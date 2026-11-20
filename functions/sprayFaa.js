// =============================================================================
// Spray schedule — FAA side of the drone operation (Exemption No. 26422, JK Equipment LLC)
// =============================================================================
//  - problems on a flight log: lost link, malfunction, damage (flag the 24-hour report)
//  - the monthly operations report (required every month, zero-flight months too)
//  - company FAA paperwork dates (exemption, renewal petition, COA, AAOC, insurance) and drone
//    registration expirations, with phone alerts 30 and 7 days out (from the daily check in sprayAlerts.js)
// Records: sprayFlights (sprayRecords.js). Settings: sprayMeta/faaPapers, sprayMeta/faaMonthly.

const { HttpsError } = require('firebase-functions/v2/https');

const OPERATOR = { name: 'JK Equipment LLC', address: '20511 F Street, Rupert, ID 83350', exemption: '26422', docket: 'FAA-2024-0943' };
const REPORT_TO = '9-AVS-FS-AFS-700-Correspondence@faa.gov';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 80);
const nowIso = () => new Date().toISOString();
const numOr = (v, d) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
const round1 = (n) => Math.round(n * 10) / 10;
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
const prevMonth = (ymd) => { const y = Number(ymd.slice(0, 4)), m = Number(ymd.slice(5, 7)); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };

// ---- problems on a flight log ----------------------------------------------------------------
const MALFUNCTIONS = ['Control station', 'Electrical', 'Fuel / battery', 'Navigation (GPS)', 'Onboard flight control', 'Powerplant (motor / prop)', 'In-flight fire', 'Other'];
/** { lost_links, lost_link_sec, malfunction, damage, notes } or null when nothing went wrong. */
function cleanProblems(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {
    lost_links: Math.min(99, Math.round(numOr(p.lost_links, 0))),
    lost_link_sec: Math.min(36000, Math.round(numOr(p.lost_link_sec, 0))),
    malfunction: MALFUNCTIONS.indexOf(p.malfunction) >= 0 ? p.malfunction : '',
    damage: p.damage === true,
    notes: clean(p.notes, 500)
  };
  if (!out.lost_links && !out.malfunction && !out.damage && !out.notes) return null;
  if (out.lost_link_sec && !out.lost_links) out.lost_links = 1;
  return out;
}
/** Why this may need the FAA 24-hour report ('' when it doesn't). */
function incidentReason(p) {
  if (!p) return '';
  const why = [];
  if (p.malfunction) why.push(p.malfunction.toLowerCase() + ' malfunction');
  if (p.damage) why.push('damage on takeoff/landing');
  if (p.lost_links) why.push('lost link');
  return why.join(', ');
}
const problemText = (p) => (!p ? '' : [p.lost_links ? p.lost_links + ' lost link' + (p.lost_links === 1 ? '' : 's') + (p.lost_link_sec ? ' (' + p.lost_link_sec + ' s)' : '') : '',
  p.malfunction ? p.malfunction + ' malfunction' : '', p.damage ? 'damage' : '', p.notes].filter(Boolean).join(' · '));

// ---- monthly operations report ---------------------------------------------------------------
const cityKey = (farm) => clean(farm, 80).toLowerCase().replace(/[^a-z0-9]+/g, '_') || '_';
/** The nearest town for each farm (for the monthly report): { farm: city }. */
async function saveCities(db, me, list) {
  const ref = db.collection('sprayMeta').doc('faaCities');
  const cur = (await ref.get()).data() || {};
  (Array.isArray(list) ? list : []).slice(0, 200).forEach((c) => { const k = cityKey(c && c.farm); if (k !== '_') cur[k] = clean(c.city, 60); });
  await ref.set(cur);
  return { ok: true };
}
async function monthlyReport(db, ym) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) throw new HttpsError('invalid-argument', 'Pick the month.');
  const by = {};
  (await db.collection('sprayFlights').get()).forEach((d) => {
    const r = d.data() || {};
    if (r.status === 'void' || String(r.date || '').slice(0, 7) !== ym || !r.drone) return;
    const k = r.drone.faa_reg || r.drone.name;
    const a = by[k] = by[k] || { drone: r.drone.name, faa_reg: r.drone.faa_reg || '', make: r.drone.make || '', model: r.drone.model || '', serial: r.drone.serial || '',
      flights: 0, minutes: 0, locations: {}, damage: 0, malfunctions: [], lost_links: 0, lost_link_sec: 0, events: [] };
    a.flights += Number(r.flights) || 0; a.minutes += Number(r.minutes) || 0;
    const s = r.site || {};
    const lk = s.lat != null ? Number(s.lat).toFixed(5) + ',' + Number(s.lng).toFixed(5) : s.farm + '|' + s.field;
    const loc = a.locations[lk] = a.locations[lk] || { farm: s.farm || '', field: s.field || '', lat: s.lat == null ? null : s.lat, lng: s.lng == null ? null : s.lng, flights: 0, dates: [] };
    loc.flights += Number(r.flights) || 0; if (loc.dates.indexOf(r.date) < 0) loc.dates.push(r.date);
    const p = r.problems;
    if (p) {
      if (p.damage) a.damage++;
      if (p.malfunction) a.malfunctions.push(p.malfunction);
      a.lost_links += p.lost_links || 0; a.lost_link_sec += p.lost_link_sec || 0;
      a.events.push({ date: r.date, field: s.field || '', pilot: (r.pilot || {}).name || '', text: problemText(p) });
    }
  });
  // COA F.2.c asks for the city name with each location: the nearest town set for each farm
  const cities = (await db.collection('sprayMeta').doc('faaCities').get()).data() || {};
  const farms = new Set();
  const aircraft = Object.keys(by).sort().map((k) => { const a = by[k]; a.hours = round1(a.minutes / 60); a.locations = Object.keys(a.locations).map((x) => a.locations[x]).sort((x, y) => (x.farm + x.field).localeCompare(y.farm + y.field));
    a.locations.forEach((l) => { l.city = cities[cityKey(l.farm)] || ''; farms.add(l.farm); }); return a; });
  const sent = ((await db.collection('sprayMeta').doc('faaMonthly').get()).data() || {})[ym] || null;
  return { ok: true, ym, month: monthName(ym), operator: OPERATOR, send_to: REPORT_TO, aircraft, zero: !aircraft.length,
    totals: { flights: aircraft.reduce((t, a) => t + a.flights, 0), hours: round1(aircraft.reduce((t, a) => t + a.minutes, 0) / 60) }, sent,
    farms: [...farms].filter(Boolean).sort().map((f) => ({ farm: f, city: cities[cityKey(f)] || '' })) };
}
async function markSent(db, me, ym, sent) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) throw new HttpsError('invalid-argument', 'Which month?');
  const ref = db.collection('sprayMeta').doc('faaMonthly');
  const cur = (await ref.get()).data() || {};
  if (sent) cur[ym] = { at: nowIso(), by: me.name }; else delete cur[ym];
  await ref.set(cur);
  return { ok: true };
}

// ---- company FAA paperwork -------------------------------------------------------------------
const PAPER_DEFAULTS = [
  { key: 'aaoc', label: 'Operator certificate (AAOC) confirmed under Exemption 26422', due: '', note: 'Form 8710-3 to UAS137Certificates@faa.gov; name must read JK Equipment LLC' },
  { key: 'renewal_start', label: 'Start the exemption renewal petition', due: '2028-02-01', note: 'regulations.gov docket FAA-2024-0943' },
  { key: 'renewal_deadline', label: 'Renewal petition deadline (120 days before it expires)', due: '2028-05-03', note: 'Must meet 14 CFR 11.81. Last time it was filed late and left a gap.' },
  { key: 'coa_end', label: 'Blanket COA ends', due: '2028-07-29', note: 'Ends before the exemption: confirm it renews with the petition' },
  { key: 'exemption_end', label: 'Exemption 26422 expires', due: '2028-08-31', note: '' },
  { key: 'insurance', label: 'Drone liability insurance renews', due: '', note: '' },
  { key: 'ops_manual', label: 'Ops manual + training program annual review', due: '2027-01-15', note: 'And whenever operations change' }
];
async function getPapers(db) {
  const saved = ((await db.collection('sprayMeta').doc('faaPapers').get()).data() || {}).items || [];
  const byKey = {}; saved.forEach((i) => { byKey[i.key] = i; });
  const items = PAPER_DEFAULTS.map((d) => Object.assign({}, d, byKey[d.key] ? { due: byKey[d.key].due || '', note: byKey[d.key].note != null ? byKey[d.key].note : d.note, done: !!byKey[d.key].done } : {}));
  saved.filter((i) => !PAPER_DEFAULTS.some((d) => d.key === i.key)).forEach((i) => items.push(i));   // ones added on the screen
  return items;
}
async function savePapers(db, me, list) {
  if (!Array.isArray(list)) throw new HttpsError('invalid-argument', 'Nothing to save.');
  const items = list.slice(0, 40).map((i, n) => {
    const key = clean(i.key, 40).replace(/[^a-z0-9_]/gi, '') || 'item' + n + '_' + Date.now().toString(36);
    const def = PAPER_DEFAULTS.find((d) => d.key === key);
    const label = def ? def.label : clean(i.label, 120);
    if (!label) throw new HttpsError('invalid-argument', 'Give each item a name.');
    const due = clean(i.due, 10);
    return { key, label, due: YMD.test(due) ? due : '', note: clean(i.note, 300), done: i.done === true };
  });
  await db.collection('sprayMeta').doc('faaPapers').set({ items, updated_by: me.name, updated_at: nowIso() });
  return getPapers(db);
}
/** Items and drone registrations due within 30 days or past due: [{ id, label, due, days, stage }]. */
function paperWarnings(items, drones, today) {
  const out = [];
  const add = (id, label, due) => {
    if (!YMD.test(due || '')) return;
    const days = daysBetween(today, due);
    const stage = days < 0 ? 'expired' : days <= 7 ? '7' : days <= 30 ? '30' : '';
    if (stage) out.push({ id, label, due, days, stage });
  };
  (items || []).forEach((i) => { if (!i.done) add('paper-' + i.key, i.label, i.due); });
  (drones || []).forEach((d) => { if (d && d.active !== false) add('reg-' + (d.id || d.name), d.name + '\'s FAA registration (' + (d.faa_reg || 'no #') + ')', d.reg_exp); });
  return out;
}

/** The daily check (sprayAlerts.checkLicenses, once a day after 7 am): paperwork alerts, and the
 *  monthly report reminder on the 1st (again on the 5th if it isn't marked sent). Returns alerts queued. */
async function dailyAlerts(db, day, now, people, alertsColl) {
  let n = 0;
  const queue = async (id, how, title, body) => {
    const ref = db.collection(alertsColl).doc(id.replace(/[^A-Za-z0-9_-]/g, ''));
    if ((await ref.get()).data()) return;
    await ref.set({ jobKey: ref.id, how, people, title, body, createdAt: now, sendAfter: now, status: people.length ? 'queued' : 'no_one' });
    n++;
  };
  const drones = [];
  (await db.collection('sprayDrones').get()).forEach((d) => drones.push(Object.assign({ id: d.id }, d.data())));
  for (const w of paperWarnings(await getPapers(db), drones, day)) {
    await queue('faa-' + w.id + '-' + w.due + '-' + w.stage, 'faa_paper', '⚠ ' + w.label,
      (w.stage === 'expired' ? 'Was due ' + w.due + '.' : 'Due ' + w.due + ' (in ' + w.days + ' day' + (w.days === 1 ? '' : 's') + ').') + (w.id.indexOf('reg-') === 0 ? ' Spray › Drones.' : ' Spray › FAA › Due dates.'));
  }
  const dd = Number(day.slice(8));
  if (dd === 1 || dd === 5) {
    const ym = prevMonth(day);
    const sent = ((await db.collection('sprayMeta').doc('faaMonthly').get()).data() || {})[ym];
    if (!sent) {
      const r = await monthlyReport(db, ym);
      await queue('faa-monthly-' + ym + '-' + dd, 'faa_monthly', '📋 FAA monthly report for ' + r.month,
        (r.zero ? 'No flights last month: a zero-flight report is still required.' : r.totals.flights + ' flights, ' + r.totals.hours + ' hrs.') + ' Spray › FAA › Monthly report, then mark it sent. Check the manufacturer service bulletins too.');
    }
  }
  return n;
}

// ---- FAA tab overview ------------------------------------------------------------------------
const FIRST_MONTH = '2026-08';   // Exemption 26422 was granted July 29, 2026: reports from August on
/** Everything the FAA tab shows: monthly reports (sent or not, flights), paperwork dates, drone
 *  registrations, and flight logs with problems in the last 60 days (24-hour report check). */
async function overview(db, today) {
  const sent = (await db.collection('sprayMeta').doc('faaMonthly').get()).data() || {};
  const flights = {}, incidents = [];
  const since = new Date(Date.parse(today + 'T12:00:00Z') - 60 * 86400000).toISOString().slice(0, 10);
  (await db.collection('sprayFlights').get()).forEach((d) => {
    const r = d.data() || {};
    if (r.status === 'void') return;
    const ym = String(r.date || '').slice(0, 7);
    const f = flights[ym] = flights[ym] || { flights: 0, minutes: 0 };
    f.flights += Number(r.flights) || 0; f.minutes += Number(r.minutes) || 0;
    if (r.problems && r.date >= since) incidents.push({ id: d.id, date: r.date, field: (r.site || {}).field || '', farm: (r.site || {}).farm || '', pilot: (r.pilot || {}).name || '', drone: (r.drone || {}).name || '', text: problemText(r.problems), reported: r.faa_reported || null });
  });
  // every month from August 2026 through last month, newest first
  const months = [];
  let ym = prevMonth(today);
  while (ym >= FIRST_MONTH && months.length < 36) {
    const f = flights[ym] || { flights: 0, minutes: 0 };
    months.push({ ym, month: monthName(ym), flights: f.flights, hours: round1(f.minutes / 60), sent: sent[ym] || null });
    ym = prevMonth(ym + '-01');
  }
  const drones = [];
  (await db.collection('sprayDrones').get()).forEach((d) => { const o = d.data() || {}; if (o.active !== false) drones.push({ id: d.id, name: o.name, faa_reg: o.faa_reg || '', reg_exp: o.reg_exp || '' }); });
  incidents.sort((a, b) => b.date.localeCompare(a.date));
  const cy = today.slice(0, 7), cf = flights[cy] || { flights: 0, minutes: 0 };
  const notam = (await db.collection('sprayMeta').doc('faaNotam').get()).data() || {};
  return { ok: true, operator: OPERATOR, send_to: REPORT_TO, months, current: { ym: cy, month: monthName(cy), flights: cf.flights, hours: round1(cf.minutes / 60) },
    papers: await getPapers(db), drones, incidents, notam: { coa: notam.coa || '', altitude_ft: notam.altitude_ft || 100, start: notam.start || '06:00', end: notam.end || '20:00' } };
}
/** Mark a flight's problem as reported to the FAA (or not needed). */
async function markIncident(db, me, id, how) {
  const ref = db.collection('sprayFlights').doc(clean(id, 80));
  const r = (await ref.get()).data();
  if (!r || !r.problems) throw new HttpsError('not-found', 'That flight record isn\'t there.');
  const val = how === 'clear' ? null : { how: how === 'not_needed' ? 'not_needed' : 'reported', at: nowIso(), by: me.name };
  await ref.set({ faa_reported: val, history: (r.history || []).concat([{ at: nowIso(), by: me.name, what: val ? (val.how === 'reported' ? 'problem reported to the FAA' : 'problem: FAA report not needed') : 'problem report mark cleared' }]) }, { merge: true });
  return { ok: true };
}

/** Prep NOTAM defaults (FAA tab > NOTAMs): COA number, altitude, usual hours. */
async function saveNotamSettings(db, me, d) {
  const hm = (v, def) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(clean(v, 5)) ? clean(v, 5) : def);
  const alt = Math.round(numOr(d && d.altitude_ft, 100));
  const val = { coa: clean(d && d.coa, 60), altitude_ft: Math.min(200, Math.max(10, alt)), start: hm(d && d.start, '06:00'), end: hm(d && d.end, '20:00'), updated_by: me.name, updated_at: nowIso() };
  await db.collection('sprayMeta').doc('faaNotam').set(val);
  return val;
}

module.exports = { overview, markIncident, saveNotamSettings, saveCities, OPERATOR, REPORT_TO, MALFUNCTIONS, cleanProblems, incidentReason, problemText, monthlyReport, markSent, getPapers, savePapers, dailyAlerts,
  _internal: { paperWarnings, prevMonth, PAPER_DEFAULTS } };
