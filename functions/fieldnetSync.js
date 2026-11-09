// FieldNET (Lindsay) pivot reader, version 3 (Nov 2026)
//
// Every 10 minutes this signs in to the FieldNET API, reads every pivot
// registered in AIO with statusSource 'fieldnet', and writes it into
// pivots/{FieldNET id} in the SAME shape the BaseStation3 sync uses
// (systemStatus, waterMode, direction, percentTimer, currentPosition,
// pressure, forwardAngle/reverseAngle, statusDate, updatedAt). That is all the
// pivot icon, the detail panel and pivotWatcher need.
//
// Data source: FieldNET's /irrigation-controllers list. (The older
// /irrigation-systems list only had a last-change time, speed and a map line.
// The controllers list has the exact status, direction, arm angle, pressure,
// volts, wiper limits, circle time and running-time counters.)
//
// What the controllers list tells us, and how we use it:
//   operational_status   forward-wet / reverse-wet  -> Running, Wet
//                        forward / reverse          -> Running, Dry
//                        anything else (stopped, service-stop, low-pressure-
//                        shutdown, auto-stop-at-barrier, powered-off ...) -> Stopped
//                        (the exact word is kept in fieldnetStatus)
//   communication_status "offline" or status "not-connected" -> No signal
//                        (we do not know, so no wet/dry time is counted)
//   direction            forward / reverse (kept as 'Forward' / 'Reverse' while
//                        running; a stopped pivot keeps its last direction)
//   pivot_angle          arm angle in degrees -> currentPosition
//   pressure             comes in BAR; stored as PSI (bar x 14.5038). Pivots
//                        with no voltage reading have no pressure sensor data,
//                        so their pressure is left empty.
//   partial_start_angle / partial_end_angle -> reverseAngle / forwardAngle
//                        (wiper limits; 0 and 0 means a full circle)
//
// "Running" older than RUNNING_HOLD_HOURS (72 h) with no new report is shown as
// No signal: FieldNET sometimes misses a stop report (20-C Mini showed
// "running" since April). No signal is never counted as wet or dry time.
//
// The stuck-pivot alert depends on how fresh the arm angle is. If the angle
// only refreshes when FieldNET gets a report, a running pivot would look
// frozen. ANGLE_IS_LIVE says whether we trust it. While it is false, each
// pivot is saved with skipStuckCheck: true and pivotWatcher leaves it alone.
//
// Every NEW report (a changed last_updated) is also saved once in
// fieldnetReadings, with the counters, so we can add up wet time later.
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
const RUNNING_HOLD_HOURS = 72;
const ANGLE_IS_LIVE = false; // set to true only after the freshness test proves it
const FARM_TIME_ZONE = 'America/Boise';
const PSI_PER_BAR = 14.5038;

// ---- pure helpers (tested on their own) ----------------------------------

// "MM/DD/YYYY hh:mm:ss AM", farm-local, like the text BaseStation3 sends.
function formatFarmLocal(date) {
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: FARM_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true
  }).formatToParts(date).forEach((p) => { parts[p.type] = p.value; });
  return `${parts.month}/${parts.day}/${parts.year} ${parts.hour}:${parts.minute}:${parts.second} ${String(parts.dayPeriod).toUpperCase()}`;
}

const numOrNull = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));
const round1 = (n) => Math.round(n * 10) / 10;

// One controller from /irrigation-controllers -> the few values we use.
function readController(c) {
  const when = c.last_updated ? new Date(c.last_updated) : null;
  const status = typeof c.operational_status === 'string' ? c.operational_status : '';
  const dir = typeof c.direction === 'string' ? c.direction.toLowerCase() : '';
  const voltage = numOrNull(c.voltage);
  const bar = numOrNull(c.pressure);
  const speed = numOrNull(c.speed);
  const angle = numOrNull(c.pivot_angle);
  const depthMm = numOrNull(c.application_depth);
  const runFull = numOrNull(c.run_time_100_percent);
  const nextStop = numOrNull(c.next_pivot_stop_time);
  return {
    id: c.id,
    name: typeof c.name === 'string' ? c.name.trim() : '',
    lastUpdated: when && !isNaN(when.getTime()) ? when : null,
    status,
    running: /^(forward|reverse)(-wet)?$/.test(status),
    wet: /-wet$/.test(status),
    offline: c.communication_status === 'offline' || status === 'not-connected',
    direction: dir === 'forward' ? 'Forward' : dir === 'reverse' ? 'Reverse' : null,
    angle,
    waterOn: c.is_water_on === true,
    speed: speed == null ? 0 : speed,
    voltage,
    pressureBar: bar,
    // No voltage reading = the panel is not sending analog data; do not show a pressure.
    pressurePsi: bar == null || voltage == null ? null : Math.round(bar * PSI_PER_BAR),
    flow: numOrNull(c.flow),
    startAngle: numOrNull(c.partial_start_angle),
    endAngle: numOrNull(c.partial_end_angle),
    circleHours: runFull != null && speed ? round1(runFull / speed / 3600) : null,
    nextStopHours: nextStop == null ? null : round1(nextStop / 3600),
    depthIn: depthMm == null ? null : Math.round(depthMm / 25.4 * 100) / 100,
    plan: typeof c.plan === 'string' ? c.plan : null,
    endgun1On: c.is_endgun_1_on === true,
    endgun2On: c.is_endgun_2_on === true,
    counters: {
      total: numOrNull(c.total_runtime),
      irrigator: numOrNull(c.irrigator_runtime),
      pump: numOrNull(c.pump_runtime),
      endgun1: numOrNull(c.endgun1_runtime),
      endgun2: numOrNull(c.endgun2_runtime),
      chemigation: numOrNull(c.chemigation_runtime)
    }
  };
}

// The status AIO should show for this reading right now.
function classify(r, now) {
  if (r.offline) return { systemStatus: 'No signal', fresh: false };
  if (r.running) {
    if (!r.lastUpdated) return { systemStatus: 'No signal', fresh: false };
    const ageHours = (now.getTime() - r.lastUpdated.getTime()) / 3600000;
    if (ageHours > RUNNING_HOLD_HOURS) return { systemStatus: 'No signal', fresh: false };
    return { systemStatus: 'Running', fresh: true };
  }
  return { systemStatus: 'Stopped', fresh: true };
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

async function readAllControllers(token) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(`${FIELDNET_BASE}/irrigation-controllers?page=${page}&page-size=100`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` }
    });
    if (!res.ok) throw new Error(`FieldNET irrigation-controllers failed: HTTP ${res.status}`);
    const body = await res.json();
    const items = Array.isArray(body) ? body : (Array.isArray(body.items) ? body.items : []);
    out.push(...items);
    if (items.length < 100) break;
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
  (await readAllControllers(token)).forEach((c) => { if (c && c.id) byId[c.id] = readController(c); });

  let written = 0, newReadings = 0, missing = 0;
  for (const doc of regSnap.docs) {
    const pivot = doc.data();
    const fnId = pivot.fieldnetId || doc.id;
    const r = byId[fnId];
    const previousReport = pivot.fieldnetLastUpdated || null;
    try {
      if (!r) {
        // FieldNET no longer lists this pivot: say so, keep everything else.
        missing++;
        await doc.ref.set({
          systemStatus: 'No signal', signalStale: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        continue;
      }
      const { systemStatus, fresh } = classify(r, now);
      const lastIso = r.lastUpdated ? r.lastUpdated.toISOString() : null;
      const isRunning = systemStatus === 'Running';
      const record = {
        guid: doc.id,
        name: r.name || pivot.name || null,
        farmId: pivot.farmId ?? null,
        rtuId: pivot.rtuId ?? null,
        deviceKind: 'FieldNET',
        systemStatus,
        signalStale: !fresh && systemStatus === 'No signal',
        waterMode: isRunning ? (r.wet ? 'Wet' : 'Dry') : (r.waterOn ? 'Wet' : 'Dry'),
        currentPosition: r.angle == null ? null : round1(r.angle).toFixed(1),
        percentTimer: round1(r.speed * 100).toFixed(1),
        pressure: r.pressurePsi == null ? null : String(r.pressurePsi),
        reverseAngle: r.startAngle,
        forwardAngle: r.endAngle,
        skipStuckCheck: !ANGLE_IS_LIVE,
        statusDate: r.lastUpdated ? formatFarmLocal(r.lastUpdated) : null,
        fieldnetLastUpdated: lastIso,
        fieldnetStatus: r.status || null,
        fieldnetComm: r.offline ? 'offline' : 'online',
        fieldnetAngle: r.angle,
        fieldnetVoltage: r.voltage,
        fieldnetPressureBar: r.pressureBar,
        fieldnetFlow: r.flow,
        fieldnetCircleHours: r.circleHours,
        fieldnetNextStopHours: r.nextStopHours,
        fieldnetDepthIn: r.depthIn,
        fieldnetPlan: r.plan,
        fieldnetEndgun1On: r.endgun1On,
        fieldnetEndgun2On: r.endgun2On,
        fieldnetCounters: r.counters,
        fieldnetCheckedAt: now.toISOString(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      // A stopped pivot keeps the direction it last ran in (for the icon).
      if (isRunning && r.direction) record.direction = r.direction;
      await doc.ref.set(record, { merge: true });
      written++;

      // Keep one copy of every NEW report (so we learn how often pivots
      // report, and can add up wet time from FieldNET's own times later).
      if (lastIso && previousReport !== lastIso) {
        await db.collection('fieldnetReadings').doc(`${doc.id}_${lastIso}`).set({
          pivotGuid: doc.id,
          name: record.name,
          reportedAt: admin.firestore.Timestamp.fromDate(r.lastUpdated),
          status: r.status || null,
          direction: r.direction,
          waterOn: r.waterOn,
          angle: r.angle,
          pressureBar: r.pressureBar,
          counters: r.counters,
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
exports._test = { formatFarmLocal, readController, classify, syncFieldnetOnce };
