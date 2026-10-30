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
//     'satellite'. By default it only fills years the two sources above have
//     no crop for; with { satFirst: true } it wins for every year it covers
//     (the record's own crop is kept as `recordCrop` for the tooltip).

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
export function buildRotation(historyDocs, agworldRows, satRows, { satFirst = false, lineage = null } = {}) {
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
  // Field history links (fieldLineage): a current field takes the crop of
  // its linked old field(s) for any year it has no record of its own — e.g.
  // COOK N and COOK S inherit the years the workbook only has as "COOK".
  // Applied before the satellite, so the satellite still only fills what's
  // left (or overrides everything, with satFirst).
  if (lineage) applyLineage(rot, lineage, entry)
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
    // (Never let one satellite row override another — two Agworld fields
    // whose names collapse to the same key, e.g. "18-D" and "18D".)
    else if (satFirst && cur.source !== 'satellite' && cur.crop !== r.crop) e.years[r.year] = { crop: r.crop, source: 'satellite', share: r.share, cdlName: r.cdlName, recordCrop: cur.crop, recordSource: cur.source }
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

// Crops the records and the satellite name differently but that are the
// same thing for rotation purposes (the workbook says "Small Grain" where the
// satellite says wheat or barley, alfalfa vs other hay, etc.).
const CROP_FAMILY = {
  WHEAT: 'GRAIN', BARLEY: 'GRAIN', 'SMALL GRAIN': 'GRAIN', RYE: 'GRAIN', OATS: 'GRAIN',
  HAY: 'HAY', PASTURE: 'HAY', 'GRASS SEED': 'HAY',
  CORN: 'CORN', 'SWEET CORN': 'CORN',
  POTATO: 'POTATO', 'MINI POTATOES': 'POTATO'
}
export const cropFamily = (c) => CROP_FAMILY[c] || c

// How well the satellite matches the records, wherever both have a crop for
// the same field-year (build the rotation records-first to call this).
// Exact = same crop; family = same rotation group (wheat vs "small grain").
export function satelliteAgreement(rotation, { fromYear = 0, toYear = 9999 } = {}) {
  const byCrop = {}
  const misses = []
  let n = 0, exact = 0, family = 0
  Object.values(rotation).forEach((f) => {
    if (!f.sat) return
    Object.entries(f.sat).forEach(([y, s]) => {
      const yr = Number(y)
      if (yr < fromYear || yr > toYear) return
      const rec = f.years[y]
      if (!rec || !rec.crop || rec.source === 'satellite' || !s.crop) return
      if (rec.crop === 'FALLOW') return
      n++
      const ex = rec.crop === s.crop
      const fam = ex || cropFamily(rec.crop) === cropFamily(s.crop)
      if (ex) exact++
      if (fam) family++
      const b = (byCrop[rec.crop] = byCrop[rec.crop] || { crop: rec.crop, n: 0, exact: 0, family: 0, saidAs: {} })
      b.n++; if (ex) b.exact++; if (fam) b.family++
      if (!fam) { b.saidAs[s.crop] = (b.saidAs[s.crop] || 0) + 1; misses.push({ field: f.name, year: yr, record: rec.crop, recordSource: rec.source, satellite: s.crop, share: s.share }) }
    })
  })
  const crops = Object.values(byCrop).sort((a, b) => b.n - a.n)
  return { n, exact, family, exactPct: n ? exact / n : null, familyPct: n ? family / n : null, crops, misses: misses.sort((a, b) => b.year - a.year) }
}

// lineage: { [childKey]: { childName, parents: [{ key, name }] } }
function applyLineage(rot, lineage, entry) {
  // Snapshot each parent's own years first, so a chain (A -> B -> C) or two
  // children of one parent can't feed off each other's inherited years.
  const own = {}
  Object.values(lineage).forEach((l) => (l.parents || []).forEach((p) => {
    if (own[p.key] || !rot[p.key]) return
    own[p.key] = Object.entries(rot[p.key].years).filter(([, v]) => v && v.crop && !v.inheritedFrom)
  }))
  Object.entries(lineage).forEach(([childKey, l]) => {
    const c = entry(childKey, l.childName)
    c.linkedFrom = (l.parents || []).map((p) => p.name || p.key)
    ;(l.parents || []).forEach((p) => {
      ;(own[p.key] || []).forEach(([y, v]) => {
        const cur = c.years[y]
        if (cur && cur.crop) return
        c.years[y] = { ...v, inheritedFrom: (rot[p.key] && rot[p.key].name) || p.name || p.key }
      })
    })
  })
}

// Name-based link suggestions: a current field whose name is an old field's
// name plus a split suffix ("COOK N" <- "COOK", "CELLAR MINI" <- "CELLAR"),
// or the other way round for fields that were merged. Keys are fieldKey()
// form (letters and digits only). Old fields that are still current fields
// themselves are skipped.
const SPLIT_SUFFIX = /^(N|S|E|W|NE|NW|SE|SW|NORTH|SOUTH|EAST|WEST|MINI|BIG|MAIN|MIDDLE|MID|MDL|CORNER|CORNERS|LITTLE|SMALL|LARGE|UPPER|LOWER|TOP|BOTTOM|PIVOT\d*|PIV\d*|P\d{1,2}|\d{1,2}|[A-H])$/
export function suggestLinksByName(currentFields, historyFields) {
  const current = new Set(currentFields.map((f) => f.key))
  const out = []
  currentFields.forEach((cf) => {
    historyFields.forEach((hf) => {
      if (!hf.key || hf.key === cf.key || current.has(hf.key)) return
      let how = null
      if (cf.key.startsWith(hf.key) && SPLIT_SUFFIX.test(cf.key.slice(hf.key.length))) how = 'split'
      else if (hf.key.startsWith(cf.key) && SPLIT_SUFFIX.test(hf.key.slice(cf.key.length))) how = 'merged'
      if (how) out.push({ childKey: cf.key, childName: cf.name, parentKey: hf.key, parentName: hf.name, how, years: hf.years })
    })
  })
  return out
}
