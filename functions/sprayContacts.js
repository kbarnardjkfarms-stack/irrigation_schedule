// =============================================================================
// Spray schedule — farm managers (Spray > Managers tab) and who hears about a Done
// =============================================================================
// Managers live in sprayContacts/{id}: name, phone, email, farms [farm names], notify.
// They're kept in the Spray module's Managers tab (Spray admins), separate from AIO's Users list,
// so outside people with AIO logins never end up on a job, a Call button or an alert.
// (They first came over from the old Google Sheet's Managers tab; the sheet isn't read any more.)
//
// notify:
//   ''        Done alerts for jobs on their farms (they're that farm's manager)
//   'all'     every Done alert (the person running the spray operation)
//   'spreads' Done alerts for Ag Rows spread jobs (operations manager)
// A manager's farms make them the job's farm manager when the AgWorld comment names nobody:
// their name on the job, their phone on the Call button.
//
// Firestore: sprayContacts has no browser rule (it holds emails); the Managers tab reads and
// writes it through sprayAct (functions/sprayActions.js).

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');

const TZ = 'America/Denver';
const personKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const mapKey = (v) => String(v || '').replace(/\b0+(\d)/g, '$1').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cell = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 120);
const NOTIFY = ['', 'all', 'spreads'];

/** A manager as saved from the Managers tab. Throws a plain message if it's not usable. */
function cleanManager(data) {
  const name = cell(data && data.name, 60);
  if (!personKey(name)) throw new HttpsError('invalid-argument', 'Enter a name.');
  const email = cell(data.email, 120).toLowerCase();
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpsError('invalid-argument', 'That email doesn\'t look right.');
  const farms = (Array.isArray(data.farms) ? data.farms : String(data.farms || '').split(/[,;\n]/))
    .map((f) => cell(f, 60)).filter(Boolean).filter((f, i, a) => a.findIndex((x) => mapKey(x) === mapKey(f)) === i).slice(0, 40);
  const notify = NOTIFY.indexOf(data.notify) >= 0 ? data.notify : '';
  return { name, phone: cell(data.phone, 30), email, farms, notify };
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
    if (m.length) m.forEach(add); else add({ name: job.manager, email: '' });   // AgWorld comment names someone not on the Managers tab
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

// The old Google Sheet reader is switched off. These two stay exported (removing exports trips the
// deploy check) but don't read or write anything.
async function syncContacts() {
  return { ok: false, error: 'The Google Sheet isn\'t read any more. Farm managers are kept in Spray > Managers, operators in Spray > Operators.' };
}

function makeExports() {
  const syncSprayContacts = onSchedule({ schedule: 'every 24 hours', timeZone: TZ, timeoutSeconds: 60 }, async () => { await syncContacts(); });
  const syncSprayContactsNow = onCall({ timeoutSeconds: 60 }, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    return syncContacts();
  });
  return { syncSprayContacts, syncSprayContactsNow };
}

module.exports = {
  makeExports,
  loadPeopleFromContacts,
  doneRecipients,
  donePeople,
  cleanManager,
  _internal: { cleanManager, donePeople, doneRecipients, loadPeopleFromContacts, syncContacts, personKey, mapKey }
};
