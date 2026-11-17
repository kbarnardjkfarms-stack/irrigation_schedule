// Spray schedule — plain logic shared by the Spray screens (no React, so it's testable).

export const TZ = 'America/Denver'
const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
export const todayYmd = () => ymdFmt.format(new Date())
export function addDays(ymd, n) {
  const d = new Date(ymd + 'T12:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
export function fmtDay(ymd, opts) {
  if (!ymd) return ''
  return new Date(ymd + 'T12:00:00Z').toLocaleDateString('en-US', Object.assign({ timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }, opts || {}))
}
export const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '')
// Farm / field names the way the Farm Map matches them: "Hawaii 07" = "HAWAII7".
export const mapKey = (v) => String(v || '').replace(/\b0+(\d)/g, '$1').toUpperCase().replace(/[^A-Z0-9]/g, '')

/** Is this job one of mine? My name on the job (AgWorld comment or AIO farm), or one of my farms. */
export function isMine(j, myName, myFarmKeys) {
  if (myName && normName(j.manager) && normName(j.manager) === normName(myName)) return true
  if (!myFarmKeys || !myFarmKeys.size) return false
  const farms = String(j.farm || '').split(',').map((x) => mapKey(x)).filter(Boolean)
  return farms.some((f) => myFarmKeys.has(f))
}

/** sprayJobs + sprayJobState -> what the screens show. Removed jobs are kept, flagged hidden. */
export function mergeJobs(jobs, states) {
  const out = []
  Object.keys(jobs || {}).forEach((k) => {
    const j = jobs[k], st = (states || {})[k] || {}
    if (j.needs_review) return
    const plannedDate = (st.move && st.move.date) || j.planned_date
    out.push(Object.assign({}, j, {
      job_key: k,
      agworld_date: j.planned_date,
      planned_date: plannedDate,
      moved: !!(st.move && st.move.date),
      operator: (st.assign && st.assign.operator) || '',
      rig: (st.assign && st.assign.rig) || '',
      done: st.done || null,
      hidden: st.hidden || null,
      released: st.hidden_released || null
    }))
  })
  return out
}

/** Season log rows: every state doc with a done row (outlives the job doc). */
export function doneRows(states, jobs) {
  const out = []
  Object.keys(states || {}).forEach((k) => {
    const st = states[k]
    if (!st || !st.done || st.hidden) return
    out.push(Object.assign({ job_key: k, job: (jobs || {})[k] || null }, st.done))
  })
  return out
}

/** The color of the stripe on a card: drone yellow, spray green, spread orange. */
export function kindOf(j) {
  if (j.source === 'drone') return 'drone'
  return j.job_type === 'Spread' ? 'spread' : 'spray'
}
export const KIND_LABEL = { drone: 'Drone', spray: 'Ag Rows spray', spread: 'Ag Rows spread' }

const CROP_EMOJI = [
  [/potato/, '🥔'], [/sweet ?corn|corn|maize/, '🌽'], [/wheat|barley|grain|oat|triticale/, '🌾'],
  [/alfalfa|hay|lucerne/, '🌿'], [/beet/, '🟣'], [/onion/, '🧅'], [/bean/, '🫘'], [/pea\b|peas/, '🟢'],
  [/carrot/, '🥕'], [/mint/, '🌱'], [/squash|pumpkin/, '🎃'], [/fallow/, '🟫']
]
export function cropEmoji(crop) {
  const c = String(crop || '').toLowerCase()
  for (const [re, e] of CROP_EMOJI) if (re.test(c)) return e
  return c ? '🌱' : ''
}

/** Open jobs by operator lane. Unassigned first, then operators A-Z; jobs by date inside a lane. */
export function lanes(jobs) {
  const by = {}
  jobs.forEach((j) => { const k = j.operator || ''; (by[k] = by[k] || []).push(j) })
  return Object.keys(by).sort((a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
    .map((k) => ({ operator: k, jobs: by[k].sort((x, y) => (x.planned_date < y.planned_date ? -1 : x.planned_date > y.planned_date ? 1 : String(x.field).localeCompare(String(y.field)))) }))
}

/** "Past due" / "Today" / "Tomorrow" / "Wed, Nov 19" — the divider above a group of cards. */
export function dayLabel(ymd, today) {
  if (!ymd) return 'No date'
  if (ymd < today) return 'Past due'
  if (ymd === today) return 'Today'
  if (ymd === addDays(today, 1)) return 'Tomorrow'
  return fmtDay(ymd)
}

/** Which open jobs show for a range: 'today' (and past due), 'week' (next 7 days), 'all'. */
export function inRange(j, range, today) {
  if (range === 'all') return true
  const end = range === 'today' ? today : addDays(today, 6)
  return String(j.planned_date) <= end
}

// ---- weather (Open-Meteo, at the field pin) --------------------------------
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
export const compass = (deg) => (deg == null || !isFinite(deg) ? '' : COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8])

export function weatherUrl(lat, lng) {
  return 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
    '&current=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m' +
    '&hourly=wind_speed_10m,wind_gusts_10m' +
    '&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=' + encodeURIComponent(TZ) + '&forecast_days=16'
}

/** Open-Meteo answer -> what a card shows for one day: { now?, maxWind, maxGust } (now only for today). */
export function summarizeWeather(data, ymd, today) {
  if (!data || !data.hourly || !data.hourly.time) return null
  const h = data.hourly
  let maxWind = null, maxGust = null
  h.time.forEach((t, i) => {
    if (String(t).slice(0, 10) !== ymd) return
    const hr = Number(String(t).slice(11, 13))
    if (hr < 6 || hr > 20) return                                  // daylight working hours
    if (h.wind_speed_10m[i] != null) maxWind = Math.max(maxWind == null ? 0 : maxWind, h.wind_speed_10m[i])
    if (h.wind_gusts_10m[i] != null) maxGust = Math.max(maxGust == null ? 0 : maxGust, h.wind_gusts_10m[i])
  })
  if (maxWind == null) return null
  const out = { maxWind: Math.round(maxWind), maxGust: maxGust == null ? null : Math.round(maxGust) }
  if (ymd === today && data.current) {
    const c = data.current
    out.now = { wind: Math.round(c.wind_speed_10m), gust: Math.round(c.wind_gusts_10m), dir: compass(c.wind_direction_10m), temp: Math.round(c.temperature_2m) }
  }
  return out
}

/** Wind level for coloring: 0 ok, 1 watch, 2 too windy (same lines as the Google app). */
export const WIND_MPH = [10, 15]
export const GUST_MPH = [15, 25]
export function windLevel(wind, gust) {
  const w = wind == null ? 0 : wind, g = gust == null ? 0 : gust
  if (w >= WIND_MPH[1] || g >= GUST_MPH[1]) return 2
  if (w >= WIND_MPH[0] || g >= GUST_MPH[0]) return 1
  return 0
}

/** Manager phone numbers from AIO users (same name as the AgWorld comment, ignoring case/spaces). */
export function phoneBook(users) {
  const m = {}
  ;(users || []).forEach((u) => { if (u && u.name && u.phone) m[normName(u.name)] = String(u.phone) })
  return m
}
