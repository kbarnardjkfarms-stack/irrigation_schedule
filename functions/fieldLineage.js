// Field history links by location (Oct 2026)
//
// The yield workbook and old Agworld seasons name fields the way they were
// farmed at the time ("COOK"); today's Agworld fields may be split by pivot
// ("COOK N", "COOK S") or renamed. This looks at every Agworld season BEFORE
// the ones the nightly sync keeps (MIN_SEASON_YEAR), takes each old field's
// outline, and overlaps it with today's field outlines (fieldBoundaries).
// Wherever an old field covers a good part of a current field under a
// different name, it's suggested as a history link: "COOK N <- COOK, covers
// 100% of COOK N, seasons 2019-2024".
//
// Suggestions are written to fieldLineage/_suggestions for the Rotation tab
// to show; nothing is linked until someone accepts it there.
//
// Lives in its own file (like satelliteRotation.js) so uploading a new
// index.js can't wipe it out.

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const sat = require('./satelliteRotation');

const AGWORLD_BASE_URL = 'https://us.agworld.co';
const MIN_OVERLAP = 0.5; // share of the CURRENT field an old field must cover

function fieldKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function yearOf(s) {
  const m = String(s || '').match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}

async function agworld(path, params, token) {
  const url = `${AGWORLD_BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/vnd.api+json', Accept: 'application/vnd.api+json', 'Api-Token': token }
  });
  if (!res.ok) throw new Error(`Agworld ${res.status} on ${path}`);
  return res.json();
}

// Grid points inside a ring (Albers metres), for estimating overlap.
function gridInside(ring, n = 12) {
  const { pointInRing } = sat._test;
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pts = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const p = [minX + ((maxX - minX) * (i + 0.5)) / n, minY + ((maxY - minY) * (j + 0.5)) / n];
    if (pointInRing(p, ring)) pts.push(p);
  }
  return pts;
}
function bbox(ring) {
  const xs = ring.map((p) => p[0]), ys = ring.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}
const boxesTouch = (a, b) => a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];

// Pure: current [{ key, name, ring }] vs old [{ key, name, year, ring }]
// (rings in Albers metres) -> suggestions.
function overlapSuggestions(current, old) {
  const { pointInRing } = sat._test;
  const out = {};
  current.forEach((c) => {
    const cBox = bbox(c.ring);
    const cPts = gridInside(c.ring);
    if (!cPts.length) return;
    old.forEach((o) => {
      if (o.key === c.key) return; // same name: already lines up
      const oBox = o.box || (o.box = bbox(o.ring));
      if (!boxesTouch(cBox, oBox)) return;
      const covered = cPts.filter((p) => pointInRing(p, o.ring)).length / cPts.length;
      if (covered < MIN_OVERLAP) return;
      const oPts = o.pts || (o.pts = gridInside(o.ring));
      const ofOld = oPts.length ? oPts.filter((p) => pointInRing(p, c.ring)).length / oPts.length : null;
      const k = `${c.key}|${o.key}`;
      const s = (out[k] = out[k] || { childKey: c.key, childName: c.name, parentKey: o.key, parentName: o.name, covered: 0, ofOld: 0, years: [] });
      s.covered = Math.max(s.covered, Math.round(covered * 100) / 100);
      if (ofOld != null) s.ofOld = Math.max(s.ofOld, Math.round(ofOld * 100) / 100);
      if (o.year && !s.years.includes(o.year)) s.years.push(o.year);
    });
  });
  return Object.values(out).map((s) => ({ ...s, years: s.years.sort() })).sort((a, b) => a.childName.localeCompare(b.childName) || b.covered - a.covered);
}

async function findSuggestions(token, minSeasonYear) {
  const db = admin.firestore();
  const started = Date.now();
  const [fieldsSnap, boundSnap] = await Promise.all([db.collection('fields').get(), db.collection('fieldBoundaries').get()]);
  const nameById = {};
  fieldsSnap.forEach((d) => { nameById[d.id] = d.data().name; });
  const { toAlbers, largestRing } = sat._test;
  const toAlb = (ring) => ring.map(([lon, lat]) => toAlbers(lon, lat));
  const current = [];
  boundSnap.forEach((d) => {
    const ring = largestRing(d.data().boundary);
    if (ring && nameById[d.id]) current.push({ key: fieldKey(nameById[d.id]), name: nameById[d.id], ring: toAlb(ring) });
  });

  // Every season on the account older than what the nightly sync keeps.
  const seasonsJson = await agworld('/user_api/v1/seasons', { 'page[size]': '100' }, token);
  const oldSeasons = (seasonsJson.data || []).map((s) => ({
    id: s.id, name: s.attributes.name, year: yearOf(s.attributes.name) || yearOf(s.attributes.season_start_date) || yearOf(s.attributes.season_end_date)
  })).filter((s) => s.year && s.year < minSeasonYear).sort((a, b) => b.year - a.year);

  const old = [];
  let oldFields = 0, withOutline = 0, seasonsChecked = 0;
  for (const s of oldSeasons) {
    if (Date.now() - started > 6 * 60 * 1000) break; // stay well inside the 9-minute limit
    seasonsChecked++;
    for (let page = 1; page < 50; page++) {
      const json = await agworld('/user_api/v1/fields', { season_id: s.id, 'page[number]': String(page), 'page[size]': '100' }, token);
      const rows = json.data || [];
      rows.forEach((f) => {
        oldFields++;
        const ring = largestRing(f.attributes && f.attributes.boundary);
        if (!ring) return;
        withOutline++;
        old.push({ key: fieldKey(f.attributes.name), name: f.attributes.name, year: s.year, ring: toAlb(ring) });
      });
      if (rows.length < 100) break;
    }
  }
  const items = overlapSuggestions(current, old);
  const result = {
    runAt: Date.now(), seasonsFound: oldSeasons.length, seasonsChecked, oldFields, oldFieldsWithOutline: withOutline,
    currentFieldsWithOutline: current.length, items: items.slice(0, 1000),
    note: !oldSeasons.length ? `Agworld has no seasons before ${minSeasonYear} on this account.`
      : !withOutline ? 'Agworld has older seasons, but their fields have no outlines to compare.' : null
  };
  await db.collection('fieldLineage').doc('_suggestions').set(result);
  return result;
}

async function requireAdminOrOwner(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await admin.firestore().doc(`users/${auth.uid}`).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'admin' && role !== 'owner') throw new HttpsError('permission-denied', 'Only an Admin or Owner can do this.');
}

function makeExports(AGWORLD_TOKEN, minSeasonYear) {
  return {
    // "Find links by map" on the Rotation tab.
    suggestFieldLineageByMap: onCall({ timeoutSeconds: 540, memory: '512MiB', secrets: [AGWORLD_TOKEN] }, async (request) => {
      await requireAdminOrOwner(request.auth);
      try {
        return await findSuggestions(AGWORLD_TOKEN.value(), minSeasonYear);
      } catch (e) {
        throw new HttpsError('internal', String(e.message || e).slice(0, 300));
      }
    })
  };
}

module.exports = { makeExports, _test: { overlapSuggestions, fieldKey } };
