// Open-Meteo forecast archive for the ET model (Nov 2026)
//
// Open-Meteo (paid Standard plan, commercial use) gives a day-by-day weather
// forecast for any latitude/longitude, including a daily "reference
// evapotranspiration" (ET0). That ET0 is for a GRASS reference crop; AgriMet
// and our crop curves use an ALFALFA reference (ETr), which runs higher. This
// file does not change the ET column. It only collects data every morning so
// we can compare Open-Meteo with AgriMet's measured ETr and work out the
// grass-to-alfalfa conversion and how accurate the forecast is.
//
// One call per AgriMet station each morning. Each call asks for the last 7
// days (what the model thinks happened) and the next 16 days (the forecast).
//
// What it writes (server-side; the app can only read openMeteoDaily):
//   openMeteoRaw/{STATION}_{YYYY-MM-DD}  the answer exactly as Open-Meteo sent
//                                        it (one per station per run day, so
//                                        every forecast is kept and can be
//                                        compared by how far ahead it was)
//   openMeteoDaily/{STATION}             { days: {YYYY-MM-DD: {etMm, etIn,
//                                        tMaxC, tMinC, precipMm, windMaxKmh,
//                                        radMj}}, runDate, updatedAt }. Newer
//                                        runs overwrite the same dates, so
//                                        past dates settle on the model's
//                                        latest look at that day.
//
// The API key lives in Secret Manager (OPEN_METEO_API_KEY) and is never
// written to the logs or to Firestore. Nothing here ever prints the request
// address, because the key is part of it.
//
// Own file (like agrimet.js) so uploading a new index.js can't wipe it out.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

// Set once (already done, Nov 19 2026):
//   read -s -p "key: " K; printf %s "$K" | gcloud secrets create OPEN_METEO_API_KEY --data-file=- ; unset K
const OPEN_METEO_API_KEY = defineSecret('OPEN_METEO_API_KEY');

const TIME_ZONE = 'America/Denver';
const PAST_DAYS = 7;
const FORECAST_DAYS = 16;
const MM_PER_INCH = 25.4;

// AgriMet stations our farms use. Coordinates are from AgriMet's station
// pages. TFGI (Twin Falls Fairgrounds, near Filer) is the town center of
// Filer, not the exact site: Open-Meteo's grid is several miles wide, so the
// difference is small, but it is marked approx.
const STATIONS = {
  RPTI: { name: 'Rupert', lat: 42.59555, lon: -113.87388 },
  GFRI: { name: 'Glenns Ferry', lat: 42.86666, lon: -115.35694 },
  GDVI: { name: 'Grand View', lat: 42.90912, lon: -116.05203 },
  TWFI: { name: 'Twin Falls (Kimberly)', lat: 42.54611, lon: -114.34527 },
  TFGI: { name: 'Twin Falls (Filer)', lat: 42.5702, lon: -114.6081, approx: true }
};

// Metric units on purpose (mm, C, km/h, MJ/m2): the raw copy stays exactly
// what Open-Meteo documents, and inches are worked out here.
const DAILY_VARS = [
  'et0_fao_evapotranspiration',
  'temperature_2m_max',
  'temperature_2m_min',
  'precipitation_sum',
  'wind_speed_10m_max',
  'shortwave_radiation_sum'
];

function todayInDenver(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Built here and never logged: the key is part of the address.
function requestUrl(station, apiKey) {
  const s = STATIONS[station];
  const q = new URLSearchParams({
    latitude: String(s.lat),
    longitude: String(s.lon),
    daily: DAILY_VARS.join(','),
    past_days: String(PAST_DAYS),
    forecast_days: String(FORECAST_DAYS),
    timezone: TIME_ZONE,
    apikey: apiKey
  });
  return `https://customer-api.open-meteo.com/v1/forecast?${q.toString()}`;
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// Turns Open-Meteo's parallel arrays into one record per date. Returns null
// when the answer isn't the expected shape or has no usable ET at all, so the
// caller keeps only the raw copy. Individual missing values stay null.
function parseDaily(json) {
  const d = json && json.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) return null;
  const et = d.et0_fao_evapotranspiration;
  if (!Array.isArray(et) || et.length !== d.time.length) return null;
  const col = (name) => (Array.isArray(d[name]) && d[name].length === d.time.length ? d[name] : d.time.map(() => null));
  const tMax = col('temperature_2m_max');
  const tMin = col('temperature_2m_min');
  const pr = col('precipitation_sum');
  const wind = col('wind_speed_10m_max');
  const rad = col('shortwave_radiation_sum');
  const days = {};
  let usable = 0;
  d.time.forEach((date, i) => {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    const etMm = num(et[i]);
    // 0 to 25 mm a day covers anything real (a very hot, windy day is ~12 mm).
    const etOk = etMm !== null && etMm >= 0 && etMm <= 25;
    if (etOk) usable += 1;
    days[date] = {
      etMm: etOk ? etMm : null,
      etIn: etOk ? Math.round((etMm / MM_PER_INCH) * 10000) / 10000 : null,
      tMaxC: num(tMax[i]),
      tMinC: num(tMin[i]),
      precipMm: num(pr[i]),
      windMaxKmh: num(wind[i]),
      radMj: num(rad[i])
    };
  });
  if (usable === 0) return null;
  return { days };
}

// Safety net: if anything ever echoes the key back (an error text, a proxy),
// it is blanked before it can reach a log or a saved record.
function scrub(text, apiKey) {
  const t = String(text);
  return apiKey ? t.split(apiKey).join('***') : t;
}

async function fetchStation(code, apiKey) {
  const res = await fetch(requestUrl(code, apiKey));
  const text = await res.text();
  if (!res.ok) {
    // Open-Meteo explains errors as {"error":true,"reason":"..."}. Log only
    // that reason, never the address.
    let reason = '';
    try { reason = JSON.parse(text).reason || ''; } catch (e) { /* not JSON */ }
    throw new Error(scrub(`${code}: Open-Meteo returned HTTP ${res.status}${reason ? ' (' + String(reason).slice(0, 200) + ')' : ''}`, apiKey));
  }
  return text;
}

async function archiveStation(db, code, runDate, apiKey) {
  const text = await fetchStation(code, apiKey);
  const s = STATIONS[code];

  // Raw copy first, before any interpretation.
  await db.doc(`openMeteoRaw/${code}_${runDate}`).set({
    station: code,
    runDate,
    lat: s.lat,
    lon: s.lon,
    latLonApprox: !!s.approx,
    pastDays: PAST_DAYS,
    forecastDays: FORECAST_DAYS,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    text
  });

  let json = null;
  try { json = JSON.parse(text); } catch (e) { /* handled below */ }
  const parsed = parseDaily(json);
  if (!parsed) {
    console.error(`${code}: saved the raw answer but could not read the daily ET; Open-Meteo's layout may have changed.`);
    return { code, parsed: false };
  }
  await db.doc(`openMeteoDaily/${code}`).set(
    {
      station: code,
      name: s.name,
      runDate,
      days: parsed.days,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  return { code, parsed: true, dates: Object.keys(parsed.days).length };
}

// One station failing (Open-Meteo down, plan problem) must not stop the others.
async function archiveAll(apiKey, now = new Date()) {
  const db = admin.firestore();
  const runDate = todayInDenver(now);
  const results = [];
  for (const code of Object.keys(STATIONS)) {
    try {
      results.push(await archiveStation(db, code, runDate, apiKey));
    } catch (err) {
      const msg = scrub(err.message, apiKey);
      console.error(`Open-Meteo archive failed for ${code}: ${msg}`);
      results.push({ code, parsed: false, error: msg });
    }
  }
  return { runDate, results };
}

// Daily at 6:15 am Mountain (the same time every day so forecasts from
// different days can be compared fairly).
exports.archiveOpenMeteoNightly = onSchedule(
  { schedule: '15 6 * * *', timeZone: TIME_ZONE, secrets: [OPEN_METEO_API_KEY], retryCount: 1, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const r = await archiveAll(OPEN_METEO_API_KEY.value());
    const ok = r.results.filter((x) => x.parsed).length;
    console.log(`Open-Meteo archive ${r.runDate}: ${ok} of ${r.results.length} stations saved.`);
  }
);

// Manual trigger for testing right after deploy. PRIVATE on purpose: every
// run spends calls from the paid plan, so only someone signed in to Google
// Cloud (you, in Cloud Shell) can run it. See the README note in the commit
// message for the one-line command.
exports.archiveOpenMeteoNow = onRequest(
  { invoker: 'private', secrets: [OPEN_METEO_API_KEY], timeoutSeconds: 120, memory: '256MiB' },
  async (req, res) => {
    try {
      const r = await archiveAll(OPEN_METEO_API_KEY.value());
      res.status(200).send(JSON.stringify(r, null, 2));
    } catch (err) {
      const msg = scrub(err.message, OPEN_METEO_API_KEY.value());
      console.error(msg);
      res.status(500).send(msg);
    }
  }
);

exports._test = { parseDaily, requestUrl, archiveAll, todayInDenver, STATIONS };
// Shared with etRatio.js (the one-time history fill needs the same secret).
exports._secret = OPEN_METEO_API_KEY;
