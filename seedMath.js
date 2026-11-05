// Pure math for the Potato Seed module (Seed*.jsx) — no React or Firebase.
//
// Flow of seed, every step a ticket in seedTickets:
//   pickup  — truck picks up whole seed at a grower (supplier / variety / lot,
//             scale weight − truck light weight = net). Status 'transit' until
//             it's tipped at the cutter, then 'unloaded'.
//   cut     — a truck weighed out of the cutter with cut seed. Its weight can
//             be split across several lots (parts: [{ supplier, variety, lot, cwt }]).
//   plant   — some or all of a cut-seed truck unloaded at an Agworld field.
//             What's left on the truck stays in inventory. A partial unload
//             takes each lot in proportion to what's still on the truck.
//   writeoff— (managers) cut seed dumped / not planted.
// Supplier, lot and variety ride along every step so any field traces back
// to the grower and lot.

export const LBS_PER_CWT = 100

export function lotKey(supplier, variety, lot) {
  const n = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ')
  return `${n(supplier)}|${n(variety)}|${n(lot)}`
}
export const lotLabel = (p) => `${p.supplier || '?'} · ${p.variety || '?'} · lot ${p.lot || '—'}`
export const truckKey = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '')

// Net weight. mode 'gross': the ticket shows the loaded truck, take off the
// truck's light weight. mode 'net': the ticket already shows net.
export function netWeight(scaleLbs, lightLbs, mode = 'gross') {
  const s = Number(scaleLbs)
  if (!(s > 0)) return null
  if (mode === 'net') return s
  const l = Number(lightLbs)
  if (!(l > 0)) return null
  const net = s - l
  return net > 0 ? net : null
}
export const toCwt = (lbs) => (lbs == null ? null : Math.round((lbs / LBS_PER_CWT) * 100) / 100)

const round2 = (n) => Math.round(n * 100) / 100

// Split `cwt` across a cut truck's parts in proportion to what each still has.
export function allocateUnload(truck, cwt) {
  const left = truck.parts.filter((p) => p.remaining > 1e-6)
  const total = left.reduce((s, p) => s + p.remaining, 0)
  if (!(total > 0) || !(cwt > 0)) return []
  const take = Math.min(cwt, total)
  const out = left.map((p) => ({ supplier: p.supplier, variety: p.variety, lot: p.lot, cwt: round2((take * p.remaining) / total) }))
  // keep the parts adding up exactly
  const diff = round2(take - out.reduce((s, p) => s + p.cwt, 0))
  if (out.length && diff) out[out.length - 1].cwt = round2(out[out.length - 1].cwt + diff)
  return out
}

// Everything the screens show, from the raw docs.
export function computeSeed({ contracts = [], tickets = [], closes = [], now = Date.now() }) {
  const live = tickets.filter((t) => !t.deleted)
  const pickups = live.filter((t) => t.type === 'pickup')
  const cuts = live.filter((t) => t.type === 'cut')
  const plants = live.filter((t) => t.type === 'plant' || t.type === 'writeoff')
  const closeByKey = Object.fromEntries(closes.map((c) => [c.key || lotKey(c.supplier, c.variety, c.lot), c]))

  // ---- lots ---------------------------------------------------------------
  const lots = {}
  const lot = (p) => {
    const k = lotKey(p.supplier, p.variety, p.lot)
    return (lots[k] = lots[k] || { key: k, supplier: p.supplier, variety: p.variety, lot: p.lot, picked: 0, transit: 0, unloaded: 0, cut: 0, planted: 0, writtenOff: 0, onTrucks: 0, fields: {}, pickups: 0, cutTrucks: 0 })
  }
  pickups.forEach((t) => {
    const L = lot(t)
    L.picked += t.cwt || 0; L.pickups++
    if (t.status === 'unloaded') L.unloaded += t.cwt || 0
    else L.transit += t.cwt || 0
  })
  cuts.forEach((t) => (t.parts || []).forEach((p) => { const L = lot(p); L.cut += p.cwt || 0; L.cutTrucks++ }))

  // ---- cut trucks and what's still on them --------------------------------
  const plantsByCut = {}
  plants.forEach((e) => { (plantsByCut[e.cutTicketId] = plantsByCut[e.cutTicketId] || []).push(e) })
  const trucks = cuts.map((t) => {
    const evs = plantsByCut[t.id] || []
    const parts = (t.parts || []).map((p) => {
      const k = lotKey(p.supplier, p.variety, p.lot)
      const out = evs.reduce((s, e) => s + (e.parts || []).filter((q) => lotKey(q.supplier, q.variety, q.lot) === k).reduce((a, q) => a + (q.cwt || 0), 0), 0)
      return { ...p, key: k, unloaded: out, remaining: Math.max(0, round2((p.cwt || 0) - out)) }
    })
    const remaining = round2(parts.reduce((s, p) => s + p.remaining, 0))
    const unloadedAll = round2(evs.reduce((s, e) => s + (e.cwt || 0), 0))
    return {
      overUnloaded: unloadedAll > (t.cwt || 0) + 0.5,
      id: t.id, ticket: t, truckNo: t.truckNo, at: t.at, cwt: t.cwt, parts, remaining,
      unloadedCwt: unloadedAll, events: evs,
      loaded: remaining > 0.05, ageHours: (now - (t.at || now)) / 3600000,
      varieties: [...new Set(parts.map((p) => p.variety))]
    }
  })
  trucks.forEach((tr) => tr.parts.forEach((p) => { if (tr.loaded) lot(p).onTrucks += p.remaining }))

  // ---- planted ------------------------------------------------------------
  const fields = {}
  plants.forEach((e) => (e.parts || []).forEach((p) => {
    const L = lot(p)
    if (e.type === 'writeoff') { L.writtenOff += p.cwt || 0; return }
    L.planted += p.cwt || 0
    L.fields[e.fieldId || e.fieldName] = (L.fields[e.fieldId || e.fieldName] || 0) + (p.cwt || 0)
    const f = (fields[e.fieldId || e.fieldName] = fields[e.fieldId || e.fieldName] || { fieldId: e.fieldId || null, fieldName: e.fieldName, farmName: e.farmName || null, acres: e.fieldAcres || null, total: 0, lots: {}, first: e.at, last: e.at, loads: 0 })
    f.total += p.cwt || 0
    const fl = (f.lots[L.key] = f.lots[L.key] || { supplier: p.supplier, variety: p.variety, lot: p.lot, cwt: 0 })
    fl.cwt += p.cwt || 0
    f.first = Math.min(f.first, e.at); f.last = Math.max(f.last, e.at)
  }))
  plants.filter((e) => e.type === 'plant').forEach((e) => { const f = fields[e.fieldId || e.fieldName]; if (f) f.loads++ })

  // ---- cutting zone -------------------------------------------------------
  Object.values(lots).forEach((L) => {
    const c = closeByKey[L.key]
    L.closed = !!c
    L.closedAt = c ? c.closedAt : null
    const left = L.unloaded - L.cut
    L.shrink = c ? Math.max(0, c.shrinkCwt ?? left) : 0
    L.zone = c ? 0 : Math.max(0, round2(left))
    L.overCut = left < -0.5 // more cut out than came in — a ticket is probably on the wrong lot
    L.shrinkPct = c && L.unloaded > 0 ? L.shrink / L.unloaded : null
  })
  const lotList = Object.values(lots).sort((a, b) => a.variety.localeCompare(b.variety) || a.supplier.localeCompare(b.supplier) || String(a.lot).localeCompare(String(b.lot), undefined, { numeric: true }))
  const zoneCwt = round2(lotList.reduce((s, L) => s + L.zone, 0))

  // ---- contracts ----------------------------------------------------------
  const contractRows = contracts.map((c) => {
    const mine = pickups.filter((t) => t.contractId === c.id)
    const picked = mine.reduce((s, t) => s + (t.cwt || 0), 0)
    const transit = mine.filter((t) => t.status !== 'unloaded').reduce((s, t) => s + (t.cwt || 0), 0)
    const target = Number(c.contractedCwt) || 0
    // Seeding rate (cwt/ac) turns seed into the acres it will plant.
    const rate = Number(c.seedingRate) > 0 ? Number(c.seedingRate) : null
    const ac = (cwt) => (rate ? cwt / rate : null)
    return {
      ...c, picked, transit, loads: mine.length, remaining: target - picked, pct: target > 0 ? picked / target : null,
      rate, acres: ac(target), pickedAcres: ac(picked), remainingAcres: ac(Math.max(0, target - picked))
    }
  })
  const byVariety = {}
  contractRows.forEach((c) => {
    const v = (byVariety[c.variety] = byVariety[c.variety] || { variety: c.variety, contracted: 0, picked: 0, planted: 0, acres: 0, acresKnown: true })
    v.contracted += Number(c.contractedCwt) || 0; v.picked += c.picked
    if (c.acres != null) v.acres += c.acres; else if (Number(c.contractedCwt) > 0) v.acresKnown = false
  })
  pickups.filter((t) => !t.contractId).forEach((t) => {
    const v = (byVariety[t.variety] = byVariety[t.variety] || { variety: t.variety, contracted: 0, picked: 0, planted: 0, acres: 0, acresKnown: true })
    v.picked += t.cwt || 0
  })
  lotList.forEach((L) => { if (byVariety[L.variety]) byVariety[L.variety].planted += L.planted })

  const loadedTrucks = trucks.filter((t) => t.loaded).sort((a, b) => a.at - b.at)
  return {
    lots: lotList, lotsByKey: lots, zoneCwt,
    transit: pickups.filter((t) => t.status !== 'unloaded').sort((a, b) => a.at - b.at),
    trucks, loadedTrucks, overUnloaded: trucks.filter((t) => t.overUnloaded),
    loadedCwt: round2(loadedTrucks.reduce((s, t) => s + t.remaining, 0)),
    fields: Object.values(fields).sort((a, b) => String(a.fieldName).localeCompare(String(b.fieldName), undefined, { numeric: true })),
    contractRows, byVariety: Object.values(byVariety).sort((a, b) => String(a.variety).localeCompare(String(b.variety))),
    totals: {
      contracted: contractRows.reduce((s, c) => s + (Number(c.contractedCwt) || 0), 0),
      acres: contractRows.reduce((s, c) => s + (c.acres || 0), 0),
      pickedAcres: contractRows.reduce((s, c) => s + (c.pickedAcres || 0), 0),
      contractsWithoutRate: contractRows.filter((c) => c.rate == null && Number(c.contractedCwt) > 0).length,
      picked: pickups.reduce((s, t) => s + (t.cwt || 0), 0),
      cut: cuts.reduce((s, t) => s + (t.cwt || 0), 0),
      planted: lotList.reduce((s, L) => s + L.planted, 0),
      shrink: lotList.reduce((s, L) => s + L.shrink, 0)
    }
  }
}

// cwt planted per Agworld field id — for the future planting schedule module.
export function plantedByField(tickets) {
  const out = {}
  tickets.filter((t) => !t.deleted && t.type === 'plant' && t.fieldId).forEach((t) => { out[t.fieldId] = (out[t.fieldId] || 0) + (t.cwt || 0) })
  return out
}

export function fmtCwt(n, d = 0) {
  if (n == null || !isFinite(n)) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d })
}
export function fmtAge(hours) {
  if (hours == null || !isFinite(hours)) return '—'
  if (hours < 1) return `${Math.max(0, Math.round(hours * 60))} min`
  if (hours < 48) return `${Math.floor(hours)} h ${Math.round((hours % 1) * 60)} m`
  return `${Math.floor(hours / 24)} d ${Math.round(hours % 24)} h`
}
export function fmtWhen(ms) {
  if (!ms) return '—'
  const d = new Date(ms)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
export function newId() { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}` }

// Shrink a phone photo to ~1280 px JPEG so it fits in a Firestore doc (and
// queues offline when there's no signal at the field).
export function compressImage(file, maxDim = 1280, quality = 0.62) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const c = document.createElement('canvas')
      c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale)
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height)
      URL.revokeObjectURL(url)
      let q = quality
      let data = c.toDataURL('image/jpeg', q)
      while (data.length > 700000 && q > 0.3) { q -= 0.1; data = c.toDataURL('image/jpeg', q) }
      resolve(data)
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo.')) }
    img.src = url
  })
}
