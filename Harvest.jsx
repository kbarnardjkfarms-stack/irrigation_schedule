import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, deleteDoc, doc, onSnapshot, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { canonCrop, effectiveYield, fieldKey } from './yieldMath.js'
import {
  buildSchedule, defaultSettings, fmtDate, fmtDays, fmtN, isoToday, orderBetween, resourcesAt, slotOf
} from './harvestMath.js'
import HarvestBoard from './HarvestBoard.jsx'
import HarvestTimeline from './HarvestTimeline.jsx'
import HarvestToday from './HarvestToday.jsx'
import { FieldDrawer, FieldsTable, HarvestSettings } from './HarvestSetup.jsx'

// Operations Schedule module (was "Harvest schedule") — the AIO version of
// harvest_plan_2026.xlsm. Code, collection names (harvestPlans/harvestFields/
// harvestLogs) and the 'harvest' module id are unchanged so nothing saved moves.
//
// Pulls every Agworld field for the season, lets you filter by crop and drag
// fields into ~8 team lines; the line order becomes a half-day by half-day
// schedule driven by each field's yield, production goal and day length.
// Teams log each half-day (full / partial / down, optionally how much they
// dug) and the banners show how far ahead or behind each team is.
//
// Data (see firestore.rules — Admin, Owner and Farm manager):
//   harvestPlans/{seasonId}                       settings: start date, day length,
//                                                 teams, crop goals, limits, calendar
//   harvestFields/{seasonId}__{key}               one doc per field on the plan (team,
//                                                 order, overrides, logistics, resources).
//                                                 key = Agworld field id, "x_<NAME>" for a
//                                                 field that isn't in Agworld, "blk_…" for a
//                                                 move day / down time block
//   harvestLogs/{seasonId}__{team}__{date}__{AM|PM} one doc per team per half-day

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
export const hfId = (seasonId, key) => `${seasonId}__${key}`
export const hlId = (seasonId, teamId, date, half) => `${seasonId}__${teamId}__${date}__${half}`

export default function Harvest({ userRole }) {
  const canEdit = userRole === 'admin' || userRole === 'owner' || userRole === 'farm_manager'
  const [view, setView] = useState('board')
  const [seasons, setSeasons] = useState([])
  const [seasonId, setSeasonId] = useState(null)
  const [baseFields, setBaseFields] = useState({})
  const [seasonData, setSeasonData] = useState({})
  const [planDoc, setPlanDoc] = useState(undefined)
  const [planDocs, setPlanDocs] = useState({})
  const [logs, setLogs] = useState([])
  const [history, setHistory] = useState({})
  const [buyers, setBuyers] = useState({})
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const [openKey, setOpenKey] = useState(null)
  const [now, setNow] = useState(() => new Date())

  // keep "now" fresh so the banners roll over at noon / midnight
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t) }, [])

  useEffect(() => onSnapshot(collection(db, 'fields'), (snap) => {
    const next = {}
    snap.forEach((d) => { next[d.id] = d.data() })
    setBaseFields(next)
  }), [])

  useEffect(() => onSnapshot(collection(db, 'seasons'), (snap) => {
    const list = []
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
    list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
    setSeasons(list)
    setSeasonId((prev) => {
      if (prev) return prev
      const cur = list.find((s) => String(s.name) === String(new Date().getFullYear()))
      return cur ? cur.id : (list[0] ? list[0].id : null)
    })
  }), [])

  useEffect(() => {
    if (!seasonId) return undefined
    const sid = String(seasonId)
    const onErr = (e) => setError(e.code === 'permission-denied'
      ? 'No permission to read the operations schedule. If this is the first time the module has been opened, the new firestore.rules may not be deployed yet.'
      : e.message)
    const unsubs = [
      onSnapshot(query(collectionGroup(db, 'seasons'), where('seasonId', '==', seasonId)), (snap) => {
        const next = {}
        snap.forEach((d) => { next[d.ref.parent.parent.id] = d.data() })
        setSeasonData(next)
      }),
      onSnapshot(doc(db, 'harvestPlans', sid), (d) => { setPlanDoc(d.exists() ? d.data() : null); setError(null) }, onErr),
      onSnapshot(query(collection(db, 'harvestFields'), where('seasonId', '==', sid)), (snap) => {
        const next = {}
        snap.forEach((d) => { next[d.data().key] = d.data() })
        setPlanDocs(next)
      }, onErr),
      onSnapshot(query(collection(db, 'harvestLogs'), where('seasonId', '==', sid)), (snap) => {
        const list = []
        snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
        setLogs(list)
      }, onErr)
    ]
    // Optional extras — quietly skipped if this login can't read them.
    const quiet = () => {}
    unsubs.push(onSnapshot(query(collection(db, 'contractAllocations'), where('seasonId', '==', sid)), (snap) => {
      const m = {}
      snap.forEach((d) => { const a = d.data(); if (a.fieldId) m[a.fieldId] = a.contractId })
      setBuyers((b) => ({ ...b, alloc: m }))
    }, quiet))
    unsubs.push(onSnapshot(query(collection(db, 'contracts'), where('seasonId', '==', sid)), (snap) => {
      const m = {}
      snap.forEach((d) => { const c = d.data(); m[d.id] = c.processor || c.name || null })
      setBuyers((b) => ({ ...b, contracts: m }))
    }, quiet))
    return () => unsubs.forEach((u) => u())
  }, [seasonId])

  // Each field's own average yield for its crop (last 5 recorded years), used
  // as the yield projection until one is typed in.
  useEffect(() => onSnapshot(collection(db, 'yieldHistory'), (snap) => {
    const acc = {}
    snap.forEach((d) => {
      const r = d.data()
      if (r.deleted || !r.fieldKey || !r.crop) return
      const y = Number(effectiveYield(r).value)
      if (!(y > 0)) return
      const k = `${r.fieldKey}|${r.crop}`
      ;(acc[k] = acc[k] || []).push({ year: r.year, y })
    })
    const out = {}
    Object.entries(acc).forEach(([k, list]) => {
      const last = list.sort((a, b) => b.year - a.year).slice(0, 5)
      out[k] = last.reduce((s, x) => s + x.y, 0) / last.length
    })
    setHistory(out)
  }, () => {}), [])

  const season = seasons.find((s) => String(s.id) === String(seasonId))
  const settings = useMemo(() => {
    const yr = season && /^\d{4}$/.test(String(season.name)) ? String(season.name) : String(new Date().getFullYear())
    const base = defaultSettings(`${yr}-08-15`)
    if (!planDoc) return base
    return { ...base, ...planDoc, teams: planDoc.teams && planDoc.teams.length ? planDoc.teams : base.teams, limits: { ...base.limits, ...(planDoc.limits || {}) }, trucking: { ...base.trucking, ...(planDoc.trucking || {}) }, calendar: planDoc.calendar || {}, crops: planDoc.crops || {} }
  }, [planDoc, season])

  // Agworld fields for the season merged with what's saved on the plan.
  const allFields = useMemo(() => {
    const out = []
    const seen = new Set()
    Object.entries(seasonData).forEach(([id, sd]) => {
      const base = baseFields[id]
      if (!base) return
      const crop = canonCrop(sd.cropName) || 'UNKNOWN'
      const saved = planDocs[id] || {}
      const fk = fieldKey(base.name)
      const contractId = buyers.alloc && buyers.alloc[id]
      out.push({
        key: id, fieldId: id, source: 'agworld', name: base.name, farmName: base.farmName || null, farmId: base.farmId || null,
        crop, variety: sd.varietyName || null, acres: Number(sd.acres) || 0,
        histYield: history[`${fk}|${crop}`] ?? null,
        contract: contractId && buyers.contracts ? buyers.contracts[contractId] : null,
        ...saved, crop: saved.crop || crop, acres: saved.acresOverride != null ? Number(saved.acresOverride) : Number(sd.acres) || 0
      })
      seen.add(id)
    })
    Object.values(planDocs).forEach((d) => {
      if (seen.has(d.key)) return
      if (d.fieldId && !seasonData[d.fieldId]) {
        // Agworld field no longer in this season — keep it visible so nothing silently drops off the plan
        out.push({ ...d, source: 'missing', acres: Number(d.acresOverride ?? d.acres) || 0 })
        return
      }
      out.push({ ...d, source: d.kind === 'block' ? 'block' : 'custom', acres: Number(d.acresOverride ?? d.acres) || 0, histYield: d.kind === 'block' ? null : history[`${fieldKey(d.name)}|${d.crop}`] ?? null })
    })
    return out
  }, [seasonData, baseFields, planDocs, history, buyers])

  const schedule = useMemo(() => buildSchedule({ fields: allFields.filter((f) => f.teamId), settings, logs, now }), [allFields, settings, logs, now])

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------
  async function run(fn, okText) {
    setMsg(null)
    try { await fn(); if (okText) setMsg({ ok: true, text: okText }) } catch (e) {
      setMsg({ ok: false, text: e.code === 'permission-denied' ? 'You don’t have permission to change the operations schedule.' : (e.message || String(e)) })
    }
  }
  const sid = String(seasonId)
  // The identifying bits we always store, so the doc stands on its own.
  function ident(f) {
    const o = { seasonId: sid, key: f.key, name: f.name, crop: f.crop || null, updatedBy: who(), updatedAt: Date.now() }
    if (f.fieldId) o.fieldId = f.fieldId
    if (f.kind) o.kind = f.kind
    return o
  }
  const byKey = useMemo(() => Object.fromEntries(allFields.map((f) => [f.key, f])), [allFields])

  // Move one or more fields to a team (or back to the pool with teamId
  // null), placed before `beforeKey` (null = end of the line). Only the moved
  // docs are rewritten: they get orders spaced between their new neighbours.
  function moveField(keys, teamId, beforeKey = null, extra = null) {
    keys = (Array.isArray(keys) ? keys : [keys]).filter((k) => byKey[k])
    if (!keys.length || !canEdit) return
    const lane = allFields.filter((x) => x.teamId === teamId && !keys.includes(x.key)).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const i = beforeKey ? lane.findIndex((x) => x.key === beforeKey) : -1
    const lo = i < 0 ? (lane.length ? lane[lane.length - 1].order ?? 0 : null) : (i > 0 ? lane[i - 1].order ?? 0 : null)
    const hi = i < 0 ? null : lane[i].order ?? 0
    // end of line: keep counting up; between two cards: share the gap evenly
    const base = hi == null ? null : (lo == null ? hi - 1000 : lo)
    const orders = keys.map((_, j) => (hi == null ? (lo ?? 0) + 1000 * (j + 1) : base + ((hi - base) * (j + 1)) / (keys.length + 1)))
    run(async () => {
      const b = writeBatch(db)
      keys.forEach((k, j) => {
        const f = byKey[k]
        const ref = doc(db, 'harvestFields', hfId(sid, k))
        if (!teamId && f.source === 'agworld' && isBare(f)) b.delete(ref)
        else b.set(ref, { ...ident(f), teamId: teamId || null, order: teamId ? orders[j] : null, ...(teamId ? extra || {} : { startOn: null }) }, { merge: true })
      })
      await b.commit()
    })
  }
  // Several fields onto the end of a team's line, in the given order.
  function addMany(keys, teamId) {
    const lane = allFields.filter((x) => x.teamId === teamId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    let last = lane.length ? lane[lane.length - 1].order ?? 0 : 0
    return run(async () => {
      for (let i = 0; i < keys.length; i += 400) {
        const b = writeBatch(db)
        keys.slice(i, i + 400).forEach((k) => {
          const f = byKey[k]; if (!f) return
          last += 1000
          b.set(doc(db, 'harvestFields', hfId(sid, k)), { ...ident(f), teamId, order: last }, { merge: true })
        })
        await b.commit()
      }
    }, `Added ${keys.length} field${keys.length === 1 ? '' : 's'}.`)
  }
  function assignMany(pairs) {
    const lastBy = {}
    allFields.forEach((x) => { if (x.teamId) lastBy[x.teamId] = Math.max(lastBy[x.teamId] ?? 0, x.order ?? 0) })
    return run(async () => {
      const b = writeBatch(db)
      pairs.forEach(({ key, teamId }) => {
        const f = byKey[key]; if (!f) return
        lastBy[teamId] = (lastBy[teamId] ?? 0) + 1000
        b.set(doc(db, 'harvestFields', hfId(sid, key)), { ...ident(f), teamId, order: lastBy[teamId] }, { merge: true })
      })
      await b.commit()
    }, `Placed ${pairs.length} field${pairs.length === 1 ? '' : 's'}.`)
  }
  function saveField(key, patch) {
    const f = byKey[key]
    if (!f) return Promise.resolve()
    return run(() => setDoc(doc(db, 'harvestFields', hfId(sid, key)), { ...ident({ ...f, ...patch }), ...patch }, { merge: true }))
  }
  function removeField(key) {
    const f = byKey[key]
    if (!f) return
    run(() => (f.source === 'agworld' ? setDoc(doc(db, 'harvestFields', hfId(sid, key)), { ...ident(f), teamId: null, order: null }, { merge: true }) : deleteDoc(doc(db, 'harvestFields', hfId(sid, key)))))
  }
  // Move day / rain day / down time. Goes before `beforeKey` (null = end of line),
  // optionally held to a start date like a field.
  function addBlock(teamId, label, days, beforeKey = null, startOn = null) {
    const key = `blk_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
    const lane = allFields.filter((x) => x.teamId === teamId).sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    const i = beforeKey ? lane.findIndex((x) => x.key === beforeKey) : -1
    const order = i < 0 ? orderBetween(lane.length ? lane[lane.length - 1].order ?? 0 : null, null)
      : orderBetween(i > 0 ? lane[i - 1].order ?? 0 : null, lane[i].order ?? 0)
    return run(() => setDoc(doc(db, 'harvestFields', hfId(sid, key)), { seasonId: sid, key, kind: 'block', name: label || 'Move day', blockDays: days || 1, crop: null, teamId, order, startOn: startOn || null, updatedBy: who(), updatedAt: Date.now() }))
  }
  // The field in a team's line that starts at or after a half-day — i.e. where
  // something starting then belongs in the order.
  function keyStartingFrom(teamId, slot, exceptKey) {
    const t = schedule.teams[teamId]
    if (!t) return null
    const hit = t.rows.find((r) => r.key !== exceptKey && r.startSlot != null && r.startSlot >= slot - 1e-9)
    return hit ? hit.key : null
  }
  // Put a field on a team so it starts on a given half-day; the fields after
  // it follow in sequence.
  function placeAt(key, teamId, date, half) {
    const slot = slotOf(schedule.startDate, date, half)
    moveField([key], teamId, keyStartingFrom(teamId, slot, key), { startOn: { date, half } })
  }
  function clearStart(key) { return saveField(key, { startOn: null }) }
  function addCustom(name, crop, acres) {
    const key = `x_${fieldKey(name)}`
    if (!fieldKey(name)) return Promise.resolve()
    if (byKey[key]) { setMsg({ ok: false, text: `“${name}” is already on the list.` }); return Promise.resolve() }
    return run(() => setDoc(doc(db, 'harvestFields', hfId(sid, key)), { seasonId: sid, key, name, crop, acresOverride: Number(acres) || 0, teamId: null, order: null, updatedBy: who(), updatedAt: Date.now() }), `Added ${name}.`)
  }
  // updateDoc replaces each top-level field it's given (a merge would keep
  // calendar days / crop numbers that were just removed).
  function saveSettings(patch) {
    const ref = doc(db, 'harvestPlans', sid)
    const stamp = { seasonId: sid, updatedBy: who(), updatedAt: Date.now() }
    return run(() => (planDoc ? updateDoc(ref, { ...patch, ...stamp }) : setDoc(ref, { ...defaultSettings(settings.startDate), ...patch, ...stamp })))
  }
  function saveLog(entry) {
    const id = hlId(sid, entry.teamId, entry.date, entry.half)
    return run(() => setDoc(doc(db, 'harvestLogs', id), { ...entry, seasonId: sid, by: who(), at: Date.now() }), 'Logged.')
  }
  function saveLogs(entries) {
    return run(async () => {
      const b = writeBatch(db)
      entries.forEach((e) => b.set(doc(db, 'harvestLogs', hlId(sid, e.teamId, e.date, e.half)), { ...e, seasonId: sid, by: who(), at: Date.now() }))
      await b.commit()
    }, `Logged ${entries.length} half-day${entries.length === 1 ? '' : 's'}.`)
  }
  function deleteLog(id) { return run(() => deleteDoc(doc(db, 'harvestLogs', id))) }

  const writes = { moveField, placeAt, clearStart, keyStartingFrom, addMany, assignMany, saveField, removeField, addBlock, addCustom, saveSettings, saveLog, saveLogs, deleteLog, run, sid }

  const nowRes = useMemo(() => resourcesAt(schedule, schedule.nowSlot), [schedule])
  const scheduledCount = allFields.filter((f) => f.teamId && f.kind !== 'block').length
  const openField = openKey ? (schedule.byKey[openKey] || byKey[openKey]) : null

  return (
    <div className="agronomy harvest">
      <div className="agronomy-filter-bar">
        {seasons.length > 0 && (
          <select value={seasonId || ''} onChange={(e) => setSeasonId(e.target.value)}>
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <span className="contracts-sub" style={{ marginTop: 0 }}>
          Starts {fmtDate(settings.startDate, true)} · {settings.dayLength} h days · {scheduledCount} field{scheduledCount === 1 ? '' : 's'} scheduled
          {planDoc === null && canEdit && ' · using default settings (Settings tab to change)'}
        </span>
        {!canEdit && <span className="contracts-readonly">View only</span>}
      </div>

      {error && <div className="agronomy-error-banner">{error}</div>}

      <Banners schedule={schedule} settings={settings} nowRes={nowRes} onPickTeam={() => setView('board')} />

      <div className="agronomy-view-toggle harvest-tabs">
        {[['board', 'Schedule board'], ['timeline', 'Timeline'], ['today', 'Today & progress'], ['fields', 'Field details'], ['settings', 'Settings']].map(([k, l]) => (
          <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>
        ))}
      </div>

      {msg && <div className={msg.ok ? 'yields-ok harvest-msg' : 'agronomy-error-banner'} onClick={() => setMsg(null)}>{msg.text}</div>}

      {view === 'board' && <HarvestBoard allFields={allFields} schedule={schedule} settings={settings} canEdit={canEdit} writes={writes} onOpen={setOpenKey} />}
      {view === 'timeline' && <HarvestTimeline schedule={schedule} settings={settings} canEdit={canEdit} writes={writes} onOpen={setOpenKey} />}
      {view === 'today' && <HarvestToday schedule={schedule} settings={settings} canEdit={canEdit} writes={writes} logs={logs} planDoc={planDoc} onOpen={setOpenKey} />}
      {view === 'fields' && <FieldsTable allFields={allFields} schedule={schedule} settings={settings} canEdit={canEdit} writes={writes} onOpen={setOpenKey} seasonName={season && season.name} />}
      {view === 'settings' && <HarvestSettings settings={settings} canEdit={canEdit} writes={writes} allFields={allFields} />}

      {openField && <FieldDrawer field={openField} schedule={schedule} settings={settings} canEdit={canEdit} writes={writes} onClose={() => setOpenKey(null)} />}
    </div>
  )
}

// An Agworld field doc that only ever held a team/order can be dropped
// entirely when it goes back to the pool.
function isBare(f) {
  const keep = ['yieldPerAcre', 'goalPerDay', 'dayLength', 'oneWayMin', 'destination', 'skinSetDays', 'killType', 'killed', 'notes', 'resources', 'finished', 'buyer', 'storage', 'bay', 'acresOverride', 'loadSize', 'totalOverride']
  return !keep.some((k) => f[k] != null && f[k] !== '')
}

// ---------------------------------------------------------------------------
// Banners: one per team + the whole harvest
// ---------------------------------------------------------------------------
function paceChip(t) {
  if (!t.rows.length) return { cls: 'idle', text: 'No fields' }
  if (t.rows.every((r) => r.done)) return { cls: 'ahead', text: 'Done' }
  if (!t.started) return { cls: 'idle', text: 'Not started' }
  const d = t.aheadDays
  if (Math.abs(d) < 0.25) return { cls: 'even', text: 'On pace' }
  return d > 0 ? { cls: 'ahead', text: `${fmtDays(d)} ahead` } : { cls: 'behind', text: `${fmtDays(-d)} behind` }
}

function Banners({ schedule, settings, nowRes }) {
  const tot = schedule.totals
  const units = Object.entries(tot.byUnit).filter(([u]) => u !== 'days')
  const totalChip = tot.aheadDays >= 0.25 ? 'ahead' : tot.aheadDays <= -0.25 ? 'behind' : 'even'
  return (
    <div className="harvest-banners">
      <div className="harvest-banner harvest-banner-total">
        <div className="hb-head"><span className="hb-name">All teams</span><span className={`hb-pace ${totalChip}`} title="All teams added together">{Math.abs(tot.aheadDays) < 0.25 ? 'On pace' : `${fmtDays(Math.abs(tot.aheadDays)).replace('day', 'crew-day')} ${tot.aheadDays > 0 ? 'ahead' : 'behind'}`}</span></div>
        <div className="hb-pct">{Math.round(tot.pct * 100)}<small>%</small></div>
        <div className="hb-bar"><div style={{ width: `${Math.min(100, tot.pct * 100)}%` }} /></div>
        <div className="hb-line">{fmtN(tot.acresDone)} of {fmtN(tot.acres)} ac</div>
        {units.map(([u, v]) => <div key={u} className="hb-line">{fmtN(v.dug)} / {fmtN(v.total)} {u}</div>)}
        <div className="hb-line">Finish {tot.finishDate ? fmtDate(tot.finishDate) : '—'} · trucks now {nowRes.trucks.toFixed(0)}/{settings.limits.trucks}</div>
      </div>
      {(settings.teams || []).map((team) => {
        const t = schedule.teams[team.id]
        if (!t) return null
        const chip = paceChip(t)
        return (
          <div key={team.id} className="harvest-banner" style={{ '--team': team.color }}>
            <div className="hb-head"><span className="hb-name"><i style={{ background: team.color }} />{team.name}</span><span className={`hb-pace ${chip.cls}`}>{chip.text}</span></div>
            <div className="hb-pct">{Math.round(t.pct * 100)}<small>%</small></div>
            <div className="hb-bar"><div style={{ width: `${Math.min(100, t.pct * 100)}%`, background: team.color }} /></div>
            <div className="hb-line" title={t.current ? t.current.name : ''}>{t.current ? `On ${t.current.name}` : t.rows.length ? 'All fields done' : 'Drag fields onto this team'}</div>
            <div className="hb-line">{fmtN(t.acresDone)} / {fmtN(t.acres)} ac · {fmtDays(t.totalDays - t.doneDays)} left</div>
            <div className="hb-line">Finish {t.finishDate ? fmtDate(t.finishDate) : '—'}</div>
          </div>
        )
      })}
    </div>
  )
}

export { paceChip, isoToday }
