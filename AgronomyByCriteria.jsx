import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, SAMPLE_TYPE_LABEL, statusFor, distanceFromTarget, STATUS_COLOR, CROP_COLOR } from './AgronomyConfig.js'
import ExportExcelButton, { exportFileName, toDateValue } from './AgronomyExport.jsx'

// Compost isn't included here - it identifies a compost source, not a
// field, so "rank fields by their compost value" doesn't apply to it.
// See AgronomyCompostSources.jsx for compost's own by-source view.
const SAMPLE_TYPES = Object.keys(METRICS_BY_TYPE).filter((t) => t !== 'compost')

export default function AgronomyByCriteria({ fields }) {
  const [type, setType] = useState('soil')
  const [metricKey, setMetricKey] = useState(METRICS_BY_TYPE.soil[0].key)
  const [samples, setSamples] = useState([])
  const [error, setError] = useState(null)

  // Some types (nematode especially, with 19 species) have many possible
  // metrics - picking a type resets to that type's first metric, and a
  // second dropdown lets you switch which one to actually rank fields by.
  function handleTypeChange(nextType) {
    setType(nextType)
    setMetricKey(METRICS_BY_TYPE[nextType][0].key)
  }

  useEffect(() => {
    const q = query(collection(db, 'samples'), where('type', '==', type), orderBy('receivedDt', 'desc'))
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
        setSamples(list)
        setError(null)
      },
      (err) => {
        // Without this, a failed query (missing composite index,
        // permissions issue, etc.) looks identical to "genuinely no
        // fields have data yet" - surface it instead. Check the browser
        // console too - Firestore prints a clickable link that
        // auto-creates a missing index.
        console.error('AgronomyByCriteria samples query failed:', err)
        setError(err.message)
      }
    )
    return () => unsub()
  }, [type])

  // Firestore returns newest-first; keeping only the first hit per field
  // gives the latest reading for each one.
  const latestByField = useMemo(() => {
    const next = {}
    samples.forEach((s) => { if (!next[s.fieldId]) next[s.fieldId] = s })
    return next
  }, [samples])

  const metric = METRICS_BY_TYPE[type].find((m) => m.key === metricKey) || METRICS_BY_TYPE[type][0]

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

  // Excel: the ranking as shown, plus every measure of this sample type (each
  // field's latest sample) so the whole panel can be sorted and filtered in Excel.
  function buildExport() {
    const typeLabel = SAMPLE_TYPE_LABEL[type]
    const statusText = (st) => ({ deficient: 'Below range', optimal: 'In range', excess: 'Above range' }[st] || (st || 'No data'))
    const base = (f, sample) => [f.name, f.farmName, f.cropName, f.varietyName, f.acres, sample ? toDateValue(sample.receivedDt) : null]
    const baseHead = ['Field', 'Farm', 'Crop', 'Variety', 'Acres', 'Latest sample date']
    const metrics = METRICS_BY_TYPE[type]
    return {
      filename: exportFileName(`By criteria - ${typeLabel} ${metric.label}`),
      sheets: [
        {
          name: `${typeLabel} ${metric.label}`.slice(0, 31),
          header: [...baseHead, `${metric.label}${metric.unit ? ` (${metric.unit})` : ''}`, 'Target low', 'Target high', 'Status'],
          rows: rows.map(({ field, value, status }) => [
            ...base(field, latestByField[field.id]),
            value, metric.target ? metric.target[0] : null, metric.target ? metric.target[1] : null, statusText(status)
          ])
        },
        {
          name: `All ${typeLabel} values`.slice(0, 31),
          header: [...baseHead, ...metrics.map((m) => `${m.label}${m.unit ? ` (${m.unit})` : ''}`)],
          rows: fields.map((f) => {
            const sample = latestByField[f.id]
            return [...base(f, sample), ...metrics.map((m) => (sample && sample.values ? sample.values[m.key] : null))]
          })
        }
      ]
    }
  }

  return (
    <div className="agronomy-by-criteria">
      <div className="agronomy-type-toggle">
        {SAMPLE_TYPES.map((t) => (
          <button key={t} className={t === type ? 'active' : ''} onClick={() => handleTypeChange(t)}>
            {SAMPLE_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginBottom: '10px' }}>
        {METRICS_BY_TYPE[type].length > 1 && (
          <select value={metricKey} onChange={(e) => setMetricKey(e.target.value)}>
            {METRICS_BY_TYPE[type].map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        )}
        <ExportExcelButton build={buildExport} disabled={!rows.length} />
      </div>

      {error && (
        <p className="agronomy-error-banner">
          Couldn't load samples: {error}. Check the browser console for a Firestore error - it may include a
          link to create a missing index automatically.
        </p>
      )}

      <table className="agronomy-criteria-table">
        <thead>
          <tr>
            <th>Field</th>
            <th>Crop</th>
            <th>{metric.label}{metric.unit ? ` (${metric.unit})` : ''}</th>
            <th>Target</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && (
            <tr><td colSpan={5} className="agronomy-table-empty">No fields to show yet.</td></tr>
          )}
          {rows.map(({ field, value, status }) => {
            const color = status ? STATUS_COLOR[status] : null
            const cropColor = field.cropName ? (CROP_COLOR[field.cropName] || { bg: '#D3D1C7', fg: '#2C2C2A' }) : null
            return (
              <tr key={field.id}>
                <td>{field.name}</td>
                <td>
                  {field.cropName && (
                    <span className="crop-badge" style={{ background: cropColor.bg, color: cropColor.fg }}>
                      {field.cropName}
                    </span>
                  )}
                </td>
                <td>{value != null ? value : '\u2014'}</td>
                <td className="agronomy-target-cell">
                  {metric.target ? `${metric.target[0]}${'\u2013'}${metric.target[1]}` : 'Not set'}
                </td>
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
