// Pure scheduling math for the Harvest Schedule module (Harvest.jsx) — no
// React or Firebase, so it can be checked on its own.
//
// Carried over from harvest_plan_2026.xlsm:
//   - the plan runs in half-day steps (AM / PM), one row per half-day
//   - days required      = total yield / production goal per day
//   - 10-wheelers needed = ROUND(loads per day / trips per truck per day + 0.9, 1)
//         loads per day  = goal / 250 cwt (beets: 12.5 tons)
//         trips per day  = (day length − 2 h) × 60 / (one-way minutes × 2.6 + 38)
//   - kill date          = start − skin-set days; water-up check = start − 7
//   - resource totals per half-day with the sheet's warning limits
//   - "Goals Today" truck split: exact when there are enough trucks, otherwise
//     up to 3 priority teams get their full need and the rest share evenly.
//
// Progress: each team logs each half-day — how much of the half-day they
// worked (full / partial / down) and, optionally, how much they dug. That work
// is credited down the team's line in order, like the sheet's cumulative
// helper column; anything not yet dug is projected forward from now.

export const HALF = ['AM', 'PM']
const DAY_MS = 86400000

export const DEFAULT_TEAMS = [
  { id: 'purple', name: 'Purple', color: '#7B4FC9' },
  { id: 'red', name: 'Red', color: '#D23B3B' },
  { id: 'orange', name: 'Orange', color: '#E8801A' },
  { id: 'green', name: 'Green', color: '#2E9B4F' },
  { id: 'yellow', name: 'Yellow', color: '#D9B300' },
  { id: 'white', name: 'White', color: '#9A9890' },
  { id: 'blue', name: 'Blue', color: '#2A6FD6' },
  { id: 'grey', name: 'Grey', color: '#5B5F66' }
]

// Per-crop defaults. unit = what yield and the goal are measured in;
// loadSize = one 10-wheeler load in that unit (sheet: 250 cwt / 12.5 tons).
export const DEFAULT_CROPS = {
  POTATO: { unit: 'cwt', yieldPerAcre: 480, goalPerDay: 25000, loadSize: 250 },
  'MINI POTATOES': { unit: 'cwt', yieldPerAcre: 300, goalPerDay: 5000, loadSize: 250 },
  BEETS: { unit: 'tons', yieldPerAcre: 40, goalPerDay: 4000, loadSize: 12.5 },
  ONIONS: { unit: 'cwt', yieldPerAcre: 900, goalPerDay: 5000, loadSize: 250 }
}
const FALLBACK_CROP = { unit: 'tons', yieldPerAcre: 20, goalPerDay: 1000, loadSize: 12.5 }

// Warning limits from the dashboard's conditional formatting (semis needed
// went red above 50).
export const DEFAULT_LIMITS = {
  trucks: 50, generators: 2, pilers: 9, sandMachines: 4, airSeps: 4, bruiseSamples: 30, pickers: 22
}

export const DEFAULT_TRUCKING = { nonHaulHours: 2, tripFactor: 2.6, tripFixedMin: 38, roundUp: 0.9 }

export function defaultSettings(startDate) {
  return {
    startDate: startDate || null,
    dayLength: 12,
    rateMode: 'day', // 'day' = goal per day (the sheet); 'scale' = output scales with day length
    standardDay: 12,
    sundaysOff: false,
    teams: DEFAULT_TEAMS.map((t) => ({ ...t })),
    crops: {},
    limits: { ...DEFAULT_LIMITS },
    trucking: { ...DEFAULT_TRUCKING },
    calendar: {}
  }
}

// ---------------------------------------------------------------------------
// Dates and half-day slots. Slot 0 = start date AM, 1 = start date PM, ...
// ---------------------------------------------------------------------------
export function isoToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
function isoMs(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) }
export function addDaysIso(iso, n) { return new Date(isoMs(iso) + n * DAY_MS).toISOString().slice(0, 10) }
export function daysBetween(a, b) { return Math.round((isoMs(b) - isoMs(a)) / DAY_MS) }
export function weekday(iso) { return new Date(isoMs(iso)).getUTCDay() } // 0 = Sunday
export function slotOf(startIso, iso, half) { return daysBetween(startIso, iso) * 2 + (half === 'PM' || half === 1 ? 1 : 0) }
export function slotInfo(startIso, slot) {
  const s = Math.floor(slot)
  return { date: addDaysIso(startIso, Math.floor(s / 2)), half: HALF[((s % 2) + 2) % 2] }
}
// The half-day we are in right now (AM before noon).
export function currentSlot(startIso, now = new Date()) {
  return slotOf(startIso, isoToday(now), now.getHours() < 12 ? 'AM' : 'PM')
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
export function fmtDate(iso, withDow = false) {
  if (!iso) return '—'
  const [, m, d] = iso.split('-').map(Number)
  return `${withDow ? DOW[weekday(iso)] + ' ' : ''}${MON[m - 1]} ${d}`
}
export function fmtSlot(startIso, slot, withDow = false) {
  if (slot == null || !isFinite(slot)) return '—'
  const { date, half } = slotInfo(startIso, slot)
  return `${fmtDate(date, withDow)} ${half}`
}

// ---------------------------------------------------------------------------
// Settings lookups
// ---------------------------------------------------------------------------
export function cropSettings(settings, crop) {
  const base = DEFAULT_CROPS[crop] || FALLBACK_CROP
  return { ...base, ...(((settings && settings.crops) || {})[crop] || {}) }
}

// Fraction (0..1) of a normal half-day a team works in a slot. Team-specific
// calendar entries beat the all-teams calendar; Sundays-off is the default
// for Sundays when nothing is set.
export function slotFactor(settings, team, startIso, slot) {
  const { date, half } = slotInfo(startIso, slot)
  if (team && team.startDate && date < team.startDate) return 0
  const tc = team && team.calendar && team.calendar[date]
  if (tc && tc[half] != null) return Number(tc[half])
  const c = settings.calendar && settings.calendar[date]
  if (c && c[half] != null) return Number(c[half])
  if (settings.sundaysOff && weekday(date) === 0) return 0
  return 1
}

// Everything the plan needs to know about one field on one team.
export function fieldPlan(f, settings, team) {
  if (f.kind === 'block') {
    // Move day / down time / anything that takes the crew's time but isn't a field.
    const days = Math.max(0, num(f.blockDays) ?? 0.5)
    return { acres: 0, yieldPerAcre: 0, yieldSource: 'block', total: days, goal: 1, dayLength: num(settings.dayLength) ?? 12, unit: 'days', loadSize: null, days, trucks: null }
  }
  const cs = cropSettings(settings, f.crop)
  const acres = Number(f.acres) || 0
  const yieldPerAcre = num(f.yieldPerAcre) ?? num(f.histYield) ?? cs.yieldPerAcre
  const total = num(f.totalOverride) ?? acres * yieldPerAcre
  const dayLength = num(f.dayLength) ?? num(team && team.dayLength) ?? num(settings.dayLength) ?? 12
  const rate = num(f.goalPerDay) ?? num(team && team.goalPerDay) ?? cs.goalPerDay
  // 'scale': goals are for a standard-length day, so a 14 h day on a 12 h
  // standard digs 14/12 of the goal. 'day' (the sheet): the goal is the goal.
  const goal = settings.rateMode === 'scale' ? rate * dayLength / (num(settings.standardDay) || 12) : rate
  const loadSize = num(f.loadSize) ?? cs.loadSize
  const days = goal > 0 ? total / goal : 0
  return {
    acres, yieldPerAcre, yieldSource: num(f.yieldPerAcre) != null ? 'set' : num(f.histYield) != null ? 'history' : 'default',
    total, goal, dayLength, unit: cs.unit, loadSize, days,
    trucks: trucksNeeded({ goal, loadSize, dayLength, oneWayMin: num(f.oneWayMin) }, settings.trucking)
  }
}

export function trucksNeeded({ goal, loadSize, dayLength, oneWayMin }, trucking = DEFAULT_TRUCKING) {
  const t = { ...DEFAULT_TRUCKING, ...(trucking || {}) }
  if (oneWayMin == null || !goal || !loadSize) return null
  const roundTrip = oneWayMin * t.tripFactor + t.tripFixedMin
  const trips = ((dayLength - t.nonHaulHours) * 60) / roundTrip
  if (trips <= 0) return null
  return Math.round(((goal / loadSize) / trips + t.roundUp) * 10) / 10
}

function num(v) {
  if (v === '' || v == null) return null
  const n = Number(v)
  return isFinite(n) ? n : null
}

// Fractional ordering so a drag only rewrites the one doc that moved.
export function orderBetween(before, after) {
  if (before == null && after == null) return 1000
  if (before == null) return after - 1000
  if (after == null) return before + 1000
  return (before + after) / 2
}

// ---------------------------------------------------------------------------
// The schedule
// ---------------------------------------------------------------------------
// fields: [{ key, name, crop, acres, teamId, order, finished, killed, skinSetDays, ...overrides }]
// logs:   [{ teamId, date, half, fraction (0..1), amount?, fieldKey?, finishedField? }]
// Returns { teams: { [teamId]: teamResult }, totals, byKey, startDate, nowSlot }.
export function buildSchedule({ fields, settings, logs = [], now = new Date(), horizon = 1600 }) {
  const startDate = settings.startDate || isoToday(now)
  const nowSlot = currentSlot(startDate, now)
  const today = isoToday(now)
  const teams = {}
  const byKey = {}

  for (const team of settings.teams || []) {
    const mine = fields.filter((f) => f.teamId === team.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const rows = mine.map((f) => {
      const p = fieldPlan(f, settings, team)
      return { ...f, ...p, dug: 0, firstSlot: null, lastSlot: null, finished: !!f.finished }
    })
    const teamStartSlot = Math.max(0, team.startDate ? slotOf(startDate, team.startDate, 'AM') : 0)
    const teamLogs = logs
      .filter((l) => l.teamId === team.id && l.date)
      .map((l) => ({ ...l, slot: slotOf(startDate, l.date, l.half) }))
      .sort((a, b) => a.slot - b.slot)
    const loggedSlots = new Set(teamLogs.map((l) => l.slot))

    // 1. Credit logged work down the line.
    const isDone = (r) => r.finished || r.dug >= r.total - 1e-6
    const touch = (r, slot) => { if (r.firstSlot == null || slot < r.firstSlot) r.firstSlot = slot; if (r.lastSlot == null || slot > r.lastSlot) r.lastSlot = slot }
    for (const l of teamLogs) {
      const fraction = num(l.fraction) ?? 1
      const target = l.fieldKey ? rows.find((r) => r.key === l.fieldKey) : null
      if (target && num(l.amount) != null) {
        target.dug += num(l.amount)
        touch(target, l.slot)
        if (l.finishedField) target.finished = true
        continue
      }
      let wd = fraction * 0.5 // field-days of work this half-day
      let last = target
      if (target) {
        // A field named without an amount: the half-day's work goes on it.
        target.dug += wd * target.goal; touch(target, l.slot); wd = 0
      }
      while (wd > 1e-9) {
        const cur = rows.find((r) => !isDone(r))
        if (!cur) break
        const need = cur.goal > 0 ? (cur.total - cur.dug) / cur.goal : 0
        const take = Math.min(wd, need)
        cur.dug += take * cur.goal; wd -= take; touch(cur, l.slot); last = cur
        if (need <= 1e-9) cur.dug = cur.total
      }
      if (l.finishedField && last) last.finished = true
    }

    // 2. Project what's left forward from now.
    let slot = Math.max(teamStartSlot, nowSlot)
    while (loggedSlots.has(slot)) slot++
    let used = 0 // field-days already used in `slot`
    let guard = 0
    const capAt = (s) => 0.5 * slotFactor(settings, team, startDate, s)
    for (const r of rows) {
      const done = isDone(r)
      r.done = done
      r.remainingDays = done ? 0 : Math.max(0, (r.total - r.dug) / (r.goal || 1))
      r.pct = r.finished ? 1 : r.total > 0 ? Math.min(1, r.dug / r.total) : 0
      if (done) {
        r.startSlot = r.firstSlot
        r.endSlot = r.lastSlot != null ? r.lastSlot + 1 : null
        r.status = 'done'
        continue
      }
      let need = r.remainingDays
      let startPos = null
      while (need > 1e-9 && guard < horizon) {
        const cap = capAt(slot)
        const free = cap - used
        if (free <= 1e-9) { slot++; used = 0; guard++; while (loggedSlots.has(slot)) slot++; continue }
        if (startPos == null) startPos = slot + used / cap
        const take = Math.min(free, need)
        need -= take; used += take
        if (need <= 1e-9) { r.projEnd = slot + used / cap; break }
      }
      if (need > 1e-9) r.projEnd = null // ran past the horizon (e.g. every day set to off)
      r.projStart = startPos
      r.startSlot = r.firstSlot != null ? r.firstSlot : startPos
      r.endSlot = r.projEnd
      r.status = r.dug > 0 ? 'active' : 'planned'
    }

    // 3. Team summary.
    for (const r of rows) {
      r.startDate = r.startSlot != null ? slotInfo(startDate, r.startSlot).date : null
      r.killDate = r.startDate && num(r.skinSetDays) != null ? addDaysIso(r.startDate, -num(r.skinSetDays)) : null
      r.waterUpDate = r.startDate ? addDaysIso(r.startDate, -7) : null
      r.killStatus = !r.killDate || r.done || r.status === 'active' ? null
        : r.killed ? 'killed'
          : r.killDate < today ? 'overdue'
            : daysBetween(today, r.killDate) <= 7 ? 'soon' : null
      byKey[r.key] = { ...r, teamId: team.id }
    }
    const totalDays = rows.reduce((s, r) => s + r.days, 0)
    const doneDays = rows.reduce((s, r) => s + (r.finished ? r.days : Math.min(r.days, r.goal > 0 ? r.dug / r.goal : 0)), 0)
    let plannedByNow = 0
    for (let s = teamStartSlot; s < nowSlot; s++) plannedByNow += capAt(s)
    if (loggedSlots.has(nowSlot) && nowSlot >= teamStartSlot) plannedByNow += capAt(nowSlot)
    plannedByNow = Math.min(plannedByNow, totalDays)
    const acres = rows.reduce((s, r) => s + r.acres, 0)
    const acresDone = rows.reduce((s, r) => s + r.acres * r.pct, 0)
    const ends = rows.map((r) => r.endSlot).filter((e) => e != null)
    const finishSlot = !ends.length ? null : rows.some((r) => !r.done && r.endSlot == null) ? null : Math.max(...ends)
    const current = rows.find((r) => r.status === 'active') || rows.find((r) => !r.done) || null
    const started = nowSlot > teamStartSlot || teamLogs.length > 0
    teams[team.id] = {
      team, rows, totalDays, doneDays, plannedByNow,
      aheadDays: started ? doneDays - plannedByNow : 0,
      started, startSlot: teamStartSlot,
      acres, acresDone, pct: acres > 0 ? acresDone / acres : 0,
      workPct: totalDays > 0 ? doneDays / totalDays : 0,
      finishSlot, finishDate: finishSlot != null ? slotInfo(startDate, Math.max(0, Math.ceil(finishSlot) - 1)).date : null,
      current, loggedSlots, logs: teamLogs
    }
  }

  const all = Object.values(teams)
  const acres = all.reduce((s, t) => s + t.acres, 0)
  const acresDone = all.reduce((s, t) => s + t.acresDone, 0)
  const totalDays = all.reduce((s, t) => s + t.totalDays, 0)
  const doneDays = all.reduce((s, t) => s + t.doneDays, 0)
  const byUnit = {}
  all.forEach((t) => t.rows.forEach((r) => {
    if (r.kind === 'block') return
    const u = (byUnit[r.unit] = byUnit[r.unit] || { total: 0, dug: 0 })
    u.total += r.total; u.dug += r.finished ? r.total : Math.min(r.total, r.dug)
  }))
  const finishes = all.filter((t) => t.finishSlot != null)
  const finishSlot = finishes.length ? Math.max(...finishes.map((t) => t.finishSlot)) : null
  return {
    startDate, nowSlot, today, teams, byKey,
    totals: {
      acres, acresDone, pct: acres > 0 ? acresDone / acres : 0,
      totalDays, doneDays, workPct: totalDays > 0 ? doneDays / totalDays : 0,
      aheadDays: all.reduce((s, t) => s + t.aheadDays, 0),
      byUnit, finishSlot,
      finishDate: finishSlot != null ? slotInfo(startDate, Math.max(0, Math.ceil(finishSlot) - 1)).date : null
    }
  }
}

// Which field each team is on during a slot (the one covering most of it).
export function fieldAtSlot(teamResult, slot) {
  let best = null, bestCover = 0
  for (const r of teamResult.rows) {
    if (r.startSlot == null || r.endSlot == null) continue
    const cover = Math.min(slot + 1, r.endSlot) - Math.max(slot, r.startSlot)
    if (cover > bestCover + 1e-9) { best = r; bestCover = cover }
  }
  return best
}

// Resource totals for one half-day across every team (the sheet's GT:HG).
export function resourcesAt(schedule, slot) {
  const out = { trucks: 0, generators: 0, pilers: 0, sandMachines: 0, airSeps: 0, eliminators: 0, pullTractors: 0, bruiseSamples: 0, airknives: 0, pickers: 0, goal: {}, fields: {} }
  for (const [tid, t] of Object.entries(schedule.teams)) {
    const f = fieldAtSlot(t, slot)
    out.fields[tid] = f
    if (!f || f.kind === 'block') continue
    const res = f.resources || {}
    out.trucks += f.trucks || 0
    out.generators += Number(res.generators) || 0
    out.pilers += Number(res.pilers) || 0
    out.pullTractors += Number(res.pullTractor) || 0
    out.bruiseSamples += Number(res.bruiseSamples) || 0
    out.airknives += Number(res.airknife) || 0
    out.pickers += Number(res.pickers) || 0
    const cu = String(res.cleaningUnit || '').toLowerCase()
    if (cu.includes('sand machine')) out.sandMachines++
    if (cu.includes('air sep')) out.airSeps++
    if (cu.includes('eliminator')) out.eliminators++
    out.goal[f.unit] = (out.goal[f.unit] || 0) + f.goal / 2
  }
  return out
}

// Over-limit checks matching the sheet's red cells.
export function resourceWarnings(r, limits = DEFAULT_LIMITS) {
  const L = { ...DEFAULT_LIMITS, ...(limits || {}) }
  const w = []
  if (r.trucks > L.trucks) w.push(`Trucks ${r.trucks.toFixed(1)} > ${L.trucks}`)
  if (r.generators > L.generators) w.push(`Generators ${r.generators} > ${L.generators}`)
  if (r.pilers > L.pilers) w.push(`Pilers ${r.pilers} > ${L.pilers}`)
  if (r.sandMachines > L.sandMachines) w.push(`Sand machines ${r.sandMachines} > ${L.sandMachines}`)
  if (r.airSeps > L.airSeps) w.push(`Air seps ${r.airSeps} > ${L.airSeps}`)
  if (r.bruiseSamples > L.bruiseSamples) w.push(`Bruise samples ${r.bruiseSamples} > ${L.bruiseSamples}`)
  if (r.pickers > L.pickers) w.push(`Pickers ${r.pickers} > ${L.pickers}`)
  return w
}

// "Goals Today" truck split. needs: { teamId: trucks }. Enough trucks ->
// everyone gets their need. Short -> priority teams (max 3) first, then the
// rest share what's left in proportion to need.
export function allocateTrucks(needs, available, priority = []) {
  const ids = Object.keys(needs).filter((k) => needs[k] > 0)
  const total = ids.reduce((s, k) => s + needs[k], 0)
  const out = {}
  if (total <= available) { ids.forEach((k) => { out[k] = Math.round(needs[k]) }); return { alloc: out, short: 0, leftover: Math.round(available - total) } }
  let left = available
  const pri = priority.filter((k) => ids.includes(k)).slice(0, 3)
  pri.forEach((k) => { const g = Math.min(Math.round(needs[k]), left); out[k] = g; left -= g })
  const rest = ids.filter((k) => !pri.includes(k))
  const restNeed = rest.reduce((s, k) => s + needs[k], 0)
  rest.forEach((k) => { out[k] = restNeed > 0 ? Math.floor((left * needs[k]) / restNeed) : 0 })
  // hand out rounding leftovers to the biggest shortfalls
  let spare = left - rest.reduce((s, k) => s + out[k], 0)
  rest.slice().sort((a, b) => (needs[b] - out[b]) - (needs[a] - out[a])).forEach((k) => { if (spare > 0) { out[k]++; spare-- } })
  return { alloc: out, short: Math.round(total - available), leftover: 0 }
}

// Auto-fill: hand unassigned fields to the chosen teams so their finish
// dates come out as even as possible (longest jobs first, each to the team
// that would finish soonest). Returns [{ key, teamId }] in placement order.
export function balanceAssign(unassigned, teamLoads, settings) {
  const loads = { ...teamLoads }
  const teams = (settings.teams || []).filter((t) => t.id in loads)
  if (!teams.length) return []
  const withDays = unassigned.map((f) => ({ f, days: fieldPlan(f, settings, null).days }))
    .sort((a, b) => b.days - a.days)
  const out = []
  for (const { f, days } of withDays) {
    const tid = Object.keys(loads).sort((a, b) => loads[a] - loads[b])[0]
    const team = teams.find((t) => t.id === tid)
    loads[tid] += team ? fieldPlan(f, settings, team).days : days
    out.push({ key: f.key, teamId: tid })
  }
  return out
}

export function fmtDays(d, signed = false) {
  if (d == null || !isFinite(d)) return '—'
  const r = Math.round(d * 10) / 10
  const s = Math.abs(r) === 1 ? 'day' : 'days'
  return `${signed && r > 0 ? '+' : ''}${r.toFixed(1)} ${s}`
}
export function fmtN(n, d = 0) {
  if (n == null || !isFinite(n)) return '—'
  return Number(n).toLocaleString(undefined, { maximumFractionDigits: d, minimumFractionDigits: 0 })
}

// ---------------------------------------------------------------------------
// Workbook import (Field Table sheet of harvest_plan_*.xlsm)
// ---------------------------------------------------------------------------
const COLS = {
  name: ['field'], variety: ['variety'], acres: ['acres'], yieldPerAcre: ['yield projection'],
  farm: ['farm'], prevCrop: ['2024 crop', 'previous crop', 'prior crop'], skinSetDays: ['skin set'], killType: ['kill type'],
  destination: ['destination'], bay: ['bay'], oneWayMin: ['time'], goalPerDay: ['target output'], dayLength: ['hours digging'],
  team: ['team'], order: ['order'], daysRequired: ['days required'], area: ['area/dump', 'area'], buyer: ['buyer'], storage: ['storage or direct'],
  postHarvestSpray: ['post harvest spray'], pileHeight: ['pile height'], stopLoadingTemp: ['stop loading temp'],
  generators: ['generator needed'], pilers: ['pilers needed'], cleaningUnit: ['cleaning unit'], pullTractor: ['pull tractor needed'],
  bruiseSamples: ['bruise samples'], airknife: ['airknife needed'], pickers: ['# of pickers']
}
// rows: array of arrays (sheet_to_json header:1). Finds the header row that
// has "Field" and "Team". Returns [{ name, crop, ...values }].
export function parseFieldTable(rows) {
  const hIdx = rows.findIndex((r) => r && r.some((c) => String(c || '').trim().toLowerCase() === 'field') && r.some((c) => String(c || '').trim().toLowerCase() === 'team'))
  if (hIdx < 0) throw new Error('Couldn’t find the Field Table header row (needs “Field” and “Team” columns).')
  const head = rows[hIdx].map((c) => String(c || '').trim().toLowerCase())
  const col = {}
  Object.entries(COLS).forEach(([k, names]) => { const i = head.findIndex((h) => names.includes(h)); if (i >= 0) col[k] = i })
  const out = []
  for (const r of rows.slice(hIdx + 1)) {
    if (!r) continue
    const get = (k) => (col[k] == null ? null : r[col[k]])
    const name = String(get('name') || '').trim()
    if (!name || /^done$/i.test(name)) continue // "Done" rows only mark the end of a team's line
    if (/^move( day)?$/i.test(name) || /^(down|travel)( day)?$/i.test(name)) {
      out.push({ kind: 'block', name, team: get('team') == null ? null : String(get('team')).trim(), order: num(get('order')), blockDays: Math.round((num(get('daysRequired')) ?? 1) * 2) / 2 || 0.5 })
      continue
    }
    const variety = String(get('variety') || '').trim() || null
    const crop = /beet/i.test(variety || '') ? 'BEETS' : 'POTATO'
    const n = (k) => num(get(k))
    const s = (k) => { const v = get(k); return v == null || String(v).trim() === '' ? null : String(v).trim() }
    out.push({
      name, variety, crop, farm: s('farm'),
      acres: n('acres'), yieldPerAcre: n('yieldPerAcre'), goalPerDay: n('goalPerDay'), dayLength: n('dayLength'),
      skinSetDays: n('skinSetDays'), killType: s('killType'), destination: s('destination'), bay: s('bay'),
      oneWayMin: n('oneWayMin'),
      team: s('team'), order: n('order'), area: s('area'), buyer: s('buyer'), storage: s('storage'),
      postHarvestSpray: s('postHarvestSpray'), pileHeight: n('pileHeight'), stopLoadingTemp: s('stopLoadingTemp'),
      resources: {
        generators: n('generators'), pilers: n('pilers'), cleaningUnit: s('cleaningUnit'), pullTractor: n('pullTractor'),
        bruiseSamples: n('bruiseSamples'), airknife: n('airknife'), pickers: n('pickers')
      }
    })
  }
  return out
}
