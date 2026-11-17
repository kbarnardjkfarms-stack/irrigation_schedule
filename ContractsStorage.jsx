import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, deleteDoc, doc, onSnapshot, query, setDoc, where } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { loadLeaflet } from './FarmMap.jsx'
import {
  DEFAULT_YIELD, autoFill, cannotPlace, milesBetween, placeField, planState, ringCentroid, storageFields, storageSites
} from './storagePlanMath.js'

// Contracts > Storage plan. Potato contracts marked Storage, the fields
// allocated to them, and the Potato Storage bays they could go in:
//   - storage available (bay capacity from Potato Storage, pile height
//     included) against what the storage contracts will need
//   - the nearest storage to every field (field outline middle → the
//     cellar's spot on the Farm Map)
//   - a brainstorm board: put fields into bays by hand or with Auto-fill,
//     one variety and one customer per bay, and keep several plans to
//     compare.
//
// Reads: potatoStorage (locations, buildings, bays — the Potato Storage
// module's own docs), farmPoints (Farm Map cellars), fieldBoundaries
// (Agworld field outlines), farmFields (Farm Map outlines, as a fallback).
// Writes: storagePlans/{id} { seasonId, name, assign: [{ fieldId, bayId, cwt }],
// excluded: [bayId], defaultYield }, storageSites/{buildingId} { pointId }.

const LOC_KEY = 'storage-locations-v3'
const BLD_KEY = 'storage-buildings-v3'
const BAY_KEY = 'norland-bays-config-v4'
const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
const fmt = (n) => (n == null || !isFinite(n) ? '—' : Math.round(n).toLocaleString())
const fmtK = (n) => (n == null || !isFinite(n) ? '—' : n >= 100000 ? `${(n / 1000).toFixed(0)}k` : Math.round(n).toLocaleString())
const mi = (n) => (n == null ? '—' : `${n < 10 ? n.toFixed(1) : Math.round(n)} mi`)
const mapKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// Variety families in the Potato Storage colours.
const FAMILY_COLOR = { BURBANK: '#3E9A33', RANGER: '#D9A900', NORKOTAH: '#C62828', CLEARWATER: '#1E9AA8', DAKOTA: '#716C3D', TETON: '#C2185B', REVEILLE: '#D9776F', GALA: '#5C7CBA' }
const POOL = ['#6D4C9F', '#8D6E63', '#00897B', '#5D6D7E', '#AD1457', '#6A8E23']
function familyColor(fam) {
  if (!fam) return '#9E9E9E'
  if (FAMILY_COLOR[fam]) return FAMILY_COLOR[fam]
  let h = 0
  for (let i = 0; i < fam.length; i++) h = (h * 31 + fam.charCodeAt(i)) >>> 0
  return POOL[h % POOL.length]
}

// Buildings in one storage yard (a Potato Storage location) shown together.
function yardsOf(sites) {
  const m = new Map()
  sites.forEach((s) => {
    const k = s.locationName || s.name
    const y = m.get(k) || { name: k, sites: [], bays: [] }
    y.sites.push(s); y.bays.push(...s.bays); m.set(k, y)
  })
  return [...m.values()].map((y) => {
    const ps = y.sites.filter((s) => s.pos).map((s) => s.pos)
    return { ...y, pos: ps.length ? { lat: ps.reduce((t, p) => t + p.lat, 0) / ps.length, lng: ps.reduce((t, p) => t + p.lng, 0) / ps.length } : null }
  })
}

function useStorageData(seasonId) {
  const [st, setSt] = useState({ locations: [], buildings: [], bays: [], storageErr: null, points: [], boundaries: {}, farmFields: [], plans: [], positions: {}, loaded: false })
  const set = (patch) => setSt((s) => ({ ...s, ...patch }))
  useEffect(() => {
    const parse = (d) => { try { return d.exists() ? JSON.parse(d.data().value) : [] } catch { return [] } }
    const noStorage = (e) => set({ storageErr: e.code === 'permission-denied' ? 'Your login doesn’t include the Potato Storage module, so storage bays can’t be shown.' : e.message })
    const unsubs = [
      onSnapshot(doc(db, 'potatoStorage', LOC_KEY), (d) => set({ locations: parse(d) }), noStorage),
      onSnapshot(doc(db, 'potatoStorage', BLD_KEY), (d) => set({ buildings: parse(d) }), noStorage),
      onSnapshot(doc(db, 'potatoStorage', BAY_KEY), (d) => set({ bays: parse(d), loaded: true }), noStorage),
      onSnapshot(collection(db, 'farmPoints'), (snap) => { const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() })); set({ points: out }) }, () => set({ points: [] })),
      onSnapshot(collection(db, 'fieldBoundaries'), (snap) => { const out = {}; snap.forEach((d) => { out[d.id] = d.data().boundary }); set({ boundaries: out }) }, () => set({ boundaries: {} })),
      onSnapshot(collection(db, 'farmFields'), (snap) => { const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() })); set({ farmFields: out }) }, () => set({ farmFields: [] })),
      onSnapshot(collection(db, 'storageSites'), (snap) => { const out = {}; snap.forEach((d) => { out[d.id] = d.data() }); set({ positions: out }) }, () => set({ positions: {} }))
    ]
    return () => unsubs.forEach((u) => u())
  }, [])
  useEffect(() => {
    if (!seasonId) return undefined
    return onSnapshot(query(collection(db, 'storagePlans'), where('seasonId', '==', String(seasonId))), (snap) => {
      const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() }))
      out.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0)); set({ plans: out })
    }, () => set({ plans: [] }))
  }, [seasonId])
  return st
}

export default function ContractsStorage({ seasonId, seasonName, seasonFields, contracts, allocByField, canEdit, onEditContracts }) {
  const data = useStorageData(seasonId)
  const [planId, setPlanId] = useState(null)
  const [view, setView] = useState('board')
  const [sel, setSel] = useState(null) // field id picked to place
  const [msg, setMsg] = useState(null)
  const [renaming, setRenaming] = useState(null)
  const plan = data.plans.find((p) => p.id === planId) || data.plans[0] || null
  useEffect(() => { if (plan && plan.id !== planId) setPlanId(plan.id) }, [plan, planId])

  const sites = useMemo(() => storageSites({ locations: data.locations, buildings: data.buildings, bays: data.bays, points: data.points, positions: data.positions }), [data.locations, data.buildings, data.bays, data.points, data.positions])
  // Middle of each field: Agworld outline, else the Farm Map outline with the same name.
  const centroids = useMemo(() => {
    const byKey = {}
    data.farmFields.forEach((f) => { const r = (f.rings || []).find((x) => !x.hole); if (r && r.c) { const ring = []; for (let i = 0; i < r.c.length; i += 2) ring.push([r.c[i], r.c[i + 1]]); byKey[mapKey(f.name)] = ringCentroid(ring) } })
    const out = {}
    seasonFields.forEach((f) => {
      let ring = null
      try { ring = data.boundaries[f.id] ? JSON.parse(data.boundaries[f.id]) : null } catch { ring = null }
      out[f.id] = (ring && ringCentroid(ring)) || byKey[mapKey(f.name)] || null
    })
    return out
  }, [seasonFields, data.boundaries, data.farmFields])
  const storageContracts = contracts.filter((c) => c.delivery === 'storage')
  const potatoNoDelivery = contracts.filter((c) => /POTATO/i.test(c.crop || '') && !c.delivery)
  const directContracts = contracts.filter((c) => c.delivery === 'direct')
  const defaultYield = (plan && Number(plan.defaultYield) > 0) ? Number(plan.defaultYield) : DEFAULT_YIELD
  const fields = useMemo(() => storageFields({ fields: seasonFields, contracts, allocByField, centroids, sites, defaultYield }), [seasonFields, contracts, allocByField, centroids, sites, defaultYield])
  const st = useMemo(() => planState({ plan, sites, fields }), [plan, sites, fields])
  const selAny = sel ? st.fields.find((f) => f.id === sel) : null
  const selF = selAny && selAny.left > 0.5 ? selAny : null // a field with cwt still to place
  const yards = useMemo(() => yardsOf(sites), [sites])
  const yardMiles = (y, f) => { const d = (f ? f.near : []).filter((n) => y.sites.some((s) => s.id === n.siteId)).map((n) => n.miles); return d.length ? Math.min(...d) : null }

  // ---- writes ---------------------------------------------------------------
  const run = (p, ok) => { setMsg(null); Promise.resolve(p).then(() => ok && setMsg({ ok: true, text: ok })).catch((e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin or Owner can change storage plans.' : e.message })) }
  const savePlan = (patch, ok) => plan && run(setDoc(doc(db, 'storagePlans', plan.id), { ...patch, updatedBy: who(), updatedAt: Date.now() }, { merge: true }), ok)
  function newPlan(copyFrom) {
    const id = `${seasonId}__${Date.now().toString(36)}`
    const n = data.plans.length + 1
    run(setDoc(doc(db, 'storagePlans', id), {
      seasonId: String(seasonId), name: copyFrom ? `${copyFrom.name} (copy)` : `Plan ${n}`, assign: copyFrom ? copyFrom.assign || [] : [], excluded: copyFrom ? copyFrom.excluded || [] : [],
      defaultYield: copyFrom ? copyFrom.defaultYield || DEFAULT_YIELD : DEFAULT_YIELD, createdAt: Date.now(), createdBy: who(), updatedAt: Date.now()
    }), copyFrom ? 'Plan copied.' : 'New plan started.')
    setPlanId(id)
  }
  function place(f, b) {
    if (!canEdit || !plan) return
    const why = cannotPlace(f, b)
    if (why) { setMsg({ ok: false, text: why }); return }
    savePlan({ assign: placeField(plan.assign || [], f, b) }, `${f.name} → ${b.name}.`)
    const left = f.left - Math.min(f.left, b.free)
    if (left <= 0.5) setSel(null)
  }
  function unplace(a) { savePlan({ assign: (plan.assign || []).filter((x) => !(x.fieldId === a.fieldId && x.bayId === a.bayId)) }) }
  function setCwt(a, v) {
    const n = Number(v)
    if (!(n > 0)) return unplace(a)
    savePlan({ assign: (plan.assign || []).map((x) => (x.fieldId === a.fieldId && x.bayId === a.bayId ? { ...x, cwt: Math.round(n) } : x)) })
  }
  function toggleBay(b) {
    const ex = new Set(plan.excluded || [])
    if (ex.has(b.id)) ex.delete(b.id); else ex.add(b.id)
    savePlan({ excluded: [...ex] }, ex.has(b.id) ? `${b.name} set aside in this plan.` : `${b.name} back in the plan.`)
  }
  function doAuto() {
    const r = autoFill({ plan, sites, fields })
    const extra = [r.skipped.length ? `No room that fits: ${r.skipped.join(', ')}.` : '', r.noVariety.length ? `No variety in Agworld: ${r.noVariety.join(', ')}.` : ''].filter(Boolean).join(' ')
    savePlan({ assign: r.assign }, `Auto-filled the nearest bays.${extra ? ' ' + extra : ''}`)
  }

  // ---- render ---------------------------------------------------------------
  if (data.storageErr) return <div className="agronomy-error-banner">{data.storageErr}</div>
  const T = st.totals
  const capAll = sites.reduce((s, x) => s + x.bays.reduce((a, b) => a + b.capacity, 0), 0)
  const unplaced = st.fields.filter((f) => f.left > 0.5)
  return (
    <div className="csp">
      {potatoNoDelivery.length > 0 && (
        <div className="csp-warn">{potatoNoDelivery.length} potato contract{potatoNoDelivery.length === 1 ? '' : 's'} not marked Direct or Storage yet ({potatoNoDelivery.map((c) => c.name).join(', ')}).{canEdit && <> <button className="link-btn" onClick={onEditContracts}>Set them on the Contracts tab</button></>}</div>
      )}
      <div className="seed-need-sum">
        <div><span>Storage contracts need</span><strong>{fmt(T.need)}</strong><small>cwt · {fields.length} field{fields.length === 1 ? '' : 's'} · {fmt(fields.reduce((s, f) => s + f.acres, 0))} ac</small></div>
        <div><span>Storage available</span><strong>{fmt(T.capacity)}</strong><small>cwt in {T.baysOpen} bays{T.capacity < capAll - 1 ? ` (${fmt(capAll)} with set-aside bays)` : ''}</small></div>
        <div className={T.need > T.capacity ? 'short' : 'ok'}><span>{T.need > T.capacity ? 'Short of space' : 'Room to spare'}</span><strong>{fmt(Math.abs(T.capacity - T.need))}</strong><small>cwt, before the bay rules</small></div>
        <div><span>This plan</span><strong>{fmt(T.placed)}</strong><small>cwt placed in {T.baysUsed} bay{T.baysUsed === 1 ? '' : 's'} · {fmt(T.left)} left to place</small></div>
      </div>

      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Storage plan — crop year {seasonName}</div>
            <div className="contracts-sub">{storageContracts.length} storage contract{storageContracts.length === 1 ? '' : 's'}, {directContracts.length} direct. Bays and capacity come from Potato Storage; each bay takes one variety and one customer. Distances are straight-line from the middle of the field to the cellar on the Farm Map.</div>
          </div>
          <div className="agronomy-filter-bar" style={{ margin: 0 }}>
            {data.plans.length > 0 && (
              renaming != null
                ? <><input className="agronomy-search-input" style={{ minWidth: 140 }} value={renaming} autoFocus onChange={(e) => setRenaming(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { savePlan({ name: renaming.trim() || plan.name }); setRenaming(null) } }} />
                  <button className="save" onClick={() => { savePlan({ name: renaming.trim() || plan.name }); setRenaming(null) }}>Save</button></>
                : <select value={plan ? plan.id : ''} onChange={(e) => { setPlanId(e.target.value); setSel(null) }}>{data.plans.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
            )}
            {canEdit && <>
              {plan && renaming == null && <button onClick={() => setRenaming(plan.name)}>Rename</button>}
              {plan && <button onClick={() => newPlan(plan)}>Copy</button>}
              <button className={plan ? '' : 'save'} onClick={() => newPlan(null)} disabled={!seasonId}>+ New plan</button>
              {plan && <button onClick={() => { if (window.confirm(`Delete “${plan.name}”?`)) { run(deleteDoc(doc(db, 'storagePlans', plan.id)), 'Plan deleted.'); setPlanId(null) } }}>Delete</button>}
            </>}
          </div>
        </div>
        {msg && <div className={msg.ok ? 'yields-ok harvest-msg' : 'agronomy-error-banner'} onClick={() => setMsg(null)}>{msg.text}</div>}
        {!plan ? (
          <div className="contracts-sub" style={{ padding: '10px 0' }}>{canEdit ? 'Start a plan to fit the storage fields into bays. You can keep several plans and compare them.' : 'No storage plan for this year yet.'}</div>
        ) : (
          <>
            <div className="agronomy-filter-bar" style={{ marginTop: 4 }}>
              <div className="agronomy-view-toggle" style={{ margin: 0 }}>
                {[['board', 'Board'], ['map', 'Map'], ['fields', 'Nearest storage'], ['sites', 'Storage sites']].map(([k, l]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>)}
              </div>
              {canEdit && <>
                <button className="save" onClick={doAuto} disabled={!unplaced.length}>Auto-fill the rest</button>
                <button onClick={() => { if (window.confirm('Take every field out of the bays in this plan?')) savePlan({ assign: [] }, 'Plan cleared.') }} disabled={!(plan.assign || []).length}>Clear</button>
                <label className="seed-need-shrink" title="Used when a storage contract has no expected yield">Yield if not on contract
                  <input className="yields-cell-input" inputMode="numeric" defaultValue={defaultYield} key={plan.id + defaultYield} onBlur={(e) => { const v = Number(e.target.value); if (v > 0 && v !== defaultYield) savePlan({ defaultYield: v }) }} /> cwt/ac
                </label>
              </>}
            </div>
            {st.stray.length > 0 && <div className="csp-warn">{st.stray.length} placement{st.stray.length === 1 ? '' : 's'} point at a field that’s no longer on a storage contract or a bay that’s gone from Potato Storage. {canEdit && <button className="link-btn" onClick={() => savePlan({ assign: (plan.assign || []).filter((a) => !st.stray.includes(a)) }, 'Removed.')}>Remove them</button>}</div>}

            {view === 'board' && (
              <div className="csp-board">
                <div className="csp-fields">
                  <div className="fm-lab">Fields to place ({unplaced.length})</div>
                  {!fields.length && <div className="contracts-sub">No fields on storage contracts. Mark potato contracts Storage and allocate fields to them.</div>}
                  {st.fields.map((f) => (
                    <button key={f.id} type="button" draggable={canEdit && f.left > 0.5} onDragStart={(e) => { e.dataTransfer.setData('text/plain', f.id); setSel(f.id) }}
                      className={`csp-field${sel === f.id ? ' picked' : ''}${f.left <= 0.5 ? ' done' : ''}`} onClick={() => setSel(sel === f.id ? null : f.id)}>
                      <i style={{ background: familyColor(f.family) }} />
                      <div className="csp-field-main">
                        <strong>{f.name}</strong>
                        <small>{f.variety || 'no variety'} · {f.customer} · {fmt(f.acres)} ac</small>
                        <small>{f.near[0] ? `Nearest ${f.near[0].name} · ${mi(f.near[0].miles)}` : 'No outline — distance unknown'}</small>
                      </div>
                      <div className="csp-field-num">{f.left > 0.5 ? <><b>{fmtK(f.left)}</b><small>{f.placed > 0 ? 'left' : 'cwt'}</small></> : <span className="seed-need-chip seed-need-ok">Placed</span>}</div>
                    </button>
                  ))}
                </div>
                <div className="csp-sites">
                  {selF && <div className="csp-hint">Placing <b>{selF.name}</b> ({selF.variety} · {selF.customer}, {fmt(selF.left)} cwt{selF.placed > 0 ? ' still to place' : ''}). {canEdit ? 'Tap or drop on a bay — greyed bays don’t fit.' : ''} <button className="csp-x" style={{ float: 'right' }} onClick={() => setSel(null)}>×</button></div>}
                  {selAny && !selF && <div className="csp-hint">{selAny.name} is placed in full: {selAny.bays.join(', ')}. Use × in a bay to take it out and move it.</div>}
                  {[...yards].sort((a, b) => (selF ? (yardMiles(a, selF) ?? 1e9) - (yardMiles(b, selF) ?? 1e9) : 0)).map((y) => (
                    <div key={y.name} className="csp-site">
                      <div className="csp-site-head"><strong>{y.name}</strong><span className="contracts-sub">{fmt(y.bays.reduce((t, b) => t + st.bays[b.id].used, 0))} of {fmt(y.bays.reduce((t, b) => t + b.capacity, 0))} cwt planned{selF && yardMiles(y, selF) != null ? ` · ${mi(yardMiles(y, selF))} from ${selF.name}` : ''}</span></div>
                      <div className="csp-bays">
                        {y.bays.map((b0) => {
                          const b = st.bays[b0.id]
                          const why = selF ? cannotPlace(selF, b) : null
                          const pct = b.capacity > 0 ? b.used / b.capacity : 0
                          return (
                            <div key={b.id} className={`csp-bay${b.excluded ? ' excluded' : ''}${selF ? (why ? ' nofit' : ' fit') : ''}${b.over ? ' over' : ''}`} title={why || ''}
                              onClick={() => selF && place(selF, b)} onDragOver={(e) => { if (canEdit) e.preventDefault() }}
                              onDrop={(e) => { e.preventDefault(); const f = st.fields.find((x) => x.id === e.dataTransfer.getData('text/plain')); if (f) place(f, b) }}>
                              <div className="csp-bay-head">
                                <strong>{b.name}</strong>
                                <span>{fmt(b.used)} / {fmt(b.capacity)}</span>
                              </div>
                              <div className="csp-gauge"><div style={{ width: `${Math.min(100, pct * 100)}%`, background: b.lock ? familyColor(b.lock.family) : '#9E9E9E' }} /></div>
                              {b.lock ? <div className="csp-lock"><i style={{ background: familyColor(b.lock.family) }} />{b.lock.variety} · {b.lock.customer}</div>
                                : <div className="csp-lock empty">{b.excluded ? 'Set aside' : 'Empty'}</div>}
                              {b.items.map((a) => (
                                <div key={a.fieldId} className="csp-item" onClick={(e) => e.stopPropagation()}>
                                  <span>{a.field.name}</span>
                                  {canEdit ? <input className="yields-cell-input" defaultValue={a.cwt} key={a.cwt} inputMode="numeric" onBlur={(e) => { if (Number(e.target.value) !== a.cwt) setCwt(a, e.target.value) }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} title="cwt of this field in this bay" />
                                    : <span>{fmt(a.cwt)}</span>}
                                  {canEdit && <button className="csp-x" title="Take out of this bay" onClick={() => unplace(a)}>×</button>}
                                </div>
                              ))}
                              {b.mixed && <div className="fm-note">Mixed varieties or customers — move one out.</div>}
                              {b.over && <div className="fm-note">Over capacity by {fmt(b.used - b.capacity)} cwt.</div>}
                              {canEdit && <button className="csp-aside" onClick={(e) => { e.stopPropagation(); toggleBay(b) }}>{b.excluded ? 'Use in plan' : 'Set aside'}</button>}
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  ))}
                  {!sites.length && <div className="contracts-sub">{data.loaded ? 'No bays in Potato Storage yet.' : 'Loading storage…'}</div>}
                </div>
              </div>
            )}
            {view === 'map' && <PlanMap sites={sites} st={st} sel={sel} onPick={setSel} />}
            {view === 'fields' && <NearestTable st={st} onPick={(id) => { setSel(id); setView('board') }} />}
            {view === 'sites' && <SitesTable sites={sites} st={st} points={data.points} positions={data.positions} canEdit={canEdit} run={run} />}
          </>
        )}
      </div>
    </div>
  )
}

function NearestTable({ st, onPick }) {
  return (
    <div className="table-scroll" style={{ maxHeight: 620, marginTop: 8 }}>
      <table className="contracts-table contracts-table-auto">
        <thead><tr><th>Field</th><th>Farm</th><th>Variety</th><th>Customer</th><th className="num">Acres</th><th className="num">Est. cwt</th><th>Nearest storage</th><th>Next location</th><th>In this plan</th></tr></thead>
        <tbody>
          {st.fields.map((f) => (
            <tr key={f.id}>
              <td><button className="link-btn" onClick={() => onPick(f.id)}>{f.name}</button></td><td>{f.farmName || ''}</td>
              <td><i className="csp-dot" style={{ background: familyColor(f.family) }} />{f.variety || <span className="contracts-sub">not set</span>}</td><td>{f.customer}</td>
              <td className="num">{fmt(f.acres)}</td><td className="num">{fmt(f.cwt)}<div className="contracts-sub" style={{ marginTop: 0 }}>@ {fmt(f.yieldPerAc)}/ac</div></td>
              <td>{f.near[0] ? <><strong>{f.near[0].name}</strong> · {mi(f.near[0].miles)}</> : <span className="contracts-sub">no outline</span>}</td>
              <td className="contracts-sub">{f.nearLocs[1] ? `${f.nearLocs[1].location} · ${mi(f.nearLocs[1].miles)}` : ''}</td>
              <td>{f.bays.length ? f.bays.join(', ') : ''}{f.left > 0.5 ? <span className={`seed-need-chip ${f.placed > 0 ? 'seed-need-over' : 'seed-need-none'}`} style={{ marginLeft: 4 }}>{f.placed > 0 ? `${fmt(f.left)} left` : 'not placed'}</span> : null}{f.overPlaced && <span className="seed-need-chip seed-need-short">over-placed</span>}</td>
            </tr>
          ))}
          {!st.fields.length && <tr><td colSpan={9} className="contracts-sub">No fields on storage contracts yet.</td></tr>}
        </tbody>
      </table>
    </div>
  )
}

const SOURCE_LABEL = { 'farm-map': 'Farm Map (picked)', 'farm-map-auto': 'Farm Map (matched by name)', set: 'Set by hand', 'storage-module': 'Potato Storage pin', null: 'No position' }
function SitesTable({ sites, st, points, positions, canEdit, run }) {
  const cellars = points.filter((p) => /CELLAR|STORAGE/i.test(p.name || '') || p.type === 'Cellar').sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  return (
    <>
      <div className="table-scroll" style={{ marginTop: 8 }}>
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>Location</th><th>Building</th><th className="num">Bays</th><th className="num">Capacity (cwt)</th><th className="num">In this plan</th><th>Position from</th>{canEdit && <th>Farm Map cellar</th>}</tr></thead>
          <tbody>
            {sites.map((s) => {
              const used = s.bays.reduce((t, b) => t + st.bays[b.id].used, 0)
              const cap = s.bays.reduce((t, b) => t + b.capacity, 0)
              return (
                <tr key={s.id}>
                  <td>{s.locationName}</td><td><strong>{s.name}</strong></td><td className="num">{s.bays.length}</td><td className="num">{fmt(cap)}</td>
                  <td className="num">{used > 0 ? fmt(used) : ''}</td>
                  <td className={s.source === 'storage-module' || !s.source ? 'csp-src-weak' : ''}>{SOURCE_LABEL[s.source]}{s.pointName ? ` — ${s.pointName}` : ''}</td>
                  {canEdit && <td>
                    <select value={(positions[s.id] && positions[s.id].pointId) || ''} onChange={(e) => run(e.target.value ? setDoc(doc(db, 'storageSites', s.id), { pointId: e.target.value, updatedBy: who(), updatedAt: Date.now() }) : deleteDoc(doc(db, 'storageSites', s.id)), 'Position saved.')}>
                      <option value="">{s.source === 'farm-map-auto' ? 'Matched by name' : 'Pick a cellar…'}</option>
                      {cellars.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </td>}
                </tr>
              )
            })}
          </tbody>
          {sites.length > 0 && <tfoot><tr><td colSpan={3}><strong>Total</strong></td><td className="num"><strong>{fmt(sites.reduce((t, s) => t + s.bays.reduce((a, b) => a + b.capacity, 0), 0))}</strong></td><td className="num"><strong>{fmt(st.totals.placed)}</strong></td><td colSpan={canEdit ? 2 : 1} /></tr></tfoot>}
        </table>
      </div>
      <div className="contracts-sub">Capacity is each bay’s pipes × cwt per pipe from Potato Storage (9′ piles count half). Buildings are placed at the cellar with the same name on the Farm Map; pick a different cellar here if a match is wrong. Bays are edited in Potato Storage.</div>
    </>
  )
}

function PlanMap({ sites, st, sel, onPick }) {
  const el = useRef(null)
  const mapRef = useRef(null)
  useEffect(() => {
    let map = null, gone = false
    loadLeaflet().then((L) => {
      if (gone || !el.current) return
      map = L.map(el.current, { zoomControl: true, attributionControl: false })
      mapRef.current = map
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map)
      const g = L.featureGroup().addTo(map)
      const yards = yardsOf(sites)
      const yardOf = Object.fromEntries(yards.flatMap((y) => y.sites.map((s) => [s.id, y])))
      // lines field → bay site, thicker for more cwt
      st.fields.forEach((f) => {
        if (!f.pos) return
        const bySite = {}
        Object.values(st.bays).forEach((b) => b.items.forEach((a) => { if (a.fieldId === f.id) { const y = yardOf[b.site.id].name; bySite[y] = (bySite[y] || 0) + Number(a.cwt || 0) } }))
        Object.entries(bySite).forEach(([yn, cwt]) => {
          const y = yards.find((x) => x.name === yn)
          if (!y || !y.pos) return
          L.polyline([[f.pos.lat, f.pos.lng], [y.pos.lat, y.pos.lng]], { color: familyColor(f.family), weight: Math.max(2, Math.min(8, cwt / 15000)), opacity: sel && sel !== f.id ? 0.25 : 0.9 })
            .bindTooltip(`${esc(f.name)} → ${esc(y.name)}: ${fmt(cwt)} cwt · ${mi(milesBetween(f.pos, y.pos))}`, { sticky: true }).addTo(g)
        })
      })
      st.fields.forEach((f) => {
        if (!f.pos) return
        L.circleMarker([f.pos.lat, f.pos.lng], { radius: Math.max(6, Math.min(14, Math.sqrt(f.acres) / 1.4)), color: f.left > 0.5 ? '#fff' : '#111', weight: f.left > 0.5 ? 3 : 1.5, dashArray: f.left > 0.5 ? '3 3' : null, fillColor: familyColor(f.family), fillOpacity: 0.9 })
          .bindTooltip(`<b>${esc(f.name)}</b><br>${esc(f.variety || 'no variety')} · ${esc(f.customer)}<br>${fmt(f.cwt)} cwt${f.left > 0.5 ? ` · ${fmt(f.left)} not placed` : ''}${f.near[0] ? `<br>Nearest: ${esc(f.near[0].location)} ${mi(f.near[0].miles)}` : ''}`)
          .on('click', () => onPick(f.id)).addTo(g)
      })
      yards.filter((y) => y.pos).forEach((y) => {
        const cap = y.bays.reduce((t, b) => t + b.capacity, 0)
        const used = y.bays.reduce((t, b) => t + st.bays[b.id].used, 0)
        const icon = L.divIcon({ className: 'csp-pin', html: `<div><b>${esc(y.name)}</b><span>${fmtK(used)} / ${fmtK(cap)} cwt</span></div>`, iconSize: null })
        L.marker([y.pos.lat, y.pos.lng], { icon, zIndexOffset: 1000 }).bindTooltip(y.bays.map((b) => { const x = st.bays[b.id]; return `${esc(b.name)}: ${x.lock ? `${esc(x.lock.variety)} · ${esc(x.lock.customer)} ` : ''}${fmt(x.used)} / ${fmt(b.capacity)}` }).join('<br>')).addTo(g)
      })
      if (g.getLayers().length) map.fitBounds(g.getBounds(), { padding: [30, 30] })
      else map.setView([42.65, -113.7], 10)
    })
    return () => { gone = true; if (map) map.remove(); mapRef.current = null }
  }, [sites, st, sel])
  const fams = [...new Map(st.fields.map((f) => [f.family, f.variety])).entries()]
  return (
    <>
      <div className="csp-map" ref={el} />
      <div className="csp-legend">
        {fams.map(([fam, v]) => <span key={fam || 'none'}><i style={{ background: familyColor(fam) }} />{fam ? v : 'no variety'}</span>)}
        <span><i className="csp-dashed" />not placed yet</span>
        <span className="contracts-sub">Lines run from each field to the storage it’s planned for. Click a field to pick it, then place it on the Board.</span>
      </div>
    </>
  )
}
