// Satellite crop history (Oct 2026)
//
// Fills the long-term rotation history for every current Agworld field from
// the USDA NASS Cropland Data Layer (CDL) — the yearly 30 m satellite crop
// map that the NASS Crop Sequence Boundaries viewer is built from. Public
// domain data, served by USDA's CropScape web service:
//
//   GetCDLStat?year=Y&points=x1,y1,x2,y2,...&format=csv  acres of each crop
//       inside a polygon (returns a link to a CSV)  -> majority crop
//   GetCDLValue?year=Y&x=..&y=..   crop at one point (fallback: several
//       points inside the field, majority vote)
//
// Coordinates must be in the CDL's Albers projection (EPSG:5070), so the
// Agworld boundary (GeoJSON, lon/lat) is projected here.
//
// Results go to rotationSat/{agworldFieldId}: { years: { "2018": { crop,
// cdlCode, cdlName, share, method } }, ... }. The Contracts > Rotation tab
// uses them only to fill years the yield workbook and Agworld have no
// record for, and marks them as satellite data. USDA rates CDL accuracy at
// roughly 85-95% for major crops; small or split fields are less reliable.
//
// Runs: "Run satellite backfill" on the Rotation tab (resumable — each call
// works for up to ~7 minutes and reports what's left), and weekly to pick up
// new fields and each new CDL year (USDA publishes year Y early in Y+1).
//
// Lives in its own file (like pivotWatcher.js / storageYields.js) so
// uploading a new index.js can't wipe it out.

const https = require('https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const CDL_BASE = 'https://nassgeodata.gmu.edu/axis2/services/CDLService';
const FIRST_CDL_YEAR = 2008; // CDL covers every state from 2008 on
const STATUS_ID = '_status';
const AGWORLD_BASE_URL = 'https://us.agworld.co';

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

// Lon/lat (NAD83 ~ WGS84) -> CONUS Albers Equal Area (EPSG:5070):
// GRS80, standard parallels 29.5/45.5, origin 23N 96W. Snyder's ellipsoidal
// Albers formulas.
const ALB = (() => {
  const a = 6378137, f = 1 / 298.257222101, e2 = 2 * f - f * f, e = Math.sqrt(e2);
  const rad = Math.PI / 180;
  const m = (phi) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const q = (phi) => {
    const s = Math.sin(phi);
    return (1 - e2) * (s / (1 - e2 * s * s) - (1 / (2 * e)) * Math.log((1 - e * s) / (1 + e * s)));
  };
  const p1 = 29.5 * rad, p2 = 45.5 * rad, p0 = 23 * rad, l0 = -96 * rad;
  const m1 = m(p1), m2 = m(p2), q1 = q(p1), q2 = q(p2), q0 = q(p0);
  const n = (m1 * m1 - m2 * m2) / (q2 - q1);
  const C = m1 * m1 + n * q1;
  const rho0 = (a * Math.sqrt(C - n * q0)) / n;
  return { a, n, C, rho0, l0, q, rad };
})();
function toAlbers(lon, lat) {
  const { a, n, C, rho0, l0, q, rad } = ALB;
  const rho = (a * Math.sqrt(C - n * q(lat * rad))) / n;
  const theta = n * (lon * rad - l0);
  return [rho * Math.sin(theta), rho0 - rho * Math.cos(theta)];
}

// Agworld boundary (GeoJSON string or object, Polygon or MultiPolygon, or
// the compact [[lon, lat], ...] ring stored in fieldBoundaries) -> the
// largest outer ring as [[lon, lat], ...].
function largestRing(boundary) {
  let g = boundary;
  if (!g) return null;
  if (typeof g === 'string') { try { g = JSON.parse(g); } catch (e) { return null; } }
  if (Array.isArray(g)) return g.length >= 3 ? g : null; // compact ring as stored in fieldBoundaries
  if (g.type === 'Feature') g = g.geometry;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
  let best = null, bestArea = 0;
  polys.forEach((p) => {
    const ring = p && p[0];
    if (!ring || ring.length < 4) return;
    const ar = Math.abs(ringArea(ring));
    if (ar > bestArea) { bestArea = ar; best = ring; }
  });
  return best;
}
function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) s += (ring[j][0] * ring[i][1]) - (ring[i][0] * ring[j][1]);
  return s / 2;
}
function ringCentroid(ring) {
  let A = 0, cx = 0, cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const cr = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    A += cr; cx += (ring[j][0] + ring[i][0]) * cr; cy += (ring[j][1] + ring[i][1]) * cr;
  }
  if (!A) return ring[0];
  return [cx / (3 * A), cy / (3 * A)];
}
function pointInRing(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
// Keep a URL-friendly number of vertices (CropScape takes them in the URL).
function simplifyRing(ring, maxPts = 40) {
  let r = ring.slice();
  if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) r.pop();
  if (r.length > maxPts) {
    const step = r.length / maxPts;
    const out = [];
    for (let i = 0; i < maxPts; i++) out.push(r[Math.floor(i * step)]);
    r = out;
  }
  return r;
}
// Up to `n` points spread inside the field (grid over its bounding box,
// kept if inside and not hugging the edge), always including a centroid
// that's inside. In Albers metres.
function samplePoints(ringAlb, n = 9) {
  const xs = ringAlb.map((p) => p[0]), ys = ringAlb.map((p) => p[1]);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const pts = [];
  const c = ringCentroid(ringAlb);
  if (pointInRing(c, ringAlb)) pts.push(c);
  for (let k = 4; k <= 8 && pts.length < n; k++) {
    for (let i = 1; i < k && pts.length < n; i++) {
      for (let j = 1; j < k && pts.length < n; j++) {
        const p = [minX + ((maxX - minX) * i) / k, minY + ((maxY - minY) * j) / k];
        if (pointInRing(p, ringAlb) && !pts.some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 45)) pts.push(p);
      }
    }
  }
  return pts.slice(0, n);
}

// CDL category -> the crop names AIO uses (yieldMath canonCrop spelling).
const CDL_CROP = {
  1: 'CORN', 12: 'SWEET CORN', 13: 'CORN', 21: 'BARLEY', 22: 'WHEAT', 23: 'WHEAT', 24: 'WHEAT', 25: 'SMALL GRAIN',
  27: 'RYE', 28: 'SMALL GRAIN', 29: 'SMALL GRAIN', 205: 'SMALL GRAIN', 226: 'SMALL GRAIN', 36: 'HAY', 37: 'HAY',
  58: 'HAY', 41: 'BEETS', 42: 'BEANS', 43: 'POTATO', 49: 'ONIONS', 53: 'PEAS', 14: 'MINT', 61: 'FALLOW',
  59: 'GRASS SEED', 60: 'GRASS SEED', 48: 'MELONS', 209: 'MELONS', 229: 'PUMPKINS', 206: 'CARROTS', 31: 'CANOLA',
  33: 'SAFFLOWER', 6: 'SUNFLOWER', 5: 'SOYBEANS', 225: 'WHEAT', 228: 'CORN', 236: 'WHEAT', 237: 'BARLEY',
  176: 'PASTURE', 152: 'NOT FARMED', 111: 'NOT FARMED', 121: 'NOT FARMED', 122: 'NOT FARMED', 123: 'NOT FARMED',
  124: 'NOT FARMED', 131: 'NOT FARMED', 141: 'NOT FARMED', 142: 'NOT FARMED', 143: 'NOT FARMED', 190: 'NOT FARMED', 195: 'NOT FARMED'
};
function cdlToCrop(code, name) {
  const c = Number(code);
  if (CDL_CROP[c]) return CDL_CROP[c];
  // "Dbl Crop WinWht/Corn" etc.: count the year as its first crop.
  if (/^dbl crop/i.test(name || '')) {
    const first = String(name).replace(/^dbl crop\s*/i, '').split('/')[0].trim();
    if (/wht|wheat|durum/i.test(first)) return 'WHEAT';
    if (/barley/i.test(first)) return 'BARLEY';
    if (/oats|triticale|rye/i.test(first)) return 'SMALL GRAIN';
    if (/corn/i.test(first)) return 'CORN';
    if (/soy/i.test(first)) return 'SOYBEANS';
    return first.toUpperCase() || null;
  }
  return name ? String(name).trim().toUpperCase() : null;
}

// GetCDLValue body: ...<Result>{x: 1, y: 2, value: 43, category: "Potatoes", color: "#..."}</Result>...
function parseCdlValue(text) {
  const m = String(text || '').match(/value\s*:\s*"?(\d+)"?[^}]*?category\s*:\s*"([^"]*)"/i);
  if (!m) return null;
  return { code: Number(m[1]), name: m[2] };
}
// GetCDLStat body holds <returnURL>https://...csv</returnURL>.
function parseReturnUrl(text) {
  const m = String(text || '').match(/<returnURL>\s*([^<\s]+)\s*<\/returnURL>/i);
  return m ? m[1] : null;
}
// CDL stat CSV: header with Value / Category / Acreage columns (order and
// extra columns vary by request type) -> [{ code, name, acres }].
function parseStatCsv(csv) {
  const lines = String(csv || '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (l) => (l.match(/("([^"]|"")*"|[^,]*)(,|$)/g) || []).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '').replace(/""/g, '"').trim()).filter((c, i, a) => i < a.length - 1 || c !== '');
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const iv = head.findIndex((h) => h === 'value' || h === 'code');
  const ic = head.findIndex((h) => h.includes('category') || h === 'name');
  const ia = head.findIndex((h) => h.includes('acre'));
  const ik = head.findIndex((h) => h.includes('count'));
  if (iv < 0 || (ia < 0 && ik < 0)) return [];
  return lines.slice(1).map(split).map((r) => ({
    code: Number(r[iv]), name: ic >= 0 ? r[ic] : null,
    acres: ia >= 0 ? Number(r[ia]) : Number(r[ik]) * 0.2224 // 30 m pixel = 0.2224 ac
  })).filter((r) => Number.isFinite(r.code) && r.acres > 0);
}
// Majority crop from per-category acres (or votes). Background / no-data (0) ignored.
function majority(rows) {
  const byCrop = {};
  let total = 0;
  rows.forEach((r) => {
    if (!r.code) return;
    const crop = cdlToCrop(r.code, r.name);
    if (!crop) return;
    const e = (byCrop[crop] = byCrop[crop] || { crop, acres: 0, code: r.code, name: r.name });
    e.acres += r.acres; total += r.acres;
    if (r.acres > (e.top || 0)) { e.top = r.acres; e.code = r.code; e.name = r.name; }
  });
  const best = Object.values(byCrop).sort((a, b) => b.acres - a.acres)[0];
  if (!best || !total) return null;
  return { crop: best.crop, cdlCode: best.code, cdlName: best.name, share: Math.round((best.acres / total) * 100) / 100 };
}

// What syncFields stores in fieldBoundaries: the largest outer ring,
// thinned to <= 80 points, 6 decimals (~10 cm), as a JSON string.
function compactBoundary(raw) {
  const r = largestRing(raw);
  if (!r) return null;
  return JSON.stringify(simplifyRing(r, 80).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]));
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------
// CropScape's certificate has a history of failing verification (the USDA's
// own R client downloads with curl -k). This is public, read-only data, so a
// certificate failure on THIS host only is retried without verification.
function httpGet(url, { timeoutMs = 30000, insecure = false } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, rejectUnauthorized: !insecure }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(httpGet(new URL(res.headers.location, url).toString(), { timeoutMs, insecure }));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => (res.statusCode >= 400 ? reject(new Error(`HTTP ${res.statusCode}`)) : resolve(body)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
async function cdlGet(url) {
  const host = new URL(url).hostname;
  try {
    return await httpGet(url);
  } catch (err) {
    const certErr = /certificate|self.signed|UNABLE_TO|CERT_|unable to verify/i.test(`${err.code} ${err.message}`);
    if (certErr && host === 'nassgeodata.gmu.edu') return httpGet(url, { insecure: true });
    throw err;
  }
}

async function cropByPolygon(ringAlb, year) {
  const pts = ringAlb.concat([ringAlb[0]]).map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(',');
  const body = await cdlGet(`${CDL_BASE}/GetCDLStat?year=${year}&points=${pts}&format=csv`);
  if (/error|exception/i.test(body) && !/returnURL/i.test(body)) throw new Error(body.replace(/<[^>]+>/g, ' ').trim().slice(0, 200));
  const link = parseReturnUrl(body);
  if (!link) throw new Error('no returnURL');
  const rows = parseStatCsv(await cdlGet(link));
  const m = majority(rows);
  if (!m) throw new Error('empty stats');
  return { ...m, method: 'polygon' };
}
async function cropByPoints(ringAlb, year) {
  const pts = samplePoints(ringAlb, 7);
  const votes = [];
  for (const p of pts) {
    try {
      const v = parseCdlValue(await cdlGet(`${CDL_BASE}/GetCDLValue?year=${year}&x=${p[0].toFixed(1)}&y=${p[1].toFixed(1)}`));
      if (v) votes.push({ ...v, acres: 1 });
    } catch (e) { /* one bad point doesn't sink the year */ }
  }
  const m = majority(votes);
  if (!m) throw new Error('no point values');
  return { ...m, method: `points(${votes.length})` };
}
async function cropForYear(ringAlb, year) {
  try {
    return await cropByPolygon(ringAlb, year);
  } catch (e) {
    return cropByPoints(ringAlb, year);
  }
}

// ---------------------------------------------------------------------------
// Firestore side
// ---------------------------------------------------------------------------
function yearOf(s) {
  const m = String(s || '').match(/\b(19|20)\d{2}\b/);
  return m ? parseInt(m[0], 10) : null;
}
function fieldKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}
function hashRing(ring) {
  let h = 0;
  const s = ring.map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)}`).join(';');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h);
}

async function fetchAgworldBoundary(fieldId, seasonId, token) {
  if (!token) return null;
  const url = `${AGWORLD_BASE_URL}/user_api/v1/fields/${encodeURIComponent(fieldId)}?season_id=${encodeURIComponent(seasonId)}&api_token=${encodeURIComponent(token)}`;
  try {
    const body = await httpGet(url);
    const json = JSON.parse(body);
    return (json && json.data && json.data.attributes && json.data.attributes.boundary) || null;
  } catch (e) {
    return null;
  }
}

// One pass: works through missing field-years until the time budget runs out.
async function runSatelliteRotation({ trigger, budgetMs = 7 * 60 * 1000, agworldToken = null, force = false }) {
  const db = admin.firestore();
  const started = Date.now();
  const latestYear = new Date().getFullYear() - 1; // CDL year Y is published early in Y+1
  const [fieldsSnap, seasonsSnap, satSnap, boundSnap] = await Promise.all([
    db.collection('fields').get(), db.collection('seasons').get(), db.collection('rotationSat').get(),
    db.collection('fieldBoundaries').get()
  ]);
  // Outlines saved by the nightly Agworld sync (fieldBoundaries/{fieldId});
  // kept out of the season docs because every screen of the app reads those.
  const boundaryById = {};
  boundSnap.forEach((d) => { boundaryById[d.id] = d.data().boundary || null; });
  const seasonYearById = {};
  seasonsSnap.forEach((s) => { const d = s.data(); seasonYearById[s.id] = yearOf(d.name) || yearOf(d.startDate); });
  const existing = {};
  satSnap.forEach((d) => { if (d.id !== STATUS_ID) existing[d.id] = d.data(); });

  // Each current field's most recent season doc (boundary lives there).
  const fields = [];
  for (const f of fieldsSnap.docs) {
    const base = f.data();
    const ss = await f.ref.collection('seasons').get();
    let best = null;
    ss.forEach((s) => {
      const d = s.data();
      const y = seasonYearById[String(d.seasonId)] || yearOf(d.seasonName) || 0;
      if (!best || y > best.y) best = { y, d, seasonId: String(d.seasonId || s.id) };
    });
    if (best) fields.push({ id: f.id, name: base.name, farmName: base.farmName || null, season: best });
  }

  let processed = 0, filled = 0, failed = 0, noBoundary = 0;
  const errors = [];
  let remaining = 0;
  const queue = [];
  for (const f of fields) {
    let boundary = boundaryById[f.id] || null;
    if (!boundary && agworldToken) {
      const raw = await fetchAgworldBoundary(f.id, f.season.seasonId, agworldToken);
      const r = largestRing(raw);
      if (r) {
        boundary = JSON.stringify(simplifyRing(r, 80).map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]));
        await db.collection('fieldBoundaries').doc(f.id).set({ boundary, seasonId: f.season.seasonId, source: 'agworld-field', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    const ring = largestRing(boundary);
    if (!ring) { noBoundary++; continue; }
    const simple = simplifyRing(ring, 40);
    const albers = simple.map(([lon, lat]) => toAlbers(lon, lat));
    const hash = hashRing(simple);
    const prev = existing[f.id] || {};
    const sameShape = prev.boundaryHash === hash && !force;
    const done = sameShape ? { ...(prev.years || {}) } : {};
    const unavailable = sameShape ? { ...(prev.unavailable || {}) } : {};
    const centroid = ringCentroid(simple);
    const todo = [];
    for (let y = FIRST_CDL_YEAR; y <= latestYear; y++) if (!done[y] && !(unavailable[y] >= 3)) todo.push(y);
    if (!sameShape || prev.fieldName !== f.name) {
      await db.collection('rotationSat').doc(f.id).set({
        fieldId: f.id, fieldName: f.name, fieldKey: fieldKey(f.name), farmName: f.farmName,
        boundaryHash: hash, centroid: { lon: centroid[0], lat: centroid[1] },
        years: done, unavailable, updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    todo.forEach((y) => queue.push({ f, y, albers, unavailable }));
  }

  // A few requests at a time, newest years first so recent history fills in first.
  queue.sort((a, b) => b.y - a.y);
  const CONCURRENCY = 4;
  let qi = 0;
  async function worker() {
    while (qi < queue.length && Date.now() - started < budgetMs) {
      const job = queue[qi++];
      try {
        const r = await cropForYear(job.albers, job.y);
        await db.collection('rotationSat').doc(job.f.id).set({ years: { [job.y]: r }, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        filled++;
      } catch (e) {
        failed++;
        job.unavailable[job.y] = (job.unavailable[job.y] || 0) + 1;
        await db.collection('rotationSat').doc(job.f.id).set({ unavailable: { [job.y]: job.unavailable[job.y] } }, { merge: true });
        if (errors.length < 10) errors.push(`${job.f.name} ${job.y}: ${String(e.message || e).slice(0, 120)}`);
      }
      processed++;
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  remaining = queue.length - processed;

  const status = {
    lastRunMs: Date.now(), trigger, fieldsWithBoundary: fields.length - noBoundary, fieldsWithoutBoundary: noBoundary,
    processed, filled, failed, remaining, latestYear, firstYear: FIRST_CDL_YEAR, errors, durationMs: Date.now() - started
  };
  await db.collection('rotationSat').doc(STATUS_ID).set(status);
  return status;
}

async function requireAdminOrOwner(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await admin.firestore().doc(`users/${auth.uid}`).get();
  const role = snap.exists ? snap.data().role : null;
  if (role !== 'admin' && role !== 'owner') throw new HttpsError('permission-denied', 'Only an Admin or Owner can run the satellite backfill.');
}

// The Agworld token is optional here: it's only used to fetch a field's
// boundary when the nightly sync hasn't stored one yet.
function makeExports(AGWORLD_TOKEN) {
  const secrets = AGWORLD_TOKEN ? [AGWORLD_TOKEN] : [];
  const token = () => { try { return AGWORLD_TOKEN ? AGWORLD_TOKEN.value() : null; } catch (e) { return null; } };
  return {
    // "Run satellite backfill" button. Resumable: call again while remaining > 0.
    syncSatelliteRotationNow: onCall({ timeoutSeconds: 540, memory: '512MiB', secrets }, async (request) => {
      await requireAdminOrOwner(request.auth);
      const force = !!(request.data && request.data.force);
      return runSatelliteRotation({ trigger: 'manual', agworldToken: token(), force });
    }),
    // Weekly: new fields, changed boundaries, and each new CDL year.
    syncSatelliteRotationWeekly: onSchedule(
      { schedule: 'every monday 03:40', timeZone: 'America/Denver', timeoutSeconds: 540, memory: '512MiB', secrets },
      async () => {
        const r = await runSatelliteRotation({ trigger: 'weekly', agworldToken: token() });
        console.log(`Satellite rotation: ${r.filled} field-years filled, ${r.failed} failed, ${r.remaining} left, ${r.fieldsWithoutBoundary} fields without a boundary.`);
      }
    )
  };
}

module.exports = {
  makeExports,
  // pure helpers, for tests only
  compactBoundary, _test: { toAlbers, largestRing, ringCentroid, pointInRing, simplifyRing, samplePoints, cdlToCrop, parseCdlValue, parseReturnUrl, parseStatCsv, majority }
};
