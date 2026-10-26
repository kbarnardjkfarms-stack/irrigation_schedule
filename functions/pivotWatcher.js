// Pivot watcher — stuck-pivot alerts (with Twilio texts), lap-time audit, and
// wet/dry hours. Lives in its own file on purpose: it was originally part of
// index.js and got wiped out when an older copy of index.js was pasted over
// it. Kept separate, edits to index.js can't silently erase it again.
//
// index.js pulls the two exported functions in with three lines at the very
// bottom of that file.
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');

// ---- Stuck-pivot watcher -----------------------------------------------
// Runs every 10 minutes. Catches the "last tower gets stuck while running
// wet, the overwatering timer fails to shut it off, and it just parks wet
// until someone notices" failure mode: if a pivot's angle position hasn't
// moved at all while it's reporting as running wet, for longer than that
// pivot's own configured threshold (pivotProfiles/{guid}
// .stuckAlertThresholdMinutes — 45 to 120 min, default 60 — set on the
// Pivot Profile page), it gets flagged (the red badge on the pivot icon,
// everywhere PivotIcon renders) and texted to whoever should know about
// that farm.
//
// This same 10-minute pass also drives the lap-time audit AND (as of this
// version) wet/dry hours tracking — see the comment above the wet/dry
// block below for details on that one.
//
// Set these once with:
//   firebase functions:secrets:set TWILIO_ACCOUNT_SID
//   firebase functions:secrets:set TWILIO_AUTH_TOKEN
//   firebase functions:secrets:set TWILIO_FROM_NUMBER
const TWILIO_ACCOUNT_SID = defineSecret('TWILIO_ACCOUNT_SID');
const TWILIO_AUTH_TOKEN = defineSecret('TWILIO_AUTH_TOKEN');
const TWILIO_FROM_NUMBER = defineSecret('TWILIO_FROM_NUMBER');

// How far the angle has to move to count as "not stuck" — small enough to
// catch a real stall quickly, comfortably larger than sensor jitter. Even
// a pivot slowed way down (5% timer) still covers a few degrees in 10
// minutes per the Valley percent-timer chart, so this stays conservative.
const STUCK_POSITION_EPSILON_DEG = 0.5;
// If BaseStation3 hasn't synced a pivot's data within this long, skip it
// this cycle rather than risk mistaking a sync/connectivity gap for a
// genuinely stuck pivot.
const STALE_DATA_CUTOFF_MINUTES = 60;
const DEFAULT_STUCK_THRESHOLD_MINUTES = 60;
const MIN_STUCK_THRESHOLD_MINUTES = 45;

// Wet/dry hours: if a scheduled run gets delayed or one gets skipped
// outright, don't let the resulting gap get fully credited to whichever
// state (wet or dry) the pivot happens to be in when the next run finally
// catches up — cap how much elapsed time any single tick can add to
// double the normal 10-minute cadence.
const WET_DRY_MAX_TICK_HOURS = 20 / 60;

// Twilio only accepts E.164 numbers (+12085550123). Phones are typed in free
// text on the Team page ("(208) 555-0123"), so clean them up here. Returns
// null when it can't be made into a valid US number, so a bad number is
// skipped instead of failing at Twilio.
function normalizePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// Only people who deliberately ticked the text-alert box on the Team page
// (and have a usable phone number) ever get texted.
function optedInTextUsers(users) {
  return users
    .filter((u) => u.receiveTextAlerts === true)
    .map((u) => ({ ...u, e164: normalizePhone(u.phone) }))
    .filter((u) => u.e164);
}

function maskPhone(e164) {
  return `***-***-${e164.slice(-4)}`;
}

async function sendSms(to, body, accountSid, authToken, fromNumber) {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`;
  const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const params = new URLSearchParams({ To: to, From: fromNumber, Body: body });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Twilio send failed (${res.status}): ${text}`);
  }
}

// Total degrees a pivot travels in one lap — 360 for a full-circle
// machine, or the arc between its reverse/forward stops for a
// wiper/sector pivot. Mirrors the exact same full-circle detection used
// in PivotIcon.jsx (equal reverse/forward angle means "goes all the way
// around," not "no data").
function computeArcDegrees(pivot) {
  const rev = Number(pivot.reverseAngle) || 0;
  const fwd = Number(pivot.forwardAngle) || 0;
  if (rev === fwd) return 360;
  let diff = fwd - rev;
  if (diff < 0) diff += 360;
  return diff;
}

async function checkStuckPivotsOnce(accountSid, authToken, fromNumber) {
  const db = admin.firestore();
  const now = new Date();

  const [pivotsSnap, profilesSnap, mappingSnap, fieldsSnap, usersSnap, seasonsSnap] = await Promise.all([
    db.collection('pivots').get(),
    db.collection('pivotProfiles').get(),
    db.collection('pivotFieldMapping').get(),
    db.collection('fields').get(),
    db.collection('users').get(),
    db.collection('seasons').get()
  ]);

  const profileByGuid = {};
  profilesSnap.forEach((d) => { profileByGuid[d.id] = d.data(); });

  const farmIdByFieldId = {};
  fieldsSnap.forEach((d) => { farmIdByFieldId[d.id] = d.data().farmId; });

  // A pivot can serve more than one field (Mietzner Middle already does),
  // so this is guid -> array of fieldIds, not a single one. Guarded
  // against duplicates on purpose — a leftover mapping doc from before
  // pivotFieldMapping was rekeyed from pivotGuid to fieldId (old docs
  // weren't always cleaned up) could otherwise list the same field twice
  // and silently double a pivot's acreage total below.
  const fieldIdsByPivotGuid = {};
  mappingSnap.forEach((d) => {
    const { fieldId, pivotGuid } = d.data();
    if (!pivotGuid || !fieldId) return;
    if (!fieldIdsByPivotGuid[pivotGuid]) fieldIdsByPivotGuid[pivotGuid] = [];
    if (!fieldIdsByPivotGuid[pivotGuid].includes(fieldId)) fieldIdsByPivotGuid[pivotGuid].push(fieldId);
  });

  const users = [];
  usersSnap.forEach((d) => users.push({ uid: d.id, ...d.data() }));

  // Current season, same "match the calendar year, fall back to latest
  // start date" logic the app itself uses — needed to know which season a
  // freshly-qualifying baseline audit belongs to, and to size the
  // baseline requirement (a pivot's combined acreage across every field
  // it serves, this season).
  const seasonsList = [];
  seasonsSnap.forEach((d) => seasonsList.push({ id: d.id, ...d.data() }));
  seasonsList.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''));
  const currentYear = String(now.getFullYear());
  const currentSeasonDoc = seasonsList.find((s) => String(s.name) === currentYear);
  const currentSeasonId = currentSeasonDoc ? currentSeasonDoc.id : (seasonsList[0] ? seasonsList[0].id : null);

  const acresByPivotGuid = {};
  if (currentSeasonId) {
    const seasonDocsSnap = await db.collectionGroup('seasons').where('seasonId', '==', currentSeasonId).get();
    const acresByFieldId = {};
    seasonDocsSnap.forEach((d) => {
      const fieldId = d.ref.parent.parent.id;
      acresByFieldId[fieldId] = d.data().acres || 0;
    });
    Object.entries(fieldIdsByPivotGuid).forEach(([guid, fieldIds]) => {
      acresByPivotGuid[guid] = fieldIds.reduce((sum, fid) => sum + (acresByFieldId[fid] || 0), 0);
    });
  }

  let checked = 0, flagged = 0, texted = 0, auditsUpdated = 0;

  for (const pivotDoc of pivotsSnap.docs) {
    const guid = pivotDoc.id;
    const pivot = pivotDoc.data();
    const profile = profileByGuid[guid] || {};

    // updatedAt is a real Firestore Timestamp written by the sync service
    // itself (unlike statusDate, which is just whatever raw string format
    // BaseStation3 hands back) — much more reliable to compute a "how
    // fresh is this" check against.
    const lastSynced = pivot.updatedAt && typeof pivot.updatedAt.toDate === 'function' ? pivot.updatedAt.toDate() : null;
    if (!lastSynced) continue;
    const dataAgeMinutes = (now.getTime() - lastSynced.getTime()) / 60000;
    if (dataAgeMinutes > STALE_DATA_CUTOFF_MINUTES) continue;

    checked++;

    const updates = {};
    let sendStuckText = false;

    // ---- Stuck-pivot check (running wet only) --------------------------
    const isRunningWet = pivot.systemStatus === 'Running' && pivot.waterMode !== 'Dry';
    const position = Number(pivot.currentPosition);
    const stuckThreshold = Math.max(MIN_STUCK_THRESHOLD_MINUTES, profile.stuckAlertThresholdMinutes || DEFAULT_STUCK_THRESHOLD_MINUTES);

    if (!isRunningWet || isNaN(position)) {
      if (profile.stuckAlertActive || profile.lastKnownPosition != null) {
        updates.lastKnownPosition = null;
        updates.positionUnchangedSince = now.toISOString();
        updates.stuckAlertActive = false;
      }
    } else {
      const hasMoved = profile.lastKnownPosition == null
        || Math.abs(position - profile.lastKnownPosition) > STUCK_POSITION_EPSILON_DEG;

      if (hasMoved) {
        updates.lastKnownPosition = position;
        updates.positionUnchangedSince = now.toISOString();
        updates.stuckAlertActive = false;
      } else {
        const unchangedSince = profile.positionUnchangedSince ? new Date(profile.positionUnchangedSince) : now;
        const minutesUnchanged = (now.getTime() - unchangedSince.getTime()) / 60000;
        if (minutesUnchanged >= stuckThreshold) {
          const lastSent = profile.stuckAlertLastSentAt ? new Date(profile.stuckAlertLastSentAt) : null;
          const minutesSinceLastSent = lastSent ? (now.getTime() - lastSent.getTime()) / 60000 : Infinity;
          if (!profile.stuckAlertActive && minutesSinceLastSent >= stuckThreshold) {
            flagged++;
            updates.stuckAlertActive = true;
            updates.stuckAlertLastSentAt = now.toISOString();
            updates.stuckAlertClearedAt = admin.firestore.FieldValue.delete();
            sendStuckText = true;
          }
        }
      }
    }

    // ---- Lap-time audit (running at all, wet or dry — rotation speed --
    // ---- doesn't care whether water's on) ------------------------------
    const isRunningAtAll = pivot.systemStatus === 'Running';
    const direction = pivot.direction;
    const percentTimer = Number(pivot.percentTimer);
    const episode = profile.auditEpisode;

    if (!isRunningAtAll || isNaN(position) || isNaN(percentTimer) || !direction) {
      if (episode) {
        updates.auditEpisode = admin.firestore.FieldValue.delete();
        updates.currentLapTimeIsLive = false;
      }
    } else {
      const episodeMatches = episode && episode.direction === direction && episode.percentTimer === percentTimer;

      if (!episodeMatches) {
        // Direction or speed changed (or there was no episode at all) —
        // start fresh. If the old episode had already produced a
        // qualifying result, that number just freezes in place as "last
        // known" rather than being touched here.
        if (episode) updates.currentLapTimeIsLive = false;
        updates.auditEpisode = {
          startedAt: now.toISOString(),
          direction,
          percentTimer,
          totalArcDegrees: computeArcDegrees(pivot),
          lastCheckedAt: now.toISOString(),
          lastCheckedPosition: position,
          accumulatedDegrees: 0
        };
      } else {
        const delta = direction === 'Forward'
          ? ((position - episode.lastCheckedPosition) + 360) % 360
          : ((episode.lastCheckedPosition - position) + 360) % 360;
        const accumulatedDegrees = (episode.accumulatedDegrees || 0) + delta;
        const elapsedHours = (now.getTime() - new Date(episode.startedAt).getTime()) / 3600000;

        updates.auditEpisode = { ...episode, lastCheckedAt: now.toISOString(), lastCheckedPosition: position, accumulatedDegrees };

        if (elapsedHours >= 3 && accumulatedDegrees > 0) {
          const degreesPerHour = accumulatedDegrees / elapsedHours;
          const lapTimeAtSpeed = episode.totalArcDegrees / degreesPerHour;
          const lapTimeAt100 = lapTimeAtSpeed * (percentTimer / 100);
          const lapTimeRounded = Math.round(lapTimeAt100 * 10) / 10;

          updates.currentLapTimeHours = lapTimeRounded;
          updates.currentLapTimeUpdatedAt = now.toISOString();
          updates.currentLapTimeIsLive = true;
          auditsUpdated++;

          const acres = acresByPivotGuid[guid] || 0;
          const requiredHours = acres > 30 ? 24 : 12;
          const baselines = profile.seasonBaselines || {};

          if (currentSeasonId && elapsedHours >= requiredHours && !baselines[currentSeasonId]) {
            updates.seasonBaselines = {
              ...baselines,
              [currentSeasonId]: {
                lapTimeHours: lapTimeRounded,
                completedAt: now.toISOString(),
                percentTimerAtMeasurement: percentTimer,
                acres,
                requiredHours
              }
            };
          }

          const baselineForDrift = currentSeasonId
            ? ((updates.seasonBaselines && updates.seasonBaselines[currentSeasonId]) || baselines[currentSeasonId])
            : null;
          updates.lapTimeDriftFlagged = baselineForDrift
            ? Math.abs(lapTimeRounded - baselineForDrift.lapTimeHours) / baselineForDrift.lapTimeHours > 0.10
            : false;
        }
      }
    }

    // ---- Wet/dry hours (running only) -----------------------------------
    // Wet hours = running with water on. Dry hours = running with water
    // off. A stopped pivot (regardless of the water valve's position)
    // counts toward neither — this is about how the pivot's actual
    // runtime split between productive and wasted-dry, not about total
    // elapsed time. Reuses isRunningWet/isRunningAtAll from the checks
    // above rather than re-deriving them.
    //
    // Elapsed time is computed from a stored checkpoint
    // (wetDryLastCheckedAt) rather than assuming a flat 10 minutes per
    // tick, so a delayed or skipped run doesn't quietly throw the totals
    // off — and WET_DRY_MAX_TICK_HOURS caps any single tick's
    // contribution so a longer gap (a paused function, a rough outage)
    // doesn't get fully credited to one bucket. The checkpoint is cleared
    // whenever the pivot isn't running, so the moment it stops counts
    // toward neither bucket, and the moment it starts again begins a
    // fresh clock rather than attributing the stopped gap to whatever
    // state it resumes in.
    const isRunningDry = isRunningAtAll && !isRunningWet;

    if (isRunningWet || isRunningDry) {
      const lastCheckedAt = profile.wetDryLastCheckedAt ? new Date(profile.wetDryLastCheckedAt) : null;
      if (lastCheckedAt) {
        const elapsedHours = Math.min((now.getTime() - lastCheckedAt.getTime()) / 3600000, WET_DRY_MAX_TICK_HOURS);
        if (elapsedHours > 0) {
          if (isRunningWet) {
            updates.wetHours = Math.round(((profile.wetHours || 0) + elapsedHours) * 100) / 100;
          } else {
            updates.dryHours = Math.round(((profile.dryHours || 0) + elapsedHours) * 100) / 100;
          }
        }
      }
      if (!profile.wetDryTrackingSince) {
        updates.wetDryTrackingSince = now.toISOString();
      }
      updates.wetDryLastCheckedAt = now.toISOString();
    } else if (profile.wetDryLastCheckedAt) {
      updates.wetDryLastCheckedAt = admin.firestore.FieldValue.delete();
    }

    if (Object.keys(updates).length > 0) {
      await db.collection('pivotProfiles').doc(guid).set(updates, { merge: true });
    }

    if (!sendStuckText) continue;

    const fieldIds = fieldIdsByPivotGuid[guid] || [];
    const farmIds = [...new Set(fieldIds.map((fid) => farmIdByFieldId[fid]).filter((f) => f != null).map(String))];

    const recipients = optedInTextUsers(users).filter((u) => {
      if (u.role === 'admin' || u.role === 'owner') return true;
      if ((u.role === 'farm_manager' || u.role === 'irrigation_manager') && Array.isArray(u.farmIds)) {
        return u.farmIds.some((fid) => farmIds.includes(String(fid)));
      }
      return false;
    });

    const pivotName = pivot.name || guid;
    const message = `AIO alert: ${pivotName} may be parked wet \u2014 no movement for over ${stuckThreshold} min while running. Check it out.`;

    for (const recipient of recipients) {
      try {
        await sendSms(recipient.e164, message, accountSid, authToken, fromNumber);
        texted++;
      } catch (err) {
        console.error(`Failed to text ${recipient.email || recipient.uid} about pivot ${guid}:`, err.message);
      }
    }

    if (recipients.length === 0) {
      console.warn(`Pivot ${guid} (${pivotName}) flagged stuck, but nobody is set up to receive a text for its farm(s): ${farmIds.join(', ') || 'none resolved'}.`);
    }
  }

  return { checked, flagged, texted, auditsUpdated };
}

exports.checkStuckPivots = onSchedule(
  {
    schedule: 'every 10 minutes',
    secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER],
    timeoutSeconds: 120,
    memory: '256MiB'
  },
  async () => {
    try {
      const result = await checkStuckPivotsOnce(
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value(),
        TWILIO_FROM_NUMBER.value()
      );
      console.log(`Pivot check: ${result.checked} checked, ${result.flagged} newly flagged stuck, ${result.texted} text(s) sent, ${result.auditsUpdated} lap-time audit(s) updated.`);
    } catch (err) {
      console.error('Stuck-pivot check failed:', err);
    }
  }
);

// Manual trigger for testing right after deploy, without waiting for the
// next scheduled run.
//
//   .../checkStuckPivotsNow                    -> runs one normal watcher pass
//   .../checkStuckPivotsNow?testText=1         -> lists who is opted in (numbers
//                                                 masked); sends nothing
//   .../checkStuckPivotsNow?testText=1&to=NUMBER
//                                              -> sends one fixed test text, but
//                                                 only if NUMBER belongs to a
//                                                 team member who opted in
//
// A test text never goes to an arbitrary number, never carries custom text,
// and each number can only be tested once every 5 minutes.
const TEST_TEXT_MESSAGE = 'AIO test: text alerts are working. You are receiving this because text alerts are turned on for your account. Reply STOP to opt out.';
const TEST_TEXT_COOLDOWN_MS = 5 * 60 * 1000;

exports.checkStuckPivotsNow = onRequest(
  { secrets: [TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER], timeoutSeconds: 120, memory: '256MiB' },
  async (req, res) => {
    try {
      if (req.query.testText) {
        const db = admin.firestore();
        const usersSnap = await db.collection('users').get();
        const users = [];
        usersSnap.forEach((d) => users.push({ uid: d.id, ...d.data() }));
        const optedIn = optedInTextUsers(users);

        if (!req.query.to) {
          if (optedIn.length === 0) {
            res.status(200).send('Nobody is opted in to text alerts with a valid phone number yet. Tick the box on the Team page and save.');
            return;
          }
          res.status(200).send(
            `Opted in (${optedIn.length}):\n` +
            optedIn.map((u) => `- ${u.name || u.email || u.uid} (${u.role}) ${maskPhone(u.e164)}`).join('\n') +
            '\n\nTo send a test, add &to=PHONENUMBER to the address.'
          );
          return;
        }

        const target = normalizePhone(req.query.to);
        const match = target && optedIn.find((u) => u.e164 === target);
        if (!match) {
          res.status(403).send('That number does not belong to a team member who is opted in to text alerts. Nothing sent.');
          return;
        }

        const logRef = db.collection('smsTestLog').doc(target.replace('+', ''));
        const logSnap = await logRef.get();
        const lastAt = logSnap.exists ? logSnap.data().lastTestAt : 0;
        if (Date.now() - lastAt < TEST_TEXT_COOLDOWN_MS) {
          res.status(429).send('A test text was sent to that number less than 5 minutes ago. Wait a few minutes and try again.');
          return;
        }
        await logRef.set({ lastTestAt: Date.now() });

        await sendSms(target, TEST_TEXT_MESSAGE, TWILIO_ACCOUNT_SID.value(), TWILIO_AUTH_TOKEN.value(), TWILIO_FROM_NUMBER.value());
        res.status(200).send(`Test text sent to ${match.name || match.email || match.uid} (${maskPhone(target)}).`);
        return;
      }

      const result = await checkStuckPivotsOnce(
        TWILIO_ACCOUNT_SID.value(),
        TWILIO_AUTH_TOKEN.value(),
        TWILIO_FROM_NUMBER.value()
      );
      res.status(200).send(`Checked ${result.checked} pivot(s), flagged ${result.flagged} new, sent ${result.texted} text(s), updated ${result.auditsUpdated} lap-time audit(s).`);
    } catch (err) {
      console.error(err);
      res.status(500).send(err.message);
    }
  }
);
