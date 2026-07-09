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

// Crop and area are season-scoped in Agworld — a field with no season_id
// attached comes back with those attributes as null. So this finds the
// most recent season first, then requests fields against it.
async function findCurrentSeasonId(token) {
  const params = new URLSearchParams({ 'page[size]': '100' });
  const json = await agworldGet('/user_api/v1/seasons', params, token);
  if (!json.data.length) return null;
  const sorted = [...json.data].sort((a, b) => {
    const da = a.attributes.season_start_date || '';
    const db = b.attributes.season_start_date || '';
    return db.localeCompare(da);
  });
  return sorted[0].id;
}

async function fetchAllFields(token) {
  const seasonId = await findCurrentSeasonId(token);
  const fields = [];
  const farmsById = {};
  let page = 1;
  const pageSize = 100;

  while (true) {
    const params = new URLSearchParams({
      'page[number]': String(page),
      'page[size]': String(pageSize),
      include: 'farm'
    });
    if (seasonId) params.set('season_id', seasonId);
    // if (typeof FARM_ID_FILTER !== 'undefined') params.set('filter[farm_id]', FARM_ID_FILTER);

    const json = await agworldGet('/user_api/v1/fields', params, token);
    fields.push(...json.data);

    // "include=farm" sideloads farm records into a top-level "included"
    // array — this pulls farm names out of it rather than just IDs.
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
  const { fields, farmsById } = await fetchAllFields(token);
  const db = admin.firestore();
  const batch = db.batch();

  Object.entries(farmsById).forEach(([farmId, farmName]) => {
    const ref = db.collection('farms').doc(String(farmId));
    batch.set(ref, { agworldId: farmId, name: farmName }, { merge: true });
  });

  fields.forEach((f) => {
    const ref = db.collection('fields').doc(String(f.id));
    // crops comes back as an array (a field can carry more than one crop
    // or blend) — take the primary entry rather than assuming one string.
    const crops = f.attributes.crops || [];
    const primaryCrop = crops.find((c) => c.crop_blend === 'primary') || crops[0] || null;

    // merge: true is the key line here — it updates the Agworld-owned
    // attributes (name, crop, acres, farm) without touching the fields
    // you maintain yourself in the app, like GPM, ditch rider, or
    // diversion point, which Agworld has no concept of.
    batch.set(
      ref,
      {
        agworldId: f.id,
        name: f.attributes.name,
        farmId: f.attributes.farm_id,
        farmName: farmsById[f.attributes.farm_id] || null,
        cropName: primaryCrop ? primaryCrop.crop_name : null,
        varietyName: primaryCrop ? primaryCrop.variety_name : null,
        irrigationMethod: f.attributes.irrigation || null,
        croppingMethod: f.attributes.cropping_method || null,
        acres: parseAreaToAcres(f.attributes.area),
        syncedFromAgworldAt: admin.firestore.FieldValue.serverTimestamp()
      },
      { merge: true }
    );
  });

  await batch.commit();
  return fields.length;
}

// Runs automatically every morning so the field list stays current
// without anyone having to remember to sync it.
exports.syncAgworldFields = onSchedule(
  {
    schedule: 'every day 05:00',
    timeZone: 'America/Denver',
    secrets: [AGWORLD_TOKEN]
  },
  async () => {
    const count = await syncFields();
    console.log(`Synced ${count} fields from Agworld.`);
  }
);

// A manual trigger, useful for testing right after deploy or forcing an
// on-demand refresh. Visiting this URL in a browser (once deployed) runs
// the same sync immediately.
exports.syncAgworldFieldsNow = onRequest(
  { secrets: [AGWORLD_TOKEN] },
  async (req, res) => {
    try {
      const count = await syncFields();
      res.status(200).send(`Synced ${count} fields from Agworld.`);
    } catch (err) {
      console.error(err);
      res.status(500).send(err.message);
    }
  }
);
