// FieldNET (Lindsay) pivot reader (Nov 2026)
//
// Every 10 minutes this signs in to the FieldNET API, reads the status of
// every pivot registered in AIO with statusSource 'fieldnet', and writes it
// into pivots/{FieldNET id} in the SAME shape the BaseStation3 sync uses
// (systemStatus, waterMode, percentTimer, currentPosition, statusDate,
// updatedAt). That is all pivotWatcher needs, so stuck-pivot alerts, the
// lap-time audit and wet/dry hours work for FieldNET pivots with no changes.
//
// What FieldNET gives us per pivot: last_updated (time of its last report),
// speed (a 0..1 share, same idea as the percent timer; 0 = not moving),
// is_water_on, and the arm as a line (pivot point, then the end of the arm).
// It does NOT give us wiper limits, a trustworthy direction or pressure, so
// those are left empty.
//
// IMPORTANT: a FieldNET pivot only reports when something happens, not on a
// steady heartbeat (in early November, 46 of 120 pivots had not reported in
// over a week). So an old report does not mean a dead pivot. Rules below:
//   report 3 hours old or newer     -> Running (speed above 0) or Stopped
//   older, and it was stopped/dry   -> Stopped (idle pivots stay quiet)
//   older, and it was moving or wet -> No signal (we do not know)
//   older than 7 days               -> No signal
// "No signal" is never counted as wet or dry time by pivotWatcher.
//
// Every NEW report (a changed last_updated) is also saved once in
// fieldnetReadings, so we can see how often pivots report and later add up
// wet time from FieldNET's own timestamps.
//
// The sign-in ID and secret are Firebase secrets, set once with:
//   firebase functions:secrets:set FIELDNET_CLIENT_ID
//   firebase functions:secrets:set FIELDNET_CLIENT_SECRET
//
// Lives in its own file (like pivotWatcher.js) so uploading a new index.js
// can't wipe it out. index.js re-exports the one function.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

const FIELDNET_CLIENT_ID = defineSecret('FIELDNET_CLIENT_ID');
const FIELDNET_CLIENT_SECRET = defineSecret('FIELDNET_CLIENT_SECRET');

const FIELDNET_BASE = process.env.FIELDNET_BASE || 'https://v2.api.myfieldnet.com';
const FRESH_HOURS = 3;
const IDLE_MAX_DAYS = 7;
const FARM_TIME_ZONE = 'America/Boise';

// ---- pure helpers (tested on their own) ----------------------------------

// Compass bearing in degrees (0 = north, clockwise) from point A to point B,
// each as [lng, lat]. Null when the two points are the same.
function bearingDegrees(a, b) {
  if (!a || !b) return null;
  const rad = Math.PI / 180;
  const dLng = (b[0] - a[0]) * rad;
  const lat1 = a[1] * rad, lat2 = b[1] * rad;
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  if (Math.abs(x) < 1e-12 && Math.abs(y) < 1e-12) return null;
  return (Math.atan2(y, x) / rad + 360) % 360;
}

// "MM/DD/YYYY hh:mm:ss AM", farm-local, like the text BaseStation3 sends.
function formatFarmLocal(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: FARM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${String(parts.dayPeriod).toUpperCase()}`;
}

// One FieldNET feature -> the few values we use.
function readFeature(f) {
  const p = (f && f.properties) || {};
  const c = (f && f.geometry && Array.isArray(f.geometry.coordinates)) ? f.geometry.coordinates : [];
  const first = c[0] || null;
  const last = c.length > 1 ? c[c.length - 1] : null;
  const when = p.last_updated ? new Date(p.last_updated) : null;
  const speed = Number(p.speed);
  return {
    id: f.id,
    name: typeof p.name === 'string' ? p.name.trim() : '',
    lastUpdated: when && !isNaN(when.getTime()) ? when : null,
    speed: isNaN(speed) ? 0 : speed,
    waterOn: p.is_water_on === true,
    position: bearingDegrees(first, last)
  };
}

// The status AIO should show for this reading right now.
function classify(reading, now) {
  if (!reading.lastUpdated) return { systemStatus: 'No signal', fresh: false };
  const ageHours = (now.getTime() - reading.lastUpdated.getTime()) / 3600000;
  const moving = reading.speed > 0;
  if (ageHours <= FRESH_HOURS) return { systemStatus: moving ? 'Running' : 'Stopped', fresh: true };
  if (ageHours > IDLE_MAX_DAYS * 24) return { systemStatus: 'No signal', fresh: false };
  return { systemStatus: moving || reading.waterOn ? 'No signal' : 'Stopped', fresh: false };
}

// ---- FieldNET API ----------------------------------------------------------

async function signIn(clientId, clientSecret) {
  const res = await fetch(`${FIELDNET_BASE}/connect/token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'api', client_id: clientId, client_secret: clientSecret })
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`FieldNET sign-in failed: HTTP ${res.status}`);
  const token = JSON.parse(text).access_token;
  if (!token) throw new Error('FieldNET sign-in gave no access token');
  return token;
}

async function readAllSystems(token) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${FIELDNET_BASE}/irrigation-systems?page=${page}&page-size=100`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`FieldNET irrigation-systems failed: HTTP ${res.status}`);
    const body = await res.json();
    const feats = Array.isArray(body.features) ? body.features : [];
    out.push(...feats);
    if (feats.length < 100) break;
  }
  return out;
}

// ---- the sync ----------------------------------------------------------------

async function syncFieldnetOnce(clientId, clientSecret, now = new Date()) {
  const db = admin.firestore();
  const regSnap = await db.collection('pivots').where('statusSource', '==', 'fieldnet').get();
  if (regSnap.empty) return { registered: 0, written: 0, newReadings: 0, missing: 0 };

  const token = await signIn(clientId, clientSecret);
  const byId = {};
  (await readAllSystems(token)).forEach((f) => { if (f && f.id) byId[f.id] = readFeature(f); });

  let written = 0, newReadings = 0, missing = 0;
  for (const doc of regSnap.docs) {
    const pivot = doc.data();
    const fnId = pivot.fieldnetId || doc.id;
    const reading = byId[fnId];
    const previousReport = pivot.fieldnetLastUpdated || null;
    try {
      if (!reading) {
        // FieldNET no longer lists this pivot: say so, keep everything else.
        missing++;
        await doc.ref.set({
          systemStatus: 'No signal', signalStale: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        continue;
      }
      const { systemStatus, fresh } = classify(reading, now);
      const lastIso = reading.lastUpdated ? reading.lastUpdated.toISOString() : null;
      const record = {
        guid: doc.id,
        name: reading.name || pivot.name || null,
        farmId: pivot.farmId ?? null,
        rtuId: pivot.rtuId ?? null,
        deviceKind: 'FieldNET',
        systemStatus,
        signalStale: !fresh && systemStatus === 'No signal',
        waterMode: reading.waterOn ? 'Wet' : 'Dry',
        direction: null,
        currentPosition: reading.position == null ? null : (Math.round(reading.position * 10) / 10).toFixed(1),
        percentTimer: (Math.round(reading.speed * 1000) / 10).toFixed(1),
        pressure: null,
        statusDate: reading.lastUpdated ? formatFarmLocal(reading.lastUpdated) : null,
        fieldnetLastUpdated: lastIso,
        fieldnetSpeed: reading.speed,
        fieldnetWaterOn: reading.waterOn,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      await doc.ref.set(record, { merge: true });
      written++;

      // Keep one copy of every NEW report (so we learn how often pivots
      // report, and can add up wet time from FieldNET's own times later).
      if (lastIso && previousReport !== lastIso) {
        await db.collection('fieldnetReadings').doc(`${doc.id}_${lastIso}`).set({
          pivotGuid: doc.id,
          name: record.name,
          reportedAt: admin.firestore.Timestamp.fromDate(reading.lastUpdated),
          speed: reading.speed,
          waterOn: reading.waterOn,
          position: record.currentPosition,
          recordedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        newReadings++;
      }
    } catch (err) {
      console.error(`FieldNET write failed for ${pivot.name || doc.id}:`, err.message);
    }
  }
  return { registered: regSnap.size, written, newReadings, missing };
}

exports.syncFieldnetPivots = onSchedule(
  {
    schedule: 'every 10 minutes',
    timeZone: 'America/Denver',
    secrets: [FIELDNET_CLIENT_ID, FIELDNET_CLIENT_SECRET],
    timeoutSeconds: 120,
    memory: '256MiB'
  },
  async () => {
    try {
      const r = await syncFieldnetOnce(FIELDNET_CLIENT_ID.value(), FIELDNET_CLIENT_SECRET.value());
      console.log(`FieldNET sync: ${r.registered} registered, ${r.written} written, ${r.newReadings} new reports, ${r.missing} not found in FieldNET.`);
    } catch (err) {
      console.error('FieldNET sync failed:', err.message);
    }
  }
);

// Exported for tests only.
exports._test = { bearingDegrees, formatFarmLocal, readFeature, classify, syncFieldnetOnce };
