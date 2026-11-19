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
//   show         { farm, crop, variety, acres } — what goes in the popups;
//                pins: the Farm Map pins (farmPoints: houses, fuel, beet dumps,
//                cellars…) in a Places folder; pinNotes: their notes too
//   groupBy      'crop' | 'farm' — folders in the Google Earth side panel
//   labelAcres   true = map label reads "FIELD · 120 ac"
//   includeHidden  true = also include fields on the subleased/archive farms
//   title        name of the top folder
//
// Requests:
//   ?k=KEY                 opened in a web browser: a map page (satellite,
//                          field outlines in crop colours, pins, directions
//                          to Google Maps) — anyone can click it on a phone.
//                          From Google Earth / QGIS (no text/html in Accept):
//                          the KML itself (what the map program re-reads)
//   ?k=KEY&map=1           always the map page;  ?k=KEY&kml=1  always the KML
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
  show: { farm: true, crop: true, variety: false, acres: true, pins: true, pinNotes: false }
};

// Farm Map pin types (mapMath.js PIN_TYPES) -> Google Earth icon + colour.
const GE = 'http://maps.google.com/mapfiles/kml/shapes/';
const PIN_TYPES = [
  ['Housing', '#2A6FD6', 'homegardenbusiness.png'], ['Fuel', '#D23B3B', 'gas_stations.png'], ['Beet dump', '#097138', 'truck.png'],
  ['Cellar', '#C17A3B', 'placemark_square.png'], ['Shop', '#5B5F66', 'mechanic.png'], ['Office', '#7B4FC9', 'placemark_square.png'],
  ['Scale', '#8C6D1F', 'placemark_square.png'], ['Pump', '#185FA5', 'water.png'], ['Jug drop', '#0F8C8C', 'triangle.png'],
  ['Transload', '#E8801A', 'truck.png'], ['Gate', '#6B8E23', 'flag.png'], ['Other', '#333333', 'placemark_circle.png']
];
const pinType = (t) => PIN_TYPES.find(([n]) => n === t) || PIN_TYPES[PIN_TYPES.length - 1];
const pinStyleId = (t) => 'p_' + pinType(t)[0].replace(/[^A-Z0-9]+/gi, '_');

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
function buildKml(settings, rows, { year, seasonNames, updatedAt, pins = [] }) {
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
  // Pins: a Places folder, one sub-folder per type.
  let pinStyles = '', pinFolder = '';
  if (s.show.pins && pins.length) {
    const types = [...new Set(pins.map((p) => pinType(p.type)[0]))];
    pinStyles = types.map((t) => {
      const [, color, icon] = pinType(t);
      return `
  <Style id="${pinStyleId(t)}">
    <IconStyle><color>${kmlColor(color, 'ff')}</color><scale>1.1</scale><Icon><href>${GE}${icon}</href></Icon></IconStyle>
    <LabelStyle><scale>0.75</scale></LabelStyle>
  </Style>`;
    }).join('');
    const pinMark = (p) => {
      const rows = [['Type', pinType(p.type)[0]]];
      if (p.farm && s.show.farm) rows.push(['Farm', titleCase(p.farm)]);
      if (p.notes && s.show.pinNotes) rows.push(['Notes', p.notes]);
      const desc = `<table>${rows.map(([k, v]) => `<tr><td><b>${esc(k)}</b></td><td>${esc(v)}</td></tr>`).join('')}</table>`;
      return `
        <Placemark id="p${esc(p.id)}">
          <name>${esc(p.name)}</name>
          <description><![CDATA[${desc}]]></description>
          <styleUrl>#${pinStyleId(p.type)}</styleUrl>
          <Point><coordinates>${Number(p.lng).toFixed(6)},${Number(p.lat).toFixed(6)},0</coordinates></Point>
        </Placemark>`;
    };
    const sub = PIN_TYPES.map(([t]) => t).filter((t) => types.includes(t)).map((t) => {
      const list = pins.filter((p) => pinType(p.type)[0] === t).sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true }));
      return `
      <Folder>
        <name>${esc(t)} (${list.length})</name>
        <open>0</open>${list.map(pinMark).join('')}
      </Folder>`;
    }).join('');
    pinFolder = `
    <Folder>
      <name>Places</name>
      <open>0</open>${sub}
    </Folder>`;
  }
  const docDesc = `${year} crop year from Agworld${seasonNames.length ? ` (${seasonNames.join(', ')})` : ''}${when ? `. Updated ${when}.` : '.'}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
<Document>
  <name>${esc(`${s.title} ${year}`)}</name>
  <description>${esc(docDesc)}</description>
  <open>1</open>${styles}${pinStyles}${folders}${pinFolder}
</Document>
</kml>
`;
}

// ---------------------------------------------------------------------------
// Map page: one self-contained HTML page (Leaflet from cdnjs, Esri imagery)
// with the fields and pins written into it.
// ---------------------------------------------------------------------------
const PIN_ICON = { Housing: '🏠', Fuel: '⛽', 'Beet dump': '🚚', Cellar: '🥔', Shop: '🔧', Office: '🏢', Scale: '⚖️', Pump: '💧', 'Jug drop': '🧴', Transload: '🔄', Gate: '🚧', Other: '📍' };
const r5 = (n) => Math.round(n * 1e5) / 1e5;
function buildMapPage(settings, rows, { year, updatedAt, pins = [] }) {
  const s = mergeSettings(settings);
  const fields = rows.map((r) => {
    const o = { n: r.name, c: r.crop, g: r.ring.map(([x, y]) => [r5(y), r5(x)]) };
    if (s.show.farm && r.farm) o.f = titleCase(r.farm);
    if (s.show.variety && r.variety) o.v = r.variety;
    if (s.show.acres && Number.isFinite(r.acres)) o.a = Math.round(r.acres * 10) / 10;
    if (!s.show.crop) delete o.c;
    return o;
  });
  const places = s.show.pins ? pins.map((p) => {
    const [t, color] = pinType(p.type);
    const o = { n: p.name, t, k: color, i: PIN_ICON[t] || '📍', p: [r5(p.lat), r5(p.lng)] };
    if (s.show.farm && p.farm) o.f = titleCase(p.farm);
    if (s.show.pinNotes && p.notes) o.x = p.notes;
    return o;
  }) : [];
  const crops = {};
  rows.forEach((r) => { const c = crops[r.crop] || (crops[r.crop] = { color: cropColor(r.crop), acres: 0, n: 0 }); c.acres += Number.isFinite(r.acres) ? r.acres : 0; c.n++; });
  const when = updatedAt ? new Date(updatedAt).toLocaleDateString('en-US', { timeZone: 'America/Denver', month: 'short', day: 'numeric', year: 'numeric' }) : null;
  const data = { title: `${s.title} ${year}`, year, when, fields, places, crops: s.show.crop ? crops : {}, showAcres: !!s.show.acres, colors: CROP_COLOR, none: NO_CROP };
  const json = JSON.stringify(data).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(data.title)}</title>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">
<style>
  html,body{margin:0;height:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#1d1d1b}
  #map{position:absolute;inset:0}
  .bar{position:absolute;z-index:1000;left:10px;top:10px;right:60px;display:flex;gap:6px;flex-wrap:wrap;align-items:center;pointer-events:none}
  .bar>*{pointer-events:auto}
  .ttl{background:#fff;border-radius:8px;padding:7px 11px;font-weight:700;font-size:14px;box-shadow:0 1px 5px rgba(0,0,0,.35)}
  .ttl small{display:block;font-weight:400;color:#777;font-size:11px}
  #q{flex:1;min-width:140px;max-width:280px;font:inherit;font-size:14px;padding:8px 10px;border:none;border-radius:8px;box-shadow:0 1px 5px rgba(0,0,0,.35)}
  .btns{position:absolute;z-index:1000;right:10px;bottom:24px;display:flex;flex-direction:column;gap:6px}
  .btns button,.lg-t{font:inherit;font-size:13px;background:#fff;border:none;border-radius:8px;padding:8px 11px;box-shadow:0 1px 5px rgba(0,0,0,.35);cursor:pointer}
  .lg{position:absolute;z-index:1000;left:10px;bottom:24px;background:#fff;border-radius:8px;box-shadow:0 1px 5px rgba(0,0,0,.35);font-size:12.5px;max-height:45vh;overflow:auto;max-width:min(260px,calc(100vw - 120px))}
  .lg-t{box-shadow:none;width:100%;text-align:left;font-weight:600}
  .lg-b{padding:0 10px 8px}
  .lg-r{display:flex;align-items:center;gap:6px;padding:2px 0;cursor:pointer;user-select:none}
  .lg-r.off{opacity:.35}
  .lg-r i{width:14px;height:14px;border-radius:3px;flex:none}
  .lg-r span:last-child{margin-left:auto;color:#777;font-variant-numeric:tabular-nums;padding-left:8px}
  .lbl{background:transparent;border:none;box-shadow:none;color:#fff;font-weight:700;font-size:11px;text-shadow:0 0 3px #000,0 0 2px #000;padding:0;white-space:nowrap}
  .lbl::before{display:none}
  .pin{background:none;border:none}
  .pin span{position:absolute;left:1px;top:0;width:28px;height:28px;border-radius:50% 50% 50% 0;transform:rotate(-45deg);border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;box-sizing:border-box}
  .pin i{transform:rotate(45deg);font-style:normal;font-size:14px;line-height:1}
  .pop b{font-size:15px}.pop table{border-collapse:collapse;margin:4px 0 6px}.pop td{padding:1px 8px 1px 0;font-size:12.5px}.pop td:first-child{color:#777}
  .pop .nt{white-space:pre-wrap;font-size:12.5px;margin:4px 0 6px}
  .go{display:inline-block;background:#1a73e8;color:#fff!important;text-decoration:none;border-radius:6px;padding:6px 10px;font-size:12.5px;font-weight:600}
  .me{width:14px;height:14px;border-radius:50%;background:#1a73e8;border:3px solid #fff;box-shadow:0 0 0 2px rgba(26,115,232,.35)}
</style></head><body>
<div id="map"></div>
<div class="bar"><div class="ttl">${esc(data.title)}<small>${when ? `Updated ${esc(when)}` : ''}</small></div><input id="q" list="names" placeholder="Find a field or place…" autocomplete="off"><datalist id="names"></datalist></div>
<div class="btns"><button id="me">◎ My location</button><button id="base">Map</button></div>
<div class="lg" id="lg"></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js"></script>
<script>
const D = ${json};
const map = L.map('map', { zoomControl: false }).setView([42.6, -113.8], 10);
L.control.zoom({ position: 'topright' }).addTo(map);
const sat = L.layerGroup([
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, attribution: 'Imagery &copy; Esri' }),
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19, opacity: 0.8 }),
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', { maxZoom: 20, maxNativeZoom: 19 })
]).addTo(map);
const road = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 20, maxNativeZoom: 19, attribution: '&copy; OpenStreetMap' });
let onSat = true;
document.getElementById('base').onclick = (e) => { onSat = !onSat; if (onSat) { map.removeLayer(road); sat.addTo(map) } else { map.removeLayer(sat); road.addTo(map) } e.target.textContent = onSat ? 'Map' : 'Satellite' };
const h = (x) => String(x == null ? '' : x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const color = (c) => c == null ? '#E8801A' : c === D.none ? '#BDBDBD' : (D.colors[c] || '#8D8A7E');
const title = (c) => c === D.none ? 'No crop entered' : String(c).toLowerCase().replace(/\\b[a-z]/g, (m) => m.toUpperCase());
const dir = (ll) => '<a class="go" target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=' + ll[0] + ',' + ll[1] + '">Directions in Google Maps</a>';
const rowsHtml = (rows) => rows.length ? '<table>' + rows.map(([k, v]) => '<tr><td>' + h(k) + '</td><td>' + h(v) + '</td></tr>').join('') + '</table>' : '';
const names = [], byName = {};
const fieldLayer = L.featureGroup().addTo(map), byCrop = {};
D.fields.forEach((f) => {
  const col = color(f.c);
  const poly = L.polygon(f.g, { color: col, weight: 2, fillColor: col, fillOpacity: 0.35 });
  const c = poly.getBounds().getCenter();
  const rows = [];
  if (f.f) rows.push(['Farm', f.f]);
  if (f.c) rows.push(['Crop', title(f.c)]);
  if (f.v) rows.push(['Variety', f.v]);
  if (f.a != null) rows.push(['Acres', f.a.toLocaleString()]);
  poly.bindPopup('<div class="pop"><b>' + h(f.n) + '</b>' + rowsHtml(rows) + dir([c.lat.toFixed(5), c.lng.toFixed(5)]) + '</div>');
  poly.bindTooltip(h(f.n), { permanent: true, direction: 'center', className: 'lbl', interactive: false });
  fieldLayer.addLayer(poly);
  (byCrop[f.c] = byCrop[f.c] || []).push(poly);
  names.push(f.n); byName[f.n.toLowerCase()] = { poly };
});
const pinLayer = L.layerGroup().addTo(map);
D.places.forEach((p) => {
  const m = L.marker(p.p, { icon: L.divIcon({ className: 'pin', iconSize: [30, 38], iconAnchor: [15, 36], popupAnchor: [0, -32], html: '<span style="background:' + p.k + '"><i>' + p.i + '</i></span>' }) });
  const rows = [['Type', p.t]]; if (p.f) rows.push(['Farm', p.f]);
  m.bindPopup('<div class="pop"><b>' + h(p.n) + '</b>' + rowsHtml(rows) + (p.x ? '<div class="nt">' + h(p.x) + '</div>' : '') + dir(p.p) + '</div>');
  m.bindTooltip(h(p.n), { direction: 'top', offset: [0, -30] });
  pinLayer.addLayer(m);
  const nm = p.i + ' ' + p.n; names.push(nm); byName[nm.toLowerCase()] = { m };
});
const labels = () => { const show = map.getZoom() >= 14; fieldLayer.eachLayer((l) => { const t = l.getTooltip(); if (t) t.setOpacity(show ? 1 : 0) }); if (map.getZoom() < 10) map.removeLayer(pinLayer); else if (!map.hasLayer(pinLayer)) pinLayer.addTo(map) };
map.on('zoomend', labels);
if (fieldLayer.getLayers().length) map.fitBounds(fieldLayer.getBounds(), { padding: [20, 20] }); else if (D.places.length) map.fitBounds(L.latLngBounds(D.places.map((p) => p.p)), { padding: [40, 40] });
labels();
// search
const dl = document.getElementById('names');
names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach((n) => { const o = document.createElement('option'); o.value = n; dl.appendChild(o) });
document.getElementById('q').addEventListener('input', (e) => {
  const hit = byName[e.target.value.toLowerCase()]; if (!hit) return;
  if (hit.poly) { map.fitBounds(hit.poly.getBounds(), { maxZoom: 16 }); hit.poly.openPopup() }
  else { map.setView(hit.m.getLatLng(), 16); if (!map.hasLayer(pinLayer)) pinLayer.addTo(map); hit.m.openPopup() }
  e.target.value = ''; e.target.blur();
});
// my location
let meDot = null;
document.getElementById('me').onclick = () => map.locate({ setView: true, maxZoom: 16, enableHighAccuracy: true });
map.on('locationfound', (e) => { if (meDot) map.removeLayer(meDot); meDot = L.marker(e.latlng, { icon: L.divIcon({ className: 'me', iconSize: [20, 20] }) }).addTo(map) });
map.on('locationerror', () => alert('Couldn’t get your location — check the browser’s location permission.'));
// legend
const lg = document.getElementById('lg');
const crops = Object.entries(D.crops).sort((a, b) => b[1].acres - a[1].acres);
if (crops.length || D.places.length) {
  let open = window.innerWidth > 700;
  const off = new Set();
  const draw = () => {
    lg.innerHTML = '<button class="lg-t">' + (open ? '▾' : '▸') + ' Legend</button>' + (open ? '<div class="lg-b">' + crops.map(([c, v]) =>
      '<div class="lg-r' + (off.has(c) ? ' off' : '') + '" data-c="' + h(c) + '"><i style="background:' + v.color + '"></i><span>' + h(title(c)) + '</span><span>' + (D.showAcres ? Math.round(v.acres).toLocaleString() + ' ac' : v.n) + '</span></div>').join('') +
      (D.places.length ? '<div class="lg-r' + (off.has('__pins') ? ' off' : '') + '" data-c="__pins"><i style="background:#fff;border:1px solid #aaa"></i><span>📍 Places</span><span>' + D.places.length + '</span></div>' : '') + '</div>' : '');
    lg.querySelector('.lg-t').onclick = () => { open = !open; draw() };
    lg.querySelectorAll('.lg-r').forEach((r) => r.onclick = () => {
      const c = r.dataset.c;
      if (off.has(c)) off.delete(c); else off.add(c);
      if (c === '__pins') { if (off.has(c)) map.removeLayer(pinLayer); else pinLayer.addTo(map) }
      else (byCrop[c] || []).forEach((p) => off.has(c) ? fieldLayer.removeLayer(p) : fieldLayer.addLayer(p));
      draw();
    });
  };
  draw();
}
</script>
</body></html>
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

function summarize(rows, year, seasonNames, pins = [], settings = null) {
  const byCrop = {};
  rows.forEach((r) => {
    const c = byCrop[r.crop] || (byCrop[r.crop] = { crop: r.crop, color: cropColor(r.crop), fields: 0, acres: 0 });
    c.fields++; c.acres += Number.isFinite(r.acres) ? r.acres : 0;
  });
  return {
    year, seasonNames, fields: rows.length,
    acres: Math.round(rows.reduce((t, r) => t + (Number.isFinite(r.acres) ? r.acres : 0), 0)),
    crops: Object.values(byCrop).map((c) => ({ ...c, acres: Math.round(c.acres) })).sort((a, b) => b.acres - a.acres),
    pins: settings && !mergeSettings(settings).show.pins ? 0 : pins.length
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
  const [fieldSnap, boundarySnap, pinSnap] = await Promise.all([db.collection('fields').get(), db.collection('fieldBoundaries').get(), db.collection('farmPoints').get()]);
  const pins = [];
  pinSnap.forEach((d) => {
    const p = d.data();
    if (Number.isFinite(p.lat) && Number.isFinite(p.lng)) pins.push({ id: d.id, name: p.name || p.type || 'Pin', type: p.type || 'Other', farm: p.farm || null, notes: p.notes || null, lat: p.lat, lng: p.lng });
  });
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
  return { rows, pins, year, seasonNames: picked.map((p) => p.name).filter(Boolean), updatedAt: latest || null };
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
    const { rows, pins, year, seasonNames, updatedAt } = cache.data;
    res.set('Cache-Control', 'public, max-age=300');
    res.set('Vary', 'Accept, User-Agent');

    if (req.query.format === 'json') { res.json(summarize(rows, year, seasonNames, pins, settings)); return; }
    // A person in a web browser gets the map page; Google Earth, QGIS and
    // the like (no text/html in Accept, or a GoogleEarth user agent) get KML.
    const wantsPage = req.query.map || (!req.query.kml && !req.query.link
      && /text\/html/i.test(req.get('accept') || '') && !/GoogleEarth|Google-Earth/i.test(req.get('user-agent') || ''));
    if (wantsPage) {
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Vary', 'Accept, User-Agent');
      res.send(buildMapPage(settings, rows, { year, updatedAt, pins }));
      return;
    }
    if (req.query.link) {
      // On the cloudfunctions.net address the function name is part of the
      // path; on its own run.app address it is not.
      const host = req.get('x-forwarded-host') || req.get('host');
      const base = /cloudfunctions\.net$/i.test(host) ? `https://${host}/publicFieldsKml` : `https://${host}`;
      const feedUrl = `${base}?k=${encodeURIComponent(k)}&kml=1`;
      const file = `${settings.title.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'farm map'} (live).kml`;
      res.set('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${file}"`);
      res.send(buildNetworkLink(settings, feedUrl, year));
      return;
    }
    res.set('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.set('Content-Disposition', `inline; filename="${year} fields.kml"`);
    res.send(buildKml(settings, rows, { year, seasonNames, updatedAt, pins }));
  } catch (err) {
    console.error('publicFieldsKml failed', err);
    res.status(500).send('Map feed error');
  }
});

exports._test = { buildMapPage, buildKml, buildNetworkLink, summarize, canonCrop, kmlColor, centroid, mergeSettings, loadRows };
