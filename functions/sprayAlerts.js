// =============================================================================
// Spray schedule — "field is done" alerts on phones (Firebase Cloud Messaging, web push)
// =============================================================================
// Who: the Managers-tab people of the spray Google Sheet (functions/sprayContacts.js donePeople):
//   notify "all" (the person running the spray operation), the job's farm manager, and notify
//   "spreads" on Ag Rows spread jobs. A phone gets it only if that person turned alerts on in
//   AIO (Spray screen) and their AIO login matches their sheet row by email (or by name).
//   AIO logins not on the sheet never get alerts.
//
// When: Done in the app (sprayAct) or the job closed in AgWorld (spraySync). The alert waits
//   SEND_DELAY_SEC so the app's Undo can take it back; sprayAlerter (every 2 minutes) sends
//   what's due. Alerts older than STALE_HOURS are never sent.
//
// No outside service or keys: Firebase Cloud Messaging is part of the Firebase project.
// iPhones: alerts only work once AIO is added to the Home Screen (Safari > Share > Add to Home Screen).
//
// Firestore (no browser rules on either, so only these functions read them):
//   sprayAlerts/{jobKey}       the queued / sent alert
//   sprayPushTokens/{token}    one per phone with alerts on: uid, name, email, at

const admin = require('firebase-admin');
const { donePeople } = require('./sprayContacts');

const ALERTS = 'sprayAlerts', TOKENS = 'sprayPushTokens';
const SEND_DELAY_SEC = 90;
const STALE_HOURS = 24;
const personKey = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const KIND = (j) => (j.source === 'drone' ? 'Drone' : j.job_type === 'Spread' ? 'Ag Rows spread' : 'Ag Rows spray');

/** Title + body for a Done alert. */
function buildAlert(job, done) {
  const d = Object.assign({}, job || {}, done || {});
  const acres = d.acres_done != null && d.acres_done !== '' ? d.acres_done : d.acres;
  const title = '✅ ' + (d.field || 'Field') + ' done';
  const body = [KIND(d), acres ? acres + ' ac' : '', d.farm, d.crop, d.operator ? 'by ' + d.operator : ''].filter(Boolean).join(' · ');
  return { title, body };
}

async function readAll(db, coll) {
  const out = {};
  (await db.collection(coll).get()).forEach((d) => { out[d.id] = d.data(); });
  return out;
}

/** Queue the alert for a Done. how: 'app' | 'agworld'. Never throws. */
async function queueDoneAlert(db, jobKey, job, done, how) {
  try {
    const people = donePeople(Object.assign({}, job, done), await readAll(db, 'sprayContacts'));
    const { title, body } = buildAlert(job, done);
    const now = Date.now();
    await db.collection(ALERTS).doc(String(jobKey)).set({
      jobKey: String(jobKey), how: how || 'app', people, title, body, createdAt: now,
      sendAfter: now + SEND_DELAY_SEC * 1000, status: people.length ? 'queued' : 'no_one'
    });
    return { people: people.length };
  } catch (err) {
    console.error('queueDoneAlert', err);
    return { people: 0, error: err.message };
  }
}

/** Undo: take back an alert that hasn't gone yet. Never throws. */
async function cancelDoneAlert(db, jobKey) {
  try {
    const ref = db.collection(ALERTS).doc(String(jobKey));
    const a = (await ref.get()).data();
    if (a && a.status !== 'sent') await ref.delete();
  } catch (err) { console.error('cancelDoneAlert', err); }
}

/** Phones for a list of people: tokens whose owner matches by email, or by name. */
function tokensFor(people, tokens) {
  const emails = people.map((p) => String(p.email || '').toLowerCase()).filter(Boolean);
  const names = people.map((p) => personKey(p.name)).filter(Boolean);
  return Object.keys(tokens).filter((t) => {
    const o = tokens[t] || {};
    return (o.email && emails.indexOf(String(o.email).toLowerCase()) >= 0) || (o.name && names.indexOf(personKey(o.name)) >= 0);
  });
}

/** Push to phones. Drops phones FCM says are gone. Returns { sent, failed }. */
async function push(db, messaging, tokenList, msg) {
  if (!tokenList.length) return { sent: 0, failed: 0 };
  const res = await messaging.sendEachForMulticast({
    tokens: tokenList,
    data: { title: msg.title, body: msg.body, url: msg.url || '/', tag: msg.tag || '' },
    webpush: { headers: { Urgency: 'high', TTL: String(STALE_HOURS * 3600) } }
  });
  const gone = [];
  (res.responses || []).forEach((r, i) => {
    const code = r.error && r.error.code;
    if (code === 'messaging/registration-token-not-registered' || code === 'messaging/invalid-registration-token' || code === 'messaging/invalid-argument') gone.push(tokenList[i]);
  });
  await Promise.all(gone.map((t) => db.collection(TOKENS).doc(t).delete().catch(() => {})));
  return { sent: res.successCount || 0, failed: res.failureCount || 0 };
}

/** Send every queued alert that's due. deps: { db, messaging, now } for tests. */
async function sendQueued(deps = {}) {
  const db = deps.db || admin.firestore();
  const messaging = deps.messaging || admin.messaging();
  const now = deps.now || Date.now();
  const snap = await db.collection(ALERTS).where('status', '==', 'queued').get();
  const due = [];
  snap.forEach((d) => due.push({ ref: d.ref, a: d.data() }));
  const stats = { sent: 0, stale: 0, waiting: 0, noPhone: 0, errors: 0 };
  if (!due.length) return stats;
  const tokens = await readAll(db, TOKENS);
  for (const { ref, a } of due) {
    if (a.sendAfter > now) { stats.waiting++; continue; }
    if (now - a.createdAt > STALE_HOURS * 3600000) { await ref.set({ status: 'stale' }, { merge: true }); stats.stale++; continue; }
    const list = tokensFor(a.people || [], tokens);
    if (!list.length) { await ref.set({ status: 'no_phones', checkedAt: now }, { merge: true }); stats.noPhone++; continue; }
    try {
      const r = await push(db, messaging, list, { title: a.title, body: a.body, tag: 'done-' + a.jobKey });
      await ref.set({ status: 'sent', sentAt: now, phones: r.sent, failed: r.failed }, { merge: true });
      stats.sent++;
    } catch (err) {
      const tries = (a.tries || 0) + 1;
      await ref.set({ tries, lastError: err.message, status: tries >= 5 ? 'error' : 'queued' }, { merge: true });
      stats.errors++;
      console.error('sprayAlerter', err.message);
    }
  }
  await db.collection('sprayMeta').doc('alerts').set({ lastRun: now, lastStats: stats }, { merge: true });
  return stats;
}

/** The signed-in AIO user (name + email), for saving a phone. */
async function whoAmI(db, auth) {
  const { HttpsError } = require('firebase-functions/v2/https');
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const p = (await db.collection('users').doc(auth.uid).get()).data() || {};
  return { uid: auth.uid, name: p.name || '', email: String(p.email || auth.token.email || '').toLowerCase() };
}

/** Turn alerts on/off for this phone, or send this person a test. data: { token, on, test } */
async function pushSetup(db, messaging, auth, data) {
  const { HttpsError } = require('firebase-functions/v2/https');
  const me = await whoAmI(db, auth);
  const token = String((data && data.token) || '').trim();
  if (token && (token.length > 1000 || /[/\s]/.test(token))) throw new HttpsError('invalid-argument', 'That phone code doesn\'t look right.');
  if (token && data.on === false) { await db.collection(TOKENS).doc(token).delete(); return { ok: true, on: false }; }
  if (token) await db.collection(TOKENS).doc(token).set({ uid: me.uid, name: me.name, email: me.email, ua: String(data.ua || '').slice(0, 200), at: Date.now() });
  const out = { ok: true, on: !!token };
  // Is this person on the sheet's Managers tab? (otherwise they won't get Done alerts)
  const contacts = await readAll(db, 'sprayContacts');
  out.onSheet = Object.values(contacts).some((c) => (me.email && String(c.email || '').toLowerCase() === me.email) || personKey(c.name) === personKey(me.name));
  if (data && data.test) {
    const tokens = await readAll(db, TOKENS);
    const mine = Object.keys(tokens).filter((t) => tokens[t].uid === me.uid);
    const r = await push(db, messaging, mine, { title: '✅ Test field done', body: 'Spray schedule alerts are working on this phone.', tag: 'test' });
    Object.assign(out, { tested: r.sent, phones: mine.length });
  }
  return out;
}

/** For the Crew tab: when the sender last ran, and the latest alerts with their status. */
async function alertLog(db) {
  const meta = (await db.collection('sprayMeta').doc('alerts').get()).data() || {};
  const tokens = await readAll(db, TOKENS);
  const list = [];
  (await db.collection(ALERTS).get()).forEach((d) => {
    const a = d.data() || {};
    list.push({ jobKey: d.id, title: a.title || '', how: a.how || '', status: a.status || '', createdAt: a.createdAt || 0, sentAt: a.sentAt || null,
      phones: a.phones || 0, lastError: a.lastError || '', people: (a.people || []).map((p) => p.name),
      phonesNow: tokensFor(a.people || [], tokens).length });
  });
  list.sort((x, y) => y.createdAt - x.createdAt);
  const owners = {};
  Object.values(tokens).forEach((t) => { const k = (t.email || t.name || '?'); owners[k] = (owners[k] || 0) + 1; });
  return { lastRun: meta.lastRun || null, lastStats: meta.lastStats || null, alerts: list.slice(0, 15),
    phones: Object.keys(owners).map((k) => ({ who: k, count: owners[k] })) };
}

function makeExports() {
  const { onSchedule } = require('firebase-functions/v2/scheduler');
  const { onCall } = require('firebase-functions/v2/https');
  const sprayAlerter = onSchedule({ schedule: 'every 2 minutes', timeZone: 'America/Denver', timeoutSeconds: 120 }, async () => { await sendQueued(); });
  const sprayPushSetup = onCall({ timeoutSeconds: 60 }, async (request) => pushSetup(admin.firestore(), admin.messaging(), request.auth, request.data || {}));
  // Spray admins: recent alerts + "Send now" (runs the sender right away instead of waiting for its timer).
  const sprayAlertLog = onCall({ timeoutSeconds: 120 }, async (request) => {
    const { HttpsError } = require('firebase-functions/v2/https');
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const db = admin.firestore();
    const me = (await db.collection('users').doc(request.auth.uid).get()).data() || {};
    if (me.sprayAdmin !== true) throw new HttpsError('permission-denied', 'Spray admins only.');
    let sent = null;
    if (request.data && request.data.sendNow) sent = await sendQueued({ db, now: Date.now() + SEND_DELAY_SEC * 1000 });
    return Object.assign({ sent }, await alertLog(db));
  });
  return { sprayAlerter, sprayPushSetup, sprayAlertLog };
}

module.exports = {
  makeExports, queueDoneAlert, cancelDoneAlert,
  _internal: { buildAlert, queueDoneAlert, cancelDoneAlert, tokensFor, sendQueued, pushSetup, alertLog, SEND_DELAY_SEC, STALE_HOURS }
};
