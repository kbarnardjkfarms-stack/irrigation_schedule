import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, SAMPLE_TYPE_LABEL, statusFor, STATUS_COLOR, SAMPLE_TYPE_BADGE_COLOR, CROP_COLOR } from './AgronomyConfig.js'

function fmtDate(ts) {
  if (!ts) return ''
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function weeksBetween(laterDate, earlierDate) {
  if (!laterDate || !earlierDate) return null
  const ms = laterDate.getTime() - earlierDate.getTime()
  return Math.floor(ms / (7 * 24 * 60 * 60 * 1000))
}

// Compact hand-rolled line chart, no chart library - matches the rest of the
// app's approach of hand-rolled SVG/table markup rather than a new dependency
// for what's usually a handful of points per season.
//
// `target` (optional [low, high]) draws a shaded reference band behind the
// trend line, matching the high/low lines on the Power BI "N Soil Level" /
// "N Petiole Level" charts, with the band's own numbers labeled on the left
// so "the range" is legible rather than just a faint tint. The band's
// bounds are folded into the y-domain so it's always fully visible even when
// every actual reading sits well above or below it, instead of getting
// clipped off the chart.
//
// The x-axis is weeks since emergence, labeled with a handful of "Wk N"
// ticks along the bottom - points alone (no axis) made it impossible to
// tell which week a reading landed in.
function Sparkline({ points, color, target }) {
  if (points.length < 2) {
    return <div className="agronomy-chart-empty">Not enough samples yet</div>
  }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const allY = target ? [...ys, ...target] : ys
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...allY), maxY = Math.max(...allY)

  const w = 280, h = 120
  const padL = 30, padR = 10, padT = 10, padB = 20
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

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="agronomy-sparkline">
      {target && (
        <>
          <rect
            x={padL}
            y={scaleY(target[1])}
            width={plotW}
            height={Math.max(0, scaleY(target[0]) - scaleY(target[1]))}
            className="agronomy-sparkline-band"
          />
          <text x={padL - 4} y={scaleY(target[1]) + 3} className="agronomy-sparkline-range-label" textAnchor="end">
            {target[1]}
          </text>
          <text x={padL - 4} y={scaleY(target[0]) + 3} className="agronomy-sparkline-range-label" textAnchor="end">
            {target[0]}
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
            .filter((p) => p.x != null)
          return (
            <div key={type} className="agronomy-chart-card">
              <p className="agronomy-chart-title">{SAMPLE_TYPE_LABEL[type]} {metric.label} vs weeks since emergence</p>
              <Sparkline points={points} color={type === 'soil' ? '#0F6E56' : '#3B6D11'} target={metric.target} />
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
