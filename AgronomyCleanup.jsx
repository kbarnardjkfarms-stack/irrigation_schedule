import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, getDocs, limit, onSnapshot, orderBy, query, startAfter, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import { SAMPLE_TYPE_LABEL, SAMPLE_TYPE_BADGE_COLOR } from './AgronomyConfig.js'

// Assumes firebase.js exports `functions` the same way it already
// exports `db` and `auth` - Users.jsx must already be doing this
// somewhere, since createUser/setUserDisabled/generateSetupLink are
// callable functions too. If firebase.js doesn't export `functions` yet,
// add: `export const functions = getFunctions(app)` there, matching
// however `auth`/`db` are set up.
const reassignSampleField = httpsCallable(functions, 'reassignSampleField')
// Scanning every unmapped sample can take a while on a big backlog, so this
// one gets the full 9 minutes the function itself is allowed instead of the
// SDK's default 70 seconds.
const rematchUnmappedSamples = httpsCallable(functions, 'rematchUnmappedSamples', { timeout: 540000 })

function fmtDate(ts) {
  if (!ts) return ''
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

const PAGE_SIZE = 100

// The original version of this screen loaded the ENTIRE unmapped/fuzzy
// sample lists in one unbounded onSnapshot query and rendered every one of
// them as a table row with a full field-select dropdown. That's fine with a
// handful of rows, but once either list grows into the hundreds it freezes
// the tab outright (too much DOM + too many listeners for a single
// `<select>`-per-row render to keep up with) - with no console error at
// all, since it's not a thrown exception, just the browser falling behind.
//
// This hook keeps a live listener only on the first page (so new
// unmapped/fuzzy samples still show up without a refresh) and fetches
// further pages on demand via loadMore(), which is enough to never render
// more than PAGE_SIZE rows at once no matter how large the backlog gets.
//
// NOTE: orderBy('receivedDt') alongside an equality filter on a different
// field needs a Firestore composite index. If this throws a
// "failed-precondition" error in the console, it'll include a link that
// creates the missing index automatically - click it, wait a minute or two
// for the index to build, then reload.
function usePaginatedSampleQuery(whereField, whereValue, excludeCompost) {
  const [items, setItems] = useState([])
  const [hasMore, setHasMore] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(null)
  const lastDocRef = useRef(null)

  useEffect(() => {
    lastDocRef.current = null
    setItems([])
    setHasMore(true)
    setError(null)
    const q = query(
      collection(db, 'samples'),
      where(whereField, '==', whereValue),
      orderBy('receivedDt', 'desc'),
      limit(PAGE_SIZE)
    )
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => {
          const data = d.data()
          // Compost samples identify a source, not a field - fieldId is
          // always null for them by design (see mapResultToSample in
          // functions/index.js), so they'd otherwise sit here forever as
          // unresolvable noise. Not a cleanup task; excluded on purpose.
          if (excludeCompost && data.type === 'compost') return
          list.push({ id: d.id, ...data })
        })
        setItems(list)
        lastDocRef.current = snap.docs[snap.docs.length - 1] || null
        setHasMore(snap.docs.length === PAGE_SIZE)
      },
      (err) => {
        console.error(`AgronomyCleanup query failed (${whereField} == ${whereValue}):`, err)
        setError(err.message)
      }
    )
    return () => unsub()
  }, [whereField, whereValue, excludeCompost])

  async function loadMore() {
    if (!lastDocRef.current || loadingMore) return
    setLoadingMore(true)
    try {
      const q = query(
        collection(db, 'samples'),
        where(whereField, '==', whereValue),
        orderBy('receivedDt', 'desc'),
        startAfter(lastDocRef.current),
        limit(PAGE_SIZE)
      )
      const snap = await getDocs(q)
      const list = []
      snap.forEach((d) => {
        const data = d.data()
        if (excludeCompost && data.type === 'compost') return
        list.push({ id: d.id, ...data })
      })
      setItems((prev) => [...prev, ...list])
      lastDocRef.current = snap.docs[snap.docs.length - 1] || lastDocRef.current
      setHasMore(snap.docs.length === PAGE_SIZE)
    } catch (err) {
      console.error(`AgronomyCleanup loadMore failed (${whereField} == ${whereValue}):`, err)
      setError(err.message)
    } finally {
      setLoadingMore(false)
    }
  }

  // Optimistic local removal right after a successful reassign, instead of
  // waiting for the live listener to catch up (the listener only covers
  // page 1 anyway - a row from page 2+ would never disappear on its own).
  function removeItem(id) {
    setItems((prev) => prev.filter((item) => item.id !== id))
  }

  return { items, hasMore, loadingMore, loadMore, removeItem, error }
}

export default function AgronomyCleanup({ fields }) {
  const unmapped = usePaginatedSampleQuery('fieldId', null, true)
  const fuzzy = usePaginatedSampleQuery('fieldMatchType', 'fuzzy', false)
  const [savingId, setSavingId] = useState(null)

  // Smart auto-match panel: preview what the matcher would link at a given
  // confidence, then apply it. Preview never writes anything.
  const [minScore, setMinScore] = useState('0.9')
  const [matchBusy, setMatchBusy] = useState(false)
  const [matchResult, setMatchResult] = useState(null)
  const [matchError, setMatchError] = useState(null)
  const [confirmingAll, setConfirmingAll] = useState(false)

  async function runMatch(apply) {
    setMatchBusy(true)
    setMatchError(null)
    try {
      const res = await rematchUnmappedSamples({ apply, minScore: Number(minScore) })
      setMatchResult(res.data)
    } catch (err) {
      console.error('rematchUnmappedSamples failed:', err)
      setMatchError(err.message || 'Auto-match failed.')
    } finally {
      setMatchBusy(false)
    }
  }

  // Confirms every suggested match currently on screen (one page, at most
  // PAGE_SIZE) - same per-sample call as the individual Confirm button.
  async function confirmAllShown() {
    if (!window.confirm(`Confirm all ${fuzzy.items.length} suggested matches shown?`)) return
    setConfirmingAll(true)
    const batch = [...fuzzy.items]
    try {
      for (let i = 0; i < batch.length; i += 10) {
        await Promise.all(
          batch.slice(i, i + 10).map((s) =>
            reassignSampleField({ sampleId: s.id, fieldId: s.fieldId }).then(() => fuzzy.removeItem(s.id))
          )
        )
      }
    } catch (err) {
      console.error('confirm all failed:', err)
      window.alert('Some matches could not be confirmed - try again.')
    } finally {
      setConfirmingAll(false)
    }
  }

  const fieldNameById = useMemo(() => {
    const map = {}
    fields.forEach((f) => { map[f.id] = f.name })
    return map
  }, [fields])

  async function handleAssign(sampleId, fieldId, removeFn) {
    setSavingId(sampleId)
    try {
      await reassignSampleField({ sampleId, fieldId: fieldId || null })
      removeFn(sampleId)
    } catch (err) {
      console.error('reassignSampleField failed:', err)
      window.alert('Could not save that change - try again.')
    } finally {
      setSavingId(null)
    }
  }

  function TypeBadge({ type }) {
    const color = SAMPLE_TYPE_BADGE_COLOR[type]
    return (
      <span
        className="agronomy-type-badge"
        style={color ? { background: color.bg, color: color.fg } : undefined}
      >
        {SAMPLE_TYPE_LABEL[type] || type || '—'}
      </span>
    )
  }

  return (
    <div className="agronomy-cleanup">
      {(unmapped.error || fuzzy.error) && (
        <p className="agronomy-error-banner">
          Couldn't load one of the cleanup lists: {unmapped.error || fuzzy.error}. Check the browser console -
          if it's a missing-index error it'll include a link that creates the index automatically.
        </p>
      )}

      <p className="agronomy-section-label">Smart auto-match</p>
      <div className="agronomy-automatch">
        <div className="agronomy-automatch-controls">
          <label>
            Link when at least{' '}
            <select value={minScore} onChange={(e) => { setMinScore(e.target.value); setMatchResult(null) }}>
              <option value="0.95">95% alike</option>
              <option value="0.9">90% alike</option>
              <option value="0.85">85% alike</option>
              <option value="0.8">80% alike</option>
            </select>
          </label>
          <button disabled={matchBusy} onClick={() => runMatch(false)}>
            {matchBusy ? 'Working...' : 'Preview'}
          </button>
          {matchResult && !matchResult.applied && matchResult.linkableSamples > 0 && (
            <button disabled={matchBusy} onClick={() => runMatch(true)}>
              Link {matchResult.linkableSamples} samples
            </button>
          )}
        </div>
        <p className="agronomy-targets-hint">
          Ignores words like "soil" and years, treats "SOUTH" and "S" as the same, forgives typos, and never links
          when a direction or number differs (WILSON N will not match WILSON S).
        </p>
        {matchError && <p className="agronomy-error-banner">{matchError}</p>}
        {matchResult && (
          <>
            <p className="agronomy-automatch-summary">
              {matchResult.applied
                ? `Linked ${matchResult.linkedSamples} samples. `
                : ''}
              {matchResult.totalUnmappedSamples} unmapped samples under {matchResult.uniqueLabels} different labels;{' '}
              {matchResult.applied
                ? 'the rest still need a manual pick below.'
                : `${matchResult.linkableLabels} labels (${matchResult.linkableSamples} samples) clear ${Math.round(matchResult.threshold * 100)}%.`}
            </p>
            {matchResult.rows.length > 0 && (
              <div className="agronomy-automatch-table-wrap">
                <table className="agronomy-cleanup-table">
                  <thead>
                    <tr><th>Lab label</th><th>Samples</th><th>Best match</th><th>Alike</th><th>Runner-up</th><th></th></tr>
                  </thead>
                  <tbody>
                    {matchResult.rows.map((r, i) => (
                      <tr key={i}>
                        <td>{r.label}</td>
                        <td>{r.sampleCount}</td>
                        <td>{r.fieldName || '\u2014'}</td>
                        <td>{r.score != null ? `${Math.round(r.score * 100)}%` : '\u2014'}</td>
                        <td>{r.runnerUp ? `${r.runnerUp.fieldName} (${Math.round(r.runnerUp.score * 100)}%)` : '\u2014'}</td>
                        <td>
                          <span className={r.willLink ? 'agronomy-automatch-yes' : 'agronomy-automatch-no'}>
                            {matchResult.applied
                              ? (r.willLink ? 'Linked' : 'Left for you')
                              : (r.willLink ? 'Will link' : 'Too uncertain')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      {fuzzy.items.length > 0 && (
        <>
          <p className="agronomy-section-label">Suggested matches to confirm ({fuzzy.items.length}{fuzzy.hasMore ? '+' : ''})</p>
          <button className="agronomy-load-more" disabled={confirmingAll} onClick={confirmAllShown}>
            {confirmingAll ? 'Confirming...' : `Confirm all ${fuzzy.items.length} shown`}
          </button>
          <table className="agronomy-cleanup-table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Label</th><th>Suggested field</th><th>Alike</th><th></th></tr>
            </thead>
            <tbody>
              {fuzzy.items.map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.receivedDt)}</td>
                  <td><TypeBadge type={s.type} /></td>
                  <td>{s.rawFieldLabel || '—'}</td>
                  <td>{fieldNameById[s.fieldId] || s.fieldId}</td>
                  <td>{s.fuzzyScore != null ? `${Math.round(s.fuzzyScore * 100)}%` : '\u2014'}</td>
                  <td>
                    <div className="agronomy-cleanup-actions">
                      <button disabled={savingId === s.id} onClick={() => handleAssign(s.id, s.fieldId, fuzzy.removeItem)}>
                        Confirm
                      </button>
                      <select
                        disabled={savingId === s.id}
                        value=""
                        onChange={(e) => e.target.value && handleAssign(s.id, e.target.value, fuzzy.removeItem)}
                      >
                        <option value="">Change to...</option>
                        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {fuzzy.hasMore && (
            <button className="agronomy-load-more" disabled={fuzzy.loadingMore} onClick={fuzzy.loadMore}>
              {fuzzy.loadingMore ? 'Loading...' : 'Load more suggested matches'}
            </button>
          )}
        </>
      )}

      <p className="agronomy-section-label">Unmapped samples ({unmapped.items.length}{unmapped.hasMore ? '+' : ''})</p>
      <table className="agronomy-cleanup-table">
        <thead>
          <tr><th>Date</th><th>Type</th><th>Label</th><th>Assign to field</th></tr>
        </thead>
        <tbody>
          {unmapped.items.length === 0 && (
            <tr><td colSpan={4} className="agronomy-table-empty">Nothing to clean up.</td></tr>
          )}
          {unmapped.items.map((s) => (
            <tr key={s.id}>
              <td>{fmtDate(s.receivedDt)}</td>
              <td><TypeBadge type={s.type} /></td>
              <td>{s.rawFieldLabel || '—'}</td>
              <td>
                <select
                  disabled={savingId === s.id}
                  value=""
                  onChange={(e) => e.target.value && handleAssign(s.id, e.target.value, unmapped.removeItem)}
                >
                  <option value="">Select field...</option>
                  {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {unmapped.hasMore && (
        <button className="agronomy-load-more" disabled={unmapped.loadingMore} onClick={unmapped.loadMore}>
          {unmapped.loadingMore ? 'Loading...' : 'Load more unmapped samples'}
        </button>
      )}
    </div>
  )
}
