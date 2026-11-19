// Grass-to-alfalfa "bump-up" ratio per weather station (Nov 2026)
//
// Open-Meteo's ET0 is for a GRASS reference crop. AgriMet, Kent and our crop
// curves use an ALFALFA reference (ETr), which runs higher, and by a different
// amount at each station (about 1.05 to 1.35). Multiply Open-Meteo's number by
// the station's ratio and you get the alfalfa-reference ET.
//
// This file works out that ratio every morning and saves it. It changes
// nothing on the schedule screen; the screen will read etRatio/{STATION} in a
// later step.
//
// How the ratio is chosen (tested on 2025 and 2026, see the project notes
// "Open-Meteo ratio year-to-year check"):
//   1. ROLLING (preferred): AgriMet's measured ETr added up over the last 30
//      days, divided by Open-Meteo's ET0 added up over the same days. It
//      corrects itself as the season changes and does not drift from year to
//      year. Needs at least 20 days with both numbers, and enough water use
//      in the window (at least 1.5 in) to be meaningful, so it is not used in
//      deep winter, and it must land between 0.90 and 1.70.
//   2. TABLE (backup): the station's season ratio times the month's shape,
//      from the 2025 + 2026 comparison. Approximate: it is the station season
//      ratio scaled by the pooled monthly ratio, not a fitted station-by-month
//      table. Used at the start of a season, if AgriMet or Open-Meteo data is
//      missing, or if the rolling number looks wrong.
//
// What it writes (the app can read etRatio; only this file writes it):
//   etRatio/{STATION}  { station, asOf, ratio, source: 'rolling' | 'table',
//                        rolling, rollingDays, rollingAgrimetIn,
//                        rollingOpenMeteoIn, tableRatio, tableByMonth, computedAt }
//
// It reads agrimetDaily/{STATION}.days (inches, ETr) and
// openMeteoDaily/{STATION}.days[date].etIn (inches, ET0), which the two
// archive jobs fill every morning.
//
// Also here: backfillEtHistoryNow, a one-time PRIVATE trigger that fills the
// last ~3 months into those two collections so the rolling ratio works on day
// one instead of after a month. It uses Open-Meteo's Historical Forecast API,
// which is only on the Professional plan, so run it before that plan is
// switched down. It is safe to run again (same values are merged in).
//
// The API key (Secret Manager OPEN_METEO_API_KEY) is never written to logs or
// Firestore.
//
// Own file (like agrimet.js and openMeteo.js) so uploading a new index.js can't
// wipe it out.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const om = require('./openMeteo');

const TIME_ZONE = 'America/Denver';
const STATIONS = ['RPTI', 'GFRI', 'GDVI', 'TWFI', 'TFGI'];

// Backup table (see header). Season ratio per station is the average of 2025
// and 2026 (April to October, AgriMet / Open-Meteo best_match). Month shape is
// the pooled monthly ratio of the two years, over the pooled season ratio.
const STATION_SEASON_RATIO = { RPTI: 1.22, GFRI: 1.34, GDVI: 1.07, TWFI: 1.12, TFGI: 1.08 };
const MONTH_RATIO = { 1: 1.105, 2: 1.21, 3: 1.275, 4: 1.22, 5: 1.215, 6: 1.15, 7: 1.12, 8: 1.12, 9: 1.17, 10: 1.24, 11: 1.285, 12: 1.37 };
const SEASON_POOLED_RATIO = 1.166;

const WINDOW_DAYS = 30;
const MIN_DAYS = 20;
const MIN_AGRIMET_TOTAL_IN = 1.5;
const RATIO_MIN = 0.9;
const RATIO_MAX = 1.7;

const addDays = (iso, n) => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
};
const todayInDenver = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;

function tableRatio(code, month) {
  const s = STATION_SEASON_RATIO[code];
  const m = MONTH_RATIO[month];
  if (!s || !m) return null;
  return round(Math.min(RATIO_MAX, Math.max(RATIO_MIN, (s * m) / SEASON_POOLED_RATIO)), 3);
}

function tableByMonth(code) {
  const out = {};
  for (let m = 1; m <= 12; m++) out[m] = tableRatio(code, m);
  return out;
}

// Usable AgriMet value: a plausible daily ETr in inches.
const agrimetVal = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1.0 ? v : null);
// Usable Open-Meteo value: inches of ET0, from the saved day record.
const omVal = (rec) => (rec && typeof rec.etIn === 'number' && Number.isFinite(rec.etIn) && rec.etIn >= 0 && rec.etIn <= 1.0 ? rec.etIn : null);

// amDays: {date: inches}; omDays: {date: {etIn,...}}. Returns the decision
// for one station, as plain data.
function decide(code, amDays, omDays, today) {
  const am = amDays && typeof amDays === 'object' ? amDays : {};
  const o = omDays && typeof omDays === 'object' ? omDays : {};
  const month = Number(today.slice(5, 7));
  const table = tableRatio(code, month);
  const base = { station: code, tableRatio: table, tableByMonth: tableByMonth(code) };

  // Newest date that has both an AgriMet and an Open-Meteo number.
  let asOf = null;
  for (const d of Object.keys(am)) {
    if (!isDate(d)) continue;
    if (agrimetVal(am[d]) !== null && omVal(o[d]) !== null && (asOf === null || d > asOf)) asOf = d;
  }
  if (asOf === null) {
    return { ...base, asOf: null, ratio: table, source: 'table', reason: 'no days with both AgriMet and Open-Meteo', rolling: null, rollingDays: 0, rollingAgrimetIn: 0, rollingOpenMeteoIn: 0 };
  }
  let sa = 0, so = 0, n = 0;
  for (let k = 0; k < WINDOW_DAYS; k++) {
    const d = addDays(asOf, -k);
    const a = agrimetVal(am[d]);
    const b = omVal(o[d]);
    if (a !== null && b !== null) { sa += a; so += b; n += 1; }
  }
  const rolling = so > 0 ? sa / so : null;
  const detail = { ...base, asOf, rolling: rolling === null ? null : round(rolling, 3), rollingDays: n, rollingAgrimetIn: round(sa, 3), rollingOpenMeteoIn: round(so, 3) };
  if (n < MIN_DAYS) return { ...detail, ratio: table, source: 'table', reason: `only ${n} days with both numbers` };
  if (sa < MIN_AGRIMET_TOTAL_IN) return { ...detail, ratio: table, source: 'table', reason: 'too little water use in the window (winter)' };
  if (rolling === null || rolling < RATIO_MIN || rolling > RATIO_MAX) return { ...detail, ratio: table, source: 'table', reason: 'rolling ratio outside 0.90-1.70' };
  return { ...detail, ratio: round(rolling, 3), source: 'rolling', reason: null };
}

async function computeAll(now = new Date()) {
  const db = admin.firestore();
  const today = todayInDenver(now);
  const results = [];
  for (const code of STATIONS) {
    try {
      const [amSnap, omSnap] = await Promise.all([db.doc(`agrimetDaily/${code}`).get(), db.doc(`openMeteoDaily/${code}`).get()]);
      const amDays = amSnap.exists ? (amSnap.data() || {}).days : null;
      const omDays = omSnap.exists ? (omSnap.data() || {}).days : null;
      const d = decide(code, amDays, omDays, today);
      await db.doc(`etRatio/${code}`).set({ ...d, computedAt: admin.firestore.FieldValue.serverTimestamp() });
      results.push({ code, ratio: d.ratio, source: d.source, asOf: d.asOf, days: d.rollingDays, reason: d.reason });
    } catch (err) {
      console.error(`etRatio failed for ${code}: ${err.message}`);
      results.push({ code, error: err.message });
    }
  }
  return { today, results };
}

// After both archive jobs (Open-Meteo 6:15, AgriMet 8:30).
exports.computeEtRatiosNightly = onSchedule(
  { schedule: '45 8 * * *', timeZone: TIME_ZONE, retryCount: 1, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const r = await computeAll();
    const rolling = r.results.filter((x) => x.source === 'rolling').length;
    console.log(`etRatio ${r.today}: ${r.results.length} stations, ${rolling} on the rolling ratio.`);
  }
);

// Manual trigger. PRIVATE (needs a Google sign-in): prints what it decided.
exports.computeEtRatiosNow = onRequest({ invoker: 'private', timeoutSeconds: 120, memory: '256MiB' }, async (req, res) => {
  try {
    res.status(200).send(JSON.stringify(await computeAll(), null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

// ---- one-time backfill ------------------------------------------------------

const BACKFILL_FROM = '2026-08-20';
// AgriMet ETRS (ETr, inches) per day from BACKFILL_FROM through 2026-11-18,
// saved from AgriMet's daily data by hand on Nov 19, 2026 (the same numbers
// the crop-water-use file reports).
const AGRIMET_BACKFILL = {
  RPTI: [0.29, 0.24, 0.33, 0.26, 0.24, 0.29, 0.27, 0.3, 0.17, 0.22, 0.32, 0.25, 0.28, 0.28, 0.21, 0.26, 0.24, 0.3, 0.23, 0.19, 0.25, 0.2, 0.28, 0.16, 0.25, 0.25, 0.2, 0.22, 0.28, 0.12, 0.11, 0.16, 0.24, 0.16, 0.18, 0.3, 0.33, 0.22, 0.23, 0.26, 0.24, 0.21, 0.18, 0.2, 0.16, 0.21, 0.16, 0.25, 0.16, 0.18, 0.21, 0.19, 0.06, 0.04, 0.11, 0.12, 0.1, 0.17, 0.21, 0.16, 0.22, 0.15, 0.14, 0.14, 0.04, 0.06, 0.07, 0.15, 0.07, 0.06, 0.07, 0.04, 0.04, 0.01, 0.06, 0.08, 0.08, 0.05, 0.05, 0.1, 0.1, 0.07, 0.12, 0.12, 0.13, 0.12, 0.09, 0.12, 0.09, 0.05, 0.06],
  GFRI: [0.36, 0.33, 0.33, 0.39, 0.29, 0.36, 0.4, 0.33, 0.23, 0.22, 0.42, 0.3, 0.45, 0.3, 0.23, 0.19, 0.23, 0.34, 0.24, 0.26, 0.28, 0.29, 0.33, 0.29, 0.32, 0.26, 0.25, 0.26, 0.42, 0.2, 0.19, 0.2, 0.33, 0.27, 0.3, 0.45, 0.44, 0.22, 0.26, 0.34, 0.31, 0.3, 0.2, 0.3, 0.23, 0.33, 0.27, 0.3, 0.24, 0.22, 0.29, 0.3, 0.11, 0.11, 0.25, 0.23, 0.15, 0.27, 0.3, 0.2, 0.29, 0.24, 0.25, 0.26, 0.07, 0.09, 0.11, 0.13, 0.08, 0.09, 0.13, 0.07, 0.08, 0.06, 0.12, 0.13, 0.14, 0.08, 0.08, 0.16, 0.13, 0.13, 0.09, 0.2, 0.22, 0.23, 0.08, 0.12, 0.07, 0.05, 0.07],
  GDVI: [0.24, 0.28, 0.24, 0.28, 0.21, 0.26, 0.24, 0.24, 0.17, 0.22, 0.25, 0.22, 0.31, 0.21, 0.18, 0.11, 0.17, 0.22, 0.16, 0.16, 0.18, 0.15, 0.21, 0.19, 0.2, 0.17, 0.16, 0.16, 0.27, 0.11, 0.15, 0.15, 0.17, 0.18, 0.19, 0.29, 0.26, 0.16, 0.16, 0.23, 0.19, 0.2, 0.13, 0.15, 0.14, 0.15, 0.14, 0.2, 0.14, 0.14, 0.12, 0.22, 0.15, 0.09, 0.2, 0.19, 0.12, 0.16, 0.24, 0.1, 0.21, 0.16, 0.15, 0.1, 0.13, 0.09, 0.12, 0.12, 0.07, 0.09, 0.1, 0.1, 0.1, 0.09, 0.12, 0.08, 0.09, 0.07, 0.08, 0.12, 0.16, 0.08, 0.09, 0.15, 0.17, 0.22, 0.07, 0.15, 0.05, 0.04, 0.07],
  TWFI: [0.3, 0.33, 0.25, 0.29, 0.23, 0.29, 0.34, 0.29, 0.2, 0.22, 0.28, 0.32, 0.29, 0.28, 0.2, 0.2, 0.23, 0.25, 0.22, 0.21, 0.24, 0.22, 0.26, 0.23, 0.25, 0.22, 0.22, 0.25, 0.29, 0.13, 0.12, 0.17, 0.26, 0.14, 0.2, 0.33, 0.28, 0.14, 0.22, 0.24, 0.24, 0.22, 0.18, 0.2, 0.17, 0.26, 0.19, 0.21, 0.18, 0.19, 0.2, 0.17, 0.08, 0.05, 0.12, 0.14, 0.14, 0.21, 0.17, 0.17, 0.17, 0.17, 0.16, 0.18, 0.05, 0.07, 0.08, 0.11, 0.05, 0.07, 0.09, 0.05, 0.04, 0.02, 0.07, 0.09, 0.07, 0.06, 0.07, 0.12, 0.1, 0.08, 0.09, 0.13, 0.17, 0.16, 0.11, 0.08, 0.07, 0.05, 0.06],
  TFGI: [0.25, 0.27, 0.27, 0.3, 0.23, 0.3, 0.31, 0.25, 0.21, 0.22, 0.28, 0.3, 0.28, 0.25, 0.17, 0.16, 0.17, 0.23, 0.19, 0.18, 0.21, 0.21, 0.25, 0.2, 0.26, 0.22, 0.2, 0.22, 0.26, 0.14, 0.14, 0.17, 0.24, 0.18, 0.21, 0.33, 0.31, 0.14, 0.19, 0.25, 0.25, 0.22, 0.19, 0.18, 0.15, 0.21, 0.16, 0.21, 0.16, 0.16, 0.19, 0.19, 0.08, 0.06, 0.14, 0.16, 0.13, 0.18, 0.18, 0.14, 0.22, 0.16, 0.16, 0.18, 0.07, 0.06, 0.08, 0.13, 0.06, 0.07, 0.08, 0.07, 0.05, 0.03, 0.07, 0.08, 0.07, 0.05, 0.06, 0.1, 0.08, 0.08, 0.09, 0.11, 0.16, 0.16, 0.1, 0.13, 0.09, 0.05, 0.07]
};

const DAILY_VARS = ['et0_fao_evapotranspiration', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'wind_speed_10m_max', 'shortwave_radiation_sum'];

const scrub = (text, key) => (key ? String(text).split(key).join('***') : String(text));

function historyUrl(code, from, to, key) {
  const s = om._test.STATIONS[code];
  const q = new URLSearchParams({ latitude: String(s.lat), longitude: String(s.lon), start_date: from, end_date: to, daily: DAILY_VARS.join(','), timezone: TIME_ZONE, apikey: key });
  return `https://customer-historical-forecast-api.open-meteo.com/v1/forecast?${q.toString()}`;
}

async function backfillAll(key, now = new Date()) {
  const db = admin.firestore();
  const today = todayInDenver(now);
  const to = addDays(today, -2); // the nightly archive already covers the most recent days
  const results = [];
  for (const code of STATIONS) {
    const r = { code };
    // AgriMet part: from the constant above, no network.
    try {
      const a = AGRIMET_BACKFILL[code];
      const days = {};
      a.forEach((v, i) => { const d = addDays(BACKFILL_FROM, i); if (agrimetVal(v) !== null) days[d] = v; });
      await db.doc(`agrimetDaily/${code}`).set({ station: code, days, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      r.agrimetDays = Object.keys(days).length;
    } catch (err) {
      r.agrimetError = scrub(err.message, key);
      console.error(`backfill AgriMet ${code}: ${r.agrimetError}`);
    }
    // Open-Meteo part: Historical Forecast API (Professional plan).
    try {
      const res = await fetch(historyUrl(code, BACKFILL_FROM, to, key));
      const text = await res.text();
      if (!res.ok) {
        let reason = '';
        try { reason = JSON.parse(text).reason || ''; } catch (e) { /* not JSON */ }
        throw new Error(`Open-Meteo returned HTTP ${res.status}${reason ? ' (' + String(reason).slice(0, 200) + ')' : ''}`);
      }
      let json = null;
      try { json = JSON.parse(text); } catch (e) { /* handled below */ }
      const parsed = om._test.parseDaily(json);
      if (!parsed) throw new Error('could not read the daily ET from the answer');
      await db.doc(`openMeteoDaily/${code}`).set({ station: code, name: om._test.STATIONS[code].name, days: parsed.days, backfilledAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      r.openMeteoDays = Object.keys(parsed.days).length;
    } catch (err) {
      r.openMeteoError = scrub(err.message, key);
      console.error(`backfill Open-Meteo ${code}: ${r.openMeteoError}`);
    }
    results.push(r);
  }
  return { from: BACKFILL_FROM, to, results };
}

exports.backfillEtHistoryNow = onRequest(
  { invoker: 'private', secrets: [om._secret], timeoutSeconds: 300, memory: '256MiB' },
  async (req, res) => {
    const key = om._secret.value();
    try {
      res.status(200).send(JSON.stringify(await backfillAll(key), null, 2));
    } catch (err) {
      const msg = scrub(err.message, key);
      console.error(msg);
      res.status(500).send(msg);
    }
  }
);

exports._test = { decide, computeAll, backfillAll, tableRatio, tableByMonth, historyUrl, AGRIMET_BACKFILL, addDays, MIN_DAYS };
