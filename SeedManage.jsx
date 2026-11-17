import { Fragment, useMemo, useState } from 'react'
import { deleteDoc, doc, getDoc, setDoc, updateDoc, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { allocateUnload, compressImage, fmtCwt, fmtWhen, lotKey, lotLabel, newId, truckKey, varietyKey } from './seedMath.js'
import { TYPE_LABEL } from './Seed.jsx'

// Manager tabs of the Potato Seed module: seed needs and contracts, every
// ticket (with the photo, edit and delete), lots & shrink close-out, the
// planted-by-field report and settings (truck light weights, cutting-zone
// limit). Admin / Owner (ctx.isAdmin) also get: ticket date, field and lot
// changes, photo replace/remove, delete for good, lot renames through the
// whole trail, close-out shrink edits, and deleting a contract that has
// pickups.

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
// <input type="datetime-local"> works in local time without a zone.
const toLocalInput = (ms) => { if (!ms) return ''; const d = new Date(ms); return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16) }
const fromLocalInput = (s) => { const t = new Date(s).getTime(); return Number.isFinite(t) ? t : null }
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
const BLANK = { supplier: '', variety: '', contractedCwt: '', seedingRate: '', lots: '', generation: '', pricePerCwt: '', notes: '', carry: true }
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
      seedingRate: f.seedingRate === '' || !(Number(f.seedingRate) > 0) ? null : Number(f.seedingRate),
      lots: String(f.lots || '').split(/[,;\n]/).map((x) => x.trim()).filter(Boolean),
      generation: String(f.generation || '').trim() || null, pricePerCwt: f.pricePerCwt === '' || f.pricePerCwt == null ? null : Number(f.pricePerCwt), notes: String(f.notes || '').trim() || null,
      updatedBy: who(), updatedAt: Date.now()
    }
    const old = f.id ? ctx.contracts.find((c) => c.id === f.id) : null
    const renamed = old && (old.supplier !== data.supplier || old.variety !== data.variety)
    run(async () => {
      const b = writeBatch(db)
      b.set(doc(db, 'seedContracts', f.id || newId()), data)
      if (renamed && f.carry) carryRename(b, old, data)
      await b.commit()
    }, f.id ? `Contract updated${renamed && f.carry ? ' — tickets and lots on it changed to match' : ''}.` : 'Contract added.').then(() => setEdit(null))
  }
  // A contract's grower or variety changed: change the tickets that came off
  // it, and the same lots all the way through cutting, planting and close-out,
  // so the lot trail still lines up.
  function carryRename(b, old, data) {
    const pickups = ctx.tickets.filter((t) => t.type === 'pickup' && t.contractId === old.id)
    const lotNames = new Set(pickups.map((t) => t.lot))
    const oldKeys = new Set(pickups.map((t) => lotKey(old.supplier, old.variety, t.lot)))
    pickups.forEach((t) => b.update(doc(db, 'seedTickets', t.id), { supplier: data.supplier, variety: data.variety, lotKey: lotKey(data.supplier, data.variety, t.lot), editedBy: who(), editedAt: Date.now() }))
    ctx.tickets.filter((t) => t.parts && t.parts.some((p) => oldKeys.has(lotKey(p.supplier, p.variety, p.lot)))).forEach((t) => {
      const parts = t.parts.map((p) => (oldKeys.has(lotKey(p.supplier, p.variety, p.lot)) ? { ...p, supplier: data.supplier, variety: data.variety } : p))
      b.update(doc(db, 'seedTickets', t.id), { parts, varieties: [...new Set(parts.map((p) => p.variety))], editedBy: who(), editedAt: Date.now() })
    })
    ctx.closes.filter((c) => lotNames.has(c.lot) && oldKeys.has(c.key)).forEach((c) => b.update(doc(db, 'seedLotClose', c.id), { supplier: data.supplier, variety: data.variety, key: lotKey(data.supplier, data.variety, c.lot) }))
  }
  const editing = edit && edit.id ? ctx.contracts.find((c) => c.id === edit.id) : null
  const editLoads = editing ? (rowsById[editing.id] || {}).loads || 0 : 0
  const editRenamed = editing && (editing.supplier !== edit.supplier.trim() || editing.variety !== edit.variety.trim())
  const previewAcres = Number(edit && edit.contractedCwt) > 0 && Number(edit && edit.seedingRate) > 0 ? Number(edit.contractedCwt) / Number(edit.seedingRate) : null
  const sorted = [...ctx.contracts].sort((a, b) => a.supplier.localeCompare(b.supplier) || a.variety.localeCompare(b.variety))
  function delContract(c, loads) {
    if (!loads) {
      if (window.confirm(`Delete the ${c.supplier} ${c.variety} contract?`)) run(() => deleteDoc(doc(db, 'seedContracts', c.id)), 'Contract deleted.')
      return
    }
    // Admin only: the pickups stay (the seed was really picked up) but no
    // longer count against a contract.
    if (!window.confirm(`Delete the ${c.supplier} ${c.variety} contract?\n\nIt has ${loads} pickup ticket${loads === 1 ? '' : 's'}. They stay in inventory and the lot trail, but show as “no contract” until you add a contract for ${c.supplier} · ${c.variety} again.`)) return
    run(async () => {
      const b = writeBatch(db)
      b.delete(doc(db, 'seedContracts', c.id))
      ctx.tickets.filter((t) => t.type === 'pickup' && t.contractId === c.id).forEach((t) => b.update(doc(db, 'seedTickets', t.id), { contractId: null, editedBy: who(), editedAt: Date.now() }))
      await b.commit()
    }, `Contract deleted — ${loads} pickup ticket${loads === 1 ? '' : 's'} kept with no contract.`)
  }
  return (
    <>
    <SeedNeeds ctx={ctx} />
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
            <label className="hd-field"><span>Avg seeding rate (cwt/ac)</span><input inputMode="decimal" placeholder="e.g. 22" value={edit.seedingRate} onChange={(e) => setEdit({ ...edit, seedingRate: e.target.value })} /></label>
            <div className="hd-field"><span>Plants about</span><div className="seed-readout" style={{ padding: '6px 0' }}>{previewAcres != null ? `${fmtCwt(previewAcres)} acres` : '—'}</div></div>
            <label className="hd-field"><span>Lot #s (comma separated)</span><input value={edit.lots} onChange={(e) => setEdit({ ...edit, lots: e.target.value })} /></label>
            <label className="hd-field"><span>Generation / class</span><input value={edit.generation} onChange={(e) => setEdit({ ...edit, generation: e.target.value })} placeholder="e.g. G3" /></label>
            <label className="hd-field"><span>Price ($/cwt)</span><input inputMode="decimal" value={edit.pricePerCwt} onChange={(e) => setEdit({ ...edit, pricePerCwt: e.target.value })} /></label>
            <label className="hd-field"><span>Notes</span><input value={edit.notes} onChange={(e) => setEdit({ ...edit, notes: e.target.value })} /></label>
          </div>
          <datalist id="sc-sup">{suppliers.map((s) => <option key={s} value={s} />)}</datalist>
          <datalist id="sc-var">{varieties.map((s) => <option key={s} value={s} />)}</datalist>
          {editRenamed && editLoads > 0 && (
            <label className="hb-check" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={edit.carry} onChange={(e) => setEdit({ ...edit, carry: e.target.checked })} />
              Also change the {editLoads} pickup ticket{editLoads === 1 ? '' : 's'} on this contract — and those lots through cutting, planting and close-out — to {edit.supplier.trim() || '?'} · {edit.variety.trim() || '?'}
            </label>
          )}
          <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
            <button className="save" disabled={!edit.supplier.trim() || !edit.variety.trim()} onClick={saveC}>Save</button>
            <button onClick={() => setEdit(null)}>Cancel</button>
          </div>
        </div>
      )}
      <div className="table-scroll">
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>Supplier</th><th>Variety</th><th>Lots</th><th>Gen</th><th className="num">Contracted</th><th className="num">Rate (cwt/ac)</th><th className="num">≈ Acres</th><th className="num">Picked up</th><th className="num">Remaining</th><th className="num">$/cwt</th><th>Notes</th><th /></tr></thead>
          <tbody>
            {sorted.map((c) => {
              const r = rowsById[c.id] || {}
              return (
                <tr key={c.id}>
                  <td><strong>{c.supplier}</strong></td><td>{c.variety}</td><td className="contracts-sub">{(c.lots || []).join(', ')}</td><td>{c.generation || ''}</td>
                  <td className="num">{fmtCwt(c.contractedCwt)}</td>
                  <td className="num">{r.rate != null ? fmtCwt(r.rate, 1) : <span className="contracts-sub">—</span>}</td>
                  <td className="num">{r.acres != null ? <strong>{fmtCwt(r.acres)}</strong> : ''}</td>
                  <td className="num">{fmtCwt(r.picked)}{r.pickedAcres > 0 ? <div className="contracts-sub" style={{ marginTop: 0 }}>≈ {fmtCwt(r.pickedAcres)} ac</div> : null}</td>
                  <td className="num">{fmtCwt(r.remaining)}</td>
                  <td className="num">{c.pricePerCwt != null ? `$${c.pricePerCwt}` : ''}</td><td className="contracts-sub">{c.notes || ''}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="clear-sort-btn" onClick={() => setEdit({ ...BLANK, ...c, lots: (c.lots || []).join(', '), contractedCwt: String(c.contractedCwt ?? ''), seedingRate: c.seedingRate != null ? String(c.seedingRate) : '', pricePerCwt: c.pricePerCwt ?? '', generation: c.generation || '', notes: c.notes || '', carry: true })}>Edit</button>{' '}
                    <button className="clear-sort-btn" disabled={r.loads > 0 && !ctx.isAdmin} title={r.loads && !ctx.isAdmin ? 'Has pickup tickets — move or delete them on the Tickets tab first (or ask an Admin)' : ''} onClick={() => delContract(c, r.loads || 0)}>Delete</button>
                  </td>
                </tr>
              )
            })}
            {!sorted.length && <tr><td colSpan={12} className="contracts-sub">No contracts for this crop year yet.</td></tr>}
          </tbody>
          {sorted.length > 0 && (
            <tfoot><tr>
              <td colSpan={4}><strong>Total</strong>{ctx.seed.totals.contractsWithoutRate > 0 && <div className="contracts-sub" style={{ marginTop: 0 }}>{ctx.seed.totals.contractsWithoutRate} contract{ctx.seed.totals.contractsWithoutRate === 1 ? '' : 's'} with no seeding rate left out of acres</div>}</td>
              <td className="num"><strong>{fmtCwt(ctx.seed.totals.contracted)}</strong></td>
              <td className="num">{ctx.seed.totals.acres > 0 ? fmtCwt(ctx.seed.contractRows.filter((c) => c.rate).reduce((t, c) => t + (Number(c.contractedCwt) || 0), 0) / ctx.seed.totals.acres, 1) : ''}</td>
              <td className="num"><strong>{fmtCwt(ctx.seed.totals.acres)}</strong></td>
              <td className="num"><strong>{fmtCwt(ctx.seed.totals.picked)}</strong>{ctx.seed.totals.pickedAcres > 0 ? <div className="contracts-sub" style={{ marginTop: 0 }}>≈ {fmtCwt(ctx.seed.totals.pickedAcres)} ac</div> : null}</td>
              <td colSpan={4} />
            </tr></tfoot>
          )}
        </table>
      </div>
    </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// Seed needs vs contracted (top of the Contracts tab)
// ---------------------------------------------------------------------------
const needDocId = (seasonId, key) => `${seasonId}__${key.replace(/[^A-Z0-9]+/g, '_')}`
const STATUS = {
  short: ['seed-need-short', 'Short'], over: ['seed-need-over', 'Over'], covered: ['seed-need-ok', 'Covered'],
  'no-need': ['seed-need-none', 'Enter need'], empty: ['seed-need-none', 'Enter need']
}
function SeedNeeds({ ctx }) {
  const { run, Msg } = useRun()
  const [draft, setDraft] = useState({})
  const [newVar, setNewVar] = useState('')
  const [shrink, setShrink] = useState(null)
  const N = ctx.needsCalc
  const edit = ctx.canManage
  const closedIn = ctx.seed.lots.filter((L) => L.closed).reduce((s, L) => s + L.unloaded, 0)
  const measured = closedIn > 0 ? (ctx.seed.totals.shrink / closedIn) * 100 : null
  const val = (r, f) => {
    const d = draft[`${r.key}:${f}`]
    if (d != null) return d
    const n = ctx.needs.find((x) => x.id === r.needId)
    return n && n[f] != null ? String(n[f]) : ''
  }
  function saveNeed(r, patch, okText) {
    return run(() => setDoc(doc(db, 'seedNeeds', needDocId(ctx.seasonId, r.key)), { seasonId: ctx.seasonId, variety: r.variety, ...patch, updatedBy: who(), updatedAt: Date.now() }, { merge: true }), okText)
  }
  function commit(r, f) {
    const k = `${r.key}:${f}`
    if (draft[k] == null) return
    const raw = String(draft[k]).trim()
    const v = f === 'note' ? (raw || null) : (Number(raw) > 0 ? Number(raw) : null)
    setDraft((d) => { const n = { ...d }; delete n[k]; return n })
    const n = ctx.needs.find((x) => x.id === r.needId)
    if ((n ? n[f] ?? null : null) === v) return
    saveNeed(r, { [f]: v })
  }
  const input = (r, f, props) => edit
    ? <input className="yields-cell-input" inputMode={f === 'note' ? 'text' : 'decimal'} value={val(r, f)} onChange={(e) => setDraft({ ...draft, [`${r.key}:${f}`]: e.target.value })}
      onBlur={() => commit(r, f)} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} {...props} />
    : <span>{val(r, f)}</span>
  function fillFromAgworld() {
    const todo = N.rows.filter((r) => r.agAcres > 0 && r.acres == null && r.typedCwt == null)
    if (!todo.length) return
    run(async () => {
      const b = writeBatch(db)
      todo.forEach((r) => b.set(doc(db, 'seedNeeds', needDocId(ctx.seasonId, r.key)), { seasonId: ctx.seasonId, variety: r.variety, acres: Math.round(r.agAcres * 10) / 10, updatedBy: who(), updatedAt: Date.now() }, { merge: true }))
      await b.commit()
    }, `Acres filled from Agworld for ${todo.length} variet${todo.length === 1 ? 'y' : 'ies'}.`)
  }
  function addVariety() {
    const v = newVar.trim()
    if (!v) return
    saveNeed({ key: varietyKey(v), variety: v }, {}, `${v} added — enter its acres and rate.`).then(() => setNewVar(''))
  }
  function saveShrink() {
    if (shrink == null) return
    const v = Number(shrink) >= 0 ? Number(shrink) : 0
    setShrink(null)
    run(() => setDoc(doc(db, 'seedSettings', ctx.seasonId), { seasonId: ctx.seasonId, needShrinkPct: v, updatedBy: who(), updatedAt: Date.now() }, { merge: true }), `Shrink allowance set to ${v}%.`)
  }
  const T = N.totals
  const agToFill = N.rows.filter((r) => r.agAcres > 0 && r.acres == null && r.typedCwt == null).length
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Seed needs vs contracted — crop year {ctx.seasonName}</div>
          <div className="contracts-sub">For each variety, the acres you’ll plant × seeding rate (plus the shrink allowance), or type the cwt needed outright. Agworld acres are this season’s potato fields in Agworld.</div>
        </div>
        {edit && (
          <div className="agronomy-filter-bar" style={{ margin: 0 }}>
            <label className="seed-need-shrink">Shrink allowance
              <input className="yields-cell-input" inputMode="decimal" value={shrink ?? String(ctx.settings.needShrinkPct ?? 0)} onChange={(e) => setShrink(e.target.value)} onBlur={saveShrink} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />%
            </label>
            <button disabled={!agToFill} onClick={fillFromAgworld} title="Copies Agworld potato acres into every variety that has no acres yet">Fill acres from Agworld{agToFill ? ` (${agToFill})` : ''}</button>
          </div>
        )}
      </div>
      {measured != null && <div className="contracts-sub" style={{ marginTop: -4, marginBottom: 6 }}>Closed lots this year have run {measured.toFixed(1)}% shrink.</div>}
      <Msg />
      {T.needCount > 0 && (
        <div className="seed-need-sum">
          <div><span>Need</span><strong>{fmtCwt(T.need)}</strong><small>cwt</small></div>
          <div><span>Contracted</span><strong>{fmtCwt(T.contractedWithNeed)}</strong><small>cwt, same varieties</small></div>
          <div className={T.short > 0 ? 'short' : 'ok'}><span>Short</span><strong>{fmtCwt(T.short)}</strong><small>cwt still to buy</small></div>
          <div><span>Over</span><strong>{fmtCwt(T.over)}</strong><small>cwt extra</small></div>
        </div>
      )}
      <div className="table-scroll">
        <table className="contracts-table contracts-table-auto seed-need-table">
          <thead><tr>
            <th>Variety</th><th className="num">Agworld ac</th><th className="num">Plant ac</th><th className="num">Rate (cwt/ac)</th><th className="num">Need (cwt)</th>
            <th className="num">Contracted</th><th>Short / over</th><th className="num">Picked up</th><th>Note</th>{edit && <th />}
          </tr></thead>
          <tbody>
            {N.rows.map((r) => {
              const [cls, base] = STATUS[r.status]
              const label = r.needCwt == null && r.acres != null && !r.rate ? 'Add rate' : base
              return (
                <tr key={r.key}>
                  <td><strong>{r.variety}</strong>{r.contracts > 0 && <div className="contracts-sub" style={{ marginTop: 0 }}>{r.contracts} contract{r.contracts === 1 ? '' : 's'}</div>}</td>
                  <td className="num">{r.agAcres > 0 ? <span title={`${r.agFields} Agworld field${r.agFields === 1 ? '' : 's'}`}>{fmtCwt(r.agAcres)}</span> : <span className="contracts-sub">—</span>}</td>
                  <td className="num">{input(r, 'acres', { placeholder: r.agAcres > 0 ? fmtCwt(r.agAcres) : 'ac' })}</td>
                  <td className="num">{input(r, 'rate', { placeholder: r.contractRate ? fmtCwt(r.contractRate, 1) : 'cwt/ac', title: r.rateFromContracts ? 'Blank uses the seeding rate on the contracts' : '' })}</td>
                  <td className="num">{edit
                    ? <input className={`yields-cell-input${r.typedCwt != null ? ' seed-need-typed' : ''}`} inputMode="decimal" value={val(r, 'cwt')} placeholder={r.needCwt != null ? fmtCwt(r.needCwt) : 'cwt'}
                      title="Leave blank to work it out from acres × rate; type a number to set the need outright"
                      onChange={(e) => setDraft({ ...draft, [`${r.key}:cwt`]: e.target.value })} onBlur={() => commit(r, 'cwt')} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
                    : fmtCwt(r.needCwt)}</td>
                  <td className="num">{r.contracted > 0 ? fmtCwt(r.contracted) : <span className="contracts-sub">none</span>}{r.contractedAcres != null && r.contracted > 0 && <div className="contracts-sub" style={{ marginTop: 0 }}>≈ {fmtCwt(r.contractedAcres)} ac</div>}</td>
                  <td><span className={`seed-need-chip ${cls}`}>{label}{r.diff != null && r.status !== 'covered' ? ` ${fmtCwt(Math.abs(r.diff))} cwt` : ''}</span>
                    {r.diffAcres != null && r.status !== 'covered' && <div className="contracts-sub" style={{ marginTop: 2 }}>≈ {fmtCwt(Math.abs(r.diffAcres))} ac</div>}</td>
                  <td className="num">{r.picked > 0 ? fmtCwt(r.picked) : ''}</td>
                  <td>{input(r, 'note', { style: { width: 130, textAlign: 'left' }, placeholder: '' })}</td>
                  {edit && <td>{r.needId && <button className="clear-sort-btn" title="Clear this variety’s need" onClick={() => { if (window.confirm(`Clear the seed need for ${r.variety}?`)) run(() => deleteDoc(doc(db, 'seedNeeds', r.needId)), `${r.variety} need cleared.`) }}>×</button>}</td>}
                </tr>
              )
            })}
            {!N.rows.length && <tr><td colSpan={10} className="contracts-sub">No varieties yet. Add a contract below, add a variety here, or put potato varieties on this season’s fields in Agworld.</td></tr>}
          </tbody>
          {N.rows.length > 0 && (
            <tfoot><tr>
              <td><strong>Total</strong></td><td className="num">{T.agAcres > 0 ? fmtCwt(T.agAcres) : ''}</td><td className="num"><strong>{T.acres > 0 ? fmtCwt(T.acres) : ''}</strong></td><td />
              <td className="num"><strong>{T.needCount ? fmtCwt(T.need) : ''}</strong></td><td className="num"><strong>{fmtCwt(T.contracted)}</strong></td>
              <td>{T.short > 0 && <span className="seed-need-chip seed-need-short">Short {fmtCwt(T.short)} cwt</span>}</td><td colSpan={edit ? 3 : 2} />
            </tr></tfoot>
          )}
        </table>
      </div>
      {edit && (
        <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
          <input className="agronomy-search-input" style={{ minWidth: 180 }} placeholder="Another variety…" value={newVar} onChange={(e) => setNewVar(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') addVariety() }} />
          <button disabled={!newVar.trim()} onClick={addVariety}>+ Add variety</button>
        </div>
      )}
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
  function delForever(t) {
    const tr = trucksById[t.id]
    const warn = t.type === 'cut' && tr && tr.events.length ? `\n\n${tr.events.length} field unload(s) came off this truck and will lose their link.` : ''
    if (!window.confirm(`Delete this ${TYPE_LABEL[t.type].toLowerCase()} ticket for good (truck ${t.truckNo}, ${fmtCwt(t.cwt, 1)} cwt)? It can’t be restored.${warn}`)) return
    run(async () => {
      const b = writeBatch(db)
      b.delete(doc(db, 'seedTickets', t.id))
      if (t.hasPhoto) b.delete(doc(db, 'seedPhotos', t.id))
      await b.commit()
    }, 'Ticket deleted for good.')
  }
  async function replacePhoto(t, file) {
    if (!file) return
    let data
    try { data = await compressImage(file) } catch (e) { alert(e.message); return }
    run(async () => {
      const b = writeBatch(db)
      b.set(doc(db, 'seedPhotos', t.id), { seasonId: ctx.seasonId, data, at: Date.now(), by: who() })
      b.update(doc(db, 'seedTickets', t.id), { hasPhoto: true, editedBy: who(), editedAt: Date.now() })
      await b.commit()
    }, 'Photo replaced.')
    setPhoto(null)
  }
  function removePhoto(t) {
    if (!window.confirm('Remove the photo from this ticket?')) return
    run(async () => {
      const b = writeBatch(db)
      b.delete(doc(db, 'seedPhotos', t.id))
      b.update(doc(db, 'seedTickets', t.id), { hasPhoto: false, editedBy: who(), editedAt: Date.now() })
      await b.commit()
    }, 'Photo removed.')
    setPhoto(null)
  }
  function saveEdit() {
    const t = edit.t
    const patch = { truckNo: edit.truckNo.trim(), truckKey: truckKey(edit.truckNo), ticketNo: edit.ticketNo.trim() || null, note: edit.note.trim() || null, editedBy: who(), editedAt: Date.now() }
    // Admin extras
    const children = [] // field unloads off a cut truck whose lots changed
    if (ctx.isAdmin) {
      const at = fromLocalInput(edit.when)
      if (at && Math.abs(at - t.at) >= 60000) patch.at = at
      if (t.type === 'plant' && edit.fieldId && edit.fieldId !== t.fieldId) {
        const f = ctx.fieldList.find((x) => x.id === edit.fieldId)
        if (f) Object.assign(patch, { fieldId: f.id, fieldName: f.name, farmName: f.farmName || null, fieldAcres: f.acres || null })
      }
    }
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
      const lotBy = ctx.seed.lotsByKey
      const swap = {} // old lot key -> new lot, when an Admin moved a part to another lot
      patch.parts = edit.parts.filter((p) => !p.removed).map((p) => {
        const L = p.newKey && lotBy[p.newKey]
        const out = { supplier: L ? L.supplier : p.supplier, variety: L ? L.variety : p.variety, lot: L ? L.lot : p.lot, cwt: Number(p.cwt) || 0 }
        const ok = lotKey(p.supplier, p.variety, p.lot)
        if (p.supplier && lotKey(out.supplier, out.variety, out.lot) !== ok) swap[ok] = out
        return out
      })
      patch.cwt = Math.round(patch.parts.reduce((s, p) => s + p.cwt, 0) * 100) / 100
      patch.netLbs = Math.round(patch.cwt * 100)
      patch.varieties = [...new Set(patch.parts.map((p) => p.variety))]
      // What was unloaded off this truck follows the lot change.
      if (Object.keys(swap).length) {
        ctx.tickets.filter((x) => x.cutTicketId === t.id && x.parts).forEach((x) => {
          const parts = x.parts.map((q) => { const n = swap[lotKey(q.supplier, q.variety, q.lot)]; return n ? { ...q, supplier: n.supplier, variety: n.variety, lot: n.lot } : q })
          children.push([x.id, { parts, varieties: [...new Set(parts.map((q) => q.variety))], editedBy: who(), editedAt: Date.now() }])
        })
      }
    }
    run(async () => {
      if (!children.length) return updateDoc(doc(db, 'seedTickets', t.id), patch)
      const b = writeBatch(db)
      b.update(doc(db, 'seedTickets', t.id), patch)
      children.forEach(([id, p]) => b.update(doc(db, 'seedTickets', id), p))
      return b.commit()
    }, children.length ? `Ticket updated — ${children.length} field unload${children.length === 1 ? '' : 's'} off this truck moved to the new lot too.` : 'Ticket updated.').then(() => setEdit(null))
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
            {ctx.isAdmin && <label className="hd-field"><span>Date &amp; time</span><input type="datetime-local" value={edit.when} onChange={(e) => setEdit({ ...edit, when: e.target.value })} /></label>}
            {ctx.isAdmin && edit.t.type === 'plant' && (
              <label className="hd-field"><span>Field</span>
                <select value={edit.fieldId || ''} onChange={(e) => setEdit({ ...edit, fieldId: e.target.value })}>
                  {!ctx.fieldList.some((f) => f.id === edit.fieldId) && <option value={edit.fieldId || ''}>{edit.t.fieldName || '—'}</option>}
                  {ctx.fieldList.map((f) => <option key={f.id} value={f.id}>{f.name}{f.farmName ? ` — ${f.farmName}` : ''}{/POTATO/.test(f.crop) ? '' : ` (${String(f.crop || 'no crop').toLowerCase()})`}</option>)}
                </select>
              </label>
            )}
          </div>
          {edit.t.type === 'cut' && (
            <div className="hd-grid" style={{ marginTop: 8 }}>
              {edit.parts.map((p, i) => p.removed ? null : (
                <div key={i} className="hd-field seed-edit-part">
                  {ctx.isAdmin ? (
                    <select value={p.newKey || lotKey(p.supplier, p.variety, p.lot)} onChange={(e) => setEdit({ ...edit, parts: edit.parts.map((x, j) => (j === i ? { ...x, newKey: e.target.value } : x)) })}>
                      {p.supplier && !ctx.seed.lotsByKey[lotKey(p.supplier, p.variety, p.lot)] && <option value={lotKey(p.supplier, p.variety, p.lot)}>{lotLabel(p)}</option>}
                      {!p.supplier && <option value="">Pick a lot…</option>}
                      {ctx.seed.lots.map((L) => <option key={L.key} value={L.key}>{lotLabel(L)}</option>)}
                    </select>
                  ) : <span>{p.variety} lot {p.lot} (cwt)</span>}
                  <div className="fm-row" style={{ flexWrap: 'nowrap' }}>
                    <input inputMode="decimal" value={p.cwt} placeholder="cwt" onChange={(e) => setEdit({ ...edit, parts: edit.parts.map((x, j) => (j === i ? { ...x, cwt: e.target.value } : x)) })} />
                    {ctx.isAdmin && edit.parts.filter((x) => !x.removed).length > 1 && <button type="button" className="clear-sort-btn" title="Take this lot off the load" onClick={() => setEdit({ ...edit, parts: edit.parts.map((x, j) => (j === i ? { ...x, removed: true } : x)) })}>×</button>}
                  </div>
                </div>
              ))}
              {ctx.isAdmin && <button type="button" className="clear-sort-btn" style={{ alignSelf: 'end' }} onClick={() => setEdit({ ...edit, parts: [...edit.parts, { supplier: '', variety: '', lot: '', cwt: '', newKey: '' }] })}>+ Another lot on this load</button>}
            </div>
          )}
          {edit.t.type === 'cut' && <div className="contracts-sub">Truck total: {fmtCwt(edit.parts.filter((p) => !p.removed).reduce((s, p) => s + (Number(p.cwt) || 0), 0), 1)} cwt</div>}
          <div className="agronomy-filter-bar" style={{ marginTop: 10 }}><button className="save" disabled={edit.t.type === 'cut' && edit.parts.some((p) => !p.removed && !p.supplier && !p.newKey)} onClick={saveEdit}>Save</button><button onClick={() => setEdit(null)}>Cancel</button></div>
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
                <td>{t.hasPhoto ? <button className="clear-sort-btn" onClick={() => openPhoto(t)}>📷</button>
                  : ctx.isAdmin && !t.deleted && (t.type === 'pickup' || t.type === 'cut') ? <label className="clear-sort-btn seed-add-photo" title="Add a ticket photo">+📷<input type="file" accept="image/*" onChange={(e) => replacePhoto(t, e.target.files && e.target.files[0])} /></label> : null}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  {t.deleted
                    ? <>
                      <button className="clear-sort-btn" onClick={() => run(() => updateDoc(doc(db, 'seedTickets', t.id), { deleted: false }), 'Restored.')}>Restore</button>
                      {ctx.isAdmin && <>{' '}<button className="clear-sort-btn seed-danger" onClick={() => delForever(t)}>Delete for good</button></>}
                    </>
                    : <>
                      <button className="clear-sort-btn" onClick={() => setEdit({ t, truckNo: t.truckNo || '', ticketNo: t.ticketNo || '', cwt: String(t.cwt ?? ''), supplier: t.supplier || '', variety: t.variety || '', lot: t.lot || '', status: t.status || 'transit', note: t.note || '', parts: t.parts ? t.parts.map((p) => ({ ...p, cwt: String(p.cwt) })) : null, when: toLocalInput(t.at), fieldId: t.fieldId || '' })}>Edit</button>{' '}
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
            <div className="agronomy-filter-bar" style={{ margin: 0, justifyContent: 'center' }}>
              {ctx.isAdmin && (() => { const t = ctx.tickets.find((x) => x.id === photo.id); return t ? <>
                <label className="clear-sort-btn seed-add-photo">Replace photo<input type="file" accept="image/*" onChange={(e) => replacePhoto(t, e.target.files && e.target.files[0])} /></label>
                <button className="clear-sort-btn seed-danger" onClick={() => removePhoto(t)}>Remove photo</button>
              </> : null })()}
              <button onClick={() => setPhoto(null)}>Close</button>
            </div>
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
  // Admin: fix a lot's supplier / variety / lot # everywhere it appears —
  // pickups, cut-seed loads, field unloads, write-offs, its close-out and the
  // contract's lot list. Deleted tickets too, so a restore still lines up.
  const [fix, setFix] = useState(null) // { key, supplier, variety, lot, shrink, closedAt }
  function saveFix(L) {
    const to = { supplier: fix.supplier.trim(), variety: fix.variety.trim(), lot: fix.lot.trim() }
    if (!to.supplier || !to.variety || !to.lot) return
    const newKey = lotKey(to.supplier, to.variety, to.lot)
    const renamed = newKey !== L.key
    if (renamed && ctx.seed.lotsByKey[newKey] && !window.confirm(`${lotLabel(to)} already exists. Merge ${lotLabel(L)} into it?`)) return
    const c = ctx.closes.find((x) => x.key === L.key)
    const onLot = (t) => (t.type === 'pickup' ? lotKey(t.supplier, t.variety, t.lot) === L.key : !!(t.parts && t.parts.some((p) => lotKey(p.supplier, p.variety, p.lot) === L.key)))
    const hit = renamed ? ctx.tickets.filter(onLot) : []
    run(async () => {
      const b = writeBatch(db)
      const stamp = { editedBy: who(), editedAt: Date.now() }
      if (renamed) {
        const contract = ctx.contracts.find((x) => x.supplier === to.supplier && x.variety === to.variety) || null
        hit.forEach((t) => {
          if (t.type === 'pickup') {
            b.update(doc(db, 'seedTickets', t.id), { ...to, lotKey: newKey, contractId: contract ? contract.id : null, ...stamp })
          } else {
            const parts = t.parts.map((p) => (lotKey(p.supplier, p.variety, p.lot) === L.key ? { ...p, ...to } : p))
            b.update(doc(db, 'seedTickets', t.id), { parts, varieties: [...new Set(parts.map((p) => p.variety))], ...stamp })
          }
        })
        // contract lot lists: the old lot # comes off, the new one goes on
        ctx.contracts.forEach((k) => {
          let lots = [...(k.lots || [])]
          if (k.supplier === L.supplier && k.variety === L.variety) lots = lots.filter((x) => x !== L.lot)
          if (contract && k.id === contract.id && !lots.includes(to.lot) && ((k.lots || []).includes(L.lot) || (k.lots || []).length)) lots.push(to.lot)
          if (JSON.stringify(lots) !== JSON.stringify(k.lots || [])) b.update(doc(db, 'seedContracts', k.id), { lots })
        })
      }
      if (c) {
        const patch = renamed ? { ...to, key: newKey } : {}
        const sh = Number(fix.shrink)
        if (fix.shrink !== '' && Number.isFinite(sh) && sh >= 0 && Math.abs(sh - (c.shrinkCwt ?? 0)) > 0.001) patch.shrinkCwt = sh
        const at = fromLocalInput(fix.closedAt)
        if (at && Math.abs(at - c.closedAt) >= 60000) patch.closedAt = at
        if (Object.keys(patch).length) b.update(doc(db, 'seedLotClose', c.id), { ...patch, ...stamp })
      }
      await b.commit()
    }, renamed ? `Lot changed to ${lotLabel(to)} on ${hit.length} ticket${hit.length === 1 ? '' : 's'}.` : 'Lot saved.').then(() => setFix(null))
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
                    {ctx.isAdmin && <>{' '}<button className="clear-sort-btn" onClick={() => { const c = ctx.closes.find((x) => x.key === L.key); setOpen(null); setFix({ key: L.key, supplier: L.supplier, variety: L.variety, lot: L.lot, shrink: c ? String(c.shrinkCwt ?? '') : '', closedAt: c ? toLocalInput(c.closedAt) : '' }) }}>Edit</button></>}
                  </td>
                </tr>
                {fix && fix.key === L.key && (
                  <tr><td colSpan={12} className="seed-lot-detail">
                    <div className="hd-grid">
                      <label className="hd-field"><span>Supplier</span><input value={fix.supplier} onChange={(e) => setFix({ ...fix, supplier: e.target.value })} /></label>
                      <label className="hd-field"><span>Variety</span><input value={fix.variety} onChange={(e) => setFix({ ...fix, variety: e.target.value })} /></label>
                      <label className="hd-field"><span>Lot #</span><input value={fix.lot} onChange={(e) => setFix({ ...fix, lot: e.target.value })} /></label>
                      {L.closed && <label className="hd-field"><span>Shrink written off (cwt)</span><input inputMode="decimal" value={fix.shrink} onChange={(e) => setFix({ ...fix, shrink: e.target.value })} /></label>}
                      {L.closed && <label className="hd-field"><span>Closed on</span><input type="datetime-local" value={fix.closedAt} onChange={(e) => setFix({ ...fix, closedAt: e.target.value })} /></label>}
                    </div>
                    <div className="contracts-sub">Changing the supplier, variety or lot # changes it on every pickup, cut-seed load and field unload for this lot{L.closed ? ', and its close-out' : ''}.</div>
                    <div className="agronomy-filter-bar" style={{ marginTop: 8 }}><button className="save" disabled={!fix.supplier.trim() || !fix.variety.trim() || !fix.lot.trim()} onClick={() => saveFix(L)}>Save</button><button onClick={() => setFix(null)}>Cancel</button></div>
                  </td></tr>
                )}
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
            <button className="save" onClick={() => run(() => setDoc(doc(db, 'seedSettings', ctx.seasonId), { seasonId: ctx.seasonId, zoneCapacity: Number(cap) || 2500, ageWarnHours: Number(warn) || 24, ageAlarmHours: Number(alarm) || 48, updatedBy: who(), updatedAt: Date.now() }, { merge: true }), 'Settings saved.')}>Save</button>
          </div>
          <div className="contracts-sub">Cut seed sitting on a truck too long is flagged amber, then red, in the loaded-truck inventory.</div>
        </div>
      </div>
    </>
  )
}

