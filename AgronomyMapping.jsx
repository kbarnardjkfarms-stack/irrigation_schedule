import { useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase.js'
import { SAMPLE_TYPE_LABEL } from './AgronomyConfig.js'

// Field mapping: Stukenholtz names its samples its own way ("WILSON SOUTH
// 2026", "Shop S pivot") and they will never line up perfectly with the Agworld
// field names. This tab lists every distinct lab label, lets you pick the
// label on the left and the field on the right, and links them. The choice is
// REMEMBERED - every sample already saved under that label is updated and
// every future sync uses it, so each label only ever has to be done once.
//
// Server side: listSampleLabels (read) and setSampleLabelLink (link / unlink /
// not-a-field / reset) in functions/index.js.
const listSampleLabels = httpsCallable(functions, 'listSampleLabels', { timeout: 300000 })
const setSampleLabelLink = httpsCallable(functions, 'setSampleLabelLink', { timeout: 300000 })

const STATUS = {
  unlinked: { text: 'Not linked', bg: '#fbe3e3', fg: '#9b1c1c', dot: '#D32F2F' },
  auto: { text: 'Auto-matched', bg: '#fdeccf', fg: '#8a5300', dot: '#F08A00' },
  mixed: { text: 'Partly linked', bg: '#fdeccf', fg: '#8a5300', dot: '#F08A00' },
  linked: { text: 'Linked', bg: '#dff0e0', fg: '#1f5c2b', dot: '#2E8B3E' },
  ignored: { text: 'Not a field', bg: '#e8e6df', fg: '#555', dot: '#999' }
}
const FILTERS = [
  { id: 'attention', label: 'Needs attention', test: (l) => l.status === 'unlinked' || l.status === 'auto' || l.status === 'mixed' },
  { id: 'unlinked', label: 'Not linked', test: (l) => l.status === 'unlinked' },
  { id: 'auto', label: 'Auto-matched', test: (l) => l.status === 'auto' },
  { id: 'linked', label: 'Linked', test: (l) => l.status === 'linked' },
  { id: 'ignored', label: 'Not a field', test: (l) => l.status === 'ignored' },
  { id: 'all', label: 'All', test: () => true }
]

const fmtDay = (ms) => (ms == null ? '' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
const SHOW_LIMIT = 150

const box = { border: '1px solid #ddd8cc', borderRadius: 8, background: '#fff', padding: 10 }
const rowBase = { display: 'block', width: '100%', textAlign: 'left', padding: '6px 8px', border: 0, borderBottom: '1px solid #eee', background: 'transparent', cursor: 'pointer', font: 'inherit', color: 'inherit' }
const smallBtn = { padding: '3px 9px', borderRadius: 5, border: '1px solid #bdb8a8', background: '#fff', cursor: 'pointer', fontSize: 12 }
const primaryBtn = { padding: '6px 14px', borderRadius: 6, border: '1px solid #3c5a3f', background: '#3c5a3f', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 600 }

function Chip({ status }) {
  const c = STATUS[status] || STATUS.unlinked
  return <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontSize: 11, fontWeight: 600, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{c.text}</span>
}

export default function AgronomyMapping({ fields }) {
  const [labels, setLabels] = useState([])
  const [totalSamples, setTotalSamples] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [filter, setFilter] = useState('attention')
  const [labelSearch, setLabelSearch] = useState('')
  const [fieldSearch, setFieldSearch] = useState('')
  const [onlyNoSamples, setOnlyNoSamples] = useState(false)
  const [selKey, setSelKey] = useState(null)
  const [selFieldId, setSelFieldId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState(null)
  const [showAll, setShowAll] = useState(false)

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const res = await listSampleLabels({})
      setLabels(res.data.labels || [])
      setTotalSamples(res.data.totalSamples || 0)
    } catch (err) {
      console.error('listSampleLabels failed:', err)
      setError(err.message || 'Could not load the lab labels.')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  const fieldById = useMemo(() => {
    const m = {}
    fields.forEach((f) => { m[f.id] = f })
    return m
  }, [fields])
  const nameOf = (id) => (fieldById[id] ? fieldById[id].name : id ? '(deleted field)' : '')

  // Which labels / how many samples each field has.
  const byField = useMemo(() => {
    const m = {}
    labels.forEach((l) => {
      if (!l.fieldId || l.status === 'unlinked' || l.status === 'ignored') return
      const e = m[l.fieldId] || (m[l.fieldId] = { labels: [], samples: 0 })
      e.labels.push(l)
      e.samples += l.count
    })
    return m
  }, [labels])

  const counts = useMemo(() => {
    const c = {}
    FILTERS.forEach((f) => { c[f.id] = labels.filter(f.test).length })
    return c
  }, [labels])

  const shownLabels = useMemo(() => {
    const test = FILTERS.find((f) => f.id === filter).test
    const q = labelSearch.trim().toLowerCase()
    return labels.filter((l) => test(l) && (!q || l.spellings.some((s) => s.toLowerCase().includes(q)) || nameOf(l.fieldId).toLowerCase().includes(q)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [labels, filter, labelSearch, fieldById])

  const shownFields = useMemo(() => {
    const q = fieldSearch.trim().toLowerCase()
    return fields.filter((f) => (!q || (f.name || '').toLowerCase().includes(q) || (f.farmName || '').toLowerCase().includes(q))
      && (!onlyNoSamples || !byField[f.id]))
  }, [fields, fieldSearch, onlyNoSamples, byField])

  const sel = labels.find((l) => l.key === selKey) || null
  const selField = selFieldId ? fieldById[selFieldId] : null
  const fieldsWithoutSamples = fields.filter((f) => !byField[f.id]).length

  function applyLocal(key, mode, res) {
    setLabels((prev) => prev.map((l) => {
      if (l.key !== key) return l
      if (mode === 'link') return { ...l, status: 'linked', fieldId: res.fieldId, remembered: true }
      if (mode === 'ignore') return { ...l, status: 'ignored', fieldId: null, remembered: true }
      if (mode === 'unlink') return { ...l, status: 'unlinked', fieldId: null, remembered: true }
      return { ...l, status: res.fieldId ? (res.fieldMatchType === 'exact' ? 'linked' : 'auto') : 'unlinked', fieldId: res.fieldId || null, remembered: false }
    }))
  }

  async function act(label, mode, fieldId, opts = {}) {
    setBusy(true)
    setNote(null)
    try {
      const res = await setSampleLabelLink({ label: label.label, fieldId: fieldId || null, mode })
      applyLocal(label.key, mode, res.data)
      if (!opts.quiet) {
        const n = res.data.updated
        setNote({
          ok: true,
          text: mode === 'reset'
            ? `${label.label}: reset to automatic (${n} samples).`
            : `${label.label}: ${{ link: `linked to ${nameOf(fieldId)}`, unlink: 'unlinked', ignore: 'marked as not a field' }[mode]} (${n} samples updated). Remembered for future syncs.`
        })
      }
      return true
    } catch (err) {
      console.error('setSampleLabelLink failed:', err)
      setNote({ ok: false, text: err.message || 'Could not save that - try again.' })
      return false
    } finally {
      setBusy(false)
    }
  }

  // After linking / ignoring, jump to the next label in the list so a long
  // backlog can be worked through quickly.
  function nextKeyAfter(key) {
    const i = shownLabels.findIndex((l) => l.key === key)
    const rest = shownLabels.slice(i + 1).concat(shownLabels.slice(0, Math.max(i, 0)))
    const nxt = rest.find((l) => l.key !== key)
    return nxt ? nxt.key : null
  }

  async function doLink(label, fieldId) {
    const next = nextKeyAfter(label.key)
    if (await act(label, 'link', fieldId)) {
      setSelKey(next)
      setSelFieldId(null)
    }
  }
  async function doIgnore(label) {
    const next = nextKeyAfter(label.key)
    if (await act(label, 'ignore')) { setSelKey(next); setSelFieldId(null) }
  }
  async function doUnlink(label) {
    if (!window.confirm(`Unlink "${label.label}" (${label.count} samples) from ${nameOf(label.fieldId) || 'its field'}? It will stay unlinked until you link it again.`)) return
    await act(label, 'unlink')
  }
  async function doReset(label) {
    if (!window.confirm(`Forget the saved choice for "${label.label}" and let the automatic matcher decide?`)) return
    await act(label, 'reset')
  }
  async function confirmAllAuto() {
    const list = labels.filter((l) => l.status === 'auto' && l.fieldId)
    if (!list.length) return
    if (!window.confirm(`Confirm all ${list.length} auto-matched labels? Each becomes a saved link you won't need to look at again.`)) return
    setBusy(true)
    setNote(null)
    let done = 0
    try {
      for (const l of list) {
        const res = await setSampleLabelLink({ label: l.label, fieldId: l.fieldId, mode: 'link' })
        applyLocal(l.key, 'link', res.data)
        done++
      }
      setNote({ ok: true, text: `Confirmed ${done} auto-matched labels.` })
    } catch (err) {
      console.error('confirm all failed:', err)
      setNote({ ok: false, text: `Stopped after ${done}: ${err.message || 'try again'}` })
    } finally {
      setBusy(false)
    }
  }

  const visibleLabels = showAll ? shownLabels : shownLabels.slice(0, SHOW_LIMIT)
  const selLinkedName = sel && sel.fieldId && sel.status !== 'unlinked' && sel.status !== 'ignored' ? nameOf(sel.fieldId) : null
  const selFieldEntry = selFieldId ? byField[selFieldId] : null

  return (
    <div className="agronomy-mapping">
      <p className="agronomy-targets-hint" style={{ marginTop: 0 }}>
        Pick a lab label on the left, then the field it really is on the right, and press Link. Every sample already
        under that label is updated and the choice is remembered for all future lab syncs - each label is done once.
        Use "Not a field" for things like shop or test samples.
      </p>

      {error && <p className="agronomy-error-banner">{error}</p>}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', margin: '8px 0' }}>
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => { setFilter(f.id); setShowAll(false) }}
            style={{ ...smallBtn, ...(filter === f.id ? { background: '#3c5a3f', color: '#fff', border: '1px solid #3c5a3f' } : {}) }}
          >
            {f.label} ({counts[f.id]})
          </button>
        ))}
        <button style={smallBtn} disabled={loading} onClick={load}>{loading ? 'Loading...' : 'Refresh'}</button>
        <span style={{ fontSize: 11, color: '#777' }}>{labels.length} lab labels from {totalSamples} samples</span>
      </div>

      {note && <p className={note.ok ? 'agronomy-automatch-summary' : 'agronomy-error-banner'} style={{ margin: '4px 0 8px' }}>{note.text}</p>}

      {/* ---- what's selected + the buttons ---- */}
      <div style={{ ...box, marginBottom: 12, borderColor: sel ? '#3c5a3f' : '#ddd8cc' }}>
        {!sel ? (
          <p style={{ margin: 0, fontSize: 13, color: '#666' }}>
            {loading ? 'Loading lab labels...' : 'Select a lab label from the list to link it.'}
          </p>
        ) : (
          <>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <strong style={{ fontSize: 15 }}>{sel.label}</strong>
              <Chip status={sel.status} />
              {selLinkedName && <span style={{ fontSize: 13 }}>{'→'} {selLinkedName}</span>}
              {sel.remembered && <span style={{ fontSize: 11, color: '#777' }}>(saved choice)</span>}
            </div>
            <p style={{ margin: '2px 0 6px', fontSize: 11, color: '#777' }}>
              {sel.count} samples ({Object.entries(sel.types || {}).map(([t, n]) => `${SAMPLE_TYPE_LABEL[t] || t} ${n}`).join(', ')})
              {sel.first != null ? ` - ${fmtDay(sel.first)} to ${fmtDay(sel.last)}` : ''}
              {sel.spellings.length > 1 ? ` - also spelled: ${sel.spellings.slice(1, 4).join(', ')}${sel.spellings.length > 4 ? '...' : ''}` : ''}
            </p>

            {sel.suggestions && sel.suggestions.length > 0 && sel.status !== 'linked' && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: '#555' }}>Looks like:</span>
                {sel.suggestions.filter((s) => fieldById[s.fieldId]).map((s) => (
                  <span key={s.fieldId} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', border: '1px solid #ddd8cc', borderRadius: 6, padding: '2px 4px 2px 8px', fontSize: 12, background: '#faf9f5' }}>
                    {nameOf(s.fieldId)} <span style={{ color: '#888' }}>{Math.round(s.score * 100)}%</span>
                    <button style={smallBtn} disabled={busy} onClick={() => doLink(sel, s.fieldId)}>Link</button>
                  </span>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                style={{ ...primaryBtn, opacity: selField && !busy ? 1 : 0.45 }}
                disabled={!selField || busy}
                onClick={() => doLink(sel, selFieldId)}
              >
                {selField
                  ? `${selLinkedName && sel.fieldId !== selFieldId ? 'Move' : 'Link'} to ${selField.name}`
                  : 'Pick a field on the right to link'}
              </button>
              {selLinkedName && <button style={smallBtn} disabled={busy} onClick={() => doUnlink(sel)}>Unlink</button>}
              {sel.status !== 'ignored' && <button style={smallBtn} disabled={busy} onClick={() => doIgnore(sel)}>Not a field</button>}
              {sel.remembered && <button style={smallBtn} disabled={busy} onClick={() => doReset(sel)}>Reset to automatic</button>}
              {filter === 'auto' && counts.auto > 1 && (
                <button style={smallBtn} disabled={busy} onClick={confirmAllAuto}>Confirm all {counts.auto} auto-matched</button>
              )}
            </div>
          </>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))', gap: 14 }}>
        {/* ---- lab labels ---- */}
        <div style={box}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>Lab labels ({shownLabels.length})</strong>
            <input type="search" placeholder="Search labels or fields..." value={labelSearch} onChange={(e) => setLabelSearch(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          </div>
          <div style={{ maxHeight: 470, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6 }}>
            {!loading && shownLabels.length === 0 && (
              <p style={{ margin: 10, fontSize: 13, color: '#888' }}>
                {filter === 'attention' ? 'Nothing needs attention - every lab label is linked.' : 'No labels in this list.'}
              </p>
            )}
            {visibleLabels.map((l) => {
              const c = STATUS[l.status] || STATUS.unlinked
              const on = l.key === selKey
              return (
                <button key={l.key} onClick={() => { setSelKey(l.key); setNote(null) }}
                  style={{ ...rowBase, background: on ? '#e7efe3' : 'transparent', boxShadow: on ? 'inset 3px 0 0 #3c5a3f' : `inset 3px 0 0 ${c.dot}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: 13 }}>{l.label}</span>
                    <span style={{ fontSize: 11, color: '#777', whiteSpace: 'nowrap' }}>{l.count} samples</span>
                  </div>
                  <div style={{ fontSize: 11, color: '#777', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ color: c.fg }}>{c.text}</span>
                    {l.fieldId && l.status !== 'unlinked' && l.status !== 'ignored' && <span>{'→'} {nameOf(l.fieldId)}</span>}
                    {l.status === 'unlinked' && l.suggestions && l.suggestions[0] && fieldById[l.suggestions[0].fieldId] && (
                      <span>maybe {nameOf(l.suggestions[0].fieldId)} ({Math.round(l.suggestions[0].score * 100)}%)</span>
                    )}
                    {l.last != null && <span>last {fmtDay(l.last)}</span>}
                  </div>
                </button>
              )
            })}
            {shownLabels.length > visibleLabels.length && (
              <button style={{ ...rowBase, textAlign: 'center', color: '#3c5a3f', fontWeight: 600 }} onClick={() => setShowAll(true)}>
                Show all {shownLabels.length}
              </button>
            )}
          </div>
        </div>

        {/* ---- fields ---- */}
        <div style={box}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
            <strong style={{ fontSize: 13 }}>Fields ({shownFields.length})</strong>
            <input type="search" placeholder="Search fields..." value={fieldSearch} onChange={(e) => setFieldSearch(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          </div>
          <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 6 }}>
            <input type="checkbox" checked={onlyNoSamples} onChange={(e) => setOnlyNoSamples(e.target.checked)} />{' '}
            Only fields with no lab samples linked ({fieldsWithoutSamples})
          </label>

          {selField && (
            <div style={{ background: '#faf9f5', border: '1px solid #ddd8cc', borderRadius: 6, padding: 8, marginBottom: 8, fontSize: 12 }}>
              <strong>{selField.name}</strong>
              {selFieldEntry
                ? <> - {selFieldEntry.samples} samples from {selFieldEntry.labels.length} lab label{selFieldEntry.labels.length === 1 ? '' : 's'}:</>
                : <> - no lab samples linked yet</>}
              {selFieldEntry && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {selFieldEntry.labels.map((l) => (
                    <span key={l.key} style={{ display: 'inline-flex', gap: 4, alignItems: 'center', border: '1px solid #ddd8cc', borderRadius: 6, padding: '2px 4px 2px 8px', background: '#fff' }}>
                      <button style={{ border: 0, background: 'none', cursor: 'pointer', font: 'inherit', padding: 0 }} onClick={() => setSelKey(l.key)}>
                        {l.label} <span style={{ color: '#888' }}>({l.count})</span>
                      </button>
                      <button style={smallBtn} disabled={busy} onClick={() => doUnlink(l)}>Unlink</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ maxHeight: 400, overflowY: 'auto', border: '1px solid #eee', borderRadius: 6 }}>
            {shownFields.map((f) => {
              const e = byField[f.id]
              const on = f.id === selFieldId
              return (
                <button key={f.id} onClick={() => setSelFieldId(on ? null : f.id)}
                  style={{ ...rowBase, background: on ? '#e7efe3' : 'transparent', boxShadow: on ? 'inset 3px 0 0 #3c5a3f' : 'none' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600 }}>
                      {f.name}
                      {f.farmName && <span style={{ fontWeight: 400, color: '#888', fontSize: 11 }}> {'·'} {f.farmName}</span>}
                    </span>
                    <span style={{ fontSize: 11, whiteSpace: 'nowrap', color: e ? '#1f5c2b' : '#a0651a' }}>
                      {e ? `${e.labels.length} label${e.labels.length === 1 ? '' : 's'} · ${e.samples}` : 'no lab samples'}
                    </span>
                  </div>
                </button>
              )
            })}
            {shownFields.length === 0 && <p style={{ margin: 10, fontSize: 13, color: '#888' }}>No fields match.</p>}
          </div>
        </div>
      </div>
    </div>
  )
}
