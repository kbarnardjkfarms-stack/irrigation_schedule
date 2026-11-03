import { useMemo, useState } from 'react'
import { doc, setDoc, updateDoc } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import {
  allocateUnload, compressImage, fmtAge, fmtCwt, lotKey, netWeight, newId, toCwt, truckKey
} from './seedMath.js'
import { CuttingZone, LoadedTrucks } from './Seed.jsx'

// The four ticket portals, built for a phone in a truck cab:
//   1 Pickup ticket   — whole seed weighed at the grower
//   2 Unload at cutter — tip a pickup into the cutting zone
//   3 Cut seed ticket — a truck weighed out of the cutter (can split lots)
//   4 Unload at field — all or part of a cut-seed truck into an Agworld field
// Saves don't wait for the server: with no signal the ticket is kept on the
// phone and syncs when it's back, so the driver can keep going.

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)

function save(ref, data, setMsg, okText) {
  setDoc(ref, data).catch((e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Not allowed to save that — ask a manager to check your access.' : e.message }))
  setMsg({ ok: true, text: okText + (navigator.onLine === false ? ' (saved on this phone — it will send when you have signal)' : '') })
}

export default function SeedPortals({ ctx }) {
  const [portal, setPortal] = useState(null)
  const [msg, setMsg] = useState(null)
  const P = [
    ['pickup', '1', 'Pickup ticket', 'Whole seed from a grower'],
    ['cutter', '2', 'Unload at cutter', `${ctx.seed.transit.length} in transit`],
    ['cut', '3', 'Cut seed ticket', 'Weigh a truck out of the cutter'],
    ['field', '4', 'Unload at field', `${ctx.seed.loadedTrucks.length} loaded truck${ctx.seed.loadedTrucks.length === 1 ? '' : 's'}`]
  ]
  const done = (m) => { setMsg(m); if (m && m.ok) setPortal(null); window.scrollTo && window.scrollTo(0, 0) }
  return (
    <div className="seed-portals">
      {msg && <div className={msg.ok ? 'yields-ok' : 'agronomy-error-banner'} style={{ marginTop: 0, marginBottom: 10 }} onClick={() => setMsg(null)}>{msg.text}</div>}
      <div className="seed-portal-grid">
        {P.map(([k, n, l, s]) => (
          <button key={k} className={`seed-portal-btn${portal === k ? ' active' : ''}`} onClick={() => { setPortal(portal === k ? null : k); setMsg(null) }}>
            <span className="seed-portal-n">{n}</span><strong>{l}</strong><small>{s}</small>
          </button>
        ))}
      </div>
      {portal === 'pickup' && <PickupForm ctx={ctx} onDone={done} />}
      {portal === 'cutter' && <CutterUnload ctx={ctx} onMsg={setMsg} />}
      {portal === 'cut' && <CutForm ctx={ctx} onDone={done} />}
      {portal === 'field' && <FieldUnload ctx={ctx} onDone={done} />}
      {!portal && <><CuttingZone ctx={ctx} compact /><LoadedTrucks ctx={ctx} /></>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Truck + weight + photo (shared by the two weigh tickets)
// ---------------------------------------------------------------------------
function useWeigh(ctx) {
  const [truckNo, setTruckNo] = useState('')
  const [scale, setScale] = useState('')
  const [mode, setMode] = useState('gross')
  const [newLight, setNewLight] = useState('')
  const [ticketNo, setTicketNo] = useState('')
  const [photo, setPhoto] = useState(null)
  const [photoBusy, setPhotoBusy] = useState(false)
  const known = ctx.trucks[truckKey(truckNo)]
  const light = known ? known.lightLbs : (Number(newLight) || null)
  const net = netWeight(scale, light, mode)
  const cwt = toCwt(net)
  return { truckNo, setTruckNo, scale, setScale, mode, setMode, newLight, setNewLight, ticketNo, setTicketNo, photo, setPhoto, photoBusy, setPhotoBusy, known, light, net, cwt }
}

function WeighFields({ ctx, w }) {
  async function onPhoto(e) {
    const f = e.target.files && e.target.files[0]
    if (!f) return
    w.setPhotoBusy(true)
    try { w.setPhoto(await compressImage(f)) } catch (err) { alert(err.message) } finally { w.setPhotoBusy(false) }
  }
  const needLight = w.mode === 'gross' && w.truckNo.trim() && !w.known
  return (
    <>
      <div className="seed-form-row">
        <label className="seed-field"><span>Truck #</span>
          <input list="seed-trucks" value={w.truckNo} onChange={(e) => w.setTruckNo(e.target.value)} placeholder="e.g. 14" autoComplete="off" />
        </label>
        <label className="seed-field"><span>Ticket # (optional)</span>
          <input value={w.ticketNo} onChange={(e) => w.setTicketNo(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <datalist id="seed-trucks">{Object.values(ctx.trucks).map((t) => <option key={t.id} value={t.truckNo} />)}</datalist>
      <div className="seed-mode">
        <span>Ticket weight is</span>
        <button type="button" className={w.mode === 'gross' ? 'active' : ''} onClick={() => w.setMode('gross')}>Loaded truck (gross)</button>
        <button type="button" className={w.mode === 'net' ? 'active' : ''} onClick={() => w.setMode('net')}>Already net</button>
      </div>
      <div className="seed-form-row">
        <label className="seed-field"><span>{w.mode === 'gross' ? 'Scale weight (lbs)' : 'Net weight (lbs)'}</span>
          <input value={w.scale} onChange={(e) => w.setScale(e.target.value.replace(/[^\d.]/g, ''))} inputMode="numeric" placeholder="lbs" />
        </label>
        {needLight ? (
          <label className="seed-field seed-new-light"><span>Light weight of truck {w.truckNo} (lbs) — first time only</span>
            <input value={w.newLight} onChange={(e) => w.setNewLight(e.target.value.replace(/[^\d.]/g, ''))} inputMode="numeric" placeholder="empty truck lbs" />
          </label>
        ) : w.mode === 'gross' && w.known ? (
          <div className="seed-field"><span>Light weight (on file)</span><div className="seed-readout">{fmtCwt(w.known.lightLbs)} lbs</div></div>
        ) : null}
      </div>
      <div className={`seed-net${w.cwt ? '' : ' empty'}`}>
        {w.cwt ? <>Net <strong>{fmtCwt(w.net)} lbs</strong> = <strong>{fmtCwt(w.cwt, 2)} cwt</strong></> : 'Net weight shows here'}
      </div>
      <label className="seed-photo">
        <input type="file" accept="image/*" capture="environment" onChange={onPhoto} />
        {w.photo ? <img src={w.photo} alt="Ticket" /> : <span>{w.photoBusy ? 'Reading photo…' : '📷 Take a picture of the ticket'}</span>}
      </label>
    </>
  )
}

function stampWeigh(ctx, w, extra) {
  const id = newId()
  const base = {
    seasonId: ctx.seasonId, truckNo: w.truckNo.trim(), truckKey: truckKey(w.truckNo), ticketNo: w.ticketNo.trim() || null,
    weightMode: w.mode, scaleLbs: Number(w.scale), lightLbs: w.mode === 'gross' ? w.light : null, netLbs: w.net, cwt: w.cwt,
    hasPhoto: !!w.photo, at: Date.now(), by: who(), ...extra
  }
  // first time we've seen this truck: keep its light weight for next time
  if (w.mode === 'gross' && !w.known && w.light) {
    setDoc(doc(db, 'seedTrucks', truckKey(w.truckNo)), { truckNo: w.truckNo.trim(), lightLbs: w.light, updatedBy: who(), updatedAt: Date.now() }).catch(() => {})
  }
  if (w.photo) setDoc(doc(db, 'seedPhotos', id), { seasonId: ctx.seasonId, data: w.photo, at: Date.now(), by: who() }).catch(() => {})
  return { id, base }
}

function weighProblem(w) {
  if (!w.truckNo.trim()) return 'Enter the truck number.'
  if (!(Number(w.scale) > 0)) return 'Enter the weight off the ticket.'
  if (w.mode === 'gross' && !w.light) return `Enter the light (empty) weight for truck ${w.truckNo} — you only do this once.`
  if (!w.net) return 'The scale weight is less than the truck’s light weight — check the numbers or switch to “Already net”.'
  if (w.cwt > 1500) return `That’s ${fmtCwt(w.cwt)} cwt on one truck — check the weight.`
  return null
}

// ---------------------------------------------------------------------------
// 1 Pickup
// ---------------------------------------------------------------------------
function PickupForm({ ctx, onDone }) {
  const w = useWeigh(ctx)
  const [supplier, setSupplier] = useState('')
  const [variety, setVariety] = useState('')
  const [lot, setLot] = useState('')
  const [tipped, setTipped] = useState(false)
  const [note, setNote] = useState('')
  const [err, setErr] = useState(null)
  const suppliers = [...new Set(ctx.contracts.map((c) => c.supplier))].sort()
  const varieties = [...new Set(ctx.contracts.filter((c) => c.supplier === supplier).map((c) => c.variety))].sort()
  const matches = ctx.contracts.filter((c) => c.supplier === supplier && c.variety === variety)
  const knownLots = [...new Set([...matches.flatMap((c) => c.lots || []), ...ctx.tickets.filter((t) => t.type === 'pickup' && t.supplier === supplier && t.variety === variety).map((t) => t.lot)].filter(Boolean))]
  const contract = matches.find((c) => (c.lots || []).includes(lot)) || matches[0] || null

  function submit() {
    const p = weighProblem(w) || (!supplier ? 'Pick the supplier.' : !variety ? 'Pick the variety.' : !lot.trim() ? 'Enter the lot number.' : null)
    if (p) { setErr(p); return }
    const { id, base } = stampWeigh(ctx, w, {
      type: 'pickup', supplier, variety, lot: lot.trim(), lotKey: lotKey(supplier, variety, lot), contractId: contract ? contract.id : null,
      status: tipped ? 'unloaded' : 'transit', unloadedAt: tipped ? Date.now() : null, unloadedBy: tipped ? who() : null, note: note.trim() || null
    })
    save(doc(db, 'seedTickets', id), base, onDone, `Pickup saved: truck ${base.truckNo}, ${fmtCwt(base.cwt, 1)} cwt ${variety} lot ${lot}.`)
  }
  return (
    <div className="yields-card seed-form">
      <div className="yields-card-title">1 · Pickup ticket</div>
      <div className="seed-form-row">
        <label className="seed-field"><span>Supplier</span>
          <select value={supplier} onChange={(e) => { setSupplier(e.target.value); setVariety(''); setLot('') }}>
            <option value="">Pick…</option>{suppliers.map((s) => <option key={s}>{s}</option>)}
          </select>
        </label>
        <label className="seed-field"><span>Variety</span>
          <select value={variety} onChange={(e) => { setVariety(e.target.value); setLot('') }} disabled={!supplier}>
            <option value="">Pick…</option>{varieties.map((v) => <option key={v}>{v}</option>)}
          </select>
        </label>
        <label className="seed-field"><span>Lot #</span>
          <input list="seed-lots" value={lot} onChange={(e) => setLot(e.target.value)} disabled={!variety} autoComplete="off" />
          <datalist id="seed-lots">{knownLots.map((l) => <option key={l} value={l} />)}</datalist>
        </label>
      </div>
      {!suppliers.length && <div className="agronomy-error-banner">No seed contracts yet — a manager adds them on the Contracts tab.</div>}
      <WeighFields ctx={ctx} w={w} />
      <label className="seed-check"><input type="checkbox" checked={tipped} onChange={(e) => setTipped(e.target.checked)} /> Already tipped at the cutter</label>
      <label className="seed-field"><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {err && <div className="agronomy-error-banner">{err}</div>}
      <button className="save seed-submit" onClick={submit}>Save pickup ticket</button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2 Unload at cutter
// ---------------------------------------------------------------------------
function CutterUnload({ ctx, onMsg }) {
  const cap = ctx.settings.zoneCapacity || 2500
  function tip(t) {
    const after = ctx.seed.zoneCwt + (t.cwt || 0)
    if (after > cap && !window.confirm(`That puts ${fmtCwt(after)} cwt at the cutter — over the ${fmtCwt(cap)} cwt limit. Tip it anyway?`)) return
    updateDoc(doc(db, 'seedTickets', t.id), { status: 'unloaded', unloadedAt: Date.now(), unloadedBy: who() })
      .catch((e) => onMsg({ ok: false, text: e.message }))
    onMsg({ ok: true, text: `Truck ${t.truckNo} tipped at the cutter: ${fmtCwt(t.cwt, 1)} cwt ${t.variety} lot ${t.lot}.` })
  }
  return (
    <>
      <CuttingZone ctx={ctx} compact />
      <div className="yields-card seed-form">
        <div className="yields-card-title">2 · Unload at cutter</div>
        <div className="contracts-sub">Trucks with a pickup ticket that haven’t been tipped yet. Tap Unloaded when it’s in the cutting zone.</div>
        <div className="seed-list">
          {ctx.seed.transit.map((t) => (
            <div key={t.id} className="seed-list-row">
              <div><strong>Truck {t.truckNo}</strong> · {fmtCwt(t.cwt, 1)} cwt<div className="contracts-sub" style={{ marginTop: 0 }}>{t.variety} · {t.supplier} · lot {t.lot} · picked up {fmtAge((ctx.now - t.at) / 3600000)} ago</div></div>
              <button className="save" onClick={() => tip(t)}>Unloaded</button>
            </div>
          ))}
          {!ctx.seed.transit.length && <div className="contracts-sub" style={{ padding: 10 }}>No trucks in transit.</div>}
        </div>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 3 Cut seed ticket
// ---------------------------------------------------------------------------
function CutForm({ ctx, onDone }) {
  const w = useWeigh(ctx)
  const zoneLots = ctx.seed.lots.filter((L) => L.zone > 0.05)
  const [parts, setParts] = useState([{ key: zoneLots.length === 1 ? zoneLots[0].key : '', cwt: '' }])
  const [note, setNote] = useState('')
  const [err, setErr] = useState(null)
  const split = parts.length > 1
  const lotBy = ctx.seed.lotsByKey
  const partSum = parts.reduce((s, p) => s + (Number(p.cwt) || 0), 0)
  const stillOn = w.truckNo.trim() ? ctx.seed.loadedTrucks.find((t) => truckKey(t.truckNo) === truckKey(w.truckNo)) : null

  function submit() {
    const p = weighProblem(w) || (parts.some((x) => !x.key) ? 'Pick the lot for every part of the load.' : null)
      || (split && Math.abs(partSum - w.cwt) > 0.5 ? `The split adds to ${fmtCwt(partSum, 1)} cwt but the truck has ${fmtCwt(w.cwt, 1)} cwt.` : null)
    if (p) { setErr(p); return }
    const outParts = (split ? parts : [{ ...parts[0], cwt: w.cwt }]).map((x) => {
      const L = lotBy[x.key]
      return { supplier: L.supplier, variety: L.variety, lot: L.lot, cwt: Math.round(Number(x.cwt) * 100) / 100 }
    })
    const over = outParts.filter((x) => x.cwt > (lotBy[lotKey(x.supplier, x.variety, x.lot)].zone + 0.5))
    if (over.length && !window.confirm(`${over.map((x) => `Lot ${x.lot}`).join(', ')} only shows ${over.map((x) => fmtCwt(lotBy[lotKey(x.supplier, x.variety, x.lot)].zone)).join(', ')} cwt at the cutter. Save anyway?`)) return
    const { id, base } = stampWeigh(ctx, w, { type: 'cut', parts: outParts, varieties: [...new Set(outParts.map((x) => x.variety))], note: note.trim() || null })
    save(doc(db, 'seedTickets', id), base, onDone, `Cut seed saved: truck ${base.truckNo}, ${fmtCwt(base.cwt, 1)} cwt ${outParts.map((x) => `${x.variety} lot ${x.lot}`).join(' + ')}.`)
  }
  const setPart = (i, patch) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)))
  return (
    <>
      <CuttingZone ctx={ctx} compact />
      <div className="yields-card seed-form">
        <div className="yields-card-title">3 · Cut seed ticket</div>
        <WeighFields ctx={ctx} w={w} />
        {stillOn && <div className="agronomy-error-banner">Truck {stillOn.truckNo} still shows {fmtCwt(stillOn.remaining, 1)} cwt of cut seed from {fmtAge(stillOn.ageHours)} ago. Unload it at a field first (or ask a manager to write it off) so the inventory stays right.</div>}
        <div className="agronomy-section-label">Lot{split ? 's on this truck' : ''}</div>
        {parts.map((p, i) => (
          <div key={i} className="seed-form-row">
            <label className="seed-field" style={{ flex: 3 }}><span>{split ? `Part ${i + 1}` : 'Lot at the cutter'}</span>
              <select value={p.key} onChange={(e) => setPart(i, { key: e.target.value })}>
                <option value="">Pick…</option>
                {zoneLots.map((L) => <option key={L.key} value={L.key}>{L.variety} · {L.supplier} · lot {L.lot} ({fmtCwt(L.zone)} cwt in zone)</option>)}
              </select>
            </label>
            {split && (
              <label className="seed-field" style={{ flex: 1 }}><span>cwt</span>
                <input value={p.cwt} inputMode="decimal" onChange={(e) => setPart(i, { cwt: e.target.value.replace(/[^\d.]/g, '') })}
                  placeholder={i === parts.length - 1 && w.cwt ? fmtCwt(Math.max(0, w.cwt - (partSum - (Number(p.cwt) || 0))), 1) : ''} />
              </label>
            )}
            {split && <button type="button" className="clear-sort-btn" style={{ alignSelf: 'flex-end', marginBottom: 6 }} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}>×</button>}
          </div>
        ))}
        {!zoneLots.length && <div className="agronomy-error-banner">Nothing at the cutter — tip a pickup first (portal 2).</div>}
        <div className="agronomy-filter-bar">
          <button type="button" onClick={() => setParts((ps) => [...ps, { key: '', cwt: '' }])}>+ Split load across another lot</button>
          {split && <span className="contracts-sub" style={{ marginTop: 0 }}>Parts add to {fmtCwt(partSum, 1)} of {fmtCwt(w.cwt || 0, 1)} cwt{w.cwt && Math.abs(partSum - w.cwt) > 0.5 ? ' ⚠' : ' ✓'}</span>}
          {split && w.cwt && (
            <button type="button" className="clear-sort-btn" onClick={() => setParts((ps) => ps.map((p, j) => (j === ps.length - 1 ? { ...p, cwt: String(Math.max(0, Math.round((w.cwt - ps.slice(0, -1).reduce((s, x) => s + (Number(x.cwt) || 0), 0)) * 100) / 100)) } : p)))}>Fill last part</button>
          )}
        </div>
        <label className="seed-field"><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        {err && <div className="agronomy-error-banner">{err}</div>}
        <button className="save seed-submit" onClick={submit}>Save cut seed ticket</button>
      </div>
    </>
  )
}

// ---------------------------------------------------------------------------
// 4 Unload at field
// ---------------------------------------------------------------------------
function FieldUnload({ ctx, onDone }) {
  const [q, setQ] = useState('')
  const [allCrops, setAllCrops] = useState(false)
  const [field, setField] = useState(null)
  const [truck, setTruck] = useState(null)
  const [mode, setMode] = useState('all')
  const [part, setPart] = useState('')
  const [partUnit, setPartUnit] = useState('cwt')
  const [note, setNote] = useState('')
  const [err, setErr] = useState(null)
  const potatoes = ctx.fieldList.filter((f) => /POTATO/.test(f.crop))
  const pool = allCrops || !potatoes.length ? ctx.fieldList : potatoes
  const shown = useMemo(() => pool.filter((f) => !q || `${f.name} ${f.farmName || ''} ${f.variety || ''}`.toLowerCase().includes(q.toLowerCase())).slice(0, 40), [pool, q])
  const t = truck ? ctx.seed.loadedTrucks.find((x) => x.id === truck.id) || null : null
  const cwt = !t ? 0 : mode === 'all' ? t.remaining : partUnit === '%' ? Math.round(t.remaining * Math.min(100, Number(part) || 0)) / 100 : Math.min(t.remaining, Number(part) || 0)
  const parts = t ? allocateUnload(t, cwt) : []
  const varietyMismatch = field && t && field.variety && !t.varieties.some((v) => String(field.variety).toUpperCase().includes(String(v).toUpperCase()) || String(v).toUpperCase().includes(String(field.variety).toUpperCase()))

  function submit() {
    const p = !field ? 'Pick the field.' : !t ? 'Pick a loaded truck.' : !(cwt > 0) ? 'Enter how much was unloaded.' : null
    if (p) { setErr(p); return }
    const id = newId()
    const data = {
      seasonId: ctx.seasonId, type: 'plant', cutTicketId: t.id, truckNo: t.truckNo, truckKey: truckKey(t.truckNo),
      fieldId: field.id, fieldName: field.name, farmName: field.farmName, fieldAcres: field.acres || null,
      cwt: Math.round(cwt * 100) / 100, parts, partial: cwt < t.remaining - 0.05, varieties: [...new Set(parts.map((x) => x.variety))],
      at: Date.now(), by: who(), note: note.trim() || null
    }
    save(doc(db, 'seedTickets', id), data, onDone,
      `Unloaded ${fmtCwt(data.cwt, 1)} cwt from truck ${t.truckNo} at ${field.name}.${data.partial ? ` ${fmtCwt(t.remaining - data.cwt, 1)} cwt stays on the truck.` : ''}`)
  }
  return (
    <div className="yields-card seed-form">
      <div className="yields-card-title">4 · Unload at field</div>
      <div className="agronomy-section-label">Field (from Agworld)</div>
      {field ? (
        <div className="seed-picked"><div><strong>{field.name}</strong><div className="contracts-sub" style={{ marginTop: 0 }}>{[field.farmName, field.crop && field.crop.toLowerCase(), field.variety, field.acres ? `${fmtCwt(field.acres)} ac` : null].filter(Boolean).join(' · ')}</div></div><button onClick={() => setField(null)}>Change</button></div>
      ) : (
        <>
          <div className="seed-form-row">
            <input className="agronomy-search-input" style={{ flex: 1 }} placeholder="Search field or farm…" value={q} onChange={(e) => setQ(e.target.value)} />
            <label className="seed-check" style={{ margin: 0 }}><input type="checkbox" checked={allCrops} onChange={(e) => setAllCrops(e.target.checked)} /> All crops</label>
          </div>
          <div className="seed-list seed-field-list">
            {shown.map((f) => (
              <button key={f.id} type="button" className="seed-list-row" onClick={() => setField(f)}>
                <div style={{ textAlign: 'left' }}><strong>{f.name}</strong><div className="contracts-sub" style={{ marginTop: 0 }}>{[f.farmName, f.crop && f.crop.toLowerCase(), f.variety, f.acres ? `${fmtCwt(f.acres)} ac` : null].filter(Boolean).join(' · ')}</div></div>
              </button>
            ))}
            {!shown.length && <div className="contracts-sub" style={{ padding: 10 }}>No fields match.{!allCrops ? ' Try “All crops”.' : ''}</div>}
          </div>
        </>
      )}
      <LoadedTrucks ctx={ctx} onPick={(x) => { setTruck(x); setMode('all'); setPart('') }} pickedId={t && t.id} />
      {t && (
        <>
          <div className="seed-mode">
            <span>Unloaded</span>
            <button type="button" className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')}>Whole load ({fmtCwt(t.remaining, 1)} cwt)</button>
            <button type="button" className={mode === 'part' ? 'active' : ''} onClick={() => setMode('part')}>Part of it</button>
          </div>
          {mode === 'part' && (
            <div className="seed-form-row">
              <label className="seed-field"><span>How much went in</span><input value={part} inputMode="decimal" onChange={(e) => setPart(e.target.value.replace(/[^\d.]/g, ''))} /></label>
              <div className="seed-mode" style={{ alignSelf: 'flex-end' }}>
                {['cwt', '%'].map((u) => <button key={u} type="button" className={partUnit === u ? 'active' : ''} onClick={() => setPartUnit(u)}>{u}</button>)}
              </div>
            </div>
          )}
          <div className="seed-net">
            {fmtCwt(cwt, 1)} cwt into the field{mode === 'part' && cwt > 0 ? ` · ${fmtCwt(t.remaining - cwt, 1)} cwt stays on truck ${t.truckNo}` : ''}
            {parts.length > 1 && <div className="contracts-sub" style={{ marginTop: 2 }}>{parts.map((x) => `${x.variety} lot ${x.lot}: ${fmtCwt(x.cwt, 1)}`).join(' · ')}</div>}
          </div>
        </>
      )}
      {varietyMismatch && <div className="agronomy-error-banner">Agworld has {field.name} as {field.variety}, but truck {t.truckNo} is carrying {t.varieties.join(' / ')}. Double-check before unloading.</div>}
      <label className="seed-field"><span>Note</span><input value={note} onChange={(e) => setNote(e.target.value)} /></label>
      {err && <div className="agronomy-error-banner">{err}</div>}
      <button className="save seed-submit" onClick={submit}>Save field unload</button>
    </div>
  )
}
