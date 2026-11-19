// Pure math for the Ground work module (GroundWork.jsx) — no React or Firebase.
//
// Model
//   categories  kinds of equipment (Dominator, Karat, Wilcox, Roller Harrow),
//               each with a target acres/day and its units (Dominator 1, 2…)
//   recipes     per crop, the passes in order: POTATO → Dominator, Karat,
//               Roller Harrow. Every field with that crop gets one job per pass.
//   jobs        groundJobs docs: one field × one pass, assigned to a unit with
//               an order in that unit's line. Blocks (rain / move / down) sit
//               in a unit's line too.
//   schedule    each unit works its line in order, in half-day slots (AM/PM)
//               from the start date; Sundays and days off skipped. A pass
//               can't start before the previous pass on the same field is done
//               (+ the gap days between passes) — the unit waits, and the job
//               is flagged. A job pinned to a start date waits for that date.
//   pace        target = the unit's acres/day × working time since its
//               category's start date (the schedule start when not set — later
//               passes like the Karats usually start a few days in), with
//               rain/move/down blocks excused. Done acres against that =
//               acres ahead/behind, ÷ acres/day = days ahead/behind. Rolled up
//               for each category and the whole schedule.
//   order       fields are numbered along a southwest → northeast line: 1 is
//               the most south-western field, the last the most north-eastern.

export const HALF = ['AM', 'PM']
const DAY_MS = 86400000

export const DEFAULT_CATEGORIES = [
  { id: 'dominator', name: 'Dominator', color: '#7B4FC9', rate: 80, units: [{ id: 'dominator-1', name: 'Dominator 1' }, { id: 'dominator-2', name: 'Dominator 2' }] },
  { id: 'karat', name: 'Karat', color: '#D2643B', rate: 120, units: [{ id: 'karat-1', name: 'Karat 1' }, { id: 'karat-2', name: 'Karat 2' }] },
  { id: 'wilcox', name: 'Wilcox', color: '#2A7FA8', rate: 100, units: [{ id: 'wilcox-1', name: 'Wilcox' }] },
  { id: 'roller-harrow', name: 'Roller Harrow', color: '#2E9B4F', rate: 150, units: [{ id: 'roller-harrow-1', name: 'Roller Harrow 1' }, { id: 'roller-harrow-2', name: 'Roller Harrow 2' }, { id: 'roller-harrow-3', name: 'Roller Harrow 3' }] }
]
export const DEFAULT_RECIPES = { POTATO: ['dominator', 'karat', 'roller-harrow'], BEETS: ['karat', 'roller-harrow'] }

export function defaultSettings(startDate) {
  return {
    startDate: startDate || null, sundaysOff: true, daysOff: [], gapDays: 0, sweepAngle: 45,
    categories: DEFAULT_CATEGORIES.map((c) => ({ ...c, units: c.units.map((u) => ({ ...u })) })),
    recipes: JSON.parse(JSON.stringify(DEFAULT_RECIPES))
  }
}

// ---- dates and half-day slots ----------------------------------------------
const isoMs = (iso) => Date.parse(`${iso}T00:00:00Z`)
export function isoToday(now = new Date()) {
  const d = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
  return d.toISOString().slice(0, 10)
}
export const addDaysIso = (iso, n) => new Date(isoMs(iso) + n * DAY_MS).toISOString().slice(0, 10)
export const daysBetween = (a, b) => Math.round((isoMs(b) - isoMs(a)) / DAY_MS)
export const weekday = (iso) => new Date(isoMs(iso)).getUTCDay()
export const slotOf = (startIso, iso, half) => daysBetween(startIso, iso) * 2 + (half === 'PM' || half === 1 ? 1 : 0)
export function slotInfo(startIso, slot) {
  const s = Math.floor(slot)
  return { date: addDaysIso(startIso, Math.floor(s / 2)), half: HALF[((s % 2) + 2) % 2] }
}
// Where "now" sits, in slots (fractional: noon splits AM/PM, 6am–6pm workday).
export function nowSlot(startIso, now = new Date()) {
  const today = isoToday(now)
  const h = now.getHours() + now.getMinutes() / 60
  const dayFrac = Math.max(0, Math.min(1, (h - 6) / 12))
  return daysBetween(startIso, today) * 2 + dayFrac * 2
}
export function fmtDate(iso, withDow = false) {
  if (!iso) return '—'
  const d = new Date(isoMs(iso))
  return d.toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', ...(withDow ? { weekday: 'short' } : {}) })
}
export const fmtSlot = (startIso, slot, withDow = false) => { const i = slotInfo(startIso, slot); return `${fmtDate(i.date, withDow)} ${i.half}` }

// Working calendar: prefix counts of working half-days so "how much work fits
// between two moments" is a subtraction.
export function makeCalendar(settings, horizon = 1600) {
  const off = new Set(settings.daysOff || [])
  const working = new Uint8Array(horizon)
  const W = new Float64Array(horizon + 1)
  for (let s = 0; s < horizon; s++) {
    const iso = addDaysIso(settings.startDate, Math.floor(s / 2))
    working[s] = (settings.sundaysOff && weekday(iso) === 0) || off.has(iso) ? 0 : 1
    W[s + 1] = W[s] + working[s]
  }
  const workAt = (t) => { // working slots before time t
    if (t <= 0) return 0
    if (t >= horizon) return W[horizon] + (t - horizon)
    const s = Math.floor(t)
    return W[s] + (working[s] ? t - s : 0)
  }
  const between = (a, b) => Math.max(0, workAt(b) - workAt(a))
  // the time at which `amount` working slots after t have been done
  const consume = (t, amount) => {
    if (!(amount > 0)) return skipOff(t)
    const target = workAt(t) + amount
    let lo = Math.max(0, Math.floor(t)), hi = horizon
    if (W[horizon] < target) return horizon + (target - W[horizon])
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (W[mid] < target) lo = mid; else hi = mid }
    return lo + (target - W[lo])
  }
  function skipOff(t) {
    let s = Math.floor(t)
    if (s < 0) return t
    while (s < horizon && !working[s]) { s++; t = s }
    return t
  }
  return { working, workAt, between, consume, skipOff, horizon, isWorking: (s) => s >= 0 && s < horizon && !!working[s] }
}

// ---- field numbering: southwest → northeast --------------------------------
// pos: { lat, lng }. Fields without a position go last, by name.
export function sweepNumbers(fields, angleDeg = 45) {
  const placed = fields.filter((f) => f.pos)
  if (!placed.length) return Object.fromEntries(fields.map((f, i) => [f.id, i + 1]))
  const lat0 = placed.reduce((s, f) => s + f.pos.lat, 0) / placed.length
  const kx = 111.32 * Math.cos((lat0 * Math.PI) / 180), ky = 110.57
  const a = (angleDeg * Math.PI) / 180
  const key = (f) => f.pos.lng * kx * Math.cos(a) + f.pos.lat * ky * Math.sin(a)
  const sorted = [...placed].sort((x, y) => key(x) - key(y))
  const rest = fields.filter((f) => !f.pos).sort((x, y) => String(x.name).localeCompare(String(y.name), undefined, { numeric: true }))
  return Object.fromEntries([...sorted, ...rest].map((f, i) => [f.id, i + 1]))
}

// ---- recipes → jobs ---------------------------------------------------------
export const jobId = (seasonId, fieldId, catId, n = 1) => `${seasonId}__${fieldId}__${catId}${n > 1 ? `__${n}` : ''}`
// fields: [{ id, name, farmName, crop (canonical), acres }]
// Returns the jobs the recipes call for that don't exist yet, and existing
// jobs (not started) that no recipe calls for any more.
export function recipeJobs({ seasonId, fields, recipes, existing }) {
  const have = new Set(existing.filter((j) => j.kind !== 'block').map((j) => j.id))
  const wanted = new Set()
  const add = []
  fields.forEach((f) => {
    const steps = (recipes[f.crop] || []).filter(Boolean)
    const seen = {}
    steps.forEach((catId, step) => {
      seen[catId] = (seen[catId] || 0) + 1
      const id = jobId(seasonId, f.id, catId, seen[catId])
      wanted.add(id)
      if (!have.has(id)) add.push({ id, seasonId, kind: 'job', fieldId: f.id, fieldName: f.name, farmName: f.farmName || null, crop: f.crop, acres: f.acres, catId, step, unitId: null, order: null, doneAcres: 0, done: false })
    })
  })
  const stale = existing.filter((j) => j.kind !== 'block' && !j.manual && !wanted.has(j.id) && !(j.doneAcres > 0) && !j.done)
  return { add, stale }
}

// Split a category's jobs into one stretch of the sweep per unit, sized to
// each unit's acres/day so they finish together.
export function autoAssign({ jobs, category, sweepNo, onlyUnassigned = true }) {
  const units = category.units || []
  if (!units.length) return []
  const mine = jobs.filter((j) => j.kind !== 'block' && j.catId === category.id && !j.done && (!onlyUnassigned || !j.unitId))
    .sort((a, b) => (sweepNo[a.fieldId] || 1e9) - (sweepNo[b.fieldId] || 1e9))
  const rates = units.map((u) => Number(u.rate) || Number(category.rate) || 1)
  const totalRate = rates.reduce((s, r) => s + r, 0)
  const total = mine.reduce((s, j) => s + (Number(j.acres) || 0), 0)
  const bounds = []
  let acc = 0
  rates.forEach((r) => { acc += (total * r) / totalRate; bounds.push(acc) })
  const out = []
  let run = 0
  mine.forEach((j) => {
    const mid = run + (Number(j.acres) || 0) / 2
    run += Number(j.acres) || 0
    const ui = Math.min(units.length - 1, bounds.findIndex((b) => mid <= b + 1e-9) === -1 ? units.length - 1 : bounds.findIndex((b) => mid <= b + 1e-9))
    out.push({ id: j.id, unitId: units[ui].id, order: sweepNo[j.fieldId] || 1e6 })
  })
  return out
}

// A fractional order between two neighbours, for drag-and-drop.
export function orderBetween(before, after) {
  if (before == null && after == null) return 1000
  if (before == null) return after - 1000
  if (after == null) return before + 1000
  return (before + after) / 2
}

// ---- the schedule -----------------------------------------------------------
export function unitsOf(settings) {
  const out = []
  ;(settings.categories || []).forEach((c) => (c.units || []).forEach((u) => out.push({ ...u, catId: c.id, catName: c.name, color: c.color, rate: Number(u.rate) || Number(c.rate) || 0, paceFrom: c.startDate || null })))
  return out
}

// jobs: groundJobs docs; liveAcres: fieldId → current Agworld acres (else the job's own)
export function buildGround({ jobs, settings, liveAcres = {}, now = new Date() }) {
  const start = settings.startDate
  const cal = makeCalendar(settings)
  const units = unitsOf(settings)
  const unitById = Object.fromEntries(units.map((u) => [u.id, u]))
  const gap = (Number(settings.gapDays) || 0) * 2
  const nowS = start ? nowSlot(start, now) : 0
  const cursor0 = Math.max(0, nowS)
  const acresOf = (j) => (Number(liveAcres[j.fieldId]) > 0 ? Number(liveAcres[j.fieldId]) : Number(j.acres) || 0)
  const real = jobs.filter((j) => j.kind !== 'block')
  // previous pass on the same field
  const byField = {}
  real.forEach((j) => { (byField[j.fieldId] = byField[j.fieldId] || []).push(j) })
  Object.values(byField).forEach((list) => list.sort((a, b) => (a.step ?? 0) - (b.step ?? 0)))
  const prevOf = {}
  Object.values(byField).forEach((list) => list.forEach((j, i) => { prevOf[j.id] = i > 0 ? list[i - 1] : null }))
  const doneSlot = (j) => (j.doneAt && start ? nowSlot(start, new Date(j.doneAt)) : null)

  const lanes = Object.fromEntries(units.map((u) => [u.id, jobs.filter((j) => j.unitId === u.id).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))]))
  let finish = {} // jobId → end slot (scheduled), from the previous round
  let res = {}
  for (let round = 0; round < 12; round++) {
    const next = {}
    const out = {}
    units.forEach((u) => {
      let t = cal.skipOff(cursor0)
      const perSlot = (u.rate || 0) / 2
      lanes[u.id].forEach((j) => {
        if (j.kind === 'block') {
          const s = cal.skipOff(t), e = cal.consume(s, Number(j.slots) || 2)
          out[j.id] = { id: j.id, block: true, start: s, end: e, unitId: u.id }
          t = e
          return
        }
        const acres = acresOf(j)
        const left = Math.max(0, acres - (Number(j.doneAcres) || 0))
        if (j.done || left <= 0.05) { out[j.id] = { id: j.id, done: true, end: doneSlot(j), unitId: u.id, acres, left: 0 }; next[j.id] = doneSlot(j) ?? -1; return }
        let s = t, waited = null, pinLate = false, dep = null
        if (j.startOn && j.startOn.date && start) {
          const p = slotOf(start, j.startOn.date, j.startOn.half)
          if (p > s) s = p; else if (p < s - 0.01) pinLate = true
        }
        const prev = prevOf[j.id]
        if (prev) {
          const pe = prev.done ? doneSlot(prev) : finish[prev.id]
          if (pe == null) dep = prev.unitId ? 'later' : 'unassigned'
          else if (pe + gap > s + 0.01) { waited = s; s = pe + gap }
        }
        s = cal.skipOff(s)
        const e = perSlot > 0 ? cal.consume(s, left / perSlot) : cal.horizon
        out[j.id] = { id: j.id, start: s, end: e, unitId: u.id, acres, left, waited, pinLate, dep, prevId: prev ? prev.id : null }
        next[j.id] = e
        t = e
      })
    })
    const stable = Object.keys(next).every((k) => finish[k] != null && Math.abs(finish[k] - next[k]) < 0.01)
    finish = next; res = out
    if (stable && round > 0) break
  }
  // a pass whose previous pass is now scheduled after it (in another unit)
  Object.values(res).forEach((r) => {
    if (r.block || r.done || !r.prevId) return
    const p = res[r.prevId]
    if (p && !p.done && p.end != null && p.end + gap > r.start + 0.01) r.dep = 'after'
  })

  // ---- pace ----
  const excused = (uId) => lanes[uId].filter((j) => j.kind === 'block').reduce((s, j) => {
    const r = res[j.id]; if (!r || r.start >= nowS) return s
    return s + cal.between(r.start, Math.min(r.end, nowS))
  }, 0)
  const paceStart = (u) => (u.paceFrom && start ? Math.max(0, slotOf(start, u.paceFrom, 'AM')) : 0)
  const unitStats = units.map((u) => {
    const elapsed = start ? cal.between(paceStart(u), Math.max(0, nowS)) : 0
    const mine = real.filter((j) => j.unitId === u.id)
    const total = mine.reduce((s, j) => s + acresOf(j), 0)
    const done = mine.reduce((s, j) => s + (j.done ? acresOf(j) : Math.min(acresOf(j), Number(j.doneAcres) || 0)), 0)
    const target = Math.min(total, Math.max(0, elapsed - excused(u.id)) * (u.rate / 2))
    const ends = mine.map((j) => res[j.id]).filter((r) => r && !r.done).map((r) => r.end)
    const end = ends.length ? Math.max(...ends) : null
    const waits = mine.filter((j) => res[j.id] && (res[j.id].waited != null || res[j.id].dep)).length
    return { ...u, jobs: mine.length, total, done, left: total - done, target, diffAcres: done - target, diffDays: u.rate ? (done - target) / u.rate : 0, end, waits }
  })
  const roll = (list) => {
    const total = list.reduce((s, x) => s + x.total, 0), done = list.reduce((s, x) => s + x.done, 0), target = list.reduce((s, x) => s + x.target, 0)
    const rate = list.reduce((s, x) => s + (x.rate || 0), 0)
    const ends = list.map((x) => x.end).filter((x) => x != null)
    return { total, done, left: total - done, target, diffAcres: done - target, diffDays: rate ? (done - target) / rate : 0, rate, end: ends.length ? Math.max(...ends) : null, pct: total ? done / total : 0 }
  }
  const catStats = (settings.categories || []).map((c) => {
    const us = unitStats.filter((u) => u.catId === c.id)
    const unassigned = real.filter((j) => j.catId === c.id && !j.unitId && !j.done)
    return { ...c, ...roll(us), units: us, unassigned: unassigned.length, unassignedAcres: unassigned.reduce((s, j) => s + acresOf(j), 0) }
  })
  return { res, lanes, units, unitById, unitStats, catStats, all: roll(unitStats), nowSlot: nowS, cal, acresOf, paceStart }
}

// Cumulative acres by day for a set of units: target pace, done (by the day
// it was marked done) and the schedule's projection. For the burn-up charts.
export function burnUp({ g, jobs, unitIds, settings, now = new Date() }) {
  if (!settings.startDate) return []
  const ids = new Set(unitIds)
  const units = g.units.filter((u) => ids.has(u.id))
  const mine = jobs.filter((j) => j.kind !== 'block' && ids.has(j.unitId))
  const total = mine.reduce((s, j) => s + g.acresOf(j), 0)
  const unitTotal = Object.fromEntries(units.map((u) => [u.id, mine.filter((j) => j.unitId === u.id).reduce((s, j) => s + g.acresOf(j), 0)]))
  const ends = mine.map((j) => g.res[j.id]).filter((r) => r && r.end != null).map((r) => r.end)
  const lastSlot = Math.max(g.nowSlot + 2, ...(ends.length ? ends : [0]))
  const days = Math.min(400, Math.ceil(lastSlot / 2) + 1)
  const todayDay = Math.floor(g.nowSlot / 2)
  const doneBy = (dayEnd) => mine.reduce((s, j) => {
    const a = j.done ? g.acresOf(j) : Math.min(g.acresOf(j), Number(j.doneAcres) || 0)
    if (!(a > 0)) return s
    const at = j.doneAt ? nowSlot(settings.startDate, new Date(j.doneAt)) : 0
    return at <= dayEnd ? s + a : s
  }, 0)
  const out = []
  for (let d = 0; d <= days; d++) {
    const dayEnd = (d + 1) * 2
    const target = Math.min(total, units.reduce((s, u) => s + Math.min(unitTotal[u.id], g.cal.between(g.paceStart(u), dayEnd) * (u.rate / 2)), 0))
    const row = { day: d, date: addDaysIso(settings.startDate, d), target: Math.round(target) }
    if (d <= todayDay) row.done = Math.round(doneBy(dayEnd))
    if (d >= todayDay) {
      const proj = mine.reduce((s, j) => {
        const r = g.res[j.id]
        const doneA = j.done ? g.acresOf(j) : Math.min(g.acresOf(j), Number(j.doneAcres) || 0)
        if (!r || r.done || r.start == null) return s + doneA
        const work = g.cal.between(r.start, r.end)
        const part = work > 0 ? Math.min(1, g.cal.between(r.start, Math.min(dayEnd, r.end)) / work) : (dayEnd >= r.end ? 1 : 0)
        return s + doneA + r.left * part
      }, 0)
      row.projected = Math.round(proj)
    }
    out.push(row)
  }
  return out
}

export const fmtAc = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString())
export function fmtDiff(days) {
  if (days == null || !isFinite(days)) return '—'
  const a = Math.abs(days)
  if (a < 0.25) return 'on pace'
  const s = a < 10 ? a.toFixed(1) : Math.round(a)
  return `${s} day${s === '1.0' || s === 1 ? '' : 's'} ${days > 0 ? 'ahead' : 'behind'}`
}

// What other modules need: each field's ground-work state for the season.
// fieldId → { passes, done, next (category id), ready (all passes done) }
export function groundStatusByField(jobs) {
  const by = {}
  jobs.filter((j) => j.kind !== 'block').forEach((j) => { (by[j.fieldId] = by[j.fieldId] || []).push(j) })
  return Object.fromEntries(Object.entries(by).map(([id, list]) => {
    list.sort((a, b) => (a.step ?? 0) - (b.step ?? 0))
    const done = list.filter((j) => j.done).length
    const nextJob = list.find((j) => !j.done)
    return [id, { passes: list.length, done, next: nextJob ? nextJob.catId : null, ready: done === list.length }]
  }))
}
