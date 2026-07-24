const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
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

// Pulls every season on the account (not just the most recent one).
// A diversified operation typically has several seasons active at once —
// e.g. a row-crop rotation season and a separate pasture/lease season —
// so we can't assume "most recent" covers every field.
async function fetchAllSeasons(token) {
  const params = new URLSearchParams({ 'page[size]': '100' });
  const json = await agworldGet('/user_api/v1/seasons', params, token);
  return json.data.map((s) => ({
    id: s.id,
    name: s.attributes.name || s.id,
    startDate: s.attributes.season_start_date || null,
    endDate: s.attributes.season_end_date || null
  }));
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

  return {
    fieldCount: fieldIds.length,
    seasonCount: seasons.length,
    fieldSeasonRecords: totalFieldSeasonDocs
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
      `Synced ${result.fieldCount} fields across ${result.seasonCount} seasons (${result.fieldSeasonRecords} field-season records).`
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
        `Synced ${result.fieldCount} fields across ${result.seasonCount} seasons (${result.fieldSeasonRecords} field-season records).`
      );
    } catch (err) {
      console.error(err);
      res.status(500).send(err.message);
    }
  }
);
