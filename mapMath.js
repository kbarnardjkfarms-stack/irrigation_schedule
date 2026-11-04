// Pure helpers for the Farm Map module (FarmMap*.jsx) — no React or Firebase.
//
//   - read a Google My Maps / Earth export (.kml or .kmz) into field outlines
//     and points (cellars, shops, beet dumps, houses…)
//   - read the Main Field Plan workbook's "Main" sheet into one row per field
//     with its crop for every year
//   - match outlines to plan rows by name, work out acres, colours, rotation

import { canonCrop, fieldKey } from './yieldMath.js'

// Name key: letters/digits only, and "SALMON 01" == "SALMON 1".
export function mapKey(name) {
  return fieldKey(String(name || '').replace(/\b0+(\d)/g, '$1'))
}

// ---------------------------------------------------------------------------
// Crops and colours. Colours are the fills on the JKF Google map, so the AIO
// map reads the same as the one the crew already knows.
// ---------------------------------------------------------------------------
export const CROP_COLOR = {
  POTATO: '#795548', 'MINI POTATOES': '#A1887F', BEETS: '#097138', CORN: '#A52714', 'SWEET CORN': '#E65100',
  HAY: '#9C27B0', BARLEY: '#FFEA00', WHEAT: '#C0CA33', PUMPKINS: '#F9A825', MELONS: '#1A237E', BEANS: '#F48FB1',
  RYE: '#0F9D58', ONIONS: '#880E4F', MINT: '#26A69A', 'COVER / FLEX': '#673AB7', FALLOW: '#8D8A7E', OATS: '#AFB42B',
  PEAS: '#7CB342', TRITICALE: '#827717'
}
export const cropColor = (c) => CROP_COLOR[c] || '#8D8A7E'
// The plan spells crops its own way ("Rye Chop", "BWCC Flex", "onions") — fold
// them onto the same names Yields and Contracts use.
export function planCrop(raw) {
  const s = String(raw ?? '').trim()
  if (!s || /^(0|no|none|n\/a|-)$/i.test(s)) return null
  if (/^rye/i.test(s)) return 'RYE'
  if (/bwcc|flex|cover/i.test(s)) return 'COVER / FLEX'
  if (/^fallow/i.test(s)) return 'FALLOW'
  if (/^mint/i.test(s)) return 'MINT'
  if (/^wheat|wheat$/i.test(s)) return 'WHEAT'
  if (/^barley/i.test(s)) return 'BARLEY'
  return canonCrop(s)
}
export const cropLabel = (c) => (c ? c.charAt(0) + c.slice(1).toLowerCase() : '—')

// ---------------------------------------------------------------------------
// Geometry. Rings are [[lng, lat], …]. Firestore can't hold arrays of arrays,
// so a ring is stored as { c: [lng, lat, lng, lat, …], hole?: true }.
// ---------------------------------------------------------------------------
export const packRing = (ring, hole) => ({ c: ring.flatMap(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]), ...(hole ? { hole: true } : {}) })
export function unpackRing(r) {
  const out = []
  for (let i = 0; i + 1 < (r.c || []).length; i += 2) out.push([r.c[i], r.c[i + 1]])
  return out
}
// Acres of a ring (local flat projection — plenty for a field).
export function ringAcres(ring) {
  if (!ring || ring.length < 3) return 0
  const R = 6378137
  const lat0 = (ring.reduce((s, p) => s + p[1], 0) / ring.length) * Math.PI / 180
  let a = 0
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i], [x2, y2] = ring[(i + 1) % ring.length]
    a += (x1 * Math.PI / 180 * R * Math.cos(lat0)) * (y2 * Math.PI / 180 * R) - (x2 * Math.PI / 180 * R * Math.cos(lat0)) * (y1 * Math.PI / 180 * R)
  }
  return Math.abs(a) / 2 / 4046.8564
}
export function shapeAcres(rings) {
  return Math.round(rings.reduce((s, r) => s + (r.hole ? -1 : 1) * ringAcres(r.pts || r), 0) * 10) / 10
}
export function centroid(ring) {
  let x = 0, y = 0
  ring.forEach((p) => { x += p[0]; y += p[1] })
  return [x / ring.length, y / ring.length]
}
// Douglas–Peucker, tolerance in degrees (~0.00002° ≈ 2 m).
export function simplify(pts, eps = 0.00002) {
  if (pts.length < 6) return pts
  const d = ([x, y], [x1, y1], [x2, y2]) => {
    const dx = x2 - x1, dy = y2 - y1
    if (!dx && !dy) return Math.hypot(x - x1, y - y1)
    const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return Math.hypot(x - x1 - t * dx, y - y1 - t * dy)
  }
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1
  const stack = [[0, pts.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()
    let idx = -1, max = 0
    for (let i = a + 1; i < b; i++) { const dd = d(pts[i], pts[a], pts[b]); if (dd > max) { max = dd; idx = i } }
    if (max > eps && idx > 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]) }
  }
  return pts.filter((_, i) => keep[i])
}
// A pivot circle: center [lng, lat] and a point on the edge.
export function circleRing(center, edge, n = 72) {
  const [cx, cy] = center
  const k = Math.cos(cy * Math.PI / 180)
  const r = Math.hypot((edge[0] - cx) * k, edge[1] - cy)
  const out = []
  for (let i = 0; i < n; i++) { const t = (i / n) * 2 * Math.PI; out.push([cx + (r * Math.cos(t)) / k, cy + r * Math.sin(t)]) }
  return out
}

// ---------------------------------------------------------------------------
// KML / KMZ
// ---------------------------------------------------------------------------
// KMZ is a zip. Read it with the browser's own inflate (no extra library).
export async function kmzToKml(buf) {
  const v = new DataView(buf)
  let eocd = -1
  for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break }
  if (eocd < 0) throw new Error('That doesn’t look like a KMZ file.')
  const count = v.getUint16(eocd + 10, true)
  let p = v.getUint32(eocd + 16, true)
  const dec = new TextDecoder()
  const entries = []
  for (let n = 0; n < count; n++) {
    const method = v.getUint16(p + 10, true), csize = v.getUint32(p + 20, true)
    const nameLen = v.getUint16(p + 28, true), extra = v.getUint16(p + 30, true), comment = v.getUint16(p + 32, true)
    const local = v.getUint32(p + 42, true)
    const name = dec.decode(new Uint8Array(buf, p + 46, nameLen))
    entries.push({ name, method, csize, local })
    p += 46 + nameLen + extra + comment
  }
  const e = entries.find((x) => /doc\.kml$/i.test(x.name)) || entries.find((x) => /\.kml$/i.test(x.name))
  if (!e) throw new Error('No .kml inside that KMZ.')
  const start = e.local + 30 + v.getUint16(e.local + 26, true) + v.getUint16(e.local + 28, true)
  const data = new Uint8Array(buf, start, e.csize)
  if (e.method === 0) return dec.decode(data)
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser can’t open KMZ files — export as KML instead.')
  const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
  return await new Response(stream).text()
}

const POINT_TYPES = [
  [/CELLAR/i, 'Cellar'], [/BEET DUMP|PILER/i, 'Beet dump'], [/SHOP/i, 'Shop'], [/FUEL/i, 'Fuel'], [/JUG DROP/i, 'Jug drop'],
  [/OFFICE/i, 'Office'], [/HOUSE|WIDE|HOTEL|HOME|BUNK/i, 'Housing'], [/TRANSLOAD/i, 'Transload'], [/PUMP|WELL/i, 'Pump']
]
export const pointType = (name) => (POINT_TYPES.find(([re]) => re.test(name)) || [null, 'Other'])[1]
// Whole-name matches only: "NORTH CANAL" and "DRY CREEK ALPHA" are farmed fields.
const OTHER_AREA = /^\s*(CREP\b.*|CANAL|CANYON RIM|DRY|ROAD|YARD|DITCH|POND|RESERVOIR)\s*$/i

// Returns { fields: [{ name, farm, rings: [{ pts, hole }], desc }], points: [{ name, farm, lat, lng, type }] }
export function parseKml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml')
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Couldn’t read that KML file.')
  const coords = (el) => (el ? el.textContent.trim().split(/\s+/).map((t) => t.split(',').map(Number)).filter((a) => isFinite(a[0]) && isFinite(a[1])).map((a) => [a[0], a[1]]) : [])
  const kids = (el, tag) => Array.from(el.children || []).filter((c) => c.localName === tag)
  const first = (el, tag) => el.getElementsByTagNameNS('*', tag)[0] || null
  const fields = [], points = []
  const walk = (el, farm) => {
    for (const ch of Array.from(el.children || [])) {
      if (ch.localName === 'Folder' || ch.localName === 'Document') {
        const nm = kids(ch, 'name')[0]
        walk(ch, ch.localName === 'Folder' && nm ? nm.textContent.trim() : farm)
      } else if (ch.localName === 'Placemark') {
        const name = ((kids(ch, 'name')[0] || {}).textContent || '').trim()
        let desc = ''
        Array.from(ch.getElementsByTagNameNS('*', 'Data')).forEach((d) => { if (/description|ZGVzY3JpcHRpb24/i.test(d.getAttribute('name') || '')) desc = (first(d, 'value') || {}).textContent || desc })
        if (!desc) desc = ((kids(ch, 'description')[0] || {}).textContent || '')
        const polys = Array.from(ch.getElementsByTagNameNS('*', 'Polygon'))
        if (polys.length) {
          const rings = []
          polys.forEach((pg) => {
            const outer = first(first(pg, 'outerBoundaryIs') || pg, 'coordinates')
            const o = simplify(coords(outer))
            if (o.length >= 3) rings.push({ pts: o })
            Array.from(pg.getElementsByTagNameNS('*', 'innerBoundaryIs')).forEach((ib) => {
              const h = simplify(coords(first(ib, 'coordinates')))
              if (h.length >= 3) rings.push({ pts: h, hole: true })
            })
          })
          if (rings.length) fields.push({ name: name || 'Unnamed', farm: cleanFarm(farm), rings, desc })
          continue
        }
        const pt = first(ch, 'Point')
        if (pt) {
          const c = coords(first(pt, 'coordinates'))[0]
          if (c) points.push({ name: name || 'Unnamed', farm: cleanFarm(farm), lng: c[0], lat: c[1], type: pointType(name) })
        }
      }
    }
  }
  walk(doc.documentElement, '')
  return { fields, points }
}
export const cleanFarm = (f) => String(f || '').replace(/\s+FARM$/i, '').trim().replace(/\b\w+/g, (w) => (w.length <= 2 ? w.toUpperCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())) || 'Unassigned'
export const isOtherArea = (name) => OTHER_AREA.test(name)

// Crops written into the map description ("2026 Crop: Hay") — used only when
// there's no plan row for the field.
export function cropsFromDesc(desc) {
  const out = {}
  String(desc || '').replace(/(\d{4})\s*Crop\s*[:;]\s*([^\n<]*)/gi, (_, y, c) => { const v = planCrop(c); if (v) out[y] = v; return '' })
  return out
}

// ---------------------------------------------------------------------------
// Main Field Plan ("Main" sheet). Header row has "Field" and "Farm"; crop
// columns are "2027 Crop", "2026 Crop", … The plan year is the newest one.
// ---------------------------------------------------------------------------
const PLAN_COLS = {
  field: ['field'], farm: ['farm'], entity: ['entity'], acres: ['acres'],
  organic: ['organic or conventional'], plantback: ['plantback chemical restriction'], pests: ['long standing pest/weed issues'],
  soil: ['sand/dirt'], lastPotato: ['last potato crop or convention'], prevPotato: ['previous pot years-'],
  area: ['area'], delivery: ['delivery'], buyer: ['buyer'], cellar: ['cellar'], variety: ['variety'], subVariety: ['sub variety'],
  harvester: ['custom harvester'], rowDirection: ['row direction'], yieldProjection: ['yield projection'], improvements: [/improvements$/],
  cornerPlan: [/corner plan$/], hayFall: [/^hay fall of/]
}
export function parseMainPlan(rows) {
  const hIdx = rows.findIndex((r) => r && r.some((c) => String(c || '').trim().toLowerCase() === 'field') && r.some((c) => String(c || '').trim().toLowerCase() === 'farm'))
  if (hIdx < 0) throw new Error('Couldn’t find the header row (needs “Field” and “Farm”) on the Main sheet.')
  const head = rows[hIdx].map((c) => String(c || '').trim().toLowerCase())
  const col = {}
  Object.entries(PLAN_COLS).forEach(([k, names]) => {
    const i = head.findIndex((h) => names.some((n) => (n instanceof RegExp ? n.test(h) : h === n)))
    if (i >= 0) col[k] = i
  })
  const cropCols = []
  head.forEach((h, i) => { const m = h.match(/^(\d{4}) crop$/); if (m) cropCols.push([m[1], i]) })
  const eligCols = []
  head.forEach((h, i) => { const m = h.match(/^(\d{4}) potato eligible/); if (m) eligCols.push([m[1], i]) })
  if (!cropCols.length) throw new Error('No “2027 Crop”-style columns on the Main sheet.')
  const planYear = Math.max(...cropCols.map(([y]) => +y))
  const out = []
  const seen = {}
  for (const r of rows.slice(hIdx + 1)) {
    if (!r) continue
    const name = String(r[col.field] ?? '').trim()
    const farm = String(r[col.farm] ?? '').trim()
    if (!name || !farm) continue // totals / notes rows have no farm
    const v = (k) => { const x = col[k] == null ? null : r[col[k]]; return x == null || String(x).trim() === '' || String(x).trim() === '0' ? null : (typeof x === 'number' ? x : String(x).trim()) }
    const crops = {}
    cropCols.forEach(([y, i]) => { const c = planCrop(r[i]); if (c) crops[y] = c })
    const elig = {}
    eligCols.forEach(([y, i]) => { if (r[i] != null && String(r[i]).trim() !== '') elig[y] = String(r[i]).trim() })
    let key = mapKey(name)
    seen[key] = (seen[key] || 0) + 1
    if (seen[key] > 1) key = `${key}_${seen[key]}`
    out.push({
      key, field: name, farm, planYear, crops, potatoEligible: elig,
      acres: typeof v('acres') === 'number' ? v('acres') : Number(v('acres')) || null,
      entity: v('entity'), organic: v('organic'), plantback: v('plantback'), pests: v('pests'), soil: v('soil'),
      lastPotato: v('lastPotato'), prevPotato: v('prevPotato'), area: v('area'), delivery: v('delivery'), buyer: v('buyer'),
      cellar: v('cellar'), variety: v('variety'), subVariety: v('subVariety'), harvester: v('harvester'), rowDirection: v('rowDirection'),
      yieldProjection: v('yieldProjection'), improvements: v('improvements'), cornerPlan: v('cornerPlan'), hayFall: v('hayFall')
    })
  }
  return { planYear, rows: out, years: cropCols.map(([y]) => +y).sort() }
}

// Which plan row an outline belongs to: a manual link wins, then the exact
// name, then the longest plan name the outline's name starts with
// ("CHUGG NORTH" → "CHUGG").
export function matchPlan(field, planByKey) {
  if (field.planKey && planByKey[field.planKey]) return { row: planByKey[field.planKey], how: 'linked' }
  const k = mapKey(field.name)
  if (planByKey[k]) return { row: planByKey[k], how: 'name' }
  let best = null
  for (const pk of Object.keys(planByKey)) if (pk.length >= 3 && k.startsWith(pk) && (!best || pk.length > best.length)) best = pk
  return best ? { row: planByKey[best], how: 'part' } : { row: null, how: null }
}

// Crop for a year: the plan (which also carries history columns), then what
// the Yields module recorded, then the map's own description.
export function cropFor(f, year) {
  const y = String(year)
  if (f.plan && f.plan.crops && f.plan.crops[y]) return { crop: f.plan.crops[y], src: +y >= (f.plan.planYear || 0) ? 'plan' : 'plan history' }
  if (f.yieldCrops && f.yieldCrops[y]) return { crop: f.yieldCrops[y], src: 'yield record' }
  if (f.descCrops && f.descCrops[y]) return { crop: f.descCrops[y], src: 'map note' }
  return { crop: null, src: null }
}
export function lastPotatoYear(f, year) {
  for (let y = year; y >= year - 25; y--) { const c = cropFor(f, y).crop; if (c === 'POTATO' || c === 'MINI POTATOES') return y }
  const n = parseInt(String((f.plan && f.plan.lastPotato) || '').slice(0, 4), 10)
  return n > 1990 && n <= year ? n : null
}
export const POT_BUCKETS = [
  ['Potatoes this year', '#4A2E12'], ['1 year out', '#8C5A2B'], ['2 years out', '#C9A26B'],
  ['3 years out', '#E3CF9F'], ['4+ years out', '#8FBF7A'], ['No potatoes on record', '#3C6E47']
]
export function potBucket(f, year) {
  const lp = lastPotatoYear(f, year)
  if (lp == null) return 5
  return Math.min(4, Math.max(0, year - lp))
}
