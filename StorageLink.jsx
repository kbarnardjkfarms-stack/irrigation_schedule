import { useEffect, useMemo, useState } from 'react'
import { arrayRemove, arrayUnion, deleteField, doc, onSnapshot, setDoc, writeBatch } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import { fmt } from './yieldMath.js'

// "Storage link" tab (Admin/Owner): Potato Storage -> Yield History.
// The sync itself runs in Cloud Functions (functions/storageYields.js):
// every 15 minutes when Potato Storage changed, nightly, and from the
// "Sync now" button here. This tab shows what it did, lets you change the tare, lists piles
// it couldn't match to an Agworld field, and lets you remove (and later
// re-link) a storage-based yield.

function when(ms) {
  if (!ms) return 'never'
  const d = new Date(ms)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
const TRIGGER_LABEL = { 'every-15-min': '15-minute check', 'storage-save': 'Potato Storage save', nightly: 'nightly run', manual: 'Sync now' }

export default function StorageLink({ docsById }) {
  const [status, setStatus] = useState(null)
  const [settings, setSettings] = useState({})
  const [tare, setTare] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [q, setQ] = useState('')

  useEffect(() => onSnapshot(doc(db, 'yieldSettings', 'storageStatus'), (s) => setStatus(s.exists() ? s.data() : null), () => setStatus(null)), [])
  useEffect(() => onSnapshot(doc(db, 'yieldSettings', 'storage'), (s) => {
    const d = s.exists() ? s.data() : {}
    setSettings(d)
    setTare((prev) => (prev === '' ? String(d.tarePct ?? 6.7) : prev))
  }, () => {}), [])

  async function syncNow(note) {
    setBusy(true); setMsg(null)
    try {
      const res = await httpsCallable(functions, 'syncStorageYieldsNow')()
      const r = res.data || {}
      setMsg({ ok: true, text: `${note ? note + ' ' : ''}Synced: ${r.linkedPiles ?? 0} piles linked, ${r.updated ?? 0} yield records updated${r.removed ? `, ${r.removed} removed` : ''}.` })
    } catch (e) {
      setMsg({ ok: false, text: e.code === 'functions/not-found' ? 'The sync function isn’t deployed yet (it deploys with the Cloud Functions workflow).' : (e.message || String(e)) })
    } finally {
      setBusy(false)
    }
  }

  async function saveTare() {
    const v = Number(tare)
    if (!(v >= 0 && v < 50)) { setMsg({ ok: false, text: 'Tare should be a percent between 0 and 50.' }); return }
    await setDoc(doc(db, 'yieldSettings', 'storage'), { tarePct: v }, { merge: true })
    await syncNow(`Tare set to ${v}%.`)
  }

  const records = useMemo(() => Object.entries(docsById)
    .filter(([, d]) => d.storage && d.storage.measuredCwt > 0)
    .map(([id, d]) => ({ id, ...d }))
    .filter((d) => !q || `${d.fieldName} ${(d.storage.bays || []).join(' ')} ${(d.storage.customers || []).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (b.year - a.year) || String(a.fieldName).localeCompare(String(b.fieldName), undefined, { numeric: true })),
  [docsById, q])

  // Stop a storage yield from coming back: every pile behind it goes on the
  // ignore list, then the storage block is removed (or the whole record, if
  // storage was the only thing in it).
  async function removeStorage(d) {
    const piles = Object.keys(d.storage.piles || {})
    if (!window.confirm(`Remove the storage-based yield for ${d.fieldName} (${d.year})? It won’t be re-created from Potato Storage unless you re-link it below.`)) return
    const batch = writeBatch(db)
    batch.set(doc(db, 'yieldSettings', 'storage'), { ignored: arrayUnion(...piles.map((z) => `${d.id}|${z}`)) }, { merge: true })
    const onlyStorage = d.source === 'storage' && !d.agworld && !(d.yieldPerAcre > 0)
    if (onlyStorage) batch.delete(doc(db, 'yieldHistory', d.id))
    else batch.set(doc(db, 'yieldHistory', d.id), { storage: deleteField() }, { merge: true })
    await batch.commit()
  }

  async function relink(key) {
    await setDoc(doc(db, 'yieldSettings', 'storage'), { ignored: arrayRemove(key) }, { merge: true })
    await syncNow('Re-linked.')
  }

  const unlinked = (status && status.unlinked) || []
  const ignored = settings.ignored || []

  return (
    <>
      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Potato Storage → yield history</div>
            <div className="contracts-sub">
              Every pile with a <strong>Measured cwt</strong> becomes a potato yield for its Agworld field(s): measured cwt less tare.
              Combined piles are split by acres; a field in several bays is added up. A workbook or entered (settlement) yield still wins over this.
            </div>
          </div>
          <button className="save" disabled={busy} onClick={() => syncNow()}>{busy ? 'Syncing…' : 'Sync now'}</button>
        </div>
        <div className="agronomy-kpi-grid" style={{ marginTop: 6 }}>
          <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Last sync</p><p className="agronomy-kpi-value" style={{ fontSize: 15 }}>{status ? when(status.lastRunMs) : 'never'}</p><p className="contracts-sub" style={{ margin: 0 }}>{status && status.trigger ? `from ${TRIGGER_LABEL[status.trigger] || status.trigger}` : 'Checks every 15 minutes, full sync nightly'}</p></div>
          <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Piles linked</p><p className="agronomy-kpi-value">{status ? fmt(status.linkedPiles) : '—'}</p></div>
          <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Not linked</p><p className="agronomy-kpi-value" style={{ color: unlinked.length ? '#A32D2D' : undefined }}>{status ? fmt(unlinked.length) : '—'}</p></div>
          <div className="agronomy-kpi-card">
            <p className="agronomy-kpi-label">Potato tare</p>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input className="yields-cell-input" style={{ width: 70 }} type="number" inputMode="decimal" value={tare} onChange={(e) => setTare(e.target.value)} />
              <span className="contracts-sub" style={{ margin: 0 }}>%</span>
              {Number(tare) !== Number(settings.tarePct ?? 6.7) && <button className="clear-sort-btn" onClick={saveTare} disabled={busy}>Save</button>}
            </div>
          </div>
        </div>
        {status && status.error && <div className="agronomy-error-banner">Last sync failed: {status.error}</div>}
        {msg && <div className={msg.ok ? 'yields-ok' : 'agronomy-error-banner'}>{msg.text}</div>}
      </div>

      {unlinked.length > 0 && (
        <div className="yields-card">
          <div className="yields-card-title">Piles not linked to a field</div>
          <p className="contracts-sub">These have a measured cwt but their name doesn’t match an Agworld field for that year. In Potato Storage, re-add the field using “From Agworld” (or rename it to the exact Agworld name), and it will link on the next sync.</p>
          <div className="table-scroll" style={{ maxHeight: 300, marginTop: 8 }}>
            <table className="contracts-table contracts-table-auto">
              <thead><tr><th>Bay</th><th>Pile</th><th>Year</th><th className="num">Measured cwt</th><th className="hide-sm">Variety</th><th className="hide-sm">Customer</th><th>Why</th></tr></thead>
              <tbody>
                {unlinked.map((u) => (
                  <tr key={u.zoneId}>
                    <td>{u.bayName || '—'}</td><td><strong>{u.zoneName || '—'}</strong></td><td>{u.year}</td>
                    <td className="num">{fmt(u.measuredCwt)}</td><td className="hide-sm">{u.variety || '—'}</td><td className="hide-sm">{u.customer || '—'}</td>
                    <td className="contracts-sub">{u.missing && u.missing.length && u.missing.length < (u.zoneName || '').split('+').length ? `No match for: ${u.missing.join(', ')}` : u.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="yields-card">
        <div className="yields-card-head">
          <div className="yields-card-title">Yields from Potato Storage ({records.length})</div>
          <input className="agronomy-search-input" placeholder="Search field, bay, customer…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {records.length === 0 ? <p className="contracts-empty">None yet. Enter a Measured cwt on a pile in Potato Storage, or press Sync now.</p> : (
          <div className="table-scroll" style={{ maxHeight: '60vh' }}>
            <table className="contracts-table contracts-table-auto">
              <thead>
                <tr>
                  <th>Field</th><th>Year</th><th className="hide-sm">Bay(s)</th><th className="hide-sm">Customer</th><th className="hide-sm">Variety</th>
                  <th className="num">Measured</th><th className="num">Less tare</th><th className="num">Acres</th><th className="num">cwt/ac</th><th>Shown?</th><th />
                </tr>
              </thead>
              <tbody>
                {records.map((d) => {
                  const s = d.storage
                  const overridden = d.yieldPerAcre > 0
                  return (
                    <tr key={d.id}>
                      <td><strong>{d.fieldName}</strong>{s.combined && <span className="yields-combined" title={Object.values(s.piles || {}).map((p) => (p.combinedWith || []).join(', ')).filter(Boolean).join('; ')}>combined</span>}</td>
                      <td>{d.year}</td>
                      <td className="hide-sm">{(s.bays || []).join(', ') || '—'}</td>
                      <td className="hide-sm">{(s.customers || []).join(', ') || '—'}</td>
                      <td className="hide-sm">{(s.varieties || []).join(', ') || '—'}</td>
                      <td className="num">{fmt(s.measuredCwt)}</td>
                      <td className="num">{fmt(s.adjustedCwt)} <span className="contracts-sub">−{fmt((s.tareFactor || 0) * 100, 1)}%</span></td>
                      <td className="num">{fmt(s.acres, 1)}</td>
                      <td className="num"><strong>{fmt(s.yieldPerAcre)}</strong></td>
                      <td className="contracts-sub" title={overridden ? 'A workbook or entered yield exists for this field-year and is shown instead' : ''}>
                        {overridden ? `No — ${fmt(d.yieldPerAcre)} ${d.yieldSource === 'manual' ? 'entered' : 'workbook'}` : 'Yes'}
                      </td>
                      <td><button className="clear-sort-btn" onClick={() => removeStorage(d)}>Remove</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {ignored.length > 0 && (
        <details className="yields-table-toggle">
          <summary>Removed storage yields ({ignored.length}) — won’t be re-created</summary>
          <div className="table-scroll" style={{ maxHeight: 260 }}>
            <table className="contracts-table contracts-table-auto">
              <thead><tr><th>Field-year</th><th>Pile id</th><th /></tr></thead>
              <tbody>
                {ignored.map((k) => {
                  const [docId, zoneId] = k.split('|')
                  const [fk, yr] = docId.split('__')
                  return (
                    <tr key={k}>
                      <td>{(docsById[docId] && docsById[docId].fieldName) || fk} · {yr}</td>
                      <td className="contracts-sub">{zoneId}</td>
                      <td><button className="clear-sort-btn" disabled={busy} onClick={() => relink(k)}>Re-link</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </>
  )
}
