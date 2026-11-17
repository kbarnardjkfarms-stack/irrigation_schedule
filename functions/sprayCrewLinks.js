// =============================================================================
// Spray schedule — no-login crew links (Ag Rows operators and drone pilots)
// =============================================================================
// Like the Google app's personal links: a Spray admin makes a link for someone on the sheet's
// Operators tab (Spray > Crew), and texts it to them. The link opens AIO at /crew/<code> with
// no sign-in:
//   Ag Rows link  every Ag Rows job (spray + spread), Done on any of them
//   Drone link    drone jobs only, Done on any of them
// Nobody sees the other crew's jobs. No assigning, moving or removing from a link.
// A link can be turned off or replaced (New link) at any time; the old code stops working.
//
// Firestore: sprayLinks/{code}  name, crew ('drone' | 'ground'), at, by, lastUsed
//   No Firestore rule, so browsers can't list or read codes; only these functions do.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');
const { act } = require('./sprayActions')._internal;
const { _internal: S } = require('./spraySync');

const LINKS = 'sprayLinks';
const DONE_DAYS = 7;          // done jobs a crew link still shows
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const newCode = () => crypto.randomBytes(18).toString('base64url');

async function linkFor(db, code) {
  const c = String(code || '');
  if (!/^[A-Za-z0-9_-]{20,40}$/.test(c)) throw new HttpsError('not-found', 'This link isn\'t right. Ask for a new one.');
  const snap = await db.collection(LINKS).doc(c).get();
  const l = snap.data();
  if (!l) throw new HttpsError('not-found', 'This link was turned off. Ask for a new one.');
  return Object.assign({ code: c }, l);
}

/** What a crew link may do (the same shape sprayActions.act expects). */
function crewMe(link) {
  const src = link.crew === 'drone' ? 'drone' : 'ground';
  return { name: link.name, see: [src], assign: [], complete: [src], admin: false, crewLink: true };
}

const FIELDS = ['source', 'job_type', 'field', 'farm', 'crop', 'acres', 'manager', 'manager_phone', 'agworld_link', 'pin_url',
  'lat', 'lng', 'products', 'product_detail', 'title', 'fields'];

/** The crew's jobs: open ones, plus ones done in the last DONE_DAYS. Removed jobs never show. */
async function crewJobs(db, link) {
  const src = link.crew === 'drone' ? 'drone' : 'ground';
  const [jSnap, sSnap] = await Promise.all([db.collection('sprayJobs').get(), db.collection('sprayJobState').get()]);
  const states = {};
  sSnap.forEach((d) => { states[d.id] = d.data(); });
  const since = S.shiftYmd(S.today(), -DONE_DAYS);
  const out = [];
  jSnap.forEach((d) => {
    const j = d.data() || {};
    const st = states[d.id] || {};
    if (j.source !== src || j.needs_review || st.hidden) return;
    if (st.done && String(st.done.completed_date || '') < since) return;
    const o = { job_key: d.id };
    FIELDS.forEach((k) => { if (j[k] !== undefined) o[k] = j[k]; });
    o.agworld_date = j.planned_date;
    o.planned_date = (st.move && st.move.date) || j.planned_date;
    o.moved = !!(st.move && st.move.date);
    o.operator = (st.assign && st.assign.operator) || '';
    o.rig = (st.assign && st.assign.rig) || '';
    o.done = st.done ? {
      completed_date: st.done.completed_date || '', entered_by: st.done.entered_by || '', acres_done: st.done.acres_done || null,
      gallons: st.done.gallons || null, gpa: st.done.gpa || null, operator: st.done.operator || '', conditions: st.done.conditions || '', done_by: st.done.done_by || ''
    } : null;
    out.push(o);
  });
  return out;
}

/** The crew page: { code, action: 'load' | 'done' | 'undo', jobKey } */
async function crewCall(db, data) {
  const link = await linkFor(db, data && data.code);
  const action = String((data && data.action) || 'load');
  if (!link.lastUsed || Date.now() - link.lastUsed > 3600000) {
    await db.collection(LINKS).doc(link.code).set({ lastUsed: Date.now() }, { merge: true });
  }
  if (action === 'done' || action === 'undo') {
    const r = await act(db, crewMe(link), { action, jobKey: data.jobKey });
    return Object.assign({}, r, { jobs: await crewJobs(db, link) });
  }
  if (action !== 'load') throw new HttpsError('invalid-argument', 'Unknown action.');
  return { name: link.name, crew: link.crew === 'drone' ? 'drone' : 'ground', today: S.today(), jobs: await crewJobs(db, link) };
}

/** Spray admin: { action: 'list' } | { action: 'make', name, crew } | { action: 'off', name } */
async function linkAdmin(db, me, data) {
  const action = String((data && data.action) || 'list');
  const all = [];
  (await db.collection(LINKS).get()).forEach((d) => all.push(Object.assign({ code: d.id }, d.data())));
  if (action === 'list') return { links: all.map((l) => ({ code: l.code, name: l.name, crew: l.crew, at: l.at || null, lastUsed: l.lastUsed || null })) };
  const name = String((data && data.name) || '').trim().slice(0, 60);
  if (!name) throw new HttpsError('invalid-argument', 'Whose link?');
  // one link per person: making a new one replaces the old (the old code stops working)
  await Promise.all(all.filter((l) => normName(l.name) === normName(name)).map((l) => db.collection(LINKS).doc(l.code).delete()));
  if (action === 'off') return { ok: true };
  if (action !== 'make') throw new HttpsError('invalid-argument', 'Unknown action.');
  const crew = data.crew === 'drone' ? 'drone' : 'ground';
  const code = newCode();
  await db.collection(LINKS).doc(code).set({ name, crew, at: Date.now(), by: me.name || '' });
  return { ok: true, code, name, crew };
}

function makeExports() {
  // No sign-in: the link's code is the key. Callable functions work without a login.
  const sprayCrew = onCall({ timeoutSeconds: 60 }, async (request) => crewCall(admin.firestore(), request.data || {}));
  const sprayLinkAdmin = onCall({ timeoutSeconds: 60 }, async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');
    const db = admin.firestore();
    const me = (await db.collection('users').doc(request.auth.uid).get()).data() || {};
    if (me.sprayAdmin !== true) throw new HttpsError('permission-denied', 'Spray admins only.');
    return linkAdmin(db, me, request.data || {});
  });
  return { sprayCrew, sprayLinkAdmin };
}

module.exports = { makeExports, _internal: { linkFor, crewMe, crewJobs, crewCall, linkAdmin } };
