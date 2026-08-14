import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, SAMPLE_TYPE_LABEL, statusFor, distanceFromTarget, STATUS_COLOR } from './agronomyConfig.js'

const SAMPLE_TYPES = Object.keys(METRICS_BY_TYPE)

export default function AgronomyByCriteria({ fields }) {
  const [type, setType] = useState('soil')
  const [samples, setSamples] = useState([])

  useEffect(() => {
    const q = query(collection(db, 'samples'), where('type', '==', type), orderBy('receivedDt', 'desc'))
    const unsub = onSnapshot(q, (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setSamples(list)
    })
    return () => unsub()
  }, [type])

  // Firestore returns newest-first; keeping only the first hit per field
  // gives the latest reading for each one.
  const latestByField = useMemo(() => {
    const next = {}
    samples.forEach((s) => { if (!next[s.fieldId]) next[s.fieldId] = s })
    return next
  }, [samples])

  const metric = METRICS_BY_TYPE[type][0]

  const rows = useMemo(() => {
    return fields
      .map((f) => {
        const sample = latestByField[f.id]
        const value = sample?.values?.[metric.key]
        return {
          field: f,
          value,
          status: statusFor(value, metric.target),
          distance: distanceFromTarget(value, metric.target)
        }
      })
      .sort((a, b) => b.distance - a.distance)
  }, [fields, latestByField, metric])

  return (
    <div className="agronomy-by-criteria">
      <div className="agronomy-type-toggle">
        {SAMPLE_TYPES.map((t) => (
          <button key={t} className={t === type ? 'active' : ''} onClick={() => setType(t)}>
            {SAMPLE_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <table className="agronomy-criteria-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>{metric.label} ({metric.unit})</th>
            <th>Target</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={4} className="agronomy-table-empty">No fields to show yet.</td></tr>
          )}
          {rows.map(({ field, value, status }) => {
            const color = status ? STATUS_COLOR[status] : null
            return (
              <tr key={field.id}>
                <td>{field.name}</td>
                <td>{value != null ? value : '\u2014'}</td>
                <td className="agronomy-target-cell">{metric.target[0]}{'\u2013'}{metric.target[1]}</td>
                <td>
                  {status
                    ? <span className="agronomy-status-badge" style={{ background: color.bg, color: color.fg }}>{status}</span>
                    : <span className="agronomy-status-badge agronomy-status-none">no data</span>}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
