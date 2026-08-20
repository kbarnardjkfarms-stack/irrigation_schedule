import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, orderBy, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE } from './AgronomyConfig.js'

function fmtDate(ts) {
  if (!ts) return ''
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Compost samples never get a fieldId (see the note in mapResultToSample
// in functions/index.js) - rawFieldLabel is what actually holds the
// source name here (a supplier or batch identifier), not a field.
export default function AgronomyCompostSources() {
  const [samples, setSamples] = useState([])
  const [error, setError] = useState(null)
  const [selectedSource, setSelectedSource] = useState(null)

  // Same type + receivedDt shape already indexed for AgronomyByCriteria/
  // AgronomySampleDatabase, so this reuses that composite index rather
  // than needing a new one.
  useEffect(() => {
    const q = query(collection(db, 'samples'), where('type', '==', 'compost'), orderBy('receivedDt', 'desc'))
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
        setSamples(list)
      },
      (err) => {
        console.error('AgronomyCompostSources query failed:', err)
        setError(err.message)
      }
    )
    return () => unsub()
  }, [])

  const sourceNames = useMemo(() => {
    const set = new Set()
    samples.forEach((s) => { if (s.rawFieldLabel) set.add(s.rawFieldLabel) })
    return [...set].sort()
  }, [samples])

  useEffect(() => {
    if (sourceNames.length && !selectedSource) setSelectedSource(sourceNames[0])
  }, [sourceNames, selectedSource])

  const sourceSamples = useMemo(
    () => samples.filter((s) => s.rawFieldLabel === selectedSource),
    [samples, selectedSource]
  )

  // Same dynamic-column approach as AgronomySampleDatabase.jsx - shows
  // whatever keys are actually present, known ones (from
  // AgronomyConfig.js) labeled properly, first.
  const valueColumns = useMemo(() => {
    const seenKeys = new Set()
    sourceSamples.forEach((s) => Object.keys(s.values || {}).forEach((k) => seenKeys.add(k)))
    const configured = (METRICS_BY_TYPE.compost || []).map((m) => m.key).filter((k) => seenKeys.has(k))
    const extra = [...seenKeys].filter((k) => !configured.includes(k)).sort()
    return [...configured, ...extra].map((key) => {
      const metric = (METRICS_BY_TYPE.compost || []).find((m) => m.key === key)
      return { key, label: metric ? metric.label : key, unit: metric ? metric.unit : null }
    })
  }, [sourceSamples])

  return (
    <div className="agronomy-compost-sources">
      {error && (
        <p className="agronomy-error-banner">
          Couldn't load compost samples: {error}. Check the browser console for a Firestore error - it may
          include a link to create a missing index automatically.
        </p>
      )}

      <div className="agronomy-compost-layout">
        <div className="agronomy-compost-source-list">
          <p className="agronomy-section-label">Sources ({sourceNames.length})</p>
          {sourceNames.length === 0 && !error && (
            <p className="agronomy-table-empty">No compost samples yet.</p>
          )}
          {sourceNames.map((name) => (
            <button
              key={name}
              className={selectedSource === name ? 'active' : ''}
              onClick={() => setSelectedSource(name)}
              style={{ display: 'block', width: '100%', textAlign: 'left', marginBottom: '4px' }}
            >
              {name}
            </button>
          ))}
        </div>

        <div className="agronomy-compost-detail">
          <p className="agronomy-section-label">
            {selectedSource || 'Select a source'}
            {selectedSource ? ` \u2014 ${sourceSamples.length} sample${sourceSamples.length === 1 ? '' : 's'}` : ''}
          </p>
          <div className="table-scroll">
            <table className="agronomy-sample-table agronomy-wide-table">
              <thead>
                <tr>
                  <th>Date</th>
                  {valueColumns.map((col) => (
                    <th key={col.key}>{col.label}{col.unit ? ` (${col.unit})` : ''}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sourceSamples.length === 0 && (
                  <tr>
                    <td colSpan={1 + valueColumns.length} className="agronomy-table-empty">
                      No samples for this source yet.
                    </td>
                  </tr>
                )}
                {sourceSamples.map((s) => (
                  <tr key={s.id}>
                    <td>{fmtDate(s.receivedDt)}</td>
                    {valueColumns.map((col) => (
                      <td key={col.key}>{s.values?.[col.key] != null ? s.values[col.key] : '\u2014'}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  )
}
