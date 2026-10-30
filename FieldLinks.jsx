import { useMemo, useState } from 'react'
import { arrayUnion, deleteDoc, doc, setDoc, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { auth, db, functions } from './firebase.js'
import { fieldKey } from './yieldMath.js'
import { suggestLinksByName } from './rotationMath.js'

// "Field history links" panel on Contracts > Rotation.
//
// Ties today's Agworld fields to the names their history was recorded under
// — e.g. COOK N and COOK S take the years the workbook only has as "COOK".
// A linked field shows the old field's crops (and yields, in Yields > Field
// history) for every year it has no record of its own; those years are
// marked as inherited.
//
// Stored in fieldLineage/{currentFieldKey}: { childName, parents: [{ key, name }] }.
// Suggestions come from two places:
//   - by name: current name = old name + a split suffix (N, S, MINI, 2, …)
//   - by map:  old Agworld seasons' field outlines overlapped with today's
//              (Cloud Function suggestFieldLineageByMap -> fieldLineage/_suggestions)
// Dismissed suggestions: fieldLineage/_dismissed.pairs ["CHILD|PARENT"].

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)

export default function FieldLinks({ currentFields, historyFields, lineage, mapSuggestions, dismissed, satYearsByKey, canEdit }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [q, setQ] = useState('')
  const [adding, setAdding] = useState({}) // childKey -> text

  const dismissedSet = useMemo(() => new Set(dismissed || []), [dismissed])
  const linkedPairs = useMemo(() => {
    const s = new Set()
    Object.entries(lineage).forEach(([c, l]) => (l.parents || []).forEach((p) => s.add(`${c}|${p.key}`)))
    return s
  }, [lineage])
  const histByKey = useMemo(() => Object.fromEntries(historyFields.map((h) => [h.key, h])), [historyFields])

  const suggestions = useMemo(() => {
    const byName = suggestLinksByName(currentFields, historyFields).map((s) => ({ ...s, why: s.how === 'split' ? 'Name: split field' : 'Name: merged field' }))
    const byMap = ((mapSuggestions && mapSuggestions.items) || []).map((s) => ({
      ...s, why: `Map: old outline covers ${Math.round(s.covered * 100)}%${s.years && s.years.length ? ` (${s.years[0]}${s.years.length > 1 ? `–${s.years[s.years.length - 1]}` : ''})` : ''}`
    }))
    const merged = {}
    ;[...byMap, ...byName].forEach((s) => {
      const k = `${s.childKey}|${s.parentKey}`
      if (linkedPairs.has(k) || dismissedSet.has(k)) return
      merged[k] = merged[k] ? { ...merged[k], why: `${merged[k].why} · ${s.why}` } : { ...s, key: k }
    })
    return Object.values(merged).sort((a, b) => a.childName.localeCompare(b.childName, undefined, { numeric: true }))
  }, [currentFields, historyFields, mapSuggestions, linkedPairs, dismissedSet])

  async function run(fn) {
    setBusy(true); setMsg(null)
    try { await fn() } catch (e) { setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only an Admin or Owner can change field links.' : (e.message || String(e)) }) } finally { setBusy(false) }
  }

  // Add one or more { childKey, childName, parentKey, parentName } links.
  function link(items) {
    return run(async () => {
      const byChild = {}
      items.forEach((s) => { (byChild[s.childKey] = byChild[s.childKey] || { childName: s.childName, parents: [] }).parents.push({ key: s.parentKey, name: s.parentName }) })
      const b = writeBatch(db)
      Object.entries(byChild).forEach(([ck, v]) => {
        const existing = (lineage[ck] && lineage[ck].parents) || []
        const parents = [...existing, ...v.parents.filter((p) => !existing.some((e) => e.key === p.key))]
        b.set(doc(db, 'fieldLineage', ck), { childKey: ck, childName: v.childName, parents, updatedBy: who(), updatedAt: Date.now() })
      })
      await b.commit()
      setMsg({ ok: true, text: `Linked ${items.length} field${items.length === 1 ? '' : 's'}.` })
    })
  }
  function unlink(childKey, parentKey) {
    const l = lineage[childKey]
    if (!l) return
    const parents = (l.parents || []).filter((p) => p.key !== parentKey)
    run(() => (parents.length ? setDoc(doc(db, 'fieldLineage', childKey), { ...l, parents, updatedBy: who(), updatedAt: Date.now() }) : deleteDoc(doc(db, 'fieldLineage', childKey))))
  }
  function dismiss(s) {
    run(() => setDoc(doc(db, 'fieldLineage', '_dismissed'), { pairs: arrayUnion(`${s.childKey}|${s.parentKey}`) }, { merge: true }))
  }
  function addManual(cf) {
    const text = (adding[cf.key] || '').trim()
    const k = fieldKey(text)
    if (!k) return
    const h = histByKey[k]
    if (!h) { setMsg({ ok: false, text: `No history recorded under “${text}”. Pick a name from the list.` }); return }
    if (k === cf.key) { setMsg({ ok: false, text: 'That’s the field’s own name — it already lines up.' }); return }
    link([{ childKey: cf.key, childName: cf.name, parentKey: k, parentName: h.name }]).then(() => setAdding((a) => ({ ...a, [cf.key]: '' })))
  }
  async function findByMap() {
    setBusy(true); setMsg({ ok: true, text: 'Checking Agworld’s older seasons for field outlines… this can take a few minutes.' })
    try {
      const r = (await httpsCallable(functions, 'suggestFieldLineageByMap', { timeout: 560000 })()).data || {}
      setMsg({ ok: true, text: r.note || `Checked ${r.seasonsChecked} older Agworld season${r.seasonsChecked === 1 ? '' : 's'} (${r.oldFieldsWithOutline} field outlines) against ${r.currentFieldsWithOutline} current fields: ${r.items ? r.items.length : 0} suggestion${r.items && r.items.length === 1 ? '' : 's'}.` })
    } catch (e) {
      setMsg({ ok: false, text: e.code === 'functions/not-found' ? 'The map-matching function isn’t deployed yet (it deploys with the Cloud Functions workflow).' : (e.message || String(e)) })
    } finally {
      setBusy(false)
    }
  }

  const linkedCount = Object.keys(lineage).length
  const nameSuggestions = suggestions.filter((s) => s.why.includes('Name'))
  const rows = currentFields.filter((f) => !q || `${f.name} ${f.farmName || ''} ${((lineage[f.key] || {}).parents || []).map((p) => p.name).join(' ')}`.toLowerCase().includes(q.toLowerCase()))

  return (
    <div className="yields-card rot-links">
      <div className="yields-card-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="yields-card-title">Field history links</div>
          <div className="contracts-sub">
            {linkedCount} field{linkedCount === 1 ? '' : 's'} linked · {suggestions.length} suggestion{suggestions.length === 1 ? '' : 's'} waiting.
            Ties today’s fields to the names their history was recorded under (e.g. COOK N and COOK S ← COOK).
          </div>
        </div>
        <button className="clear-sort-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'Review links'}</button>
      </div>
      {open && (
        <>
          {canEdit && (
            <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
              <button disabled={busy} onClick={findByMap}>Find links by map (old Agworld seasons)</button>
              {nameSuggestions.length > 0 && <button className="save" disabled={busy} onClick={() => link(nameSuggestions)}>Accept all {nameSuggestions.length} name matches</button>}
              {mapSuggestions && mapSuggestions.runAt && <span className="contracts-sub">Map check last run {new Date(mapSuggestions.runAt).toLocaleDateString()}{mapSuggestions.note ? ` — ${mapSuggestions.note}` : ''}</span>}
            </div>
          )}
          {msg && <div className={msg.ok ? 'yields-ok' : 'agronomy-error-banner'}>{msg.text}</div>}

          {suggestions.length > 0 && (
            <>
              <div className="agronomy-section-label">Suggested</div>
              <div className="table-scroll" style={{ maxHeight: 280 }}>
                <table className="contracts-table contracts-table-auto">
                  <thead><tr><th>Current field</th><th>Take history from</th><th className="num">Years of history</th><th>Why</th>{canEdit && <th />}</tr></thead>
                  <tbody>
                    {suggestions.map((s) => (
                      <tr key={s.key}>
                        <td><strong>{s.childName}</strong></td>
                        <td>{s.parentName}</td>
                        <td className="num">{(histByKey[s.parentKey] || {}).years ?? '—'}</td>
                        <td className="contracts-sub">{s.why}</td>
                        {canEdit && (
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="clear-sort-btn" disabled={busy} onClick={() => link([s])}>Link</button>{' '}
                            <button className="clear-sort-btn" disabled={busy} onClick={() => dismiss(s)}>Dismiss</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}

          <div className="agronomy-filter-bar" style={{ marginTop: 12, marginBottom: 6 }}>
            <span className="agronomy-section-label" style={{ margin: 0 }}>All current fields</span>
            <input className="agronomy-search-input" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <datalist id="rot-history-names">
            {historyFields.map((h) => <option key={h.key} value={h.name}>{h.years} yrs</option>)}
          </datalist>
          <div className="table-scroll" style={{ maxHeight: 360 }}>
            <table className="contracts-table contracts-table-auto">
              <thead><tr><th>Field</th><th className="num">Own record yrs</th><th className="num">Satellite yrs</th><th>History also from</th>{canEdit && <th>Add an old name</th>}</tr></thead>
              <tbody>
                {rows.map((cf) => {
                  const l = lineage[cf.key]
                  const own = (histByKey[cf.key] || {}).years || 0
                  const satN = satYearsByKey[cf.key] || 0
                  return (
                    <tr key={cf.key}>
                      <td><strong>{cf.name}</strong><div className="contracts-sub" style={{ marginTop: 0 }}>{cf.farmName || ''}</div></td>
                      <td className="num" style={{ color: own === 0 ? '#A32D2D' : undefined }}>{own}</td>
                      <td className="num" title={satN ? '' : 'No satellite years yet — the backfill may not have reached it, or Agworld has no outline for it'}>{satN || '—'}</td>
                      <td>
                        {l && (l.parents || []).length ? (l.parents || []).map((p) => (
                          <span key={p.key} className="yields-chip" style={{ marginRight: 4 }}>{p.name}
                            {canEdit && <button aria-label={`Unlink ${p.name}`} disabled={busy} onClick={() => unlink(cf.key, p.key)}>×</button>}
                          </span>
                        )) : <span className="contracts-sub">—</span>}
                      </td>
                      {canEdit && (
                        <td style={{ whiteSpace: 'nowrap' }}>
                          <input className="yields-cell-input" style={{ width: 150, textAlign: 'left' }} list="rot-history-names" placeholder="Old field name"
                            value={adding[cf.key] || ''} onChange={(e) => setAdding((a) => ({ ...a, [cf.key]: e.target.value }))}
                            onKeyDown={(e) => { if (e.key === 'Enter') addManual(cf) }} />{' '}
                          <button className="clear-sort-btn" disabled={busy || !(adding[cf.key] || '').trim()} onClick={() => addManual(cf)}>Link</button>
                        </td>
                      )}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
