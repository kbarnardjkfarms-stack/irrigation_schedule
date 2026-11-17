// =============================================================================
// Spray schedule — farm managers and operators from the spray Google Sheet
// =============================================================================
// The spray schedule's Google Sheet stays the list of people, the same as the Google app:
//   Managers tab   name | phone | farms | email | notify
//   Operators tab  name | crew | rig | phone | active | ... | aliases | email
// AIO's own Users list is NOT used for this, so outside people with AIO logins never end up
// on a job, a Call button or a Done alert.
//
// notify (Managers tab, optional):
//   all       gets every Done alert (the person running the spray operation)
//   spreads   gets Done alerts for Ag Rows spread jobs (operations manager)
//   (blank)   gets Done alerts only for jobs where they're the farm manager
// Rows with notify don't need farms; they aren't anyone's farm manager unless farms are filled in.
//
// The sheet is read with the functions' own Google account: share the sheet with that account
// as Viewer (Spray -> Crew shows the address). Nothing secret goes in this repo; the sheet link is
// saved from the app into sprayMeta/contacts.
//
// Firestore:
//   sprayContacts/{key}    managers (name, phone, farms, email, notify). No browser access at all
//                          (no rule = denied); the sync copies the manager's phone onto jobs.
//   sprayOperators/{key}   operators for the dropdown (name, crew, rig, phone, active, aliases).
//                          Only these columns are copied; pay, licenses etc. stay in the sheet.
//   sprayMeta/contacts     sheetId, lastOk, counts, lastError, account

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const TZ = 'America/Denver';
const META = 'contacts';
const TABS = { managers: 'Managers', operators: 'Operators' };
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly';
const MD = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/';

const personKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const mapKey = (v) => String(v || '').replace(/\b0+(\d)/g, '$1').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cell = (v) => String(v == null ? '' : v).trim();
const docId = (name) => personKey(name).slice(0, 80) || null;

/** The sheet id from a pasted link (or the id itself). */
function sheetIdFrom(v) {
  const s = cell(v);
  const m = s.match(/\/spreadsheets\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  return /^[A-Za-z0-9_-]{20,}$/.test(s) ? s : '';
}

/** Header row + rows -> objects keyed by lowercased header ("Farm Manager" -> "farm_manager"). */
function rowsToObjects(values) {
  if (!Array.isArray(values) || !values.length) return [];
  const head = values[0].map((h) => cell(h).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  return values.slice(1).map((r) => {
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = cell(r[i]); });
    return o;
  }).filter((o) => o.name);
}

const truthy = (v) => !/^(n|no|false|0|inactive|off)$/i.test(cell(v));
const crewOf = (v) => (/drone/i.test(cell(v)) ? 'drone' : 'ground');
const notifyOf = (v) => { const s = cell(v).toLowerCase(); return /^(all|every)\b/.test(s) ? 'all' : /^spread/.test(s) ? 'spreads' : ''; };
const emailOf = (v) => { const s = cell(v).toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : ''; };

function toManagers(rows) {
  const out = {};
  rows.forEach((r) => {
    const id = docId(r.name); if (!id) return;
    out[id] = {
      name: r.name, phone: r.phone || '', email: emailOf(r.email), notify: notifyOf(r.notify),
      farms: (r.farms || r.farm || '').split(/[,;\n]/).map(cell).filter(Boolean)
    };
  });
  return out;
}

function toOperators(rows) {
  const out = {};
  rows.forEach((r) => {
    const id = docId(r.name); if (!id) return;
    out[id] = {
      name: r.name, crew: crewOf(r.crew), rig: r.rig || '', phone: r.phone || '',
      active: r.active === undefined || r.active === '' ? true : truthy(r.active), aliases: r.aliases || '', from_sheet: true
    };
  });
  return out;
}

/** Who hears about a Done: the "all" people, the job's farm manager, and the "spreads" people on
 *  Ag Rows spread jobs. Returns [{ name, email }] from the Managers tab (no duplicates). */
function donePeople(job, contacts) {
  const list = Object.values(contacts || {});
  const out = [];
  const add = (c) => { if (c && !out.some((o) => personKey(o.name) === personKey(c.name))) out.push({ name: c.name, email: c.email || '' }); };
  list.filter((c) => c.notify === 'all').forEach(add);
  const mgr = personKey(job && job.manager);
  if (mgr) {
    const m = list.filter((c) => personKey(c.name) === mgr);
    if (m.length) m.forEach(add); else add({ name: job.manager, email: '' });   // AgWorld comment name not on the sheet
  }
  if (job && job.source !== 'drone' && job.job_type === 'Spread') list.filter((c) => c.notify === 'spreads').forEach(add);
  return out;
}

/** Just the email addresses of donePeople (for email, if that's added later). */
function doneRecipients(job, contacts) {
  return donePeople(job, contacts).map((p) => p.email).filter((e, i, a) => e && a.indexOf(e) === i);
}

/** For the job sync: { byFarm: {farmKey: [names]}, phoneByName: {personKey: phone} } from sprayContacts. */
async function loadPeopleFromContacts(db) {
  const snap = await db.collection('sprayContacts').get().catch(() => ({ forEach: () => {} }));
  const byFarm = {}, phoneByName = {};
  snap.forEach((d) => {
    const c = d.data() || {};
    if (!c.name) return;
    if (c.phone) phoneByName[personKey(c.name)] = String(c.phone);
    (c.farms || []).forEach((f) => { const k = mapKey(f); if (k) (byFarm[k] = byFarm[k] || []).push(String(c.name)); });
  });
  Object.keys(byFarm).forEach((k) => { byFarm[k] = byFarm[k].filter((x, i, a) => a.indexOf(x) === i).sort(); });
  return { byFarm, phoneByName };
}

// ---- reading the sheet --------------------------------------------------------
async function metadata(path, fetchImpl) {
  const r = await fetchImpl(MD + path, { headers: { 'Metadata-Flavor': 'Google' } });
  if (!r.ok) throw new Error('metadata ' + r.status);
  return r;
}
async function accountEmail(fetchImpl) {
  try { return (await (await metadata('email', fetchImpl)).text()).trim(); } catch (e) { return ''; }
}
async function sheetsToken(fetchImpl) {
  try { return (await (await metadata('token?scopes=' + encodeURIComponent(SCOPE), fetchImpl)).json()).access_token; }
  catch (e) { return (await admin.credential.applicationDefault().getAccessToken()).access_token; }
}

async function readTab(sheetId, tab, token, fetchImpl) {
  const url = 'https://sheets.googleapis.com/v4/spreadsheets/' + sheetId + '/values/' + encodeURIComponent(tab) + '?valueRenderOption=FORMATTED_VALUE';
  const r = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + token } });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = (body.error && body.error.message) || ('HTTP ' + r.status);
    const e = new Error(tab + ' tab: ' + msg); e.status = r.status; throw e;
  }
  return body.values || [];
}

/** Plain-English reason for a failed read, with what to do. */
function explain(err, account) {
  const m = String(err && err.message || err);
  if (/has not been used|is disabled|SERVICE_DISABLED/i.test(m)) return 'The Google Sheets API is turned off for the Firebase project. ' + (m.match(/https:\/\/\S+/) ? 'Turn it on here: ' + m.match(/https:\/\/\S+/)[0] : 'Turn it on in Google Cloud console > APIs.');
  if (err && (err.status === 403 || /permission|caller does not have/i.test(m))) return 'AIO can\'t open the sheet. Share it (Viewer) with ' + (account || 'the Firebase functions account') + '.';
  if (err && err.status === 404) return 'That sheet wasn\'t found. Check the link.';
  if (/Unable to parse range/i.test(m)) return 'The sheet needs tabs named "Managers" and "Operators". ' + m;
  return m;
}

/** Read both tabs and replace sprayContacts / sprayOperators. deps: { db, fetch, sheetId } for tests. */
async function syncContacts(deps = {}) {
  const db = deps.db || admin.firestore();
  const fetchImpl = deps.fetch || fetch;
  const metaRef = db.collection('sprayMeta').doc(META);
  const meta = (await metaRef.get()).data() || {};
  const sheetId = deps.sheetId || meta.sheetId;
  const account = meta.account || await accountEmail(fetchImpl);
  if (!sheetId) return { ok: false, error: 'No sheet linked yet. Paste the spray Google Sheet link in Spray > Crew.', account };
  try {
    const token = await sheetsToken(fetchImpl);
    const [mVals, oVals] = await Promise.all([readTab(sheetId, TABS.managers, token, fetchImpl), readTab(sheetId, TABS.operators, token, fetchImpl)]);
    const managers = toManagers(rowsToObjects(mVals)), operators = toOperators(rowsToObjects(oVals));
    // Guard: an empty read (tab renamed, wrong sheet) must not wipe the lists.
    if (!Object.keys(managers).length && !Object.keys(operators).length) throw new Error('Both tabs came back empty. Is this the spray schedule sheet?');
    const ops = [];
    const sync = async (coll, want) => {
      const have = await db.collection(coll).get();
      have.forEach((d) => { if (!want[d.id]) ops.push({ ref: d.ref, data: null }); });
      Object.keys(want).forEach((id) => ops.push({ ref: db.collection(coll).doc(id), data: want[id] }));
    };
    await sync('sprayContacts', managers);
    if (Object.keys(operators).length) await sync('sprayOperators', operators);
    for (let i = 0; i < ops.length; i += 400) {
      const b = db.batch();
      ops.slice(i, i + 400).forEach((o) => (o.data === null ? b.delete(o.ref) : b.set(o.ref, o.data)));
      await b.commit();
    }
    const res = { ok: true, managers: Object.keys(managers).length, operators: Object.keys(operators).length, account };
    await metaRef.set({ sheetId, account, lastOk: Date.now(), lastError: '', managers: res.managers, operators: res.operators }, { merge: true });
    return res;
  } catch (err) {
    const error = explain(err, account);
    await metaRef.set({ sheetId, account, lastError: error, lastErrorAt: Date.now() }, { merge: true });
    return { ok: false, error, account };
  }
}

function makeExports() {
  const syncSprayContacts = onSchedule({ schedule: 'every 60 minutes', timeZone: TZ, timeoutSeconds: 120 }, async () => { await syncContacts(); });
  // Spray admins: save the sheet link and/or read it now. Returns what happened, for the Crew tab.
  const syncSprayContactsNow = onCall({ timeoutSeconds: 120 }, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const db = admin.firestore();
    const me = (await db.collection('users').doc(request.auth.uid).get()).data() || {};
    if (me.sprayAdmin !== true) throw new HttpsError('permission-denied', 'Spray admins only.');
    const data = request.data || {};
    let sheetId = '';
    if (data.sheet !== undefined) {
      sheetId = sheetIdFrom(data.sheet);
      if (!sheetId) throw new HttpsError('invalid-argument', 'Paste the Google Sheet link (it has /spreadsheets/d/ in it).');
      await db.collection('sprayMeta').doc(META).set({ sheetId, sheetSetBy: me.name || '' }, { merge: true });
    }
    const res = await syncContacts({ db, sheetId: sheetId || undefined });
    const meta = (await db.collection('sprayMeta').doc(META).get()).data() || {};
    return Object.assign({ linked: !!meta.sheetId, lastOk: meta.lastOk || null }, res);
  });
  return { syncSprayContacts, syncSprayContactsNow };
}

module.exports = {
  makeExports,
  loadPeopleFromContacts,
  doneRecipients,
  donePeople,
  _internal: { sheetIdFrom, rowsToObjects, toManagers, toOperators, doneRecipients, donePeople, syncContacts, explain, loadPeopleFromContacts }
};
