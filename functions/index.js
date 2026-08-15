const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
admin.initializeApp();

// The token lives here, as a Firebase secret — never in client code.
// Set it once with: firebase functions:secrets:set AGWORLD_API_TOKEN
const AGWORLD_TOKEN = defineSecret('AGWORLD_API_TOKEN');

// Change this to match your Agworld region if you're not on the US instance:
// Australia - https://my.agworld.com.au
// New Zealand - https://nz.agworld.co
const AGWORLD_BASE_URL = 'https://us.agworld.co';

// Optional: set this to only pull fields for a specific farm, if your
// Agworld account covers more than just this operation.
// const FARM_ID_FILTER = '123456';

// These AgWorld "farms" aren't real JKF farms — they're housekeeping
// buckets (archived/no-longer-farmed fields, subleased ground, and a
// separate line of the operation) that shouldn't show up in the
// irrigation program. Fields under these farm IDs are skipped on sync,
// and any that were already synced in previously get cleaned up
// automatically the next time this runs (as a natural side effect of the
// general stale-field cleanup below, since excluded-farm fields never
// appear in the current valid set either).
const EXCLUDED_FARM_IDS = new Set(['175660', '211414', '219606']);
// 175660 = SUBLEASED AND ROTATION LEASE FIELDS
// 211414 = TETON TREES
// 219606 = ZARCHIVE

// Agworld returns measurements as strings with units attached, e.g.
// "34 acre" or "50 ha" — not plain numbers. This normalizes to acres
// regardless of which unit your Agworld instance/region uses.
function parseAreaToAcres(areaString) {
  if (!areaString) return null;
  const match = String(areaString).match(/^([\d.]+)\s*(\w+)/);
  if (!match) return null;
  const value = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith('ha')) return value * 2.47105;
  return value; // already acres
}

async function agworldGet(path, params, token) {
  const url = `${AGWORLD_BASE_URL}${path}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
      'Api-Token': token
    }
  });
  if (!res.ok) throw new Error(`Agworld API error ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Only sync seasons from this year onward — older seasons are historical
// noise the irrigation program doesn't need. Raise this in a future year
// only if you actually want to re-pull older history; otherwise leave it.
const MIN_SEASON_YEAR = 2026;

// Pulls every season on the account from MIN_SEASON_YEAR onward (not just
// the most recent one). A diversified operation typically has several
// seasons active at once — e.g. a row-crop rotation season and a separate
// pasture/lease season — so we can't assume "most recent" covers every
// field, but we also don't need seasons from before the program started.
async function fetchAllSeasons(token) {
  const params = new URLSearchParams({ 'page[size]': '100' });
  const json = await agworldGet('/user_api/v1/seasons', params, token);
  return json.data
    .map((s) => ({
      id: s.id,
      name: s.attributes.name || s.id,
      startDate: s.attributes.season_start_date || null,
      endDate: s.attributes.season_end_date || null
    }))
    .filter((s) => {
      // Keep seasons with no date info rather than silently dropping them —
      // better to sync something unexpected than to lose an active season.
      const dateToCheck = s.startDate || s.endDate;
      if (!dateToCheck) return true;
      const year = parseInt(dateToCheck.slice(0, 4), 10);
      return Number.isNaN(year) || year >= MIN_SEASON_YEAR;
    });
}

// Fetches every field for a single season_id, paginated. Farm names are
// sideloaded via include=farm and returned separately so we only need to
// fetch that list once per sync, not once per season.
async function fetchFieldsForSeason(seasonId, token) {
  const fields = [];
  const farmsById = {};
  let page = 1;
  const pageSize = 100;
  while (true) {
    const params = new URLSearchParams({
      'page[number]': String(page),
      'page[size]': String(pageSize),
      season_id: seasonId,
      include: 'farm'
    });
    // if (typeof FARM_ID_FILTER !== 'undefined') params.set('filter[farm_id]', FARM_ID_FILTER);
    const json = await agworldGet('/user_api/v1/fields', params, token);
    fields.push(...json.data);
    (json.included || []).forEach((rec) => {
      if (rec.type === 'farms') {
        farmsById[rec.id] = rec.attributes.name;
      }
    });
    if (!json.data.length || json.data.length < pageSize) break;
    page++;
  }
  return { fields, farmsById };
}

async function syncFields() {
  const token = AGWORLD_TOKEN.value();
  const db = admin.firestore();
  const seasons = await fetchAllSeasons(token);

  // Write the season list first so the app's year/season dropdown always
  // has something to render, even if a later step fails partway through.
  const seasonsBatch = db.batch();
  seasons.forEach((s) => {
    const ref = db.collection('seasons').doc(String(s.id));
    seasonsBatch.set(
      ref,
      {
        agworldId: s.id,
        name: s.name,
        startDate: s.startDate,
        endDate: s.endDate
      },
      { merge: true }
    );
  });
  await seasonsBatch.commit();

  const allFarmsById = {};
  const fieldNamesById = {}; // field id -> { name, farmId }
  const skippedFieldIds = new Set(); // distinct fields skipped, across all seasons
  let totalFieldSeasonDocs = 0;

  // Fetch every season's fields one season at a time to keep each batch
  // small and to avoid one bad season response taking down the whole sync.
  for (const season of seasons) {
    let fields, farmsById;
    try {
      ({ fields, farmsById } = await fetchFieldsForSeason(season.id, token));
    } catch (err) {
      console.error(`Skipping season ${season.id} (${season.name}): ${err.message}`);
      continue;
    }
    Object.assign(allFarmsById, farmsById);

    // Firestore batches cap at 500 writes; chunk defensively.
    for (let i = 0; i < fields.length; i += 400) {
      const chunk = fields.slice(i, i + 400);
      const batch = db.batch();
      chunk.forEach((f) => {
        if (EXCLUDED_FARM_IDS.has(String(f.attributes.farm_id))) {
          skippedFieldIds.add(f.id);
          return; // skip fields under junk farms
        }
        fieldNamesById[f.id] = {
          name: f.attributes.name,
          farmId: f.attributes.farm_id
        };
        // crops comes back as an array (a field can carry more than one
        // crop or blend for a given season) — take the primary entry
        // rather than assuming there's only one.
        const crops = f.attributes.crops || [];
        const primaryCrop = crops.find((c) => c.crop_blend === 'primary') || crops[0] || null;
        // Per-season crop/acreage data lives in a subcollection keyed by
        // season id, so the app can switch years without losing history.
        const seasonRef = db
          .collection('fields')
          .doc(String(f.id))
          .collection('seasons')
          .doc(String(season.id));
        batch.set(
          seasonRef,
          {
            seasonId: season.id,
            seasonName: season.name,
            cropName: primaryCrop ? primaryCrop.crop_name : null,
            varietyName: primaryCrop ? primaryCrop.variety_name : null,
            cropUse: primaryCrop ? primaryCrop.crop_use : null,
            // planting_date lives on the field's own attributes, not
            // nested inside the crop object - confirmed via Agworld's docs
            // showing it as a sibling of area/irrigation/cropping_method
            // on this exact endpoint, and via a debug log against field
            // "27A" showing primaryCrop has no date field at all.
            plantDate: f.attributes.planting_date || f.attributes.plant_date || null,
            acres: parseAreaToAcres(f.attributes.area),
            irrigationMethod: f.attributes.irrigation || null,
            croppingMethod: f.attributes.cropping_method || null,
            syncedFromAgworldAt: admin.firestore.FieldValue.serverTimestamp()
          },
          { merge: true }
        );
        totalFieldSeasonDocs++;
      });
      await batch.commit();
    }
  }

  // Now write the season-independent field/farm records: name, farm,
  // etc. — the things that don't change per season. merge: true keeps
  // any app-owned fields (GPM, ditch rider, diversion point, etc.)
  // untouched, since Agworld has no concept of those.
  const farmsBatch = db.batch();
  Object.entries(allFarmsById).forEach(([farmId, farmName]) => {
    if (EXCLUDED_FARM_IDS.has(String(farmId))) return; // skip junk farms
    const ref = db.collection('farms').doc(String(farmId));
    farmsBatch.set(ref, { agworldId: farmId, name: farmName }, { merge: true });
  });
  await farmsBatch.commit();

  const fieldIds = Object.keys(fieldNamesById);
  for (let i = 0; i < fieldIds.length; i += 400) {
    const chunkIds = fieldIds.slice(i, i + 400);
    const batch = db.batch();
    chunkIds.forEach((fieldId) => {
      const { name, farmId } = fieldNamesById[fieldId];
      const ref = db.collection('fields').doc(String(fieldId));
      batch.set(
        ref,
        {
          agworldId: fieldId,
          name,
          farmId,
          farmName: allFarmsById[farmId] || null,
          syncedFromAgworldAt: admin.firestore.FieldValue.serverTimestamp()
        },
        { merge: true }
      );
    });
    await batch.commit();
  }

  // General staleness cleanup: remove any field from Firestore that Agworld
  // did NOT return anywhere in this sync — across every currently-synced
  // season, for any reason. This covers a field being deleted outright,
  // but also the case that actually bit us: a field getting split into new
  // per-pivot fields in Agworld (e.g. "CELLAR" -> "CELLAR BIG" +
  // "CELLAR MINI"). The old field simply stops appearing in Agworld's
  // results — it's never explicitly "deleted" from Agworld's point of
  // view — so without this check it would sit in Firestore forever. This
  // also covers the excluded-farm cleanup as a subset, since fields under
  // EXCLUDED_FARM_IDS never make it into fieldNamesById either. Once
  // cleaned up, this finds nothing on every future run until the next
  // real change in Agworld.
  const currentFieldIds = new Set(fieldIds);
  const allFieldDocsSnap = await db.collection('fields').get();
  const staleFieldDocs = allFieldDocsSnap.docs.filter((doc) => !currentFieldIds.has(doc.id));

  if (staleFieldDocs.length) {
    for (const fieldDoc of staleFieldDocs) {
      const seasonDocsSnap = await fieldDoc.ref.collection('seasons').get();
      if (!seasonDocsSnap.empty) {
        const seasonCleanupBatch = db.batch();
        seasonDocsSnap.forEach((doc) => seasonCleanupBatch.delete(doc.ref));
        await seasonCleanupBatch.commit();
      }
    }
    for (let i = 0; i < staleFieldDocs.length; i += 400) {
      const chunk = staleFieldDocs.slice(i, i + 400);
      const batch = db.batch();
      chunk.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
    }
  }

  // Separately clean up farm docs for the excluded farm IDs, in case any
  // were sitting in Firestore from before this exclusion existed. Farms
  // aren't part of the field-diffing logic above since a farm can validly
  // have zero currently-synced fields without being stale itself.
  const excludedFarmCleanupBatch = db.batch();
  EXCLUDED_FARM_IDS.forEach((id) => excludedFarmCleanupBatch.delete(db.collection('farms').doc(id)));
  await excludedFarmCleanupBatch.commit();

  return {
    fieldCount: fieldIds.length,
    seasonCount: seasons.length,
    fieldSeasonRecords: totalFieldSeasonDocs,
    skippedFieldCount: skippedFieldIds.size,
    staleFieldsRemoved: staleFieldDocs.length
  };
}

// Runs automatically every morning so the field list stays current
// without anyone having to remember to sync it.
exports.syncAgworldFields = onSchedule(
  {
    schedule: 'every day 05:00',
    timeZone: 'America/Denver',
    secrets: [AGWORLD_TOKEN],
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const result = await syncFields();
    console.log(
      `Synced ${result.fieldCount} fields across ${result.seasonCount} seasons (${result.fieldSeasonRecords} field-season records, skipped ${result.skippedFieldCount} fields from excluded farms, removed ${result.staleFieldsRemoved} stale fields).`
    );
  }
);

// A manual trigger, useful for testing right after deploy or forcing an
// on-demand refresh. Visiting this URL in a browser (once deployed) runs
// the same sync immediately.
exports.syncAgworldFieldsNow = onRequest(
  { secrets: [AGWORLD_TOKEN], timeoutSeconds: 540, memory: '512MiB' },
  async (req, res) => {
    try {
      const result = await syncFields();
      res.status(200).send(
        `Synced ${result.fieldCount} fields across ${result.seasonCount} seasons (${result.fieldSeasonRecords} field-season records, skipped ${result.skippedFieldCount} fields from excluded farms, removed ${result.staleFieldsRemoved} stale fields).`
      );
    } catch (err) {
      console.error(err);
      res.status(500).send(err.message);
    }
  }
);

// ChirpStack -> Firestore webhook
//
// Receives uplink events from ChirpStack's HTTP integration and writes
// sensor readings into Firestore. No secret required — this is a one-way
// inbound webhook, not calling out to any third-party API.
//
// Once deployed, paste this service's URL into: ChirpStack -> Applications
// -> (the app, e.g. "JKF Pulse Counters") -> Integrations -> HTTP ->
// "Event endpoint URL(s)".
exports.chirpstackWebhook = onRequest(async (req, res) => {
  try {
    const eventType = req.query.event;
    if (eventType !== 'up') {
      res.status(200).send(`Ignored event type: ${eventType}`);
      return;
    }
    const body = req.body || {};
    const deviceInfo = body.deviceInfo || {};
    const deviceName = deviceInfo.deviceName || deviceInfo.devEui || 'unknown-device';
    const devEui = deviceInfo.devEui || null;
    const rx = (body.rxInfo && body.rxInfo[0]) || {};
    const rssi = rx.rssi ?? null;
    const snr = rx.snr ?? rx.loRaSnr ?? null;
    const reading = {
      time: body.time || new Date().toISOString(),
      devEui,
      deviceName,
      fCnt: body.fCnt ?? null,
      fPort: body.fPort ?? null,
      decoded: body.object || {},
      rssi,
      snr
    };
    const db = admin.firestore();
    const deviceRef = db.collection('devices').doc(deviceName);
    await deviceRef.set(
      {
        devEui,
        lastSeen: admin.firestore.FieldValue.serverTimestamp(),
        latest: reading
      },
      { merge: true }
    );
    await deviceRef.collection('readings').add(reading);
    res.status(200).send('OK');
  } catch (err) {
    console.error('chirpstackWebhook error:', err);
    res.status(500).send('Error processing webhook');
  }
});

const VALID_ROLES = ['admin', 'owner', 'farm_manager', 'irrigation_manager', 'irrigator'];
const FARM_SCOPED_ROLES = ['farm_manager', 'irrigation_manager', 'irrigator'];

// Confirms the calling user's own Firestore profile says admin or owner.
// Used by both functions below instead of trusting anything the client
// sends about its own permissions.
async function requireAdminOrOwner(auth) {
  if (!auth) {
    throw new HttpsError('unauthenticated', 'Sign in required.');
  }
  const snap = await admin.firestore().doc(`users/${auth.uid}`).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'admin' && role !== 'owner') {
    throw new HttpsError('permission-denied', 'Only an Admin or Owner can manage team members.');
  }
}

// Creates a team member's login and their permissions profile together.
// Done server-side (Admin SDK) on purpose: the client SDK's own
// "create account" call automatically signs the browser into the new
// account, which would otherwise kick the admin out of their own session
// mid-task. After this returns, the app sends a normal Firebase
// "reset password" email from the client — that doubles as this person's
// first-time "set your password" link, no separate email service needed.
exports.createUser = onCall(async (request) => {
  await requireAdminOrOwner(request.auth);

  const { name, email, role, farmIds, canEditSchedule } = request.data || {};
  if (!name || !email || !role) {
    throw new HttpsError('invalid-argument', 'Name, email, and role are required.');
  }
  if (!VALID_ROLES.includes(role)) {
    throw new HttpsError('invalid-argument', 'Unrecognized role.');
  }
  if (FARM_SCOPED_ROLES.includes(role) && (!Array.isArray(farmIds) || farmIds.length === 0)) {
    throw new HttpsError('invalid-argument', 'At least one assigned farm is required for this role.');
  }

  let userRecord;
  try {
    userRecord = await admin.auth().createUser({ email, displayName: name });
  } catch (err) {
    if (err.code === 'auth/email-already-exists') {
      throw new HttpsError('already-exists', 'Someone with this email already has an account.');
    }
    throw new HttpsError('internal', err.message);
  }

  const profile = { name, email, role };
  if (FARM_SCOPED_ROLES.includes(role)) {
    profile.farmIds = farmIds.map(String);
  }
  if (role === 'irrigator') {
    profile.canEditSchedule = !!canEditSchedule;
  }

  try {
    await admin.firestore().doc(`users/${userRecord.uid}`).set(profile);
  } catch (err) {
    // Don't leave an orphaned Auth account with no matching profile doc —
    // that's exactly the silent-revert failure mode already seen once
    // with a manually-created account (see project notes on Kent's login).
    await admin.auth().deleteUser(userRecord.uid);
    throw new HttpsError('internal', 'Could not save the profile — account creation rolled back.');
  }

  // Hand back a one-time setup link alongside the account. Firebase's own
  // auto-email to corporate inboxes (M365/Workspace) often lands in junk
  // since it comes from Firebase's shared sending domain, not jkfarms.com —
  // this link is the fallback: paste it into a text or an email from your
  // own address instead of relying on the automated one.
  let link = null;
  try {
    link = await admin.auth().generatePasswordResetLink(email);
  } catch (err) {
    console.error('generatePasswordResetLink error:', err);
  }

  return { uid: userRecord.uid, link };
});

// Generates a fresh one-time setup/password-reset link for an existing
// team member, without sending anything — for when the automated email
// got junked and you'd rather hand them the link directly (text, WhatsApp,
// or an email from your own address). Links expire in about an hour, so
// this is meant to be generated right before you actually send it, not
// stockpiled.
exports.generateSetupLink = onCall(async (request) => {
  await requireAdminOrOwner(request.auth);
  const { email } = request.data || {};
  if (!email) {
    throw new HttpsError('invalid-argument', 'email is required.');
  }
  try {
    const link = await admin.auth().generatePasswordResetLink(email);
    return { link };
  } catch (err) {
    throw new HttpsError('internal', err.message);
  }
});

// Disables (or re-enables) a team member's login without deleting their
// history or profile — offboarding someone shouldn't erase who scheduled
// what. Admin/owner only, same as createUser.
exports.setUserDisabled = onCall(async (request) => {
  await requireAdminOrOwner(request.auth);

  const { uid, disabled } = request.data || {};
  if (!uid || typeof disabled !== 'boolean') {
    throw new HttpsError('invalid-argument', 'uid and disabled (true/false) are required.');
  }
  if (uid === request.auth.uid) {
    throw new HttpsError('invalid-argument', "You can't disable your own account.");
  }

  await admin.auth().updateUser(uid, { disabled });
  await admin.firestore().doc(`users/${uid}`).set({ disabled }, { merge: true });
  return { ok: true };
});

// --- Stukenholtz Results sync -------------------------------------------
//
// Reuses admin, onSchedule, onRequest, and defineSecret already required
// at the top of this file.
//
// Set the key once with: firebase functions:secrets:set STUKENHOLTZ_API_KEY
//
// IMPORTANT - unverified response shape: Stukenholtz's docs
// (https://stukenholtz.readme.io) document the *request* body for
// /results but not the shape of an individual result object. The field
// names guessed at in mapResultToSample() below (sampleType, field,
// receivedDt, values) are based on common API conventions and the shape
// of the /contacts example - not confirmed. After deploying, hit
// backfillStukenholtzSamplesNow once with a short date range and check
// the Cloud Functions log for "Unmapped Stukenholtz sample" entries -
// those print the full raw object so you can see what's actually coming
// back and adjust the extraction below.

const STUKENHOLTZ_API_KEY = defineSecret('STUKENHOLTZ_API_KEY');
const STUKENHOLTZ_BASE_URL = 'https://reporting.stukenholtz.com/api';
// NOTE: Stukenholtz's docs (stukenholtz.readme.io) still reference
// results.stukenholtz.com, but that domain now 301-redirects here as of
// August 2026. Pointing directly at the real address rather than relying
// on the redirect - a POST hitting a 301 can silently get converted into
// a GET by some HTTP clients (including Node's fetch), which is what
// caused the "405 Method Not Allowed" on /results before this fix.

async function stukenholtzGet(path, apikey) {
  const url = `${STUKENHOLTZ_BASE_URL}${path}?apikey=${apikey}`;
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`Stukenholtz API error ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

async function stukenholtzPost(path, body, apikey) {
  const url = `${STUKENHOLTZ_BASE_URL}${path}?apikey=${apikey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`Stukenholtz API error ${res.status} on ${path}: ${await res.text()}`);
  return res.json();
}

// Matches a Stukenholtz field/location label against our own `fields`
// collection by name - the same loose, lowercase/punctuation-stripped
// approach slugifyFarmName() uses elsewhere in this app, since the two
// systems were never guaranteed to agree on exact capitalization/spacing.
function normalizeFieldLabel(label) {
  return (label || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, ' ').trim();
}

function buildFieldLookup(fieldDocs) {
  const byNormalizedName = {};
  fieldDocs.forEach((doc) => {
    const data = doc.data();
    if (data.name) byNormalizedName[normalizeFieldLabel(data.name)] = doc.id;
  });
  return byNormalizedName;
}

// Best-guess extraction of a usable sample doc from one raw Stukenholtz
// result - see the file-level note above. Candidate property names are
// checked in order; adjust once you've seen a real response.
function mapResultToSample(result, fieldLookup) {
  const sourceId = result._id || result.id || null;
  if (!sourceId) return null; // can't upsert safely without a stable id

  // Confirmed via a live API response (Aug 2026): the short code lives in
  // ProdType (e.g. "PL"), matching the codes Stukenholtz emailed (SO/PL/
  // NEMA/CM). Type carries the human-readable category (e.g. "Plant
  // Tissue") as a fallback in case ProdType is ever missing.
  const prodTypeCode = (result.ProdType || '').toUpperCase().trim();
  const typeDescription = (result.Type || result.sampleType || result.sample_type || result.type || '').toLowerCase();
  let type = null;
  if (prodTypeCode === 'SO') type = 'soil';
  else if (prodTypeCode === 'PL') type = 'petiole';
  else if (prodTypeCode === 'NEMA') type = 'nematode';
  else if (prodTypeCode === 'CM') type = 'compost';
  else if (typeDescription.includes('soil')) type = 'soil';
  else if (typeDescription.includes('petiole') || typeDescription.includes('plant')) type = 'petiole';
  else if (typeDescription.includes('nematode')) type = 'nematode';
  else if (typeDescription.includes('compost') || typeDescription.includes('manure')) type = 'compost';

  // Stukenholtz's own /results response labels "Sample" as "Sample ID" in
  // its column metadata - the closest match to a field/location name
  // (e.g. "SHOP S"). FieldID is Stukenholtz's own internal number (won't
  // match Agworld-sourced field docs), and Grower is the farm/company
  // name, not a specific field - both kept only as fallbacks.
  const fieldLabel = result.Sample || result.field || result.fieldName || result.FieldID || result.Grower || null;
  const fieldId = fieldLabel ? fieldLookup[normalizeFieldLabel(fieldLabel)] || null : null;

  // Confirmed field name: ReceivedDt (matches Stukenholtz's own
  // "Date Sampled" column label).
  const receivedDtRaw = result.ReceivedDt || result.receivedDt || result.received_dt || null;
  const receivedDate = receivedDtRaw ? new Date(receivedDtRaw) : null;

  return {
    sourceId: String(sourceId),
    type,
    fieldId,
    // Kept only when unmatched, so unmatched samples are easy to find and
    // fix later without having lost the original label.
    rawFieldLabel: fieldId ? null : fieldLabel,
    receivedDt: receivedDate && !Number.isNaN(receivedDate.getTime())
      ? admin.firestore.Timestamp.fromDate(receivedDate)
      : null,
    // Confirmed key: Results (came back as an empty {} on the one live
    // sample we saw, which may just mean that particular report hadn't
    // had lab values entered yet - if populated samples turn out to
    // nest numbers differently than a flat object, this needs another
    // look once we see one with actual data in it).
    values: result.Results || result.values || result.measurements || {},
    raw: result, // kept until the mapping above is confirmed against real data
    syncedAt: admin.firestore.FieldValue.serverTimestamp()
  };
}

async function fetchAllContactIds(apikey) {
  const json = await stukenholtzGet('/contacts', apikey);
  const contacts = json.contacts || json.data || (Array.isArray(json) ? json : null);
  if (!contacts) {
    // Nothing matched the shapes we know how to handle - log the actual
    // top-level keys so this is debuggable from the logs alone, rather
    // than silently returning zero contacts (which is what caused an
    // earlier "fetched 0, wrote 0" run to look like a dead end).
    console.warn('Unexpected /contacts response shape, top-level keys:', Object.keys(json));
    return [];
  }
  return contacts.map((c) => c._id || c.id).filter(Boolean);
}

async function fetchResultsSince(startingReceivedDt, contactIds, apikey) {
  const json = await stukenholtzPost(
    '/results',
    { sampleType: 'ANY', contacts: contactIds, startingReceivedDt },
    apikey
  );
  if (Array.isArray(json)) return json;
  if (Array.isArray(json.results)) return json.results;
  if (Array.isArray(json.data)) return json.data;
  // Same reasoning as fetchAllContactIds - log what we actually got back
  // rather than silently returning zero results.
  console.warn('Unexpected /results response shape, top-level keys:', Object.keys(json));
  return [];
}

// Stukenholtz caps /results at 1000 records per call and exposes no page
// number - Kent has hit this limit before with this API. The only way to
// advance is to push the date cursor forward ourselves, using the latest
// ReceivedDt actually returned in each batch.
const STUKENHOLTZ_PAGE_SIZE = 1000;

// Fetches, maps, and writes ONE batch (up to the cap above) starting at
// startingReceivedDt. Shared by both the hourly sync (small windows,
// always well under the cap) and the backfill endpoint (which calls this
// repeatedly, advancing its own cursor between calls).
async function syncOneStukenholtzBatch(startingReceivedDt) {
  const apikey = STUKENHOLTZ_API_KEY.value();
  const db = admin.firestore();

  const [contactIds, fieldDocsSnap] = await Promise.all([
    fetchAllContactIds(apikey),
    db.collection('fields').get()
  ]);
  const fieldLookup = buildFieldLookup(fieldDocsSnap.docs);
  const results = await fetchResultsSince(startingReceivedDt, contactIds, apikey);

  let written = 0;
  let unmapped = 0;
  let maxReceivedDt = null;

  for (let i = 0; i < results.length; i += 400) {
    const chunk = results.slice(i, i + 400);
    const batch = db.batch();
    chunk.forEach((raw) => {
      const sample = mapResultToSample(raw, fieldLookup);
      if (!sample) return;
      if (!sample.type || !sample.fieldId) {
        unmapped++;
        console.warn('Unmapped Stukenholtz sample, needs manual review:', JSON.stringify(raw));
      }
      if (sample.receivedDt) {
        const d = sample.receivedDt.toDate();
        if (!maxReceivedDt || d > maxReceivedDt) maxReceivedDt = d;
      }
      batch.set(db.collection('samples').doc(sample.sourceId), sample, { merge: true });
    });
    await batch.commit();
    written += chunk.length;
  }

  return { fetched: results.length, written, unmapped, maxReceivedDt };
}

// Runs hourly, resuming from wherever the last successful sync left off -
// not a rolling "last N hours" window - so a slow run or a missed
// invocation never creates a gap. First run ever falls back to the last
// 24 hours. NOTE: this doesn't paginate - if a single hour ever genuinely
// produced 1000+ new samples (essentially impossible at real-world
// volumes), anything past the cap would be silently missed until the
// following hour's run happened to catch it via an overlapping window.
// Not handled here since it's not a realistic hourly volume.
exports.syncStukenholtzSamplesHourly = onSchedule(
  {
    schedule: 'every 1 hours',
    timeZone: 'America/Denver',
    secrets: [STUKENHOLTZ_API_KEY],
    timeoutSeconds: 540,
    memory: '512MiB'
  },
  async () => {
    const db = admin.firestore();
    const stateDoc = await db.collection('syncState').doc('stukenholtz').get();
    const lastSyncedAt = stateDoc.exists && stateDoc.data().lastSyncedAt
      ? stateDoc.data().lastSyncedAt.toDate().toISOString()
      : new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const result = await syncOneStukenholtzBatch(lastSyncedAt);
    await db.collection('syncState').doc('stukenholtz').set(
      { lastSyncedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    console.log(`Stukenholtz sync: fetched ${result.fetched}, wrote ${result.written}, ${result.unmapped} unmapped.`);
  }
);

// Resumable full-history backfill. Call this same URL repeatedly (no
// query params needed after the first time) - each call fetches one
// batch of up to STUKENHOLTZ_PAGE_SIZE, writes it, and saves where it
// left off in syncState/stukenholtzBackfill. Returns JSON with a "done"
// field: keep calling until that's true. Once done, it also bumps
// syncState/stukenholtz's lastSyncedAt so the hourly job picks up
// seamlessly from where the backfill stopped, with no gap in between.
//
// First-ever call: pass ?since=2015-01-01 (or any date) to set the
// starting point - defaults to 2015-01-01 if omitted. Add ?reset=true to
// restart from scratch (e.g. if you want to redo it with an earlier
// start date after it's already marked done).
exports.backfillStukenholtzSamplesNow = onRequest(
  { secrets: [STUKENHOLTZ_API_KEY], timeoutSeconds: 540, memory: '1GiB' },
  async (req, res) => {
    try {
      const db = admin.firestore();
      const stateRef = db.collection('syncState').doc('stukenholtzBackfill');
      const stateSnap = await stateRef.get();
      const forceReset = req.query.reset === 'true';

      let cursor;
      if (forceReset || !stateSnap.exists) {
        cursor = req.query.since || '2015-01-01T00:00:00.000Z';
      } else if (stateSnap.data().done) {
        res.status(200).json({
          done: true,
          message: `Backfill already completed as of ${stateSnap.data().cursor}. Add ?reset=true to run again from scratch.`
        });
        return;
      } else {
        cursor = stateSnap.data().cursor;
      }

      const result = await syncOneStukenholtzBatch(cursor);

      // A partial batch (fewer than the page size) is the only signal
      // Stukenholtz gives us that we've caught up to the present - a
      // full-size batch might mean there's more waiting.
      const done = result.fetched < STUKENHOLTZ_PAGE_SIZE;
      // Advance 1ms past the latest record seen, so the next call doesn't
      // just refetch the same boundary record forever. Harmless if a
      // handful of records share that exact millisecond and get
      // refetched - the upsert-by-sourceId is idempotent either way.
      const nextCursor = result.maxReceivedDt
        ? new Date(result.maxReceivedDt.getTime() + 1).toISOString()
        : cursor;

      await stateRef.set({
        cursor: nextCursor,
        done,
        lastRunAt: admin.firestore.FieldValue.serverTimestamp()
      });

      if (done) {
        await db.collection('syncState').doc('stukenholtz').set(
          { lastSyncedAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );
      }

      res.status(200).json({
        done,
        fetchedThisBatch: result.fetched,
        writtenThisBatch: result.written,
        unmappedThisBatch: result.unmapped,
        nextCursor,
        message: done
          ? 'Backfill complete - the hourly sync will take over from here.'
          : `Fetched ${result.fetched} (cap is ${STUKENHOLTZ_PAGE_SIZE} per call) - call this same URL again to continue from ${nextCursor}.`
      });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  }
);
