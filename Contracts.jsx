import { Fragment, useEffect, useMemo, useState } from 'react'
import {
  addDoc, collection, collectionGroup, doc, onSnapshot, query,
  serverTimestamp, updateDoc, where, writeBatch
} from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { UNITS, acresToUnits, contractProgress, fieldMatchesContract, fmtNum } from './contractMath.js'

// Contracts module — a quick view of the season's acres (from the same
// Agworld-synced fields/{id}/seasons/{id} data Irrigation and Agronomy read),
// plus processor / beet-share / corn / onion contracts and which whole
// fields are allocated to each.
//
// Data (see firestore.rules):
//   contracts/{autoId}                       one doc per contract, tagged with seasonId
//   contractAllocations/{seasonId}__{fieldId} one doc per allocated field — keying on
//                                             season+field means a field can only ever
//                                             sit on ONE contract per season (whole-field
//                                             allocation, per Kent), enforced by the data
//                                             shape itself rather than by UI checks.
// Admin/Owner can edit; Farm managers can view. The rules are the real gate.

const CROP_COLOR = {
  POTATO: { bg: '#D6B48C', fg: '#4A2E12' }, POTATOES: { bg: '#D6B48C', fg: '#4A2E12' },
  CORN: { bg: '#FCE9A8', fg: '#7A5C02' }, 'SWEET CORN': { bg: '#FCE9A8', fg: '#7A5C02' },
  ALFALFA: { bg: '#C0DD97', fg: '#173404' }, HAY: { bg: '#C0DD97', fg: '#173404' },
  'SUGAR BEET': { bg: '#E0D6F5', fg: '#3D2B6B' }, BEETS: { bg: '#E0D6F5', fg: '#3D2B6B' },
  FALLOW: { bg: '#E4E1D8', fg: '#5A574C' }, ONIONS: { bg: '#F4C0D1', fg: '#4B1528' },
  MINT: { bg: '#9FE1CB', fg: '#04342C' }, CARROTS: { bg: '#FAD9BB', fg: '#7A3E0A' },
  SQUASH: { bg: '#F5C98A', fg: '#6B3D02' }
}
function CropBadge({ crop }) {
  if (!crop) return null
  const c = CROP_COLOR[crop] || { bg: '#D3D1C7', fg: '#2C2C2A' }
  return <span className="crop-badge" style={{ background: c.bg, color: c.fg }}>{crop}</span>
}

const STATUS_STYLE = {
  open: { label: 'Open', color: '#854F0B', bar: '#EF9F27' },
  filled: { label: 'Filled', color: '#3B6D11', bar: '#3B6D11' },
  over: { label: 'Over', color: '#A32D2D', bar: '#A32D2D' },
  incomplete: { label: 'Needs yield', color: '#888', bar: '#bbb' }
}

function ProgressBar({ pct, status }) {
  const width = Math.max(0, Math.min(100, pct || 0))
  return (
    <div className="contracts-bar">
      <div className="contracts-bar-fill" style={{ width: width + '%', background: STATUS_STYLE[status].bar }} />
    </div>
  )
}

function allocId(seasonId, fieldId) { return `${seasonId}__${fieldId}` }

function who() {
  const u = auth.currentUser
  return u ? (u.email || u.uid) : null
}

export default function Contracts({ userRole }) {
  const canEdit = userRole === 'admin' || userRole === 'owner'
  const [view, setView] = useState('acres')
  const [seasons, setSeasons] = useState([])
  const [selectedSeasonId, setSelectedSeasonId] = useState(null)
  const [farms, setFarms] = useState([])
  const [selectedFarmId, setSelectedFarmId] = useState('all')
  const [baseFieldsById, setBaseFieldsById] = useState({})
  const [seasonDataByField, setSeasonDataByField] = useState({})
  const [contracts, setContracts] = useState([])
  const [allocations, setAllocations] = useState([])
  const [error, setError] = useState(null)
  // Lifted so the Acres view can jump straight into Allocate pre-filtered.
  const [allocFilter, setAllocFilter] = useState({ crop: 'all', status: 'all', contractId: 'all', search: '' })

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'fields'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data() })
      setBaseFieldsById(next)
    })
    return () => unsub()
  }, [])

  // Same "default to the season matching the current calendar year"
  // pattern used in App.jsx and Agronomy.jsx.
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'seasons'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
      setSeasons(list)
      setSelectedSeasonId((prev) => {
        if (prev) return prev
        const currentYear = String(new Date().getFullYear())
        const currentSeason = list.find((s) => String(s.name) === currentYear)
        return currentSeason ? currentSeason.id : (list[0] ? list[0].id : null)
      })
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'farms'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setFarms(list)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    if (!selectedSeasonId) return
    const q = query(collectionGroup(db, 'seasons'), where('seasonId', '==', selectedSeasonId))
    const unsub = onSnapshot(q, (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.ref.parent.parent.id] = d.data() })
      setSeasonDataByField(next)
    })
    return () => unsub()
  }, [selectedSeasonId])

  useEffect(() => {
    if (!selectedSeasonId) return
    const seasonKey = String(selectedSeasonId)
    const onErr = (e) => setError(e.code === 'permission-denied'
      ? 'No permission to read contracts. If this is the first time the module has been opened, the new firestore.rules may not be deployed yet.'
      : e.message)
    const unsubC = onSnapshot(query(collection(db, 'contracts'), where('seasonId', '==', seasonKey)), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.crop || '').localeCompare(b.crop || '') || (a.name || '').localeCompare(b.name || ''))
      setContracts(list)
      setError(null)
    }, onErr)
    const unsubA = onSnapshot(query(collection(db, 'contractAllocations'), where('seasonId', '==', seasonKey)), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setAllocations(list)
    }, onErr)
    return () => { unsubC(); unsubA() }
  }, [selectedSeasonId])

  // Every field planted this season, across ALL farms. Contract progress is
  // always computed from this, since one contract can span several farms —
  // the farm picker only narrows what's listed, never the totals on a contract.
  const seasonFields = useMemo(() => {
    return Object.entries(baseFieldsById)
      .filter(([id]) => seasonDataByField[id])
      .map(([id, base]) => {
        const sd = seasonDataByField[id] || {}
        return {
          id,
          name: base.name,
          farmId: base.farmId,
          farmName: base.farmName,
          crop: (sd.cropName || '').toUpperCase(),
          variety: sd.varietyName || null,
          acres: Number(sd.acres) || 0
        }
      })
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [baseFieldsById, seasonDataByField])

  const fields = useMemo(() => seasonFields.filter((f) => selectedFarmId === 'all' || String(f.farmId) === String(selectedFarmId)),
    [seasonFields, selectedFarmId])

  const contractsById = useMemo(() => Object.fromEntries(contracts.map((c) => [c.id, c])), [contracts])

  // fieldId -> contractId, ignoring allocations pointing at a deleted contract
  // or a field no longer in this season.
  const allocByField = useMemo(() => {
    const m = {}
    allocations.forEach((a) => { if (contractsById[a.contractId]) m[a.fieldId] = a.contractId })
    return m
  }, [allocations, contractsById])

  const progressByContract = useMemo(() => {
    const acresBy = {}
    const fieldsBy = {}
    seasonFields.forEach((f) => {
      const cid = allocByField[f.id]
      if (!cid) return
      acresBy[cid] = (acresBy[cid] || 0) + f.acres
      ;(fieldsBy[cid] = fieldsBy[cid] || []).push(f)
    })
    const out = {}
    contracts.forEach((c) => { out[c.id] = { ...contractProgress(c, acresBy[c.id] || 0), fields: fieldsBy[c.id] || [] } })
    return out
  }, [contracts, seasonFields, allocByField])

  const cropOptions = useMemo(() => [...new Set(seasonFields.map((f) => f.crop).filter(Boolean))].sort(), [seasonFields])
  const varietiesByCrop = useMemo(() => {
    const m = {}
    seasonFields.forEach((f) => {
      if (!f.crop || !f.variety) return
      ;(m[f.crop] = m[f.crop] || new Set()).add(f.variety)
    })
    return Object.fromEntries(Object.entries(m).map(([k, s]) => [k, [...s].sort()]))
  }, [seasonFields])

  async function assign(fieldIds, contractId) {
    const seasonKey = String(selectedSeasonId)
    const batch = writeBatch(db)
    fieldIds.forEach((fid) => {
      const ref = doc(db, 'contractAllocations', allocId(seasonKey, fid))
      if (contractId) {
        const f = seasonFields.find((x) => x.id === fid)
        batch.set(ref, {
          seasonId: seasonKey, fieldId: fid, contractId,
          // Snapshot for reference/exports only — live acres always come from Agworld.
          acresAtAllocation: f ? f.acres : null,
          updatedAt: serverTimestamp(), updatedBy: who()
        })
      } else {
        batch.delete(ref)
      }
    })
    await batch.commit()
  }

  function jumpToAllocate(crop, status) {
    setAllocFilter({ crop: crop || 'all', status: status || 'all', contractId: 'all', search: '' })
    setView('allocate')
  }

  function showContractFields(contractId) {
    setAllocFilter({ crop: 'all', status: 'all', contractId, search: '' })
    setView('allocate')
  }

  return (
    <div className="agronomy contracts">
      <div className="agronomy-filter-bar">
        {seasons.length > 0 && (
          <select value={selectedSeasonId || ''} onChange={(e) => setSelectedSeasonId(e.target.value)}>
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <select value={selectedFarmId} onChange={(e) => setSelectedFarmId(e.target.value)}>
          <option value="all">All farms</option>
          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
        {!canEdit && <span className="contracts-readonly">View only</span>}
      </div>

      <div className="agronomy-view-toggle">
        <button className={view === 'acres' ? 'active' : ''} onClick={() => setView('acres')}>Acres</button>
        <button className={view === 'contracts' ? 'active' : ''} onClick={() => setView('contracts')}>Contracts{contracts.length ? ` (${contracts.length})` : ''}</button>
        <button className={view === 'allocate' ? 'active' : ''} onClick={() => setView('allocate')}>{canEdit ? 'Allocate fields' : 'Field allocations'}</button>
      </div>

      {error && <div className="agronomy-error-banner">{error}</div>}

      {view === 'acres' && (
        <AcresView fields={fields} allocByField={allocByField} contracts={contracts} progressByContract={progressByContract}
          farmFiltered={selectedFarmId !== 'all'} onJump={jumpToAllocate} />
      )}
      {view === 'contracts' && (
        <ContractsView contracts={contracts} progressByContract={progressByContract} canEdit={canEdit}
          seasonId={selectedSeasonId} cropOptions={cropOptions} varietiesByCrop={varietiesByCrop}
          allocations={allocations} onShowFields={showContractFields} seasonFields={seasonFields} allocByField={allocByField} />
      )}
      {view === 'allocate' && (
        <AllocateView fields={fields} contracts={contracts} contractsById={contractsById} allocByField={allocByField}
          progressByContract={progressByContract} canEdit={canEdit} onAssign={assign}
          filter={allocFilter} setFilter={setAllocFilter} cropOptions={cropOptions}
          seasonName={(seasons.find((s) => String(s.id) === String(selectedSeasonId)) || {}).name} />
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Acres                                                              */
/* ------------------------------------------------------------------ */

function AcresView({ fields, allocByField, contracts, progressByContract, farmFiltered, onJump }) {
  const [expanded, setExpanded] = useState(new Set())

  const totals = useMemo(() => {
    let acres = 0, alloc = 0
    fields.forEach((f) => { acres += f.acres; if (allocByField[f.id]) alloc += f.acres })
    return { acres, alloc, open: acres - alloc, count: fields.length }
  }, [fields, allocByField])

  // crop -> { acres, alloc, count, varieties: { name -> {acres, alloc, count} } }
  const byCrop = useMemo(() => {
    const m = {}
    fields.forEach((f) => {
      const crop = f.crop || '(NO CROP)'
      const c = (m[crop] = m[crop] || { crop, acres: 0, alloc: 0, count: 0, varieties: {} })
      const vName = f.variety || '(no variety)'
      const v = (c.varieties[vName] = c.varieties[vName] || { name: vName, acres: 0, alloc: 0, count: 0 })
      const isAlloc = !!allocByField[f.id]
      c.acres += f.acres; c.count++; v.acres += f.acres; v.count++
      if (isAlloc) { c.alloc += f.acres; v.alloc += f.acres }
    })
    return Object.values(m).sort((a, b) => b.acres - a.acres)
  }, [fields, allocByField])

  // Contracted demand per crop, converted to acres, so open acres can be
  // compared against what the contracts still need.
  const needByCrop = useMemo(() => {
    const m = {}
    contracts.forEach((c) => {
      const p = progressByContract[c.id]
      if (!p || p.remainingAcres == null) return
      m[c.crop] = (m[c.crop] || 0) + Math.max(0, p.remainingAcres)
    })
    return m
  }, [contracts, progressByContract])

  function toggle(crop) {
    setExpanded((prev) => { const n = new Set(prev); n.has(crop) ? n.delete(crop) : n.add(crop); return n })
  }

  return (
    <>
      <div className="agronomy-kpi-grid">
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Fields</p><p className="agronomy-kpi-value">{totals.count}</p></div>
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Total acres</p><p className="agronomy-kpi-value">{fmtNum(totals.acres, 1)} <span className="agronomy-kpi-unit">ac</span></p></div>
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">On a contract</p><p className="agronomy-kpi-value">{fmtNum(totals.alloc, 1)} <span className="agronomy-kpi-unit">ac · {totals.acres ? Math.round((totals.alloc / totals.acres) * 100) : 0}%</span></p></div>
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Open (uncontracted)</p><p className="agronomy-kpi-value">{fmtNum(totals.open, 1)} <span className="agronomy-kpi-unit">ac</span></p></div>
      </div>

      <div className="table-scroll" style={{ maxHeight: 'none' }}>
        <table className="contracts-table">
          <colgroup>
            <col style={{ width: '34%' }} /><col style={{ width: '9%' }} /><col style={{ width: '12%' }} />
            <col style={{ width: '12%' }} /><col style={{ width: '12%' }} /><col style={{ width: '21%' }} />
          </colgroup>
          <thead>
            <tr>
              <th>Crop / variety</th><th className="num">Fields</th><th className="num">Acres</th>
              <th className="num">Contracted</th><th className="num">Open</th><th>Contracted share</th>
            </tr>
          </thead>
          <tbody>
            {byCrop.length === 0 && <tr><td colSpan={6} className="contracts-empty">No fields for this season{farmFiltered ? ' and farm' : ''}.</td></tr>}
            {byCrop.map((c) => {
              const isOpen = expanded.has(c.crop)
              const pct = c.acres ? (c.alloc / c.acres) * 100 : 0
              const need = needByCrop[c.crop]
              return (
                <Fragment key={c.crop}>
                  <tr className="contracts-crop-row" onClick={() => toggle(c.crop)}>
                    <td><span className="contracts-caret">{isOpen ? '▾' : '▸'}</span> <CropBadge crop={c.crop} /></td>
                    <td className="num">{c.count}</td>
                    <td className="num"><strong>{fmtNum(c.acres, 1)}</strong></td>
                    <td className="num">{fmtNum(c.alloc, 1)}</td>
                    <td className="num">
                      {c.acres - c.alloc > 0.05
                        ? <button className="contracts-link" onClick={(e) => { e.stopPropagation(); onJump(c.crop, 'open') }}>{fmtNum(c.acres - c.alloc, 1)}</button>
                        : '—'}
                    </td>
                    <td>
                      <ProgressBar pct={pct} status={pct >= 99.5 ? 'filled' : 'open'} />
                      <div className="contracts-sub">{Math.round(pct)}%{need > 0.05 && !farmFiltered ? ` · contracts still need ~${fmtNum(need, 0)} ac` : ''}</div>
                    </td>
                  </tr>
                  {isOpen && Object.values(c.varieties).sort((a, b) => b.acres - a.acres).map((v) => {
                    const vp = v.acres ? (v.alloc / v.acres) * 100 : 0
                    return (
                      <tr key={c.crop + v.name} className="contracts-variety-row">
                        <td style={{ paddingLeft: 28 }}>{v.name}</td>
                        <td className="num">{v.count}</td>
                        <td className="num">{fmtNum(v.acres, 1)}</td>
                        <td className="num">{fmtNum(v.alloc, 1)}</td>
                        <td className="num">{fmtNum(v.acres - v.alloc, 1)}</td>
                        <td><ProgressBar pct={vp} status={vp >= 99.5 ? 'filled' : 'open'} /></td>
                      </tr>
                    )
                  })}
                </Fragment>
              )
            })}
          </tbody>
          {byCrop.length > 0 && (
            <tfoot>
              <tr>
                <td><strong>Total</strong></td><td className="num">{totals.count}</td>
                <td className="num"><strong>{fmtNum(totals.acres, 1)}</strong></td>
                <td className="num">{fmtNum(totals.alloc, 1)}</td><td className="num">{fmtNum(totals.open, 1)}</td><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="contracts-hint">Acres come from Agworld (synced daily). Tap a crop to see varieties, or an open-acres number to allocate those fields.</p>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Contracts                                                          */
/* ------------------------------------------------------------------ */

const EMPTY_CONTRACT = { name: '', buyer: '', crop: '', varieties: [], unit: 'cwt', amount: '', yieldPerAcre: '', acresPerShare: '', price: '', notes: '' }

function ContractsView({ contracts, progressByContract, canEdit, seasonId, cropOptions, varietiesByCrop, allocations, onShowFields, seasonFields, allocByField }) {
  const [editing, setEditing] = useState(null) // null | 'new' | contract id
  const [form, setForm] = useState(EMPTY_CONTRACT)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState(null)
  const [cropFilter, setCropFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')

  function startNew() {
    setForm({ ...EMPTY_CONTRACT, crop: cropOptions[0] || '' })
    setEditing('new'); setFormError(null)
  }
  function startEdit(c) {
    setForm({
      name: c.name || '', buyer: c.buyer || '', crop: c.crop || '', varieties: c.varieties || [], unit: c.unit || 'cwt',
      amount: c.amount ?? '', yieldPerAcre: c.yieldPerAcre ?? '', acresPerShare: c.acresPerShare ?? '', price: c.price ?? '', notes: c.notes || ''
    })
    setEditing(c.id); setFormError(null)
  }

  const num = (v) => (v === '' || v == null || isNaN(Number(v)) ? null : Number(v))

  async function save() {
    if (!form.name.trim()) return setFormError('Give the contract a name.')
    if (!form.crop) return setFormError('Pick a crop.')
    if (!(num(form.amount) > 0)) return setFormError('Enter the contracted amount.')
    const payload = {
      seasonId: String(seasonId),
      name: form.name.trim(), buyer: form.buyer.trim(), crop: form.crop,
      varieties: form.varieties, unit: form.unit, amount: num(form.amount),
      yieldPerAcre: UNITS[form.unit].kind === 'yield' ? num(form.yieldPerAcre) : null,
      acresPerShare: UNITS[form.unit].kind === 'share' ? num(form.acresPerShare) : null,
      price: num(form.price), notes: form.notes.trim(),
      updatedAt: serverTimestamp(), updatedBy: who()
    }
    setSaving(true)
    try {
      if (editing === 'new') {
        await addDoc(collection(db, 'contracts'), { ...payload, createdAt: serverTimestamp() })
      } else {
        await updateDoc(doc(db, 'contracts', editing), payload)
      }
      setEditing(null)
    } catch (e) {
      setFormError(e.message)
    } finally {
      setSaving(false)
    }
  }

  async function remove(c) {
    const n = (progressByContract[c.id] || {}).fields?.length || 0
    if (!window.confirm(`Delete "${c.name}"?${n ? ` Its ${n} allocated field${n === 1 ? '' : 's'} will go back to open.` : ''}`)) return
    const batch = writeBatch(db)
    allocations.filter((a) => a.contractId === c.id).forEach((a) => batch.delete(doc(db, 'contractAllocations', a.id)))
    batch.delete(doc(db, 'contracts', c.id))
    await batch.commit()
    if (editing === c.id) setEditing(null)
  }

  const visible = contracts.filter((c) => (cropFilter === 'all' || c.crop === cropFilter)
    && (statusFilter === 'all' || (progressByContract[c.id] || {}).status === statusFilter))

  // Roll-up per crop + unit (cwt and tons can't be summed together).
  const rollup = useMemo(() => {
    const m = {}
    contracts.forEach((c) => {
      const p = progressByContract[c.id]; if (!p) return
      const key = c.crop + '|' + c.unit
      const r = (m[key] = m[key] || { crop: c.crop, unit: c.unit, amount: 0, allocated: 0, value: 0, hasValue: false })
      r.amount += c.amount || 0
      r.allocated += p.allocatedUnits || 0
      if (c.price != null && p.allocatedUnits != null) { r.value += c.price * p.allocatedUnits; r.hasValue = true }
    })
    return Object.values(m).sort((a, b) => a.crop.localeCompare(b.crop))
  }, [contracts, progressByContract])

  const unitInfo = UNITS[form.unit]
  const preview = editing ? contractProgress({ ...form, amount: num(form.amount), yieldPerAcre: num(form.yieldPerAcre), acresPerShare: num(form.acresPerShare) }, 0) : null

  // Open fields that would fit the contract being edited — shown as a hint.
  const fitAcres = useMemo(() => {
    if (!editing || !form.crop) return null
    const c = { crop: form.crop, varieties: form.varieties }
    return seasonFields.filter((f) => !allocByField[f.id] && fieldMatchesContract(f, c)).reduce((s, f) => s + f.acres, 0)
  }, [editing, form.crop, form.varieties, seasonFields, allocByField])

  return (
    <>
      {rollup.length > 0 && (
        <div className="agronomy-kpi-grid">
          {rollup.map((r) => (
            <div key={r.crop + r.unit} className="agronomy-kpi-card">
              <p className="agronomy-kpi-label"><CropBadge crop={r.crop} /> {UNITS[r.unit].label} contracted</p>
              <p className="agronomy-kpi-value">{fmtNum(r.allocated, 0)} <span className="agronomy-kpi-unit">/ {fmtNum(r.amount, 0)} {UNITS[r.unit].label}</span></p>
              {r.hasValue && <p className="contracts-sub">≈ ${fmtNum(r.value, 0)} allocated value</p>}
            </div>
          ))}
        </div>
      )}

      <div className="agronomy-filter-bar">
        <select value={cropFilter} onChange={(e) => setCropFilter(e.target.value)}>
          <option value="all">All crops</option>
          {[...new Set(contracts.map((c) => c.crop))].sort().map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">Any status</option>
          <option value="open">Still open</option>
          <option value="filled">Filled</option>
          <option value="over">Over-allocated</option>
          <option value="incomplete">Needs yield / share factor</option>
        </select>
        {canEdit && <button className="save" onClick={startNew} disabled={!seasonId}>+ New contract</button>}
      </div>

      {editing && (
        <div className="editor-panel contracts-form">
          <div className="editor-field-name">{editing === 'new' ? 'New contract' : 'Edit contract'}</div>
          <div className="contracts-form-grid">
            <label>Contract name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Simplot Burbank #1" /></label>
            <label>Buyer<input value={form.buyer} onChange={(e) => setForm({ ...form, buyer: e.target.value })} placeholder="e.g. Simplot, Amalgamated" /></label>
            <label>Crop
              <select value={form.crop} onChange={(e) => setForm({ ...form, crop: e.target.value, varieties: [] })}>
                <option value="">Pick a crop…</option>
                {[...new Set([...cropOptions, form.crop].filter(Boolean))].sort().map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <label>Contract unit
              <select value={form.unit} onChange={(e) => setForm({ ...form, unit: e.target.value })}>
                {Object.entries(UNITS).map(([k, u]) => <option key={k} value={k}>{u.name}</option>)}
              </select>
            </label>
            <label>Amount ({unitInfo.label})<input type="number" inputMode="decimal" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} /></label>
            {unitInfo.kind === 'yield' && (
              <label>Expected yield ({unitInfo.label}/ac)<input type="number" inputMode="decimal" value={form.yieldPerAcre} onChange={(e) => setForm({ ...form, yieldPerAcre: e.target.value })} placeholder={form.unit === 'cwt' ? 'e.g. 450' : 'e.g. 38'} /></label>
            )}
            {unitInfo.kind === 'share' && (
              <label>Acres per share<input type="number" inputMode="decimal" value={form.acresPerShare} onChange={(e) => setForm({ ...form, acresPerShare: e.target.value })} placeholder="e.g. 1" /></label>
            )}
            <label>Price ($/{unitInfo.label}, optional)<input type="number" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} /></label>
          </div>
          {form.crop && (varietiesByCrop[form.crop] || []).length > 0 && (
            <>
              <div className="editor-label">Varieties allowed <span className="contracts-sub">(none checked = any {form.crop.toLowerCase()} variety)</span></div>
              <div className="contracts-variety-picks">
                {[...new Set([...(varietiesByCrop[form.crop] || []), ...form.varieties])].sort().map((v) => (
                  <label key={v}>
                    <input type="checkbox" checked={form.varieties.includes(v)}
                      onChange={() => setForm({ ...form, varieties: form.varieties.includes(v) ? form.varieties.filter((x) => x !== v) : [...form.varieties, v] })} />
                    {v}
                  </label>
                ))}
              </div>
            </>
          )}
          <label className="contracts-notes">Notes<textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Delivery window, storage terms, bonus/penalty specs…" /></label>
          {preview && preview.targetAcres != null && (
            <div className="contracts-hint">
              ≈ <strong>{fmtNum(preview.targetAcres, 1)} ac</strong> needed to fill this contract
              {fitAcres != null ? ` · ${fmtNum(fitAcres, 1)} ac of matching fields are still open` : ''}.
            </div>
          )}
          {formError && <div className="agronomy-error-banner">{formError}</div>}
          <div className="editor-row">
            <button className="save" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</button>
            <button onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      )}

      {visible.length === 0 && !editing && (
        <p className="contracts-empty">{contracts.length === 0 ? `No contracts for this season yet.${canEdit ? ' Tap “+ New contract” to add one.' : ''}` : 'No contracts match these filters.'}</p>
      )}

      <div className="contracts-cards">
        {visible.map((c) => {
          const p = progressByContract[c.id] || {}
          const st = STATUS_STYLE[p.status || 'incomplete']
          const u = UNITS[c.unit] || UNITS.acres
          return (
            <div key={c.id} className="contracts-card">
              <div className="contracts-card-head">
                <div>
                  <div className="contracts-card-title">{c.name}</div>
                  <div className="contracts-sub">{c.buyer || '—'}</div>
                </div>
                <span className="contracts-status" style={{ color: st.color, borderColor: st.color }}>{st.label}</span>
              </div>
              <div style={{ margin: '6px 0' }}>
                <CropBadge crop={c.crop} />{' '}
                <span className="contracts-sub">{c.varieties && c.varieties.length ? c.varieties.join(', ') : 'Any variety'}</span>
              </div>
              <ProgressBar pct={p.pct} status={p.status || 'incomplete'} />
              <div className="contracts-card-nums">
                <span><strong>{p.allocatedUnits != null ? fmtNum(p.allocatedUnits, 0) : '—'}</strong> / {fmtNum(c.amount, 0)} {u.label}</span>
                <span>{p.pct != null ? Math.round(p.pct) + '%' : ''}</span>
              </div>
              <div className="contracts-sub">
                {fmtNum(p.allocatedAcres, 1)} ac on {p.fields ? p.fields.length : 0} field{p.fields && p.fields.length === 1 ? '' : 's'}
                {u.kind === 'yield' && c.yieldPerAcre ? ` · @ ${fmtNum(c.yieldPerAcre, 0)} ${u.label}/ac` : ''}
                {u.kind === 'share' && c.acresPerShare ? ` · ${fmtNum(c.acresPerShare, 2)} ac/share` : ''}
              </div>
              {p.remainingAcres != null && Math.abs(p.remainingAcres) > 0.05 && (
                <div className="contracts-sub" style={{ color: p.status === 'filled' ? '#3B6D11' : p.remainingAcres < 0 ? '#A32D2D' : '#854F0B' }}>
                  {p.status === 'filled'
                    ? `On target (${p.remainingAcres > 0 ? '−' : '+'}${fmtNum(Math.abs(p.remainingAcres), 1)} ac)`
                    : p.remainingAcres > 0
                    ? `Needs ~${fmtNum(p.remainingAcres, 1)} more ac (${fmtNum(p.remainingUnits, 0)} ${u.label})`
                    : `Over by ~${fmtNum(-p.remainingAcres, 1)} ac (${fmtNum(-p.remainingUnits, 0)} ${u.label})`}
                </div>
              )}
              {p.status === 'incomplete' && <div className="contracts-sub">Add {u.kind === 'share' ? 'acres per share' : 'expected yield'} to track progress.</div>}
              {c.price != null && p.allocatedUnits != null && <div className="contracts-sub">≈ ${fmtNum(c.price * p.allocatedUnits, 0)} at ${fmtNum(c.price, 2)}/{u.label}</div>}
              {c.notes && <div className="contracts-notes-text">{c.notes}</div>}
              <div className="contracts-card-actions">
                <button onClick={() => onShowFields(c.id)}>Fields</button>
                {canEdit && <button onClick={() => startEdit(c)}>Edit</button>}
                {canEdit && <button onClick={() => remove(c)} style={{ color: '#A32D2D' }}>Delete</button>}
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Allocate                                                           */
/* ------------------------------------------------------------------ */

function AllocateView({ fields, contracts, contractsById, allocByField, progressByContract, canEdit, onAssign, filter, setFilter, cropOptions, seasonName }) {
  const [selected, setSelected] = useState(new Set())
  const [bulkContract, setBulkContract] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  const rows = useMemo(() => {
    const s = filter.search.trim().toLowerCase()
    return fields.filter((f) => {
      const cid = allocByField[f.id]
      if (filter.crop !== 'all' && f.crop !== filter.crop) return false
      if (filter.status === 'open' && cid) return false
      if (filter.status === 'allocated' && !cid) return false
      if (filter.contractId !== 'all' && cid !== filter.contractId) return false
      if (s && !`${f.name} ${f.farmName || ''} ${f.variety || ''}`.toLowerCase().includes(s)) return false
      return true
    })
  }, [fields, allocByField, filter])

  // Drop selections that scrolled out of the filtered list.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(rows.map((r) => r.id))
      const next = new Set([...prev].filter((id) => ids.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [rows])

  const selectedFields = rows.filter((r) => selected.has(r.id))
  const selectedAcres = selectedFields.reduce((s, f) => s + f.acres, 0)
  // Contracts every selected field is eligible for.
  const bulkOptions = contracts.filter((c) => selectedFields.length > 0 && selectedFields.every((f) => fieldMatchesContract(f, c)))

  useEffect(() => { if (bulkContract && !bulkOptions.find((c) => c.id === bulkContract)) setBulkContract('') }, [bulkOptions, bulkContract])

  async function run(fieldIds, contractId) {
    setBusy(true); setMsg(null)
    try { await onAssign(fieldIds, contractId) } catch (e) { setMsg(e.message) } finally { setBusy(false) }
  }

  async function applyBulk() {
    if (!bulkContract) return
    await run([...selected], bulkContract)
    setSelected(new Set())
  }
  async function clearBulk() {
    await run([...selected], null)
    setSelected(new Set())
  }

  function exportCsv() {
    const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
    const lines = [['Season', 'Field', 'Farm', 'Crop', 'Variety', 'Acres', 'Contract', 'Buyer', 'Unit', 'Est. volume'].join(',')]
    rows.forEach((f) => {
      const c = contractsById[allocByField[f.id]]
      const est = c ? acresToUnits(c, f.acres) : null
      lines.push([seasonName, f.name, f.farmName, f.crop, f.variety, f.acres.toFixed(2), c && c.name, c && c.buyer, c && UNITS[c.unit].label, est != null ? est.toFixed(1) : ''].map(esc).join(','))
    })
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `contract-allocations-${seasonName || 'season'}.csv`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }

  const allChecked = rows.length > 0 && rows.every((r) => selected.has(r.id))
  const totalAcres = rows.reduce((s, f) => s + f.acres, 0)

  return (
    <>
      <div className="agronomy-filter-bar">
        <input className="agronomy-search-input" placeholder="Search field, farm, variety…" value={filter.search} onChange={(e) => setFilter({ ...filter, search: e.target.value })} />
        <select value={filter.crop} onChange={(e) => setFilter({ ...filter, crop: e.target.value })}>
          <option value="all">All crops</option>
          {cropOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="all">Open + allocated</option>
          <option value="open">Open only</option>
          <option value="allocated">Allocated only</option>
        </select>
        <select value={filter.contractId} onChange={(e) => setFilter({ ...filter, contractId: e.target.value })}>
          <option value="all">Any contract</option>
          {contracts.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <button onClick={exportCsv} disabled={rows.length === 0}>Export CSV</button>
      </div>

      {canEdit && selected.size > 0 && (
        <div className="mode-bar">
          <div>{selected.size} field{selected.size === 1 ? '' : 's'} selected · {fmtNum(selectedAcres, 1)} ac</div>
          <div className="mode-bar-actions" style={{ flexWrap: 'wrap' }}>
            <select value={bulkContract} onChange={(e) => setBulkContract(e.target.value)} disabled={busy}>
              <option value="">{bulkOptions.length ? 'Assign to contract…' : 'No contract fits every selected field'}</option>
              {bulkOptions.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="apply" disabled={!bulkContract || busy} onClick={applyBulk}>Assign</button>
            <button className="apply danger" disabled={busy || !selectedFields.some((f) => allocByField[f.id])} onClick={clearBulk}>Unassign</button>
            <button className="cancel" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
          {bulkContract && progressByContract[bulkContract] && (() => {
            const c = contractsById[bulkContract]; const p = progressByContract[bulkContract]
            const already = selectedFields.filter((f) => allocByField[f.id] === bulkContract).reduce((s, f) => s + f.acres, 0)
            const after = (p.allocatedAcres || 0) + selectedAcres - already
            const pa = contractProgress(c, after)
            return <div className="contracts-sub" style={{ color: '#fff', marginTop: 6 }}>After assigning: {pa.pct != null ? Math.round(pa.pct) + '% of ' + c.name : fmtNum(after, 1) + ' ac'}{pa.status === 'over' ? ' — over-allocated' : ''}</div>
          })()}
        </div>
      )}
      {msg && <div className="agronomy-error-banner">{msg}</div>}

      <div className="table-scroll">
        <table className="contracts-table contracts-table-auto">
          <thead>
            <tr>
              {canEdit && <th><input type="checkbox" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
              <th>Field</th><th className="hide-sm">Farm</th><th>Crop</th><th className="hide-sm">Variety</th><th className="num">Acres</th><th>Contract</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={canEdit ? 7 : 6} className="contracts-empty">No fields match.</td></tr>}
            {rows.map((f) => {
              const cid = allocByField[f.id]
              const c = cid ? contractsById[cid] : null
              const eligible = contracts.filter((x) => fieldMatchesContract(f, x))
              const mismatch = c && !fieldMatchesContract(f, c)
              return (
                <tr key={f.id} className={selected.has(f.id) ? 'contracts-row-selected' : ''}>
                  {canEdit && <td><input type="checkbox" checked={selected.has(f.id)} onChange={() => setSelected((prev) => { const n = new Set(prev); n.has(f.id) ? n.delete(f.id) : n.add(f.id); return n })} /></td>}
                  <td><strong>{f.name}</strong></td>
                  <td className="hide-sm">{f.farmName || '—'}</td>
                  <td><CropBadge crop={f.crop} /></td>
                  <td className="hide-sm">{f.variety || '—'}</td>
                  <td className="num">{fmtNum(f.acres, 1)}</td>
                  <td>
                    {canEdit ? (
                      <select className="contracts-row-select" value={cid || ''} disabled={busy}
                        onChange={(e) => run([f.id], e.target.value || null)}
                        style={{ borderColor: c ? '#3c5a3f' : undefined }}>
                        <option value="">— Open —</option>
                        {c && !eligible.includes(c) && <option value={c.id}>{c.name} (doesn’t match)</option>}
                        {eligible.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                      </select>
                    ) : (c ? c.name : <span className="contracts-sub">Open</span>)}
                    {mismatch && <div className="contracts-sub" style={{ color: '#A32D2D' }}>⚠ Field’s crop/variety no longer matches this contract</div>}
                    {c && <div className="contracts-sub">≈ {fmtNum(acresToUnits(c, f.acres), 0)} {UNITS[c.unit].label}</div>}
                  </td>
                </tr>
              )
            })}
          </tbody>
          {rows.length > 0 && (
            <tfoot>
              <tr>
                {canEdit && <td />}
                <td colSpan={2}><strong>{rows.length} field{rows.length === 1 ? '' : 's'}</strong></td>
                <td className="hide-sm" /><td className="hide-sm" />
                <td className="num"><strong>{fmtNum(totalAcres, 1)}</strong></td><td />
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {canEdit && <p className="contracts-hint">Whole fields only — each field can sit on one contract per season. The dropdown only lists contracts whose crop (and variety, if set) match the field.</p>}
    </>
  )
}

