// =============================================================================
// Spray schedule — who the farm managers are, and who hears about a Done
// =============================================================================
// FROM AIO USERS (Users screen) now: each person's role, farms, phone, and their
// "Alerts" switches (users/{uid}.alerts = { spray, irrigation }, each '' | 'farms' | 'all',
// spray also 'spreads'). A Farm manager login's farms make them the farm manager on that
// farm's jobs (their name on the job, their phone on the Call button); so does an Admin/Owner login
// with farms ticked (e.g. Devin on Acequia). Operations, Trucking
// and Mart Produce logins never become a job's farm manager; they only get alerts they switch on.
//
// Bridge from the old Spray > Managers tab (sprayContacts): until at least one AIO user has a
// Spray alert switched on, Done alerts still follow the Managers tab; a farm with no Farm manager
// login, or a manager login with no phone, still takes the name / phone from it.
//
// Old notes below describe the Managers tab, kept for the bridge.
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
function donePeople(job, contacts, fromUsers) {
  const list = Object.values(contacts || {});
  const out = [];
  const add = (c) => { if (c && !out.some((o) => personKey(o.name) === personKey(c.name))) out.push({ name: c.name, email: c.email || '', uid: c.uid || '' }); };
  list.filter((c) => c.notify === 'all').forEach(add);
  if (job && job.source !== 'drone' && job.job_type === 'Spread') list.filter((c) => c.notify === 'spreads').forEach(add);
  if (fromUsers) {
    // AIO users: "Their farms" means a job on one of the farms ticked for them
    const fk = mapKey(job && job.farm);
    if (fk) list.filter((c) => c.notify === 'farms' && (c.farms || []).some((f) => mapKey(f) === fk)).forEach(add);
    return out;
  }
  const mgr = personKey(job && job.manager);
  if (mgr) {
    const m = list.filter((c) => personKey(c.name) === mgr);
    if (m.length) m.forEach(add); else add({ name: job.manager, email: '' });   // AgWorld comment names someone not on the Managers tab
  }
  return out;
}

// ---- AIO Users as the people list ---------------------------------------------------------------
const ALERT_SETTINGS = ['', 'farms', 'all', 'spreads'];
const MANAGER_ROLES = ['farm_manager'];
/** Users -> contact-shaped rows: { uid, name, email, phone, role, farms: [farm names], notify } where
 *  notify is the person's Spray alert switch ('off' | 'farms' | 'all' | 'spreads'). */
async function loadUsers(db) {
  const [uSnap, fSnap] = await Promise.all([db.collection('users').get(), db.collection('farms').get()]);
  const farmName = {};
  fSnap.forEach((d) => { const f = d.data() || {}; farmName[String(d.id)] = f.name || ''; });
  const out = [];
  uSnap.forEach((d) => {
    const u = d.data() || {};
    if (!u.name || u.role === 'customer' || u.disabled === true) return;
    const sp = u.alerts && ALERT_SETTINGS.indexOf(u.alerts.spray) >= 0 ? u.alerts.spray : '';
    out.push({ uid: d.id, name: String(u.name), email: String(u.email || '').toLowerCase(), phone: String(u.phone || ''), role: u.role || '',
      farms: (Array.isArray(u.farmIds) ? u.farmIds : []).map((id) => farmName[String(id)]).filter(Boolean), notify: sp || 'off' });
  });
  return out;
}
/** Who can get Done alerts: AIO users once anyone has a Spray alert switched on; until then the
 *  old Managers tab. Returns { list, fromUsers }. */
async function alertContacts(db) {
  const users = await loadUsers(db);
  if (users.some((u) => u.notify !== 'off')) return { list: users, fromUsers: true };
  const old = [];
  (await db.collection('sprayContacts').get()).forEach((d) => old.push(d.data() || {}));
  return { list: old, fromUsers: false };
}

/** Just the email addresses of donePeople (for email, if that's added later). */
function doneRecipients(job, contacts) {
  return donePeople(job, contacts).map((p) => p.email).filter((e, i, a) => e && a.indexOf(e) === i);
}

/** For the job sync: { byFarm: {farmKey: [names]}, phoneByName: {personKey: phone} }.
 *  Farm manager logins in AIO Users first (their farms, their phone); the old Managers tab fills in
 *  a farm with no Farm manager login and a phone a login doesn't have. */
async function loadPeopleFromContacts(db) {
  const byFarm = {}, phoneByName = {};
  const users = await loadUsers(db).catch(() => []);
  users.forEach((u) => {
    if (u.phone) phoneByName[personKey(u.name)] = u.phone;
    // Farm manager logins, and Admin/Owner logins with farms ticked (e.g. an admin who runs one farm)
    if (MANAGER_ROLES.indexOf(u.role) >= 0 || ((u.role === 'admin' || u.role === 'owner') && u.farms.length)) u.farms.forEach((f) => { const k = mapKey(f); if (k) (byFarm[k] = byFarm[k] || []).push(u.name); });
  });
  const snap = await db.collection('sprayContacts').get().catch(() => ({ forEach: () => {} }));
  const oldFarm = {};
  snap.forEach((d) => {
    const c = d.data() || {};
    if (!c.name) return;
    if (c.phone && !phoneByName[personKey(c.name)]) phoneByName[personKey(c.name)] = String(c.phone);
    (c.farms || []).forEach((f) => { const k = mapKey(f); if (k) (oldFarm[k] = oldFarm[k] || []).push(String(c.name)); });
  });
  Object.keys(oldFarm).forEach((k) => { if (!byFarm[k]) byFarm[k] = oldFarm[k]; });
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
  loadUsers,
  alertContacts,
  doneRecipients,
  donePeople,
  cleanManager,
  _internal: { cleanManager, donePeople, doneRecipients, loadPeopleFromContacts, loadUsers, alertContacts, syncContacts, personKey, mapKey }
};
