// FieldNET (Lindsay) pivot reader, version 3.5 (Nov 2026)
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
//   direction            'forward' / 'reverse' means the pivot is MOVING. FieldNET
//                        also puts extra words on a moving pivot (for example
//                        low-pressure-warning), so "running" is decided from the
//                        direction, not from the status word. Two stale statuses
//                        (not-connected, powered-off) can keep an old direction,
//                        so they never count as running. Every stopped status
//                        (stopped, service-stop, low-pressure-shutdown,
//                        auto-stop-at-barrier, alignment-fault ...) reports
//                        direction 'stopped'.
//   operational_status   forward-wet / reverse-wet  -> Running, Wet
//                        forward / reverse          -> Running, Dry
//                        (the exact word is always kept in fieldnetStatus)
//   is_water_on          decides Wet or Dry for a moving pivot whose status
//                        has an extra word (a low-pressure warning with the
//                        water on is Running, Wet)
//   communication_status "offline" (FieldNET's last poll failed) or status
//                        "not-connected": a pivot that was STOPPED and is
//                        offline shows No signal (it may have started since).
//                        A pivot that was RUNNING keeps showing Running for up
//                        to OFFLINE_RUNNING_HOLD_HOURS (one failed poll does not
//                        mean it stopped), then shows No signal.
//                        No signal is never counted as wet or dry time.
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
// FieldNET refreshes the arm angle, pressure and counters at irregular times
// (about hourly, per the first test), not on every 10-minute check. So every
// time any of them CHANGES, one row is saved in fieldnetSamples with the time
// we noticed. That log shows how often each pivot's data really refreshes, and
// fieldnetAngleChangedAt on the pivot says how old its angle is.
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
const OFFLINE_RUNNING_HOLD_HOURS = 6;
const ANGLE_IS_LIVE = false; // set to true only after the freshness test proves it
const FARM_TIME_ZONE = 'America/Boise';
const PSI_PER_BAR = 14.5038;
const FEET_PER_METER = 3.28084;

// What to show under the pivot icon for each FieldNET status word (the same
// thing the FieldNET app shows under each pivot). tone: 'fault' = the icon
// turns red and the detail panel gets a red bar; 'warning' / 'info' = a colored
// bar in the detail panel; null = an ordinary running or stopped status (label
// only, no bar). A status word we have not seen before still gets a label (the
// word, tidied up) so a new kind of stop never goes unnoticed.
// label = the short text under the icon (two lines at most); full = the
// wording for the detail panel.
const STATUS_LABELS = {
  'low-pressure-shutdown': { label: 'Low PSI', full: 'Low pressure shutdown', tone: 'fault' },
  'alignment-fault': { label: 'Alignment Fault', full: 'Alignment fault', tone: 'fault' },
  'low-pressure-warning': { label: 'Low PSI Warn', full: 'Low pressure warning', tone: 'warning' },
  'service-stop': { label: 'Service Stop', full: 'Service stop', tone: 'info' },
  'auto-stop-at-barrier': { label: 'Auto Barrier Stop', full: 'Auto stop at barrier', tone: 'info' },
  'soft-barrier-stop': { label: 'Soft Barrier Stop', full: 'Soft barrier stop', tone: 'info' },
  'powered-off': { label: 'Powered Off', full: 'Powered off', tone: 'info' },
  'not-connected': { label: 'Not Connected', full: 'Not connected', tone: 'info' },
  'stopped-wet': { label: 'Stopped Wet', full: 'Stopped, water on', tone: 'info' },
  'stopped': { label: 'Stopped', full: 'Stopped', tone: null },
  'forward': { label: 'Forward', full: 'Forward', tone: null },
  'forward-wet': { label: 'Forward Wet', full: 'Forward, wet', tone: null },
  'reverse': { label: 'Reverse', full: 'Reverse', tone: null },
  'reverse-wet': { label: 'Reverse Wet', full: 'Reverse, wet', tone: null }
};

function statusLabelFor(status) {
  if (!status) return { label: null, full: null, tone: null };
  if (STATUS_LABELS[status]) return STATUS_LABELS[status];
  const words = String(status).replace(/[-_]+/g, ' ').trim();
  return {
    label: words.replace(/\b\w/g, (c) => c.toUpperCase()),
    full: words.charAt(0).toUpperCase() + words.slice(1),
    tone: 'info'
  };
}

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

// Meters -> whole feet. Uses the wet length, else the dry length, else null.
function lengthFeet(wetM, dryM) {
  const m = numOrNull(wetM) > 0 ? numOrNull(wetM) : (numOrNull(dryM) > 0 ? numOrNull(dryM) : null);
  return m == null ? null : Math.round(m * FEET_PER_METER);
}

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
  const moving = (dir === 'forward' || dir === 'reverse') && status !== 'not-connected' && status !== 'powered-off';
  const waterOn = c.is_water_on === true;
  return {
    id: c.id,
    name: typeof c.name === 'string' ? c.name.trim() : '',
    lastUpdated: when && !isNaN(when.getTime()) ? when : null,
    status,
    running: moving,
    wet: /-wet$/.test(status) || (moving && waterOn),
    offline: c.communication_status === 'offline' || status === 'not-connected',
    direction: dir === 'forward' ? 'Forward' : dir === 'reverse' ? 'Reverse' : null,
    angle,
    waterOn,
    speed: speed == null ? 0 : speed,
    voltage,
    pressureBar: bar,
    // No voltage reading = the panel is not sending analog data; do not show a pressure.
    pressurePsi: bar == null || voltage == null ? null : Math.round(bar * PSI_PER_BAR),
    flow: numOrNull(c.flow),
    // Pivot length. FieldNET gives meters. system_length_wet (the radius the
    // water reaches, 1314 ft on 11-A) is the one that matches the app; the
    // plain system_length is the shorter dry length.
    lengthFt: lengthFeet(c.system_length_wet, c.system_length),
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

// What counts as "FieldNET sent us something new". Pressure only counts while
// the pivot is running (a stopped pivot's pressure just flickers).
function fingerprint(r) {
  return JSON.stringify([r.status, r.angle, r.running ? r.pressureBar : null, r.voltage, r.counters, r.lastUpdated ? r.lastUpdated.toISOString() : null]);
}

// The status AIO should show for this reading right now.
function classify(r, now) {
  if (r.status === 'not-connected') return { systemStatus: 'No signal', fresh: false };
  if (r.running) {
    if (!r.lastUpdated) return { systemStatus: 'No signal', fresh: false };
    const ageHours = (now.getTime() - r.lastUpdated.getTime()) / 3600000;
    if (ageHours > RUNNING_HOLD_HOURS) return { systemStatus: 'No signal', fresh: false };
    if (r.offline && ageHours > OFFLINE_RUNNING_HOLD_HOURS) return { systemStatus: 'No signal', fresh: false };
    return { systemStatus: 'Running', fresh: true };
  }
  if (r.offline) return { systemStatus: 'No signal', fresh: false };
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
  if (regSnap.empty) return { registered: 0, written: 0, newReadings: 0, newSamples: 0, missing: 0 };

  const token = await signIn(clientId, clientSecret);
  const byId = {};
  (await readAllControllers(token)).forEach((c) => { if (c && c.id) byId[c.id] = readController(c); });

  let written = 0, newReadings = 0, newSamples = 0, missing = 0;
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
      const fp = fingerprint(r);
      const dataChanged = fp !== (pivot.fieldnetFingerprint || null);
      const angleChanged = r.angle !== (pivot.fieldnetAngle === undefined ? null : pivot.fieldnetAngle);
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
        statusLabel: statusLabelFor(r.status).label,
        statusFull: statusLabelFor(r.status).full,
        statusTone: statusLabelFor(r.status).tone,
        fieldnetComm: r.offline ? 'offline' : 'online',
        fieldnetAngle: r.angle,
        fieldnetVoltage: r.voltage,
        fieldnetPressureBar: r.pressureBar,
        fieldnetFlow: r.flow,
        fieldnetLengthFt: r.lengthFt,
        fieldnetCircleHours: r.circleHours,
        fieldnetNextStopHours: r.nextStopHours,
        fieldnetDepthIn: r.depthIn,
        fieldnetPlan: r.plan,
        fieldnetEndgun1On: r.endgun1On,
        fieldnetEndgun2On: r.endgun2On,
        fieldnetCounters: r.counters,
        fieldnetCheckedAt: now.toISOString(),
        fieldnetFingerprint: fp,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
      // FieldNET only gives a direction while the pivot is moving; a stopped
      // pivot keeps the direction it last ran in (for the icon).
      if (r.direction) record.direction = r.direction;
      // When did we last SEE a new angle? (The angle is only as fresh as this.)
      if (angleChanged || !pivot.fieldnetAngleChangedAt) record.fieldnetAngleChangedAt = now.toISOString();
      await doc.ref.set(record, { merge: true });
      written++;

      // Pivot length goes on the pivot's profile as machineLengthFt (feet),
      // the same field the BaseStation pivots use, so the Pivot Profile page
      // can work out the circle acres. Written only when FieldNET's number
      // changes (or the profile never got it).
      if (r.lengthFt && (pivot.fieldnetLengthFt !== r.lengthFt || pivot.fieldnetLengthSaved !== true)) {
        await db.collection('pivotProfiles').doc(doc.id).set({
          machineLengthFt: r.lengthFt,
          machineLengthSource: 'fieldnet'
        }, { merge: true });
        await doc.ref.set({ fieldnetLengthSaved: true }, { merge: true });
      }

      // One row each time FieldNET's data for this pivot changed (see header).
      if (dataChanged) {
        await db.collection('fieldnetSamples').doc(`${doc.id}_${now.toISOString()}`).set({
          pivotGuid: doc.id,
          name: record.name,
          seenAt: admin.firestore.Timestamp.fromDate(now),
          status: r.status || null,
          angle: r.angle,
          angleChanged,
          pressureBar: r.pressureBar,
          voltage: r.voltage,
          waterOn: r.waterOn,
          counters: r.counters,
          lastUpdated: lastIso
        });
        newSamples++;
      }

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
  return { registered: regSnap.size, written, newReadings, newSamples, missing };
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
      console.log(`FieldNET sync: ${r.registered} registered, ${r.written} written, ${r.newReadings} new reports, ${r.newSamples} data changes, ${r.missing} not found in FieldNET.`);
    } catch (err) {
      console.error('FieldNET sync failed:', err.message);
    }
  }
);

// Exported for tests only.
exports._test = { formatFarmLocal, readController, classify, syncFieldnetOnce, statusLabelFor };
