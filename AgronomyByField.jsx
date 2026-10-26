import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, SAMPLE_TYPE_LABEL, statusFor, STATUS_COLOR, SAMPLE_TYPE_BADGE_COLOR, CROP_COLOR, WEEKLY_CURVES_BY_CROP } from './AgronomyConfig.js'

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
function Sparkline({ points, color, band }) {
  if (points.length < 2) {
    return <div className="agronomy-chart-empty">Not enough samples yet</div>
  }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const sortedBand = band && band.length ? [...band].sort((a, b) => a.x - b.x) : null
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
      <polyline points={path} fill="none" stroke={color} strokeWidth="2" />
      {points.map((p, i) => (
        <circle key={i} cx={scaleX(p.x)} cy={scaleY(p.y)} r="2.5" fill={color} />
      ))}
    </svg>
  )
}

// Builds the reference band passed to Sparkline: the real week-by-week
// curve for this crop when WEEKLY_CURVES_BY_CROP has one (potato, beets,
// corn, as of Oct 2026), clamped to the curve's own defined range so a
// season running longer than the sheet covers still gets a band instead of
// a gap. Falls back to a flat band (the same [low, high] repeated across
// the chart's x-range) for any crop not yet in that table - onions,
// alfalfa, etc. - using the placeholder target from METRICS_BY_TYPE.
function buildBand(points, cropName, curveKey, flatTarget) {
  if (!points.length) return null
  const xs = points.map((p) => p.x)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const curveRows = cropName ? WEEKLY_CURVES_BY_CROP[cropName] : null

  if (curveRows && curveRows.length) {
    const sorted = [...curveRows].sort((a, b) => a.week - b.week)
    const band = []
    for (let week = minX; week <= maxX; week++) {
      const row =
        sorted.find((r) => r.week === week) ||
        (week < sorted[0].week ? sorted[0] : sorted[sorted.length - 1])
      const range = row[curveKey]
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

  useEffect(() => {
    if (fields.length && !fieldId) setFieldId(fields[0].id)
  }, [fields, fieldId])

  useEffect(() => {
    if (!fieldId) return
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

  // N Rec is the one Phase 2 nitrogen KPI available right now - a pure
  // lookup against the field's own crop + current week from
  // WEEKLY_CURVES_BY_CROP. N Applied / N Use / Total N Applied still need
  // the Agworld applications sync (in progress separately) before they can
  // show real numbers, so this tile is left out entirely for a crop with
  // no curve defined yet rather than showing an empty placeholder for
  // something that may never exist for that crop.
  const nRecRow = useMemo(() => {
    const curveRows = field?.cropName ? WEEKLY_CURVES_BY_CROP[field.cropName] : null
    if (!curveRows || weeksSinceEmergence == null) return null
    return curveRows.find((r) => r.week === weeksSinceEmergence) || null
  }, [field, weeksSinceEmergence])

  const cropColor = field?.cropName ? (CROP_COLOR[field.cropName] || { bg: '#D3D1C7', fg: '#2C2C2A' }) : null

  return (
    <div className="agronomy-by-field">
      <div className="agronomy-field-picker">
        <select value={fieldId || ''} onChange={(e) => setFieldId(e.target.value)}>
          {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
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
          <p className="agronomy-kpi-label">Weeks since emergence</p>
          <p className="agronomy-kpi-value">{weeksSinceEmergence != null ? weeksSinceEmergence : '—'}</p>
        </div>
        {nRecRow && (
          <div className="agronomy-kpi-card">
            <p className="agronomy-kpi-label">N Rec (this week)</p>
            <p className="agronomy-kpi-value">
              {nRecRow.nRec != null ? nRecRow.nRec : '—'}
              {nRecRow.nRec != null && <span className="agronomy-kpi-unit"> lbs/ac</span>}
            </p>
            {nRecRow.stage && <p className="agronomy-kpi-date">{nRecRow.stage}</p>}
          </div>
        )}
        {Object.entries(METRICS_BY_TYPE).flatMap(([type, metrics]) =>
          metrics
            .filter((m) => m.target) // no target yet = not "at a glance" actionable; still visible in the sample table below
            .map((m) => {
              const sample = latestByType[type]
              const value = sample?.values?.[m.key]
              const status = statusFor(value, m.target)
              const color = status ? STATUS_COLOR[status] : null
              return (
                <div key={type + m.key} className="agronomy-kpi-card">
                  <p className="agronomy-kpi-label">{SAMPLE_TYPE_LABEL[type]} {m.label}</p>
                  <p className="agronomy-kpi-value">
                    {value != null ? value : '—'}
                    {value != null && <span className="agronomy-kpi-unit"> {m.unit}</span>}
                  </p>
                  {value != null && sample?.receivedDt && (
                    <p className="agronomy-kpi-date">{fmtDate(sample.receivedDt)}</p>
                  )}
                  {status && (
                    <span className="agronomy-status-badge" style={{ background: color.bg, color: color.fg }}>
                      {status}
                    </span>
                  )}
                </div>
              )
            })
        )}
      </div>

      <div className="agronomy-charts">
        {['soil', 'petiole'].map((type) => {
          const typeSamples = samples.filter((s) => s.type === type)
          const metric = METRICS_BY_TYPE[type][0]
          const points = typeSamples
            .filter((s) => s.values?.[metric.key] != null && s.receivedDt && plantDate)
            .map((s) => ({
              x: weeksBetween(s.receivedDt.toDate(), plantDate),
              y: s.values[metric.key]
            }))
            .filter((p) => p.x != null && p.x >= IN_SEASON_WEEK_MIN && p.x <= IN_SEASON_WEEK_MAX)
          const band = buildBand(points, field?.cropName, type === 'soil' ? 'soilNO3' : 'petioleNO3', metric.target)
          return (
            <div key={type} className="agronomy-chart-card">
              <p className="agronomy-chart-title">{SAMPLE_TYPE_LABEL[type]} {metric.label} vs weeks since emergence</p>
              <Sparkline points={points} color={type === 'soil' ? '#0F6E56' : '#3B6D11'} band={band} />
            </div>
          )
        })}
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
                  {Object.entries(annualSoilSample.values || {}).map(([k, v]) => (
                    <div key={k} className="agronomy-annual-value-row">
                      <span>{k}</span><span>{v}</span>
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
                  {METRICS_BY_TYPE.nematode
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
              <td>{Object.entries(s.values || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
