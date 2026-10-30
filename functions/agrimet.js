// AgriMet weather archive for the ET column (Oct 2026)
//
// AgriMet (US Bureau of Reclamation) publishes a small text file per weather
// station, "crop water use", refreshed every morning around 7:30 am Mountain.
// Its alfalfa-reference row (ETr) has the last four finished days and a
// "Daily ET forecast (4 day average)". Each file only reaches back four days,
// so this saves a copy every morning and builds up the history the ET column
// needs, plus a record of every forecast so we can measure how good the
// forecast is by spring.
//
// What it writes (all server-side; the app only reads agrimetDaily):
//   agrimetRaw/{STATION}_{YYYY-MM-DD}  the file exactly as AgriMet sent it
//   agrimetDaily/{STATION}             { days: {YYYY-MM-DD: ETr inches},
//                                        forecast, forecastAsOf, updatedAt }
//
// The raw copy is the safety net: if AgriMet changes the layout and the
// reader below stops understanding it, nothing is lost, and the days can be
// re-read later.
//
// Lives in its own file (like pivotWatcher.js and storageYields.js) so
// uploading a new index.js can't wipe it out. index.js re-exports the two
// functions.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

// Stations our farms use (see the station mapping in etMath.js).
const STATIONS = ['RPTI', 'GFRI', 'GDVI', 'TWFI', 'TFGI'];

const TIME_ZONE = 'America/Denver';

function cropFileUrl(code) {
  return `https://www.usbr.gov/pn/agrimet/chart/${code.toLowerCase()}ch.txt`;
}

// Today's calendar date in Mountain time, as YYYY-MM-DD.
function todayInDenver(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}

const MONTHS = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 };

// The file's first line looks like "Estimated Crop Water Use - RPTI October 29
// 2026". That date is the newest finished day in the table (checked against
// Rupert's daily record: the "1 day ago" column equals that date's ETr).
function headerDate(text) {
  const m = /Estimated Crop Water Use[^\n]*?\b([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})/i.exec(text);
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return `${m[3]}-${String(MONTHS[m[1].toLowerCase()]).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

// Reads the ETr row of an AgriMet crop water use file. Real layout (checked
// against a copy of Rupert's file from Oct 30, 2026):
//
//   Estimated Crop Water Use - RPTI October 29 2026
//   Crop,Start Date,Full Cover Date,Terminate Date,4,3,2,1,Daily Forecast,Sum ET,7 Day Use,14 Day Use
//   ETr,01/01,01/01,12/31,0.15,0.07,0.06,0.07,0.09,64.4,0.5,1.7
//
// Columns 4 to 7 are ET for 4, 3, 2 and 1 days before the file's newest day,
// column 8 is the daily forecast. If the row isn't found or the numbers
// aren't plausible, this returns null and the caller keeps only the raw text.
//
// `fetchDate` is the day the file was fetched (Mountain time). It is only a
// fallback for when the header's date can't be read: then the newest day is
// taken to be the day before.
function parseCropWaterUse(text, fetchDate) {
  if (typeof text !== 'string') return null;
  const line = text.split(/\r?\n/).find((l) => /^\s*ETr\b/i.test(l));
  if (!line) return null;
  let vals;
  if (line.includes(',')) {
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 9) return null;
    vals = cols.slice(4, 9).map(Number);
  } else {
    // Whitespace-separated fallback: the decimals, in order, skipping dates.
    vals = (line.match(/-?\d+\.\d+/g) || []).slice(0, 5).map(Number);
  }
  if (vals.length < 5) return null;
  const [d4, d3, d2, d1, forecast] = vals;
  const plausible = (v) => Number.isFinite(v) && v >= 0 && v <= 1.0;
  if (![d4, d3, d2, d1, forecast].every(plausible)) return null;
  const newest = headerDate(text) || addDays(fetchDate, -1);
  return {
    days: {
      [addDays(newest, -3)]: d4,
      [addDays(newest, -2)]: d3,
      [addDays(newest, -1)]: d2,
      [newest]: d1
    },
    forecast,
    // The forecast covers the day after the newest finished day and the next 3.
    forecastAsOf: addDays(newest, 1)
  };
}

async function archiveStation(db, code, fileDate) {
  const res = await fetch(cropFileUrl(code), { headers: { 'User-Agent': 'JKF-AIO irrigation schedule (devin@jkfarms.com)' } });
  if (!res.ok) throw new Error(`${code}: AgriMet returned HTTP ${res.status}`);
  const text = await res.text();

  // Raw copy first, before any interpretation.
  await db.doc(`agrimetRaw/${code}_${fileDate}`).set({
    station: code,
    fileDate,
    fetchedAt: admin.firestore.FieldValue.serverTimestamp(),
    text
  });

  const parsed = parseCropWaterUse(text, fileDate);
  if (!parsed) {
    console.error(`${code}: saved the raw file but could not read the ETr row; layout may differ from what the reader expects.`);
    return { code, parsed: false };
  }
  await db.doc(`agrimetDaily/${code}`).set(
    {
      station: code,
      days: parsed.days,
      forecast: parsed.forecast,
      forecastAsOf: parsed.forecastAsOf,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  return { code, parsed: true, forecast: parsed.forecast };
}

// One station failing (AgriMet down, layout change) must not stop the others.
async function archiveAll() {
  const db = admin.firestore();
  const fileDate = todayInDenver();
  const results = [];
  for (const code of STATIONS) {
    try {
      results.push(await archiveStation(db, code, fileDate));
    } catch (err) {
      console.error(`AgriMet archive failed for ${code}:`, err);
      results.push({ code, parsed: false, error: err.message });
    }
  }
  return { fileDate, results };
}

// Daily, after AgriMet's ~7:30 am update.
exports.archiveAgrimetNightly = onSchedule(
  { schedule: '30 8 * * *', timeZone: TIME_ZONE, retryCount: 1, timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const r = await archiveAll();
    const ok = r.results.filter((x) => x.parsed).length;
    console.log(`AgriMet archive ${r.fileDate}: ${ok} of ${r.results.length} stations read.`);
  }
);

// Manual trigger for testing right after deploy. Visiting the URL runs the
// same archive now and prints what happened per station.
exports.archiveAgrimetNow = onRequest({ timeoutSeconds: 120, memory: '256MiB' }, async (req, res) => {
  try {
    const r = await archiveAll();
    res.status(200).send(JSON.stringify(r, null, 2));
  } catch (err) {
    console.error(err);
    res.status(500).send(err.message);
  }
});

exports._test = { parseCropWaterUse, addDays, todayInDenver };
