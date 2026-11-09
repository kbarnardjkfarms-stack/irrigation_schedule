// Weekly pivot wet-time log (step 3 of the FieldNET / AIO plan, Nov 2026)
//
// One record per pivot per week, in pivotWetLog/{pivotGuid}_{weekStart}:
//   { pivotGuid, weekStart: 'YYYY-MM-DD' (the Monday), wetHours, dryHours, unknownHours }
//   wet     = running with the water on
//   dry     = running with the water off
//   unknown = no signal from the pivot (never assumed dry, never assumed wet)
// A stopped pivot adds nothing. Weeks run Monday to Sunday in farm time
// (America/Boise), like the irrigation schedule.
//
// pivotWatcher.js calls updateWeeklyLog() every 10 minutes, for every brand
// (BaseStation, FieldNET, later AgSense), so there is ONE method for all of
// them. Each check remembers the pivot's state in pivotWetLogState/{guid}.
// The time since the previous check is credited like this:
//   - up to 20 minutes counts normally: the first half to the state at the
//     previous check, the second half to the state now. (A start or stop lands
//     somewhere in that gap, so splitting it down the middle is right on
//     average. Crediting the whole gap to one side would run high or low on
//     every run.)
//   - anything beyond 20 minutes (the watcher was down) is unknown time.
//   - a gap that crosses Monday midnight is split between the two weeks.
// Only pivots linked to a field are logged.
//
// This does NOT replace the wetHours / dryHours totals on the pivot profile.

const TIME_ZONE = 'America/Boise';
const STALE_DATA_MINUTES = 60;        // same cutoff the stuck-pivot check uses
const MAX_COUNTED_HOURS = 20 / 60;    // same cap as the profile wet/dry hours

const dtf = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE, year: 'numeric', month: 'numeric', day: 'numeric',
  hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23'
});

function localParts(ms) {
  const p = {};
  dtf.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = Number(x.value); });
  return p;
}

function tzOffsetMs(ms) {
  const p = localParts(ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

// The instant of local midnight at the start of a calendar day.
function localMidnightMs(y, m, d) {
  const guess = Date.UTC(y, m - 1, d);
  const first = guess - tzOffsetMs(guess);
  const second = guess - tzOffsetMs(first);
  return second;
}

// 'YYYY-MM-DD' of the Monday of the (farm-time) week this instant falls in.
function weekStartIso(ms) {
  const p = localParts(ms);
  const dow = new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday
  const back = (dow + 6) % 7;
  const monday = new Date(Date.UTC(p.year, p.month - 1, p.day - back));
  return monday.toISOString().slice(0, 10);
}

// The instant the next week starts (next Monday, local midnight).
function nextWeekStartMs(ms) {
  const [y, m, d] = weekStartIso(ms).split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 7));
  return localMidnightMs(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
}

// What the pivot is doing right now, for the log.
function stateOf(pivot, nowMs) {
  const updated = pivot && pivot.updatedAt && typeof pivot.updatedAt.toDate === 'function' ? pivot.updatedAt.toDate() : null;
  if (!updated) return 'unknown';
  if ((nowMs - updated.getTime()) / 60000 > STALE_DATA_MINUTES) return 'unknown';
  if (pivot.systemStatus === 'No signal') return 'unknown';
  if (pivot.systemStatus === 'Running') return pivot.waterMode === 'Dry' ? 'dry' : 'wet';
  return 'idle';
}

// The pieces of time to credit since the previous check, as
// [{ startMs, endMs, state }].
function segmentsSince(prevAtMs, prevState, nowMs, curState) {
  const out = [];
  if (!(nowMs > prevAtMs)) return out;
  const elapsedH = (nowMs - prevAtMs) / 3600000;
  const countedH = Math.min(elapsedH, MAX_COUNTED_HOURS);
  const countedStart = nowMs - countedH * 3600000;
  if (countedStart > prevAtMs) out.push({ startMs: prevAtMs, endMs: countedStart, state: 'unknown' });
  const mid = countedStart + (nowMs - countedStart) / 2;
  out.push({ startMs: countedStart, endMs: mid, state: prevState });
  out.push({ startMs: mid, endMs: nowMs, state: curState });
  return out;
}

// Add the segments up per week: { 'YYYY-MM-DD': { wet, dry, unknown } } in hours.
function addUp(segments) {
  const weeks = {};
  segments.forEach((seg) => {
    if (seg.state !== 'wet' && seg.state !== 'dry' && seg.state !== 'unknown') return; // idle adds nothing
    let start = seg.startMs;
    while (start < seg.endMs) {
      const boundary = nextWeekStartMs(start);
      const end = Math.min(seg.endMs, boundary);
      const wk = weekStartIso(start);
      const hours = (end - start) / 3600000;
      weeks[wk] = weeks[wk] || { wet: 0, dry: 0, unknown: 0 };
      weeks[wk][seg.state] += hours;
      start = end;
    }
  });
  return weeks;
}

const round4 = (n) => Math.round(n * 10000) / 10000;

// pivotDocs: documents of the pivots collection. mappedGuids: Set of pivot ids
// that serve at least one field. FieldValue: admin.firestore.FieldValue.
async function updateWeeklyLog({ db, FieldValue, pivotDocs, mappedGuids, now = new Date() }) {
  const nowMs = now.getTime();
  const stateSnap = await db.collection('pivotWetLogState').get();
  const prevByGuid = {};
  stateSnap.forEach((d) => { prevByGuid[d.id] = d.data(); });

  let batch = db.batch(), ops = 0, logged = 0, started = 0;
  const flush = async () => { if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; } };

  for (const doc of pivotDocs) {
    const guid = doc.id;
    if (!mappedGuids.has(guid)) continue;
    const curState = stateOf(doc.data(), nowMs);
    const prev = prevByGuid[guid];
    const prevAtMs = prev && prev.at ? new Date(prev.at).getTime() : NaN;

    if (prev && !isNaN(prevAtMs) && prev.state) {
      const weeks = addUp(segmentsSince(prevAtMs, prev.state, nowMs, curState));
      Object.entries(weeks).forEach(([wk, h]) => {
        const data = { pivotGuid: guid, weekStart: wk, updatedAt: FieldValue.serverTimestamp() };
        if (h.wet > 0) data.wetHours = FieldValue.increment(round4(h.wet));
        if (h.dry > 0) data.dryHours = FieldValue.increment(round4(h.dry));
        if (h.unknown > 0) data.unknownHours = FieldValue.increment(round4(h.unknown));
        batch.set(db.collection('pivotWetLog').doc(`${guid}_${wk}`), data, { merge: true });
        ops++; logged++;
      });
    } else {
      started++;
    }
    batch.set(db.collection('pivotWetLogState').doc(guid), { at: now.toISOString(), state: curState });
    ops++;
    if (ops >= 400) await flush();
  }
  await flush();
  return { logged, started };
}

module.exports = { updateWeeklyLog, _test: { weekStartIso, nextWeekStartMs, stateOf, segmentsSince, addUp, localMidnightMs } };
