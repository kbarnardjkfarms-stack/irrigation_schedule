// ET (crop water use) math for the irrigation schedule's ET column.
//
// How a number is made (see the "AIO ET Columns" doc for the full story):
//
//   crop ET for a day = reference ET for that day (alfalfa reference, "ETr",
//                       from the nearest AgriMet station)
//                     x crop factor (Kc) for that crop on that day
//
// Everything here is plain functions with no Firebase or React in them, so
// it can be tested on its own (etMath.test.js). Dates are ISO strings
// ("2026-07-04") and are treated as calendar days, never as clock times, so
// time zones can't shift a day.
//
// The Kc curves below were tuned so the 2026 Rupert season totals match
// AgriMet's published crop totals. That proves the math reproduces
// AgriMet's, not that AgriMet's crop assumptions are right for our fields.
// They are drafts for Kent to review. Change them here and nowhere else.

// ---- Dates ---------------------------------------------------------------

const DAY_MS = 86400000

function toUtc(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

export function addDaysIso(iso, n) {
  return new Date(toUtc(iso) + n * DAY_MS).toISOString().slice(0, 10)
}

export function daysBetweenIso(a, b) {
  return Math.round((toUtc(b) - toUtc(a)) / DAY_MS)
}

// ---- Crop curves ---------------------------------------------------------
//
// A curve is four straight-line stages: start Kc, rising to peak Kc at full
// cover, holding at peak for a share (`hold`) of the time from full cover to
// the end, then falling to end Kc.
//
// mode 'planting': timing counts from the field's plant date. `timing` lists
//   [plant date (month-day), days to full cover, days to the end] taken from
//   AgriMet's own planting-date templates; a field planted between two of
//   them gets the in-between values (earlier planting = a longer season).
// mode 'calendar': timing is fixed calendar dates (month-day), for crops
//   whose season doesn't start at a plant date we can rely on: established
//   alfalfa and fall-planted grains that green up in spring.

export const CURVES = {
  POTATO: { label: 'Potatoes', mode: 'planting', timing: [['04-15', 71, 143], ['05-01', 65, 132], ['05-15', 61, 123]], k0: 0.20, kp: 0.95, ke: 0.70, hold: 0.25 },
  SUGAR_BEET: { label: 'Sugar beets', mode: 'planting', timing: [['04-05', 87, 173], ['04-10', 86, 174], ['04-15', 86, 173]], k0: 0.15, kp: 0.95, ke: 0.70, hold: 0.25 },
  CORN: { label: 'Field corn', mode: 'planting', timing: [['04-25', 76, 138], ['05-10', 71, 133]], k0: 0.20, kp: 1.00, ke: 0.40, hold: 0.5 },
  SPRING_GRAIN: { label: 'Spring grain', mode: 'planting', timing: [['03-15', 87, 127], ['04-01', 80, 122]], k0: 0.25, kp: 1.10, ke: 0.10, hold: 0.75, approximate: true },
  ALFALFA: { label: 'Alfalfa (season average)', mode: 'calendar', start: '03-05', full: '05-05', end: '10-10', k0: 0.30, kp: 0.90, ke: 0.70, hold: 0.5, approximate: true },
  WINTER_GRAIN: { label: 'Winter grain', mode: 'calendar', start: '02-25', full: '05-10', end: '07-10', k0: 0.25, kp: 1.05, ke: 0.40, hold: 0.75, approximate: true }
}

// AIO's crop names (already upper-cased by normalizeCrop in App.jsx) to a
// curve. Crops with no entry (mint, watermelon, pumpkin, sweet corn, onion,
// fallow, ...) have no curve yet and show a blank ET.
const CROP_TO_CURVE = {
  POTATO: 'POTATO', POTATOES: 'POTATO',
  'SUGAR BEET': 'SUGAR_BEET', BEETS: 'SUGAR_BEET', 'SUGAR BEETS': 'SUGAR_BEET',
  CORN: 'CORN',
  ALFALFA: 'ALFALFA',
  RYE: 'WINTER_GRAIN', 'WHEAT - WINTER': 'WINTER_GRAIN', 'BARLEY - WINTER': 'WINTER_GRAIN',
  BARLEY: 'SPRING_GRAIN', 'BARLEY - SPRING': 'SPRING_GRAIN'
}

export function curveKeyForCrop(cropName) {
  const key = (cropName || '').toUpperCase().trim()
  return CROP_TO_CURVE[key] || null
}

// Days to full cover and days to the end for a given plant date, interpolated
// between the templates and held flat outside them.
function timingFor(curve, plantDate) {
  const year = plantDate.slice(0, 4)
  const pts = curve.timing.map(([md, toFull, total]) => ({ at: daysBetweenIso(`${year}-01-01`, `${year}-${md}`), toFull, total }))
  const at = daysBetweenIso(`${year}-01-01`, plantDate)
  if (at <= pts[0].at) return pts[0]
  if (at >= pts[pts.length - 1].at) return pts[pts.length - 1]
  for (let i = 1; i < pts.length; i++) {
    if (at <= pts[i].at) {
      const a = pts[i - 1], b = pts[i]
      const t = (at - a.at) / (b.at - a.at)
      return { toFull: Math.round(a.toFull + (b.toFull - a.toFull) * t), total: Math.round(a.total + (b.total - a.total) * t) }
    }
  }
  return pts[pts.length - 1]
}

// The three key dates of a curve for the year of `onDate`.
// Returns null when the curve can't be placed (planting mode with no plant
// date, which is how "no plant date = blank ET" is enforced).
function seasonDates(curve, plantDate, onDate) {
  if (curve.mode === 'planting') {
    if (!plantDate) return null
    const t = timingFor(curve, plantDate)
    return { start: plantDate, full: addDaysIso(plantDate, t.toFull), end: addDaysIso(plantDate, t.total) }
  }
  const year = onDate.slice(0, 4)
  return { start: `${year}-${curve.start}`, full: `${year}-${curve.full}`, end: `${year}-${curve.end}` }
}

// Crop factor for one day, or null when the crop isn't growing that day
// (before the start date or after the end date) or can't be placed.
export function kcOnDate(curveKey, plantDate, onDate) {
  const c = CURVES[curveKey]
  if (!c) return null
  const s = seasonDates(c, plantDate, onDate)
  if (!s) return null
  if (onDate < s.start || onDate > s.end) return null
  const hold = addDaysIso(s.full, Math.floor(daysBetweenIso(s.full, s.end) * c.hold))
  if (onDate <= s.full) {
    const span = Math.max(1, daysBetweenIso(s.start, s.full))
    return c.k0 + (c.kp - c.k0) * daysBetweenIso(s.start, onDate) / span
  }
  if (onDate <= hold) return c.kp
  const span = Math.max(1, daysBetweenIso(hold, s.end))
  return c.kp + (c.ke - c.kp) * daysBetweenIso(hold, onDate) / span
}

// ---- Weekly ET -----------------------------------------------------------

// Average of the most recent `count` measured days before `today`.
export function recentAverage(etrByDate, today, count = 7) {
  const vals = []
  for (let i = 1; i <= 30 && vals.length < count; i++) {
    const v = etrByDate[addDaysIso(today, -i)]
    if (typeof v === 'number') vals.push(v)
  }
  if (!vals.length) return null
  return vals.reduce((a, b) => a + b, 0) / vals.length
}

// Reference ET for one day and where it came from:
//   'measured' - a finished day AgriMet reported
//   'forecast' - today and the next 3 days: AgriMet's one daily forecast value
//   'average'  - anything else: the recent average (a finished day we never
//                recorded, or a day beyond the forecast)
// `station` = { etrByDate: {iso: inches}, forecast: inches|null, forecastAsOf: iso|null }
export function referenceEt(station, onDate, today) {
  const measured = station.etrByDate[onDate]
  if (onDate < today && typeof measured === 'number') return { value: measured, source: 'measured' }
  if (onDate >= today && onDate <= addDaysIso(today, 3) && typeof station.forecast === 'number') {
    return { value: station.forecast, source: 'forecast' }
  }
  const avg = recentAverage(station.etrByDate, today)
  if (avg == null) return { value: null, source: 'none' }
  return { value: avg, source: 'average' }
}

// Weighted mix of two stations ("between stations"): each day's reference ET
// is the plain average of the two stations' values for that day.
function mixedReferenceEt(stations, onDate, today) {
  const parts = stations.map((s) => referenceEt(s, onDate, today)).filter((p) => p.value != null)
  if (!parts.length) return { value: null, source: 'none' }
  const value = parts.reduce((a, p) => a + p.value, 0) / parts.length
  // The least certain source wins the label.
  const rank = { measured: 0, forecast: 1, average: 2, none: 3 }
  const source = parts.reduce((w, p) => (rank[p.source] > rank[w] ? p.source : w), 'measured')
  return { value, source }
}

// ET for the Monday-to-Sunday week starting `weekStart` (ISO).
// Returns null when there is nothing honest to show: no curve for the crop,
// no plant date where one is needed, or no weather data at all.
// Otherwise { inches, measuredDays, forecastDays, averageDays, growingDays }.
export function weeklyEt({ weekStart, today, cropName, plantDate, stations }) {
  const curveKey = curveKeyForCrop(cropName)
  if (!curveKey || !stations || !stations.length) return null
  const curve = CURVES[curveKey]
  if (curve.mode === 'planting' && !plantDate) return null

  let inches = 0
  const counts = { measured: 0, forecast: 0, average: 0 }
  let growingDays = 0
  let sawData = false
  for (let i = 0; i < 7; i++) {
    const day = addDaysIso(weekStart, i)
    const kc = kcOnDate(curveKey, plantDate, day)
    const ref = mixedReferenceEt(stations, day, today)
    if (ref.value != null) sawData = true
    if (kc == null) continue
    growingDays++
    if (ref.value == null) continue
    inches += kc * ref.value
    counts[ref.source]++
  }
  if (!sawData) return null
  return {
    inches,
    measuredDays: counts.measured,
    forecastDays: counts.forecast,
    averageDays: counts.average,
    growingDays,
    curveKey,
    approximate: !!curve.approximate
  }
}

// ---- Color of the Scheduled cell -----------------------------------------
//
// Scheduled inches as a share of the week's ET:
//   under 50%      red    far short
//   50% to <80%    yellow somewhat short
//   80% to 115%    green  on target
//   over 115%      split  need covered but too much scheduled (diagonal
//                         red/green)
//   anything else  gray   can't tell (no ET, no inches)
// The cutoffs are first guesses (Devin, Oct 30 2026). Change them here.

export const BANDS = { red: 0.5, yellow: 0.8, greenTop: 1.15 }

// Below this much ET for the week there is nothing meaningful to compare
// (crop not growing yet, or season over).
const MIN_ET = 0.05

export function scheduledBand(scheduledInches, etInches) {
  if (scheduledInches == null || etInches == null || etInches < MIN_ET) return 'gray'
  const share = scheduledInches / etInches
  if (share < BANDS.red) return 'red'
  if (share < BANDS.yellow) return 'yellow'
  if (share <= BANDS.greenTop) return 'green'
  return 'split'
}

export function scheduledShare(scheduledInches, etInches) {
  if (scheduledInches == null || etInches == null || etInches < MIN_ET) return null
  return scheduledInches / etInches
}

// ---- Which station a field uses ------------------------------------------
//
// Default by farm (from the Oct 30 station mapping). A field can override
// this with fieldSettings/{fieldId}.etStations = ['RPTI'] or two codes for a
// "between stations" field. Gooding is deliberately not listed: its fields
// are 18 to 31 miles from any station and split between Glenns Ferry and
// Filer, so each needs its own override until we store field centers.

export const STATION_NAMES = {
  RPTI: 'Rupert', GFRI: 'Glenns Ferry', GDVI: 'Grand View', TWFI: 'Twin Falls (Kimberly)',
  TFGI: 'Twin Falls (Filer)', PMAI: 'Parma', NMPI: 'Nampa', BOII: 'Boise'
}

const FARM_STATIONS = {
  HV: ['RPTI'], NORLAND: ['RPTI'], ACEQUIA: ['RPTI'],
  PAUL: ['TWFI', 'RPTI'],
  'KING HILL': ['GFRI'], GRINDSTONE: ['GFRI'], 'GLENNS FERRY': ['GFRI'], BLISS: ['GFRI'],
  OWYHEE: ['GDVI'],
  SALMON: ['TFGI']
}

// Returns { codes: [...], source: 'field' | 'farm' } or null when the field
// has no station yet.
export function stationsForField(farmName, fieldOverride) {
  if (Array.isArray(fieldOverride) && fieldOverride.length) {
    return { codes: fieldOverride.slice(0, 2), source: 'field' }
  }
  const key = (farmName || '').toUpperCase().trim()
  const codes = FARM_STATIONS[key]
  return codes ? { codes: codes.slice(), source: 'farm' } : null
}
