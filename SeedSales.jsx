import { Fragment, useMemo, useState } from 'react'
import { deleteDoc, doc, setDoc, updateDoc, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { fmtCwt, fmtWhen, newId } from './seedMath.js'

// Potato Seed > Seed sales: seed sold to customers — what each customer has
// contracted and what has shipped against it, load by load.
//   seedSales/{id}      seasonId, customer, variety, contractedCwt, pricePerCwt,
//                       generation, lots, notes
//   seedShipments/{id}  seasonId, saleId, customer, variety, at, cwt, truckNo,
//                       ticketNo, lot, note
// Admin, Owner and Farm manager add and change everything here (firestore.rules).

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
const fromLocalInput = (s) => { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : null }
const money = (n) => (n == null ? '' : `$${Math.round(n).toLocaleString()}`)

const BLANK_SALE = { customer: '', variety: '', contractedCwt: '', pricePerCwt: '', generation: '', lots: '', notes: '' }
const blankShip = () => ({ when: toLocalInput(Date.now()), cwt: '', unit: 'cwt', truckNo: '', ticketNo: '', lot: '', note: '' })

export default function SeedSales({ ctx }) {
  const S = ctx.salesCalc
  const [msg, setMsg] = useState(null)
  const [edit, setEdit] = useState(null) // sale form
  const [open, setOpen] = useState(null) // sale id whose loads are shown
  const [ship, setShip] = useState(null) // { saleId, id|null, ...form }
  const [q, setQ] = useState('')
  const canEdit = ctx.canManage
  const run = (fn, ok) => {
    setMsg(null)
    let p
    try { p = Promise.resolve(fn()) } catch (e) { p = Promise.reject(e) }
    p.catch((e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin, Owner or Farm manager can change seed sales.' : e.message }))
    if (ok) setMsg({ ok: true, text: ok + (navigator.onLine === false ? ' (offline — it will sync when you’re back online)' : '') })
    return Promise.resolve()
  }
  const customers = useMemo(() => [...new Set(ctx.sales.map((c) => c.customer).filter(Boolean))].sort(), [ctx.sales])
  const varieties = useMemo(() => [...new Set([...ctx.sales.map((c) => c.variety), ...ctx.contracts.map((c) => c.variety)].filter(Boolean))].sort(), [ctx.sales, ctx.contracts])
  const rows = S.rows.filter((r) => !q || `${r.customer} ${r.variety} ${r.generation || ''} ${(r.lots || []).join(' ')} ${r.notes || ''}`.toLowerCase().includes(q.toLowerCase()))
  const multi = Object.fromEntries(S.customers.filter((c) => c.sales > 1).map((c) => [c.customer, c]))

  function saveSale() {
    const f = edit
    if (!f.customer.trim() || !f.variety.trim()) return
    const data = {
      seasonId: ctx.seasonId, customer: f.customer.trim(), variety: f.variety.trim(), contractedCwt: Number(f.contractedCwt) || 0,
      pricePerCwt: Number(f.pricePerCwt) > 0 ? Number(f.pricePerCwt) : null, generation: String(f.generation || '').trim() || null,
      lots: String(f.lots || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean), notes: String(f.notes || '').trim() || null,
      updatedBy: who(), updatedAt: Date.now()
    }
    const old = f.id ? ctx.sales.find((c) => c.id === f.id) : null
    const renamed = old && (old.customer !== data.customer || old.variety !== data.variety)
    run(async () => {
      const b = writeBatch(db)
      b.set(doc(db, 'seedSales', f.id || newId()), data)
      // keep the loads' customer / variety in step with the sale
      if (renamed) ctx.shipments.filter((s) => s.saleId === f.id).forEach((s) => b.update(doc(db, 'seedShipments', s.id), { customer: data.customer, variety: data.variety }))
      await b.commit()
    }, f.id ? 'Sale updated.' : `Sale added: ${data.customer} · ${data.variety}.`).then(() => setEdit(null))
  }
  function delSale(r) {
    const loads = ctx.shipments.filter((s) => s.saleId === r.id)
    if (loads.length && !ctx.isAdmin) return
    if (!window.confirm(`Delete the ${r.customer} ${r.variety} sale${loads.length ? ` and its ${loads.length} shipped load${loads.length === 1 ? '' : 's'}` : ''}?`)) return
    run(async () => {
      const b = writeBatch(db)
      b.delete(doc(db, 'seedSales', r.id))
      loads.forEach((s) => b.delete(doc(db, 'seedShipments', s.id)))
      await b.commit()
    }, 'Sale deleted.')
  }
  function saveShip() {
    const f = ship
    const sale = ctx.sales.find((c) => c.id === f.saleId)
    const raw = Number(f.cwt)
    if (!sale || !(raw > 0)) return
    const cwt = Math.round((f.unit === 'lbs' ? raw / 100 : raw) * 100) / 100
    const data = {
      seasonId: ctx.seasonId, saleId: sale.id, customer: sale.customer, variety: sale.variety, at: fromLocalInput(f.when) || Date.now(), cwt,
      netLbs: Math.round(cwt * 100), truckNo: f.truckNo.trim() || null, ticketNo: f.ticketNo.trim() || null, lot: f.lot.trim() || null, note: f.note.trim() || null,
      ...(f.id ? { editedBy: who(), editedAt: Date.now() } : { by: who(), createdAt: Date.now() })
    }
    run(() => (f.id ? updateDoc(doc(db, 'seedShipments', f.id), data) : setDoc(doc(db, 'seedShipments', newId()), data)),
      f.id ? 'Load updated.' : `Shipped ${fmtCwt(cwt, 1)} cwt to ${sale.customer}.`).then(() => setShip(null))
  }
  async function exportXlsx() {
    const XLSX = await import('xlsx')
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.rows.map((r) => ({
      Customer: r.customer, Variety: r.variety, Generation: r.generation || '', Lots: (r.lots || []).join(', '), 'Contracted cwt': Number(r.contractedCwt) || 0,
      'Shipped cwt': r.shipped, 'Remaining cwt': r.remaining, Loads: r.loads, '$/cwt': r.pricePerCwt ?? '', 'Contract $': r.value ?? '', 'Shipped $': r.shippedValue ?? '', Notes: r.notes || ''
    }))), 'Seed sales')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(S.rows.flatMap((r) => r.shipments.map((s) => ({
      Date: new Date(s.at).toLocaleString(), Customer: r.customer, Variety: r.variety, Cwt: s.cwt, 'Truck #': s.truckNo || '', 'Ticket #': s.ticketNo || '', Lot: s.lot || '', Note: s.note || ''
    })))), 'Loads shipped')
    XLSX.writeFile(wb, `seed_sales_${ctx.seasonName || ''}.xlsx`)
  }

  const T = S.totals
  const tpct = T.contracted > 0 ? T.shipped / T.contracted : null
  const shipForm = (r) => ship && ship.saleId === r.id && (
    <tr><td colSpan={11} className="seed-lot-detail">
      <div className="yields-card-title" style={{ fontSize: 14 }}>{ship.id ? 'Edit load' : `Ship a load to ${r.customer}`} · {r.variety}</div>
      <div className="hd-grid" style={{ marginTop: 6 }}>
        <label className="hd-field"><span>Date &amp; time</span><input type="datetime-local" value={ship.when} onChange={(e) => setShip({ ...ship, when: e.target.value })} /></label>
        <label className="hd-field"><span>Amount</span>
          <div className="fm-row" style={{ flexWrap: 'nowrap' }}>
            <input inputMode="decimal" autoFocus value={ship.cwt} onChange={(e) => setShip({ ...ship, cwt: e.target.value.replace(/[^\d.]/g, '') })} placeholder={ship.unit} />
            <select className="seed-unit" value={ship.unit} onChange={(e) => setShip({ ...ship, unit: e.target.value })} aria-label="Unit"><option value="cwt">cwt</option><option value="lbs">lbs</option></select>
          </div>
        </label>
        <label className="hd-field"><span>Truck #</span><input value={ship.truckNo} onChange={(e) => setShip({ ...ship, truckNo: e.target.value })} /></label>
        <label className="hd-field"><span>Ticket / BOL #</span><input value={ship.ticketNo} onChange={(e) => setShip({ ...ship, ticketNo: e.target.value })} /></label>
        <label className="hd-field"><span>Lot</span><input list="ss-lots" value={ship.lot} onChange={(e) => setShip({ ...ship, lot: e.target.value })} /></label>
        <label className="hd-field"><span>Note</span><input value={ship.note} onChange={(e) => setShip({ ...ship, note: e.target.value })} /></label>
      </div>
      <datalist id="ss-lots">{(r.lots || []).map((l) => <option key={l} value={l} />)}</datalist>
      {ship.unit === 'lbs' && Number(ship.cwt) > 0 && <div className="contracts-sub">= {fmtCwt(Number(ship.cwt) / 100, 2)} cwt</div>}
      {!ship.id && Number(ship.cwt) > 0 && r.remaining - (ship.unit === 'lbs' ? Number(ship.cwt) / 100 : Number(ship.cwt)) < -0.5 && <div className="fm-note">That ships more than the {fmtCwt(Math.max(0, r.remaining), 1)} cwt left on this sale.</div>}
      <div className="agronomy-filter-bar" style={{ marginTop: 8 }}><button className="save" disabled={!(Number(ship.cwt) > 0)} onClick={saveShip}>{ship.id ? 'Save' : 'Save load'}</button><button onClick={() => setShip(null)}>Cancel</button></div>
    </td></tr>
  )

  return (
    <>
      <div className="seed-need-sum seed-sales-sum">
        <div><span>Contracted</span><strong>{fmtCwt(T.contracted)}</strong><small>cwt · {S.customers.length} customer{S.customers.length === 1 ? '' : 's'}</small></div>
        <div className="ok"><span>Shipped</span><strong>{fmtCwt(T.shipped)}</strong><small>cwt{tpct != null ? ` · ${Math.round(tpct * 100)}%` : ''} · {T.loads} load{T.loads === 1 ? '' : 's'}</small></div>
        <div><span>Left to ship</span><strong>{fmtCwt(Math.max(0, T.remaining))}</strong><small>cwt</small></div>
        {T.value > 0 && <div><span>Contract value</span><strong>{money(T.value)}</strong><small>{money(T.shippedValue)} shipped</small></div>}
      </div>
      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Seed sales — crop year {ctx.seasonName}</div>
            <div className="contracts-sub">One line per customer and variety. Click a line for its loads; + Load logs a shipment.</div>
          </div>
          <div className="agronomy-filter-bar" style={{ margin: 0 }}>
            <input className="agronomy-search-input" style={{ minWidth: 150 }} placeholder="Customer, variety…" value={q} onChange={(e) => setQ(e.target.value)} />
            <button onClick={exportXlsx} disabled={!S.rows.length}>Export to Excel</button>
            {canEdit && <button className="save" onClick={() => { setEdit({ ...BLANK_SALE, id: null }); setShip(null) }}>+ Add sale</button>}
          </div>
        </div>
        {msg && <div className={msg.ok ? 'yields-ok' : 'agronomy-error-banner'} style={{ marginTop: 0, marginBottom: 10 }} onClick={() => setMsg(null)}>{msg.text}</div>}
        {edit && (
          <div className="harvest-import">
            <div className="hd-grid">
              <label className="hd-field"><span>Customer</span><input list="ss-cust" value={edit.customer} onChange={(e) => setEdit({ ...edit, customer: e.target.value })} autoFocus /></label>
              <label className="hd-field"><span>Variety</span><input list="ss-var" value={edit.variety} onChange={(e) => setEdit({ ...edit, variety: e.target.value })} /></label>
              <label className="hd-field"><span>Contracted (cwt)</span><input inputMode="decimal" value={edit.contractedCwt} onChange={(e) => setEdit({ ...edit, contractedCwt: e.target.value })} /></label>
              <label className="hd-field"><span>Price ($/cwt)</span><input inputMode="decimal" value={edit.pricePerCwt} onChange={(e) => setEdit({ ...edit, pricePerCwt: e.target.value })} /></label>
              <label className="hd-field"><span>Generation / class</span><input value={edit.generation} onChange={(e) => setEdit({ ...edit, generation: e.target.value })} placeholder="e.g. G3" /></label>
              <label className="hd-field"><span>Lot #s (comma separated)</span><input value={edit.lots} onChange={(e) => setEdit({ ...edit, lots: e.target.value })} /></label>
              <label className="hd-field"><span>Notes</span><input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
            </div>
            <datalist id="ss-cust">{customers.map((s) => <option key={s} value={s} />)}</datalist>
            <datalist id="ss-var">{varieties.map((s) => <option key={s} value={s} />)}</datalist>
            <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
              <button className="save" disabled={!edit.customer.trim() || !edit.variety.trim()} onClick={saveSale}>Save</button>
              <button onClick={() => setEdit(null)}>Cancel</button>
            </div>
          </div>
        )}
        <div className="table-scroll">
          <table className="contracts-table contracts-table-auto">
            <thead><tr>
              <th>Customer</th><th>Variety</th><th>Gen</th><th className="num">Contracted</th><th className="num">Shipped</th><th style={{ width: '16%' }} />
              <th className="num">Left to ship</th><th className="num">Loads</th><th>Last load</th><th className="num">$/cwt</th><th />
            </tr></thead>
            <tbody>
              {rows.map((r, i) => {
                const firstOfCustomer = i === 0 || rows[i - 1].customer !== r.customer
                const lastOfCustomer = i === rows.length - 1 || rows[i + 1].customer !== r.customer
                const sub = multi[r.customer]
                return (
                  <Fragment key={r.id}>
                    <tr className="clickable" onClick={() => setOpen(open === r.id ? null : r.id)}>
                      <td>{firstOfCustomer ? <strong>{r.customer}</strong> : ''}</td><td>{r.variety}</td><td>{r.generation || ''}</td>
                      <td className="num">{fmtCwt(r.contractedCwt)}</td><td className="num">{fmtCwt(r.shipped)}</td>
                      <td>{r.pct != null && <div className="seed-bar"><div style={{ width: `${Math.min(100, r.pct * 100)}%` }} className={r.pct > 1.02 ? 'over' : ''} /><span>{Math.round(r.pct * 100)}%</span></div>}</td>
                      <td className="num" style={{ color: r.remaining < -1 ? '#A32D2D' : undefined }}>{r.remaining < -1 ? `${fmtCwt(-r.remaining)} over` : fmtCwt(r.remaining)}</td>
                      <td className="num">{r.loads}</td><td className="contracts-sub" style={{ whiteSpace: 'nowrap' }}>{r.lastAt ? fmtWhen(r.lastAt) : '—'}</td>
                      <td className="num">{r.pricePerCwt != null ? `$${r.pricePerCwt}` : ''}</td>
                      <td style={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        {canEdit && <>
                          <button className="clear-sort-btn" onClick={() => { setOpen(r.id); setEdit(null); setShip({ ...blankShip(), saleId: r.id, id: null, lot: (r.lots || []).length === 1 ? r.lots[0] : '' }) }}>+ Load</button>{' '}
                          <button className="clear-sort-btn" onClick={() => { setShip(null); setEdit({ ...BLANK_SALE, ...r, contractedCwt: String(r.contractedCwt ?? ''), pricePerCwt: r.pricePerCwt ?? '', generation: r.generation || '', lots: (r.lots || []).join(', '), notes: r.notes || '' }) }}>Edit</button>{' '}
                          <button className="clear-sort-btn" disabled={r.loads > 0 && !ctx.isAdmin} title={r.loads && !ctx.isAdmin ? 'Has shipped loads — delete those first (or ask an Admin)' : ''} onClick={() => delSale(r)}>Delete</button>
                        </>}
                      </td>
                    </tr>
                    {shipForm(r)}
                    {open === r.id && (
                      <tr><td colSpan={11} className="seed-lot-detail">
                        {r.notes && <div className="contracts-sub" style={{ marginTop: 0, marginBottom: 6 }}>{r.notes}{(r.lots || []).length ? ` · lots ${r.lots.join(', ')}` : ''}</div>}
                        {r.shipments.length ? (
                          <table className="contracts-table contracts-table-auto seed-ship-table">
                            <thead><tr><th>Shipped</th><th className="num">Cwt</th><th>Truck #</th><th>Ticket / BOL #</th><th>Lot</th><th>Note</th><th /></tr></thead>
                            <tbody>
                              {r.shipments.map((s) => (
                                <tr key={s.id}>
                                  <td style={{ whiteSpace: 'nowrap' }}>{fmtWhen(s.at)}</td><td className="num"><strong>{fmtCwt(s.cwt, 1)}</strong></td>
                                  <td>{s.truckNo || ''}</td><td>{s.ticketNo || ''}</td><td>{s.lot || ''}</td><td className="contracts-sub">{s.note || ''}</td>
                                  <td style={{ whiteSpace: 'nowrap' }}>{canEdit && <>
                                    <button className="clear-sort-btn" onClick={() => setShip({ saleId: r.id, id: s.id, when: toLocalInput(s.at), cwt: String(s.cwt ?? ''), unit: 'cwt', truckNo: s.truckNo || '', ticketNo: s.ticketNo || '', lot: s.lot || '', note: s.note || '' })}>Edit</button>{' '}
                                    <button className="clear-sort-btn" onClick={() => { if (window.confirm(`Delete the ${fmtCwt(s.cwt, 1)} cwt load shipped ${fmtWhen(s.at)}?`)) run(() => deleteDoc(doc(db, 'seedShipments', s.id)), 'Load deleted.') }}>Delete</button>
                                  </>}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        ) : <div className="contracts-sub" style={{ marginTop: 0 }}>Nothing shipped on this sale yet.</div>}
                      </td></tr>
                    )}
                    {lastOfCustomer && sub && !q && (
                      <tr className="seed-sales-sub">
                        <td colSpan={3}>{r.customer} total</td><td className="num">{fmtCwt(sub.contracted)}</td><td className="num">{fmtCwt(sub.shipped)}</td><td />
                        <td className="num">{fmtCwt(Math.max(0, sub.contracted - sub.shipped))}</td><td className="num">{sub.loads}</td><td colSpan={3} />
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {!rows.length && <tr><td colSpan={11} className="contracts-sub">{S.rows.length ? 'No sales match.' : `No seed sales for crop year ${ctx.seasonName || ''} yet.${canEdit ? ' Use + Add sale.' : ''}`}</td></tr>}
            </tbody>
            {S.rows.length > 1 && !q && (
              <tfoot><tr>
                <td colSpan={3}><strong>Total</strong></td><td className="num"><strong>{fmtCwt(T.contracted)}</strong></td><td className="num"><strong>{fmtCwt(T.shipped)}</strong></td>
                <td>{tpct != null && <div className="seed-bar"><div style={{ width: `${Math.min(100, tpct * 100)}%` }} /><span>{Math.round(tpct * 100)}%</span></div>}</td>
                <td className="num"><strong>{fmtCwt(Math.max(0, T.remaining))}</strong></td><td className="num"><strong>{T.loads}</strong></td><td colSpan={3} />
              </tr></tfoot>
            )}
          </table>
        </div>
      </div>
    </>
  )
}
