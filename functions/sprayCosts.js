// =============================================================================
// Spray schedule — drone costs (Spray > Costs tab, Spray admins only)
// =============================================================================
// What it answers: acres per labor hour, labor cost per hour, and the all-in cost per acre to run
// the drones (chemical not included), by week, by pilot and by drone.
//
// Where the numbers come from:
//   acres, flights, flight time   the flight records (sprayFlights, functions/sprayRecords.js)
//   labor                         hours entered each Sunday for Mon–Sat (sprayHours) x pay rate (sprayPay)
//                                 hourly: rate; salary: salary / 2080 per hour
//   batteries                     battery purchases (kind 'battery'), spread over that season's acres:
//                                 the drone's acres if a drone was picked, otherwise all drone acres
//                                 (the 3 batteries that come with a new drone are in its purchase price)
//   drone wear                    purchase price / 3 a year, spread over that drone's acres that year
//   repairs                       the costs on the Drones tab maintenance log (sprayMaint)
//   fuel                          monthly totals (sprayExpenses kind 'fuel'), spread over that month's acres
//   yearly fixed                  insurance, fees, software... (kind 'fixed'), spread over that year's acres
//   other                         one-time costs on a date (kind 'other'), counted in their week
//
// Pay is private: sprayPay, sprayHours and sprayExpenses have no browser rule, and only Spray admins
// reach them, through sprayAct. Nothing here goes to crew links.

const { HttpsError } = require('firebase-functions/v2/https');

const PAY = 'sprayPay', HOURS = 'sprayHours', EXP = 'sprayExpenses';
const TZ = 'America/Denver';
const WEAR_YEARS = 3;
const SALARY_HOURS = 2080;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 120);
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, '')); return isFinite(n) ? n : null; };
const round = (n, d) => { const p = Math.pow(10, d == null ? 2 : d); return Math.round((Number(n) || 0) * p) / p; };
const nowIso = () => new Date().toISOString();
const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const keyOf = (s) => normName(s).slice(0, 60) || 'x';

/** The Monday of the week a date falls in (weeks run Mon–Sun; hours are entered for Mon–Sat). */
function weekOf(ymd) {
  const d = new Date(ymd + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const addDays = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/** Cost of one hour for a pay row. */
function hourlyCost(p) {
  if (!p) return null;
  if (p.type === 'salary') return p.salary ? p.salary / SALARY_HOURS : null;
  return p.rate || null;
}

// ---- pay rates ------------------------------------------------------------------------------
async function listPay(db) {
  const out = {};
  (await db.collection(PAY).get()).forEach((d) => { const p = d.data() || {}; if (p.name) out[keyOf(p.name)] = p; });
  return out;
}
async function savePay(db, me, data) {
  const name = clean(data && data.name, 60);
  if (!normName(name)) throw new HttpsError('invalid-argument', 'Whose pay?');
  const type = data.type === 'salary' ? 'salary' : 'hourly';
  const rate = num(data.rate), salary = num(data.salary);
  if (type === 'hourly' && !(rate > 0 && rate < 500)) throw new HttpsError('invalid-argument', 'Enter the hourly rate.');
  if (type === 'salary' && !(salary > 1000 && salary < 1000000)) throw new HttpsError('invalid-argument', 'Enter the yearly salary.');
  await db.collection(PAY).doc(keyOf(name)).set({ name, type, rate: type === 'hourly' ? round(rate, 2) : null, salary: type === 'salary' ? round(salary, 0) : null,
    updated_by: me.name, updated_at: nowIso() });
  return listPay(db);
}

// ---- weekly hours (entered Sundays for Mon–Sat) ----------------------------------------------
async function getWeek(db, week) {
  const wk = weekOf(YMD.test(String(week || '')) ? week : addDays(todayYmd(), -7));
  const rows = {};
  (await db.collection(HOURS).get()).forEach((d) => { const h = d.data() || {}; if (h.week === wk) rows[keyOf(h.name)] = h; });
  return { week: wk, rows };
}
async function saveHours(db, me, data) {
  const wk = clean(data && data.week, 10);
  if (!YMD.test(wk) || weekOf(wk) !== wk) throw new HttpsError('invalid-argument', 'Pick the week (it starts on a Monday).');
  if (wk > todayYmd()) throw new HttpsError('invalid-argument', 'That week hasn\'t started yet.');
  const rows = Array.isArray(data.rows) ? data.rows.slice(0, 40) : [];
  for (const r of rows) {
    const name = clean(r.name, 60);
    if (!normName(name)) continue;
    const ref = db.collection(HOURS).doc(wk + '_' + keyOf(name));
    const h = r.hours === '' || r.hours == null ? null : num(r.hours);
    if (h == null) { await ref.delete(); continue; }
    if (h < 0 || h > 100) throw new HttpsError('invalid-argument', name + ': hours for a week should be 0 to 100.');
    await ref.set({ week: wk, name, hours: round(h, 2), entered_by: me.name, entered_at: nowIso() });
  }
  return getWeek(db, wk);
}

// ---- expenses -----------------------------------------------------------------------------
const KINDS = { fuel: 'Fuel (month)', battery: 'Batteries', fixed: 'Yearly fixed', other: 'Other (one time)' };
async function listExpenses(db) {
  const out = [];
  (await db.collection(EXP).get()).forEach((d) => out.push(Object.assign({ id: d.id }, d.data())));
  return out.sort((a, b) => String(b.when).localeCompare(String(a.when)));
}
async function addExpense(db, me, data) {
  const kind = KINDS[data && data.kind] ? data.kind : '';
  if (!kind) throw new HttpsError('invalid-argument', 'Pick fuel, yearly fixed, or other.');
  const amount = num(data.amount);
  if (!(amount > 0 && amount < 1000000)) throw new HttpsError('invalid-argument', 'Enter the amount.');
  let when = clean(data.when, 10);
  if (kind === 'fuel' && !/^\d{4}-\d{2}$/.test(when)) throw new HttpsError('invalid-argument', 'Pick the month the fuel was for.');
  if (kind === 'fixed' && !/^\d{4}$/.test(when)) throw new HttpsError('invalid-argument', 'Pick the year it covers.');
  if ((kind === 'other' || kind === 'battery') && (!YMD.test(when) || when > todayYmd())) throw new HttpsError('invalid-argument', 'Pick the date (not in the future).');
  const what = clean(data.what, 200);
  if (kind !== 'fuel' && kind !== 'battery' && what.length < 2) throw new HttpsError('invalid-argument', 'Say what it was (e.g. drone insurance).');
  const ref = db.collection(EXP).doc();
  await ref.set({ kind, when, amount: round(amount, 2), what, drone: kind === 'battery' ? clean(data.drone, 60) : '', entered_by: me.name, entered_at: nowIso() });
  return listExpenses(db);
}
async function deleteExpense(db, id) {
  await db.collection(EXP).doc(clean(id, 80)).delete();
  return listExpenses(db);
}

// ---- the numbers ----------------------------------------------------------------------------
/** costs(db, { year }) -> everything the Costs tab shows for that season (Jan 1 – Dec 31). */
async function costs(db, data) {
  const year = /^\d{4}$/.test(String(data && data.year)) ? String(data.year) : todayYmd().slice(0, 4);
  const from = year + '-01-01', to = year + '-12-31';
  const [fSnap, dSnap, mSnap, hSnap, pay, exps] = await Promise.all([
    db.collection('sprayFlights').get(), db.collection('sprayDrones').get(), db.collection('sprayMaint').get(),
    db.collection(HOURS).get(), listPay(db), listExpenses(db)]);
  const flights = [];
  fSnap.forEach((d) => { const r = d.data() || {}; if (r.status !== 'void' && r.date >= from && r.date <= to) flights.push(r); });
  const drones = {};
  dSnap.forEach((d) => { const o = d.data() || {}; drones[keyOf(o.name)] = o; });
  const repairs = [];
  mSnap.forEach((d) => { const m = d.data() || {}; if (m.status !== 'void' && m.cost && m.date >= from && m.date <= to) repairs.push(m); });
  const hours = [];
  hSnap.forEach((d) => { const h = d.data() || {}; if (h.week >= weekOf(from) && h.week <= to) hours.push(h); });

  const W = {};   // week -> totals
  const wk = (w) => (W[w] = W[w] || { week: w, acres: 0, flights: 0, flight_min: 0, hours: 0, labor: 0, battery: 0, wear: 0, repairs: 0, fuel: 0, fixed: 0, other: 0, unpaid_hours: 0 });
  const P = {};   // pilot -> totals
  const pl = (n) => (P[keyOf(n)] = P[keyOf(n)] || { name: n, acres: 0, flights: 0, flight_min: 0, hours: 0, labor: 0, weeks: {} });
  const D = {};   // drone -> totals
  const dr = (n) => (D[keyOf(n)] = D[keyOf(n)] || { name: n, acres: 0, flights: 0, flight_min: 0, battery: 0, wear: 0, repairs: 0 });

  // acres per drone this year (drone wear is spread over them) and per month (fuel is spread over them)
  const droneYearAcres = {}, monthAcres = {};
  flights.forEach((r) => { const k = keyOf(r.drone.name); droneYearAcres[k] = (droneYearAcres[k] || 0) + (r.acres || 0); const m = r.date.slice(0, 7); monthAcres[m] = (monthAcres[m] || 0) + (r.acres || 0); });
  const yearAcres = flights.reduce((t, r) => t + (r.acres || 0), 0);
  const notes = [];

  flights.forEach((r) => {
    const w = wk(weekOf(r.date)), p = pl(r.pilot.name), d = dr(r.drone.name), info = drones[keyOf(r.drone.name)] || {};
    const ac = r.acres || 0, fl = r.flights || 0, mins = r.minutes || 0;
    w.acres += ac; w.flights += fl; w.flight_min += mins;
    p.acres += ac; p.flights += fl; p.flight_min += mins; p.weeks[w.week] = p.weeks[w.week] || { acres: 0, hours: 0 }; p.weeks[w.week].acres += ac;
    d.acres += ac; d.flights += fl; d.flight_min += mins;
    // drone wear: purchase price / 3 a year, over that drone's acres this year
    if (info.purchase_price && droneYearAcres[keyOf(r.drone.name)]) {
      const x = (info.purchase_price / WEAR_YEARS) * ac / droneYearAcres[keyOf(r.drone.name)];
      w.wear += x; d.wear += x;
    }
  });
  Object.keys(drones).forEach((k) => {
    const o = drones[k];
    if (o.active !== false && !o.purchase_price && droneYearAcres[k]) notes.push(o.name + ': no purchase price on the Drones tab, so drone wear isn\'t counted.');
  });

  // labor
  hours.forEach((h) => {
    const w = wk(h.week), p = pl(h.name), rate = hourlyCost(pay[keyOf(h.name)]);
    w.hours += h.hours; p.hours += h.hours;
    p.weeks[h.week] = p.weeks[h.week] || { acres: 0, hours: 0 }; p.weeks[h.week].hours += h.hours;
    if (rate == null) { w.unpaid_hours += h.hours; return; }
    w.labor += h.hours * rate; p.labor += h.hours * rate;
  });
  Object.values(P).forEach((p) => { if (p.hours && hourlyCost(pay[keyOf(p.name)]) == null) notes.push(p.name + ': no pay rate yet, so their hours aren\'t in labor cost.'); });

  // repairs (maintenance log costs) in their week, and on their drone
  repairs.forEach((m) => { wk(weekOf(m.date)).repairs += m.cost; dr(m.drone).repairs += m.cost; });

  // fuel: each month's total over that month's acres
  const fuelMonths = {};
  exps.filter((e) => e.kind === 'fuel' && String(e.when).slice(0, 4) === year).forEach((e) => { fuelMonths[e.when] = (fuelMonths[e.when] || 0) + e.amount; });
  const fuelMissing = Object.keys(monthAcres).filter((m) => !fuelMonths[m] && m < todayYmd().slice(0, 7)).sort();
  flights.forEach((r) => { const m = r.date.slice(0, 7); if (fuelMonths[m] && monthAcres[m]) wk(weekOf(r.date)).fuel += fuelMonths[m] * (r.acres || 0) / monthAcres[m]; });
  const fuelNoAcres = Object.keys(fuelMonths).filter((m) => !monthAcres[m]);
  if (fuelNoAcres.length) notes.push('Fuel entered for ' + fuelNoAcres.join(', ') + ' with no acres flown that month; it\'s in the season total only.');

  // battery purchases over the season's acres (that drone's, if one was picked and it flew)
  exps.filter((e) => e.kind === 'battery' && String(e.when).slice(0, 4) === year).forEach((e) => {
    const k = e.drone ? keyOf(e.drone) : '';
    const own = k && droneYearAcres[k];
    const pool = own ? flights.filter((r) => keyOf(r.drone.name) === k) : flights;
    const acres = own ? droneYearAcres[k] : yearAcres;
    if (!acres) { notes.push('Battery purchase ' + e.when + ' ($' + e.amount + ') has no acres to spread over yet.'); return; }
    pool.forEach((r) => { const x = e.amount * (r.acres || 0) / acres; wk(weekOf(r.date)).battery += x; dr(r.drone.name).battery += x; });
  });

  // yearly fixed over the year's acres; one-time "other" in its week
  const fixedTotal = exps.filter((e) => e.kind === 'fixed' && e.when === year).reduce((t, e) => t + e.amount, 0);
  if (fixedTotal && yearAcres) flights.forEach((r) => { wk(weekOf(r.date)).fixed += fixedTotal * (r.acres || 0) / yearAcres; });
  exps.filter((e) => e.kind === 'other' && String(e.when).slice(0, 4) === year).forEach((e) => { wk(weekOf(e.when)).other += e.amount; });

  // totals + per-acre / per-hour
  const PARTS = ['labor', 'battery', 'wear', 'repairs', 'fuel', 'fixed', 'other'];
  const weeks = Object.values(W).sort((a, b) => a.week.localeCompare(b.week)).map((w) => {
    const total = PARTS.reduce((t, k) => t + w[k], 0);
    const o = { week: w.week, acres: round(w.acres, 1), flights: w.flights, flight_hours: round(w.flight_min / 60, 1), hours: round(w.hours, 1), unpaid_hours: round(w.unpaid_hours, 1), total: round(total) };
    PARTS.forEach((k) => { o[k] = round(w[k]); });
    o.cost_per_acre = w.acres ? round(total / w.acres) : null;
    o.acres_per_hour = w.hours ? round(w.acres / w.hours, 1) : null;
    o.fuel_missing = fuelMissing.indexOf(w.week.slice(0, 7)) >= 0 || fuelMissing.indexOf(addDays(w.week, 6).slice(0, 7)) >= 0;
    return o;
  });
  const T = { acres: 0, flights: 0, flight_min: 0, hours: 0, unpaid_hours: 0 };
  PARTS.forEach((k) => { T[k] = 0; });
  Object.values(W).forEach((w) => { ['acres', 'flights', 'flight_min', 'hours', 'unpaid_hours'].concat(PARTS).forEach((k) => { T[k] += w[k]; }); });
  const total = PARTS.reduce((t, k) => t + T[k], 0);
  const paidHours = T.hours - T.unpaid_hours;
  const season = {
    acres: round(T.acres, 1), flights: T.flights, flight_hours: round(T.flight_min / 60, 1), hours: round(T.hours, 1), total: round(total),
    cost_per_acre: T.acres ? round(total / T.acres) : null,
    acres_per_hour: T.hours ? round(T.acres / T.hours, 1) : null,
    labor_per_hour: paidHours ? round(T.labor / paidHours) : null,
    parts: PARTS.map((k) => ({ key: k, amount: round(T[k]), per_acre: T.acres ? round(T[k] / T.acres) : null }))
  };
  const pilots = Object.values(P).map((p) => ({
    name: p.name, acres: round(p.acres, 1), flights: p.flights, flight_hours: round(p.flight_min / 60, 1), hours: round(p.hours, 1), labor: round(p.labor),
    acres_per_hour: p.hours ? round(p.acres / p.hours, 1) : null, cost_per_hour: p.hours && p.labor ? round(p.labor / p.hours) : null,
    labor_per_acre: p.acres && p.labor ? round(p.labor / p.acres) : null,
    pay_type: (pay[keyOf(p.name)] || {}).type || '',
    weeks: Object.keys(p.weeks).sort().map((w) => ({ week: w, acres: round(p.weeks[w].acres, 1), hours: round(p.weeks[w].hours, 1), acres_per_hour: p.weeks[w].hours ? round(p.weeks[w].acres / p.weeks[w].hours, 1) : null }))
  })).sort((a, b) => b.acres - a.acres);
  const droneRows = Object.values(D).map((d) => ({
    name: d.name, acres: round(d.acres, 1), flights: d.flights, flight_hours: round(d.flight_min / 60, 1), battery: round(d.battery), wear: round(d.wear), repairs: round(d.repairs),
    machine_per_acre: d.acres ? round((d.battery + d.wear + d.repairs) / d.acres) : null, acres_per_flight: d.flights ? round(d.acres / d.flights, 1) : null
  })).sort((a, b) => b.acres - a.acres);

  // flags: weeks well off the season's normal (needs a few weeks to judge)
  const flags = [];
  const ok = weeks.filter((w) => w.acres >= 20);
  if (ok.length >= 3 && season.cost_per_acre) ok.forEach((w) => { if (w.cost_per_acre > season.cost_per_acre * 1.3) flags.push({ week: w.week, what: 'cost per acre ' + Math.round((w.cost_per_acre / season.cost_per_acre - 1) * 100) + '% above the season' }); });
  if (ok.length >= 3 && season.acres_per_hour) ok.forEach((w) => { if (w.acres_per_hour != null && w.acres_per_hour < season.acres_per_hour * 0.7) flags.push({ week: w.week, what: 'acres per hour ' + Math.round((1 - w.acres_per_hour / season.acres_per_hour) * 100) + '% below the season' }); });
  pilots.forEach((p) => { if (season.acres_per_hour && p.hours >= 20 && p.acres_per_hour != null && p.acres_per_hour < season.acres_per_hour * 0.7) flags.push({ pilot: p.name, what: p.name + '\'s acres per hour ' + Math.round((1 - p.acres_per_hour / season.acres_per_hour) * 100) + '% below the crew' }); });

  return { ok: true, year, season, weeks, pilots, drones: droneRows, fuel_missing: fuelMissing, notes, flags,
    assumptions: { wear_years: WEAR_YEARS, salary_hours: SALARY_HOURS } };
}

/** Spray admin actions for the Costs tab (sprayActions.js passes them here). */
async function costAction(db, me, action, data) {
  if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can see or change costs.');
  switch (action) {
    case 'costs': return costs(db, data);
    case 'getWeek': return Object.assign({ ok: true, pay: await listPay(db) }, await getWeek(db, data.week));
    case 'saveHours': return Object.assign({ ok: true }, await saveHours(db, me, data));
    case 'listPay': return { ok: true, pay: await listPay(db) };
    case 'savePay': return { ok: true, pay: await savePay(db, me, data) };
    case 'listExpenses': return { ok: true, expenses: await listExpenses(db) };
    case 'addExpense': return { ok: true, expenses: await addExpense(db, me, data) };
    case 'deleteExpense': return { ok: true, expenses: await deleteExpense(db, data.id) };
    default: throw new HttpsError('invalid-argument', 'Unknown action.');
  }
}
const COST_ACTIONS = ['costs', 'getWeek', 'saveHours', 'listPay', 'savePay', 'listExpenses', 'addExpense', 'deleteExpense'];

module.exports = { costAction, COST_ACTIONS, _internal: { weekOf, hourlyCost, costs, saveHours, getWeek, savePay, addExpense, listPay, WEAR_YEARS, SALARY_HOURS } };
