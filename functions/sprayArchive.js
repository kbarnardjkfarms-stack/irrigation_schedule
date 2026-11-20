// =============================================================================
// Spray schedule — year-end archive of the application records (Spray > Reports > Archive)
// =============================================================================
// A frozen copy of a year's records, kept outside the live data:
//   spray-archive/<year>/<stamp>-records.html  a readable report that opens in any browser
//                                               (prints to PDF) without AIO: Idaho application
//                                               records (drone + Ag Rows), FAA Part 137 records,
//                                               pilot and drone logbooks, drone maintenance
//   spray-archive/<year>/<stamp>-data.json      every record, as data
// Each file's SHA-256 fingerprint is saved with it (sprayArchives/{id}), so a copy can be shown
// unchanged. Copies are never overwritten or deleted by the app; "Archive now" adds a new one.
//
// When: automatically once a year, early January (from Jan 2), for the year before (the daily
// check in sprayAlerts.js calls autoArchive). And any time from the Archive tab ("Archive now").
//
// Storage: the project's default bucket, under spray-archive/ (no storage rule covers it, so
// browsers can't read or change it; downloads go through sprayAct for Spray admins).

const admin = require('firebase-admin');
const crypto = require('crypto');
const records = require('./sprayRecords');

const ARCHIVES = 'sprayArchives';
const TZ = 'America/Denver';
const nowIso = () => new Date().toISOString();
const denverDay = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms || Date.now()));
const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const esc = (v) => String(v == null ? '' : v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- gather a year --------------------------------------------------------------------------
async function collectYear(db, year) {
  const from = year + '-01-01', to = year + '-12-31';
  const fl = await records.listFlights(db, { from, to });
  const gr = await records.listGround(db, { from, to });
  const ops = [], drones = [];
  (await db.collection('sprayOperators').get()).forEach((d) => { const o = d.data() || {}; ops.push(Object.assign({ id: d.id }, o)); });
  (await db.collection('sprayDrones').get()).forEach((d) => drones.push(Object.assign({ id: d.id }, d.data())));
  const maint = await records.listMaint(db, { from, to });
  return {
    year: String(year), from, to, generated_at: nowIso(), company: records.COMPANY, faa_operator: records.FAA_OPERATOR,
    flights: fl.flights, ground: gr.records, maintenance: maint,
    chief_supervisors: ops.filter((o) => o.crew === 'drone' && o.chief).map((o) => ({ name: o.name, faa_cert: o.faa_cert || '', part137_date: o.part137_date || '', license_no: o.license_no || '' })),
    drones: drones.map((d) => ({ name: d.name, make: d.make || '', model: d.model || '', faa_reg: d.faa_reg || '', serial: d.serial || '', activated: d.activated || '' })),
    unlogged_drone_jobs: fl.unlogged
  };
}

// ---- the readable report --------------------------------------------------------------------
const day = (ymd) => (ymd ? new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const t12 = (hm) => { if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' am' : ' pm'); };
const ac = (n) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('en-US');
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const hrs = (min) => (Math.round((Number(min) || 0) / 6) / 10).toFixed(1);
const wind = (w) => (!w || !w.ok ? 'not recorded' : (w.wind_low_mph != null && w.wind_low_mph !== w.wind_mph ? w.wind_low_mph + '–' : '') + w.wind_mph + ' mph from ' + w.dir + (w.gust_mph != null ? ' (gusts ' + w.gust_mph + ')' : '') + (w.window ? ', ' + w.window : ''));
const temp = (w) => (!w || !w.ok ? '' : (w.temp_low_f != null && w.temp_low_f !== w.temp_f ? w.temp_low_f + '–' : '') + w.temp_f + '°F, ' + w.humidity_pct + '% RH');

function productTable(list) {
  const rows = (list || []).map((p) => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.epa_reg_no || '—') + '</td><td>' + esc(p.rate || '—') + '</td><td>' + esc(p.total_applied || '—') + '</td></tr>').join('');
  return '<table><tr><th>Brand name</th><th>EPA reg. no.</th><th>Rate</th><th>Total applied</th></tr>' + (rows || '<tr><td colspan="4">No products on the AgWorld job</td></tr>') + '</table>';
}
function recBlock(r, ground) {
  const p = ground ? r.operator || {} : r.pilot || {};
  const voided = r.status === 'void';
  const g = (label, val) => '<div><i>' + label + '</i>' + val + '</div>';
  const actual = ground && r.agworld ? r.agworld : null;
  return '<div class="rec' + (voided ? ' void' : '') + '">' +
    '<div class="rh"><b>' + esc(day(r.date)) + ' · ' + esc(r.site && r.site.field) + '</b><span>' + esc([ground ? (r.job_type === 'Spread' || r.job_type === 'Fumigation' ? r.job_type : 'Spray') + ' (ground)' : 'Drone', r.site && r.site.farm, voided ? 'VOID: ' + ((r.void && r.void.reason) || '') : ''].filter(Boolean).join(' · ')) + '</span></div>' +
    '<div class="g">' +
    g('Applied for', esc(r.applied_for.name + ', ' + r.applied_for.address + (r.applied_for.farm ? ' (' + r.applied_for.farm + ')' : ''))) +
    g('Crop / site', esc((r.site && r.site.crop) || '—')) +
    g('Location', esc((r.site && r.site.field) + (r.site && r.site.lat != null ? ' · ' + Number(r.site.lat).toFixed(5) + ', ' + Number(r.site.lng).toFixed(5) : ''))) +
    g('Size treated', esc(ac(actual && actual.acres != null ? actual.acres : r.acres) + ' ac' + (actual && actual.acres != null ? ' (AgWorld actual)' : ''))) +
    g('Date & time', esc(day(r.date) + (ground ? (r.done_time ? ', done ' + t12(r.done_time) : ', time not recorded') : ', ' + t12(r.start) + '–' + t12(r.end)))) +
    g('Wind', esc(wind(r.weather))) + g('Temp / humidity', esc(temp(r.weather) || '—')) +
    (actual && actual.conditions ? g('Conditions in AgWorld', esc(actual.conditions)) : '') +
    (actual && actual.gallons != null ? g('Spray volume (AgWorld)', esc(Math.round(actual.gallons) + ' gal' + (actual.gpa ? ', ' + actual.gpa + ' gal/ac' : ''))) : '') +
    g('Applicator', esc((p.name || '—') + ' · ' + (p.license_type || 'Idaho license') + ' #' + (p.license_no || '—') + (p.license_cats ? ' (' + p.license_cats + ')' : ''))) +
    (p.supervisor ? g('Supervisor', esc(p.supervisor)) : '') +
    (ground ? g('Method', 'Ground application (Ag Rows)') : g('Equipment', esc(r.drone.name + ' · ' + [r.drone.make, r.drone.model].filter(Boolean).join(' ') + (r.drone.faa_reg ? ' · FAA ' + r.drone.faa_reg : '')))) +
    '</div>' + productTable(r.products) +
    (r.notes ? '<div class="n">Notes: ' + esc(r.notes) + '</div>' : '') +
    (r.problems ? '<div class="m">Problem: ' + esc(require('./sprayFaa').problemText(r.problems)) + '</div>' : '') +
    (r.missing && r.missing.length ? '<div class="m">Missing: ' + esc(r.missing.join(', ')) + '</div>' : '') +
    '<div class="n">Record ' + esc(r.id) + ' · entered by ' + esc(r.entered_by) + (r.entered_via ? ' (' + esc(r.entered_via) + ')' : '') + ' ' + esc(r.entered_at || '') +
    ((r.history || []).length > 1 ? ' · history: ' + esc(r.history.map((h) => h.at + ' ' + h.by + ' ' + h.what + (h.reason ? ' (' + h.reason + ')' : '')).join('; ')) : '') + '</div></div>';
}
function logbook(title, sub, rows, kind, extra) {
  const ok = rows.filter((r) => r.status !== 'void');
  const sum = (k) => ok.reduce((t, r) => t + (Number(r[k]) || 0), 0);
  return '<section class="book"><h2>' + esc(title) + '</h2><div class="sub">' + esc(sub) + '</div>' +
    '<div class="tot">' + plural(new Set(ok.map((r) => r.date)).size, 'day') + ' · ' + plural(ok.length, 'job') + ' · ' + sum('flights') + ' flights · ' + hrs(sum('minutes')) + ' hours · ' + ac(sum('acres')) + ' acres</div>' +
    '<table><tr><th>Date</th><th>Field</th><th>' + (kind === 'pilot' ? 'Aircraft' : 'Pilot') + '</th><th>Time</th><th>Hrs</th><th>Flights</th><th>Acres</th><th>Notes</th></tr>' +
    rows.map((r) => '<tr class="' + (r.status === 'void' ? 'void' : '') + '"><td>' + esc(day(r.date)) + '</td><td>' + esc(r.site.field + ', ' + r.site.farm) + '</td><td>' +
      esc(kind === 'pilot' ? r.drone.name + (r.drone.faa_reg ? ' · ' + r.drone.faa_reg : '') : r.pilot.name) + '</td><td>' + esc(t12(r.start) + '–' + t12(r.end)) + '</td><td>' + hrs(r.minutes) +
      '</td><td>' + esc(r.flights) + '</td><td>' + ac(r.acres) + '</td><td>' + esc(r.status === 'void' ? 'VOID' : [r.notes, require('./sprayFaa').problemText(r.problems)].filter(Boolean).join(' · ')) + '</td></tr>').join('') +
    '<tr class="t"><td colspan="4">Totals</td><td>' + hrs(sum('minutes')) + '</td><td>' + sum('flights') + '</td><td>' + ac(sum('acres')) + '</td><td></td></tr></table>' + (extra || '') +
    '<div class="sign">Reviewed by ______________________ &nbsp; Date __________</div></section>';
}
function buildHtml(s) {
  const co = s.company;
  const faa = s.faa_operator || co;
  const head = (t, sub, who) => '<header><div><b class="co">' + esc((who || co).name) + '</b><div>' + esc((who || co).address) + '</div></div><div class="r"><b>' + esc(t) + '</b><div>' + esc(sub) + '</div><div>' + esc(day(s.from) + ' – ' + day(s.to)) + '</div></div></header>';
  const liveF = s.flights.filter((r) => r.status !== 'void'), liveG = s.ground.filter((r) => r.status !== 'void');
  const pilots = [...new Set(s.flights.map((r) => r.pilot.name))].sort();
  const drones = [...new Set(s.flights.map((r) => r.drone.name))].sort();
  const roster = [...new Map(liveF.map((r) => [r.pilot.name, r.pilot])).values()];
  const css = 'body{font:13px/1.4 -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#1c1d1f;max-width:960px;margin:24px auto;padding:0 16px}header{display:flex;justify-content:space-between;gap:12px;border-bottom:2px solid #1c1d1f;padding-bottom:8px;margin:28px 0 10px}header .r{text-align:right}.co{font-size:18px}h1{font-size:22px;margin:0}h2{font-size:16px;margin:24px 0 2px}.sub,header div div{color:#55585c;font-size:12px}' +
    '.rec{border:1px solid #d8d6cf;border-radius:6px;padding:8px 10px;margin:10px 0;break-inside:avoid}.rh{display:flex;justify-content:space-between;border-bottom:1px solid #e4e2db;padding-bottom:4px;margin-bottom:6px}.rh span{color:#55585c}.g{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:3px 14px}.g i{display:block;font-style:normal;font-size:10px;text-transform:uppercase;letter-spacing:.05em;color:#7a7d81}' +
    'table{width:100%;border-collapse:collapse;margin-top:6px;font-size:12px}th{text-align:left;font-size:10px;text-transform:uppercase;color:#7a7d81;border-bottom:1px solid #bdbab2;padding:3px 5px}td{border-bottom:1px solid #e4e2db;padding:4px 5px;vertical-align:top}tr.t td{font-weight:700;border-top:2px solid #1c1d1f}' +
    '.void{opacity:.55;text-decoration:line-through}.m{color:#a3261e;font-weight:600;font-size:12px;margin-top:4px}.n{color:#7a7d81;font-size:11px;margin-top:4px}.tot{margin:6px 0;color:#55585c}.sign{margin-top:12px;color:#55585c}.book,.part{break-before:page}.cover{border:1px solid #d8d6cf;border-radius:8px;padding:14px}@media print{body{margin:0}}';
  const pilotBooks = pilots.map((n) => { const rows = s.flights.filter((r) => r.pilot.name === n); const p = rows[rows.length - 1].pilot;
    return logbook('Pilot Logbook · ' + n, faa.name + ' · FAA ' + (p.faa_cert || '—') + ' · Part 137 ' + (p.part137_date ? day(p.part137_date) : '—') + ' · Idaho ' + (p.license_no || '—'), rows, 'pilot'); }).join('');
  const droneBooks = drones.map((n) => { const rows = s.flights.filter((r) => r.drone.name === n); const d = rows[rows.length - 1].drone;
    const ml = s.maintenance.filter((m) => m.drone === n);
    const mt = '<h3>Maintenance (' + ml.filter((m) => m.status !== 'void').length + ')</h3>' + (ml.length ? '<table><tr><th>Date</th><th>Type</th><th>What was done</th><th>By</th><th>Cost</th></tr>' + ml.slice().reverse().map((m) => '<tr class="' + (m.status === 'void' ? 'void' : '') + '"><td>' + esc(day(m.date)) + '</td><td>' + esc(m.kind) + '</td><td>' + esc(m.what) + '</td><td>' + esc(m.by) + '</td><td>' + (m.cost != null ? '$' + esc(m.cost) : '') + '</td></tr>').join('') + '</table>' : '<div class="n">None logged.</div>');
    return logbook('Aircraft Logbook · ' + n, faa.name + ' · ' + [d.make, d.model].filter(Boolean).join(' ') + ' · FAA ' + (d.faa_reg || '—') + (d.serial ? ' · S/N ' + d.serial : ''), rows, 'drone', mt); }).join('');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(co.name + ' spray records ' + s.year) + '</title><style>' + css + '</style></head><body>' +
    '<div class="cover"><h1>' + esc(co.name) + ' · Spray application records ' + esc(s.year) + '</h1><div class="sub">' + esc(co.address) + '</div>' +
    '<p>Archived ' + esc(new Date(s.generated_at).toLocaleString('en-US', { timeZone: TZ })) + ' (Mountain). Drone: ' + liveF.length + ' applications, ' + ac(liveF.reduce((t, r) => t + (r.acres || 0), 0)) + ' acres. Ag Rows: ' + liveG.length + ' applications.' +
    (s.unlogged_drone_jobs.length ? ' <b>' + s.unlogged_drone_jobs.length + ' drone job(s) done with no flight log</b> (listed at the end).' : '') + ' Voided records are included, struck through, with their reasons.</p>' +
    '<p class="n">Idaho IDAPA 02.03.03 records are kept 2 years; FAA 14 CFR 137.71 records 12 months or more. This file is a frozen copy; its SHA-256 fingerprint is stored in AIO (Spray › Reports › Archive).</p></div>' +
    '<section class="part">' + head('Pesticide Application Records', 'Idaho · IDAPA 02.03.03 · Drone (aerial, unmanned aircraft)') + (s.flights.map((r) => recBlock(r, false)).join('') || '<p>None.</p>') + '</section>' +
    '<section class="part">' + head('Pesticide Application Records', 'Idaho · IDAPA 02.03.03 · Ag Rows (ground)') + (s.ground.map((r) => recBlock(r, true)).join('') || '<p>None.</p>') + '</section>' +
    '<section class="part">' + head('Agricultural Aircraft Operator Records', '14 CFR 137.71' + (faa.exemption ? ' · Exemption No. ' + faa.exemption : ''), faa) +
    '<p>Chief supervisor: ' + esc(s.chief_supervisors.map((c) => c.name + (c.faa_cert ? ' (FAA ' + c.faa_cert + (c.part137_date ? ', 137.19(e) ' + day(c.part137_date) : '') + ')' : '')).join('; ') || 'not set') + '</p>' +
    '<h3>Pilots</h3><table><tr><th>Name</th><th>Address</th><th>FAA certificate #</th><th>137.19(e) date</th></tr>' + roster.map((p) => '<tr><td>' + esc(p.name) + '</td><td>' + esc(p.address) + '</td><td>' + esc(p.faa_cert || '—') + '</td><td>' + esc(p.part137_date ? day(p.part137_date) : '—') + '</td></tr>').join('') + '</table>' +
    '<h3>Operations</h3><table><tr><th>Date</th><th>Customer</th><th>Field</th><th>Material &amp; quantity</th><th>Pilot</th><th>Aircraft</th></tr>' + s.flights.map((r) => '<tr class="' + (r.status === 'void' ? 'void' : '') + '"><td>' + esc(day(r.date)) + '</td><td>' + esc(r.applied_for.name + ', ' + r.applied_for.address) + '</td><td>' + esc(r.site.field + ', ' + r.site.farm + ' · ' + ac(r.acres) + ' ac') + '</td><td>' + (r.products || []).map((p) => esc(p.name + ': ' + (p.total_applied || '—'))).join('<br>') + '</td><td>' + esc(r.pilot.name) + '</td><td>' + esc(r.drone.name + (r.drone.faa_reg ? ' · ' + r.drone.faa_reg : '')) + '</td></tr>').join('') + '</table></section>' +
    pilotBooks + droneBooks +
    (s.unlogged_drone_jobs.length ? '<section class="part"><h2>Drone jobs done with no flight log</h2><table><tr><th>Done</th><th>Field</th><th>Farm</th><th>Acres</th><th>How</th></tr>' + s.unlogged_drone_jobs.map((u) => '<tr><td>' + esc(day(u.completed_date)) + '</td><td>' + esc(u.field) + '</td><td>' + esc(u.farm) + '</td><td>' + esc(u.acres) + '</td><td>' + esc(u.entered_by) + '</td></tr>').join('') + '</table></section>' : '') +
    '</body></html>';
}

// ---- save / list / read ---------------------------------------------------------------------
/** Archive a year now. kind 'auto' | 'manual'. deps: { bucket } for tests. Returns the archive row. */
async function archiveYear(db, year, by, kind, deps) {
  const y = String(year);
  if (!/^\d{4}$/.test(y)) throw new Error('Which year?');
  const snap = await collectYear(db, y);
  const html = buildHtml(snap), json = JSON.stringify(snap, null, 1);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z') + '-' + crypto.randomBytes(3).toString('hex');   // never reuses a name
  const bucket = (deps && deps.bucket) || admin.storage().bucket();
  const files = [
    { which: 'html', name: 'JK-Farms-spray-records-' + y + '-' + stamp + '.html', path: 'spray-archive/' + y + '/' + stamp + '-records.html', type: 'text/html; charset=utf-8', text: html },
    { which: 'json', name: 'JK-Farms-spray-records-' + y + '-' + stamp + '.json', path: 'spray-archive/' + y + '/' + stamp + '-data.json', type: 'application/json', text: json }
  ];
  for (const f of files) await bucket.file(f.path).save(f.text, { contentType: f.type, resumable: false, metadata: { metadata: { sha256: sha256(f.text) } } });
  const row = {
    year: y, kind: kind || 'manual', at: nowIso(), by: by || '',
    counts: { drone: snap.flights.filter((r) => r.status !== 'void').length, ground: snap.ground.filter((r) => r.status !== 'void').length, voided: snap.flights.concat(snap.ground).filter((r) => r.status === 'void').length, unlogged: snap.unlogged_drone_jobs.length },
    files: files.map((f) => ({ which: f.which, name: f.name, path: f.path, type: f.type, bytes: Buffer.byteLength(f.text, 'utf8'), sha256: sha256(f.text) }))
  };
  const ref = db.collection(ARCHIVES).doc(y + '-' + stamp);
  await ref.set(row);
  return Object.assign({ id: ref.id }, row);
}

async function listArchives(db) {
  const out = [];
  (await db.collection(ARCHIVES).get()).forEach((d) => out.push(Object.assign({ id: d.id }, d.data())));
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

/** One archive file's text, checked against its saved fingerprint. */
async function getArchiveFile(db, id, which, deps) {
  const a = (await db.collection(ARCHIVES).doc(String(id || '')).get()).data();
  if (!a) throw new Error('That archive isn\'t there.');
  const f = (a.files || []).find((x) => x.which === which);
  if (!f) throw new Error('That file isn\'t in the archive.');
  const bucket = (deps && deps.bucket) || admin.storage().bucket();
  const [buf] = await bucket.file(f.path).download();
  const text = buf.toString('utf8');
  return { name: f.name, type: f.type, text, sha256: sha256(text), unchanged: sha256(text) === f.sha256 };
}

/** Called once a day: early January (from Jan 2), archive last year if it hasn't been yet. Never throws. */
async function autoArchive(db, nowMs, deps) {
  try {
    const d = denverDay(nowMs);
    if (d.slice(5, 7) !== '01' || d.slice(8) < '02') return null;
    const last = String(Number(d.slice(0, 4)) - 1);
    const meta = db.collection('sprayMeta').doc('archive');
    if (((await meta.get()).data() || {}).autoYear === last) return null;
    await meta.set({ autoYear: last, at: nowIso() }, { merge: true });   // claim it first so two runs don't both archive
    try {
      return await archiveYear(db, last, 'AIO (automatic, every January)', 'auto', deps);
    } catch (e) {
      await meta.set({ autoYear: '', error: String(e && e.message || e).slice(0, 300) }, { merge: true });   // try again tomorrow
      throw e;
    }
  } catch (e) {
    console.error('autoArchive', e);
    return null;
  }
}

module.exports = { archiveYear, listArchives, getArchiveFile, autoArchive, _internal: { collectYear, buildHtml, sha256, denverDay } };
