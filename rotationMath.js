// Pure rotation helpers for the Contracts module's Rotation tab — no React
// or Firebase, so they can be checked on their own.
//
// A rotation is { [fieldKey]: { name, area, years: { [year]: { crop, source } } } }
// built from two places:
//   - yieldHistory (the yield workbook lists every field every year, 2007 on,
//     plus anything entered / synced since) -> source 'history'
//   - Agworld's per-season crop (fields/{id}/seasons/{id}, synced nightly
//     from 2026 on, including next season once it's planned) -> source 'agworld'
// Agworld wins for a year it has, since it's the live plan going forward.
//   - USDA satellite crop map (Cropland Data Layer, 2008 on, per Agworld
//     field outline; see functions/satelliteRotation.js) -> source
//     'satellite'. Only fills years the two sources above have no crop for.

import { canonCrop, fieldKey } from './yieldMath.js'

export function seasonYear(s) {
  if (!s) return null
  const m = String(s.name || '').match(/\b(19|20)\d{2}\b/)
  if (m) return Number(m[0])
  const d = s.startDate || s.endDate
  return d ? Number(String(d).slice(0, 4)) : null
}

// historyDocs: yieldHistory docs (deleted ones skipped)
// agworldRows: [{ name, farmName, year, crop }]
export function buildRotation(historyDocs, agworldRows, satRows) {
  const rot = {}
  const entry = (key, name, area) => {
    const e = (rot[key] = rot[key] || { key, name, area: area || null, years: {} })
    if (!e.name && name) e.name = name
    if (!e.area && area) e.area = area
    return e
  }
  ;(historyDocs || []).forEach((d) => {
    if (!d || d.deleted) return
    const key = d.fieldKey || fieldKey(d.fieldName)
    const year = Number(d.year)
    if (!key || !year) return
    const crop = d.crop || (d.agworld && d.agworld.crop) || null
    const e = entry(key, d.fieldName, d.area)
    // Two workbook rows for one field-year (double crop): keep the first
    // real crop; FALLOW never overrides a crop.
    const cur = e.years[year]
    if (!cur || (!cur.crop && crop) || (cur.crop === 'FALLOW' && crop && crop !== 'FALLOW')) {
      e.years[year] = { crop: crop || null, source: 'history', leasedOut: !!d.leasedOut }
    }
  })
  ;(agworldRows || []).forEach((r) => {
    const key = fieldKey(r.name)
    if (!key || !r.year) return
    const crop = canonCrop(r.crop)
    const e = entry(key, r.name, r.farmName)
    if (r.farmName) e.farmName = r.farmName
    if (crop) e.years[r.year] = { crop, source: 'agworld' }
    else if (!e.years[r.year]) e.years[r.year] = { crop: null, source: 'agworld' }
  })
  // satRows: [{ name, farmName, year, crop, share, cdlName }] keyed by the
  // field's CURRENT Agworld name, so a renamed/split field still lines up.
  ;(satRows || []).forEach((r) => {
    const key = fieldKey(r.name)
    if (!key || !r.year || !r.crop) return
    const e = entry(key, r.name, r.farmName)
    e.sat = e.sat || {}
    e.sat[r.year] = { crop: r.crop, share: r.share, cdlName: r.cdlName }
    const cur = e.years[r.year]
    if (!cur || !cur.crop) e.years[r.year] = { crop: r.crop, source: 'satellite', share: r.share, cdlName: r.cdlName }
  })
  return rot
}

// Years with crop C for one field, ascending, up to and including `toYear`.
export function cropYears(field, crop, toYear) {
  return Object.entries(field.years)
    .filter(([y, v]) => v.crop === crop && Number(y) <= toYear)
    .map(([y]) => Number(y))
    .sort((a, b) => a - b)
}

// Per-field numbers for one focus crop, relative to a reference year (the
// contract season) and a look-back window (the W years ending with it).
//   yearsOut   reference year minus the last year it was in the crop (0 =
//              in it this year); null if never in it on record
//   neverSince first year on record when it has never been in the crop
//   count      years in the crop inside the window
//   minGap     shortest gap between two crops of it inside the window
//              (3 = e.g. 2020 then 2023); null if fewer than two
//   avgGap     average of those gaps
//   known      years in the window with a known crop (data coverage)
export function fieldStats(field, crop, refYear, windowYears) {
  const from = refYear - windowYears + 1
  const ys = cropYears(field, crop, refYear)
  const last = ys.length ? ys[ys.length - 1] : null
  const inWin = ys.filter((y) => y >= from)
  const gaps = []
  for (let i = 1; i < inWin.length; i++) gaps.push(inWin[i] - inWin[i - 1])
  // A gap that straddles the window start still says how tight the rotation
  // is, so include the step into the window from the crop just before it.
  const before = ys.filter((y) => y < from)
  if (inWin.length && before.length) gaps.unshift(inWin[0] - before[before.length - 1])
  const recordYears = Object.keys(field.years).map(Number).filter((y) => y <= refYear)
  const firstYear = recordYears.length ? Math.min(...recordYears) : null
  let known = 0
  for (let y = from; y <= refYear; y++) if (field.years[y] && field.years[y].crop) known++
  return {
    last,
    yearsOut: last == null ? null : refYear - last,
    neverSince: last == null ? firstYear : null,
    count: inWin.length,
    minGap: gaps.length ? Math.min(...gaps) : null,
    avgGap: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    known
  }
}

// For "yield vs years since the crop was last on the field": every yield
// record of the crop paired with the gap since that field's previous crop
// of it (gap 1 = back-to-back years).
export function yieldByGap(rotation, yieldRecords, crop) {
  const out = []
  ;(yieldRecords || []).forEach((r) => {
    if (r.crop !== crop || !(r._yield > 0)) return
    const f = rotation[r.fieldKey]
    if (!f) return
    const prev = cropYears(f, crop, r.year - 1)
    if (!prev.length) return
    out.push({ gap: r.year - prev[prev.length - 1], yield: r._yield, acres: r.acres || 0, field: r.fieldName, year: r.year })
  })
  return out
}
