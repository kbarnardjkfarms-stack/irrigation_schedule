// =============================================================================
// Spray schedule — drone flight records (audit-ready application records + logbooks)
// =============================================================================
// One record per drone flight log, saved when a pilot taps Done on a drone job (or added later by a
// Spray admin). Built to answer an audit:
//
//   Idaho IDAPA 02.03.03.101 (professional applicator records, kept 2 years): who it was applied
//     for (name + address), crop/site, location, size treated, brand name, EPA reg. no., total
//     amount applied, date, time of day, wind velocity + direction, applicator's full name and
//     license number (+ supervisor's for an apprentice).
//   FAA 14 CFR 137.71 (agricultural aircraft operator records, kept 12+ months): customer name +
//     address, date, name and quantity of material dispensed, each pilot's name, address,
//     certificate number, and the date they met 137.19(e).
//
// How the record stays trustworthy:
//   - Browsers can't write sprayFlights (no Firestore rule); only these functions do.
//   - Pilot, drone and product details are copied INTO the record when it's saved, so a later
//     change on the Operators tab or a new drone name doesn't change an old record.
//   - Weather is fetched by the server at the field pin at save time (not typed by anyone).
//   - A record is never overwritten or deleted. A Spray admin can correct it with a reason; each
//     correction is added to history with the old and new value, who, and when. Undoing a Done
//     voids the record (status 'void' + reason), it stays on file.
//
// Firestore:
//   sprayFlights/{id}   the record (see buildRecord)
//   sprayDrones/{id}    name, make, model, faa_reg, serial, battery_cost, battery_cycles,
//                       batteries_per_flight, active, notes (Drones tab, Spray admins)

const { HttpsError } = require('firebase-functions/v2/https');

const FLIGHTS = 'sprayFlights', DRONES = 'sprayDrones';
const COMPANY = { name: 'JK Farms', address: '20511 F Street, Rupert, ID 83350' };
const TZ = 'America/Denver';
const nowIso = () => new Date().toISOString();
const clean = (v, n) => String(v == null ? '' : v).trim().slice(0, n || 120);
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const hmFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const todayYmd = () => ymdFmt.format(new Date());
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass16 = (deg) => (deg == null || !isFinite(deg) ? '' : COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]);
const num = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/,/g, '')); return isFinite(n) ? n : null; };
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const round = (n, d) => { const p = Math.pow(10, d == null ? 2 : d); return Math.round(n * p) / p; };

// ---- weather at the field pin for the hours sprayed (Open-Meteo), stamped by the server ----------
// Uses the company's paid Open-Meteo plan (secret OPEN_METEO_API_KEY, see openMeteo.js) when the
// function has it; otherwise the free service. Recent days come from the forecast service's past
// hours, older dates (a correction months later) from the historical archive.
let apiKeyOf = () => '';
function useApiKey(getter) { apiKeyOf = getter || (() => ''); }
const HOURLY = 'wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,relative_humidity_2m';
const daysAgo = (ymd) => Math.round((Date.parse(todayYmd() + 'T12:00:00Z') - Date.parse(ymd + 'T12:00:00Z')) / 86400000);
function weatherUrl(lat, lng, date, key) {
  const archive = daysAgo(date) > 80;
  const host = archive ? (key ? 'customer-archive-api.open-meteo.com/v1/archive' : 'archive-api.open-meteo.com/v1/archive')
    : (key ? 'customer-api.open-meteo.com/v1/forecast' : 'api.open-meteo.com/v1/forecast');
  return 'https://' + host + '?latitude=' + lat + '&longitude=' + lng + '&hourly=' + HOURLY + '&start_date=' + date + '&end_date=' + date +
    '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=' + encodeURIComponent(TZ) + (key ? '&apikey=' + encodeURIComponent(key) : '');
}
/** Circular mean of wind directions (so 350° and 10° average to 0°, not 180°). */
function meanDir(degs) {
  const v = degs.filter((d) => d != null && isFinite(d));
  if (!v.length) return null;
  const x = v.reduce((t, d) => t + Math.cos(d * Math.PI / 180), 0), y = v.reduce((t, d) => t + Math.sin(d * Math.PI / 180), 0);
  return Math.round(((Math.atan2(y, x) * 180 / Math.PI) + 360) % 360);
}
/** Hourly weather for date, start-end (HH:MM) -> summary of every hour that overlaps the window. */
async function stampWeather(lat, lng, when, deps) {
  if (lat == null || lng == null) return { ok: false, note: 'No map pin for this field, so no weather was recorded.' };
  const w = when || {};
  if (!YMD.test(String(w.date || '')) || !HM.test(String(w.start || '')) || !HM.test(String(w.end || ''))) return { ok: false, note: 'No date and time, so no weather was recorded.' };
  let key = '';
  try { key = (deps && deps.apiKey != null) ? deps.apiKey : apiKeyOf() || ''; } catch (e) { key = ''; }
  try {
    const r = await ((deps && deps.fetch) || fetch)(weatherUrl(lat, lng, w.date, key));
    if (!r.ok) return { ok: false, note: 'Weather service answered ' + r.status + '; no weather recorded.' };
    const h = ((await r.json()) || {}).hourly || {};
    const t = h.time || [];
    const h0 = Number(w.start.slice(0, 2)), h1 = Number(w.end.slice(0, 2)) + (w.end.slice(3) === '00' ? 0 : 1);
    const idx = [];
    t.forEach((x, i) => { const hr = Number(String(x).slice(11, 13)); if (String(x).slice(0, 10) === w.date && hr >= h0 && hr <= Math.max(h0, h1)) idx.push(i); });
    if (!idx.length) return { ok: false, note: 'The weather service had no hours for that time; no weather recorded.' };
    const col = (k) => idx.map((i) => (h[k] || [])[i]).filter((v) => v != null && isFinite(v));
    const ws = col('wind_speed_10m'), gs = col('wind_gusts_10m'), ts = col('temperature_2m'), rh = col('relative_humidity_2m');
    if (!ws.length) return { ok: false, note: 'The weather service had no wind for that time; no weather recorded.' };
    const dir = meanDir(idx.map((i) => (h.wind_direction_10m || [])[i]));
    return {
      ok: true, window: w.start + '–' + w.end,
      wind_mph: round(Math.max(...ws), 0), wind_low_mph: round(Math.min(...ws), 0), gust_mph: gs.length ? round(Math.max(...gs), 0) : null,
      dir_deg: dir, dir: compass16(dir),
      temp_f: ts.length ? round(Math.max(...ts), 0) : null, temp_low_f: ts.length ? round(Math.min(...ts), 0) : null,
      humidity_pct: rh.length ? round(Math.min(...rh), 0) : null, humidity_high_pct: rh.length ? round(Math.max(...rh), 0) : null,
      hours: idx.map((i) => ({ t: String(t[i]).slice(11, 16), wind: round(h.wind_speed_10m[i], 0), gust: h.wind_gusts_10m ? round(h.wind_gusts_10m[i], 0) : null,
        dir: compass16(h.wind_direction_10m ? h.wind_direction_10m[i] : null), temp: h.temperature_2m ? round(h.temperature_2m[i], 0) : null })),
      source: 'Open-Meteo ' + (daysAgo(w.date) > 80 ? 'historical' : 'hourly') + (key ? ' (paid plan)' : '') + ', at the field pin (' + round(lat, 4) + ', ' + round(lng, 4) + ')',
      stamped_at: nowIso()
    };
  } catch (e) {
    return { ok: false, note: 'Weather service unreachable; no weather recorded.' };
  }
}

// ---- products: total amount applied = rate x acres sprayed ----------------------------
/** "16 fl oz/ac" -> { n: 16, unit: 'fl oz' }. Rates not per acre come back null. */
function parseRate(rate) {
  const m = String(rate || '').trim().match(/^([\d.,]+)\s*(.*?)\s*\/\s*(ac|acre|a)\b/i);
  if (!m) return null;
  const n = num(m[1]);
  return n == null ? null : { n, unit: m[2] || '' };
}
function productLines(job, acres) {
  const list = Array.isArray(job.product_detail) && job.product_detail.length ? job.product_detail
    : String(job.products || '').split(',').map((n) => ({ name: n.trim() })).filter((p) => p.name);
  return list.map((p) => {
    const r = parseRate(p.rate);
    let total = '', how = '';
    if (r && acres) { total = round(r.n * acres, 2) + (r.unit ? ' ' + r.unit : ''); how = 'rate x acres sprayed'; }
    else if (p.total && num(job.acres) && acres) {
      const t = num(p.total);
      const unit = String(p.total).replace(/^[\d.,\s]+/, '').trim();
      if (t != null) { total = round(t * acres / num(job.acres), 2) + (unit ? ' ' + unit : ''); how = 'AgWorld total x share of acres sprayed'; }
    }
    if (!total && p.total) { total = String(p.total); how = 'AgWorld total for the job'; }
    return { name: clean(p.name, 120), epa_reg_no: clean(p.epa, 40), rate: clean(p.rate, 60), total_applied: total, total_how: how };
  });
}

// ---- inputs ------------------------------------------------------------------------------
function cleanFlightInput(data, job) {
  const f = data || {};
  const date = clean(f.date, 10) || todayYmd();
  if (!YMD.test(date)) throw new HttpsError('invalid-argument', 'Pick the date flown.');
  if (date > todayYmd()) throw new HttpsError('invalid-argument', 'The date flown can\'t be in the future.');
  const start = clean(f.start, 5), end = clean(f.end, 5);
  if (!HM.test(start)) throw new HttpsError('invalid-argument', 'Enter the start time.');
  if (!HM.test(end)) throw new HttpsError('invalid-argument', 'Enter the end time.');
  if (end <= start) throw new HttpsError('invalid-argument', 'The end time has to be after the start time.');
  const flights = Math.round(num(f.flights) || 0);
  if (flights < 1 || flights > 300) throw new HttpsError('invalid-argument', 'Enter how many flights (battery sets) it took.');
  const acres = num(f.acres);
  if (acres == null || acres <= 0) throw new HttpsError('invalid-argument', 'Enter the acres sprayed.');
  const max = Math.max(5, (num(job && job.acres) || 0) * 1.5);
  if (acres > max) throw new HttpsError('invalid-argument', 'That\'s more acres than the job has (' + (job && job.acres) + ' ac). Check the number.');
  const pilot = clean(f.pilot, 60);
  const drone = clean(f.drone, 60);
  if (!pilot) throw new HttpsError('invalid-argument', 'Pick the pilot.');
  if (!drone) throw new HttpsError('invalid-argument', 'Pick the drone.');
  return { date, start, end, flights, acres: round(acres, 2), pilot, drone, notes: clean(f.notes, 500) };
}

// ---- pilot papers (Operators tab > Drone pilots) ------------------------------------------
// Idaho license types (ISDA): Professional Applicator, Private Applicator, Commercial Apprentice
// (works under a Professional Applicator). Drone work needs the AU (Aerial UAS) category, from July 2026.
const LICENSE_TYPES = { professional: 'Professional Applicator', private: 'Private Applicator', apprentice: 'Commercial Apprentice' };
function cleanPilotPapers(d) {
  const ymd = (v) => (YMD.test(clean(v, 10)) ? clean(v, 10) : '');
  return {
    license_no: clean(d.license_no, 40), license_type: LICENSE_TYPES[d.license_type] ? d.license_type : '',
    license_cats: clean(d.license_cats, 80).toUpperCase(), license_exp: ymd(d.license_exp), license_issued: ymd(d.license_issued),
    // who supervises them: a Professional Applicator on the Operators tab (picked by name), for an
    // apprentice or someone with no license yet. The record spells out that person's license.
    supervisor: d.license_type === 'apprentice' || !clean(d.license_no, 40) ? clean(d.supervisor, 120) : '',
    // the chief supervisor named in the Part 137 certificate paperwork (shown on the FAA reports)
    chief: d.chief === true,
    faa_cert: clean(d.faa_cert, 40), part137_date: ymd(d.part137_date), address: clean(d.address, 160),
    // FAA remote pilot: the certificate doesn't expire, but the online recurrent course is due every 24 calendar months
    faa_recurrent: ymd(d.faa_recurrent),
    // third-class medical: 60 calendar months if under 40 on the exam date, 24 if 40 or older
    medical_issued: ymd(d.medical_issued), medical_over40: d.medical_over40 === true
  };
}

// ---- renewal dates ---------------------------------------------------------------------------
/** Last day of the month n calendar months after ymd's month (FAA "calendar months"). */
function calMonthsEnd(ymd, n) {
  if (!YMD.test(String(ymd || ''))) return '';
  const [y, m] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n + 1, 0)).toISOString().slice(0, 10);
}
const plusYears = (ymd, n) => { if (!YMD.test(String(ymd || ''))) return ''; const [y, m, d] = ymd.split('-').map(Number); const e = new Date(Date.UTC(y + n, m - 1, d)); if (e.getUTCMonth() !== m - 1) e.setUTCDate(0); return e.toISOString().slice(0, 10); };
/** An operator's renewal dates: [{ kind, label, due, figured }]. The license date printed on the card
 *  wins; without it, Idaho's terms (July 2026 rule): Professional/Private 5 years from renewal,
 *  Commercial Apprentice 2 years from issue (not renewable). */
function renewals(o) {
  const out = [];
  const lic = o.license_exp || (o.license_issued ? plusYears(o.license_issued, o.license_type === 'apprentice' ? 2 : 5) : '');
  if (lic) out.push({ kind: 'license', label: 'Idaho applicator license', due: lic, figured: !o.license_exp });
  if (o.crew === 'drone' && o.faa_recurrent) out.push({ kind: 'faa', label: 'FAA recurrent training (online course)', due: calMonthsEnd(o.faa_recurrent, 24), figured: true });
  if (o.crew === 'drone' && o.medical_issued) out.push({ kind: 'medical', label: 'Third-class medical', due: calMonthsEnd(o.medical_issued, o.medical_over40 ? 24 : 60), figured: true });
  return out;
}
/** What goes into a record about the pilot (a copy, so later edits don't change old records). */
const dueOf = (p, kind) => ((renewals(Object.assign({ crew: 'drone' }, p)).find((r) => r.kind === kind) || {}).due || '');
function pilotSnap(p) {
  return {
    name: p.name, license_no: p.license_no || '', license_type: LICENSE_TYPES[p.license_type] || '', license_cats: p.license_cats || '',
    license_exp: dueOf(p, 'license'), faa_cert: p.faa_cert || '', part137_date: p.part137_date || '',
    faa_current_until: dueOf(p, 'faa'), medical_until: dueOf(p, 'medical'),
    address: p.address || COMPANY.address, supervisor: p.supervisor || ''
  };
}
function pilotGaps(pilot, date, ground) {
  const out = [];
  const who = ground ? 'operator' : 'pilot';
  if (!pilot.license_no) out.push(who + '\'s Idaho license number');
  if (!ground && pilot.license_no && !/\bAU\b/.test(pilot.license_cats || '')) out.push('AU (Aerial UAS) category on the pilot\'s license');
  if (pilot.license_exp && pilot.license_exp < date) out.push(who + '\'s Idaho license was expired on the ' + (ground ? 'date applied' : 'date flown'));
  if (!ground && pilot.faa_current_until && pilot.faa_current_until < date) out.push('pilot\'s FAA recurrent training was past due on the date flown');
  if (!ground && pilot.medical_until && pilot.medical_until < date) out.push('pilot\'s third-class medical had run out on the date flown');
  if ((pilot.license_type === LICENSE_TYPES.apprentice || !pilot.license_no) && !pilot.supervisor) out.push('supervising Professional Applicator');
  if (ground) return out;
  if (!pilot.faa_cert) out.push('pilot\'s FAA certificate number');
  if (!pilot.part137_date) out.push('pilot\'s Part 137 knowledge/skill date');
  return out;
}

/** "Name · Professional Applicator #PA-1" for a supervisor picked by name (older free-text kept as is). */
async function withSupervisor(db, op, allOps) {
  if (!op || !op.supervisor) return op;
  let list = allOps;
  if (!list) { list = []; (await db.collection('sprayOperators').get()).forEach((d) => list.push(d.data() || {})); }
  const s = list.find((o) => normName(o.name) && normName(o.name) === normName(op.supervisor));
  if (s) op.supervisor = s.name + ' · ' + (LICENSE_TYPES[s.license_type] || 'Idaho license') + ' #' + (s.license_no || '—');
  return op;
}

async function findPilot(db, name) {
  const snap = await db.collection('sprayOperators').get();
  let hit = null;
  snap.forEach((d) => {
    const o = d.data() || {};
    if (hit || o.crew !== 'drone') return;
    if (normName(o.name) && normName(o.name) === normName(name)) hit = Object.assign({ id: d.id }, o);
  });
  if (!hit) throw new HttpsError('invalid-argument', name + ' isn\'t on the Operators tab as a drone pilot.');
  return hit;
}
async function findDrone(db, name) {
  const snap = await db.collection(DRONES).get();
  let hit = null;
  snap.forEach((d) => { const o = d.data() || {}; if (!hit && normName(o.name) === normName(name)) hit = Object.assign({ id: d.id }, o); });
  if (!hit) throw new HttpsError('invalid-argument', name + ' isn\'t on the Drones tab.');
  return hit;
}

const minutesBetween = (a, b) => { const [h1, m1] = a.split(':').map(Number), [h2, m2] = b.split(':').map(Number); return (h2 * 60 + m2) - (h1 * 60 + m1); };

/** The full record, with everything an inspector asks for copied in. */
function buildRecord(job, jobKey, input, pilot, drone, weather, me) {
  const pSnap = pilotSnap(pilot);
  const missing = pilotGaps(pSnap, input.date);
  if (!drone.faa_reg) missing.push('drone\'s FAA registration');
  if (!weather.ok) missing.push('weather');
  const products = productLines(job, input.acres);
  if (products.some((p) => !p.epa_reg_no)) missing.push('EPA reg. no. on a product');
  if (products.some((p) => !p.total_applied)) missing.push('total amount on a product');
  if (job.lat == null) missing.push('field location');
  return {
    job_key: String(jobKey), agworld_id: String(job.agworld_id || jobKey), agworld_link: job.agworld_link || '', job_title: job.title || '',
    status: 'active',
    applied_for: { name: COMPANY.name, address: COMPANY.address, farm: job.farm || '' },
    site: { field: job.field || '', fields: (job.fields || []).map((f) => ({ name: f.name || '', acres: f.acres || null })), farm: job.farm || '', crop: job.crop || '',
      lat: job.lat == null ? null : job.lat, lng: job.lng == null ? null : job.lng },
    date: input.date, start: input.start, end: input.end, minutes: minutesBetween(input.start, input.end),
    acres: input.acres, job_acres: num(job.acres), flights: input.flights,
    products,
    weather,
    pilot: pSnap,
    drone: { name: drone.name, make: drone.make || '', model: drone.model || '', faa_reg: drone.faa_reg || '', serial: drone.serial || '' },
    notes: input.notes,
    missing,
    entered_by: me.name, entered_via: me.crewLink ? 'crew link' : 'AIO login', entered_at: nowIso(),
    history: [{ at: nowIso(), by: me.name, what: 'created' }]
  };
}

/** Save a flight record for a drone job. deps: { fetch } for tests. Returns { id, record }. */
async function logFlight(db, me, job, jobKey, data, deps) {
  if (!job || job.source !== 'drone') throw new HttpsError('invalid-argument', 'Flight records are for drone jobs.');
  const input = cleanFlightInput(data, job);
  const [pilot, drone] = await Promise.all([findPilot(db, input.pilot).then((p) => withSupervisor(db, p)), findDrone(db, input.drone)]);
  const weather = await stampWeather(job.lat, job.lng, { date: input.date, start: input.start, end: input.end }, deps);
  const record = buildRecord(job, jobKey, input, pilot, drone, weather, me);
  const ref = db.collection(FLIGHTS).doc();
  await ref.set(record);
  return { id: ref.id, record };
}

const EDITABLE = ['date', 'start', 'end', 'flights', 'acres', 'pilot', 'drone', 'notes'];

/** Spray admin correction. Needs a reason; adds a history entry with old -> new. */
async function editFlight(db, me, data, deps) {
  if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can correct a flight record.');
  const id = clean(data && data.id, 80);
  const reason = clean(data && data.reason, 300);
  if (!id) throw new HttpsError('invalid-argument', 'Which record?');
  if (reason.length < 4) throw new HttpsError('invalid-argument', 'Say why it\'s being corrected (it goes in the record\'s history).');
  const ref = db.collection(FLIGHTS).doc(id);
  const rec = (await ref.get()).data();
  if (!rec) throw new HttpsError('not-found', 'That record isn\'t there.');
  if (rec.status === 'void') throw new HttpsError('failed-precondition', 'That record was voided. Add a new one instead.');
  const job = (await db.collection('sprayJobs').doc(rec.job_key).get()).data() ||
    { source: 'drone', acres: rec.job_acres, product_detail: rec.products.map((p) => ({ name: p.name, rate: p.rate, epa: p.epa_reg_no, total: p.total_applied })), lat: rec.site.lat, lng: rec.site.lng, field: rec.site.field, farm: rec.site.farm, crop: rec.site.crop };
  const cur = { date: rec.date, start: rec.start, end: rec.end, flights: rec.flights, acres: rec.acres, pilot: rec.pilot.name, drone: rec.drone.name, notes: rec.notes };
  const next = cleanFlightInput(Object.assign({}, cur, data.changes || {}), job);
  const changes = {};
  EDITABLE.forEach((k) => { if (String(cur[k]) !== String(next[k])) changes[k] = [cur[k], next[k]]; });
  if (!Object.keys(changes).length) return { ok: true, unchanged: true };
  const upd = { date: next.date, start: next.start, end: next.end, minutes: minutesBetween(next.start, next.end), flights: next.flights, acres: next.acres, notes: next.notes };
  if (changes.pilot) {
    const p = await withSupervisor(db, await findPilot(db, next.pilot));
    upd.pilot = pilotSnap(p);
  }
  if (changes.drone) {
    const d = await findDrone(db, next.drone);
    upd.drone = { name: d.name, make: d.make || '', model: d.model || '', faa_reg: d.faa_reg || '', serial: d.serial || '' };
  }
  if (changes.acres) upd.products = productLines(job, next.acres);
  if (changes.date || changes.start || changes.end) upd.weather = await stampWeather(rec.site.lat, rec.site.lng, { date: next.date, start: next.start, end: next.end }, deps);
  upd.history = (rec.history || []).concat([{ at: nowIso(), by: me.name, what: 'corrected', reason, changes }]);
  await ref.set(upd, { merge: true });
  return { ok: true, changes };
}

/** Void instead of delete. Spray admin, or the system on Undo (me.system). */
async function voidFlight(db, me, id, reason) {
  if (!me.admin && !me.system) throw new HttpsError('permission-denied', 'Only a Spray admin can void a flight record.');
  const ref = db.collection(FLIGHTS).doc(String(id));
  const rec = (await ref.get()).data();
  if (!rec || rec.status === 'void') return { ok: true };
  const why = clean(reason, 300) || 'voided';
  await ref.set({ status: 'void', void: { at: nowIso(), by: me.name, reason: why },
    history: (rec.history || []).concat([{ at: nowIso(), by: me.name, what: 'voided', reason: why }]) }, { merge: true });
  return { ok: true };
}

// ---- Reports tab: records in a date range, + drone jobs done with no flight record ------------
async function listFlights(db, data) {
  const from = YMD.test(clean(data && data.from, 10)) ? clean(data.from, 10) : todayYmd().slice(0, 4) + '-01-01';
  const to = YMD.test(clean(data && data.to, 10)) ? clean(data.to, 10) : todayYmd();
  const flights = [];
  (await db.collection(FLIGHTS).get()).forEach((d) => {
    const r = d.data() || {};
    if (r.date >= from && r.date <= to) flights.push(Object.assign({ id: d.id }, r));
  });
  flights.sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
  const maint = await listMaint(db, { from, to });
  // drone jobs marked done (app or AgWorld) in the range that have no flight record
  const [jSnap, sSnap, kSnap] = await Promise.all([db.collection('sprayJobs').get(), db.collection('sprayJobState').get(), db.collection(NOLOG).get()]);
  const jobs = {}, kept = {};
  jSnap.forEach((d) => { jobs[d.id] = d.data() || {}; });
  kSnap.forEach((d) => { kept[d.id] = d.data() || {}; });
  const logged = new Set(flights.filter((f) => f.status !== 'void').map((f) => f.job_key));
  const unlogged = [];
  sSnap.forEach((d) => {
    const st = d.data() || {}, j = jobs[d.id], dn = st.done;
    if (!dn || !j || j.source !== 'drone' || st.hidden) return;
    const day = String(dn.completed_date || '');
    if (day < from || day > to || logged.has(d.id)) return;
    if (dn.flight_id && flights.some((f) => f.id === dn.flight_id && f.status !== 'void')) return;
    unlogged.push({ job_key: d.id, field: j.field || '', farm: j.farm || '', crop: j.crop || '', acres: j.acres || null, completed_date: day,
      entered_by: dn.entered_by || '', operator: dn.operator || '', product_detail: j.product_detail || [] });
  });
  // ones whose job has left the schedule (45 days back): from the kept copy
  Object.keys(kept).forEach((k) => {
    if (jobs[k] || logged.has(k) || unlogged.some((u) => u.job_key === k)) return;
    const j = kept[k].job || {}, dn = kept[k].done || {};
    const day = String(dn.completed_date || '');
    if (day < from || day > to) return;
    unlogged.push({ job_key: k, field: j.field || '', farm: j.farm || '', crop: j.crop || '', acres: j.acres || null, completed_date: day,
      entered_by: dn.entered_by || '', operator: dn.operator || '', product_detail: j.product_detail || [], off_schedule: true });
  });
  unlogged.sort((a, b) => a.completed_date.localeCompare(b.completed_date));
  return { ok: true, from, to, company: COMPANY, flights, unlogged, maint };
}

// ---- Ag Rows (ground) application records ------------------------------------------------------
// Ag Rows keeps one-tap Done. The tap saves the record: the time of the tap, the operator assigned
// on the schedule with their Idaho license copied in, the job's products and acres, and the weather
// at the field for the hour before the tap. When the job closes in AgWorld, AgWorld's actual acres,
// gallons and recorded conditions are shown beside it (Reports reads them from the job's Done row).
// Firestore: sprayGroundRecs/{id}  job_key, status, ... (no browser rule)
const GROUND = 'sprayGroundRecs';
const hmNow = () => hmFmt.format(new Date()).replace(/^24/, '00');
const minusHour = (hm) => { const [h, m] = hm.split(':').map(Number); const t = Math.max(0, h * 60 + m - 60); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
async function findOperator(db, name) {
  let hit = null;
  (await db.collection('sprayOperators').get()).forEach((d) => { const o = d.data() || {}; if (!hit && o.crew !== 'drone' && normName(o.name) && normName(o.name) === normName(name)) hit = Object.assign({ id: d.id }, o); });
  return hit;
}
function groundRecord(job, jobKey, operator, opRow, date, end, weather, me) {
  const op = opRow ? pilotSnap(opRow) : { name: operator || '', license_no: '', license_type: '', license_cats: '', license_exp: '', supervisor: '' };
  delete op.faa_cert; delete op.part137_date; delete op.faa_current_until; delete op.medical_until;
  const missing = operator ? pilotGaps(op, date, true) : ['operator (nobody assigned on the schedule)'];
  if (operator && !opRow) missing.push(operator + ' isn\'t on the Operators tab');
  if (!weather.ok) missing.push('weather');
  const products = productLines(job, num(job.acres));
  if (products.some((p) => !p.epa_reg_no)) missing.push('EPA reg. no. on a product');
  if (job.lat == null) missing.push('field location');
  return {
    job_key: String(jobKey), agworld_id: String(job.agworld_id || jobKey), agworld_link: job.agworld_link || '', job_title: job.title || '', job_type: job.job_type || '',
    status: 'active', applied_for: { name: COMPANY.name, address: COMPANY.address, farm: job.farm || '' },
    site: { field: job.field || '', farm: job.farm || '', crop: job.crop || '', lat: job.lat == null ? null : job.lat, lng: job.lng == null ? null : job.lng },
    date, done_time: end, acres: num(job.acres), products, weather, operator: op, rig: '', missing,
    entered_by: me.name, entered_via: me.crewLink ? 'crew link' : 'AIO login', entered_at: nowIso(), history: [{ at: nowIso(), by: me.name, what: 'created (Done tapped)' }]
  };
}
/** One-tap Done on an Ag Rows job. Never throws (the Done itself must not fail over a record). */
async function logGround(db, me, job, jobKey, operator, deps) {
  try {
    const date = todayYmd(), end = hmNow();
    const opRow = operator ? await withSupervisor(db, await findOperator(db, operator)) : null;
    const weather = await stampWeather(job.lat, job.lng, { date, start: minusHour(end), end }, deps);
    const rec = groundRecord(job, jobKey, operator, opRow, date, end, weather, me);
    const ref = db.collection(GROUND).doc();
    await ref.set(rec);
    return { id: ref.id, record: rec };
  } catch (e) {
    console.error('logGround', e);
    return { id: '', record: { missing: ['record could not be saved: ' + e.message] } };
  }
}
async function voidGround(db, me, jobKey, reason) {
  const snap = await db.collection(GROUND).get();
  const why = clean(reason, 300) || 'voided';
  const jobs = [];
  snap.forEach((d) => { const r = d.data() || {}; if (r.job_key === String(jobKey) && r.status !== 'void') jobs.push(d.ref.set({ status: 'void', void: { at: nowIso(), by: me.name, reason: why }, history: (r.history || []).concat([{ at: nowIso(), by: me.name, what: 'voided', reason: why }]) }, { merge: true })); });
  await Promise.all(jobs);
  return { ok: true };
}
/** The sync (spraySync.js) passes every Ag Rows job closed in AgWorld: [{ k, job, done, operator }].
 *  A job with no Done in the app gets its own permanent record ('agworld-<job>'), so it stays in the
 *  reports after the job leaves the schedule (the schedule keeps jobs 45 days back). Written once;
 *  after that only AgWorld's actuals are updated, and only when they change. Never throws. */
async function saveAgworldGround(db, items) {
  try {
    if (!items || !items.length) return 0;
    const [gSnap, oSnap] = await Promise.all([db.collection(GROUND).get(), db.collection('sprayOperators').get()]);
    const recs = {}, appJob = new Set();
    gSnap.forEach((d) => { const r = d.data() || {}; recs[d.id] = r; if (!r.from_agworld_only && r.status !== 'void') appJob.add(r.job_key); });
    const allOps = [];
    oSnap.forEach((d) => allOps.push(d.data() || {}));
    const actualOf = (dn) => ({ completed_date: dn.completed_date || '', acres: dn.acres_done == null ? null : dn.acres_done, gallons: dn.gallons == null ? null : dn.gallons,
      gpa: dn.gpa == null ? null : dn.gpa, conditions: dn.conditions || '', products: (dn.product_detail || []).map((p) => ({ name: p.name || '', rate: p.rate || '', total: p.total || '', epa: p.epa || '' })) });
    let n = 0;
    for (const it of items) {
      const k = String(it.k), j = it.job || {}, dn = it.done || {};
      if (appJob.has(k)) continue;                       // a Done in the app already made the record
      const id = 'agworld-' + k.replace(/[^A-Za-z0-9_-]/g, '');
      const act = actualOf(dn);
      const old = recs[id];
      if (old) {
        if (old.status !== 'void' && JSON.stringify(old.agworld || null) !== JSON.stringify(act)) { await db.collection(GROUND).doc(id).set({ agworld: act, updated_at: nowIso() }, { merge: true }); n++; }
        continue;
      }
      const day = String(dn.completed_date || '');
      const opName = it.operator || dn.operator || '';
      const o = allOps.find((x) => x.crew !== 'drone' && normName(x.name) && normName(x.name) === normName(opName));
      const op = o ? await withSupervisor(db, pilotSnap(Object.assign({}, o)), allOps) : { name: opName, license_no: '', license_type: '', license_cats: '', supervisor: '' };
      delete op.faa_cert; delete op.part137_date; delete op.faa_current_until; delete op.medical_until;
      const missing = ['time of day (closed in AgWorld, no Done in the app)'].concat(opName ? pilotGaps(op, day, true) : ['operator (nobody assigned on the schedule)']);
      await db.collection(GROUND).doc(id).set({
        from_agworld_only: true, job_key: k, agworld_id: String(j.agworld_id || k), agworld_link: j.agworld_link || '', job_title: j.title || '', job_type: j.job_type || '',
        status: 'active', applied_for: { name: COMPANY.name, address: COMPANY.address, farm: j.farm || '' },
        site: { field: j.field || '', farm: j.farm || '', crop: j.crop || '', lat: j.lat == null ? null : j.lat, lng: j.lng == null ? null : j.lng },
        date: day, done_time: '', acres: num(j.acres), products: productLines(j, num(j.acres)),
        weather: { ok: false, note: 'No Done in the app; see AgWorld\'s conditions.' }, operator: op, missing, agworld: act,
        entered_by: 'AgWorld', entered_via: 'AgWorld sync', entered_at: nowIso(), history: [{ at: nowIso(), by: 'AgWorld sync', what: 'saved from AgWorld (closed there)' }]
      });
      n++;
    }
    return n;
  } catch (e) {
    console.error('saveAgworldGround', e);
    return 0;
  }
}

// Drone jobs closed in AgWorld with no flight log: a copy of the job is kept here until the flight
// log is added, so the Reports warning and its "Add flight log" button survive the job leaving the
// schedule (45 days back). Firestore: sprayNoLog/{jobKey} { job, done, saved_at } (no browser rule)
const NOLOG = 'sprayNoLog';
/** From the sync: [{ k, job, done }]. Saves the ones not kept yet. Never throws. */
async function keepUnlogged(db, items) {
  try {
    if (!items || !items.length) return 0;
    const have = new Set();
    (await db.collection(NOLOG).get()).forEach((d) => have.add(d.id));
    let n = 0;
    for (const it of items) {
      const k = String(it.k);
      if (have.has(k)) continue;
      await db.collection(NOLOG).doc(k).set({ job: it.job || {}, done: it.done || {}, saved_at: nowIso() });
      n++;
    }
    return n;
  } catch (e) { console.error('keepUnlogged', e); return 0; }
}

/** Reports + crew link: Ag Rows records in a date range, with AgWorld's actuals beside them.
 *  Ag Rows jobs closed only in AgWorld (no Done in the app) show too, flagged for the missing time. */
async function listGround(db, data, opts) {
  const from = YMD.test(clean(data && data.from, 10)) ? clean(data.from, 10) : todayYmd().slice(0, 4) + '-01-01';
  const to = YMD.test(clean(data && data.to, 10)) ? clean(data.to, 10) : todayYmd();
  const [gSnap, jSnap, sSnap, oSnap] = await Promise.all([db.collection(GROUND).get(), db.collection('sprayJobs').get(), db.collection('sprayJobState').get(), db.collection('sprayOperators').get()]);
  const jobs = {}, states = {}, ops = {};
  jSnap.forEach((d) => { jobs[d.id] = d.data() || {}; });
  sSnap.forEach((d) => { states[d.id] = d.data() || {}; });
  const allOps = [];
  oSnap.forEach((d) => { const o = d.data() || {}; allOps.push(o); if (o.crew !== 'drone') ops[normName(o.name)] = o; });
  const actual = (k) => {
    const dn = (states[k] || {}).done;
    if (!dn || !String(dn.entered_by || '').startsWith('AgWorld')) return null;
    return { completed_date: dn.completed_date || '', acres: dn.acres_done == null ? null : dn.acres_done, gallons: dn.gallons == null ? null : dn.gallons,
      gpa: dn.gpa == null ? null : dn.gpa, conditions: dn.conditions || '', products: (dn.product_detail || []).map((p) => ({ name: p.name || '', rate: p.rate || '', total: p.total || '', epa: p.epa || '' })) };
  };
  const recs = [], have = new Set();
  gSnap.forEach((d) => {
    const r = d.data() || {};
    if (r.date < from || r.date > to) return;
    if (r.status !== 'void') have.add(r.job_key);
    recs.push(Object.assign({ id: d.id }, r, { agworld: actual(r.job_key) || r.agworld || null }));
  });
  Object.keys(states).forEach((k) => {
    const st = states[k], dn = st.done, j = jobs[k];
    if (!dn || !j || j.source === 'drone' || st.hidden || have.has(k)) return;
    const day = String(dn.completed_date || '');
    if (day < from || day > to || !String(dn.entered_by || '').startsWith('AgWorld')) return;
    const opName = (st.assign && st.assign.operator) || dn.operator || '';
    const o = ops[normName(opName)];
    const op = o ? pilotSnap(Object.assign({}, o, { supervisor: o.supervisor })) : { name: opName, license_no: '', license_type: '', license_cats: '', supervisor: '' };
    if (o && o.supervisor) { const sv = allOps.find((x) => normName(x.name) === normName(o.supervisor)); if (sv) op.supervisor = sv.name + ' · ' + (LICENSE_TYPES[sv.license_type] || 'Idaho license') + ' #' + (sv.license_no || '—'); }
    delete op.faa_cert; delete op.part137_date; delete op.faa_current_until; delete op.medical_until;
    const missing = ['time of day (closed in AgWorld, no Done in the app)'].concat(opName ? pilotGaps(op, day, true) : ['operator (nobody assigned on the schedule)']);
    recs.push({ id: 'agworld-' + k, from_agworld_only: true, job_key: k, job_type: j.job_type || '', status: 'active',
      applied_for: { name: COMPANY.name, address: COMPANY.address, farm: j.farm || '' },
      site: { field: j.field || '', farm: j.farm || '', crop: j.crop || '', lat: j.lat == null ? null : j.lat, lng: j.lng == null ? null : j.lng },
      date: day, done_time: '', acres: num(j.acres), products: productLines(j, num(j.acres)), weather: { ok: false, note: 'No Done in the app; see AgWorld\'s conditions.' },
      operator: op, missing, agworld: actual(k), history: [] });
  });
  recs.sort((a, b) => (a.date + (a.done_time || '')).localeCompare(b.date + (b.done_time || '')));
  const out = (opts && opts.crew) ? recs.filter((r) => r.status !== 'void').map((r) => ({ id: r.id, date: r.date, done_time: r.done_time, job_type: r.job_type,
    site: { field: r.site.field, farm: r.site.farm, crop: r.site.crop }, acres: r.agworld && r.agworld.acres != null ? r.agworld.acres : r.acres,
    gallons: r.agworld ? r.agworld.gallons : null, operator: { name: r.operator.name }, products: r.products.map((p) => ({ name: p.name, rate: p.rate })) })) : recs;
  return { ok: true, from, to, company: COMPANY, records: out };
}

// ---- drone maintenance log (Drones tab; shows in the drone's logbook) ----------------------------
// Firestore: sprayMaint/{id}  drone_id, drone, date, kind, what, by, cost, status, history (no browser rule)
const MAINT = 'sprayMaint';
const MAINT_KINDS = ['Repair', 'Part replaced', 'Inspection', 'Firmware update', 'Battery retired', 'Other'];
async function addMaint(db, me, data) {
  if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can add to the maintenance log.');
  const id = clean(data && data.droneId, 80);
  const dr = id ? (await db.collection(DRONES).doc(id).get()).data() : null;
  if (!dr) throw new HttpsError('invalid-argument', 'Which drone?');
  const date = clean(data.date, 10);
  if (!YMD.test(date) || date > todayYmd()) throw new HttpsError('invalid-argument', 'Pick the date (not in the future).');
  const what = clean(data.what, 500);
  if (what.length < 3) throw new HttpsError('invalid-argument', 'Say what was done.');
  const cost = num(data.cost);
  const rec = { drone_id: id, drone: dr.name, drone_faa_reg: dr.faa_reg || '', date, kind: MAINT_KINDS.indexOf(data.kind) >= 0 ? data.kind : 'Other', what,
    by: clean(data.by, 80) || me.name, cost: cost == null || cost < 0 ? null : round(cost, 2), status: 'active',
    entered_by: me.name, entered_at: nowIso(), history: [{ at: nowIso(), by: me.name, what: 'created' }] };
  const ref = db.collection(MAINT).doc();
  await ref.set(rec);
  return { ok: true, id: ref.id };
}
async function voidMaint(db, me, id, reason) {
  if (!me.admin) throw new HttpsError('permission-denied', 'Only a Spray admin can void a maintenance entry.');
  const why = clean(reason, 300);
  if (why.length < 4) throw new HttpsError('invalid-argument', 'Say why it\'s being voided (it stays on file with the reason).');
  const ref = db.collection(MAINT).doc(clean(id, 80));
  const r = (await ref.get()).data();
  if (!r || r.status === 'void') return { ok: true };
  await ref.set({ status: 'void', void: { at: nowIso(), by: me.name, reason: why }, history: (r.history || []).concat([{ at: nowIso(), by: me.name, what: 'voided', reason: why }]) }, { merge: true });
  return { ok: true };
}
async function listMaint(db, data) {
  const out = [];
  (await db.collection(MAINT).get()).forEach((d) => {
    const r = d.data() || {};
    if (data && data.from && r.date < data.from) return;
    if (data && data.to && r.date > data.to) return;
    out.push(Object.assign({ id: d.id }, r));
  });
  return out.sort((a, b) => (b.date + b.entered_at).localeCompare(a.date + a.entered_at));
}

// ---- drone warranty: one year from the day it was activated -------------------------------------
function warrantyEnd(activated) {
  if (!YMD.test(String(activated || ''))) return '';
  const [y, m, d] = activated.split('-').map(Number);
  const end = new Date(Date.UTC(y + 1, m - 1, d));
  if (end.getUTCMonth() !== m - 1) end.setUTCDate(0);   // Feb 29 -> Feb 28
  return end.toISOString().slice(0, 10);
}
/** Drones whose warranty ends within 30 days: [{ id, name, ends, days }]. */
function warrantyWarnings(dronesList, today) {
  const t = today || todayYmd();
  const out = [];
  (dronesList || []).forEach((d) => {
    if (!d || d.active === false) return;
    const ends = warrantyEnd(d.activated);
    if (!ends) return;
    const days = Math.round((Date.parse(ends + 'T12:00:00Z') - Date.parse(t + 'T12:00:00Z')) / 86400000);
    if (days >= 0 && days <= 30) out.push({ id: d.id || normName(d.name), name: d.name, ends, days });
  });
  return out;
}

// ---- license expirations (checked once a day by the alert sender, sprayAlerts.js) --------------
/** [{ id, name, crew, license_no, exp, days, stage: '30' | '7' | 'expired' }] for active operators. */
function licenseWarnings(opsList, today) {
  const t = today || todayYmd();
  const out = [];
  (opsList || []).forEach((o) => {
    if (!o || o.active === false) return;
    renewals(o).forEach((r) => {
      const days = Math.round((Date.parse(r.due + 'T12:00:00Z') - Date.parse(t + 'T12:00:00Z')) / 86400000);
      const stage = days < 0 ? 'expired' : days <= 7 ? '7' : days <= 30 ? '30' : '';
      if (stage) out.push({ id: o.id || normName(o.name), name: o.name, crew: o.crew, kind: r.kind, label: r.label, license_no: r.kind === 'license' ? o.license_no || '' : '', exp: r.due, days, stage });
    });
  });
  return out;
}

// ---- drones list (Drones tab) ------------------------------------------------------------
function cleanDrone(d) {
  const name = clean(d && d.name, 60);
  if (!normName(name) && !/\d/.test(name)) throw new HttpsError('invalid-argument', 'Give the drone a nickname (what pilots pick on the Done form).');
  const n = (v) => { const x = num(v); return x == null || x < 0 ? null : x; };
  return {
    name, make: clean(d.make, 40), model: clean(d.model, 60), faa_reg: clean(d.faa_reg, 40).toUpperCase(), serial: clean(d.serial, 60),
    battery_cost: n(d.battery_cost), battery_cycles: n(d.battery_cycles), batteries_per_flight: n(d.batteries_per_flight),
    // acres flown before the app's flight records started; the drone's total = this + every flight record since
    acres_before: n(d.acres_before),
    // what was paid for the drone (comes with 3 batteries and a charging station), for the Costs tab
    purchase_price: n(d.purchase_price),
    // the day it was activated: the warranty runs one year from it (warrantyEnd)
    activated: YMD.test(clean(d.activated, 10)) && clean(d.activated, 10) <= todayYmd() ? clean(d.activated, 10) : '',
    active: d.active !== false, notes: clean(d.notes, 300)
  };
}
/** Drones with their running totals from the flight records: acres_logged, flights_logged, minutes_logged,
 *  and acres_total (= acres flown before the app + acres_logged). Voided records don't count. */
async function listDrones(db) {
  const out = [], tot = {};
  (await db.collection(FLIGHTS).get()).forEach((d) => {
    const r = d.data() || {};
    if (r.status === 'void' || !r.drone) return;
    const k = normName(r.drone.name), t = tot[k] = tot[k] || { acres: 0, flights: 0, minutes: 0 };
    t.acres += Number(r.acres) || 0; t.flights += Number(r.flights) || 0; t.minutes += Number(r.minutes) || 0;
  });
  (await db.collection(DRONES).get()).forEach((d) => {
    const o = Object.assign({ id: d.id }, d.data()), t = tot[normName(o.name)] || { acres: 0, flights: 0, minutes: 0 };
    o.acres_logged = round(t.acres, 1); o.flights_logged = t.flights; o.minutes_logged = t.minutes;
    o.acres_total = round((Number(o.acres_before) || 0) + t.acres, 1);
    o.warranty_end = warrantyEnd(o.activated);
    out.push(o);
  });
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

module.exports = {
  COMPANY, FLIGHTS, DRONES,
  LICENSE_TYPES, MAINT_KINDS, GROUND, MAINT, logFlight, editFlight, voidFlight, cleanDrone, listDrones, listFlights, cleanPilotPapers,
  renewals, calMonthsEnd, useApiKey, logGround, saveAgworldGround, keepUnlogged, NOLOG, voidGround, listGround, addMaint, voidMaint, listMaint, licenseWarnings, warrantyEnd, warrantyWarnings,
  _internal: { parseRate, productLines, cleanFlightInput, buildRecord, stampWeather, compass16, minutesBetween, pilotSnap, pilotGaps, meanDir, weatherUrl, groundRecord, minusHour }
};
