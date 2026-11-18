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

// ---------------------------------------------------------------------------
// Seed needs vs contracted (Contracts tab). One row per variety.
//   needs:  seedNeeds docs { variety, acres, rate, cwt, note } — cwt, when
//           given, is the need outright; otherwise acres × rate.
//   shrinkPct: extra seed allowed for cutting shrink / cull, added on top of
//           acres × rate (not on a typed-in cwt).
//   fieldList: the season's Agworld fields — potato acres by variety shown as
//           a suggestion for the acres.
// ---------------------------------------------------------------------------
export const varietyKey = (v) => String(v || '').trim().toUpperCase().replace(/\s+/g, ' ')

// Acres to plant by variety from the Contracts module's potato contracts.
//   mode 'contracted': each contract's acres = cwt ÷ expected yield (acres
//     for an acre contract). One variety → all to it; several → split by the
//     varieties of the fields allocated to it; nothing to split by → listed
//     in `unsplit` and not counted.
//   mode 'allocated': the acres of the fields allocated to each contract, by
//     each field's variety (picked on the allocation, else Agworld's).
// contracts: Contracts-module docs; allocations: contractAllocations docs;
// fields: { [fieldId]: { acres, variety } } for the season.
export function contractPlantAcres({ contracts = [], allocations = [], fields = {}, mode = 'contracted' }) {
  const out = [], unsplit = []
  const potato = contracts.filter((c) => /POTATO/i.test(String(c.crop || '')))
  potato.forEach((c) => {
    const vs = (c.varieties || []).filter(Boolean)
    const byVar = {}
    let allocAc = 0, noVarAc = 0
    allocations.filter((a) => a.contractId === c.id).forEach((a) => {
      const f = fields[a.fieldId]
      if (!f || !(Number(f.acres) > 0)) return
      const v = a.variety || f.variety || (vs.length === 1 ? vs[0] : null)
      allocAc += Number(f.acres)
      if (v) byVar[v] = (byVar[v] || 0) + Number(f.acres); else noVarAc += Number(f.acres)
    })
    const label = c.name || c.buyer || 'contract'
    if (mode === 'allocated') {
      Object.entries(byVar).forEach(([v, ac]) => out.push({ variety: v, acres: ac, contract: label }))
      if (noVarAc > 0) unsplit.push({ contract: label, acres: noVarAc, why: 'fields with no variety picked' })
      return
    }
    const yieldPer = c.unit === 'acres' ? 1 : c.unit === 'cwt' && Number(c.yieldPerAcre) > 0 ? Number(c.yieldPerAcre) : null
    if (!(Number(c.amount) > 0) || !yieldPer) { unsplit.push({ contract: label, acres: null, why: 'no expected yield on the contract' }); return }
    const acres = c.unit === 'acres' ? Number(c.amount) : Number(c.amount) / yieldPer
    if (vs.length === 1) { out.push({ variety: vs[0], acres, contract: label }); return }
    const known = Object.values(byVar).reduce((t, x) => t + x, 0)
    if (known > 0) { Object.entries(byVar).forEach(([v, ac]) => out.push({ variety: v, acres: (acres * ac) / known, contract: label })); return }
    unsplit.push({ contract: label, acres, why: vs.length ? `lists ${vs.length} varieties and no fields are allocated to split by` : 'allows any variety and no fields are allocated' })
  })
  return { list: out, unsplit }
}

export function computeNeeds({ needs = [], contractRows = [], fieldList = [], shrinkPct = 0, plantAcres = null }) {
  const rows = {}
  const row = (variety) => {
    const k = varietyKey(variety)
    if (!k) return null
    return (rows[k] = rows[k] || { key: k, variety: String(variety).trim(), contracted: 0, picked: 0, rateCwt: 0, rateAcres: 0, contracts: 0, agAcres: 0, agFields: 0, need: null, ctAcres: 0, ctFrom: [] })
  }
  contractRows.forEach((c) => {
    const r = row(c.variety)
    if (!r) return
    const cwt = Number(c.contractedCwt) || 0
    r.contracted += cwt; r.picked += c.picked || 0; r.contracts++
    if (c.rate && cwt > 0) { r.rateCwt += cwt; r.rateAcres += cwt / c.rate }
  })
  needs.forEach((n) => { const r = row(n.variety); if (r) r.need = n })
  // Agworld potato fields: exact variety match first, then a name that
  // contains the other ("Russet Burbank" / "Burbank"); the rest get rows of
  // their own so nothing planted in Agworld goes unseen.
  const potatoes = fieldList.filter((f) => /POTATO/.test(String(f.crop || '').toUpperCase()) && Number(f.acres) > 0)
  potatoes.forEach((f) => {
    const fk = varietyKey(f.variety)
    let r = fk ? rows[fk] : null
    if (!r && fk) r = Object.values(rows).find((x) => x.key.includes(fk) || fk.includes(x.key)) || null
    if (!r) r = row(f.variety || 'Variety not set in Agworld')
    r.agAcres += Number(f.acres); r.agFields++
  })
  // Acres from the Contracts module's potato contracts, matched to the seed
  // variety the same way (exact, then one name containing the other).
  if (plantAcres) {
    plantAcres.list.forEach((x) => {
      const k = varietyKey(x.variety)
      let r = rows[k] || Object.values(rows).find((y) => y.key.includes(k) || k.includes(y.key)) || null
      if (!r) r = row(x.variety)
      r.ctAcres += x.acres
      if (!r.ctFrom.includes(x.contract)) r.ctFrom.push(x.contract)
    })
  }
  const allow = 1 + (Number(shrinkPct) > 0 ? Number(shrinkPct) / 100 : 0)
  const out = Object.values(rows).map((r) => {
    const n = r.need || {}
    const contractRate = r.rateAcres > 0 ? r.rateCwt / r.rateAcres : null
    const rate = Number(n.rate) > 0 ? Number(n.rate) : contractRate
    const typedAcres = Number(n.acres) > 0 ? Number(n.acres) : null
    const acres = typedAcres != null ? typedAcres : plantAcres && r.ctAcres > 0 ? r.ctAcres : null
    const typed = Number(n.cwt) > 0 ? Number(n.cwt) : null
    const needCwt = typed != null ? typed : acres != null && rate ? acres * rate * allow : null
    const diff = needCwt != null ? r.contracted - needCwt : null
    const perAc = rate ? rate * allow : null
    const status = needCwt == null ? (r.contracted > 0 ? 'no-need' : 'empty')
      : Math.abs(diff) <= Math.max(1, needCwt * 0.02) ? 'covered' : diff < 0 ? 'short' : 'over'
    return {
      ...r, contractRate, rate, rateFromContracts: !(Number(n.rate) > 0) && contractRate != null, acres, typedAcres, acresFromContracts: typedAcres == null && acres != null, typedCwt: typed,
      needCwt, diff, diffAcres: diff != null && perAc ? diff / perAc : null,
      contractedAcres: perAc ? r.contracted / perAc : null, status, note: n.note || null, needId: n.id || null
    }
  }).sort((a, b) => a.variety.localeCompare(b.variety))
  const sum = (f) => out.reduce((s, r) => s + (r[f] || 0), 0)
  const withNeed = out.filter((r) => r.needCwt != null)
  return {
    rows: out, unsplit: plantAcres ? plantAcres.unsplit : [],
    totals: {
      need: sum('needCwt'), contracted: sum('contracted'), agAcres: sum('agAcres'), acres: sum('acres'), ctAcres: sum('ctAcres'),
      typedCwtCount: out.filter((r) => r.typedCwt != null).length, noRate: out.filter((r) => r.acres != null && !r.rate && r.typedCwt == null).length,
      short: withNeed.filter((r) => r.status === 'short').reduce((s, r) => s - r.diff, 0),
      over: withNeed.filter((r) => r.status === 'over').reduce((s, r) => s + r.diff, 0),
      contractedWithNeed: withNeed.reduce((s, r) => s + r.contracted, 0), needCount: withNeed.length
    }
  }
}

// ---------------------------------------------------------------------------
// Seed sales (Seed sales tab): seed we sell to customers.
//   sales:     seedSales docs { customer, variety, contractedCwt, pricePerCwt, … }
//   shipments: seedShipments docs { saleId, at, cwt, truckNo, ticketNo, lot, … }
// ---------------------------------------------------------------------------
export function computeSales({ sales = [], shipments = [] }) {
  const live = shipments.filter((s) => !s.deleted)
  const bySale = {}
  live.forEach((s) => { (bySale[s.saleId] = bySale[s.saleId] || []).push(s) })
  const rows = sales.map((c) => {
    const ships = (bySale[c.id] || []).sort((a, b) => (b.at || 0) - (a.at || 0))
    const shipped = round2(ships.reduce((t, s) => t + (Number(s.cwt) || 0), 0))
    const target = Number(c.contractedCwt) || 0
    const price = Number(c.pricePerCwt) > 0 ? Number(c.pricePerCwt) : null
    return {
      ...c, shipments: ships, loads: ships.length, shipped, remaining: round2(target - shipped),
      pct: target > 0 ? shipped / target : null, lastAt: ships.length ? ships[0].at : null,
      value: price != null ? target * price : null, shippedValue: price != null ? shipped * price : null
    }
  }).sort((a, b) => String(a.customer).localeCompare(String(b.customer)) || String(a.variety).localeCompare(String(b.variety)))
  const byCustomer = {}
  rows.forEach((r) => {
    const k = String(r.customer || '').trim()
    const c = (byCustomer[k] = byCustomer[k] || { customer: k, contracted: 0, shipped: 0, loads: 0, sales: 0 })
    c.contracted += Number(r.contractedCwt) || 0; c.shipped += r.shipped; c.loads += r.loads; c.sales++
  })
  const sum = (f) => round2(rows.reduce((t, r) => t + (Number(r[f]) || 0), 0))
  return {
    rows, customers: Object.values(byCustomer).sort((a, b) => a.customer.localeCompare(b.customer)),
    orphans: live.filter((s) => !sales.some((c) => c.id === s.saleId)),
    totals: { contracted: sum('contractedCwt'), shipped: sum('shipped'), remaining: round2(sum('contractedCwt') - sum('shipped')), loads: live.length, value: sum('value'), shippedValue: sum('shippedValue') }
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
