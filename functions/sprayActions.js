// =============================================================================
// Spray schedule — what people do in the app (Spray module)
// =============================================================================
// Every change to the spray schedule goes through here so the role checks live
// on the server: assign an operator, mark done / undo, move a job's date, remove
// a job from the schedule / restore it, and the crew list. The browser only reads
// (firestore.rules allow no writes to the spray collections).
//
// Who can do what (AIO logins; crew links come in a later step and reuse act()):
//   Logins with sprayAdmin: true (Users screen checkbox)   everything, both crews
//   Admin, Owner, Farm manager                            view only
//
// Firestore:
//   sprayJobState/{jobKey}  assign {operator, rig}, done {...}, move {date}, hidden {...}
//   sprayOperators/{id}     name, crew ('drone' | 'ground'), rig, phone, active

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { _internal: S } = require('./spraySync');

const OPS = 'sprayOperators';

/** What a role may do in the Spray module. */
function permsFor(role, sprayAdmin) {
  if (role === 'customer' || role === 'planting_staff') return null;
  // Only logins with Spray admin checked run the schedule. AIO Admin/Owner and Farm managers can look.
  if (sprayAdmin === true) return { see: ['drone', 'ground'], assign: ['drone', 'ground'], complete: ['drone', 'ground'], admin: true };
  if (role === 'admin' || role === 'owner' || role === 'farm_manager') return { see: ['drone', 'ground'], assign: [], complete: [], admin: false };
  return null;
}

/** The signed-in AIO user, with their Spray permissions. */
async function meFromAuth(db, auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in first.');
  const p = (await db.collection('users').doc(auth.uid).get()).data() || {};
  const mods = Array.isArray(p.modules) ? p.modules : null;
  const isAO = p.role === 'admin' || p.role === 'owner';
  if (!isAO && mods && mods.indexOf('spray') < 0) throw new HttpsError('permission-denied', 'The Spray module isn\'t turned on for your login.');
  const perms = permsFor(p.role, p.sprayAdmin);
  if (!perms) throw new HttpsError('permission-denied', 'Your role can\'t use the Spray module.');
  return Object.assign({ name: p.name || auth.token.email || 'AIO user', email: p.email || auth.token.email || '', role: p.role }, perms);
}

const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 80);
const nowIso = () => new Date().toISOString();

/** The row the one-tap Done writes. The next sync replaces it with AgWorld's acres, gallons and conditions. */
function quickDoneRow(job, me, operator) {
  return {
    completed_date: S.today(), acres_done: job.acres, gallons: null, gpa: null,
    operator: operator || '', notes: 'Marked done by ' + me.name,
    source: job.source, job_type: job.job_type, manager: job.manager, farm: job.farm, field: job.field, crop: job.crop,
    planned_date: job.planned_date, agworld_link: job.agworld_link, products: job.products || '', product_detail: job.product_detail || [],
    entered_by: S.QUICK_DONE_TAG, entered_at: nowIso(), done_by: me.name, conditions: ''
  };
}

/** One change to one job, or to the crew list. Returns what the browser needs to show it right away. */
async function act(db, me, data) {
  const action = clean(data && data.action, 20);

  // ---- crew list (Admin) ----
  if (action === 'saveOperator' || action === 'deleteOperator') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only an Admin can change the crew list.');
    if (action === 'deleteOperator') {
      const id = clean(data.id, 60);
      if (!id) throw new HttpsError('invalid-argument', 'Which operator?');
      await db.collection(OPS).doc(id).delete();
      return { ok: true };
    }
    const name = clean(data.name, 60);
    const crew = data.crew === 'drone' ? 'drone' : 'ground';
    if (!name) throw new HttpsError('invalid-argument', 'Enter a name.');
    const ref = data.id ? db.collection(OPS).doc(clean(data.id, 60)) : db.collection(OPS).doc();
    await ref.set({
      name, crew, rig: clean(data.rig, 60), phone: clean(data.phone, 30), active: data.active !== false,
      aliases: clean(data.aliases, 200), updated_by: me.name, updated_at: nowIso()
    }, { merge: true });
    return { ok: true, id: ref.id };
  }

  // ---- one job ----
  const jobKey = clean(data && data.jobKey, 40);
  if (!jobKey) throw new HttpsError('invalid-argument', 'Which job?');
  const job = (await db.collection('sprayJobs').doc(jobKey).get()).data();
  const stateRef = db.collection('sprayJobState').doc(jobKey);
  const state = (await stateRef.get()).data() || {};
  if (!job) throw new HttpsError('not-found', 'That job changed in AgWorld since the schedule loaded. It will show the new version in a moment.');
  if (me.see.indexOf(job.source) < 0) throw new HttpsError('permission-denied', 'That job isn\'t on your schedule.');

  switch (action) {
    case 'assign': {
      if (me.assign.indexOf(job.source) < 0) throw new HttpsError('permission-denied', 'You can\'t assign operators on these jobs.');
      const operator = clean(data.operator, 120);
      const assign = operator ? { operator, rig: clean(data.rig, 60), by: me.name, at: nowIso() } : null;
      const upd = { assign: assign || admin.firestore.FieldValue.delete() };
      // a one-tap Done row carries the operator too
      if (state.done && state.done.entered_by === S.QUICK_DONE_TAG) upd.done = Object.assign({}, state.done, { operator });
      await stateRef.set(upd, { merge: true });
      return { ok: true };
    }
    case 'done': {
      if (me.complete.indexOf(job.source) < 0) throw new HttpsError('permission-denied', 'You can\'t mark ' + (job.source === 'drone' ? 'drone' : 'Ag Rows') + ' jobs done.');
      if (state.done) return { ok: true, already: true };
      const operator = (state.assign && state.assign.operator) || '';
      await stateRef.set({ done: quickDoneRow(job, me, operator) }, { merge: true });
      return { ok: true };
    }
    case 'undo': {
      if (me.complete.indexOf(job.source) < 0) throw new HttpsError('permission-denied', 'You can\'t change that.');
      if (!state.done) return { ok: true };
      if (state.done.entered_by !== S.QUICK_DONE_TAG) {
        throw new HttpsError('failed-precondition', 'This one was closed in AgWorld. To reopen it, change it in AgWorld.');
      }
      await stateRef.set({ done: admin.firestore.FieldValue.delete() }, { merge: true });
      return { ok: true };
    }
    case 'move': {
      if (!me.admin) throw new HttpsError('permission-denied', 'Only an Admin can move jobs.');
      const date = clean(data.date, 10);
      if (!date || date === job.planned_date) {
        await stateRef.set({ move: admin.firestore.FieldValue.delete() }, { merge: true });
        return { ok: true, planned_date: job.planned_date, moved: false };
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpsError('invalid-argument', 'Pick a date.');
      await stateRef.set({ move: { date, from: job.planned_date, by: me.name, at: nowIso() } }, { merge: true });
      return { ok: true, planned_date: date, moved: true };
    }
    case 'hide': {
      if (!me.admin) throw new HttpsError('permission-denied', 'Only an Admin can remove jobs.');
      await stateRef.set({ hidden: { field: job.field, acres: job.acres, title: job.title, date: job.planned_date, source: job.source, by: me.name, at: nowIso() } }, { merge: true });
      return { ok: true };
    }
    case 'restore': {
      if (!me.admin) throw new HttpsError('permission-denied', 'Only an Admin can restore jobs.');
      await stateRef.set({ hidden: admin.firestore.FieldValue.delete() }, { merge: true });
      return { ok: true };
    }
    default:
      throw new HttpsError('invalid-argument', 'Unknown action: ' + action);
  }
}

function makeExports() {
  const sprayAct = onCall(async (request) => {
    const db = admin.firestore();
    const me = await meFromAuth(db, request.auth);
    return act(db, me, request.data || {});
  });
  return { sprayAct };
}

module.exports = { makeExports, _internal: { act, permsFor, meFromAuth, quickDoneRow } };
