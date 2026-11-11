// Public farm map feed (Nov 2026)
//
// A live KML link built from the Agworld fields AIO already syncs every
// morning (fields, fields/{id}/seasons, fieldBoundaries). Google Earth (Pro
// or web), QGIS, ArcGIS and most other map programs can load the link and
// re-read it on a timer, so a change made in Agworld shows up on that map
// after the next sync with nobody touching the map.
//
// Settings live in publicMapFeed/settings (Admin/Owner only, set from Farm
// Map > Public feed):
//   enabled      false = the link answers 404
//   key          random string that must be on the link (?k=...), so the
//                link can be turned off or replaced without redeploying
//   year         'auto' (this calendar year) or a number such as 2027
//   show         { farm, crop, variety, acres } — what goes in the popups
//   groupBy      'crop' | 'farm' — folders in the Google Earth side panel
//   labelAcres   true = map label reads "FIELD · 120 ac"
//   includeHidden  true = also include fields on the subleased/archive farms
//   title        name of the top folder
//
// Requests:
//   ?k=KEY                 the KML itself (what the map program re-reads)
//   ?k=KEY&link=1          a small .kml file to open once in Google Earth;
//                          it holds a network link to the feed that refreshes
//                          every `refreshMinutes` (default 60)
//   ?k=KEY&format=json     a summary (counts and acres per crop) for the
//                          preview in AIO
//
// Lives in its own file (like agrimet.js) so uploading a new index.js can't
// wipe it out. index.js re-exports publicFieldsKml.

const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const DEFAULTS = {
  enabled: false, key: '', year: 'auto', groupBy: 'crop', labelAcres: false,
  includeHidden: false, refreshMinutes: 60, title: 'JK Farms fields',
  show: { farm: true, crop: true, variety: false, acres: true }
};

// Same fills as the Farm Map (mapMath.js CROP_COLOR) so every map matches.
const CROP_COLOR = {
  POTATO: '#795548', 'MINI POTATOES': '#A1887F', BEETS: '#097138', CORN: '#A52714', 'SWEET CORN': '#E65100',
  HAY: '#9C27B0', BARLEY: '#FFEA00', WHEAT: '#C0CA33', PUMPKINS: '#F9A825', MELONS: '#1A237E', BEANS: '#F48FB1',
  RYE: '#0F9D58', ONIONS: '#880E4F', MINT: '#26A69A', 'COVER / FLEX': '#673AB7', FALLOW: '#8D8A7E', OATS: '#AFB42B',
  PEAS: '#7CB342', TRITICALE: '#827717'
};
const NO_CROP = 'NO CROP ENTERED';
const NO_CROP_COLOR = '#BDBDBD';
const OTHER_COLOR = '#8D8A7E';

function canonCrop(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (/^(RENTED )?POTATO(ES)?$/.test(s)) return 'POTATO';
  if (/^MINI POTATO(ES)?$/.test(s)) return 'MINI POTATOES';
  if (/^(SUGAR ?)?BEETS?$/.test(s)) return 'BEETS';
  if (/^SWEET CORN$/.test(s)) return 'SWEET CORN';
  if (/^(FIELD |SILAGE |GRAIN )?CORN$/.test(s)) return 'CORN';
  if (/^HAY\b/.test(s) || s === 'TIMOTHY' || s === 'ALFALFA') return 'HAY';
  if (/^RYE\b/.test(s)) return 'RYE';
  if (/^BEANS?$/.test(s) || /\bBEANS?$/.test(s)) return 'BEANS';
  if (/^ONIONS?$/.test(s)) return 'ONIONS';
  if (/^MELONS?$|WATERMELON/.test(s)) return 'MELONS';
  if (/^PUMPKINS?$/.test(s)) return 'PUMPKINS';
  if (/WHEAT/.test(s)) return 'WHEAT';
  if (/^BARLEY/.test(s)) return 'BARLEY';
  if (/^OATS?$/.test(s)) return 'OATS';
  if (/^PEAS?$/.test(s)) return 'PEAS';
  if (/^MINT|PEPPERMINT|SPEARMINT/.test(s)) return 'MINT';
  if (/^FALLOW/.test(s)) return 'FALLOW';
  if (/COVER|FLEX/.test(s)) return 'COVER / FLEX';
  return s;
}
const cropColor = (c) => (c === NO_CROP ? NO_CROP_COLOR : CROP_COLOR[c] || OTHER_COLOR);
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase());

// KML colours are aabbggrr.
function kmlColor(hex, alpha) {
  const h = String(hex).replace('#', '');
  return alpha + h.slice(4, 6) + h.slice(2, 4) + h.slice(0, 2);
}
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const styleId = (crop) => 'c_' + crop.replace(/[^A-Z0-9]+/gi, '_');
const fmtAc = (n) => (Number.isFinite(n) ? Math.round(n).toLocaleString('en-US') : '');

function seasonYear(season) {
  const fromName = String(season.name || '').match(/\b(19|20)\d{2}\b/);
  if (fromName) return parseInt(fromName[0], 10);
  const d = season.startDate || season.endDate;
  return d ? parseInt(String(d).slice(0, 4), 10) : null;
}

// Area-weighted centre of a ring, for the label point.
function centroid(ring) {
  let a = 0, x = 0, y = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f;
  }
  if (!a) return ring[0];
  return [x / (3 * a), y / (3 * a)];
}

function mergeSettings(raw) {
  const s = { ...DEFAULTS, ...(raw || {}) };
  s.show = { ...DEFAULTS.show, ...((raw && raw.show) || {}) };
  return s;
}

// ---------------------------------------------------------------------------
// Pure builder: settings + the rows read from Firestore -> KML text.
// rows: [{ id, name, farm, crop, variety, acres, ring: [[lng,lat],...] }]
// ---------------------------------------------------------------------------
function buildKml(settings, rows, { year, seasonNames, updatedAt }) {
  const s = mergeSettings(settings);
  const groups = new Map();
  rows.forEach((r) => {
    const g = s.groupBy === 'farm' ? (r.farm || 'Other') : r.crop;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  });
  const crops = [...new Set(rows.map((r) => r.crop))];
  const styles = crops.map((c) => `
  <Style id="${styleId(c)}">
    <IconStyle><scale>0</scale></IconStyle>
    <LabelStyle><scale>0.8</scale></LabelStyle>
    <LineStyle><color>${kmlColor(cropColor(c), 'ff')}</color><width>2.5</width></LineStyle>
    <PolyStyle><color>${kmlColor(cropColor(c), '59')}</color></PolyStyle>
  </Style>`).join('');

  const when = updatedAt ? new Date(updatedAt).toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const placemark = (r) => {
    const rows = [];
    if (s.show.farm && r.farm) rows.push(['Farm', titleCase(r.farm)]);
    if (s.show.crop) rows.push(['Crop', r.crop === NO_CROP ? 'Not entered yet' : titleCase(r.crop)]);
    if (s.show.variety && r.variety) rows.push(['Variety', r.variety]);
    if (s.show.acres && Number.isFinite(r.acres)) rows.push(['Acres', fmtAc(r.acres)]);
    rows.push(['Crop year', String(year)]);
    const desc = `<table>${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>`;
    const label = s.labelAcres && s.show.acres && Number.isFinite(r.acres) ? `${r.name} · ${fmtAc(r.acres)} ac` : r.name;
    const coords = r.ring.map(([x, y]) => `${x},${y},0`).join(' ');
    const first = r.ring[0], last = r.ring[r.ring.length - 1];
    const closed = first[0] === last[0] && first[1] === last[1] ? coords : `${coords} ${first[0]},${first[1]},0`;
    const [cx, cy] = centroid(r.ring);
    return `
      <Placemark id="f${esc(r.id)}">
        <name>${esc(label)}</name>
        <description><![CDATA[${desc}]]></description>
        <styleUrl>#${styleId(r.crop)}</styleUrl>
        <MultiGeometry>
          <Point><coordinates>${cx.toFixed(6)},${cy.toFixed(6)},0</coordinates></Point>
          <Polygon><tessellate>1</tessellate><outerBoundaryIs><LinearRing><coordinates>${closed}</coordinates></LinearRing></outerBoundaryIs></Polygon>
        </MultiGeometry>
      </Placemark>`;
  };
  const folderName = (g, list) => {
    const label = s.groupBy === 'farm' ? titleCase(g) : g === NO_CROP ? 'No crop entered' : titleCase(g);
    const ac = list.reduce((t, r) => t + (Number.isFinite(r.acres) ? r.acres : 0), 0);
    return s.show.acres ? `${label} — ${fmtAc(ac)} ac` : label;
  };
  const order = [...groups.keys()].sort((a, b) => (a === NO_CROP) - (b === NO_CROP) || a.localeCompare(b));
  const folders = order.map((g) => {
    const list = groups.get(g).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    return `
    <Folder>
      <name>${esc(folderName(g, list))}</name>
      <open>0</open>${list.map(placemark).join('')}
    </Folder>`;
  }).join('');
  const docDesc = `${year} crop year from Agworld${seasonNames.length ? ` (${seasonNames.join(', ')})` : ''}${when ? `. Updated ${when}.` : '.'}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(`${s.title} ${year}`)}</name>
  <description>${esc(docDesc)}</description>
  <open>1</open>${styles}${folders}
</Document>
</kml>
`;
}

function buildNetworkLink(settings, feedUrl, year) {
  const s = mergeSettings(settings);
  const secs = Math.max(5, Number(s.refreshMinutes) || 60) * 60;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <NetworkLink>
    <name>${esc(s.title)} (live)</name>
    <open>1</open>
    <flyToView>1</flyToView>
    <Link>
      <href>${esc(feedUrl)}</href>
      <refreshMode>onInterval</refreshMode>
      <refreshInterval>${secs}</refreshInterval>
    </Link>
  </NetworkLink>
</kml>
`;
}

function summarize(rows, year, seasonNames) {
  const byCrop = {};
  rows.forEach((r) => {
    const c = byCrop[r.crop] || (byCrop[r.crop] = { crop: r.crop, color: cropColor(r.crop), fields: 0, acres: 0 });
    c.fields++; c.acres += Number.isFinite(r.acres) ? r.acres : 0;
  });
  return {
    year, seasonNames, fields: rows.length,
    acres: Math.round(rows.reduce((t, r) => t + (Number.isFinite(r.acres) ? r.acres : 0), 0)),
    crops: Object.values(byCrop).map((c) => ({ ...c, acres: Math.round(c.acres) })).sort((a, b) => b.acres - a.acres)
  };
}

// ---------------------------------------------------------------------------
// Firestore -> rows
// ---------------------------------------------------------------------------
async function loadRows(db, settings) {
  const s = mergeSettings(settings);
  const seasonsSnap = await db.collection('seasons').get();
  const seasons = seasonsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const thisYear = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Denver', year: 'numeric' }).format(new Date()), 10);
  const year = s.year === 'auto' || !s.year ? thisYear : Number(s.year);
  const picked = seasons.filter((x) => seasonYear(x) === year);
  const [fieldSnap, boundarySnap] = await Promise.all([db.collection('fields').get(), db.collection('fieldBoundaries').get()]);
  const boundaries = {};
  boundarySnap.forEach((d) => { boundaries[d.id] = d.data(); });
  const fields = fieldSnap.docs.filter((d) => s.includeHidden || !d.data().hiddenFromIrrigation);

  // Each field's season doc for the chosen year (a field Agworld doesn't
  // have in that season isn't on the map).
  const refs = [];
  fields.forEach((f) => picked.forEach((p) => refs.push(f.ref.collection('seasons').doc(String(p.id)))));
  const seasonDocs = {};
  for (let i = 0; i < refs.length; i += 300) {
    const got = refs.length ? await db.getAll(...refs.slice(i, i + 300)) : [];
    got.forEach((d) => { if (d.exists) seasonDocs[d.ref.parent.parent.id] = seasonDocs[d.ref.parent.parent.id] || d.data(); });
  }

  let latest = 0;
  const rows = [];
  fields.forEach((f) => {
    const sd = seasonDocs[f.id];
    const b = boundaries[f.id];
    if (!sd || !b || !b.boundary) return;
    let ring;
    try { ring = JSON.parse(b.boundary); } catch (e) { return; }
    if (!Array.isArray(ring) || ring.length < 3) return;
    const fd = f.data();
    const t = (sd.syncedFromAgworldAt && sd.syncedFromAgworldAt.toMillis) ? sd.syncedFromAgworldAt.toMillis() : 0;
    if (t > latest) latest = t;
    rows.push({
      id: f.id, name: fd.name || f.id, farm: fd.farmName || null,
      crop: canonCrop(sd.cropName) || NO_CROP, variety: sd.varietyName || null,
      acres: Number.isFinite(sd.acres) ? sd.acres : null, ring
    });
  });
  return { rows, year, seasonNames: picked.map((p) => p.name).filter(Boolean), updatedAt: latest || null };
}

// A short in-memory cache so a map program refreshing every few minutes, or
// a busy link, doesn't re-read every field each time.
let cache = null; // { sig, at, data }
const CACHE_MS = 10 * 60 * 1000;

exports.publicFieldsKml = onRequest({ cors: true, maxInstances: 3, timeoutSeconds: 60, memory: '512MiB' }, async (req, res) => {
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).send('GET only'); return; }
    const db = admin.firestore();
    const setSnap = await db.collection('publicMapFeed').doc('settings').get();
    const settings = mergeSettings(setSnap.exists ? setSnap.data() : null);
    const k = String(req.query.k || '');
    if (!settings.enabled || !settings.key || k !== settings.key) { res.status(404).send('Not found'); return; }

    const sig = JSON.stringify({ ...settings, updatedAt: setSnap.updateTime ? setSnap.updateTime.toMillis() : 0 });
    if (!cache || cache.sig !== sig || Date.now() - cache.at > CACHE_MS) {
      cache = { sig, at: Date.now(), data: await loadRows(db, settings) };
    }
    const { rows, year, seasonNames, updatedAt } = cache.data;
    res.set('Cache-Control', 'public, max-age=300');

    if (req.query.format === 'json') { res.json(summarize(rows, year, seasonNames)); return; }
    if (req.query.link) {
      // On the cloudfunctions.net address the function name is part of the
      // path; on its own run.app address it is not.
      const host = req.get('x-forwarded-host') || req.get('host');
      const base = /cloudfunctions\.net$/i.test(host) ? `https://${host}/publicFieldsKml` : `https://${host}`;
      const feedUrl = `${base}?k=${encodeURIComponent(k)}`;
      const file = `${settings.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'farm map'} (live).kml`;
      res.set('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${file}"`);
      res.send(buildNetworkLink(settings, feedUrl, year));
      return;
    }
    res.set('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="${year} fields.kml"`);
    res.send(buildKml(settings, rows, { year, seasonNames, updatedAt }));
  } catch (err) {
    console.error('publicFieldsKml failed', err);
    res.status(500).send('Map feed error');
  }
});

exports._test = { buildKml, buildNetworkLink, summarize, canonCrop, kmlColor, centroid, mergeSettings, loadRows };
