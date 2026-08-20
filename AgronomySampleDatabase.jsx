import { Fragment, useEffect, useMemo, useState } from 'react'
import { collection, getDocs, limit, onSnapshot, orderBy, query, startAfter, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { SAMPLE_TYPE_LABEL, METRICS_BY_TYPE, CROP_COLOR } from './AgronomyConfig.js'

const SAMPLE_TYPES = Object.keys(METRICS_BY_TYPE)
const PAGE_SIZE = 200

const MATCH_TYPE_OPTIONS = [
  { value: '', label: 'Any match status' },
  { value: 'exact', label: 'Exact match' },
  { value: 'fuzzy', label: 'Fuzzy match' },
  { value: 'manual', label: 'Manually confirmed' },
  { value: 'unmapped', label: 'Unmapped' }
]

function fmtDate(ts) {
  if (!ts) return ''
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function SortArrow({ active, dir }) {
  if (!active) return null
  return <span style={{ marginLeft: '4px' }}>{dir === 'asc' ? '\u25b2' : '\u25bc'}</span>
}

export default function AgronomySampleDatabase({ fields }) {
  const [type, setType] = useState('soil')
  const [fieldFilter, setFieldFilter] = useState('all')
  const [matchTypeFilter, setMatchTypeFilter] = useState('')
  const [searchText, setSearchText] = useState('')
  const [sinceDate, setSinceDate] = useState('')
  const [untilDate, setUntilDate] = useState('')
  const [samples, setSamples] = useState([])
  const [lastDoc, setLastDoc] = useState(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const [sortColumn, setSortColumn] = useState('receivedDt')
  const [sortDir, setSortDir] = useState('desc')
  const [expandedId, setExpandedId] = useState(null)

  // Builds the shared where()/orderBy() clauses for both the live first
  // page and loadMore. sinceDate/untilDate are range filters on the same
  // receivedDt field already covered by the type+receivedDt composite
  // index - Firestore allows range filters on whichever field is being
  // ordered on without needing a separate index for it, so this doesn't
  // require creating anything new.
  function buildConstraints() {
    const constraints = [where('type', '==', type)]
    if (sinceDate) constraints.push(where('receivedDt', '>=', new Date(sinceDate)))
    if (untilDate) constraints.push(where('receivedDt', '<=', new Date(untilDate + 'T23:59:59.999')))
    constraints.push(orderBy('receivedDt', 'desc'))
    return constraints
  }

  // Only the first page stays live (onSnapshot) - new samples of this
  // type appear automatically. Pages beyond that are a manual one-time
  // fetch (loadMore/getDocs) rather than more live listeners, since
  // keeping many paginated listeners in sync isn't worth the complexity
  // for a browse-everything view like this.
  useEffect(() => {
    setSamples([])
    setLastDoc(null)
    setHasMore(false)
    setError(null)
    setExpandedId(null)
    const q = query(collection(db, 'samples'), ...buildConstraints(), limit(PAGE_SIZE))
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
        setSamples(list)
        setLastDoc(snap.docs[snap.docs.length - 1] || null)
        setHasMore(snap.docs.length === PAGE_SIZE)
      },
      (err) => {
        console.error('AgronomySampleDatabase samples query failed:', err)
        setError(err.message)
      }
    )
    return () => unsub()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, sinceDate, untilDate])

  async function loadMore() {
    if (!lastDoc) return
    setLoadingMore(true)
    try {
      const q = query(collection(db, 'samples'), ...buildConstraints(), startAfter(lastDoc), limit(PAGE_SIZE))
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
    const search = searchText.trim().toLowerCase()
    return samples.filter((s) => {
      if (fieldFilter !== 'all' && s.fieldId !== fieldFilter) return false
      if (matchTypeFilter) {
        if (matchTypeFilter === 'unmapped' ? s.fieldMatchType : s.fieldMatchType !== matchTypeFilter) return false
      }
      if (search) {
        const field = fieldById[s.fieldId]
        const haystack = [field?.name, field?.cropName, s.rawFieldLabel].filter(Boolean).join(' ').toLowerCase()
        if (!haystack.includes(search)) return false
      }
      return true
    })
  }, [samples, fieldFilter, matchTypeFilter, searchText, fieldById])

  // Columns come from whatever value keys are actually present in the
  // currently loaded samples - known/labeled metrics (from
  // AgronomyConfig.js) come first in their defined order, then any other
  // key Stukenholtz sent that isn't formally mapped yet, alphabetically.
  const valueColumns = useMemo(() => {
    const seenKeys = new Set()
    visibleSamples.forEach((s) => Object.keys(s.values || {}).forEach((k) => seenKeys.add(k)))
    const configured = (METRICS_BY_TYPE[type] || []).map((m) => m.key).filter((k) => seenKeys.has(k))
    const extra = [...seenKeys].filter((k) => !configured.includes(k)).sort()
    return [...configured, ...extra].map((key) => {
      const metric = (METRICS_BY_TYPE[type] || []).find((m) => m.key === key)
      return { key, label: metric ? metric.label : key, unit: metric ? metric.unit : null }
    })
  }, [visibleSamples, type])

  function handleSort(columnKey) {
    if (sortColumn === columnKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortColumn(columnKey)
      setSortDir('asc')
    }
  }

  // Sorts/searches only what's currently loaded (this page, plus
  // anything pulled in via Load more) - the date range above is a real
  // server-side query bound, but search text, match status, and sorting
  // by a value column all operate on the loaded set, since Firestore
  // can't do free-text search or sort by an arbitrary nested field
  // without a dedicated index per metric. Load more first if you want to
  // search/sort across full history rather than just the loaded page(s).
  const sortedSamples = useMemo(() => {
    const list = [...visibleSamples]
    function getValue(s) {
      if (sortColumn === 'receivedDt') return s.receivedDt ? s.receivedDt.toMillis() : null
      if (sortColumn === 'field') return fieldById[s.fieldId]?.name || s.rawFieldLabel || ''
      if (sortColumn === 'crop') return fieldById[s.fieldId]?.cropName || ''
      return s.values ? s.values[sortColumn] : null
    }
    list.sort((a, b) => {
      const av = getValue(a)
      const bv = getValue(b)
      if (av == null && bv == null) return 0
      if (av == null) return 1
      if (bv == null) return -1
      if (typeof av === 'number' && typeof bv === 'number') {
        return sortDir === 'asc' ? av - bv : bv - av
      }
      const strA = String(av), strB = String(bv)
      return sortDir === 'asc' ? strA.localeCompare(strB) : strB.localeCompare(strA)
    })
    return list
  }, [visibleSamples, sortColumn, sortDir, fieldById])

  // null = show all columns (default). Once the person toggles anything,
  // this becomes a real Set and only those columns show. Reset whenever
  // the type changes, so a column selection made while looking at
  // Nematode's 19 columns doesn't carry over and quietly hide everything
  // when switching back to Soil's 2.
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(null)
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)
  useEffect(() => { setVisibleColumnKeys(null); setColumnPickerOpen(false) }, [type])

  function toggleColumn(key) {
    setVisibleColumnKeys((prev) => {
      const base = prev || new Set(valueColumns.map((c) => c.key))
      const next = new Set(base)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  const displayedColumns = useMemo(() => {
    if (!visibleColumnKeys) return valueColumns
    return valueColumns.filter((c) => visibleColumnKeys.has(c.key))
  }, [valueColumns, visibleColumnKeys])

  const totalColumns = 3 + displayedColumns.length

  return (
    <div className="agronomy-sample-database">
      <div className="agronomy-type-toggle">
        {SAMPLE_TYPES.map((t) => (
          <button key={t} className={t === type ? 'active' : ''} onClick={() => setType(t)}>
            {SAMPLE_TYPE_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="agronomy-filter-bar">
        <select value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)}>
          <option value="all">All fields</option>
          {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        <select value={matchTypeFilter} onChange={(e) => setMatchTypeFilter(e.target.value)}>
          {MATCH_TYPE_OPTIONS.map((opt) => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
        </select>
        <input
          type="date"
          value={sinceDate}
          onChange={(e) => setSinceDate(e.target.value)}
          title="Since date"
        />
        <input
          type="date"
          value={untilDate}
          onChange={(e) => setUntilDate(e.target.value)}
          title="Until date"
        />
        <input
          type="text"
          placeholder="Search field, crop, or lab label..."
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="agronomy-search-input"
        />
        {valueColumns.length > 1 && (
          <div style={{ position: 'relative' }}>
            <button onClick={() => setColumnPickerOpen((o) => !o)}>
              Columns ({displayedColumns.length}/{valueColumns.length})
            </button>
            {columnPickerOpen && (
              <div className="agronomy-column-picker">
                <div className="agronomy-column-picker-actions">
                  <button onClick={() => setVisibleColumnKeys(new Set(valueColumns.map((c) => c.key)))}>All</button>
                  <button onClick={() => setVisibleColumnKeys(new Set())}>None</button>
                </div>
                {valueColumns.map((col) => (
                  <label key={col.key}>
                    <input
                      type="checkbox"
                      checked={!visibleColumnKeys || visibleColumnKeys.has(col.key)}
                      onChange={() => toggleColumn(col.key)}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="agronomy-error-banner">
          Couldn't load samples: {error}. Check the browser console for a Firestore error - it may include a
          link to create a missing index automatically.
        </p>
      )}

      <div className="table-scroll">
        <table className="agronomy-sample-table agronomy-wide-table">
          <thead>
            <tr>
              <th className="agronomy-sortable" onClick={() => handleSort('receivedDt')}>
                Date<SortArrow active={sortColumn === 'receivedDt'} dir={sortDir} />
              </th>
              <th className="agronomy-sortable" onClick={() => handleSort('field')}>
                Field<SortArrow active={sortColumn === 'field'} dir={sortDir} />
              </th>
              <th className="agronomy-sortable" onClick={() => handleSort('crop')}>
                Crop<SortArrow active={sortColumn === 'crop'} dir={sortDir} />
              </th>
              {displayedColumns.map((col) => (
                <th key={col.key} className="agronomy-sortable" onClick={() => handleSort(col.key)}>
                  {col.label}{col.unit ? ` (${col.unit})` : ''}
                  <SortArrow active={sortColumn === col.key} dir={sortDir} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedSamples.length === 0 && !error && (
              <tr><td colSpan={totalColumns} className="agronomy-table-empty">
                No {SAMPLE_TYPE_LABEL[type].toLowerCase()} samples match the current filters.
              </td></tr>
            )}
            {sortedSamples.map((s) => {
              const field = fieldById[s.fieldId]
              const cropColor = field?.cropName ? (CROP_COLOR[field.cropName] || { bg: '#D3D1C7', fg: '#2C2C2A' }) : null
              const isExpanded = expandedId === s.id
              return (
                <Fragment key={s.id}>
                  <tr className="agronomy-clickable-row" onClick={() => setExpandedId(isExpanded ? null : s.id)}>
                    <td>{fmtDate(s.receivedDt)}</td>
                    <td>{field?.name || s.rawFieldLabel || '\u2014'}</td>
                    <td>
                      {field?.cropName && (
                        <span className="crop-badge" style={{ background: cropColor.bg, color: cropColor.fg }}>
                          {field.cropName}
                        </span>
                      )}
                    </td>
                    {displayedColumns.map((col) => (
                      <td key={col.key}>{s.values?.[col.key] != null ? s.values[col.key] : '\u2014'}</td>
                    ))}
                  </tr>
                  {isExpanded && (
                    <tr className="agronomy-detail-row">
                      <td colSpan={totalColumns}>
                        <div className="agronomy-detail-content">
                          <div><strong>Field label from lab:</strong> {s.rawFieldLabel || '\u2014'}</div>
                          <div><strong>Match type:</strong> {s.fieldMatchType || 'unmapped'}</div>
                          <div><strong>Report ID:</strong> {s.id}</div>
                          {valueColumns.map((col) => (
                            <div key={col.key}>
                              <strong>{col.label}:</strong>{' '}
                              {s.values?.[col.key] != null ? s.values[col.key] : '\u2014'}
                              {col.unit ? ` ${col.unit}` : ''}
                            </div>
                          ))}
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <button disabled={loadingMore} onClick={loadMore} style={{ marginTop: '10px' }}>
          {loadingMore ? 'Loading\u2026' : 'Load more'}
        </button>
      )}
    </div>
  )
}
