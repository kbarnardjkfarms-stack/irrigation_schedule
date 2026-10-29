// Potato Storage -> Yield History link (Oct 2026)
//
// Every pile (a "zone" in Potato Storage) with a Measured cwt becomes a
// potato yield for the Agworld field(s) it came from:
//
//   adjusted cwt = measured cwt x (1 - tare)      tare defaults to 6.7%
//
// A pile built from several Agworld fields ("Power Plant Main + Power Plant
// Mini") is split back onto each field by Agworld acres. A field stored in
// more than one bay has its piles added together. The result lands on
// yieldHistory/{FIELDKEY}__{YEAR} under a `storage` block, next to the
// workbook/entered numbers and the `agworld` block. The Yields module shows
// a workbook or hand-entered yield first, then this, then Agworld's.
//
// Piles keep their contribution after the bay is emptied for next season
// (the zone disappears from Potato Storage, but last year's yield must not).
// A pile that still exists but has its Measured cwt cleared is removed.
// Anything deleted from the Yields module's "Storage link" tab is put on an
// ignore list (yieldSettings/storage.ignored) so the next sync doesn't bring
// it back.
//
// Runs: whenever Potato Storage saves its bay list, nightly at 2:15am, and on
// demand from the Yields module ("Sync now").
//
// Lives in its own file (like pivotWatcher.js) so uploading a new index.js
// can't wipe it out. index.js only re-exports the three functions.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const admin = require('firebase-admin');

// Potato Storage's bay list document (CONFIG_KEY in PotatoStorage.jsx).
const STORAGE_BAYS_KEY = 'norland-bays-config-v4';
const DEFAULT_TARE_PCT = 6.7;
const SETTINGS_DOC = 'yieldSettings/storage';
const STATUS_DOC = 'yieldSettings/storageStatus';

// Same as fieldKey() in yieldMath.js / yieldFieldKey() in index.js.
function fieldKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function yearOf(s) {
  const m = String(s || '').match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}
function round(n, d = 2) {
  const f = Math.pow(10, d);
  return Math.round(n * f) / f;
}
// A pile's Agworld field names: the combined list when it was built from
// several, otherwise its own name (also split on " + " in case it was
// typed that way by hand).
function pileFieldNames(zone) {
  if (Array.isArray(zone.sourceFields) && zone.sourceFields.length) return zone.sourceFields;
  return String(zone.name || '').split(/\s+\+\s+/).map((s) => s.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pure planning step — no Firestore. Exported so it can be tested on its own.
//
// bays:        Potato Storage bay list (each with zones[])
// agworld:     { [year]: { [fieldKey]: { acres, fieldId, fieldName, farmName, variety } } }
// existing:    { [docId]: yieldHistory doc data } for every doc that has a
//              storage block or that a pile now points at
// tarePct:     e.g. 6.7
// ignored:     Set of "DOCID|zoneId"
// currentYear: fallback year for a bay with no fill date
//
// Returns { writes: [{ docId, data, merge }], deletes: [docId], unlinked: [], linkedPiles }
// ---------------------------------------------------------------------------
function planStorageYields({ bays, agworld, existing, tarePct, ignored, currentYear }) {
  const tare = (Number.isFinite(tarePct) ? tarePct : DEFAULT_TARE_PCT) / 100;
  const liveZoneIds = new Set();
  const fresh = {}; // docId -> { year, key, info, piles: { zoneId: pile } }
  const unlinked = [];
  let linkedPiles = 0;

  (bays || []).forEach((bay) => {
    (bay.zones || []).forEach((zone) => {
      if (!zone || !zone.id) return;
      liveZoneIds.add(zone.id);
      const measured = Number(zone.actualCwtOverride);
      if (!(measured > 0)) return;
      const year = yearOf(bay.fillDate) || currentYear;
      const names = pileFieldNames(zone);
      const ag = agworld[year] || {};
      const matched = names.map((n) => ({ name: n, key: fieldKey(n), ag: ag[fieldKey(n)] || null }));
      if (!matched.length || matched.some((m) => !m.ag)) {
        unlinked.push({
          bayId: bay.id, bayName: bay.name || null, zoneId: zone.id, zoneName: zone.name || null, year,
          measuredCwt: measured, variety: zone.variety || null, customer: zone.customer || null,
          missing: matched.filter((m) => !m.ag).map((m) => m.name),
          reason: matched.length ? 'No Agworld field with this name in ' + year : 'Pile has no name'
        });
        return;
      }
      const totalAcres = matched.reduce((s, m) => s + (Number(m.ag.acres) || 0), 0);
      const byAcres = matched.every((m) => Number(m.ag.acres) > 0);
      linkedPiles++;
      matched.forEach((m) => {
        const docId = `${m.key}__${year}`;
        if (ignored.has(`${docId}|${zone.id}`)) return;
        const share = byAcres ? (Number(m.ag.acres) / totalAcres) : 1 / matched.length;
        const gross = measured * share;
        const f = (fresh[docId] = fresh[docId] || { year, key: m.key, info: m.ag, piles: {} });
        f.piles[zone.id] = {
          zoneId: zone.id, zoneName: zone.name || null, bayId: bay.id, bayName: bay.name || null,
          fillDate: bay.fillDate || null, pileMeasuredCwt: measured,
          measuredCwt: round(gross), adjustedCwt: round(gross * (1 - tare)), tareFactor: round(tare, 4),
          fieldAcres: Number(m.ag.acres) || null, splitBy: matched.length > 1 ? (byAcres ? 'acres' : 'even') : 'single',
          combinedWith: matched.length > 1 ? matched.filter((x) => x.key !== m.key).map((x) => x.name) : [],
          variety: zone.variety || null, customer: zone.customer || null
        };
      });
    });
  });

  const writes = [];
  const deletes = [];
  const docIds = new Set([...Object.keys(fresh), ...Object.keys(existing).filter((id) => existing[id] && existing[id].storage)]);
  docIds.forEach((docId) => {
    const ex = existing[docId] || null;
    const oldPiles = (ex && ex.storage && ex.storage.piles) || {};
    // Keep piles whose zone is gone from Potato Storage (bay emptied) — that
    // yield already happened. Drop piles whose zone still exists (they're
    // recomputed below, or were cleared) and anything on the ignore list.
    const piles = {};
    Object.entries(oldPiles).forEach(([zid, p]) => {
      if (!liveZoneIds.has(zid) && !ignored.has(`${docId}|${zid}`)) piles[zid] = p;
    });
    const f = fresh[docId];
    if (f) Object.assign(piles, f.piles);

    const pileList = Object.values(piles);
    if (!pileList.length) {
      if (!ex || !ex.storage) return;
      const onlyStorage = ex.source === 'storage' && !ex.agworld && !(ex.yieldPerAcre > 0);
      if (onlyStorage) deletes.push(docId);
      else writes.push({ docId, data: { storage: admin.firestore.FieldValue.delete() }, merge: true });
      return;
    }
    const measuredCwt = round(pileList.reduce((s, p) => s + (p.measuredCwt || 0), 0));
    const adjustedCwt = round(pileList.reduce((s, p) => s + (p.adjustedCwt || 0), 0));
    // Same field in two bays carries the same field acres on both piles.
    const acres = Math.max(...pileList.map((p) => p.fieldAcres || 0)) || (f && Number(f.info.acres)) || null;
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];
    const storage = {
      piles,
      // Overall tare actually applied (piles kept from an earlier season keep
      // the tare they were synced with).
      measuredCwt, adjustedCwt, tareFactor: measuredCwt > 0 ? round(1 - adjustedCwt / measuredCwt, 4) : round(tare, 4), acres,
      yieldPerAcre: acres > 0 ? round(adjustedCwt / acres, 1) : null,
      varieties: uniq(pileList.map((p) => p.variety)),
      customers: uniq(pileList.map((p) => p.customer)),
      bays: uniq(pileList.map((p) => p.bayName)),
      fillDate: pileList.map((p) => p.fillDate).filter(Boolean).sort()[0] || null,
      combined: pileList.some((p) => p.combinedWith && p.combinedWith.length)
    };
    // Skip the write when nothing changed, so a Potato Storage save that
    // didn't touch any measured cwt doesn't rewrite every yield doc.
    const same = ex && ex.storage && JSON.stringify(stripVolatile(ex.storage)) === JSON.stringify(stripVolatile(storage));
    if (same) return;
    const data = { storage: { ...storage, syncedAt: admin.firestore.FieldValue.serverTimestamp() } };
    if (!ex) {
      const info = (f && f.info) || {};
      Object.assign(data, {
        fieldKey: (f && f.key) || docId.split('__')[0], fieldName: info.fieldName || null,
        year: (f && f.year) || parseInt(docId.split('__')[1], 10), crop: 'POTATO',
        variety: storage.varieties[0] || info.variety || null, acres, area: info.farmName || null,
        unit: 'cwt', source: 'storage', agworldFieldId: info.fieldId || null
      });
    }
    writes.push({ docId, data, merge: true });
  });

  return { writes, deletes, unlinked, linkedPiles };
}
function stripVolatile(s) {
  const { syncedAt, ...rest } = s || {};
  // Stable key order for the comparison.
  return JSON.parse(JSON.stringify(rest, Object.keys(flatKeys(rest)).sort()));
}
function flatKeys(o, out = {}) {
  if (o && typeof o === 'object') Object.entries(o).forEach(([k, v]) => { out[k] = 1; flatKeys(v, out); });
  return out;
}

// ---------------------------------------------------------------------------
// Firestore side
// ---------------------------------------------------------------------------
async function loadAgworldFieldsByYear(db, years) {
  const out = {};
  if (!years.size) return out;
  const [seasonSnap, fieldSnap] = await Promise.all([db.collection('seasons').get(), db.collection('fields').get()]);
  const fieldsById = {};
  fieldSnap.forEach((d) => { fieldsById[d.id] = d.data(); });
  for (const s of seasonSnap.docs) {
    const sd = s.data();
    const y = yearOf(sd.name) || yearOf(sd.startDate) || yearOf(sd.endDate);
    if (!years.has(y)) continue;
    const fsSnap = await db.collectionGroup('seasons').where('seasonId', '==', sd.agworldId != null ? sd.agworldId : s.id).get();
    const map = (out[y] = out[y] || {});
    fsSnap.forEach((d) => {
      const fieldId = d.ref.parent.parent && d.ref.parent.parent.id;
      const base = fieldsById[fieldId];
      if (!base || !base.name) return;
      const data = d.data();
      const k = fieldKey(base.name);
      if (map[k]) return; // first one wins if two seasons in a year both have it
      map[k] = { acres: Number(data.acres) || null, fieldId, fieldName: base.name, farmName: base.farmName || null, variety: data.varietyName || null };
    });
  }
  return out;
}

async function syncStorageYields(trigger) {
  const db = admin.firestore();
  const started = Date.now();
  const [baysSnap, settingsSnap, storageDocsSnap] = await Promise.all([
    db.doc(`potatoStorage/${STORAGE_BAYS_KEY}`).get(),
    db.doc(SETTINGS_DOC).get(),
    db.collection('yieldHistory').where('storage.measuredCwt', '>', 0).get()
  ]);
  let bays = [];
  if (baysSnap.exists) {
    try { bays = JSON.parse(baysSnap.data().value) || []; } catch (e) { bays = []; }
  }
  const settings = settingsSnap.exists ? settingsSnap.data() : {};
  const tarePct = Number.isFinite(Number(settings.tarePct)) && settings.tarePct !== null && settings.tarePct !== '' ? Number(settings.tarePct) : DEFAULT_TARE_PCT;
  const ignored = new Set(settings.ignored || []);
  const currentYear = new Date().getFullYear();

  const years = new Set();
  bays.forEach((b) => (b.zones || []).forEach((z) => { if (Number(z.actualCwtOverride) > 0) years.add(yearOf(b.fillDate) || currentYear); }));
  const agworld = await loadAgworldFieldsByYear(db, years);

  // Existing docs: every doc that already has a storage block, plus every
  // doc a measured pile now points at (to know whether to create it).
  const existing = {};
  storageDocsSnap.forEach((d) => { existing[d.id] = d.data(); });
  const wanted = new Set();
  bays.forEach((b) => (b.zones || []).forEach((z) => {
    if (!(Number(z.actualCwtOverride) > 0)) return;
    const y = yearOf(b.fillDate) || currentYear;
    pileFieldNames(z).forEach((n) => wanted.add(`${fieldKey(n)}__${y}`));
  }));
  const missing = [...wanted].filter((id) => !existing[id]);
  for (let i = 0; i < missing.length; i += 100) {
    const refs = missing.slice(i, i + 100).map((id) => db.collection('yieldHistory').doc(id));
    const snaps = await db.getAll(...refs);
    snaps.forEach((s) => { if (s.exists) existing[s.id] = s.data(); });
  }

  const plan = planStorageYields({ bays, agworld, existing, tarePct, ignored, currentYear });
  const ops = [
    ...plan.writes.map((w) => (b) => b.set(db.collection('yieldHistory').doc(w.docId), w.data, { merge: true })),
    ...plan.deletes.map((id) => (b) => b.delete(db.collection('yieldHistory').doc(id)))
  ];
  for (let i = 0; i < ops.length; i += 400) {
    const batch = db.batch();
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
  const status = {
    lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
    lastRunMs: Date.now(),
    trigger,
    tarePct,
    linkedPiles: plan.linkedPiles,
    updated: plan.writes.length,
    removed: plan.deletes.length,
    unlinked: plan.unlinked.slice(0, 200),
    durationMs: Date.now() - started,
    error: null
  };
  await db.doc(STATUS_DOC).set(status);
  return { ...status, lastRunAt: null };
}

async function runLogged(trigger) {
  try {
    const r = await syncStorageYields(trigger);
    console.log(`Storage->yield sync (${trigger}): ${r.linkedPiles} piles linked, ${r.updated} updated, ${r.removed} removed, ${r.unlinked.length} unlinked.`);
    return r;
  } catch (err) {
    console.error('Storage->yield sync failed', err);
    await admin.firestore().doc(STATUS_DOC).set(
      { lastRunMs: Date.now(), trigger, error: String(err && err.message || err) }, { merge: true }
    ).catch(() => {});
    throw err;
  }
}

async function requireAdminOrOwner(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await admin.firestore().doc(`users/${auth.uid}`).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'admin' && role !== 'owner') throw new HttpsError('permission-denied', 'Only an Admin or Owner can run the storage yield sync.');
}

// Whenever Potato Storage saves its bay list (which is where Measured cwt,
// variety, customer and fill date live).
exports.onPotatoStorageBaysWritten = onDocumentWritten(
  { document: 'potatoStorage/{key}', timeoutSeconds: 120, memory: '512MiB' },
  async (event) => {
    if (event.params.key !== STORAGE_BAYS_KEY) return;
    await runLogged('storage-save');
  }
);

// Nightly safety net, in case a save-triggered run was missed.
exports.syncStorageYieldsNightly = onSchedule(
  { schedule: 'every day 02:15', timeZone: 'America/Denver', timeoutSeconds: 300, memory: '512MiB' },
  async () => { await runLogged('nightly'); }
);

// "Sync now" button on the Yields module's Storage link tab.
exports.syncStorageYieldsNow = onCall({ timeoutSeconds: 300, memory: '512MiB' }, async (request) => {
  await requireAdminOrOwner(request.auth);
  return runLogged('manual');
});

exports._planStorageYields = planStorageYields; // for tests only; not a deployed function
