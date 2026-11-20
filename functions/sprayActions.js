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
//   sprayOperators/{id}     name, crew ('drone' | 'ground'), rig, phone, active (Spray > Crew tab)

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { _internal: S } = require('./spraySync');
const alerts = require('./sprayAlerts');
const contacts = require('./sprayContacts');
const records = require('./sprayRecords');
const costs = require('./sprayCosts');
const OPS = 'sprayOperators';

/** What a role may do in the Spray module. */
function permsFor(role, sprayAdmin) {
  if (role === 'customer' || role === 'planting_staff') return null;
  // Only logins with Spray admin checked run the schedule. AIO Admin/Owner and Farm managers can look.
  if (sprayAdmin === true) return { see: ['drone', 'ground'], assign: ['drone', 'ground'], complete: ['drone', 'ground'], admin: true };
  if (role === 'admin' || role === 'owner' || role === 'farm_manager' || role === 'operations') return { see: ['drone', 'ground'], assign: [], complete: [], admin: false };
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

  // ---- crew list (Spray admin): Spray > Crew tab ----
  if (action === 'saveOperator' || action === 'deleteOperator') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can change the crew list.');
    if (action === 'deleteOperator') {
      const id = clean(data.id, 80);
      if (!id) throw new HttpsError('invalid-argument', 'Which operator?');
      await db.collection(OPS).doc(id).delete();
      return { ok: true };
    }
    const name = clean(data.name, 60);
    const crew = data.crew === 'drone' ? 'drone' : 'ground';
    if (!name) throw new HttpsError('invalid-argument', 'Enter a name.');
    const ref = data.id ? db.collection(OPS).doc(clean(data.id, 80)) : db.collection(OPS).doc();
    const row = {
      name, crew, rig: clean(data.rig, 60), phone: clean(data.phone, 30), active: data.active !== false,
      // names come only from this tab (no AgWorld / Paycom spellings), so old "other spellings" are dropped
      aliases: admin.firestore.FieldValue.delete(), from_sheet: admin.firestore.FieldValue.delete(), updated_by: me.name, updated_at: nowIso()
    };
    // Idaho applicator license (both crews) + FAA details (drone pilots only), copied into each
    // application record when it's saved (functions/sprayRecords.js).
    const papers = records.cleanPilotPapers(data);
    if (crew !== 'drone') { delete papers.faa_cert; delete papers.part137_date; delete papers.address; delete papers.faa_recurrent; delete papers.medical_issued; delete papers.medical_over40; delete papers.chief; }
    Object.assign(row, papers);
    await ref.set(row, { merge: true });
    return { ok: true, id: ref.id };
  }

  // ---- drones list (Operators tab) ----
  if (action === 'listDrones') {
    if (!me.admin && me.see.indexOf('drone') < 0) throw new HttpsError('permission-denied', 'Not your crew.');
    return { ok: true, drones: await records.listDrones(db) };
  }
  if (action === 'saveDrone' || action === 'deleteDrone') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can change the drones list.');
    if (action === 'deleteDrone') {
      const id = clean(data.id, 80);
      if (!id) throw new HttpsError('invalid-argument', 'Which drone?');
      await db.collection(records.DRONES).doc(id).delete();   // old flight records keep their own copy of the drone
    } else {
      const d = records.cleanDrone(data);
      const ref = data.id ? db.collection(records.DRONES).doc(clean(data.id, 80)) : db.collection(records.DRONES).doc();
      await ref.set(Object.assign(d, { updated_by: me.name, updated_at: nowIso() }), { merge: true });
    }
    return { ok: true, drones: await records.listDrones(db) };
  }

  // ---- flight records: corrections and voids (Spray admin; every change is kept in the record's history) ----
  if (action === 'editFlight') return records.editFlight(db, me, data);
  if (action === 'listFlights') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can see the flight records.');
    return records.listFlights(db, data);
  }
  if (action === 'listGround') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can see the Ag Rows records.');
    return records.listGround(db, data);
  }
  if (action === 'voidGround') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can void an Ag Rows record.');
    if (clean(data.reason, 300).length < 4) throw new HttpsError('invalid-argument', 'Say why it\'s being voided (it stays on file with the reason).');
    return records.voidGround(db, me, clean(data.jobKey, 40), data.reason);
  }
  // ---- drone maintenance log (Drones tab) ----
  if (action === 'listMaint') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can see the maintenance log.');
    return { ok: true, maint: await records.listMaint(db, {}), kinds: records.MAINT_KINDS };
  }
  if (action === 'addMaint') { await records.addMaint(db, me, data); return { ok: true, maint: await records.listMaint(db, {}) }; }
  if (action === 'voidMaint') { await records.voidMaint(db, me, clean(data.id, 80), data.reason); return { ok: true, maint: await records.listMaint(db, {}) }; }
  if (action === 'voidFlight') {
    if (clean(data.reason, 300).length < 4) throw new HttpsError('invalid-argument', 'Say why it\'s being voided (it stays on file with the reason).');
    return records.voidFlight(db, me, clean(data.id, 80), data.reason);
  }

  // ---- Costs tab (Spray admin): weekly hours, pay rates, expenses, cost per acre (functions/sprayCosts.js) ----
  if (costs.COST_ACTIONS.indexOf(action) >= 0) return costs.costAction(db, me, action, data || {});

  // ---- farm managers (Spray admin): Spray > Managers tab ----
  if (action === 'listManagers' || action === 'saveManager' || action === 'deleteManager') {
    if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can see or change the managers list.');
    const MGRS = db.collection('sprayContacts');
    if (action === 'saveManager') {
      const m = contacts.cleanManager(data);
      const id = clean(data.id, 80) || contacts._internal.personKey(m.name).slice(0, 80);
      if (!data.id && (await MGRS.doc(id).get()).data()) throw new HttpsError('already-exists', 'There\'s already a manager named ' + m.name + '. Edit that one instead.');
      await MGRS.doc(id).set(Object.assign(m, { updated_by: me.name, updated_at: nowIso() }));
    } else if (action === 'deleteManager') {
      const id = clean(data.id, 80);
      if (!id) throw new HttpsError('invalid-argument', 'Which manager?');
      await MGRS.doc(id).delete();
    }
    const list = [];
    (await MGRS.get()).forEach((d) => { const c = d.data() || {}; list.push({ id: d.id, name: c.name || '', phone: c.phone || '', email: c.email || '', farms: c.farms || [], notify: c.notify || '' }); });
    list.sort((a, b) => a.name.localeCompare(b.name));
    return { ok: true, managers: list };
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
      const row = quickDoneRow(job, me, operator);
      if (job.source === 'drone') {
        // Drone jobs: Done saves the flight record (application record + logbooks) at the same time
        if (!data.flight) throw new HttpsError('invalid-argument', 'Fill in the flight log to mark a drone job done.');
        const f = await records.logFlight(db, me, job, jobKey, data.flight);
        Object.assign(row, { operator: f.record.pilot.name, acres_done: f.record.acres, flight_id: f.id, drone: f.record.drone.name, flights: f.record.flights });
      }
      let missing = row.flight_id ? ((await db.collection(records.FLIGHTS).doc(row.flight_id).get()).data() || {}).missing || [] : [];
      await stateRef.set({ done: row }, { merge: true });
      // Ag Rows: the one tap saves the application record too (time of the tap, operator's license, weather)
      if (job.source !== 'drone') missing = (await records.logGround(db, me, job, jobKey, operator)).record.missing || [];
      // Phone alert (farm manager, the "all" people, + "spreads" people on spreads), after a short wait so Undo can take it back
      const a = await alerts.queueDoneAlert(db, jobKey, job, row, 'app');
      return { ok: true, alerted: a.people, missing: missing };
    }
    case 'undo': {
      if (me.complete.indexOf(job.source) < 0) throw new HttpsError('permission-denied', 'You can\'t change that.');
      if (!state.done) return { ok: true };
      if (state.done.entered_by !== S.QUICK_DONE_TAG) {
        throw new HttpsError('failed-precondition', 'This one was closed in AgWorld. To reopen it, change it in AgWorld.');
      }
      await stateRef.set({ done: admin.firestore.FieldValue.delete() }, { merge: true });
      await alerts.cancelDoneAlert(db, jobKey);
      // its flight record stays on file, voided, so the history is complete
      if (state.done.flight_id) await records.voidFlight(db, { name: me.name, system: true }, state.done.flight_id, 'Done was undone in the app by ' + me.name);
      if (job.source !== 'drone') await records.voidGround(db, me, jobKey, 'Done was undone in the app by ' + me.name);
      return { ok: true };
    }
    case 'logFlight': {
      if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can add a flight record afterwards.');
      const f = await records.logFlight(db, me, job, jobKey, data.flight);
      // a job closed in AgWorld (or done before flight logs) now points at its record
      if (state.done && !state.done.flight_id) await stateRef.set({ done: Object.assign({}, state.done, { flight_id: f.id }) }, { merge: true });
      return { ok: true, id: f.id, missing: f.record.missing };
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
  // the company's paid Open-Meteo plan for the weather on records (same secret as openMeteo.js)
  const { defineSecret } = require('firebase-functions/params');
  const OPEN_METEO_API_KEY = defineSecret('OPEN_METEO_API_KEY');
  records.useApiKey(() => OPEN_METEO_API_KEY.value());
  const sprayAct = onCall({ secrets: [OPEN_METEO_API_KEY] }, async (request) => {
    const db = admin.firestore();
    const me = await meFromAuth(db, request.auth);
    return act(db, me, request.data || {});
  });
  return { sprayAct };
}

module.exports = { makeExports, _internal: { act, permsFor, meFromAuth, quickDoneRow } };
