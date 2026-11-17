// Pure math for Contracts > Storage plan — no React or Firebase.
//
// Pieces:
//   bayCapacity      a Potato Storage bay's cwt capacity (same formula as
//                    PotatoStorage.jsx: pipes × cwt/pipe × pile height / 18')
//   storageSites     every storage building (with its bays) placed on the
//                    map: a site position set by hand → its Farm Map cellar
//                    point ("NORLAND CELLARS #8&9" for "Norland 8–9
//                    Building") → the Storage module's own pin
//   fieldCentroid    middle of an Agworld field outline
//   milesBetween     straight-line distance
//   bayLock          what a bay already holds in the plan (one variety, one
//                    customer per bay)
//   refrigerated     a contract marked refrigerated only goes in refrigerated
//                    bays (a bay is refrigerated when Potato Storage says so,
//                    or when it's ticked on Storage plan > Storage sites)
//   canPlace / autoFill  the brainstorm board's rules and its greedy fill

export const DEFAULT_YIELD = 450 // cwt/ac when a storage contract has no expected yield

// ---- Potato Storage --------------------------------------------------------
const pileRatio = (bay) => (Number(bay && bay.pileHeight) || 18) / 18
function pipeCountOf(zone) {
  if (Array.isArray(zone.pipeRanges) && zone.pipeRanges.length) {
    const set = new Set()
    zone.pipeRanges.forEach(({ from, to }) => {
      const lo = Math.min(Number(from), Number(to)), hi = Math.max(Number(from), Number(to))
      if (Number.isFinite(lo) && Number.isFinite(hi)) for (let p = lo; p <= hi; p++) set.add(p)
    })
    return set.size
  }
  return Number(zone.pipeCount) || 0
}
export function bayCapacity(bay) {
  if (!bay) return 0
  if (Number(bay.pipeCount) > 0 && Number(bay.cwtPerPipe) > 0) return Number(bay.pipeCount) * Number(bay.cwtPerPipe) * pileRatio(bay)
  return (bay.zones || []).reduce((s, z) => s + pipeCountOf(z) * (Number(z.cwtPerPipe) || Number(bay.cwtPerPipe) || 0) * pileRatio(bay), 0)
}

// ---- Varieties and customers ----------------------------------------------
// "Russet Burbank", "Burbank" and "G3 Burbank" are one variety for a bay;
// "Ranger Russet" and "Russet Burbank" are not (same rule as Potato Storage).
const GENERIC = new Set(['RUSSET', 'POTATO', 'POTATOES'])
export function varietyFamily(name) {
  const s = String(name || '').replace(/\([^)]*\)/g, ' ').toUpperCase()
  const t = s.split(/[^A-Z0-9-]+/).filter((w) => w && !GENERIC.has(w) && !/^G\d+$/.test(w))
  return t.join(' ') || s.trim()
}
export const customerKey = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim()

// ---- Geometry --------------------------------------------------------------
export function milesBetween(a, b) {
  if (!a || !b) return null
  const R = 3958.8, rad = Math.PI / 180
  const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}
// ring: [[lng, lat], …] → { lat, lng } (area-weighted)
export function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null
  let a = 0, x = 0, y = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f
  }
  if (!a) {
    const n = ring.length
    return { lng: ring.reduce((s, p) => s + p[0], 0) / n, lat: ring.reduce((s, p) => s + p[1], 0) / n }
  }
  return { lng: x / (3 * a), lat: y / (3 * a) }
}

// ---- Storage sites ---------------------------------------------------------
// A name's place word and its numbers: "Norland 8–9 Building" → NORLAND [8,9],
// "NORLAND CELLARS #8&9" → NORLAND [8,9], "Watco-Dutchman" → WATCO [].
function nameSig(name) {
  const s = String(name || '').toUpperCase().replace(/&AMP;/g, '&')
  const word = (s.match(/[A-Z]{3,}/) || [''])[0]
  const nums = (s.match(/\d+/g) || []).map(Number).sort((a, b) => a - b)
  return { word, nums: nums.join(',') }
}
const isCellar = (p) => /CELLAR|STORAGE/i.test(p.name || '') || p.type === 'Cellar'
export function matchCellarPoint(building, location, points) {
  const cellars = (points || []).filter((p) => isCellar(p) && Number.isFinite(p.lat) && Number.isFinite(p.lng))
  const b = nameSig(building && building.name)
  const l = nameSig(location && location.name)
  const word = b.word || l.word
  if (!word) return null
  const same = cellars.filter((p) => nameSig(p.name).word === word)
  if (!same.length) return null
  return same.find((p) => b.nums && nameSig(p.name).nums === b.nums) || null
}
// Every building with bays becomes a site. positions: storageSites docs
// { [buildingId]: { pointId } | { lat, lng }, coldBays: [bayId] } set in the plan.
export function storageSites({ locations = [], buildings = [], bays = [], points = [], positions = {} }) {
  const locById = Object.fromEntries(locations.map((l) => [l.id, l]))
  const pointById = Object.fromEntries((points || []).map((p) => [p.id, p]))
  const sites = buildings.map((b) => {
    const loc = locById[b.locationId] || null
    const myBays = bays.filter((x) => x.buildingId === b.id)
    const set = positions[b.id] || null
    let pos = null, source = null, pointName = null
    if (set && set.pointId && pointById[set.pointId]) { const p = pointById[set.pointId]; pos = { lat: p.lat, lng: p.lng }; source = 'farm-map'; pointName = p.name }
    else if (set && Number.isFinite(set.lat) && Number.isFinite(set.lng)) { pos = { lat: set.lat, lng: set.lng }; source = 'set' }
    if (!pos) {
      const p = matchCellarPoint(b, loc, points)
      if (p) { pos = { lat: p.lat, lng: p.lng }; source = 'farm-map-auto'; pointName = p.name }
    }
    if (!pos && loc && Number.isFinite(Number(loc.lat)) && Number.isFinite(Number(loc.lng))) { pos = { lat: Number(loc.lat), lng: Number(loc.lng) }; source = 'storage-module' }
    return {
      id: b.id, name: b.name, locationId: b.locationId, locationName: loc ? loc.name : '', pos, source, pointName,
      bays: myBays.map((x) => ({ id: x.id, name: x.name, siteId: b.id, capacity: bayCapacity(x), refrigerated: x.refrigerated === true || !!(set && (set.coldBays || []).includes(x.id)), now: [...new Set((x.zones || []).map((z) => `${z.variety || '?'} · ${z.customer || '?'}`))] }))
    }
  }).filter((s) => s.bays.length)
  return sites.sort((a, b) => a.locationName.localeCompare(b.locationName) || a.name.localeCompare(b.name, undefined, { numeric: true }))
}

// ---- Fields on storage contracts ------------------------------------------
// fields: Contracts' season fields; contracts with delivery 'storage';
// allocByField: fieldId → contractId; centroids: fieldId → { lat, lng }
export function storageFields({ fields, contracts, allocByField, centroids, sites, defaultYield = DEFAULT_YIELD }) {
  const cById = Object.fromEntries(contracts.map((c) => [c.id, c]))
  const placed = sites.filter((s) => s.pos)
  return fields.filter((f) => cById[allocByField[f.id]] && cById[allocByField[f.id]].delivery === 'storage').map((f) => {
    const c = cById[allocByField[f.id]]
    const yieldPerAc = c.unit === 'cwt' && Number(c.yieldPerAcre) > 0 ? Number(c.yieldPerAcre) : Number(defaultYield) || DEFAULT_YIELD
    const pos = centroids[f.id] || null
    const near = pos ? placed.map((s) => ({ siteId: s.id, name: s.name, location: s.locationName || s.name, miles: milesBetween(pos, s.pos) })).sort((a, b) => a.miles - b.miles) : []
    // nearest building at each storage location (buildings in one yard are all about as far)
    const nearLocs = near.filter((n, i) => near.findIndex((m) => m.location === n.location) === i)
    const variety = f.variety || (c.varieties && c.varieties.length === 1 ? c.varieties[0] : null)
    return {
      id: f.id, name: f.name, farmName: f.farmName, acres: f.acres, variety, family: varietyFamily(variety), customer: c.buyer || c.name,
      customerKey: customerKey(c.buyer || c.name), contractId: c.id, contractName: c.name, refrigerated: !!c.refrigerated, yieldPerAc, cwt: f.acres * yieldPerAc, pos, near, nearLocs
    }
  }).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
}

// ---- The plan --------------------------------------------------------------
// plan.assign: [{ fieldId, bayId, cwt }]; plan.excluded: [bayId]
export function planState({ plan, sites, fields }) {
  const assign = (plan && plan.assign) || []
  const excluded = new Set((plan && plan.excluded) || [])
  const fieldById = Object.fromEntries(fields.map((f) => [f.id, f]))
  const bays = {}
  sites.forEach((s) => s.bays.forEach((b) => { bays[b.id] = { ...b, site: s, used: 0, items: [], lock: null, excluded: excluded.has(b.id) } }))
  const placedBy = {}
  const stray = [] // assignments to a bay or field that no longer exists
  assign.forEach((a) => {
    const b = bays[a.bayId], f = fieldById[a.fieldId]
    if (!b || !f) { stray.push(a); return }
    b.used += Number(a.cwt) || 0
    b.items.push({ ...a, field: f })
    if (!b.lock) b.lock = { family: f.family, variety: f.variety, customerKey: f.customerKey, customer: f.customer }
    placedBy[f.id] = (placedBy[f.id] || 0) + (Number(a.cwt) || 0)
  })
  Object.values(bays).forEach((b) => {
    b.free = Math.max(0, b.capacity - b.used)
    b.over = b.used > b.capacity + 1
    b.mixed = b.items.some((i) => i.field.family !== b.lock.family || i.field.customerKey !== b.lock.customerKey)
  })
  const fieldsOut = fields.map((f) => ({ ...f, placed: placedBy[f.id] || 0, left: Math.max(0, f.cwt - (placedBy[f.id] || 0)), overPlaced: (placedBy[f.id] || 0) > f.cwt + 1, bays: assign.filter((a) => a.fieldId === f.id && bays[a.bayId]).map((a) => bays[a.bayId].name) }))
  const open = Object.values(bays).filter((b) => !b.excluded)
  const cold = open.filter((b) => b.refrigerated)
  return {
    bays, fields: fieldsOut, stray,
    totals: {
      need: fields.reduce((s, f) => s + f.cwt, 0), capacity: open.reduce((s, b) => s + b.capacity, 0),
      placed: assign.reduce((s, a) => s + (bays[a.bayId] && fieldById[a.fieldId] ? Number(a.cwt) || 0 : 0), 0),
      left: fieldsOut.reduce((s, f) => s + f.left, 0), free: open.reduce((s, b) => s + b.free, 0),
      baysUsed: open.filter((b) => b.items.length).length, baysOpen: open.length,
      coldNeed: fields.filter((f) => f.refrigerated).reduce((s, f) => s + f.cwt, 0),
      coldCapacity: cold.reduce((s, b) => s + b.capacity, 0), coldBays: cold.length,
      coldLeft: fieldsOut.filter((f) => f.refrigerated).reduce((s, f) => s + f.left, 0)
    }
  }
}

// Can field f go in bay b? → null if yes, else the reason.
export function cannotPlace(f, b) {
  if (!b || !f) return 'Pick a field and a bay.'
  if (b.excluded) return `${b.name} is set aside in this plan.`
  if (!f.family) return `${f.name} has no variety in Agworld — set one before placing it.`
  if (b.lock && b.lock.family !== f.family) return `${b.name} holds ${b.lock.variety} — one variety per bay.`
  if (b.lock && b.lock.customerKey !== f.customerKey) return `${b.name} is ${b.lock.customer}'s — one customer per bay.`
  if (f.refrigerated && !b.refrigerated) return `${b.name} isn’t refrigerated — ${f.name} is on a refrigerated contract.`
  if (b.free <= 0.5) return `${b.name} is full.`
  return null
}

// Put what's left of a field into a bay, as much as fits. Returns the new
// assign list (or the same list when nothing fits).
export function placeField(assign, f, b, maxCwt) {
  const amt = Math.min(f.left, b.free, maxCwt == null ? Infinity : maxCwt)
  if (!(amt > 0.5)) return assign
  const i = assign.findIndex((a) => a.fieldId === f.id && a.bayId === b.id)
  const cwt = Math.round(amt)
  if (i >= 0) return assign.map((a, j) => (j === i ? { ...a, cwt: Math.round((Number(a.cwt) || 0) + amt) } : a))
  return [...assign, { fieldId: f.id, bayId: b.id, cwt }]
}

// Greedy brainstorm: refrigerated-contract fields first (they have the fewest
// bays to go in), then biggest first, each into the nearest bays that fit its
// variety and customer — topping up bays it already shares before opening a
// new one at the same site, and keeping refrigerated bays for refrigerated
// fields when an ordinary bay is just as close. Keeps whatever is placed.
export function autoFill({ plan, sites, fields }) {
  let assign = [...((plan && plan.assign) || [])]
  let st = planState({ plan: { ...plan, assign }, sites, fields })
  const order = [...st.fields].filter((f) => f.left > 0.5 && f.family).sort((a, b) => (b.refrigerated - a.refrigerated) || (b.left - a.left))
  const skipped = []
  order.forEach((f0) => {
    for (let guard = 0; guard < 50; guard++) {
      st = planState({ plan: { ...plan, assign }, sites, fields })
      const f = st.fields.find((x) => x.id === f0.id)
      if (!f || f.left <= 0.5) return
      const dist = Object.fromEntries((f.near || []).map((n) => [n.siteId, n.miles]))
      const cands = Object.values(st.bays).filter((b) => !cannotPlace(f, b)).sort((a, b) => {
        const da = dist[a.site.id] ?? 1e9, db = dist[b.site.id] ?? 1e9
        if (Math.abs(da - db) > 0.25) return da - db
        if (!f.refrigerated && a.refrigerated !== b.refrigerated) return a.refrigerated ? 1 : -1 // save cold bays
        const sa = a.lock ? 0 : 1, sb = b.lock ? 0 : 1 // top up a started bay first
        if (sa !== sb) return sa - sb
        return String(a.name).localeCompare(String(b.name), undefined, { numeric: true })
      })
      if (!cands.length) { skipped.push(f.name); return }
      assign = placeField(assign, f, cands[0])
    }
  })
  return { assign, skipped: [...new Set(skipped)], noVariety: fields.filter((f) => !f.family).map((f) => f.name) }
}
