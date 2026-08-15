import { useEffect, useMemo, useState } from 'react'
import { collection, getDocs, limit, onSnapshot, orderBy, query, startAfter, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { SAMPLE_TYPE_LABEL, METRICS_BY_TYPE, CROP_COLOR } from './AgronomyConfig.js'

const SAMPLE_TYPES = Object.keys(METRICS_BY_TYPE)
const PAGE_SIZE = 200

function fmtDate(ts) {
  if (!ts) return ''
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function AgronomySampleDatabase({ fields }) {
  const [type, setType] = useState('soil')
  const [fieldFilter, setFieldFilter] = useState('all')
  const [samples, setSamples] = useState([])
  const [lastDoc, setLastDoc] = useState(null)
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)

  // Same where(type) + orderBy(receivedDt) shape already used in
  // AgronomyByCriteria.jsx, so no new Firestore composite index is
  // needed - reusing a query pattern already proven to work.
  //
  // Only the first page stays live (onSnapshot) - new samples of this
  // type appear automatically. Pages beyond that are a manual one-time
  // fetch (loadMore/getDocs) rather than more live listeners, since
  // keeping many paginated listeners in sync isn't worth the complexity
  // for a browse-everything view like this.
  useEffect(() => {
    setSamples([])
    setLastDoc(null)
    setHasMore(true)
    const q = query(
      collection(db, 'samples'),
      where('type', '==', type),
      orderBy('receivedDt', 'desc'),
      limit(PAGE_SIZE)
    )
    const unsub = onSnapshot(q, (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setSamples(list)
      setLastDoc(snap.docs[snap.docs.length - 1] || null)
      setHasMore(snap.docs.length === PAGE_SIZE)
    })
    return () => unsub()
  }, [type])

  async function loadMore() {
    if (!lastDoc) return
    setLoadingMore(true)
    try {
      const q = query(
        collection(db, 'samples'),
        where('type', '==', type),
        orderBy('receivedDt', 'desc'),
        startAfter(lastDoc),
        limit(PAGE_SIZE)
      )
      const snap = await getDocs(q)
      const more = []
      snap.forEach((d) => more.push({ id: d.id, ...d.data() }))
      setSamples((prev) => [...prev, ...more])
      setLastDoc(snap.docs[snap.docs.length - 1] || lastDoc)
      setHasMore(snap.docs.length === PAGE_SIZE)
    } finally {
      setLoadingMore(false)
    }
  }

  const fieldById = useMemo(() => {
    const map = {}
    fields.forEach((f) => { map[f.id] = f })
    return map
  }, [fields])

  const visibleSamples = useMemo(() => {
    if (fieldFilter === 'all') return samples
    return samples.filter((s) => s.fieldId === fieldFilter)
  }, [samples, fieldFilter])

  return (
    <div className="agronomy-sample-database">
      <div className="agronomy-type-toggle">
        {SAMPLE_TYPES.map((t) => (
          <button key={t} className={t === type ? 'active' : ''} onClick={() => setType(t)}>
            {SAMPLE_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <select value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)}>
        <option value="all">All fields</option>
        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
      </select>

      <table className="agronomy-sample-table">
        <thead>
          <tr><th>Date</th><th>Field</th><th>Crop</th><th>Values</th></tr>
        </thead>
        <tbody>
          {visibleSamples.length === 0 && (
            <tr><td colSpan={4} className="agronomy-table-empty">
              No {SAMPLE_TYPE_LABEL[type].toLowerCase()} samples {fieldFilter === 'all' ? 'yet' : 'for this field yet'}.
            </td></tr>
          )}
          {visibleSamples.map((s) => {
            const field = fieldById[s.fieldId]
            const cropColor = field?.cropName ? (CROP_COLOR[field.cropName] || { bg: '#D3D1C7', fg: '#2C2C2A' }) : null
            return (
              <tr key={s.id}>
                <td>{fmtDate(s.receivedDt)}</td>
                <td>{field?.name || s.rawFieldLabel || '\u2014'}</td>
                <td>
                  {field?.cropName && (
                    <span className="crop-badge" style={{ background: cropColor.bg, color: cropColor.fg }}>
                      {field.cropName}
                    </span>
                  )}
                </td>
                <td>{Object.entries(s.values || {}).map(([k, v]) => `${k}: ${v}`).join(' \u00b7 ')}</td>
              </tr>
            )
          })}
        </tbody>
      </table>

      {hasMore && (
        <button disabled={loadingMore} onClick={loadMore} style={{ marginTop: '10px' }}>
          {loadingMore ? 'Loading\u2026' : 'Load more'}
        </button>
      )}
    </div>
  )
}
