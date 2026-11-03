import { Fragment, useMemo, useState } from 'react'
import { deleteDoc, doc, getDoc, setDoc, updateDoc } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { allocateUnload, fmtCwt, fmtWhen, lotKey, lotLabel, newId, truckKey } from './seedMath.js'
import { TYPE_LABEL } from './Seed.jsx'

// Manager tabs of the Potato Seed module: contracts, every ticket (with the
// photo, edit and delete), lots & shrink close-out, the planted-by-field
// report and settings (truck light weights, cutting-zone limit).

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
function useRun() {
  const [msg, setMsg] = useState(null)
  // Don't wait on the server: offline, Firestore keeps the change on this
  // device (and shows it straight away) and sends it when signal is back.
  const run = (fn, ok) => {
    setMsg(null)
    let p
    try { p = Promise.resolve(fn()) } catch (e) { p = Promise.reject(e) }
    p.catch((e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin, Owner or Farm manager can change that.' : e.message }))
    if (ok) setMsg({ ok: true, text: ok + (navigator.onLine === false ? ' (offline — it will sync when you’re back online)' : '') })
    return Promise.resolve()
  }
  const Msg = () => (msg ? <div className={msg.ok ? 'yields-ok' : 'agronomy-error-banner'} style={{ marginTop: 0, marginBottom: 10 }} onClick={() => setMsg(null)}>{msg.text}</div> : null)
  return { run, Msg }
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------
const BLANK = { supplier: '', variety: '', contractedCwt: '', lots: '', generation: '', pricePerCwt: '', notes: '' }
export function SeedContracts({ ctx }) {
  const { run, Msg } = useRun()
  const [edit, setEdit] = useState(null) // { id|null, ...form }
  const rowsById = Object.fromEntries(ctx.seed.contractRows.map((c) => [c.id, c]))
  const suppliers = [...new Set(ctx.contracts.map((c) => c.supplier))].sort()
  const varieties = [...new Set(ctx.contracts.map((c) => c.variety))].sort()
  function saveC() {
    const f = edit
    if (!f.supplier.trim() || !f.variety.trim()) return
    const data = {
      seasonId: ctx.seasonId, supplier: f.supplier.trim(), variety: f.variety.trim(), contractedCwt: Number(f.contractedCwt) || 0,
      lots: String(f.lots || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean),
      generation: f.generation.trim() || null, pricePerCwt: f.pricePerCwt === '' ? null : Number(f.pricePerCwt), notes: f.notes.trim() || null,
      updatedBy: who(), updatedAt: Date.now()
    }
    run(() => setDoc(doc(db, 'seedContracts', f.id || newId()), data), f.id ? 'Contract updated.' : 'Contract added.').then(() => setEdit(null))
  }
  const sorted = [...ctx.contracts].sort((a, b) => a.supplier.localeCompare(b.supplier) || a.variety.localeCompare(b.variety))
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Seed contracts — crop year {ctx.seasonName}</div>
          <div className="contracts-sub">One line per grower and variety. Lots are optional here — drivers can type a new lot on the pickup ticket.</div>
        </div>
        <button className="save" onClick={() => setEdit({ ...BLANK, id: null })}>+ Add contract</button>
      </div>
      <Msg />
      {edit && (
        <div className="harvest-import">
          <div className="hd-grid">
            <label className="hd-field"><span>Supplier (grower)</span><input list="sc-sup" value={edit.supplier} onChange={(e) => setEdit({ ...edit, supplier: e.target.value })} /></label>
            <label className="hd-field"><span>Variety</span><input list="sc-var" value={edit.variety} onChange={(e) => setEdit({ ...edit, variety: e.target.value })} /></label>
            <label className="hd-field"><span>Contracted (cwt)</span><input inputMode="decimal" value={edit.contractedCwt} onChange={(e) => setEdit({ ...edit, contractedCwt: e.target.value })} /></label>
            <label className="hd-field"><span>Lot #s (comma separated)</span><input value={edit.lots} onChange={(e) => setEdit({ ...edit, lots: e.target.value })} /></label>
            <label className="hd-field"><span>Generation / class</span><input value={edit.generation} onChange={(e) => setEdit({ ...edit, generation: e.target.value })} placeholder="e.g. G3" /></label>
            <label className="hd-field"><span>Price ($/cwt)</span><input inputMode="decimal" value={edit.pricePerCwt} onChange={(e) => setEdit({ ...edit, pricePerCwt: e.target.value })} /></label>
            <label className="hd-field"><span>Notes</span><input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
          </div>
          <datalist id="sc-sup">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
          <datalist id="sc-var">{varieties.map((s) => <option key={s} value={s} />)}</datalist>
          <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
            <button className="save" disabled={!edit.supplier.trim() || !edit.variety.trim()} onClick={saveC}>Save</button>
            <button onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>Supplier</th><th>Variety</th><th>Lots</th><th>Gen</th><th className="num">Contracted</th><th className="num">Picked up</th><th className="num">Remaining</th><th className="num">$/cwt</th><th>Notes</th><th /></tr></thead>
          <tbody>
            {sorted.map((c) => {
              const r = rowsById[c.id] || {}
              return (
                <tr key={c.id}>
                  <td><strong>{c.supplier}</strong></td><td>{c.variety}</td><td className="contracts-sub">{(c.lots || []).join(', ')}</td><td>{c.generation || ''}</td>
                  <td className="num">{fmtCwt(c.contractedCwt)}</td><td className="num">{fmtCwt(r.picked)}</td><td className="num">{fmtCwt(r.remaining)}</td>
                  <td className="num">{c.pricePerCwt != null ? `$${c.pricePerCwt}` : ''}</td><td className="contracts-sub">{c.notes || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="clear-sort-btn" onClick={() => setEdit({ ...BLANK, ...c, lots: (c.lots || []).join(', '), contractedCwt: String(c.contractedCwt ?? ''), pricePerCwt: c.pricePerCwt ?? '', generation: c.generation || '', notes: c.notes || '' })}>Edit</button>{' '}
                    <button className="clear-sort-btn" disabled={r.loads > 0} title={r.loads ? 'Has pickup tickets' : ''} onClick={() => { if (window.confirm(`Delete the ${c.supplier} ${c.variety} contract?`)) run(() => deleteDoc(doc(db, 'seedContracts', c.id))) }}>Delete</button>
                  </td>
                </tr>
              )
            })}
            {!sorted.length && <tr><td colSpan={10} className="contracts-sub">No contracts for this crop year yet.</td></tr>}
          </tbody>
          {sorted.length > 0 && <tfoot><tr><td colSpan={4}><strong>Total</strong></td><td className="num"><strong>{fmtCwt(ctx.seed.totals.contracted)}</strong></td><td className="num"><strong>{fmtCwt(ctx.seed.totals.picked)}</strong></td><td colSpan={4} /></tr></tfoot>}
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tickets
// ---------------------------------------------------------------------------
export function SeedTickets({ ctx }) {
  const { run, Msg } = useRun()
  const [type, setType] = useState('all')
  const [q, setQ] = useState('')
  const [showDeleted, setShowDeleted] = useState(false)
  const [photo, setPhoto] = useState(null) // { id, data|null }
  const [edit, setEdit] = useState(null)
  const list = ctx.tickets
    .filter((t) => showDeleted || !t.deleted)
    .filter((t) => type === 'all' || t.type === type)
    .filter((t) => !q || JSON.stringify([t.truckNo, t.ticketNo, t.supplier, t.variety, t.lot, t.fieldName, t.parts, t.note]).toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => b.at - a.at)
  const trucksById = Object.fromEntries(ctx.seed.trucks.map((t) => [t.id, t]))

  async function openPhoto(t) {
    setPhoto({ id: t.id, data: null })
    try { const d = await getDoc(doc(db, 'seedPhotos', t.id)); setPhoto({ id: t.id, data: d.exists() ? d.data().data : 'none' }) } catch { setPhoto({ id: t.id, data: 'none' }) }
  }
  function del(t) {
    const tr = trucksById[t.id]
    const warn = t.type === 'cut' && tr && tr.events.length ? ` ${tr.events.length} field unload(s) came off this truck — they'll lose their link.` : ''
    if (window.confirm(`Delete this ${TYPE_LABEL[t.type].toLowerCase()} ticket (truck ${t.truckNo}, ${fmtCwt(t.cwt, 1)} cwt)?${warn} You can restore it with “Show deleted”.`)) {
      run(() => updateDoc(doc(db, 'seedTickets', t.id), { deleted: true, deletedAt: Date.now(), deletedBy: who() }), 'Ticket deleted.')
    }
  }
  function saveEdit() {
    const t = edit.t
    const patch = { truckNo: edit.truckNo.trim(), truckKey: truckKey(edit.truckNo), ticketNo: edit.ticketNo.trim() || null, note: edit.note.trim() || null, editedBy: who(), editedAt: Date.now() }
    const cwt = Number(edit.cwt)
    if (cwt > 0 && Math.abs(cwt - t.cwt) > 0.001) {
      patch.cwt = cwt
      patch.netLbs = Math.round(cwt * 100)
      if (t.parts && t.parts.length) {
        const f = cwt / (t.cwt || cwt)
        patch.parts = t.parts.map((p) => ({ ...p, cwt: Math.round(p.cwt * f * 100) / 100 }))
      }
    }
    if (t.type === 'pickup') {
      Object.assign(patch, { supplier: edit.supplier.trim(), variety: edit.variety.trim(), lot: edit.lot.trim(), lotKey: lotKey(edit.supplier, edit.variety, edit.lot) })
      const c = ctx.contracts.find((x) => x.supplier === patch.supplier && x.variety === patch.variety)
      patch.contractId = c ? c.id : null
      patch.status = edit.status
    }
    if (t.type === 'cut' && edit.parts) {
      patch.parts = edit.parts.map((p) => ({ ...p, cwt: Number(p.cwt) || 0 }))
      patch.cwt = Math.round(patch.parts.reduce((s, p) => s + p.cwt, 0) * 100) / 100
    }
    run(() => updateDoc(doc(db, 'seedTickets', t.id), patch), 'Ticket updated.').then(() => setEdit(null))
  }
  async function exportXlsx() {
    const XLSX = await import('xlsx')
    const rows = list.map((t) => ({
      When: new Date(t.at).toLocaleString(), Type: TYPE_LABEL[t.type], Truck: t.truckNo, 'Ticket #': t.ticketNo || '',
      Supplier: t.supplier || (t.parts || []).map((p) => p.supplier).join(' + '), Variety: t.variety || (t.parts || []).map((p) => p.variety).join(' + '),
      Lot: t.lot || (t.parts || []).map((p) => p.lot).join(' + '), 'Scale lbs': t.scaleLbs ?? '', 'Light lbs': t.lightLbs ?? '', 'Net lbs': t.netLbs ?? '', Cwt: t.cwt,
      Field: t.fieldName || '', Status: t.type === 'pickup' ? t.status : '', Note: t.note || '', By: t.by || '', Deleted: t.deleted ? 'yes' : ''
    }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Seed tickets')
    XLSX.writeFile(wb, `seed_tickets_${ctx.seasonName || ''}.xlsx`)
  }
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div><div className="yields-card-title">Tickets</div><div className="contracts-sub">{list.length} shown. Tap 📷 for the ticket photo.</div></div>
        <div className="agronomy-filter-bar" style={{ margin: 0 }}>
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="all">All types</option>{Object.entries(TYPE_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <input className="agronomy-search-input" style={{ minWidth: 160 }} placeholder="Truck, lot, field…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="hb-check"><input type="checkbox" checked={showDeleted} onChange={(e) => setShowDeleted(e.target.checked)} /> Show deleted</label>
          <button onClick={exportXlsx}>Export to Excel</button>
        </div>
      </div>
      <Msg />
      {edit && (
        <div className="harvest-import">
          <div className="yields-card-title">Edit {TYPE_LABEL[edit.t.type].toLowerCase()} ticket</div>
          <div className="hd-grid" style={{ marginTop: 8 }}>
            <label className="hd-field"><span>Truck #</span><input value={edit.truckNo} onChange={(e) => setEdit({ ...edit, truckNo: e.target.value })} /></label>
            <label className="hd-field"><span>Ticket #</span><input value={edit.ticketNo} onChange={(e) => setEdit({ ...edit, ticketNo: e.target.value })} /></label>
            {edit.t.type !== 'cut' && <label className="hd-field"><span>Cwt</span><input inputMode="decimal" value={edit.cwt} onChange={(e) => setEdit({ ...edit, cwt: e.target.value })} /></label>}
            {edit.t.type === 'pickup' && <>
              <label className="hd-field"><span>Supplier</span><input value={edit.supplier} onChange={(e) => setEdit({ ...edit, supplier: e.target.value })} /></label>
              <label className="hd-field"><span>Variety</span><input value={edit.variety} onChange={(e) => setEdit({ ...edit, variety: e.target.value })} /></label>
              <label className="hd-field"><span>Lot #</span><input value={edit.lot} onChange={(e) => setEdit({ ...edit, lot: e.target.value })} /></label>
              <label className="hd-field"><span>Status</span><select value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="transit">In transit</option><option value="unloaded">Tipped at cutter</option></select></label>
            </>}
            <label className="hd-field"><span>Note</span><input value={edit.note} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
          </div>
          {edit.t.type === 'cut' && (
            <div className="hd-grid" style={{ marginTop: 8 }}>
              {edit.parts.map((p, i) => (
                <label key={i} className="hd-field"><span>{p.variety} lot {p.lot} (cwt)</span>
                  <input inputMode="decimal" value={p.cwt} onChange={(e) => setEdit({ ...edit, parts: edit.parts.map((x, j) => (j === i ? { ...x, cwt: e.target.value } : x)) })} />
                </label>
              ))}
            </div>
          )}
          <div className="agronomy-filter-bar" style={{ marginTop: 10 }}><button className="save" onClick={saveEdit}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div>
        </div>
      )}
      <div className="table-scroll" style={{ maxHeight: 640 }}>
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>When</th><th>Type</th><th>Truck</th><th>Ticket #</th><th>Seed</th><th>Field / status</th><th className="num">Net lbs</th><th className="num">Cwt</th><th /><th /></tr></thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id} className={t.deleted ? 'harvest-done-row' : ''}>
                <td style={{ whiteSpace: 'nowrap' }}>{fmtWhen(t.at)}</td>
                <td><span className={`seed-type ${t.type}`}>{TYPE_LABEL[t.type]}</span></td>
                <td>{t.truckNo}</td><td>{t.ticketNo || ''}</td>
                <td>{t.parts ? t.parts.map((p) => <div key={p.lot + p.supplier}>{lotLabel(p)}{t.parts.length > 1 ? ` — ${fmtCwt(p.cwt, 1)}` : ''}</div>) : lotLabel(t)}</td>
                <td>{t.type === 'pickup' ? (t.status === 'unloaded' ? 'Tipped at cutter' : 'In transit') : t.type === 'cut' ? (trucksById[t.id] ? (trucksById[t.id].loaded ? `${fmtCwt(trucksById[t.id].remaining, 1)} cwt still on` : 'Empty') : '') : t.fieldName || ''}{t.partial ? ' (part load)' : ''}</td>
                <td className="num">{t.netLbs != null ? fmtCwt(t.netLbs) : ''}</td>
                <td className="num"><strong>{fmtCwt(t.cwt, 2)}</strong></td>
                <td>{t.hasPhoto && <button className="clear-sort-btn" onClick={() => openPhoto(t)}>📷</button>}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {t.deleted
                    ? <button className="clear-sort-btn" onClick={() => run(() => updateDoc(doc(db, 'seedTickets', t.id), { deleted: false }), 'Restored.')}>Restore</button>
                    : <>
                      <button className="clear-sort-btn" onClick={() => setEdit({ t, truckNo: t.truckNo || '', ticketNo: t.ticketNo || '', cwt: String(t.cwt ?? ''), supplier: t.supplier || '', variety: t.variety || '', lot: t.lot || '', status: t.status || 'transit', note: t.note || '', parts: t.parts ? t.parts.map((p) => ({ ...p, cwt: String(p.cwt) })) : null })}>Edit</button>{' '}
                      <button className="clear-sort-btn" onClick={() => del(t)}>Delete</button>
                    </>}
                </td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={10} className="contracts-sub">No tickets.</td></tr>}
          </tbody>
        </table>
      </div>
      {photo && (
        <div className="hd-backdrop" onClick={() => setPhoto(null)}>
          <div className="seed-photo-view" onClick={(e) => e.stopPropagation()}>
            {photo.data == null ? 'Loading…' : photo.data === 'none' ? 'Photo not found (it may still be uploading from the driver’s phone).' : <img src={photo.data} alt="Scale ticket" />}
            <button onClick={() => setPhoto(null)}>Close</button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Lots & shrink
// ---------------------------------------------------------------------------
export function SeedLots({ ctx }) {
  const { run, Msg } = useRun()
  const [open, setOpen] = useState(null)
  const fieldName = useMemo(() => Object.fromEntries(ctx.seed.fields.map((f) => [f.fieldId || f.fieldName, f.fieldName])), [ctx.seed.fields])
  function close(L) {
    const left = Math.max(0, L.unloaded - L.cut)
    if (!window.confirm(`Close out ${L.variety} lot ${L.lot} (${L.supplier})?\n\nTipped ${fmtCwt(L.unloaded)} cwt, cut out ${fmtCwt(L.cut)} cwt → ${fmtCwt(left)} cwt (${L.unloaded ? Math.round((left / L.unloaded) * 100) : 0}%) is written off as shrink / cull and the lot leaves the cutting zone.`)) return
    const id = `${ctx.seasonId}__${L.key.replace(/[^A-Z0-9|]/g, '_').replace(/\|/g, '__')}`
    run(() => setDoc(doc(db, 'seedLotClose', id), { seasonId: ctx.seasonId, key: L.key, supplier: L.supplier, variety: L.variety, lot: L.lot, inCwt: L.unloaded, cutCwt: L.cut, shrinkCwt: left, closedAt: Date.now(), by: who() }), `Lot ${L.lot} closed out.`)
  }
  function reopen(L) {
    const c = ctx.closes.find((x) => x.key === L.key)
    if (c) run(() => deleteDoc(doc(db, 'seedLotClose', c.id)), `Lot ${L.lot} reopened.`)
  }
  const totIn = ctx.seed.lots.filter((L) => L.closed).reduce((s, L) => s + L.unloaded, 0)
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Lots — supplier to field</div>
          <div className="contracts-sub">Every lot from pickup to planted. When a lot is done at the cutter, close it out: whatever was tipped but not cut out is written off as shrink / cull.</div>
        </div>
        <div className="contracts-sub" style={{ marginTop: 0 }}>Closed lots: {fmtCwt(ctx.seed.totals.shrink)} cwt shrink{totIn ? ` (${((ctx.seed.totals.shrink / totIn) * 100).toFixed(1)}%)` : ''}</div>
      </div>
      <Msg />
      <div className="table-scroll" style={{ maxHeight: 680 }}>
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>Variety</th><th>Supplier</th><th>Lot</th><th className="num">Picked up</th><th className="num">In transit</th><th className="num">Tipped</th><th className="num">Cut out</th><th className="num">At cutter</th><th className="num">On trucks</th><th className="num">Planted</th><th className="num">Shrink</th><th /></tr></thead>
          <tbody>
            {ctx.seed.lots.map((L) => (
              <Fragment key={L.key}>
                <tr className="clickable" onClick={() => setOpen(open === L.key ? null : L.key)}>
                  <td><strong>{L.variety}</strong></td><td>{L.supplier}</td><td>{L.lot}</td>
                  <td className="num">{fmtCwt(L.picked)}</td><td className="num">{L.transit ? fmtCwt(L.transit) : ''}</td><td className="num">{fmtCwt(L.unloaded)}</td>
                  <td className="num">{fmtCwt(L.cut)}</td><td className="num">{L.closed ? <span className="contracts-sub">closed</span> : fmtCwt(L.zone)}{L.overCut && <span className="hb-tag warn">over-cut</span>}</td>
                  <td className="num">{L.onTrucks ? fmtCwt(L.onTrucks) : ''}</td><td className="num">{fmtCwt(L.planted)}</td>
                  <td className="num">{L.closed ? `${fmtCwt(L.shrink)} (${L.shrinkPct != null ? (L.shrinkPct * 100).toFixed(1) : '—'}%)` : ''}</td>
                  <td onClick={(e) => e.stopPropagation()} style={{ whiteSpace: 'nowrap' }}>
                    {L.closed ? <button className="clear-sort-btn" onClick={() => reopen(L)}>Reopen</button>
                      : <button className="clear-sort-btn" disabled={!(L.unloaded > 0) || L.transit > 0} title={L.transit > 0 ? 'Some of this lot is still in transit' : ''} onClick={() => close(L)}>Close out</button>}
                  </td>
                </tr>
                {open === L.key && (
                  <tr><td colSpan={12} className="seed-lot-detail">
                    <strong>Planted at:</strong> {Object.entries(L.fields).length ? Object.entries(L.fields).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${fieldName[k] || k} ${fmtCwt(v, 1)} cwt`).join(' · ') : 'nowhere yet'}
                    {L.writtenOff > 0 && <> · <strong>Written off off trucks:</strong> {fmtCwt(L.writtenOff, 1)} cwt</>}
                    <span className="contracts-sub"> · {L.pickups} pickup load{L.pickups === 1 ? '' : 's'}, {L.cutTrucks} cut-seed truck{L.cutTrucks === 1 ? '' : 's'}</span>
                  </td></tr>
                )}
              </Fragment>
            ))}
            {!ctx.seed.lots.length && <tr><td colSpan={12} className="contracts-sub">No lots yet — they appear with the first pickup ticket.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Planted by field (+ write-off of what's left on a truck)
// ---------------------------------------------------------------------------
export function SeedReport({ ctx }) {
  const { run, Msg } = useRun()
  const [q, setQ] = useState('')
  const fields = ctx.seed.fields.filter((f) => !q || `${f.fieldName} ${f.farmName || ''} ${Object.values(f.lots).map(lotLabel).join(' ')}`.toLowerCase().includes(q.toLowerCase()))
  async function exportXlsx() {
    const XLSX = await import('xlsx')
    const rows = []
    ctx.seed.fields.forEach((f) => Object.values(f.lots).forEach((l) => rows.push({
      Field: f.fieldName, Farm: f.farmName || '', 'Field acres': f.acres || '', Supplier: l.supplier, Variety: l.variety, Lot: l.lot,
      'Cwt planted': Math.round(l.cwt * 100) / 100, 'Field total cwt': Math.round(f.total * 100) / 100, 'Cwt / acre': f.acres ? Math.round((f.total / f.acres) * 10) / 10 : ''
    })))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Planted by field')
    XLSX.writeFile(wb, `seed_planted_${ctx.seasonName || ''}.xlsx`)
  }
  function writeOff(t) {
    const v = window.prompt(`Write off cut seed left on truck ${t.truckNo}? It has ${fmtCwt(t.remaining, 1)} cwt. How many cwt to write off (dumped / not planted)?`, String(t.remaining))
    const cwt = Math.min(t.remaining, Number(v) || 0)
    if (!(cwt > 0)) return
    run(() => setDoc(doc(db, 'seedTickets', newId()), {
      seasonId: ctx.seasonId, type: 'writeoff', cutTicketId: t.id, truckNo: t.truckNo, truckKey: truckKey(t.truckNo), fieldId: null, fieldName: null,
      cwt, parts: allocateUnload(t, cwt), at: Date.now(), by: who(), note: 'Written off by manager'
    }), `Wrote off ${fmtCwt(cwt, 1)} cwt from truck ${t.truckNo}.`)
  }
  return (
    <>
      <div className="yields-card">
        <div className="yields-card-head">
          <div><div className="yields-card-title">Seed planted by field</div><div className="contracts-sub">cwt of each lot unloaded at each Agworld field, and the seeding rate from Agworld acres.</div></div>
          <div className="agronomy-filter-bar" style={{ margin: 0 }}>
            <input className="agronomy-search-input" style={{ minWidth: 160 }} placeholder="Field, variety, lot…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button onClick={exportXlsx} disabled={!ctx.seed.fields.length}>Export to Excel</button>
          </div>
        </div>
        <Msg />
        <div className="table-scroll" style={{ maxHeight: 640 }}>
          <table className="contracts-table contracts-table-auto">
            <thead><tr><th>Field</th><th>Farm</th><th>Variety</th><th>Supplier</th><th>Lot</th><th className="num">Cwt</th><th className="num">Field total</th><th className="num">Acres</th><th className="num">Cwt / ac</th><th>Planted</th></tr></thead>
            <tbody>
              {fields.map((f) => Object.values(f.lots).sort((a, b) => b.cwt - a.cwt).map((l, i, arr) => (
                <tr key={f.fieldName + l.lot + l.supplier}>
                  {i === 0 && <td rowSpan={arr.length}><strong>{f.fieldName}</strong></td>}
                  {i === 0 && <td rowSpan={arr.length}>{f.farmName || ''}</td>}
                  <td>{l.variety}</td><td>{l.supplier}</td><td>{l.lot}</td><td className="num">{fmtCwt(l.cwt, 1)}</td>
                  {i === 0 && <td rowSpan={arr.length} className="num"><strong>{fmtCwt(f.total, 1)}</strong></td>}
                  {i === 0 && <td rowSpan={arr.length} className="num">{f.acres ? fmtCwt(f.acres) : ''}</td>}
                  {i === 0 && <td rowSpan={arr.length} className="num">{f.acres ? fmtCwt(f.total / f.acres, 1) : ''}</td>}
                  {i === 0 && <td rowSpan={arr.length} className="contracts-sub" style={{ whiteSpace: 'nowrap' }}>{fmtWhen(f.first)}{f.last !== f.first ? ` – ${fmtWhen(f.last)}` : ''} · {f.loads} load{f.loads === 1 ? '' : 's'}</td>}
                </tr>
              )))}
              {!fields.length && <tr><td colSpan={10} className="contracts-sub">Nothing planted yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {ctx.seed.loadedTrucks.length > 0 && (
        <div className="yields-card">
          <div className="yields-card-title">Seed still on trucks</div>
          <div className="contracts-sub">If seed was dumped or won’t be planted, write it off so the truck clears from inventory.</div>
          <table className="contracts-table contracts-table-auto" style={{ marginTop: 8 }}>
            <tbody>
              {ctx.seed.loadedTrucks.map((t) => (
                <tr key={t.id}><td>Truck {t.truckNo}</td><td>{t.parts.filter((p) => p.remaining > 0.05).map(lotLabel).join(' + ')}</td><td className="num">{fmtCwt(t.remaining, 1)} cwt</td><td>{fmtWhen(t.at)}</td><td><button className="clear-sort-btn" onClick={() => writeOff(t)}>Write off…</button></td></tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
export function SeedSettings({ ctx }) {
  const { run, Msg } = useRun()
  const [cap, setCap] = useState(String(ctx.settings.zoneCapacity))
  const [warn, setWarn] = useState(String(ctx.settings.ageWarnHours))
  const [alarm, setAlarm] = useState(String(ctx.settings.ageAlarmHours))
  const [nt, setNt] = useState({ truckNo: '', lightLbs: '' })
  const [edits, setEdits] = useState({})
  const trucks = Object.values(ctx.trucks).sort((a, b) => String(a.truckNo).localeCompare(String(b.truckNo), undefined, { numeric: true }))
  const lastUse = {}
  ctx.tickets.forEach((t) => { if (t.truckKey) lastUse[t.truckKey] = Math.max(lastUse[t.truckKey] || 0, t.at) })
  function saveTruck(no, lbs) {
    const k = truckKey(no)
    if (!k || !(Number(lbs) > 0)) return
    run(() => setDoc(doc(db, 'seedTrucks', k), { truckNo: String(no).trim(), lightLbs: Number(lbs), updatedBy: who(), updatedAt: Date.now() }), `Truck ${no} saved.`)
  }
  return (
    <>
      <Msg />
      <div className="harvest-two">
        <div className="yields-card">
          <div className="yields-card-title">Truck light weights</div>
          <div className="contracts-sub">Empty weight of each truck, entered once. Drivers type the scale weight; AIO takes this off to get net. A driver can add a truck the first time they use it.</div>
          <table className="contracts-table contracts-table-auto" style={{ marginTop: 8 }}>
            <thead><tr><th>Truck #</th><th className="num">Light weight (lbs)</th><th>Last used</th><th /></tr></thead>
            <tbody>
              {trucks.map((t) => (
                <tr key={t.id}>
                  <td><strong>{t.truckNo}</strong></td>
                  <td className="num"><input className="yields-cell-input" inputMode="numeric" value={edits[t.id] ?? t.lightLbs} onChange={(e) => setEdits({ ...edits, [t.id]: e.target.value })} /></td>
                  <td className="contracts-sub">{lastUse[t.id] ? fmtWhen(lastUse[t.id]) : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {edits[t.id] != null && String(edits[t.id]) !== String(t.lightLbs) && <button className="clear-sort-btn" onClick={() => { saveTruck(t.truckNo, edits[t.id]); setEdits({ ...edits, [t.id]: undefined }) }}>Save</button>}{' '}
                    <button className="clear-sort-btn" onClick={() => { if (window.confirm(`Remove truck ${t.truckNo}?`)) run(() => deleteDoc(doc(db, 'seedTrucks', t.id))) }}>Remove</button>
                  </td>
                </tr>
              ))}
              <tr>
                <td><input className="yields-cell-input" style={{ width: 80, textAlign: 'left' }} placeholder="Truck #" value={nt.truckNo} onChange={(e) => setNt({ ...nt, truckNo: e.target.value })} /></td>
                <td className="num"><input className="yields-cell-input" inputMode="numeric" placeholder="lbs" value={nt.lightLbs} onChange={(e) => setNt({ ...nt, lightLbs: e.target.value })} /></td>
                <td /><td><button className="clear-sort-btn" disabled={!nt.truckNo.trim() || !(Number(nt.lightLbs) > 0)} onClick={() => { saveTruck(nt.truckNo, nt.lightLbs); setNt({ truckNo: '', lightLbs: '' }) }}>Add</button></td>
              </tr>
            </tbody>
          </table>
        </div>
        <div className="yields-card">
          <div className="yields-card-title">Cutter &amp; inventory</div>
          <div className="hd-grid" style={{ marginTop: 8 }}>
            <label className="hd-field"><span>Cutting zone holds (cwt)</span><input inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} /></label>
            <label className="hd-field"><span>Loaded truck — amber after (hours)</span><input inputMode="numeric" value={warn} onChange={(e) => setWarn(e.target.value)} /></label>
            <label className="hd-field"><span>Loaded truck — red after (hours)</span><input inputMode="numeric" value={alarm} onChange={(e) => setAlarm(e.target.value)} /></label>
          </div>
          <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
            <button className="save" onClick={() => run(() => setDoc(doc(db, 'seedSettings', ctx.seasonId), { seasonId: ctx.seasonId, zoneCapacity: Number(cap) || 2500, ageWarnHours: Number(warn) || 24, ageAlarmHours: Number(alarm) || 48, updatedBy: who(), updatedAt: Date.now() }), 'Settings saved.')}>Save</button>
          </div>
          <div className="contracts-sub">Cut seed sitting on a truck too long is flagged amber, then red, in the loaded-truck inventory.</div>
        </div>
      </div>
    </>
  )
}

