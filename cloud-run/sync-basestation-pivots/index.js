import {http} from '@google-cloud/functions-framework';
import admin from 'firebase-admin';

admin.initializeApp();
const db = admin.firestore();

const BASE_URL = 'http://kurlfarms.basestation3.com:8080/basestation3services';

async function login() {
  const res = await fetch(`${BASE_URL}/UserMgmt.svc/User/Login`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      UserName: process.env.BASESTATION3_USERNAME,
      Password: process.env.BASESTATION3_PASSWORD,
    }),
  });

  if (!res.ok) {
    throw new Error(`Login failed: ${res.status} ${res.statusText}`);
  }

  const securityToken = res.headers.get('securitytoken');
  const body = await res.json();
  const userId = body.UserId;

  if (!securityToken || !userId) {
    throw new Error('Login response missing Securitytoken or UserId');
  }

  return {securityToken, userId};
}

async function getPivotStatus(guid, auth) {
  const res = await fetch(
    `${BASE_URL}/deviceconfigurationservice.svc/GetUniversalPanel/${guid}`,
    {
      headers: {
        Accept: 'application/json',
        Securitytoken: auth.securityToken,
        Userid: auth.userId,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Status fetch failed for ${guid}: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

// AgSense 365 panels (ICON Link, CommanderVP) can't be asked for one at a time
// the way pivots are: GetUniversalPanel answers 500 for them. BaseStation3's
// own web page gets their status from the farm's full device list instead, so
// that is what this reads (one request per farm, however many AgSense panels
// the farm has). Returns the devices keyed by their BaseStation3 ID.
async function getFarmDevicesById(farmGuid, auth) {
  const res = await fetch(
    `${BASE_URL}/deviceconfigurationservice.svc/DevicesByFarmIdAndUserId/${farmGuid}/${auth.userId}`,
    {
      headers: {
        Accept: 'application/json',
        Securitytoken: auth.securityToken,
        Userid: auth.userId,
      },
    }
  );

  if (!res.ok) {
    throw new Error(`Farm device list failed for ${farmGuid}: ${res.status} ${res.statusText}`);
  }

  const list = await res.json();
  if (!Array.isArray(list)) {
    throw new Error('Farm device list was not a list. Keys: ' + Object.keys(list || {}).slice(0, 25).join(', '));
  }
  const byId = {};
  for (const device of list) {
    if (device && device.Id) byId[device.Id] = device;
  }
  return byId;
}

// BaseStation3's own value is truthy-checked as a string, since this API
// stringifies most fields (see how `pressure` and `percentTimer` come back
// quoted elsewhere in this same response) — a literal "false" string would
// otherwise pass a plain truthy check.
function isTrue(value) {
  return value === true || value === 'true';
}

// AgSense 365 panels (ICON Link, CommanderVP) are listed in BaseStation3 next
// to the regular pivots, but their status comes back under different names:
// AgSenseBasicStatus / AgSenseSupplementaryStates instead of PivotBasicStatus
// / PivotSupplementaryStates, and a few fields are named differently
// (wiper limits are MinAngle/MaxAngle, wet/dry is Water on/off, and the
// percent timer is AppliedPercent).
//
// AgSense panels also go quiet without BaseStation3 noticing: a panel can sit
// on "Running" with a status time months old. pivotWatcher judges freshness by
// when THIS sync ran, so a dead panel would look alive and eventually trigger
// stuck-pivot texts. If an AgSense panel's own status time is older than
// the limit below, it is reported as "No signal" instead of its last status.
const AGSENSE_STALE_MINUTES = 180;
const FARM_TIME_ZONE = 'America/Boise';

// BaseStation3 writes status times as farm-local text, e.g.
// "10/26/2026 02:03:10 PM". Both sides of the comparison are turned into the
// same kind of plain local-looking date, so the server's own time zone
// cancels out.
function minutesSinceFarmLocalTime(text) {
  if (!text) return null;
  const then = new Date(text);
  if (isNaN(then.getTime())) return null;
  const nowFarm = new Date(new Date().toLocaleString('en-US', {timeZone: FARM_TIME_ZONE}));
  return (nowFarm.getTime() - then.getTime()) / 60000;
}

// ---- Status label under the pivot icon (same idea as FieldNET's statusLabelFor) ----
// Turns BaseStation3's current stop reason into a short label under the pivot icon.
// BaseStation writes times as farm-local text, e.g. "11/09/2026 02:42:03 PM".
// Returns a real UTC time (ISO text) or null.
function farmLocalToIso(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4}) (\d{1,2}):(\d{2}):(\d{2}) (AM|PM)$/i.exec(String(text || '').trim());
  if (!m) return null;
  const hour = (Number(m[4]) % 12) + (m[7].toUpperCase() === 'PM' ? 12 : 0);
  const asUtc = Date.UTC(Number(m[3]), Number(m[1]) - 1, Number(m[2]), hour, Number(m[5]), Number(m[6]));
  const offset = (t) => {
    const d = new Date(t);
    return new Date(d.toLocaleString('en-US', {timeZone: FARM_TIME_ZONE})).getTime() -
      new Date(d.toLocaleString('en-US', {timeZone: 'UTC'})).getTime();
  };
  const t = asUtc - offset(asUtc - offset(asUtc));
  return new Date(t).toISOString();
}

// Normal stops: shown as "Stopped: <reason>", gray icon.
const NORMAL = {'sis': 'SIS', 'command': 'Command', 'auto-stop': 'Auto-Stop'};
// Real faults: red icon. [short label, full wording]
const FAULTS = {
  'safety': ['Safety Stop', 'Shutdown: Safety'],
  'system safety': ['Sys Safety', 'Shutdown: System Safety'],
  'low pressure': ['Low PSI', 'Shutdown: Low Pressure'],
  'high water pressure': ['High PSI', 'Shutdown: High Water Pressure'],
  'pressure': ['Pressure', 'Shutdown: Pressure'],
  'power': ['Power Fault', 'Shutdown: Power'],
};

function titleCase(s) {
  return s.replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

// reasons: "Shutdown: SIS , Command" -> ['sis', 'command']  (AgSense just says "Sis")
function parseReasons(text) {
  const seen = [];
  String(text || '').replace(/^shutdown:\s*/i, '').split(',').forEach((part) => {
    const r = part.trim().toLowerCase();
    if (r && !seen.includes(r)) seen.push(r);
  });
  return seen;
}

// alarms: the device's alarm list (BaseStation keeps a log of recent events).
// Used only to find WHEN the stop happened, never to decide the status.
function sinceFor(reasons, alarms) {
  let best = null;
  for (const a of Array.isArray(alarms) ? alarms : []) {
    const info = a.AlarmTypeInfo || {};
    if (info.AlarmCategory !== 1) continue;
    if (!reasons.includes(String(info.AlarmName || '').trim().toLowerCase())) continue;
    const iso = farmLocalToIso(a.CreatedDate);
    if (iso && (!best || iso > best)) best = iso;
  }
  return best;
}

function bsStatusFor({running, direction, wet, shutDownFault, noSignal, lastHeard, alarms}) {
  if (noSignal) return {statusLabel: 'No Signal', statusFull: 'No signal from the panel', statusTone: 'info', statusSince: farmLocalToIso(lastHeard)};
  if (running) {
    const dir = String(direction || '').toLowerCase() === 'reverse' ? 'Reverse' : 'Forward';
    return {statusLabel: wet ? `${dir} Wet` : dir, statusFull: `${dir}, ${wet ? 'wet' : 'dry'}`, statusTone: null, statusSince: null};
  }
  const reasons = parseReasons(shutDownFault);
  if (!reasons.length) return {statusLabel: 'Stopped', statusFull: 'Stopped', statusTone: null, statusSince: null};
  const faultKey = reasons.find((r) => !(r in NORMAL));
  if (faultKey) {
    const since = sinceFor([faultKey], alarms);
    // Anything BaseStation calls a shutdown that is not on the normal list is treated as a real fault.
    const [label, full] = FAULTS[faultKey] || [`${titleCase(faultKey)} Fault`, `Shutdown: ${titleCase(faultKey)}`];
    return {statusLabel: label, statusFull: full, statusTone: 'fault', statusSince: since};
  }
  const since = sinceFor(reasons, alarms);
  const names = reasons.map((r) => NORMAL[r]);
  // Two reasons at once is rare; the label squeezes them in, the panel gets the full wording.
  const short = names.map((n) => (names.length > 1 && n === 'Command' ? 'Cmd' : n)).join('/');
  return {statusLabel: `Stopped: ${short}`, statusFull: `Stopped: ${names.join(', ')}`, statusTone: null, statusSince: since};
}

// Look-only helper for the ?peek= mode below. Walks a BaseStation3 response
// and lists fields whose KEY looks like a name / farm / label / length, so we
// can see where BaseStation keeps a pivot's current name. Changes nothing.
function findFields(obj, re, path = '', depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 3 || out.length >= 80) return out;
  for (const [k, v] of Object.entries(obj)) {
    const p = path ? `${path}.${k}` : k;
    if (re.test(k) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) {
      out.push({path: p, value: v});
    } else if (v && typeof v === 'object') {
      findFields(v, re, p, depth + 1, out);
    }
  }
  return out;
}

function sectionKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    out[k] = v && typeof v === 'object' ? Object.keys(v).slice(0, 60) : typeof v;
  }
  return out;
}

http('syncBasestationPivots', async (req, res) => {
  try {
    // PEEK MODE (look only): ?peek=<rtu id, guid, or part of the stored name>
    // Fetches that one pivot's BaseStation3 response and reports which fields
    // look like names. Writes nothing.
    if (req.query && req.query.peek) {
      const want = String(req.query.peek).toLowerCase();
      const snap = await db.collection('pivots').get();
      const all = snap.docs.map(doc => ({guid: doc.id, ...doc.data()}));
      const pivot =
        all.find(p => String(p.rtuId ?? '').toLowerCase() === want) ||
        all.find(p => p.guid.toLowerCase() === want) ||
        all.find(p => String(p.name ?? '').toLowerCase().includes(want));
      if (!pivot) {
        res.status(404).json({error: 'No registered pivot matches', peek: req.query.peek});
        return;
      }
      const auth = await login();
      const NAMEISH = /name|label|title|descr|farm|site|rtu|length/i;
      const out = {
        storedInAio: {guid: pivot.guid, rtuId: pivot.rtuId ?? null, name: pivot.name ?? null, statusSource: pivot.statusSource ?? null, bsFarmGuid: pivot.bsFarmGuid ?? null},
      };
      const panel = await getPivotStatus(pivot.guid, auth).catch(err => ({__error: err.message}));
      out.panelResponse = {sections: sectionKeys(panel), nameLikeFields: findFields(panel, NAMEISH)};
      if (pivot.bsFarmGuid) {
        const list = await getFarmDevicesById(pivot.bsFarmGuid, auth).catch(err => ({__error: err.message}));
        const device = list && list[pivot.guid];
        out.farmListEntry = device
          ? {sections: sectionKeys(device), nameLikeFields: findFields(device, NAMEISH)}
          : 'not found in farm device list';
      }
      res.status(200).json(out);
      return;
    }

    // Read the pivot list from Firestore instead of a hardcoded array.
    // Adding a pivot now means adding a document, not redeploying this function.
    const registrySnapshot = await db.collection('pivots').get();
    const pivots = registrySnapshot.docs.map(doc => ({guid: doc.id, ...doc.data()}));

    if (pivots.length === 0) {
      res.status(200).json({results: [], note: 'No pivots registered in Firestore'});
      return;
    }

    const auth = await login();
    const results = [];

    // Farm device lists, fetched at most once per farm per run, and only for
    // farms that have a registered AgSense panel (statusSource 'farmList').
    const farmDeviceLists = {};
    async function farmDevices(farmGuid) {
      if (!farmDeviceLists[farmGuid]) {
        farmDeviceLists[farmGuid] = getFarmDevicesById(farmGuid, auth).then(
          (list) => ({list}),
          (err) => ({err})
        );
      }
      const outcome = await farmDeviceLists[farmGuid];
      if (outcome.err) throw outcome.err;
      return outcome.list;
    }

    for (const pivot of pivots) {
      // FieldNET pivots are read by the separate FieldNET sync, not BaseStation3.
      if (pivot.statusSource === 'fieldnet') continue;
      try {
        let data;
        if (pivot.statusSource === 'farmList') {
          if (!pivot.bsFarmGuid) throw new Error('No bsFarmGuid saved for this device');
          const device = (await farmDevices(pivot.bsFarmGuid))[pivot.guid];
          if (!device) throw new Error('Device not found in its farm device list');
          data = {
            AgSenseBasicStatus: device.AgSenseBasicStatus,
            AgSenseSupplementaryStates: device.AgSenseSupplementaryStates,
            PivotBasicStatus: device.PivotBasicStatus,
            PivotSupplementaryStates: device.PivotSupplementaryState || device.PivotSupplementaryStates,
          };
        } else {
          data = await getPivotStatus(pivot.guid, auth);
        }
        const isAgSense = !data.PivotBasicStatus && !!(data.AgSenseBasicStatus || data.AgSenseSupplementaryStates);
        if (!data.PivotBasicStatus && !isAgSense) {
          throw new Error('Unrecognized status response. Keys: ' + Object.keys(data || {}).slice(0, 25).join(', '));
        }
        const status = data.PivotBasicStatus || data.AgSenseBasicStatus || {};

        // The live pressure reading and the flags that say which source
        // is actually active for this panel don't live in PivotBasicStatus
        // at all — they're in a separate sibling section of the same
        // response, PivotSupplementaryStates. Confirmed directly from a
        // captured BaseStation3 response: PivotBasicStatus.Pressure sat at
        // "0" the whole time, while PivotSupplementaryStates.RemotePressure
        // held the real live value with IsShowRemotePressure set to true.
        //
        // There's actually a third possible source too — IsShowEndPressure
        // / EndPressure — so this checks all three flags BaseStation3
        // provides rather than assuming it's only ever a two-way choice
        // between old and new panel styles.
        const supplementary = data.PivotSupplementaryStates || data.AgSenseSupplementaryStates || {};
        let pressure;
        if (isTrue(supplementary.IsShowRemotePressure)) {
          pressure = supplementary.RemotePressure;
        } else if (isTrue(supplementary.IsShowEndPressure)) {
          pressure = supplementary.EndPressure;
        } else if (supplementary.CurrentPressure != null) {
          pressure = supplementary.CurrentPressure;
        } else {
          pressure = status.Pressure;
        }

        let record;
        if (isAgSense) {
          const statusDate = status.StatusDate ?? supplementary.Status ?? null;
          const ageMinutes = minutesSinceFarmLocalTime(statusDate);
          const stale = ageMinutes != null && ageMinutes > AGSENSE_STALE_MINUTES;
          const rawSystemStatus = supplementary.SystemStatus ?? status.SystemStatus ?? null;
          const water = status.Water ?? supplementary.Water ?? null;
          const agLabel = bsStatusFor({
            running: !stale && rawSystemStatus === 'Running',
            direction: status.Direction ?? supplementary.Direction,
            wet: water === 'on',
            shutDownFault: supplementary.ShutDownFault ?? status.ShutDownFault,
            noSignal: stale,
            lastHeard: statusDate,
            alarms: status.Alarms || supplementary.Alarms,
          });
          record = {
            ...agLabel,
            rtuId: pivot.rtuId ?? null,
            name: pivot.name ?? null,
            farmId: pivot.farmId ?? null,
            guid: pivot.guid,
            deviceKind: 'AgSense',
            systemStatus: stale ? 'No signal' : rawSystemStatus,
            signalStale: stale,
            waterMode: status.WaterMode ?? (water === 'on' ? 'Wet' : water === 'off' ? 'Dry' : null),
            direction: status.Direction ?? supplementary.Direction ?? null,
            currentPosition: status.Angle ?? supplementary.Angle ?? null,
            percentTimer: supplementary.PercentTimer ?? status.AppliedPercent ?? null,
            pressure: pressure ?? null,
            forwardAngle: status.MaxAngle ?? null,
            reverseAngle: status.MinAngle ?? null,
            statusDate,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
        } else {
          // The pivot's current name as BaseStation3 has it right now
          // (PivotBasicStatus.PivotName), so renaming a pivot in BaseStation3
          // carries over here on the next sync. If BaseStation3 doesn't
          // send one, keep the name already stored.
          const bsName = typeof status.PivotName === 'string' ? status.PivotName.trim() : '';
          // BaseStation3 says PollingState false when it is not hearing from the
          // panel. A pivot can sit on "Running" for days that way, so (like AgSense)
          // it is reported as "No signal" instead of its last status.
          const noSignal = status.PollingState === false || status.PollingState === 'false';
          const rawStatus = status.SystemStatus ?? null;
          const pvLabel = bsStatusFor({
            running: !noSignal && rawStatus === 'Running',
            direction: status.Direction ?? supplementary.Direction,
            wet: (status.WaterMode ?? supplementary.WaterMode) === 'Wet',
            shutDownFault: supplementary.ShutDownFault ?? status.ShutDownFault,
            noSignal,
            lastHeard: status.StatusDate,
            alarms: status.Alarms || supplementary.Alarm,
          });
          record = {
            ...pvLabel,
            rtuId: pivot.rtuId ?? null,
            name: bsName || (pivot.name ?? null),
            farmId: pivot.farmId ?? null,
            guid: pivot.guid,
            systemStatus: noSignal ? 'No signal' : rawStatus,
            signalStale: noSignal,
            waterMode: status.WaterMode ?? null,
            direction: status.Direction ?? null,
            currentPosition: status.CurrentPosition ?? null,
            percentTimer: status.PercentTimer ?? null,
            pressure: pressure ?? null,
            forwardAngle: status.ForwardAngle ?? null,
            reverseAngle: status.ReverseAngle ?? null,
            statusDate: status.StatusDate ?? null,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          };
        }

        if ((record.name ?? null) !== (pivot.name ?? null)) {
          console.log(`Name changed for RTU ${pivot.rtuId}: "${pivot.name}" -> "${record.name}"`);
        }
        await db.collection('pivots').doc(pivot.guid).set(record, {merge: true});
        results.push({rtu: pivot.rtuId, ok: true});
      } catch (err) {
        console.error(`Failed for ${pivot.name}:`, err.message);
        results.push({rtu: pivot.rtuId, ok: false, error: err.message});
      }
    }

    res.status(200).json({results});
  } catch (err) {
    console.error('Sync failed:', err.message);
    res.status(500).json({error: err.message});
  }
});
