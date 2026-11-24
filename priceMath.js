// Pure math for Planning › Prices & bids (PlanningPrices.jsx) — no React or
// Firebase, so it can be checked on its own (and builds the bundled price
// history, priceHistory.json, from the comparison workbooks).
//
// Where prices come from:
//   "YYYY Price Comparison Chemical & Fertilizer.xlsx", sheet "database":
//       Product Name | Year | Class | Category | Seller | AI | Price | Unit |
//       Price/Unit | Rate | unit2 | Price/Acre | discount | Final | Final Pick
//       (or Volume | Dollars) | MRL Issues | Chemigation | PHI | Plantbacks |
//       MOA | Low end rate | High End Rate | In season max | Manufacturer
//     Each year's file is a running list back to 2020, so the files overlap;
//     merging keeps every distinct price and flags the same product / year /
//     seller entered at two different prices.
//   Agworld's price list export (CSV): Name, Kind (products | operations |
//     seeds), Pack Size, Pack Size Units, Pack Cost, Unit Cost, Unit Cost
//     Units, ID. The prices Agworld budgets with right now.
//
// Units: every quote keeps the unit it was given in; comparisons use a base
// unit per product family — gal for liquids, lb for dry — so a $/ton bid and
// a $/lb bid line up. "oz" means fl oz for a liquid and dry oz for a solid.

export const CLASSES = ['Herbicide', 'Fungicide', 'Insecticide', 'Nematicide', 'Seed Treat', 'Adjuvant', 'Growth Regulator', 'Rodenticide', 'Dry Fert', 'Liquid Fert', 'Fumigant', 'Seed', 'Custom operation', 'Other']

export function money(v) {
  if (v == null) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  const s = String(v).replace(/[$,\s]/g, '')
  if (!s || s === '-' || /^#/.test(s)) return null
  const neg = /^\(.*\)$/.test(s)
  const n = Number(s.replace(/[()]/g, ''))
  return isFinite(n) ? (neg ? -n : n) : null
}
export function pct(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return v > 1 ? v / 100 : v
  const s = String(v).trim()
  const n = Number(s.replace(/[%\s]/g, ''))
  if (!isFinite(n)) return null
  return s.includes('%') || n > 1 ? n / 100 : n
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------
const UNIT_ALIASES = {
  gal: ['gal', 'gals', 'gallon', 'gallons'], qt: ['qt', 'qts', 'quart', 'quarts'], pt: ['pt', 'pts', 'pint', 'pints'],
  floz: ['floz', 'fl oz', 'fl/oz', 'fl. oz', 'fl.oz'], oz: ['oz', '0z', 'ozwt', 'dry oz', 'ounce', 'ounces'],
  lb: ['lb', 'lbs', 'pound', 'pounds', '#'], ton: ['ton', 'tons', 't'], each: ['each', 'ea', 'unit', 'units', 'bag', 'bags', 'unit (80k)'],
  acre: ['acre', 'acres', 'ac'], acin: ['acre*in', 'acre-in', 'ac-in']
}
const UNIT_OF = {}
Object.entries(UNIT_ALIASES).forEach(([u, list]) => list.forEach((a) => { UNIT_OF[a] = u }))
export function normUnit(u) {
  const s = String(u || '').trim().toLowerCase().replace(/^dollar\//, '').replace(/\s+/g, ' ')
  return UNIT_OF[s] || (s ? s : '')
}
// gallons / pounds per unit. oz is resolved by the family it sits in.
const VOL = { gal: 1, qt: 0.25, pt: 0.125, floz: 1 / 128 }
const WT = { ton: 2000, lb: 1, oz: 1 / 16 }
export const familyOf = (u) => (u in VOL ? 'vol' : u in WT ? 'wt' : u ? 'other' : '')
export const baseUnitOf = (fam) => (fam === 'vol' ? 'gal' : fam === 'wt' ? 'lb' : null)
// How many base units (gal or lb) one `unit` is, for a product of family `fam`.
export function toBase(unit, fam) {
  const u = normUnit(unit)
  if (fam === 'vol') return u === 'oz' ? VOL.floz : VOL[u] ?? null
  if (fam === 'wt') return WT[u] ?? (u === 'floz' ? null : null)
  return u ? 1 : null
}
export function unitLabel(u) {
  return { gal: 'gal', qt: 'qt', pt: 'pt', floz: 'fl oz', oz: 'oz', lb: 'lb', ton: 'ton', each: 'each', acre: 'ac', acin: 'ac-in' }[u] || u || ''
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------
const DROP_WORDS = /\b(herbicide|fungicide|insecticide|miticide|bactericide|nematicide|desiccant|dessicant|soil fumigant|seed treatment|systemic protectant|insect control|brand|the|potato)\b/g
// One key per product, so "Luna PRO", "LUNA Pro" and "Luna Pro Fungicide" are one product.
export function productKey(name) {
  let s = String(name || '').toLowerCase()
    .replace(/[®™©]/g, '')
    .replace(/\(epa[^)]*\)/g, '')
    .replace(/\((upl|valent|arysta|corteva|basf|winfield[^)]*|gowan|aceto|simplot|fbn)\)/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(DROP_WORDS, ' ')
    .replace(/(\d),\s+(\d)/g, '$1,$2')
    .replace(/[^a-z0-9.,%/+-]+/g, ' ')
    .replace(/\s+/g, ' ').trim()
  s = s.replace(/^(agri star|agristar|agrsolutions|agrisolutions|winfield|nufarm|helena|upi|corteva|koch|marion|cameron|valley agronomics|verdesian|gowan) /, '')
  return s || String(name || '').trim().toLowerCase()
}
export const docKey = (k) => k.replace(/[/.#$[\]]/g, '_').slice(0, 140)

// Matching a new name to a product already on the list: exact key, then
// the same letters ignoring spaces / punctuation ("batallion 2 ec" =
// "batallion 2ec"), then one name starting with the other's first word(s)
// when that picks out exactly one product ("acronyx 4 f" -> "acronyx",
// "beleaf 50 sg" -> "beleaf"). Returns the matched key or null.
// Never across different strengths or formulations: the numbers in both
// names must agree where both have numbers ("manganese 32%" ≠ "manganese
// 5%", "shenzi 700 wg" ≠ "shenzi 400sc"), and so must formulation codes
// ("flumi sc" ≠ "flumi 51 wdg"). `claimed` = keys another incoming product
// already owns exactly, which can't be taken by a looser match.
const compact = (k) => k.replace(/[^a-z0-9%]/g, '')
const FORM = /(?:^|[\s\d])(sc|sx|wg|wdg|ec|df|wp|fs|sl|me|cs|lv|sg|xl|ez|hl|ew|od|ls|st)(?=$|\s)/g
const numsOf = (k) => (k.match(/\d+(?:\.\d+)?/g) || []).join(',')
const formsOf = (k) => [...k.matchAll(FORM)].map((m) => m[1]).sort().join(',')
function compatible(a, b) {
  const na = numsOf(a), nb = numsOf(b)
  if (na && nb && na !== nb) return false
  const fa = formsOf(a), fb = formsOf(b)
  if (fa && fb && fa !== fb) return false
  return true
}
export function matchKey(key, keys, claimed = null) {
  if (keys.has ? keys.has(key) : keys.includes(key)) return key
  const list = [...keys].filter((k) => !(claimed && claimed.has(k)) && compatible(key, k))
  const c = compact(key)
  const same = list.filter((k) => compact(k) === c)
  if (same.length === 1) return same[0]
  const words = key.split(' ')
  for (let n = Math.min(3, words.length); n >= 1; n--) {
    const head = words.slice(0, n).join(' ')
    if (head.length < 4) continue
    const hc = compact(head)
    const hits = list.filter((k) => { const kc = compact(k); return kc === hc || (kc.startsWith(hc) && n > 1) || compact(k.split(' ').slice(0, n).join(' ')) === hc })
    const uniq = [...new Set(hits)]
    if (uniq.length === 1) return uniq[0]
    if (uniq.length > 1) {
      const exactHead = uniq.filter((k) => compact(k) === hc)
      if (exactHead.length === 1) return exactHead[0]
      return null
    }
  }
  return null
}

const SELLERS = { vwc: 'VWC', sgs: 'SGS', fbn: 'FBN', valley: 'Valley', helena: 'Helena', simplot: 'Simplot', 'rocky mountain ag': 'Rocky Mountain Ag', 'rocky mtn': 'Rocky Mountain Ag', 'ag chem solutions': 'Ag Chem Solutions', agworld: 'Agworld' }
export function normSeller(s) {
  const t = String(s || '').trim()
  if (!t || /^see /i.test(t)) return null
  return SELLERS[t.toLowerCase()] || t
}
export function normClass(c, category = '') {
  const s = `${c || ''}`.trim().toLowerCase()
  const cat = String(category || '').toLowerCase()
  if (!s) return null
  if (/seed treat/.test(s)) return 'Seed Treat'
  if (/^dry fert/.test(s)) return 'Dry Fert'
  if (/liquid fert/.test(s)) return 'Liquid Fert'
  if (/growth/.test(s)) return 'Growth Regulator'
  if (/fumig/.test(s) || /fumig/.test(cat)) return 'Fumigant'
  const hit = CLASSES.find((x) => x.toLowerCase() === s)
  return hit || s.replace(/\b[a-z]/g, (m) => m.toUpperCase())
}

// ---------------------------------------------------------------------------
// A quote's price in the product's base unit (gal or lb), before and after
// discount, and per acre at its rate.
// ---------------------------------------------------------------------------
export function quoteMath(q, fam) {
  const f = fam || familyOf(normUnit(q.unit))
  const per = toBase(q.unit, f)
  const base = q.price != null && per ? q.price / per : null
  const disc = q.discount || 0
  const net = base != null ? base * (1 - disc) : null
  const rateBase = q.rate != null && q.rateUnit ? toBase(q.rateUnit, f) : null
  const perAcre = net != null && rateBase ? net * q.rate * rateBase : null
  return { fam: f, baseUnit: baseUnitOf(f), base, net, perAcre }
}

// ---------------------------------------------------------------------------
// Parsing the comparison workbook's "database" sheet (array of row arrays).
// ---------------------------------------------------------------------------
const H = {
  name: ['product name'], year: ['year'], class: ['class'], category: ['category'], seller: ['seller'], ai: ['ai', 'active ingredient'],
  price: ['price'], unit: ['unit'], rate: ['rate'], rateUnit: ['unit2'], discount: ['discount'], final: ['final'],
  pick: ['final pick'], volume: ['volume'], dollars: ['dollars'], mrl: ['mrl issues'], chemigation: ['chemigation'], phi: ['phi'],
  plantbacks: ['plantbacks'], moa: ['moa'], rateLow: ['low end rate'], rateHigh: ['high end rate'], inSeasonMax: ['in season max'], manufacturer: ['manufacturer']
}
export function parseComparison(rows, source) {
  const hIdx = rows.findIndex((r) => r && r.some((c) => String(c || '').trim().toLowerCase() === 'product name') && r.some((c) => String(c || '').trim().toLowerCase() === 'seller'))
  if (hIdx < 0) throw new Error('Couldn’t find the header row (needs “Product Name” and “Seller”) — use the “database” sheet.')
  const head = rows[hIdx].map((c) => String(c || '').trim().toLowerCase())
  const col = {}
  Object.entries(H).forEach(([k, names]) => { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i })
  const out = [], skipped = []
  rows.slice(hIdx + 1).forEach((r, i) => {
    if (!r) return
    const g = (k) => (col[k] == null ? null : r[col[k]])
    const s = (k) => { const v = g(k); return v == null || String(v).trim() === '' ? null : String(v).trim() }
    const name = s('name')
    if (!name) return
    const yr = String(g('year') ?? '').trim()
    const m = yr.match(/\b(20\d\d)\b/)
    if (!m) { skipped.push({ row: hIdx + 2 + i, name, why: `year “${yr || 'blank'}”` }); return }
    const seller = normSeller(s('seller'))
    const unit = normUnit(s('unit'))
    const price = money(g('price'))
    if (price == null && money(g('final')) == null) { skipped.push({ row: hIdx + 2 + i, name, why: 'no price' }); return }
    out.push({
      name, key: productKey(name), season: +m[1], seasonNote: yr.replace(m[1], '').trim() || null,
      class: normClass(s('class'), s('category')), category: s('category'), seller, sellerNote: seller ? null : s('seller'),
      ai: s('ai'), price, unit, rate: money(g('rate')), rateUnit: normUnit(s('rateUnit')) || null,
      discount: pct(g('discount')), final: money(g('final')),
      award: ['1', 'yes', 'y', 'x'].includes(String(g('pick') ?? '').trim().toLowerCase()) || null,
      volume: money(g('volume')), mrl: s('mrl'), chemigation: s('chemigation'), phi: s('phi'), plantbacks: s('plantbacks'),
      moa: s('moa'), rateLow: s('rateLow'), rateHigh: s('rateHigh'), inSeasonMax: s('inSeasonMax'), manufacturer: s('manufacturer'),
      source
    })
  })
  return { quotes: out, skipped }
}

// Agworld price list CSV -> quotes (season = the year given) + product kinds.
export function parseCsv(text) {
  const rows = []
  let row = [], cur = '', q = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cur += '"'; i++ } else if (ch === '"') q = false; else cur += ch
    } else if (ch === '"') q = true
    else if (ch === ',') { row.push(cur); cur = '' } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cur); rows.push(row); row = []; cur = ''
    } else cur += ch
  }
  if (cur || row.length) { row.push(cur); rows.push(row) }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ''))
}
export function parseAgworld(text, season, source = 'Agworld price list') {
  const rows = parseCsv(text)
  const head = (rows[0] || []).map((c) => String(c).trim().toLowerCase())
  const ix = (n) => head.indexOf(n)
  const iName = ix('name'), iKind = ix('kind'), iUnitCost = ix('unit cost'), iUnits = ix('unit cost units'), iId = ix('id')
  if (iName < 0 || iKind < 0) throw new Error('This doesn’t look like an Agworld price list (needs “Name” and “Kind” columns).')
  const quotes = [], products = []
  rows.slice(1).forEach((r) => {
    const name = String(r[iName] || '').trim()
    if (!name) return
    const kind = String(r[iKind] || '').trim().toLowerCase().replace(/s$/, '')
    const cls = kind === 'operation' ? 'Custom operation' : kind === 'seed' ? 'Seed' : null
    const unit = normUnit(r[iUnits])
    const price = money(r[iUnitCost])
    products.push({ name, key: productKey(name), kind: kind === 'operation' ? 'operation' : kind === 'seed' ? 'seed' : 'product', class: cls, agworldId: String(r[iId] || '').trim() || null })
    if (price != null && price > 0) quotes.push({ name, key: productKey(name), season, seller: 'Agworld', price, unit, class: cls, source })
  })
  return { quotes, products }
}

// ---------------------------------------------------------------------------
// Merging quotes from several files: one entry per distinct
// product / season / seller / price / unit. The same product, season and
// seller at a different price is kept and flagged so it can be checked.
// `order` = sources, newest first (the newest wins ties).
// ---------------------------------------------------------------------------
const r4 = (n) => (n == null ? '' : Math.round(n * 10000) / 10000)
export const quoteSig = (q) => [q.key, q.season, q.seller || '', r4(q.price), q.unit || '', r4(q.rate), q.rateUnit || ''].join('|')
export function mergeQuotes(groups) {
  const bySig = new Map()
  const out = []
  groups.forEach(({ source, quotes }) => quotes.forEach((q) => {
    const sig = quoteSig(q)
    const have = bySig.get(sig)
    if (have) { if (!have.alsoIn.includes(source)) have.alsoIn.push(source); return }
    const e = { ...q, source, alsoIn: [] }
    bySig.set(sig, e)
    out.push(e)
  }))
  // conflicts: same product/season/seller, different price
  const byPSS = {}
  out.forEach((q) => { const k = `${q.key}|${q.season}|${q.seller || ''}`; (byPSS[k] = byPSS[k] || []).push(q) })
  Object.values(byPSS).forEach((list) => {
    const prices = new Set(list.map((q) => `${r4(q.price)}|${q.unit}`))
    if (prices.size > 1) list.forEach((q) => { q.conflict = list.filter((x) => x !== q).map((x) => `${x.price != null ? '$' + x.price : '—'}/${unitLabel(x.unit)} in ${x.source}`).join('; ') })
  })
  return out
}

// Products from quotes: the most common class / unit family and the newest
// non-empty details (AI, MOA, PHI…) for each product key.
const DRY_FORM = /(?:^|[\s\d])(sg|wg|wdg|df|wp|dg|gg|wsp|granular|granules|prill|prilled|pellet|pelleted)(?=$|\s)/
export function buildProducts(quotes, extra = []) {
  const by = {}
  const add = (q) => {
    const p = by[q.key] || (by[q.key] = { key: q.key, names: {}, classes: {}, fams: {}, latest: -1, kind: 'product' })
    p.names[q.name] = (p.names[q.name] || 0) + 1
    if (q.class) p.classes[q.class] = (p.classes[q.class] || 0) + 1
    // "oz" alone doesn't say liquid or dry, so it doesn't vote; the rate unit
    // can (fl oz / pt / qt → liquid, lb → dry).
    const u = normUnit(q.unit)
    const f = u === 'oz' ? '' : familyOf(u)
    if (f === 'vol' || f === 'wt') p.fams[f] = (p.fams[f] || 0) + 1
    const ru = normUnit(q.rateUnit)
    const rf = ru === 'oz' ? '' : familyOf(ru)
    if (rf === 'vol' || rf === 'wt') p.fams[rf] = (p.fams[rf] || 0) + 0.5
    if (u === 'oz') p.ozOnly = true
    if ((q.season || 0) >= p.latest) {
      p.latest = q.season || 0
      ;['ai', 'moa', 'phi', 'chemigation', 'plantbacks', 'mrl', 'rateLow', 'rateHigh', 'inSeasonMax', 'manufacturer', 'category'].forEach((k) => { if (q[k]) p[k] = q[k] })
      if (q.rate) { p.defaultRate = q.rate; p.rateUnit = q.rateUnit }
    }
  }
  quotes.forEach(add)
  extra.forEach((x) => {
    const p = by[x.key] || (by[x.key] = { key: x.key, names: {}, classes: {}, fams: {}, latest: -1, kind: x.kind })
    p.names[x.name] = (p.names[x.name] || 0) + 0.5
    if (x.kind) p.kind = x.kind
    if (x.class) p.classes[x.class] = (p.classes[x.class] || 0) + 1
    if (x.agworldId) { p.agworldId = x.agworldId; p.agworldName = x.name }
  })
  const top = (o) => Object.entries(o).sort((a, b) => b[1] - a[1])[0]?.[0] || null
  return Object.values(by).map((p) => {
    const names = Object.keys(p.names)
    const out = {
      key: p.key, name: top(p.names), aliases: names.filter((n) => n !== top(p.names)), kind: p.kind,
      class: top(p.classes),
      // only ever priced per oz: dry if it's a dry fertilizer, otherwise a liquid (fl oz)
      family: top(p.fams) || (p.ozOnly ? (/dry/i.test(top(p.classes) || '') || DRY_FORM.test(p.key) ? 'wt' : 'vol') : null)
    }
    ;['ai', 'moa', 'phi', 'chemigation', 'plantbacks', 'mrl', 'rateLow', 'rateHigh', 'inSeasonMax', 'manufacturer', 'category', 'defaultRate', 'rateUnit', 'agworldId', 'agworldName'].forEach((k) => { if (p[k] != null && p[k] !== '') out[k] = p[k] })
    return out
  })
}

// ---------------------------------------------------------------------------
// Bids: for one season and one product, every seller's quote, normalised to
// the product's base unit with its discount, cheapest first.
// ---------------------------------------------------------------------------
export function compareQuotes(quotes, product) {
  const fam = product && product.family
  return quotes.map((q) => ({ ...q, ...quoteMath(q, fam) }))
    .sort((a, b) => (a.net ?? Infinity) - (b.net ?? Infinity))
}
// Latest net price per season (cheapest seller that season) — for history charts.
export function seasonSeries(quotes, product) {
  const fam = product && product.family
  const by = {}
  const slips = unitSlips(quotes, product) // left out so one typo doesn't wreck the chart
  quotes.forEach((q, i) => {
    if (slips.has(q.id ?? i)) return
    const m = quoteMath(q, fam)
    if (m.net == null) return
    const s = (by[q.season] = by[q.season] || {})
    const k = q.seller || '—'
    if (s[k] == null || m.net < s[k]) s[k] = m.net
  })
  return Object.entries(by).sort((a, b) => +a[0] - +b[0]).map(([season, sellers]) => ({ season: +season, ...sellers, best: Math.min(...Object.values(sellers)) }))
}
export function changePct(series) {
  if (series.length < 2) return null
  const a = series[series.length - 2].best, b = series[series.length - 1].best
  return a > 0 ? (b - a) / a : null
}
// What to order: needed − on hand, times the order factor (the sheet ordered 95%).
export function toOrder(line, factor = 0.95) {
  const need = Number(line.volume) || 0
  const have = Number(line.onHand) || 0
  return Math.max(0, (need - have) * factor)
}
export const fmt$ = (n, d = 2) => (n == null || !isFinite(n) ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`)

// Prices that look like a unit slip in the files (e.g. a per-oz price typed in
// a per-gal column): more than 3× off the product's median net price.
// Returns a Set of quote ids (or indexes when quotes have no id).
export function unitSlips(quotes, product) {
  const fam = product && product.family
  const nets = quotes.map((q) => (q.seller === 'Agworld' ? null : quoteMath(q, fam).net))
  const vals = nets.filter((x) => x != null && x > 0).sort((a, b) => a - b)
  const out = new Set()
  if (vals.length < 3) return out
  const med = vals[Math.floor(vals.length / 2)]
  nets.forEach((n, i) => { if (n != null && n > 0 && (n > med * 3 || n < med / 3)) out.add(quotes[i].id ?? i) })
  return out
}
