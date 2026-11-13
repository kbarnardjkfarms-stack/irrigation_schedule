// Turns the "WATER SCHEDULE" tab of the Excel irrigation schedule into AIO schedule events.
// Pure functions (no Firebase, no React) so they can be tested on their own.
//
// AIO stores a week as: weeks/{Monday date}/events/{fieldId} = { events: [...] }, where each
// event is { ts: hours since Monday 00:00, type: 'on' | 'off', additive?: 'fert' | 'chem',
// display?: 'time' | 'stop' | 'sis', sisDegrees? }. At most one event per half-day block
// (AM = hours 0-12, PM = 12-24).

export const DEFAULT_HOUR = { am: 8, pm: 17 }
export const SHEET_NAME = 'WATER SCHEDULE'
const FIRST_DATE_COL = 20 // column T
const HEADER_DATE_ROW = 3
const FIRST_UNIT_ROW = 5
const NAME_COL = 3 // column C: "Irrigation Name"
const FIELD_COL = 1 // column A: "Field Name" (only filled on the first row of a field)

const EXCEL_EPOCH = Date.UTC(1899, 11, 30)
export function serialToParts(serial) {
  const whole = Math.floor(serial + 1e-9)
  const frac = serial - whole
  const d = new Date(EXCEL_EPOCH + whole * 86400000)
  const iso = d.toISOString().slice(0, 10)
  const weekday = (d.getUTCDay() + 6) % 6 === d.getUTCDay() - 1 ? (d.getUTCDay() + 6) % 7 : (d.getUTCDay() + 6) % 7
  return { iso, dayIdx: (d.getUTCDay() + 6) % 7, shift: frac >= 0.5 - 1e-6 ? 'pm' : 'am', ms: d.getTime() }
}
export function mondayIso(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  const idx = (d.getUTCDay() + 6) % 7
  return new Date(d.getTime() - idx * 86400000).toISOString().slice(0, 10)
}

// One cell of text -> what it means for the schedule.
export function parseMark(raw) {
  if (raw == null) return { kind: 'blank' }
  const text = String(raw).trim()
  if (!text) return { kind: 'blank' }
  const lower = text.toLowerCase()
  if (lower === 'x') return { kind: 'cont' }
  const isOn = /^on\b/.test(lower)
  const isOff = /^off\b/.test(lower)
  if (!isOn && !isOff) return { kind: 'note', text }
  let hour = null
  const m = lower.match(/(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\b/)
  if (m) {
    const h = parseInt(m[1], 10)
    if (h >= 1 && h <= 12) hour = (h % 12) + (m[3] === 'p' ? 12 : 0) + (m[2] ? parseInt(m[2], 10) / 60 : 0)
  }
  if (isOn) {
    const additive = /fert/.test(lower) ? 'fert' : /chem/.test(lower) ? 'chem' : null
    return { kind: 'on', hour, additive }
  }
  const display = /\bstop\b/.test(lower) ? 'stop' : /\bsis\b/.test(lower) ? 'sis' : 'time'
  return { kind: 'off', hour, display }
}

// True when the unit has at least one On or Off written for it.
export function hasSchedule(unit) {
  return unit.marks.some((v) => { const k = parseMark(v).kind; return k === 'on' || k === 'off' })
}

// Reads the sheet into { dates, units }. `XLSX` is the xlsx library (passed in so this file has no imports).
export function extractGrid(ws, XLSX) {
  const range = XLSX.utils.decode_range(ws['!ref'])
  const maxRow = range.e.r + 1
  const maxCol = range.e.c + 1
  const val = (r, c) => { const cell = ws[XLSX.utils.encode_cell({ r: r - 1, c: c - 1 })]; return cell ? cell.v : undefined }
  const dates = []
  let prevMs = -Infinity
  for (let c = FIRST_DATE_COL; c <= maxCol; c++) {
    const v = val(HEADER_DATE_ROW, c)
    if (typeof v !== 'number') break
    const p = serialToParts(v)
    if (p.ms + (p.shift === 'pm' ? 1 : 0) <= prevMs) break // dates start going backwards: the next block is a different year
    prevMs = p.ms + (p.shift === 'pm' ? 1 : 0)
    dates.push({ col: c, ...p })
  }
  const units = []
  let farmLabel = ''
  let lastUsed = -1
  for (let r = FIRST_UNIT_ROW; r <= maxRow; r++) {
    const a = val(r, FIELD_COL)
    if (typeof a === 'string' && a.trim()) farmLabel = a.trim()
    const name = val(r, NAME_COL)
    if (typeof name !== 'string' || !name.trim()) continue
    const marks = dates.map((d) => val(r, d.col))
    marks.forEach((v, i) => { if (v != null && String(v).trim() !== '' && i > lastUsed) lastUsed = i })
    units.push({ row: r, name: name.trim().replace(/\s+/g, ' '), group: farmLabel, marks })
  }
  // The sheet has columns for the whole year; stop at the last half-day anyone wrote anything in,
  // so the end of the season isn't padded out with empty weeks.
  const used = dates.slice(0, lastUsed + 1)
  units.forEach((u) => { u.marks = u.marks.slice(0, lastUsed + 1) })
  return { dates: used, units }
}

// One irrigation unit's marks -> { weeks: Map(mondayIso -> events[]), stats }.
export function convertUnit(unit, dates) {
  const weeks = new Map()
  const stats = { on: 0, off: 0, defaultHour: 0, clockTime: 0, outsideBlock: 0, contWhileOff: 0, notes: 0, carried: 0, endedRunning: false, fert: 0, chem: 0 }
  let on = false
  let additive = null
  let curWeek = null
  dates.forEach((d, i) => {
    const week = mondayIso(d.iso)
    if (week !== curWeek) {
      curWeek = week
      if (on) {
        // Running when the week begins: AIO weeks are separate, so say so at Monday 00:00.
        weeks.set(week, [{ ts: 0, type: 'on', additive, _carry: true }])
        stats.carried++
      }
    }
    const mark = parseMark(unit.marks[i])
    const lo = d.shift === 'am' ? 0 : 12
    const base = d.dayIdx * 24
    const fallback = DEFAULT_HOUR[d.shift]
    const hourFor = (h) => {
      if (h == null) { stats.defaultHour++; return fallback }
      if (h < lo || h >= lo + 12) { stats.outsideBlock++; return fallback }
      stats.clockTime++
      return h
    }
    const push = (ev) => {
      if (!weeks.has(week)) weeks.set(week, [])
      const list = weeks.get(week)
      // A carry-in 'on' (Monday 00:00) goes after the cell's own event so the grid shows the cell's event.
      const ci = list.findIndex((e) => e._carry && e.ts >= base + lo && e.ts < base + lo + 12)
      if (ci >= 0) list.splice(ci, 0, ev); else list.push(ev)
    }
    if (mark.kind === 'note') stats.notes++
    else if (mark.kind === 'cont' && !on) stats.contWhileOff++
    else if (mark.kind === 'on') {
      const changesAdditive = on && mark.additive && mark.additive !== additive
      if (!on || changesAdditive) {
        const h = hourFor(mark.hour)
        const ev = { ts: base + h, type: 'on', additive: mark.additive || null }
        // 'on' at the start of a block that already has the carry-in event just replaces it
        if (weeks.get(week) && d.dayIdx === 0 && d.shift === 'am') {
          const list = weeks.get(week); const ci = list.findIndex((e) => e._carry)
          if (ci >= 0) list.splice(ci, 1)
        }
        push(ev)
        stats.on++
        if (mark.additive) stats[mark.additive]++
        on = true; additive = mark.additive || (changesAdditive ? additive : null)
        if (mark.additive) additive = mark.additive
      }
    } else if (mark.kind === 'off') {
      if (on) {
        const h = hourFor(mark.hour)
        const ev = { ts: base + h, type: 'off', display: mark.display }
        if (mark.display === 'sis') ev.sisDegrees = 180
        push(ev)
        stats.off++
        on = false; additive = null
      }
    }
  })
  stats.endedRunning = on
  // strip internal flag
  weeks.forEach((list, w) => weeks.set(w, list.map(({ _carry, ...e }) => e)))
  return { weeks, stats }
}

// ---- matching Excel unit names to AIO field names ----
const SYN = { N: 'NORTH', S: 'SOUTH', E: 'EAST', W: 'WEST', NE: 'NORTHEAST', NW: 'NORTHWEST', SE: 'SOUTHEAST', SW: 'SOUTHWEST', WIPER: 'BIG', CORNER: 'BIG', MINI: 'MINI', BIG: 'BIG' }
const DROP = new Set(['PVT', 'PIVOT', 'R', 'LINES', 'LINE', 'WHEELS', 'WHEEL', 'WL', 'AND'])
function tokens(name) {
  return String(name || '').toUpperCase().replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    .filter((t) => !DROP.has(t)).map((t) => SYN[t] || t)
}
// Returns the best AIO field for an Excel unit name, or null when there is no clear single match.
// `fields` = [{ id, name }]
export function suggestMatch(unitName, fields) {
  const ut = tokens(unitName)
  if (!ut.length) return null
  let best = null; let bestScore = 0; let tie = false
  fields.forEach((f) => {
    const ft = tokens(f.name)
    if (!ft.length) return
    const shared = ut.filter((t) => ft.includes(t)).length
    const score = shared / new Set([...ut, ...ft]).size
    // every word of the shorter name must appear in the other, and the first word (the field's own name) must agree
    const subset = ft.every((t) => ut.includes(t)) || ut.every((t) => ft.includes(t))
    if (ut[0] !== ft[0] || !subset) return
    if (score > bestScore + 1e-9) { best = f; bestScore = score; tie = false } else if (Math.abs(score - bestScore) < 1e-9) tie = true
  })
  return tie ? null : best
}

// Suggested field id for each unit (by index); two units never get the same suggestion.
export function suggestAll(units, fields) {
  const picks = units.map((u) => { const m = suggestMatch(u.name, fields); return m ? m.id : null })
  const count = new Map()
  picks.forEach((id) => { if (id) count.set(id, (count.get(id) || 0) + 1) })
  return picks.map((id) => (id && count.get(id) > 1 ? null : id))
}
