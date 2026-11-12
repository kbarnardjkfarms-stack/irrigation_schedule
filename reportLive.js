// Live data for the Irrigation Reports view.
//
// Reads what AIO really has, for one season, and turns it into the same
// field-and-week rows the demo data uses. Anything AIO doesn't have is left
// null (never 0), so the report can say "no data" instead of showing a made-up
// number. Where AIO already has a calculation, this file uses the same one:
// ET from etMath.js, applied inches from appliedMath.js, scheduled inches the
// same way the schedule screen works them out.
//
// What feeds each column today (Nov 2026):
//   etActual / etEstimate  etMath.js on the saved AgriMet days (agrimetDaily).
//                          Only days saved since the nightly archive started
//                          are there, so older weeks stay blank until the
//                          season's daily history is loaded once.
//   rain                   Not saved anywhere in AIO yet, so always null.
//   schedIn                weeks/{week}/events (the schedule screen's records),
//                          times the pivot's GPM over the field's acres.
//   appIn                  pivotWetLog (counted from the week of Nov 9, 2026),
//                          through computeApplied().
//   moisture               scoutingObservations (needs Agronomy access).

import { collection, collectionGroup, getDocs, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { addDaysIso, curveKeyForCrop, CURVES, kcOnDate, normalizeIsoDate, stationsForField, weeklyEt } from './etMath.js'
import { computeApplied, GALLONS_PER_ACRE_INCH } from './appliedMath.js'

// Same crop-name folding the schedule screen uses.
const CROP_ALIASES = { LUCERNE: 'ALFALFA', MAIZE: 'CORN' }
export function cropLabel(name) {
  const up = (name || '').toUpperCase().trim()
  if (!up) return 'No crop'
  const key = CROP_ALIASES[up] || up
  return key.toLowerCase().replace(/(^|[\s/-])([a-z])/g, (m, a, b) => a + b.toUpperCase())
}
const cropKey = (name) => { const up = (name || '').toUpperCase().trim(); return CROP_ALIASES[up] || up }

const isNum = (v) => typeof v === 'number' && Number.isFinite(v)

export function mondayIso(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  const back = (d.getUTCDay() + 6) % 7
  return addDaysIso(iso, -back)
}

function toIso(t) {
  if (!t) return ''
  if (typeof t.toDate === 'function') return t.toDate().toISOString().slice(0, 10)
  if (t instanceof Date) return t.toISOString().slice(0, 10)
  return String(t).slice(0, 10)
}

// The same on/off math the schedule screen uses (hours on in a 168-hour week).
function hoursOn(events) {
  const evs = [...events].sort((a, b) => a.ts - b.ts)
  let state = false
  let cursor = 0
  let total = 0
  evs.forEach((e) => {
    if (state) total += Math.max(0, Math.min(e.ts, 168) - Math.max(cursor, 0))
    cursor = e.ts
    state = e.type === 'on'
  })
  if (state) total += Math.max(0, 168 - Math.max(cursor, 0))
  return total
}

export async function fetchSeasons() {
  const snap = await getDocs(collection(db, 'seasons'))
  const list = []
  snap.forEach((d) => {
    const v = d.data()
    const m = (String(v.name || '') + ' ' + String(v.startDate || '') + ' ' + d.id).match(/20\d\d/)
    list.push({ id: d.id, name: v.name || d.id, startDate: v.startDate || '', year: m ? Number(m[0]) : null })
  })
  list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || '') || String(b.name).localeCompare(String(a.name)))
  return list
}

async function settle(promise, label, warnings) {
  try {
    return await promise
  } catch (err) {
    warnings.push(label)
    console.warn('Reports: could not read', label, err && err.message)
    return null
  }
}

function docsMap(snap, pick) {
  const out = {}
  if (!snap) return out
  snap.forEach((d) => { out[d.id] = pick ? pick(d) : d.data() })
  return out
}

// Reads everything for one season. Returns the raw inputs for buildLiveReport.
export async function fetchLiveInputs(season, todayIso) {
  const warnings = []
  const [fieldsSnap, farmsSnap, seasonSnap, mapSnap, pivotsSnap, profilesSnap, settingsSnap, agriSnap] = await Promise.all([
    getDocs(collection(db, 'fields')),
    settle(getDocs(collection(db, 'farms')), 'farms', warnings),
    getDocs(query(collectionGroup(db, 'seasons'), where('seasonId', '==', season.id))),
    settle(getDocs(collection(db, 'pivotFieldMapping')), 'pivot links', warnings),
    settle(getDocs(collection(db, 'pivots')), 'pivots', warnings),
    settle(getDocs(collection(db, 'pivotProfiles')), 'pivot GPMs', warnings),
    settle(getDocs(collection(db, 'fieldSettings')), 'field settings', warnings),
    settle(getDocs(collection(db, 'agrimetDaily')), 'weather', warnings)
  ])

  const baseFields = {}
  fieldsSnap.forEach((d) => { if (!d.data().hiddenFromIrrigation) baseFields[d.id] = d.data() })
  const seasonByField = {}
  seasonSnap.forEach((d) => { seasonByField[d.ref.parent.parent.id] = d.data() })

  const farmsById = docsMap(farmsSnap)
  const pivotGuidByField = {}
  if (mapSnap) mapSnap.forEach((d) => { const v = d.data(); pivotGuidByField[v.fieldId] = v.pivotGuid })
  const etStationsByField = {}
  if (settingsSnap) settingsSnap.forEach((d) => { if (Array.isArray(d.data().etStations)) etStationsByField[d.id] = d.data().etStations })
  const agrimetByStation = {}
  if (agriSnap) {
    agriSnap.forEach((d) => {
      const v = d.data()
      agrimetByStation[d.id] = { etrByDate: v.days || {}, forecast: isNum(v.forecast) ? v.forecast : null, forecastAsOf: v.forecastAsOf || null }
    })
  }

  // Weeks to read (Mar 1 of the season's year to Nov 30, never past this week).
  const weeks = seasonWeeks(season.year, todayIso)

  const eventsByWeek = {}
  await Promise.all(weeks.map(async (w) => {
    const snap = await settle(getDocs(collection(db, 'weeks', w, 'events')), 'schedule for ' + w, warnings)
    if (!snap) return
    const m = {}
    snap.forEach((d) => { m[d.id] = d.data().events || [] })
    if (Object.keys(m).length) eventsByWeek[w] = m
  }))

  const wetLogByWeek = {}
  const wetSnap = weeks.length ? await settle(getDocs(query(collection(db, 'pivotWetLog'), where('weekStart', '>=', weeks[0]))), 'pivot run log', warnings) : null
  if (wetSnap) {
    wetSnap.forEach((d) => {
      const v = d.data()
      if (!v.weekStart || !v.pivotGuid) return
      ;(wetLogByWeek[v.weekStart] = wetLogByWeek[v.weekStart] || {})[v.pivotGuid] = v
    })
  }

  // Moisture readings (Agronomy access). Looked up in groups of 30 field ids.
  const moistureByFieldWeek = {}
  let moistureAvailable = true
  const ids = Object.keys(seasonByField).filter((id) => baseFields[id])
  const chunks = []
  for (let i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30))
  if (weeks.length) {
    const results = await Promise.all(chunks.map((c) => settle(getDocs(query(collection(db, 'scoutingObservations'), where('fieldId', 'in', c))), 'moisture readings', [])))
    if (results.some((r) => r == null)) moistureAvailable = false
    results.forEach((snap) => {
      if (!snap) return
      snap.forEach((d) => {
        const v = d.data()
        if (!isNum(Number(v.moisture)) || v.moisture == null || v.moisture === '') return
        const day = toIso(v.observedAt)
        if (!day || Number(day.slice(0, 4)) !== season.year) return
        const w = mondayIso(day)
        const slot = ((moistureByFieldWeek[v.fieldId] = moistureByFieldWeek[v.fieldId] || {})[w] = moistureByFieldWeek[v.fieldId][w] || { sum: 0, n: 0 })
        slot.sum += Number(v.moisture)
        slot.n += 1
      })
    })
    if (!moistureAvailable) warnings.push('Moisture readings need Agronomy access, so none are shown.')
  }

  return {
    season, todayIso, weeks, baseFields, seasonByField, farmsById, pivotGuidByField,
    pivotsByGuid: docsMap(pivotsSnap), profilesByGuid: docsMap(profilesSnap),
    etStationsByField, agrimetByStation, eventsByWeek, wetLogByWeek, moistureByFieldWeek, warnings
  }
}

export function seasonWeeks(year, todayIso) {
  if (!year) return []
  const first = mondayIso(`${year}-03-01`)
  const last = mondayIso(`${year}-11-30`)
  const current = mondayIso(todayIso)
  const end = last < current ? last : current
  const out = []
  for (let w = first; w <= end; w = addDaysIso(w, 7)) out.push(w)
  return out
}

// Turns the raw inputs into { fields, rows, ... } for the report page.
export function buildLiveReport(inp) {
  const { weeks, todayIso } = inp
  const currentWeekId = mondayIso(todayIso)
  const fields = []
  const rows = []

  Object.keys(inp.seasonByField).forEach((id) => {
    const base = inp.baseFields[id]
    if (!base) return
    const sd = inp.seasonByField[id] || {}
    const farmName = base.farmName || (inp.farmsById[base.farmId] && inp.farmsById[base.farmId].name) || ''
    const crop = cropLabel(sd.cropName)
    const key = cropKey(sd.cropName)
    const plantDate = normalizeIsoDate(sd.plantDate)
    const acres = Number(sd.acres) > 0 ? Number(sd.acres) : null
    const curveKey = curveKeyForCrop(key)
    const stationInfo = stationsForField(farmName, inp.etStationsByField[id])
    const stationData = stationInfo ? stationInfo.codes.map((c) => inp.agrimetByStation[c]).filter(Boolean) : []
    const pivotGuid = inp.pivotGuidByField[id]
    const pivot = pivotGuid ? inp.pivotsByGuid[pivotGuid] : null
    const profile = pivotGuid ? inp.profilesByGuid[pivotGuid] : null
    const gpm = profile && Number(profile.currentGpm) > 0 ? Number(profile.currentGpm) : null

    // Why the report can't show ET for this field at all.
    const issues = []
    if (!key) issues.push('No crop in AgWorld for this season')
    else if (!curveKey) issues.push('No crop curve for ' + crop.toLowerCase() + ' yet')
    else if (CURVES[curveKey].mode === 'planting' && !plantDate) issues.push('No plant date in AgWorld')
    if (key && curveKey && !stationInfo) issues.push('No weather station for this farm yet')
    // Why scheduled / applied inches can't be worked out.
    const notes = []
    if (!pivotGuid) notes.push('No pivot linked to this field')
    else if (!gpm) notes.push('Its pivot has no GPM yet')
    if (!acres) notes.push('No acres in AgWorld')

    const field = { key: id, name: base.name || base.fieldName || id, label: base.name || base.fieldName || id, farm: farmName, crop, acres, issues, notes, hasData: false }
    fields.push(field)

    weeks.forEach((w) => {
      let etActual = null
      let etEstimate = null
      if (curveKey && stationData.length && !issues.length) {
        let growing = 0
        let measured = 0
        let inches = 0
        for (let i = 0; i < 7; i++) {
          const day = addDaysIso(w, i)
          const kc = kcOnDate(curveKey, plantDate, day)
          if (kc == null) continue
          growing++
          const vals = stationData.map((s) => s.etrByDate[day]).filter(isNum)
          if (vals.length && day < todayIso) {
            inches += kc * (vals.reduce((a, b) => a + b, 0) / vals.length)
            measured++
          }
        }
        if (growing > 0) {
          if (measured === growing) etActual = inches
          try {
            const est = weeklyEt({ weekStart: w, today: w, cropName: key, plantDate, stations: stationData })
            if (est && est.growingDays > 0) etEstimate = est.inches
          } catch (err) {
            etEstimate = null
          }
        }
      }

      const events = inp.eventsByWeek[w] && inp.eventsByWeek[w][id]
      let schedIn = null
      if (events) {
        const hrs = hoursOn(events)
        schedIn = hrs <= 0 ? 0 : (gpm && acres ? (gpm * hrs * 60) / (GALLONS_PER_ACRE_INCH * acres) : null)
      }

      let appIn = null
      if (pivotGuid) {
        const a = computeApplied({ pivotGuid, pivot, profile, field: { acres }, wetLog: inp.wetLogByWeek[w] || {}, weekId: w, currentWeekId })
        if (a && a.ok) appIn = a.inches
      }

      const mo = inp.moistureByFieldWeek[id] && inp.moistureByFieldWeek[id][w]
      const moisture = mo && mo.n ? Math.round(mo.sum / mo.n) : null

      if (etActual != null || etEstimate != null || schedIn != null || appIn != null || moisture != null) {
        rows.push({ crop, fieldKey: id, week: w, etEstimate, etActual, rain: null, moisture, schedIn, appIn })
        field.hasData = true
      }
    })
    if (!field.hasData && !issues.length) {
      issues.push(weeks.length ? 'Nothing recorded for this field yet' : 'This season has not started yet')
    }
  })

  fields.sort((a, b) => a.farm.localeCompare(b.farm) || a.name.localeCompare(b.name))
  return { fields, rows, weeks, warnings: inp.warnings }
}

export async function loadLiveReport(season, todayIso) {
  const inputs = await fetchLiveInputs(season, todayIso)
  const out = buildLiveReport(inputs)
  return { ...out, loadedAt: new Date(), season }
}
