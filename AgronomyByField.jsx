import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, SAMPLE_TYPE_LABEL, statusFor, STATUS_COLOR, SAMPLE_TYPE_BADGE_COLOR, CROP_COLOR, sortValueKeys } from './AgronomyConfig.js'
import AgronomySeason3D, { normalizeToRange } from './AgronomySeason3D.jsx'
import { useLiveAgronomyCriteria, getCurveRows, mergeFlatTargets } from './AgronomyCriteriaData.js'

function fmtDate(ts) {
  if (!ts) return ''
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function weeksBetween(laterDate, earlierDate) {
  if (!laterDate || !earlierDate) return null
  const ms = laterDate.getTime() - earlierDate.getTime()
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000))
}

// Sample documents only carry fieldId + receivedDt, not a season/year -
// the full-history Stukenholtz backfill pulled years of samples per field,
// so without a bound here the "vs weeks since emergence" charts plot every
// sample ever recorded for this field against the CURRENT season's plant
// date, producing nonsense like "342 weeks before emergence" for a sample
// from a prior year. This clamps to a sane in-season window - 6 weeks
// before planting (covers a pre-plant baseline soil test) through 35 weeks
// after (comfortably past the longest curve in WEEKLY_CURVES_BY_CROP,
// potato's 17 weeks) - rather than the real fix of tagging each sample
// with its season at sync time, which needs a backend change.
const IN_SEASON_WEEK_MIN = -6
const IN_SEASON_WEEK_MAX = 35

// Short form for on-chart labels so 5-digit petiole NO3 readings (e.g. 21500)
// don't collide with neighbouring points; the table under each chart always
// shows the exact number.
function fmtChartValue(v) {
  if (v == null) return ''
  if (Math.abs(v) >= 10000) return `${(v / 1000).toFixed(1)}k`
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100)
}

// The target range in force at a given week: the band entry for that exact
// week when there is one (week-by-week curves), otherwise the nearest entry
// (flat fallback bands only have entries at the two ends and are the same
// range throughout anyway).
function rangeAt(band, x) {
  if (!band || !band.length) return null
  let best = band[0]
  for (const b of band) {
    if (b.x === x) return [b.low, b.high]
    if (Math.abs(b.x - x) < Math.abs(best.x - x)) best = b
  }
  return [best.low, best.high]
}

// Which curve column judges which metric. Metrics not listed (compost,
// nematode, soil Salts) just keep their flat target.
const CURVE_KEY_BY_METRIC = {
  'soil.NO3': 'soilNO3',
  'petiole.no3': 'petioleNO3',
  'petiole.p': 'petioleP',
  'petiole.k': 'petioleK',
  'petiole.sulfur': 'petioleS'
}

// The target for a reading: that sample's own week on the crop/variety
// curve when one exists (clamped to the curve's first/last week, same as the
// chart band), otherwise the flat target.
function targetForReading(type, metric, curveRows, sampleDate, plantDate) {
  const curveKey = CURVE_KEY_BY_METRIC[`${type}.${metric.key}`]
  if (!curveKey || !curveRows || !curveRows.length || !sampleDate || !plantDate) return metric.target
  const week = weeksBetween(sampleDate.toDate(), plantDate)
  if (week == null) return metric.target
  return curveRangeForWeek(curveRows, week, curveKey) || metric.target
}

// Scouting observations (Agworld "Weekly Dig" reports, imported on the
// Scouting tab) carry a real Timestamp in observedAt.
function obsDate(o) {
  return o && o.observedAt && o.observedAt.toDate ? o.observedAt.toDate() : null
}
function fmtObsDate(d) {
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
}

// Field moisture % target (Kent, Oct 28): below 71 = red, 71-88 = green,
// above 88 = orange. Same for every crop and week.
const MOISTURE_TARGET = [71, 88]

const STATUS_LABEL = { deficient: 'Below range', optimal: 'In range', excess: 'Above range' }

// Looks up a metric's value in a sample's `values`, tolerating the lab
// spelling a key differently than AgronomyConfig.js does ("NO3-N" vs "no3",
// "Phosphorus" vs "p", "P (%)"...). Exact key first, then a case/punctuation/
// unit-insensitive match against the key and a few known aliases.
const VALUE_ALIASES = {
  'soil.NO3': ['no3', 'no3n', 'nitrate', 'nitraten'],
  'petiole.no3': ['no3', 'no3n', 'nitrate', 'nitraten', 'petioleno3', 'petiolenitrate'],
  'petiole.p': ['p', 'phosphorus', 'ppercent', 'petiolep'],
  'petiole.k': ['k', 'potassium', 'kpercent', 'petiolek'],
  'petiole.sulfur': ['s', 'sulfur', 'sulphur', 'spercent', 'petioles']
}
function simplifyKey(k) {
  return String(k).toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, '').replace(/[^a-z0-9]/g, '').replace(/(ppm|percent|pct)$/, '')
}
function metricValue(values, type, metric) {
  if (!values) return undefined
  if (values[metric.key] != null) return values[metric.key]
  const wanted = new Set([simplifyKey(metric.key), ...(VALUE_ALIASES[`${type}.${metric.key}`] || [])])
  for (const [k, v] of Object.entries(values)) {
    if (v != null && wanted.has(simplifyKey(k))) return v
  }
  return undefined
}

// Range for a given week from a crop curve: that week's own entry when it
// has one, otherwise the nearest week that does (ties go to the earlier
// week). Weeks past the end of the sheet - e.g. potato week 17+, which only
// has a stage note - therefore keep the last known range instead of losing
// the band and falling back to the flat target.
function curveRangeForWeek(curveRows, week, curveKey) {
  let best = null
  for (const r of curveRows) {
    if (!r[curveKey]) continue
    const d = Math.abs(r.week - week)
    if (!best || d < best.d || (d === best.d && r.week < best.week)) best = { d, week: r.week, range: r[curveKey] }
  }
  return best ? best.range : null
}

// Soil on the left, petiole on the right, stacking only on a narrow screen.
// Set inline (not just in styles.css) so the layout can't silently fall back
// to one tall column if the stylesheet on the site is out of date.
const SPLIT_STYLE = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
  gap: 16,
  marginBottom: 16
}

// Compact hand-rolled line chart, no chart library - matches the rest of the
// app's approach of hand-rolled SVG/table markup rather than a new dependency
// for what's usually a handful of points per season.
//
// `band` (optional array of { x, low, high }, any order) draws a shaded
// reference corridor behind the trend line, matching the high/low lines on
// the Power BI "N Soil Level" / "N Petiole Level" charts. Unlike a flat
// target range, this corridor can shift week to week - the real agronomic
// targets move a lot over a season (e.g. potato Soil NO3 target starts at
// 35-50 ppm and tapers to 4-5 ppm by week 16), so a flat box drawn across
// the whole chart was actively misleading. The band's own bounds are
// folded into the y-domain so it's always fully visible even when a
// reading sits well outside it. The low/high numbers are labeled at the
// corridor's right edge (the most recent week) so "the range" stays
// legible without a separate legend.
//
// The x-axis is weeks since emergence, labeled with a handful of "Wk N"
// ticks along the bottom - points alone (no axis) made it impossible to
// tell which week a reading landed in.
function Sparkline({ points, color, band, emptyMessage, selectedWeek, onSelect }) {
  if (points.length < 1) {
    return <div className="agronomy-chart-empty">{emptyMessage || 'No readings yet'}</div>
  }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  let sortedBand = band && band.length ? [...band].sort((a, b) => a.x - b.x) : null
  // A single reading gives a one-week band; widen it a week each side so
  // the shaded range is still drawn as an area.
  if (sortedBand && sortedBand.length === 1) {
    const only = sortedBand[0]
    sortedBand = [{ ...only, x: only.x - 1 }, only, { ...only, x: only.x + 1 }]
  }
  const bandYs = sortedBand ? sortedBand.flatMap((b) => [b.low, b.high]) : []
  const bandXs = sortedBand ? sortedBand.map((b) => b.x) : []
  const minX = Math.min(...xs, ...bandXs), maxX = Math.max(...xs, ...bandXs)
  const minY = Math.min(...ys, ...bandYs), maxY = Math.max(...ys, ...bandYs)

  const w = 280, h = 120
  // padR is wide enough for a 5-digit band label (petiole NO3 targets run
  // up to ~25000 ppm) sitting just past the plot area's right edge.
  const padL = 30, padR = 34, padT = 10, padB = 20
  const plotW = w - padL - padR
  const plotH = h - padT - padB

  const scaleX = (x) => padL + ((x - minX) / (maxX - minX || 1)) * plotW
  const scaleY = (y) => padT + plotH - ((y - minY) / (maxY - minY || 1)) * plotH
  const path = points.map((p) => `${scaleX(p.x)},${scaleY(p.y)}`).join(' ')

  // Up to 5 week ticks, spread evenly across the actual sample range and
  // rounded to whole weeks, de-duped in case the range is short.
  const tickCount = Math.max(2, Math.min(5, maxX - minX + 1))
  const xTicks = [...new Set(
    Array.from({ length: tickCount }, (_, i) =>
      Math.round(minX + ((maxX - minX) * i) / (tickCount - 1))
    )
  )]

  // A closed polygon tracing the high edge left-to-right then the low edge
  // back right-to-left, so the shaded fill follows both boundaries exactly
  // instead of being a single rectangle.
  const bandPolygon = sortedBand
    ? [
        ...sortedBand.map((b) => `${scaleX(b.x)},${scaleY(b.high)}`),
        ...[...sortedBand].reverse().map((b) => `${scaleX(b.x)},${scaleY(b.low)}`)
      ].join(' ')
    : null
  const bandRightEdge = sortedBand ? sortedBand[sortedBand.length - 1] : null

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="agronomy-sparkline">
      {bandPolygon && (
        <>
          <polygon points={bandPolygon} className="agronomy-sparkline-band" />
          <text x={padL + plotW + 2} y={scaleY(bandRightEdge.high) + 3} className="agronomy-sparkline-range-label">
            {bandRightEdge.high}
          </text>
          <text x={padL + plotW + 2} y={scaleY(bandRightEdge.low) + 3} className="agronomy-sparkline-range-label">
            {bandRightEdge.low}
          </text>
        </>
      )}
      <line x1={padL} y1={padT + plotH} x2={padL + plotW} y2={padT + plotH} className="agronomy-sparkline-axis" />
      {xTicks.map((t) => (
        <text key={t} x={scaleX(t)} y={h - 4} className="agronomy-sparkline-week-label" textAnchor="middle">
          Wk {t}
        </text>
      ))}
      {selectedWeek != null && selectedWeek >= minX && selectedWeek <= maxX && (
        <line
          x1={scaleX(selectedWeek)} y1={padT} x2={scaleX(selectedWeek)} y2={padT + plotH}
          stroke="#555" strokeWidth="1" strokeDasharray="3 3"
        />
      )}
      <polyline points={path} fill="none" stroke={color} strokeWidth="2" />
      {points.map((p, i) => {
        const dot = (p.status && STATUS_COLOR[p.status]?.dot) || color
        const cy = scaleY(p.y)
        const isSelected = selectedWeek === p.x
        // Label above the point, flipped below when there's no room at the top.
        const labelY = cy < padT + 9 ? cy + 11 : cy - 5
        return (
          <g key={i} onClick={() => onSelect && onSelect(p.x)} style={{ cursor: onSelect ? 'pointer' : 'default' }}>
            <circle cx={scaleX(p.x)} cy={cy} r="9" fill="transparent" />
            <circle
              cx={scaleX(p.x)} cy={cy} r={isSelected ? 5.5 : 3.5} fill={dot}
              stroke={isSelected ? '#222' : '#fff'} strokeWidth={isSelected ? 2 : 1}
            />
            <text x={scaleX(p.x)} y={labelY} textAnchor="middle" className="agronomy-sparkline-value-label" fill={dot} fontSize="7" fontWeight="600">
              {fmtChartValue(p.y)}
            </text>
          </g>
        )
      })}
    </svg>
  )
}

// Builds the reference band passed to Sparkline: the real week-by-week
// curve for this field's crop/variety when the live Targets data (see
// AgronomyCriteriaData.js) has one, clamped to the curve's own defined
// range so a season running longer than the sheet covers still gets a band
// instead of a gap. Falls back to a flat band (the same [low, high]
// repeated across the chart's x-range) for any crop with no curve defined
// yet - onions, alfalfa, etc. - using the fallback target from
// METRICS_BY_TYPE (merged with any live flat-target override by the
// caller before it gets here).
function buildBand(points, curveRows, curveKey, flatTarget) {
  if (!points.length) return null
  const xs = points.map((p) => p.x)
  const minX = Math.min(...xs), maxX = Math.max(...xs)

  if (curveRows && curveRows.length) {
    const band = []
    for (let week = minX; week <= maxX; week++) {
      const range = curveRangeForWeek(curveRows, week, curveKey)
      if (range) band.push({ x: week, low: range[0], high: range[1] })
    }
    return band.length ? band : null
  }

  if (!flatTarget) return null
  return [
    { x: minX, low: flatTarget[0], high: flatTarget[1] },
    { x: maxX, low: flatTarget[0], high: flatTarget[1] }
  ]
}

export default function AgronomyByField({ fields }) {
  const [fieldId, setFieldId] = useState(null)
  const [samples, setSamples] = useState([])
  const [samplesError, setSamplesError] = useState(null)

  // Pick the first field when nothing is selected - and ALSO when the
  // selected field is no longer in the list, which happens whenever the farm
  // (or season) filter above changes to one that doesn't include it. Without
  // this, the dropdown just displayed the first field of the new list while
  // the page kept showing the OLD field's samples (no crop, no plant date),
  // which looked like samples had been matched to the wrong field.
  const [cropFilter, setCropFilter] = useState('all')
  const cropOptions = useMemo(
    () => [...new Set(fields.map((f) => f.cropName).filter(Boolean))].sort(),
    [fields]
  )
  // If the farm/season filters above leave no field of the chosen crop, drop
  // back to all crops rather than showing an empty picker.
  useEffect(() => {
    if (cropFilter !== 'all' && !cropOptions.includes(cropFilter)) setCropFilter('all')
  }, [cropOptions, cropFilter])
  const visibleFields = useMemo(
    () => (cropFilter === 'all' ? fields : fields.filter((f) => f.cropName === cropFilter)),
    [fields, cropFilter]
  )

  useEffect(() => {
    if (!visibleFields.length) return
    if (!fieldId || !visibleFields.some((f) => f.id === fieldId)) setFieldId(visibleFields[0].id)
  }, [visibleFields, fieldId])

  useEffect(() => {
    if (!fieldId) return
    // Clear the previous field's samples straight away so they can't sit
    // on screen under the new field's name while the new query loads.
    setSamples([])
    const q = query(collection(db, 'samples'), where('fieldId', '==', fieldId), orderBy('receivedDt', 'asc'))
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
        setSamples(list)
        setSamplesError(null)
      },
      (err) => {
        // Without this, a failed query (missing composite index,
        // permissions issue, etc.) looks identical to "genuinely no
        // samples for this field" - surface it instead. Check the
        // browser console too - Firestore prints a clickable link that
        // auto-creates a missing index.
        console.error('AgronomyByField samples query failed:', err)
        setSamplesError(err.message)
      }
    )
    return () => unsub()
  }, [fieldId])

  // Scouting observations for this field. Equality filter only (sorted here
  // in the browser) so no composite index is needed.
  const [observations, setObservations] = useState([])
  useEffect(() => {
    if (!fieldId) return
    setObservations([])
    const q = query(collection(db, 'scoutingObservations'), where('fieldId', '==', fieldId))
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
        list.sort((a, b) => (obsDate(a)?.getTime() || 0) - (obsDate(b)?.getTime() || 0))
        setObservations(list)
      },
      (err) => console.error('AgronomyByField scouting query failed:', err)
    )
    return () => unsub()
  }, [fieldId])

  const field = fields.find((f) => f.id === fieldId)

  // plantDate/cropName/varietyName/acres all come straight from the season-
  // and farm-aware fields list built in Agronomy.jsx, instead of this
  // component fetching its own season data - keeps the season-selection
  // logic in one place rather than duplicated per tab.
  const plantDate = useMemo(() => (field?.plantDate ? new Date(field.plantDate) : null), [field])
  const weeksSinceEmergence = useMemo(() => weeksBetween(new Date(), plantDate), [plantDate])

  const latestByType = useMemo(() => {
    const next = {}
    samples.forEach((s) => { next[s.type] = s })
    return next
  }, [samples])

  // Soil sampling covers two different things that happen to share the same
  // `type: 'soil'`: the quick in-season test (just NO3 + Salts, confirmed
  // exact keys) and a fuller fall/annual panel (~20 values, keys not yet
  // confirmed the way NO3/Salts are). Rather than hardcode the fall panel's
  // key names, any soil sample with more than the 2 known quick-test keys is
  // treated as an annual panel - a shape check, not a date check, so it
  // still works if the fall sampling window shifts year to year. Per Kent
  // (Oct 26): full soil panels and nematode counts are yearly review data,
  // not weekly trend data, so they get a snapshot card here instead of a
  // "vs weeks since emergence" line like the weekly soil/petiole pair below.
  const annualSoilSample = useMemo(() => {
    const fullPanel = samples.filter((s) => s.type === 'soil' && Object.keys(s.values || {}).length > 2)
    return fullPanel.length ? fullPanel[fullPanel.length - 1] : null
  }, [samples])

  const nematodeSample = latestByType['nematode'] || null

  const { flatTargets, curvesByKey } = useLiveAgronomyCriteria()
  const metricsByType = useMemo(() => mergeFlatTargets(METRICS_BY_TYPE, flatTargets), [flatTargets])
  const curveRows = getCurveRows(curvesByKey, field?.cropName, field?.varietyName)

  // Clicking a point on either chart picks a week; the tiles up top then
  // show the readings as of that week. null = latest (the default view).
  const [selectedWeek, setSelectedWeek] = useState(null)
  useEffect(() => { setSelectedWeek(null) }, [fieldId])
  const toggleWeek = (x) => setSelectedWeek((w) => (w === x ? null : x))

  // The sample a tile shows for a type: the latest overall by default, or
  // - once a week is picked - the latest one taken on or before that week,
  // so the tile is never blank just because soil and petiole were sampled
  // in different weeks (the tile says which date/week it's actually from).
  function sampleAsOf(type) {
    if (selectedWeek == null || !plantDate) return latestByType[type] || null
    let found = null
    samples.forEach((s) => {
      if (s.type === type && s.receivedDt && weeksBetween(s.receivedDt.toDate(), plantDate) <= selectedWeek) found = s
    })
    return found
  }

  // N Rec is the one Phase 2 nitrogen KPI available right now - a pure
  // lookup against the field's own crop/variety curve for the week being
  // shown. N Applied / N Use / Total N Applied still need the Agworld
  // applications sync (in progress separately) before they can show real
  // numbers, so this tile is left out entirely for a crop with no curve
  // defined yet.
  const activeWeek = selectedWeek != null ? selectedWeek : weeksSinceEmergence
  const nRecRow = useMemo(() => {
    if (!curveRows || activeWeek == null) return null
    return curveRows.find((r) => r.week === activeWeek) || null
  }, [curveRows, activeWeek])

  // Field moisture % from the scouting reports, placed on the same weeks-
  // since-emergence axis (and the same in-season window) as the other charts.
  const moisturePoints = useMemo(() => {
    if (!plantDate) return []
    return observations
      .filter((o) => o.moisture != null && obsDate(o))
      .map((o) => ({ x: weeksBetween(obsDate(o), plantDate), y: o.moisture, date: obsDate(o) }))
      .filter((p) => p.x != null && p.x >= IN_SEASON_WEEK_MIN && p.x <= IN_SEASON_WEEK_MAX)
  }, [observations, plantDate])
  // Tile value: latest reading on or before the picked week (or latest overall).
  const moistureAsOf = useMemo(() => {
    let found = null
    moisturePoints.forEach((p) => { if (selectedWeek == null || p.x <= selectedWeek) found = p })
    return found
  }, [moisturePoints, selectedWeek])
  const moistureBand = useMemo(() => buildBand(moisturePoints, null, null, MOISTURE_TARGET), [moisturePoints])
  const moistureJudged = useMemo(
    () => moisturePoints.map((p) => ({ ...p, status: statusFor(p.y, MOISTURE_TARGET) })),
    [moisturePoints]
  )
  const moistureStatus = moistureAsOf ? statusFor(moistureAsOf.y, MOISTURE_TARGET) : null
  const digLog = useMemo(
    () => observations.filter((o) => obsDate(o) && plantDate)
      .filter((o) => { const w = weeksBetween(obsDate(o), plantDate); return w >= IN_SEASON_WEEK_MIN && w <= IN_SEASON_WEEK_MAX })
      .reverse(),
    [observations, plantDate]
  )
  const digKeys = useMemo(() => [...new Set(digLog.flatMap((o) => Object.keys(o.values || {})))], [digLog])

  const cropColor = field?.cropName ? (CROP_COLOR[field.cropName] || { bg: '#D3D1C7', fg: '#2C2C2A' }) : null

  function renderTile(type, m) {
    const sample = sampleAsOf(type)
    const value = metricValue(sample?.values, type, m)
    const target = targetForReading(type, m, curveRows, sample?.receivedDt, plantDate)
    const status = statusFor(value, target)
    const color = status ? STATUS_COLOR[status] : null
    const sampleWeek = sample?.receivedDt && plantDate ? weeksBetween(sample.receivedDt.toDate(), plantDate) : null
    return (
      <div
        key={type + m.key}
        className="agronomy-kpi-card"
        style={color ? { borderTop: `3px solid ${color.dot}` } : undefined}
      >
        <p className="agronomy-kpi-label">{SAMPLE_TYPE_LABEL[type]} {m.label}</p>
        <p className="agronomy-kpi-value" style={color ? { color: color.fg } : undefined}>
          {value != null ? value : '—'}
          {value != null && <span className="agronomy-kpi-unit"> {m.unit}</span>}
        </p>
        <p className="agronomy-kpi-date">Target {target[0]}{'–'}{target[1]}</p>
        {value != null && sample?.receivedDt && (
          <p className="agronomy-kpi-date">
            {fmtDate(sample.receivedDt)}
            {sampleWeek != null ? ` · Wk ${sampleWeek}` : ''}
            {selectedWeek != null && sampleWeek != null && sampleWeek !== selectedWeek ? ` (none in wk ${selectedWeek})` : ''}
          </p>
        )}
        {status && (
          <span className="agronomy-status-badge" style={{ background: color.bg, color: color.fg }}>
            {STATUS_LABEL[status] || status}
          </span>
        )}
      </div>
    )
  }

  function renderChartCard(type) {
    const typeSamples = samples.filter((s) => s.type === type)
    const metric = metricsByType[type][0]
    const withValue = typeSamples
      .map((s) => ({ s, y: metricValue(s.values, type, metric) }))
      .filter(({ s, y }) => y != null && s.receivedDt)
    const dated = plantDate
      ? withValue.map(({ s, y }) => ({
          x: weeksBetween(s.receivedDt.toDate(), plantDate),
          y,
          date: s.receivedDt
        }))
      : []
    const points = dated.filter((p) => p.x != null && p.x >= IN_SEASON_WEEK_MIN && p.x <= IN_SEASON_WEEK_MAX)
    // Say WHY a chart is empty instead of just "not enough samples".
    let emptyMessage = `No ${SAMPLE_TYPE_LABEL[type].toLowerCase()} samples for this field yet`
    if (typeSamples.length > 0 && withValue.length === 0) {
      const keys = [...new Set(typeSamples.flatMap((s) => Object.keys(s.values || {})))]
      emptyMessage = keys.length
        ? `${typeSamples.length} sample(s), but none has a ${metric.label} value. Value names found: ${keys.join(', ')}`
        : `${typeSamples.length} sample(s), but the lab sent no values yet`
    } else if (withValue.length > 0 && !plantDate) {
      emptyMessage = 'This field has no plant date for the selected season, so readings can’t be placed on the weekly chart'
    } else if (withValue.length > 0 && points.length === 0) {
      emptyMessage = `${withValue.length} reading(s), all outside this season (more than ${-IN_SEASON_WEEK_MIN} weeks before or ${IN_SEASON_WEEK_MAX} weeks after planting). Check the season selected above.`
    }
    const band = buildBand(points, curveRows, type === 'soil' ? 'soilNO3' : 'petioleNO3', metric.target)
    // Each reading is judged against the range for ITS week, not
    // today's: red = below range, green = in range, orange = above.
    const judged = points.map((p) => {
      const range = rangeAt(band, p.x)
      return { ...p, range, status: range ? statusFor(p.y, range) : null }
    })
    return (
      <div className="agronomy-chart-card">
        <p className="agronomy-chart-title">
          {SAMPLE_TYPE_LABEL[type]} {metric.label} vs weeks since emergence {'·'} click a point to see that week above
        </p>
        <Sparkline
          points={judged}
          color={type === 'soil' ? '#0F6E56' : '#3B6D11'}
          band={band}
          emptyMessage={emptyMessage}
          selectedWeek={selectedWeek}
          onSelect={toggleWeek}
        />
        {judged.length > 0 && (
          <table className="agronomy-chart-readings" style={{ minWidth: 0, width: '100%', fontSize: 10 }}>
            <thead>
              <tr><th>Date</th><th>Wk</th><th>Reading</th><th>Target</th></tr>
            </thead>
            <tbody>
              {[...judged].reverse().map((p, i) => {
                const c = p.status ? STATUS_COLOR[p.status] : null
                return (
                  <tr
                    key={i}
                    className={`agronomy-chart-reading-row${selectedWeek === p.x ? ' selected' : ''}`}
                    onClick={() => toggleWeek(p.x)}
                  >
                    <td>{fmtDate(p.date)}</td>
                    <td>{p.x}</td>
                    <td>
                      <span
                        className="agronomy-reading-chip"
                        style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontWeight: 600, ...(c ? { background: c.bg, color: c.fg } : {}) }}
                      >
                        {p.y}
                      </span>
                    </td>
                    <td>{p.range ? `${p.range[0]}–${p.range[1]}` : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    )
  }

  // In-season readings of a weekly measure, each judged against the target
  // for its own week - same logic as renderChartCard, used for the 3D view.
  function judgedFor(type) {
    const metric = metricsByType[type][0]
    if (!plantDate) return { metric, judged: [] }
    const pts = samples
      .filter((s) => s.type === type && s.receivedDt)
      .map((s) => ({ s, y: metricValue(s.values, type, metric) }))
      .filter(({ y }) => y != null)
      .map(({ s, y }) => ({ x: weeksBetween(s.receivedDt.toDate(), plantDate), y, date: s.receivedDt }))
      .filter((p) => p.x != null && p.x >= IN_SEASON_WEEK_MIN && p.x <= IN_SEASON_WEEK_MAX)
    const band = buildBand(pts, curveRows, type === 'soil' ? 'soilNO3' : 'petioleNO3', metric.target)
    const judged = pts.map((p) => {
      const range = rangeAt(band, p.x)
      return { ...p, range, status: range ? statusFor(p.y, range) : null, norm: normalizeToRange(p.y, range) }
    })
    return { metric, judged }
  }
  const soil3d = judgedFor('soil')
  const petiole3d = judgedFor('petiole')
  const season3dSeries = [
    { key: 'soil', label: 'Soil NO3', unit: soil3d.metric.unit, color: '#0F6E56', points: soil3d.judged },
    { key: 'petiole', label: 'Petiole NO3', unit: petiole3d.metric.unit, color: '#3B6D11', points: petiole3d.judged },
    {
      key: 'moisture', label: 'Field moisture', unit: '%', color: '#1F6FB2',
      points: moistureJudged.map((p) => ({ ...p, range: MOISTURE_TARGET, norm: normalizeToRange(p.y, MOISTURE_TARGET) }))
    }
  ]

  return (
    <div className="agronomy-by-field">
      <div className="agronomy-field-picker">
        <select value={cropFilter} onChange={(e) => setCropFilter(e.target.value)}>
          <option value="all">All crops</option>
          {cropOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={fieldId || ''} onChange={(e) => setFieldId(e.target.value)}>
          {visibleFields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {field?.cropName && (
          <span className="crop-badge" style={{ background: cropColor.bg, color: cropColor.fg }}>
            {field.cropName}
          </span>
        )}
        {field?.varietyName && <span className="acres-tag"> {'·'} {field.varietyName}</span>}
        {field?.acres != null && <span className="acres-tag"> {'·'} {field.acres.toFixed(1)} ac</span>}
      </div>

      {samplesError && (
        <p className="agronomy-error-banner">
          Couldn't load samples: {samplesError}. Check the browser console for a Firestore error - it may include
          a link to create a missing index automatically.
        </p>
      )}

      <div className="agronomy-kpi-grid">
        <div className="agronomy-kpi-card">
          <p className="agronomy-kpi-label">{selectedWeek != null ? 'Showing week' : 'Weeks since emergence'}</p>
          <p className="agronomy-kpi-value">{activeWeek != null ? activeWeek : '—'}</p>
          {selectedWeek != null && (
            <button className="agronomy-link-btn" onClick={() => setSelectedWeek(null)}>Back to latest</button>
          )}
        </div>
        {moistureAsOf && (
          <div
            className="agronomy-kpi-card"
            style={moistureStatus ? { borderTop: `3px solid ${STATUS_COLOR[moistureStatus].dot}` } : undefined}
          >
            <p className="agronomy-kpi-label">Field moisture</p>
            <p className="agronomy-kpi-value" style={moistureStatus ? { color: STATUS_COLOR[moistureStatus].fg } : undefined}>
              {moistureAsOf.y}<span className="agronomy-kpi-unit"> %</span>
            </p>
            <p className="agronomy-kpi-date">Target {MOISTURE_TARGET[0]}{'–'}{MOISTURE_TARGET[1]}</p>
            <p className="agronomy-kpi-date">
              {fmtObsDate(moistureAsOf.date)} {'·'} Wk {moistureAsOf.x}
              {selectedWeek != null && moistureAsOf.x !== selectedWeek ? ` (none in wk ${selectedWeek})` : ''}
            </p>
            {moistureStatus && (
              <span className="agronomy-status-badge" style={{ background: STATUS_COLOR[moistureStatus].bg, color: STATUS_COLOR[moistureStatus].fg }}>
                {STATUS_LABEL[moistureStatus]}
              </span>
            )}
          </div>
        )}
        {nRecRow && (
          <div className="agronomy-kpi-card">
            <p className="agronomy-kpi-label">N Rec ({selectedWeek != null ? `wk ${selectedWeek}` : 'this week'})</p>
            <p className="agronomy-kpi-value">
              {nRecRow.nRec != null ? nRecRow.nRec : '—'}
              {nRecRow.nRec != null && <span className="agronomy-kpi-unit"> lbs/ac</span>}
            </p>
            {nRecRow.stage && <p className="agronomy-kpi-date">{nRecRow.stage}</p>}
          </div>
        )}
      </div>

      <div className="agronomy-split" style={SPLIT_STYLE}>
        {['soil', 'petiole'].map((type) => (
          <div key={type} className="agronomy-split-col" style={{ minWidth: 0 }}>
            <div className="agronomy-kpi-grid">
              {[type].flatMap((t) =>
                metricsByType[t]
                  .filter((m) => m.target) // no target yet = not "at a glance" actionable; still visible in the sample table below
                  .map((m) => renderTile(t, m))
              )}
            </div>
            {renderChartCard(type)}
          </div>
        ))}
      </div>

      <div className="agronomy-split" style={SPLIT_STYLE}>
        <div className="agronomy-split-col" style={{ minWidth: 0 }}>
          <div className="agronomy-chart-card">
            <p className="agronomy-chart-title">
              Field moisture % vs weeks since emergence {'·'} click a point to see that week above
            </p>
            <Sparkline
              points={moistureJudged}
              color="#1F6FB2"
              band={moistureBand}
              emptyMessage={
                observations.length === 0
                  ? 'No scouting reports for this field yet - upload one on the Scouting tab'
                  : !plantDate
                    ? 'This field has no plant date for the selected season, so readings can’t be placed on the weekly chart'
                    : 'No field moisture readings in this season'
              }
              selectedWeek={selectedWeek}
              onSelect={toggleWeek}
            />
            {moisturePoints.length > 0 && (
              <table className="agronomy-chart-readings" style={{ minWidth: 0, width: '100%', fontSize: 10 }}>
                <thead><tr><th>Date</th><th>Wk</th><th>Moisture %</th><th>Target</th></tr></thead>
                <tbody>
                  {[...moistureJudged].reverse().map((p, i) => (
                    <tr
                      key={i}
                      className={`agronomy-chart-reading-row${selectedWeek === p.x ? ' selected' : ''}`}
                      onClick={() => toggleWeek(p.x)}
                    >
                      <td>{fmtObsDate(p.date)}</td><td>{p.x}</td>
                      <td>
                        <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontWeight: 600, background: STATUS_COLOR[p.status].bg, color: STATUS_COLOR[p.status].fg }}>
                          {p.y}
                        </span>
                      </td>
                      <td>{MOISTURE_TARGET[0]}{'–'}{MOISTURE_TARGET[1]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <div className="agronomy-split-col" style={{ minWidth: 0 }}>
          {digLog.length > 0 && (
            <div className="agronomy-chart-card" style={{ overflowX: 'auto' }}>
              <p className="agronomy-chart-title">Scouting log (Agworld)</p>
              <table className="agronomy-chart-readings" style={{ minWidth: 0, width: '100%', fontSize: 10 }}>
                <thead>
                  <tr>
                    <th>Date</th><th>Wk</th><th>Moist %</th>
                    {digKeys.map((k) => <th key={k}>{k}</th>)}
                    <th>Comments</th>
                  </tr>
                </thead>
                <tbody>
                  {digLog.map((o) => {
                    const d = obsDate(o)
                    const wk = weeksBetween(d, plantDate)
                    return (
                      <tr
                        key={o.id}
                        className={`agronomy-chart-reading-row${selectedWeek === wk ? ' selected' : ''}`}
                        onClick={() => toggleWeek(wk)}
                      >
                        <td>{fmtObsDate(d)}</td>
                        <td>{wk}</td>
                        <td>
                          {o.moisture != null ? (
                            <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontWeight: 600, background: STATUS_COLOR[statusFor(o.moisture, MOISTURE_TARGET)].bg, color: STATUS_COLOR[statusFor(o.moisture, MOISTURE_TARGET)].fg }}>
                              {o.moisture}
                            </span>
                          ) : '—'}
                        </td>
                        {digKeys.map((k) => <td key={k}>{o.values && o.values[k] != null ? o.values[k] : ''}</td>)}
                        <td>{o.comments || ''}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      <div className="agronomy-chart-card" style={{ marginBottom: 16 }}>
        <p className="agronomy-chart-title">
          Season 3D view {'·'} soil NO3, petiole NO3 and field moisture by week {'·'} drag to rotate, click a dot to pick that week
        </p>
        <AgronomySeason3D
          series={season3dSeries}
          selectedWeek={selectedWeek}
          onSelect={toggleWeek}
          fmtDate={(d) => (d && d.toDate ? fmtDate(d) : fmtObsDate(d))}
        />
      </div>

      {(annualSoilSample || nematodeSample) && (
        <>
          <p className="agronomy-section-label">Annual review</p>
          <div className="agronomy-annual-cards">
            {annualSoilSample && (
              <div className="agronomy-annual-card">
                <p className="agronomy-annual-card-title">
                  Fall soil panel {'—'} {fmtDate(annualSoilSample.receivedDt)}
                </p>
                <div className="agronomy-annual-values">
                  {sortValueKeys('soil', Object.keys(annualSoilSample.values || {})).map((k) => (
                    <div key={k} className="agronomy-annual-value-row">
                      <span>{k}</span><span>{annualSoilSample.values[k]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {nematodeSample && (
              <div className="agronomy-annual-card">
                <p className="agronomy-annual-card-title">
                  Nematode counts {'—'} {fmtDate(nematodeSample.receivedDt)}
                </p>
                <div className="agronomy-annual-values">
                  {metricsByType.nematode
                    .filter((m) => nematodeSample.values?.[m.key] != null)
                    .map((m) => (
                      <div key={m.key} className="agronomy-annual-value-row">
                        <span>{m.label}</span>
                        <span>{nematodeSample.values[m.key]}{m.unit ? ` ${m.unit}` : ''}</span>
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      <p className="agronomy-section-label">All samples {field ? `— ${field.name}` : ''}</p>
      <table className="agronomy-sample-table">
        <thead>
          <tr><th>Date</th><th>Type</th><th>Values</th></tr>
        </thead>
        <tbody>
          {samples.length === 0 && (
            <tr><td colSpan={3} className="agronomy-table-empty">No samples yet for this field.</td></tr>
          )}
          {[...samples].reverse().map((s) => (
            <tr key={s.id}>
              <td>{fmtDate(s.receivedDt)}</td>
              <td>
                <span
                  className="agronomy-type-badge"
                  style={{ background: SAMPLE_TYPE_BADGE_COLOR[s.type]?.bg, color: SAMPLE_TYPE_BADGE_COLOR[s.type]?.fg }}
                >
                  {SAMPLE_TYPE_LABEL[s.type]}
                </span>
              </td>
              <td>{sortValueKeys(s.type, Object.keys(s.values || {})).map((k) => `${k}: ${s.values[k]}`).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
