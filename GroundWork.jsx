import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, deleteDoc, doc, onSnapshot, query, setDoc, updateDoc, where, writeBatch } from 'firebase/firestore'
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { auth, db } from './firebase.js'
import { canonCrop } from './yieldMath.js'
import {
  autoAssign, buildGround, burnUp, defaultSettings, fmtAc, fmtDate, fmtDiff, fmtSlot, isoToday, orderBetween, sweepNumbers
} from './groundMath.js'
import { GroundJobs, GroundSetup } from './GroundSetup.jsx'

// Ground work module — spring field work by machine: Dominators, Karats, the
// Wilcox, Roller Harrows. Crop recipes turn each Agworld field's crop into
// passes (jobs); each pass belongs to a category of equipment and is put in
// one machine's line, in order. The schedule runs in half days and keeps each
// field's passes in recipe order; the dashboard shows how far ahead or behind
// each machine, each category and the whole schedule is against its target
// acres per day, and drills down machine by machine.
//
// Data (see firestore.rules; season-scoped):
//   groundSettings/{seasonId}  start date, days off, gap between passes,
//                              categories [{ id, name, color, rate (ac/day),
//                              startDate, units: [{ id, name, rate? }] }],
//                              recipes { CROP: [categoryId…] }
//   groundJobs/{id}            kind 'job': seasonId, fieldId, fieldName, crop,
//                              acres, catId, step, unitId, order, startOn,
//                              doneAcres, done, doneAt — or kind 'block'
//                              (rain / move / down) with unitId, order, slots
// Other modules can read groundJobs (see groundStatusByField in groundMath.js)
// to know which fields are worked and ready to plant.

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
const mapKey = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
function ringCentroid(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return null
  let a = 0, x = 0, y = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]; a += f; x += (ring[j][0] + ring[i][0]) * f; y += (ring[j][1] + ring[i][1]) * f }
  return a ? { lng: x / (3 * a), lat: y / (3 * a) } : { lng: ring[0][0], lat: ring[0][1] }
}
const paceClass = (d) => (d == null ? 'idle' : Math.abs(d) < 0.25 ? 'even' : d > 0 ? 'ahead' : 'behind')

export default function GroundWork({ userRole }) {
  const canEdit = userRole === 'admin' || userRole === 'owner' || userRole === 'farm_manager'
  const [view, setView] = useState('dashboard')
  const [seasons, setSeasons] = useState([])
  const [seasonId, setSeasonId] = useState(null)
  const [baseFields, setBaseFields] = useState({})
  const [seasonData, setSeasonData] = useState({})
  const [bounds, setBounds] = useState({})
  const [farmFields, setFarmFields] = useState([])
  const [settingsDoc, setSettingsDoc] = useState(undefined)
  const [jobs, setJobs] = useState([])
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 60000); return () => clearInterval(t) }, [])

  useEffect(() => onSnapshot(collection(db, 'seasons'), (snap) => {
    const list = []; snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
    list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
    setSeasons(list)
    setSeasonId((prev) => {
      if (prev) return prev
      const y = new Date().getFullYear() + (new Date().getMonth() >= 8 ? 1 : 0) // ground work is spring: look ahead after harvest
      const pick = list.find((s) => String(s.name).includes(String(y))) || list[0]
      return pick ? pick.id : null
    })
  }, () => {}), [])
  useEffect(() => onSnapshot(collection(db, 'fields'), (snap) => { const o = {}; snap.forEach((d) => { o[d.id] = d.data() }); setBaseFields(o) }, () => {}), [])
  useEffect(() => onSnapshot(collection(db, 'fieldBoundaries'), (snap) => { const o = {}; snap.forEach((d) => { o[d.id] = d.data().boundary }); setBounds(o) }, () => setBounds({})), [])
  useEffect(() => onSnapshot(collection(db, 'farmFields'), (snap) => { const o = []; snap.forEach((d) => o.push({ id: d.id, ...d.data() })); setFarmFields(o) }, () => setFarmFields([])), [])
  useEffect(() => {
    if (!seasonId) return undefined
    const sid = String(seasonId)
    const onErr = (e) => setError(e.code === 'permission-denied' ? 'No permission to read ground work. If the module was just added, the new firestore.rules may not be deployed yet.' : e.message)
    const unsubs = [
      onSnapshot(query(collectionGroup(db, 'seasons'), where('seasonId', '==', seasonId)), (snap) => { const o = {}; snap.forEach((d) => { o[d.ref.parent.parent.id] = d.data() }); setSeasonData(o) }, () => {}),
      onSnapshot(doc(db, 'groundSettings', sid), (d) => { setSettingsDoc(d.exists() ? d.data() : null); setError(null) }, onErr),
      onSnapshot(query(collection(db, 'groundJobs'), where('seasonId', '==', sid)), (snap) => { const o = []; snap.forEach((d) => o.push({ id: d.id, ...d.data() })); setJobs(o) }, onErr)
    ]
    return () => unsubs.forEach((u) => u())
  }, [seasonId])

  const season = seasons.find((s) => String(s.id) === String(seasonId))
  const settings = useMemo(() => {
    const yr = season && (String(season.name).match(/\b(19|20)\d{2}\b/) || [])[0]
    const base = defaultSettings(yr ? `${yr}-03-15` : null)
    return { ...base, ...(settingsDoc || {}) }
  }, [settingsDoc, season])

  // The season's Agworld fields with a position (outline middle) and a number
  // along the southwest → northeast sweep.
  const fields = useMemo(() => {
    const byKey = {}
    farmFields.forEach((f) => { const r = (f.rings || []).find((x) => !x.hole); if (r && r.c) { const ring = []; for (let i = 0; i < r.c.length; i += 2) ring.push([r.c[i], r.c[i + 1]]); byKey[mapKey(f.name)] = ringCentroid(ring) } })
    return Object.entries(seasonData).map(([id, sd]) => {
      const b = baseFields[id] || {}
      let ring = null
      try { ring = bounds[id] ? JSON.parse(bounds[id]) : null } catch { ring = null }
      return { id, name: b.name || id, farmName: b.farmName || null, crop: canonCrop(sd.cropName) || null, variety: sd.varietyName || null, acres: Number(sd.acres) || 0, pos: (ring && ringCentroid(ring)) || byKey[mapKey(b.name)] || null, hidden: !!b.hiddenFromIrrigation }
    }).filter((f) => f.name && !f.hidden)
  }, [seasonData, baseFields, bounds, farmFields])
  const sweepNo = useMemo(() => sweepNumbers(fields, Number(settings.sweepAngle) || 45), [fields, settings.sweepAngle])
  const liveAcres = useMemo(() => Object.fromEntries(fields.map((f) => [f.id, f.acres])), [fields])
  const g = useMemo(() => (settings.startDate ? buildGround({ jobs, settings, liveAcres, now }) : null), [jobs, settings, liveAcres, now])

  // ---- writes -----------------------------------------------------------------
  const run = (p, ok) => {
    setMsg(null)
    Promise.resolve(p).then(() => ok && setMsg({ ok: true, text: ok })).catch((e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin, Owner or Farm manager can change ground work.' : e.message }))
  }
  const saveSettings = (patch, ok) => run(setDoc(doc(db, 'groundSettings', String(seasonId)), { ...patch, seasonId: String(seasonId), updatedBy: who(), updatedAt: Date.now() }, { merge: true }), ok)
  async function batchWrite(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(db)
      ops.slice(i, i + 400).forEach(([kind, id, data]) => (kind === 'del' ? b.delete(doc(db, 'groundJobs', id)) : kind === 'set' ? b.set(doc(db, 'groundJobs', id), data) : b.update(doc(db, 'groundJobs', id), data)))
      await b.commit()
    }
  }
  const api = {
    run, saveSettings, batchWrite,
    patchJob: (id, patch, ok) => run(updateDoc(doc(db, 'groundJobs', id), { ...patch, updatedBy: who(), updatedAt: Date.now() }), ok),
    addJob: (data, ok) => run(setDoc(doc(db, 'groundJobs', data.id), { ...data, seasonId: String(seasonId), createdBy: who(), updatedAt: Date.now() }), ok),
    deleteJob: (id, ok) => run(deleteDoc(doc(db, 'groundJobs', id)), ok),
    autoAssignCat: (cat, onlyUnassigned) => {
      const a = autoAssign({ jobs, category: cat, sweepNo, onlyUnassigned })
      if (!a.length) { setMsg({ ok: false, text: `Nothing ${onlyUnassigned ? 'unassigned ' : ''}to assign in ${cat.name}.` }); return }
      run(batchWrite(a.map((x) => ['upd', x.id, { unitId: x.unitId, order: x.order, startOn: null, updatedBy: who(), updatedAt: Date.now() }])), `${a.length} ${cat.name} job${a.length === 1 ? '' : 's'} split across ${cat.units.length} machine${cat.units.length === 1 ? '' : 's'} by field order.`)
    }
  }

  const tabs = [['dashboard', 'Dashboard'], ['schedule', 'Schedule'], ['jobs', 'Fields & passes'], ...(canEdit ? [['setup', 'Setup']] : [])]
  return (
    <div className="agronomy ground">
      <div className="agronomy-filter-bar">
        {seasons.length > 0 && <select value={seasonId || ''} onChange={(e) => setSeasonId(e.target.value)}>{seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>}
        <span className="contracts-sub" style={{ marginTop: 0 }}>Ground work · {settings.startDate ? `starts ${fmtDate(settings.startDate, true)}` : 'no start date yet'} · {jobs.filter((j) => j.kind !== 'block').length} passes on {new Set(jobs.filter((j) => j.kind !== 'block').map((j) => j.fieldId)).size} fields</span>
      </div>
      {error && <div className="agronomy-error-banner">{error}</div>}
      <div className="agronomy-view-toggle harvest-tabs">
        {tabs.map(([k, l]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>)}
      </div>
      {msg && <div className={msg.ok ? 'yields-ok harvest-msg' : 'agronomy-error-banner harvest-msg'} onClick={() => setMsg(null)}>{msg.text}</div>}
      {!jobs.some((j) => j.kind !== 'block') && view !== 'setup' && view !== 'jobs' && settingsDoc !== undefined && (
        <div className="yields-card"><div className="yields-card-title">No passes yet</div>
          <div className="contracts-sub">{canEdit ? 'Check the machines and crop recipes on Setup, then use “Build passes from recipes” on Fields & passes.' : 'An Admin, Owner or Farm manager sets up the machines and crop recipes first.'}</div></div>
      )}
      {g && view === 'dashboard' && <GroundDashboard g={g} jobs={jobs} settings={settings} sweepNo={sweepNo} now={now} onOpenSchedule={() => setView('schedule')} />}
      {g && view === 'schedule' && <GroundSchedule g={g} jobs={jobs} settings={settings} sweepNo={sweepNo} canEdit={canEdit} api={api} />}
      {view === 'jobs' && <GroundJobs fields={fields} jobs={jobs} settings={settings} sweepNo={sweepNo} g={g} canEdit={canEdit} api={api} seasonId={String(seasonId)} />}
      {view === 'setup' && canEdit && <GroundSetup settings={settings} fields={fields} saveSettings={saveSettings} />}
      {!g && view !== 'setup' && view !== 'jobs' && settingsDoc !== undefined && <div className="yields-card"><div className="contracts-sub">Set a start date on Setup to build the schedule.</div></div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Dashboard: whole schedule → category → machine, each level a click deeper.
// ---------------------------------------------------------------------------
function GroundDashboard({ g, jobs, settings, sweepNo, now, onOpenSchedule }) {
  const [path, setPath] = useState({ cat: null, unit: null })
  const cat = path.cat ? g.catStats.find((c) => c.id === path.cat) : null
  const unit = path.unit ? g.unitStats.find((u) => u.id === path.unit) : null
  const level = unit ? 'unit' : cat ? 'cat' : 'all'
  const S = level === 'unit' ? unit : level === 'cat' ? cat : g.all
  const unitIds = level === 'unit' ? [unit.id] : level === 'cat' ? cat.units.map((u) => u.id) : g.units.map((u) => u.id)
  const series = useMemo(() => burnUp({ g, jobs, unitIds, settings, now }), [g, jobs, unitIds.join(','), settings, now])
  const title = level === 'unit' ? unit.name : level === 'cat' ? cat.name : 'All ground work'
  const color = level === 'unit' ? unit.color : level === 'cat' ? cat.color : '#3c5a3f'
  const rows = level === 'all' ? g.catStats.filter((c) => c.total > 0 || c.unassigned > 0).map((c) => ({ ...c, key: c.id, sub: `${c.units.length} machine${c.units.length === 1 ? '' : 's'} · ${fmtAc(c.rate)} ac/day`, onClick: () => setPath({ cat: c.id, unit: null }) }))
    : level === 'cat' ? cat.units.map((u) => ({ ...u, key: u.id, pct: u.total ? u.done / u.total : 0, sub: `${fmtAc(u.rate)} ac/day · ${u.jobs} field${u.jobs === 1 ? '' : 's'}`, onClick: () => setPath({ cat: cat.id, unit: u.id }) }))
      : null
  return (
    <div className="gw-dash">
      <div className="gw-crumbs">
        <button className={level === 'all' ? 'on' : ''} onClick={() => setPath({ cat: null, unit: null })}>All ground work</button>
        {cat && <><span>›</span><button className={level === 'cat' ? 'on' : ''} onClick={() => setPath({ cat: cat.id, unit: null })}>{cat.name}</button></>}
        {unit && <><span>›</span><button className="on">{unit.name}</button></>}
      </div>
      <div className="harvest-banners gw-banners">
        <div className="harvest-banner harvest-banner-total" style={{ '--team': color }}>
          <div className="hb-head"><span className="hb-name">{title}</span><span className={`hb-pace ${paceClass(S.total ? S.diffDays : null)}`}>{S.total ? fmtDiff(S.diffDays) : 'nothing planned'}</span></div>
          <div className="hb-pct">{Math.round((S.total ? S.done / S.total : 0) * 100)}<small>%</small></div>
          <div className="hb-bar"><div style={{ width: `${Math.min(100, (S.total ? S.done / S.total : 0) * 100)}%`, background: color }} /></div>
          <div className="hb-line">{fmtAc(S.done)} of {fmtAc(S.total)} ac done · target by now {fmtAc(S.target)} ac ({S.diffAcres >= 0 ? '+' : '−'}{fmtAc(Math.abs(S.diffAcres))})</div>
          <div className="hb-line">{S.end != null ? `Projected finish ${fmtSlot(settings.startDate, S.end, true)}` : 'Nothing left to schedule'}{level === 'cat' && cat.startDate ? ` · pace from ${fmtDate(cat.startDate)}` : ''}</div>
        </div>
        {level === 'cat' && cat.unassigned > 0 && <div className="harvest-banner gw-warn"><div className="hb-name">Not assigned</div><div className="hb-pct">{cat.unassigned}</div><div className="hb-line">{fmtAc(cat.unassignedAcres)} ac in no machine’s line</div></div>}
        {level === 'unit' && unit.waits > 0 && <div className="harvest-banner gw-warn"><div className="hb-name">Waiting on passes</div><div className="hb-pct">{unit.waits}</div><div className="hb-line">fields where the pass before isn’t done in time</div></div>}
      </div>

      {rows && (
        <div className="yields-card">
          <div className="yields-card-title">{level === 'all' ? 'By equipment — click one for its machines' : `${cat.name} machines — click one for its fields`}</div>
          <div className="gw-bars">
            {rows.map((r) => {
              const pctDone = r.total ? (r.done / r.total) * 100 : 0
              const pctTarget = r.total ? Math.min(100, (r.target / r.total) * 100) : 0
              return (
                <button key={r.key} className="gw-bar-row" onClick={r.onClick} style={{ '--c': r.color }}>
                  <div className="gw-bar-label"><b><i />{r.name}</b><small>{r.sub}</small></div>
                  <div className="gw-bar-track">
                    <div className="gw-bar-done" style={{ width: `${pctDone}%` }} />
                    {r.target > 0 && <div className="gw-bar-target" style={{ left: `${pctTarget}%` }} title={`Target by now: ${fmtAc(r.target)} ac`} />}
                    <span>{fmtAc(r.done)} / {fmtAc(r.total)} ac</span>
                  </div>
                  <div className="gw-bar-end">
                    <span className={`hb-pace ${paceClass(r.total ? r.diffDays : null)}`}>{r.total ? fmtDiff(r.diffDays) : '—'}</span>
                    <small>{r.end != null ? `done ${fmtSlot(settings.startDate, r.end)}` : r.total ? 'finished' : ''}</small>
                  </div>
                </button>
              )
            })}
            {!rows.length && <div className="contracts-sub">Nothing here yet.</div>}
          </div>
          <div className="contracts-sub">Bar = acres done; the tick is where the target pace says it should be by now.</div>
        </div>
      )}

      <div className="yields-card">
        <div className="yields-card-title">Acres over time — {title}</div>
        <div className="contracts-sub">Target pace (acres/day from {level === 'cat' && cat.startDate ? fmtDate(cat.startDate) : 'the start date'}), acres marked done, and where the schedule says it’ll go from here.</div>
        <div style={{ height: 280, marginTop: 8 }}>
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={series} margin={{ top: 8, right: 16, bottom: 4, left: 4 }}>
              <CartesianGrid stroke="#eee9de" vertical={false} />
              <XAxis dataKey="date" tickFormatter={(d) => fmtDate(d)} minTickGap={28} tick={{ fontSize: 11, fill: '#777' }} />
              <YAxis tickFormatter={(v) => (v >= 1000 ? `${Math.round(v / 100) / 10}k` : v)} tick={{ fontSize: 11, fill: '#777' }} width={44} />
              <Tooltip labelFormatter={(d) => fmtDate(d, true)} formatter={(v, n) => [`${fmtAc(v)} ac`, n]} />
              <Line dataKey="target" name="Target pace" stroke="#9A9890" strokeDasharray="5 4" dot={false} strokeWidth={2} isAnimationActive={false} />
              <Area dataKey="done" name="Done" stroke={color} fill={color} fillOpacity={0.18} strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls />
              <Line dataKey="projected" name="Scheduled" stroke={color} strokeDasharray="2 3" dot={false} strokeWidth={2} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {level === 'unit' && <UnitTimeline g={g} unit={unit} settings={settings} sweepNo={sweepNo} onOpenSchedule={onOpenSchedule} />}
    </div>
  )
}

function UnitTimeline({ g, unit, settings, sweepNo, onOpenSchedule }) {
  const lane = g.lanes[unit.id] || []
  const items = lane.map((j) => ({ j, r: g.res[j.id] })).filter((x) => x.r)
  const live = items.filter((x) => !x.r.done && x.r.start != null)
  const t0 = Math.floor(Math.min(g.nowSlot, ...live.map((x) => x.r.start)) / 2) * 2
  const t1 = Math.max(t0 + 4, ...live.map((x) => x.r.end))
  const span = t1 - t0
  const pct = (t) => `${((t - t0) / span) * 100}%`
  const nowPct = ((g.nowSlot - t0) / span) * 100
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div><div className="yields-card-title">{unit.name} — fields in order</div><div className="contracts-sub">{fmtAc(unit.left)} ac left at {fmtAc(unit.rate)} ac/day. Drag to change the order on the Schedule tab.</div></div>
        <button onClick={onOpenSchedule}>Open schedule</button>
      </div>
      <div className="gw-gantt">
        {items.map(({ j, r }) => (
          <div key={j.id} className={`gw-g-row${r.done ? ' done' : ''}`}>
            <div className="gw-g-name">{r.block ? <i>{j.label || 'Block'}</i> : <><b>#{sweepNo[j.fieldId] || '–'}</b> {j.fieldName}</>}</div>
            <div className="gw-g-track">
              {!r.done && r.start != null && (
                <>
                  {r.waited != null && <div className="gw-g-wait" style={{ left: pct(r.waited), width: `calc(${pct(r.start)} - ${pct(r.waited)})` }} title="Waiting for the pass before" />}
                  <div className={`gw-g-bar${r.block ? ' block' : ''}${r.dep ? ' warn' : ''}`} style={{ left: pct(r.start), width: `max(3px, calc(${pct(r.end)} - ${pct(r.start)}))`, background: r.block ? undefined : unit.color }} title={`${fmtSlot(settings.startDate, r.start, true)} → ${fmtSlot(settings.startDate, r.end, true)}`} />
                </>
              )}
              {r.done && <span className="gw-g-done">✓ done{j.doneAt ? ` ${fmtDate(new Date(j.doneAt).toISOString().slice(0, 10))}` : ''}</span>}
              {nowPct >= 0 && nowPct <= 100 && <div className="gw-g-now" style={{ left: `${nowPct}%` }} />}
            </div>
            <div className="gw-g-when">{r.block ? `${(Number(j.slots) || 2) / 2} day` : r.done ? `${fmtAc(r.acres)} ac` : `${fmtAc(r.left)} ac · ${fmtSlot(settings.startDate, r.start)} → ${fmtSlot(settings.startDate, r.end)}`}</div>
          </div>
        ))}
        {!items.length && <div className="contracts-sub">No fields in this machine’s line.</div>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schedule: one line per machine, drag fields within and between machines of
// the same kind; rain / move / down blocks; start-date pins; mark done.
// ---------------------------------------------------------------------------
const BLOCKS = [['Rain day', 2], ['Rain ½ day', 1], ['Move ½ day', 1], ['Down day', 2]]
function GroundSchedule({ g, jobs, settings, sweepNo, canEdit, api }) {
  const cats = settings.categories || []
  const [catId, setCatId] = useState(() => (cats[0] ? cats[0].id : null))
  const [drag, setDrag] = useState(null)
  const [open, setOpen] = useState(null) // job id with its edit panel open
  const cat = cats.find((c) => c.id === catId) || cats[0]
  const cs = g.catStats.find((c) => c.id === (cat && cat.id))
  if (!cat) return <div className="yields-card"><div className="contracts-sub">Add equipment on Setup.</div></div>
  const unassigned = jobs.filter((j) => j.kind !== 'block' && j.catId === cat.id && !j.unitId && !j.done).sort((a, b) => (sweepNo[a.fieldId] || 1e9) - (sweepNo[b.fieldId] || 1e9))
  const lanes = cat.units.map((u) => ({ u, items: g.lanes[u.id] || [], st: g.unitStats.find((x) => x.id === u.id) }))
  const dropOn = (unitId, beforeId) => {
    if (!drag || !canEdit) return
    const j = jobs.find((x) => x.id === drag)
    setDrag(null)
    if (!j) return
    if (j.kind !== 'block' && j.catId !== cat.id) return
    if (!unitId) { api.patchJob(j.id, { unitId: null, order: null, startOn: null }, `${j.fieldName} taken out of the line.`); return }
    const lane = (g.lanes[unitId] || []).filter((x) => x.id !== j.id)
    const idx = beforeId ? lane.findIndex((x) => x.id === beforeId) : lane.length
    const before = idx > 0 ? lane[idx - 1].order : null, after = idx >= 0 && idx < lane.length ? lane[idx].order : null
    api.patchJob(j.id, { unitId, order: orderBetween(before, after), startOn: null })
  }
  const resort = (u) => {
    const lane = (g.lanes[u.id] || []).filter((x) => x.kind !== 'block')
    api.run(api.batchWrite(lane.map((j) => ['upd', j.id, { order: sweepNo[j.fieldId] || 1e6, startOn: null }])), `${u.name} put back in field order (#1 southwest → northeast).`)
  }
  const addBlock = (u, label, slots) => {
    const lane = g.lanes[u.id] || []
    const firstLive = lane.findIndex((x) => { const r = g.res[x.id]; return r && !r.done && r.start != null && r.end > g.nowSlot })
    const before = firstLive > 0 ? lane[firstLive - 1].order : null, after = firstLive >= 0 ? lane[firstLive].order : null
    api.addJob({ id: `blk_${Date.now().toString(36)}`, kind: 'block', unitId: u.id, label, slots, order: firstLive >= 0 ? orderBetween(before, after) : orderBetween(lane.length ? lane[lane.length - 1].order : null, null) }, `${label} added to ${u.name}.`)
  }
  const cardProps = { g, settings, sweepNo, cat, canEdit, api, drag, setDrag, open, setOpen, dropOn }
  return (
    <>
      <div className="agronomy-filter-bar gw-cat-pick">
        {cats.map((c) => { const st = g.catStats.find((x) => x.id === c.id); return (
          <button key={c.id} className={c.id === cat.id ? 'active' : ''} onClick={() => setCatId(c.id)} style={{ '--c': c.color }}><i />{c.name}{st && st.total ? <span className={`hb-pace ${paceClass(st.diffDays)}`}>{fmtDiff(st.diffDays)}</span> : null}</button>
        ) })}
      </div>
      {canEdit && (
        <div className="agronomy-filter-bar">
          <button className="save" disabled={!unassigned.length} onClick={() => api.autoAssignCat(cat, true)}>Assign the {unassigned.length} unassigned by field order</button>
          <button onClick={() => { if (window.confirm(`Re-split every ${cat.name} job that isn’t done across the ${cat.units.length} machines by field order? Hand-made order and pins in ${cat.name} are replaced.`)) api.autoAssignCat(cat, false) }}>Re-split all {cat.name} jobs</button>
          <span className="contracts-sub" style={{ marginTop: 0 }}>Drag a field to move it; drop on a field to go before it. Tap a field to mark it done or pin a start date.</span>
        </div>
      )}
      <div className="gw-lanes">
        {unassigned.length > 0 && (
          <div className="gw-lane pool" onDragOver={(e) => { if (drag) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); dropOn(null) }}>
            <div className="gw-lane-head"><b>Not assigned</b><span>{unassigned.length} fields · {fmtAc(unassigned.reduce((s, j) => s + g.acresOf(j), 0))} ac</span></div>
            {unassigned.map((j) => <JobCard key={j.id} j={j} {...cardProps} />)}
          </div>
        )}
        {lanes.map(({ u, items, st }) => (
          <div key={u.id} className="gw-lane" style={{ '--team': cat.color }} onDragOver={(e) => { if (drag) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); dropOn(u.id) }}>
            <div className="gw-lane-head">
              <b>{u.name}</b>
              <span className={`hb-pace ${paceClass(st && st.total ? st.diffDays : null)}`}>{st && st.total ? fmtDiff(st.diffDays) : 'empty'}</span>
            </div>
            <div className="hb-line">{fmtAc(st ? st.done : 0)} / {fmtAc(st ? st.total : 0)} ac · {fmtAc(Number(u.rate) || cat.rate)} ac/day{st && st.end != null ? ` · done ${fmtSlot(settings.startDate, st.end)}` : ''}</div>
            <div className="hb-lane-bar"><div style={{ width: `${st && st.total ? (st.done / st.total) * 100 : 0}%` }} /></div>
            {canEdit && (
              <div className="gw-lane-tools">
                {BLOCKS.map(([l, s]) => <button key={l} onClick={() => addBlock(u, l, s)}>+ {l}</button>)}
                <button onClick={() => resort(u)} title="Order this machine's fields by field number">Field order</button>
              </div>
            )}
            {items.map((j) => <JobCard key={j.id} j={j} {...cardProps} />)}
            {!items.length && <div className="contracts-sub" style={{ padding: 10 }}>Drop fields here.</div>}
          </div>
        ))}
      </div>
      {cs && cs.startDate && <div className="contracts-sub">{cat.name} pace counts from {fmtDate(cs.startDate)} (set on Setup).</div>}
    </>
  )
}

function JobCard({ j, g, settings, sweepNo, cat, canEdit, api, drag, setDrag, open, setOpen, dropOn }) {
  const r = g.res[j.id] || {}
  const block = j.kind === 'block'
  const isOpen = open === j.id
  const left = r.left ?? Math.max(0, g.acresOf(j) - (Number(j.doneAcres) || 0))
  return (
    <div className={`gw-card${block ? ' block' : ''}${r.done ? ' done' : ''}${r.dep ? ' warn' : ''}${drag === j.id ? ' dragging' : ''}`} draggable={canEdit} onDragStart={(e) => { e.dataTransfer.setData('text/plain', j.id); setDrag(j.id) }} onDragEnd={() => setDrag(null)}
      onDragOver={(e) => { if (drag && drag !== j.id) e.preventDefault() }} onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropOn(j.unitId, j.id) }}>
      {block ? (
        <div className="gw-card-top"><b>{j.label || 'Block'}</b><span>{r.start != null ? fmtSlot(settings.startDate, r.start) : ''}</span>{canEdit && <button className="csp-x" onClick={() => api.deleteJob(j.id, 'Removed.')}>×</button>}</div>
      ) : (
        <>
          <div className="gw-card-top" onClick={() => setOpen(isOpen ? null : j.id)}>
            <b><span className="gw-no">#{sweepNo[j.fieldId] || '–'}</span>{j.fieldName}</b>
            <span>{r.done ? '✓ done' : `${fmtAc(left)} ac`}</span>
          </div>
          {!r.done && r.start != null && <div className="gw-card-when">{fmtSlot(settings.startDate, r.start, true)} → {fmtSlot(settings.startDate, r.end)}{j.startOn ? ' · 📌' : ''}</div>}
          {(j.doneAcres > 0 && !r.done) && <div className="hb-mini-bar"><div style={{ width: `${Math.min(100, (j.doneAcres / g.acresOf(j)) * 100)}%`, background: cat.color }} /></div>}
          {r.waited != null && <div className="gw-flag">Waits for the pass before (from {fmtSlot(settings.startDate, r.waited)})</div>}
          {r.dep === 'unassigned' && <div className="gw-flag">The pass before isn’t in any machine’s line</div>}
          {r.dep === 'after' && <div className="gw-flag">The pass before is scheduled later</div>}
          {r.pinLate && <div className="gw-flag">Pinned date has passed</div>}
          {isOpen && canEdit && <CardEdit j={j} r={r} cat={cat} api={api} settings={settings} close={() => setOpen(null)} acres={g.acresOf(j)} />}
        </>
      )}
    </div>
  )
}

function CardEdit({ j, r, cat, api, settings, close, acres }) {
  const [part, setPart] = useState(String(j.doneAcres || ''))
  const [pin, setPin] = useState(j.startOn ? j.startOn.date : '')
  const [half, setHalf] = useState(j.startOn ? j.startOn.half : 'AM')
  const [move, setMove] = useState(j.unitId || '')
  const today = isoToday()
  return (
    <div className="gw-edit" onClick={(e) => e.stopPropagation()}>
      <div className="contracts-sub" style={{ marginTop: 0 }}>{j.farmName ? `${j.farmName} · ` : ''}{j.crop ? `${j.crop.toLowerCase()} · ` : ''}{fmtAc(acres)} ac · pass {(j.step ?? 0) + 1}</div>
      <div className="gw-edit-row">
        {!j.done
          ? <button className="save" onClick={() => { api.patchJob(j.id, { done: true, doneAcres: acres, doneAt: Date.now() }, `${j.fieldName} — ${cat.name} done.`); close() }}>Done</button>
          : <button onClick={() => { api.patchJob(j.id, { done: false, doneAcres: 0, doneAt: null }, 'Marked not done.'); close() }}>Not done</button>}
        {!j.done && <>
          <input className="yields-cell-input" inputMode="decimal" placeholder="ac" value={part} onChange={(e) => setPart(e.target.value)} />
          <button disabled={!(Number(part) >= 0)} onClick={() => { const v = Math.min(acres, Number(part) || 0); api.patchJob(j.id, { doneAcres: v, done: v >= acres - 0.05, doneAt: Date.now() }, `${j.fieldName}: ${fmtAc(v)} of ${fmtAc(acres)} ac done.`); close() }}>Acres done</button>
        </>}
      </div>
      {!j.done && (
        <div className="gw-edit-row">
          <span>Start no sooner than</span>
          <input type="date" value={pin} min={settings.startDate || undefined} onChange={(e) => setPin(e.target.value)} />
          <select value={half} onChange={(e) => setHalf(e.target.value)}><option>AM</option><option>PM</option></select>
          <button disabled={!pin} onClick={() => { api.patchJob(j.id, { startOn: { date: pin, half } }, `${j.fieldName} pinned to ${fmtDate(pin)} ${half}.`); close() }}>Pin</button>
          {j.startOn && <button onClick={() => { api.patchJob(j.id, { startOn: null }, 'Pin removed.'); close() }}>Unpin</button>}
          {pin && pin < today && <span className="gw-flag">in the past</span>}
        </div>
      )}
      <div className="gw-edit-row">
        <span>Machine</span>
        <select value={move} onChange={(e) => setMove(e.target.value)}>
          <option value="">Not assigned</option>
          {cat.units.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <button disabled={move === (j.unitId || '')} onClick={() => { api.patchJob(j.id, { unitId: move || null, order: move ? Date.now() / 1e6 : null, startOn: null }, move ? 'Moved to the end of that line.' : 'Taken out of the line.'); close() }}>Move</button>
      </div>
    </div>
  )
}
