// Pure helpers for the Yield History module (Yields.jsx) — no React or
// Firebase, so the normalization and averaging can be checked on their own.
//
// IMPORTANT: canonCrop() and fieldKey() are duplicated in
// functions/index.js (the Agworld yield sync). Keep both copies in step, or
// Agworld rows and spreadsheet rows for the same field/year won't line up.

// One crop name per crop, matching how Agworld names them where we know it
// (POTATO, BEETS, CORN, ONIONS — see CROP_COLOR in App.jsx). The workbook
// spells them many ways ("Potatoes", "potatoes", "Hay 3", "Rented Potatoes").
export function canonCrop(raw) {
  const s = String(raw || '').trim().toUpperCase().replace(/\s+/g, ' ')
  if (!s) return null
  if (/^(RENTED )?POTATO(ES)?$/.test(s)) return 'POTATO'
  if (/^MINI POTATO(ES)?$/.test(s)) return 'MINI POTATOES'
  if (/^(SUGAR ?)?BEETS?$/.test(s)) return 'BEETS'
  if (/^SWEET CORN$/.test(s)) return 'SWEET CORN'
  if (/^(FIELD |SILAGE |GRAIN )?CORN$/.test(s)) return 'CORN'
  if (/^HAY\b/.test(s) || s === 'TIMOTHY' || s === 'ALFALFA') return 'HAY'
  if (/^RYE\b/.test(s)) return 'RYE'
  if (/^BEANS?$/.test(s) || /\bBEANS?$/.test(s)) return 'BEANS'
  if (/^ONIONS?$/.test(s)) return 'ONIONS'
  if (/^MELONS?$|WATERMELON/.test(s)) return 'MELONS'
  if (/^PUMPKINS?$/.test(s)) return 'PUMPKINS'
  if (/^LETTUCE$/.test(s)) return 'LETTUCE'
  return s
}

// Name-based link between a workbook row, an Agworld field and a yield doc:
// uppercase, letters and digits only. "Hawaii 05" / "HAWAII 05" / "HAWAII05"
// and "18-A" / "18A" all land on the same key.
export function fieldKey(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

// Yield units per acre, by crop, as the workbook records them.
export const CROP_UNIT = {
  POTATO: 'cwt', 'MINI POTATOES': 'cwt', BEETS: 'tons', CORN: 'tons', 'SWEET CORN': 'tons',
  BEANS: 'cwt', HAY: 'tons', ONIONS: 'cwt', RYE: 'tons'
}
export function unitFor(crop) { return CROP_UNIT[crop] || 'units' }

// ---------------------------------------------------------------------------
// Spreadsheet import
// ---------------------------------------------------------------------------

// Normalized header text -> record property. Matched on the first column
// with that header, so the repeated petiole blocks further right never win.
const HEADER_MAP = {
  field: 'fieldName', year: 'year', area: 'area', manager: 'manager', crop: 'cropRaw',
  acres: 'acres', elevation: 'elevation', previouscrop: 'previousCropRaw',
  lastyearitwasinthesamecrop: 'lastSameCrop', numberofthatcropin15years: 'cropCount15',
  variety: 'variety', subvariety: 'subVariety', seedspacing: 'seedSpacing',
  '1stplantdate': 'plantDate', '1stwetdate': 'wetDate', finalplantdate: 'finalPlantDate',
  finalwetdate: 'finalWetDate', killdate: 'killDate', harvestdate: 'harvestDate',
  irrigationsystem: 'irrigation', standcount: 'standCount',
  adjustedyield: 'adjustedYield', adjustedyieldbyacre: 'yieldPerAcre',
  earlyincentivefactor: 'earlyIncentive', tarefactor: 'tareFactor', unadjustedyield: 'unadjustedYield',
  drymattersugar: 'dryMatterSugar', sugarearlyincentive: 'sugarEarlyIncentive',
  ones: 'ones', size: 'size', sizecategory: 'sizeCategory', bruisefree: 'bruiseFree',
  frycolor: 'fryColor', sugarends: 'sugarEnds', directorstorage: 'directOrStorage',
  nitrates: 'nitrates', starch: 'starch', fumigationproduct: 'fumigationProduct',
  fumigationrate: 'fumigationRate', landlord: 'landlord', watersource: 'waterSource'
}
const DATE_PROPS = new Set(['plantDate', 'wetDate', 'finalPlantDate', 'finalWetDate', 'killDate', 'harvestDate'])
const NUM_PROPS = new Set(['year', 'acres', 'elevation', 'cropCount15', 'seedSpacing', 'standCount', 'adjustedYield',
  'yieldPerAcre', 'earlyIncentive', 'tareFactor', 'unadjustedYield', 'dryMatterSugar', 'sugarEarlyIncentive', 'fumigationRate'])
const TEXT_PROPS = new Set(['fieldName', 'area', 'manager', 'cropRaw', 'previousCropRaw', 'variety', 'subVariety', 'irrigation',
  'fumigationProduct', 'landlord', 'waterSource', 'directOrStorage', 'lastSameCrop'])

const normHeader = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '')
const isBlank = (v) => v == null || (typeof v === 'string' && /^(|n\/?a|na|none|-|—)$/i.test(v.trim()))

function toNum(v) {
  if (isBlank(v)) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(String(v).replace(/[,$%\s]/g, ''))
  return Number.isFinite(n) ? n : null
}
function pad(n) { return String(n).padStart(2, '0') }
function toIsoDate(v) {
  if (isBlank(v)) return null
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  if (typeof v === 'number' && v > 20000 && v < 80000) { // Excel serial date
    const d = new Date(Math.round((v - 25569) * 86400000))
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  }
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}
// Day of year (1-366). The workbook's own convention moves every date onto
// one calendar year so planting can be compared across years — this does
// the same for any date.
export function dayOfYear(iso) {
  if (!iso) return null
  const [, m, d] = iso.split('-').map(Number)
  return Math.round((Date.UTC(2001, m - 1, d) - Date.UTC(2001, 0, 1)) / 86400000) + 1
}
function titleCase(s) {
  if (!s) return s
  return String(s).trim().toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase())
}

// rows: array-of-arrays from the "Database" sheet (SheetJS sheet_to_json
// with header: 1). Finds the header row itself (the one with Field + Year),
// so a note row added above it doesn't break the import.
export function parseYieldRows(rows) {
  const hIdx = rows.findIndex((r) => Array.isArray(r) && r.some((c) => normHeader(c) === 'field') && r.some((c) => normHeader(c) === 'year'))
  if (hIdx < 0) throw new Error('Couldn’t find the header row (needs “Field” and “Year” columns) on the Database sheet.')
  const colOf = {}
  rows[hIdx].forEach((h, i) => {
    const prop = HEADER_MAP[normHeader(h)]
    if (prop && colOf[prop] == null) colOf[prop] = i
  })
  const records = []
  const warnings = []
  const seen = {}
  rows.slice(hIdx + 1).forEach((r, offset) => {
    if (!Array.isArray(r)) return
    const rec = {}
    Object.entries(colOf).forEach(([prop, i]) => {
      const v = r[i]
      if (DATE_PROPS.has(prop)) rec[prop] = toIsoDate(v)
      else if (NUM_PROPS.has(prop)) rec[prop] = toNum(v)
      else if (TEXT_PROPS.has(prop)) rec[prop] = isBlank(v) ? null : String(v).trim()
      else rec[prop] = isBlank(v) ? null : (typeof v === 'number' ? v : String(v).trim())
    })
    if (!rec.fieldName || !rec.year) {
      if (r.some((c) => !isBlank(c))) warnings.push(`Row ${hIdx + offset + 2}: no field name or year — skipped`)
      return
    }
    rec.year = Math.round(rec.year)
    rec.crop = canonCrop(rec.cropRaw)
    rec.previousCrop = canonCrop(rec.previousCropRaw)
    rec.irrigation = titleCase(rec.irrigation)
    if (rec.manager && /leased\s*out/i.test(rec.manager)) rec.leasedOut = true
    rec.manager = rec.manager ? titleCase(rec.manager) : null
    rec.variety = rec.variety ? rec.variety.replace(/\s+/g, ' ') : null
    // Per-acre yield: the workbook's own column first (it's the adjusted
    // number the team trusts); fall back to adjusted ÷ acres. A zero is an
    // empty cell in practice (unharvested / current year), not a real 0.
    if (!(rec.yieldPerAcre > 0)) {
      rec.yieldPerAcre = rec.adjustedYield > 0 && rec.acres > 0 ? rec.adjustedYield / rec.acres : null
    }
    rec.unit = unitFor(rec.crop)
    rec.plantDoy = dayOfYear(rec.plantDate)
    rec.harvestDoy = dayOfYear(rec.harvestDate)
    rec.fieldKey = fieldKey(rec.fieldName)
    const base = `${rec.fieldKey}__${rec.year}`
    seen[base] = (seen[base] || 0) + 1
    rec.id = seen[base] === 1 ? base : `${base}__${seen[base]}`
    rec.sourceRow = hIdx + offset + 2
    records.push(rec)
  })
  return { records, warnings }
}

// ---------------------------------------------------------------------------
// Analysis helpers
// ---------------------------------------------------------------------------

// The yield a record shows: the adjusted yield entered in AIO or imported
// from the workbook when there is one, otherwise what Agworld reported.
export function effectiveYield(rec) {
  if (rec.yieldPerAcre > 0) return { value: rec.yieldPerAcre, source: rec.yieldSource === 'manual' ? 'manual' : 'spreadsheet' }
  if (rec.agworld && rec.agworld.yieldPerAcre > 0) return { value: rec.agworld.yieldPerAcre, source: 'agworld' }
  return { value: null, source: null }
}

// Acre-weighted average yield (a 140-ac field counts 4× a 35-ac one), plus
// count, acres, min and max. Falls back to a straight mean if acres are
// missing on every record.
export function summarize(recs) {
  let wSum = 0, aSum = 0, plain = 0, n = 0, min = Infinity, max = -Infinity
  recs.forEach((r) => {
    const y = r._yield
    if (!(y > 0)) return
    n++; plain += y
    if (y < min) min = y
    if (y > max) max = y
    if (r.acres > 0) { wSum += y * r.acres; aSum += r.acres }
  })
  if (!n) return { n: 0, avg: null, acres: 0, min: null, max: null }
  return { n, avg: aSum > 0 ? wSum / aSum : plain / n, acres: aSum, min, max }
}

export function groupBy(recs, keyFn) {
  const m = new Map()
  recs.forEach((r) => {
    const k = keyFn(r)
    if (k == null || k === '') return
    if (!m.has(k)) m.set(k, [])
    m.get(k).push(r)
  })
  return m
}

export function fmt(n, digits = 0) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function doyLabel(doy) {
  if (doy == null) return '—'
  const d = new Date(Date.UTC(2001, 0, doy))
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

// Categorical series colors, fixed order (validated palette, light mode).
// Assigned by entity — a field keeps its color as others are added/removed.
export const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948']
export const MAX_SERIES = 8
