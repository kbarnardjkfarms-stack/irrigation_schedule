import { Fragment, useEffect, useMemo, useState } from 'react'
import { collection, getDocs, limit, onSnapshot, orderBy, query, startAfter, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import { SAMPLE_TYPE_LABEL, METRICS_BY_TYPE, CROP_COLOR, sortValueKeys } from './AgronomyConfig.js'

const SAMPLE_TYPES = Object.keys(METRICS_BY_TYPE)
const PAGE_SIZE = 200
const SEARCH_PAGE = 1000

// ---------------------------------------------------------------------------
// Spelling-tolerant search. Both sides are folded to capital letters and
// digits only, so "HV-01", "hv 01", "HV01" and "HV_1" all compare equal (a
// wrong dash, a space or a dropped leading zero doesn't matter). On top of
// that a few typos are allowed: about one per four letters typed.
// ---------------------------------------------------------------------------
export function foldText(t) {
  return String(t || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(^|[^0-9])0+(?=[0-9])/g, '$1')
}
// Fewest edits to make `q` appear somewhere inside `t` (approximate substring
// match). Returns 0 for an exact hit.
export function editsToFind(q, t) {
  if (!q) return 0
  if (t.includes(q)) return 0
  const m = q.length
  let pp = null // row before prev, for swapped letters
  let prev = Array.from({ length: m + 1 }, (_, i) => i)
  let best = m
  for (let j = 1; j <= t.length; j++) {
    const cur = [0] // a match may start anywhere in t
    for (let i = 1; i <= m; i++) {
      const cost = q[i - 1] === t[j - 1] ? 0 : 1
      let v = Math.min(prev[i] + 1, cur[i - 1] + 1, prev[i - 1] + cost)
      // swapped letters ("HV10" for "HV01") count as one edit
      if (pp && i > 1 && q[i - 1] === t[j - 2] && q[i - 2] === t[j - 1]) v = Math.min(v, pp[i - 2] + 1)
      cur.push(v)
    }
    if (cur[m] < best) best = cur[m]
    pp = prev
    prev = cur
  }
  return best
}
export const allowedEdits = (q) => (q.length < 3 ? 0 : Math.max(1, Math.floor(q.length / 4)))
// Score a sample against the typed words: null = no match, 0 = exact, higher = looser.
export function matchScore(words, haystacks) {
  let total = 0
  for (const w of words) {
    let best = Infinity
    for (const h of haystacks) { const d = editsToFind(w, h); if (d < best) best = d; if (!best) break }
    if (best > allowedEdits(w)) return null
    total += best
  }
  return total
}

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

const TYPE_NAME = { SO: 'soil', PL: 'petiole', NEMA: 'nematode', CM: 'compost' }
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fmtDay = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })

// Asks Stukenholtz again for every sample received in a date range and saves
// any AIO doesn't have (recheckStukenholtzRange Cloud Function). The lab's
// API only hands back 1,000 results per call, so a busy stretch could get
// cut off; this re-check goes a few days at a time so nothing is skipped.
function RecheckStukenholtz() {
  const [open, setOpen] = useState(false)
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 30 * 86400000)))
  const [to, setTo] = useState(() => isoDay(new Date()))
  const [busy, setBusy] = useState(false)
  const [res, setRes] = useState(null)
  // The function stops after ~4 minutes and says how far it got; keep
  // calling from there until the whole range is done, adding up the counts.
  const [progress, setProgress] = useState(null)
  async function go() {
    setBusy(true); setRes(null); setProgress(null)
    const call = httpsCallable(functions, 'recheckStukenholtzRange', { timeout: 540000 })
    const end = `${to}T23:59:59`
    let start = `${from}T00:00:00`
    const sum = { fetched: 0, added: 0, unmapped: 0, byType: {}, stillCapped: [], errors: [] }
    try {
      for (let round = 0; round < 30; round++) {
        const r = (await call({ from: start, to: end })).data
        sum.fetched += r.fetched || 0; sum.added += r.added || 0; sum.unmapped += r.unmapped || 0
        Object.entries(r.byType || {}).forEach(([k, v]) => { sum.byType[k] = (sum.byType[k] || 0) + v })
        sum.stillCapped.push(...(r.stillCapped || [])); sum.errors.push(...(r.errors || []))
        sum.checkedThrough = r.checkedThrough
        if (!r.timedOut || !r.checkedThrough || r.checkedThrough >= new Date(end).toISOString()) break
        start = r.checkedThrough
        setProgress(`Checked through ${fmtDay(r.checkedThrough)} so far — ${sum.added} missing found…`)
      }
      setRes({ ok: true, r: sum })
    } catch (e) {
      const partial = sum.checkedThrough ? ` (it had checked through ${fmtDay(sum.checkedThrough)} and saved ${sum.added} missing before this)` : ''
      setRes({ ok: false, text: (e.code === 'functions/not-found' ? 'The re-check isn’t deployed yet — it goes out with the Cloud Functions upload.' : (e.message || String(e))) + partial })
    } finally { setBusy(false); setProgress(null) }
  }
  if (!open) return <button onClick={() => setOpen(true)} title="Ask Stukenholtz again for a date range and add any samples that are missing">Re-check Stukenholtz…</button>
  const r = res && res.ok ? res.r : null
  return (
    <div className="agronomy-recheck">
      <div><strong>Re-check Stukenholtz</strong> — asks the lab again for every sample <em>received</em> in these dates and adds any AIO is missing. Nothing already here is changed or duplicated.</div>
      <div className="agronomy-filter-bar" style={{ margin: '8px 0 0' }}>
        <label>From <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To <input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <button className="save" disabled={busy || !from || !to || to < from} onClick={go}>{busy ? 'Checking… (can take a few minutes)' : 'Re-check'}</button>
        {progress && <span className="agronomy-search-status">{progress}</span>}
        <button disabled={busy} onClick={() => { setOpen(false); setRes(null) }}>Close</button>
      </div>
      {res && !res.ok && <div className="agronomy-error-banner" style={{ margin: '8px 0 0' }}>{res.text}</div>}
      {r && (
        <div className={r.added ? 'yields-ok' : 'agronomy-recheck-result'}>
          Stukenholtz has {r.fetched.toLocaleString()} sample{r.fetched === 1 ? '' : 's'} received {fmtDay(`${from}T12:00:00`)} – {fmtDay(`${to}T12:00:00`)}
          {' '}({Object.entries(r.byType).filter(([, v]) => v).map(([k, v]) => `${v.toLocaleString()} ${TYPE_NAME[k] || k}`).join(', ') || 'none'}).
          {' '}<strong>{r.added ? `${r.added.toLocaleString()} were missing and are now saved.` : 'AIO already had all of them.'}</strong>
          {r.unmapped > 0 && ` ${r.unmapped} couldn’t be matched to a field — see Field mapping.`}
          {r.stillCapped && r.stillCapped.length > 0 && ` ${r.stillCapped.length} one-hour stretch(es) still hit the lab’s 1,000 limit — tell Claude.`}
          {r.errors && r.errors.length > 0 && <div style={{ marginTop: 6, color: '#A32D2D' }}>{r.errors.length} stretch{r.errors.length === 1 ? '' : 'es'} couldn’t be read from Stukenholtz and {r.errors.length === 1 ? 'was' : 'were'} skipped ({fmtDay(r.errors[0].from)}: {r.errors[0].message}). Press Re-check again to retry.</div>}
        </div>
      )}
    </div>
  )
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
  // Searching looks through every sample of this type (in the date range),
  // not just the loaded pages: fetched once, kept for the session.
  const [allCache, setAllCache] = useState({ key: null, list: null, loading: false, error: null })

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

  const searching = searchText.trim().length > 0
  const cacheKey = `${type}|${sinceDate}|${untilDate}`
  useEffect(() => {
    if (!searching || allCache.key === cacheKey) return undefined
    let dead = false
    setAllCache({ key: cacheKey, list: null, loading: true, error: null })
    ;(async () => {
      try {
        const out = []
        let after = null
        for (let guard = 0; guard < 200; guard++) {
          const parts = [collection(db, 'samples'), ...buildConstraints()]
          if (after) parts.push(startAfter(after))
          parts.push(limit(SEARCH_PAGE))
          const snap = await getDocs(query(...parts))
          snap.forEach((d) => out.push({ id: d.id, ...d.data() }))
          if (dead) return
          setAllCache((c) => (c.key === cacheKey ? { ...c, list: [...out], loading: snap.docs.length === SEARCH_PAGE } : c))
          if (snap.docs.length < SEARCH_PAGE) break
          after = snap.docs[snap.docs.length - 1]
        }
      } catch (err) {
        if (!dead) setAllCache({ key: cacheKey, list: null, loading: false, error: err.message })
      }
    })()
    return () => { dead = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching, cacheKey])
  // A new live sample arriving on page one shouldn't be missing from search.
  const searchBase = useMemo(() => {
    if (!searching || allCache.key !== cacheKey || !allCache.list) return samples
    const ids = new Set(allCache.list.map((x) => x.id))
    return [...samples.filter((x) => !ids.has(x.id)), ...allCache.list]
  }, [searching, allCache, cacheKey, samples])

  const fieldById = useMemo(() => {
    const map = {}
    fields.forEach((f) => { map[f.id] = f })
    return map
  }, [fields])

  const visibleSamples = useMemo(() => {
    const words = searchText.trim().split(/\s+/).map(foldText).filter(Boolean)
    const out = []
    searchBase.forEach((s) => {
      if (fieldFilter !== 'all' && s.fieldId !== fieldFilter) return
      if (matchTypeFilter) {
        if (matchTypeFilter === 'unmapped' ? s.fieldMatchType : s.fieldMatchType !== matchTypeFilter) return
      }
      if (words.length) {
        const field = fieldById[s.fieldId]
        const hay = [field?.name, field?.farmName, field?.cropName, s.rawFieldLabel, s.id].filter(Boolean).map(foldText)
        const score = matchScore(words, hay)
        if (score == null) return
        out.push(score ? { ...s, _fuzzy: score } : s)
        return
      }
      out.push(s)
    })
    return out
  }, [searchBase, fieldFilter, matchTypeFilter, searchText, fieldById])
  const fuzzyCount = visibleSamples.filter((s) => s._fuzzy).length

  // Columns come from whatever value keys are actually present in the
  // currently loaded samples - known/labeled metrics (from
  // AgronomyConfig.js) come first in their defined order, then any other
  // key Stukenholtz sent that isn't formally mapped yet, alphabetically.
  const valueColumns = useMemo(() => {
    const seenKeys = new Set()
    visibleSamples.forEach((s) => Object.keys(s.values || {}).forEach((k) => seenKeys.add(k)))
    const configured = (METRICS_BY_TYPE[type] || []).map((m) => m.key).filter((k) => seenKeys.has(k))
    const extra = [...seenKeys].filter((k) => !configured.includes(k)).sort()
    return sortValueKeys(type, [...configured, ...extra]).map((key) => {
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

  // Without search text this sorts what's loaded (page one plus Load more).
  // With search text it works on every sample of this type in the date
  // range (fetched once, above) - Firestore can't do free-text or
  // spelling-tolerant search itself, so it's done here.
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

  // null = default order (whatever valueColumns naturally computes to).
  // Once reordered, this holds the person's chosen key order; new keys
  // that show up later (e.g. a fuller panel appears in newly loaded data)
  // get appended at the end rather than disrupting the custom order.
  const [columnOrder, setColumnOrder] = useState(null)

  const orderedColumns = useMemo(() => {
    if (!columnOrder) return valueColumns
    const byKey = Object.fromEntries(valueColumns.map((c) => [c.key, c]))
    const ordered = columnOrder.filter((k) => byKey[k]).map((k) => byKey[k])
    const orderedKeys = new Set(columnOrder)
    const remaining = valueColumns.filter((c) => !orderedKeys.has(c.key))
    return [...ordered, ...remaining]
  }, [valueColumns, columnOrder])

  function moveColumn(key, direction) {
    setColumnOrder((prev) => {
      const base = prev || orderedColumns.map((c) => c.key)
      const idx = base.indexOf(key)
      if (idx === -1) return base
      const newIdx = idx + direction
      if (newIdx < 0 || newIdx >= base.length) return base
      const next = [...base]
      ;[next[idx], next[newIdx]] = [next[newIdx], next[idx]]
      return next
    })
  }

  // null = show all columns (default). Once the person toggles anything,
  // this becomes a real Set and only those columns show. Reset whenever
  // the type changes, so a column selection made while looking at
  // Nematode's 19 columns doesn't carry over and quietly hide everything
  // when switching back to Soil's 2.
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(null)
  const [columnPickerOpen, setColumnPickerOpen] = useState(false)
  useEffect(() => { setVisibleColumnKeys(null); setColumnOrder(null); setColumnPickerOpen(false) }, [type])

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
    if (!visibleColumnKeys) return orderedColumns
    return orderedColumns.filter((c) => visibleColumnKeys.has(c.key))
  }, [orderedColumns, visibleColumnKeys])

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
          placeholder="Search all samples: field, farm, crop, lab label…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          className="agronomy-search-input"
        />
        {searching && (
          <span className="agronomy-search-status">
            {allCache.error ? `Couldn’t search everything (${allCache.error}) — showing loaded samples only`
              : allCache.loading ? `Searching all ${SAMPLE_TYPE_LABEL[type].toLowerCase()} samples… ${allCache.list ? allCache.list.length.toLocaleString() : 0} so far`
                : `${visibleSamples.length.toLocaleString()} of ${searchBase.length.toLocaleString()} ${SAMPLE_TYPE_LABEL[type].toLowerCase()} samples${fuzzyCount ? ` · ${fuzzyCount} close match${fuzzyCount === 1 ? '' : 'es'}` : ''}`}
          </span>
        )}
        <RecheckStukenholtz />
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
                  <button onClick={() => setColumnOrder(null)}>Reset order</button>
                </div>
                {orderedColumns.map((col, i) => (
                  <div key={col.key} className="agronomy-column-picker-row">
                    <label>
                      <input
                        type="checkbox"
                        checked={!visibleColumnKeys || visibleColumnKeys.has(col.key)}
                        onChange={() => toggleColumn(col.key)}
                      />
                      {col.label}
                    </label>
                    <span className="agronomy-column-picker-move">
                      <button
                        disabled={i === 0}
                        onClick={() => moveColumn(col.key, -1)}
                        title="Move earlier"
                      >
                        {'\u2191'}
                      </button>
                      <button
                        disabled={i === orderedColumns.length - 1}
                        onClick={() => moveColumn(col.key, 1)}
                        title="Move later"
                      >
                        {'\u2193'}
                      </button>
                    </span>
                  </div>
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
                    <td>
                      {field?.name || s.rawFieldLabel || '\u2014'}
                      {s._fuzzy ? <span className="agronomy-fuzzy-tag" title="Close match — spelled a little differently from what you typed">close match</span> : null}
                    </td>
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

      {hasMore && !searching && (
        <button disabled={loadingMore} onClick={loadMore} style={{ marginTop: '10px' }}>
          {loadingMore ? 'Loading\u2026' : 'Load more'}
        </button>
      )}
    </div>
  )
}
