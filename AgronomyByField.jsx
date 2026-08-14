import { useEffect, useMemo, useState } from 'react'
import { collection, doc, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, SAMPLE_TYPE_LABEL, statusFor, STATUS_COLOR, SAMPLE_TYPE_BADGE_COLOR } from './agronomyConfig.js'

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
function Sparkline({ points, color }) {
  if (points.length < 2) {
    return <div className="agronomy-chart-empty">Not enough samples yet</div>
  }
  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const minX = Math.min(...xs), maxX = Math.max(...xs)
  const minY = Math.min(...ys), maxY = Math.max(...ys)
  const w = 260, h = 90, pad = 8
  const scaleX = (x) => pad + ((x - minX) / (maxX - minX || 1)) * (w - pad * 2)
  const scaleY = (y) => h - pad - ((y - minY) / (maxY - minY || 1)) * (h - pad * 2)
  const path = points.map((p) => `${scaleX(p.x)},${scaleY(p.y)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="agronomy-sparkline">
      <polyline points={path} fill="none" stroke={color} strokeWidth="2" />
    </svg>
  )
}

export default function AgronomyByField({ fields }) {
  const [fieldId, setFieldId] = useState(null)
  const [samples, setSamples] = useState([])
  const [seasons, setSeasons] = useState([])
  const [seasonData, setSeasonData] = useState(null)

  useEffect(() => {
    if (fields.length && !fieldId) setFieldId(fields[0].id)
  }, [fields, fieldId])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'seasons'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setSeasons(list)
    })
    return () => unsub()
  }, [])

  // Same "does this season's name match the current year" logic used on
  // PublicScheduleView.jsx - falls back to whatever season comes first if
  // nothing matches the current year.
  const currentSeasonId = useMemo(() => {
    const currentYear = String(new Date().getFullYear())
    const match = seasons.find((s) => String(s.name) === currentYear)
    return match ? match.id : (seasons[0] ? seasons[0].id : null)
  }, [seasons])

  useEffect(() => {
    if (!fieldId || !currentSeasonId) { setSeasonData(null); return }
    const unsub = onSnapshot(doc(db, 'fields', fieldId, 'seasons', currentSeasonId), (snap) => {
      setSeasonData(snap.exists() ? snap.data() : null)
    })
    return () => unsub()
  }, [fieldId, currentSeasonId])

  useEffect(() => {
    if (!fieldId) return
    const q = query(collection(db, 'samples'), where('fieldId', '==', fieldId), orderBy('receivedDt', 'asc'))
    const unsub = onSnapshot(q, (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setSamples(list)
    })
    return () => unsub()
  }, [fieldId])

  // seasonData.plantDate comes from Agworld's field_crops.planting_date via
  // syncFields() in functions/index.js - see the file-level note there if
  // this ever comes back null for a field you know has a plant date.
  const plantDate = useMemo(() => {
    return seasonData?.plantDate ? new Date(seasonData.plantDate) : null
  }, [seasonData])

  const weeksSinceEmergence = useMemo(() => weeksBetween(new Date(), plantDate), [plantDate])

  const latestByType = useMemo(() => {
    const next = {}
    samples.forEach((s) => { next[s.type] = s })
    return next
  }, [samples])

  const field = fields.find((f) => f.id === fieldId)

  return (
    <div className="agronomy-by-field">
      <select value={fieldId || ''} onChange={(e) => setFieldId(e.target.value)}>
        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>

      <div className="agronomy-kpi-grid">
        <div className="agronomy-kpi-card">
          <p className="agronomy-kpi-label">Weeks since emergence</p>
          <p className="agronomy-kpi-value">{weeksSinceEmergence != null ? weeksSinceEmergence : '\u2014'}</p>
        </div>
        {Object.entries(METRICS_BY_TYPE).flatMap(([type, metrics]) =>
          metrics.map((m) => {
            const sample = latestByType[type]
            const value = sample?.values?.[m.key]
            const status = statusFor(value, m.target)
            const color = status ? STATUS_COLOR[status] : null
            return (
              <div key={type + m.key} className="agronomy-kpi-card">
                <p className="agronomy-kpi-label">{SAMPLE_TYPE_LABEL[type]} {m.label}</p>
                <p className="agronomy-kpi-value">
                  {value != null ? value : '\u2014'}
                  {value != null && <span className="agronomy-kpi-unit"> {m.unit}</span>}
                </p>
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
              <Sparkline points={points} color={type === 'soil' ? '#0F6E56' : '#3B6D11'} />
            </div>
          )
        })}
      </div>

      <p className="agronomy-section-label">All samples {field ? `\u2014 ${field.name}` : ''}</p>
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
              <td>{Object.entries(s.values || {}).map(([k, v]) => `${k}: ${v}`).join(' \u00b7 ')}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
