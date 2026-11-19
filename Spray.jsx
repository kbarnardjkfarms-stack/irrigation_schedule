import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import {
  mergeJobs, lanes, dayLabel, inRange, todayYmd, addDays, fmtDay, kindOf, KIND_LABEL, cropEmoji,
  weatherUrl, summarizeWeather, windLevel, mapKey, isMine, normName
} from './sprayMath.js'
import jkLogo from './jk-farms-logo.png'
import { FileText, Navigation, Phone, Check, Undo2 } from 'lucide-react'
import { pushState, turnOn, turnOff, refresh as refreshPush, sendTest } from './sprayPush.js'

// Spray schedule module (drone crew + Ag Rows) — jobs come from AgWorld through
// functions/spraySync.js. Every change goes through the sprayAct function, which
// checks the person's role; this screen only reads.
//
//   sprayJobs/{jobKey}       the job from AgWorld
//   sprayJobState/{jobKey}   assign / done / move / hidden
//   sprayOperators/{id}      the operators (Operators tab, Spray admins)

const sprayAct = httpsCallable(functions, 'sprayAct')
const syncNow = httpsCallable(functions, 'syncSprayJobsNow', { timeout: 1800000 })
const crewCall = httpsCallable(functions, 'sprayCrew', { timeout: 60000 })
const linkAdmin = httpsCallable(functions, 'sprayLinkAdmin', { timeout: 60000 })
const alertLogCall = httpsCallable(functions, 'sprayAlertLog', { timeout: 130000 })

const RANGES = [['today', 'Today'], ['week', '7 days'], ['all', 'All upcoming']]

export default function Spray({ userRole, sprayAdmin, userProfile }) {
  // Only Spray admins (Users screen checkbox) change anything; everyone else views.
  const isAdmin = !!sprayAdmin
  const [view, setView] = useState('schedule')
  const [jobsDoc, setJobsDoc] = useState(null)
  const [states, setStates] = useState({})
  const [ops, setOps] = useState([])
  const [farms, setFarms] = useState({})
  const [error, setError] = useState(null)
  const [toast, setToast] = useState(null)

  useEffect(() => onSnapshot(collection(db, 'sprayJobs'), (snap) => {
    const m = {}; snap.forEach((d) => { m[d.id] = d.data() }); setJobsDoc(m)
  }, (e) => setError(e.message)), [])
  useEffect(() => onSnapshot(collection(db, 'sprayJobState'), (snap) => {
    const m = {}; snap.forEach((d) => { m[d.id] = d.data() }); setStates(m)
  }, (e) => setError(e.message)), [])
  useEffect(() => onSnapshot(collection(db, 'sprayOperators'), (snap) => {
    const a = []; snap.forEach((d) => a.push(Object.assign({ id: d.id }, d.data()))); setOps(a.sort((x, y) => String(x.name).localeCompare(String(y.name))))
  }, () => {}), [])
  useEffect(() => onSnapshot(collection(db, 'farms'), (snap) => {
    const m = {}; snap.forEach((d) => { m[d.id] = d.data() }); setFarms(m)
  }, () => {}), [])

  const toastTimer = useRef(null)
  const say = (msg, undo) => {
    setToast({ msg, undo })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), undo ? 7000 : 2600)
  }
  const run = async (data) => {
    try { return (await sprayAct(data)).data }
    catch (e) { say(e.message || String(e)); throw e }
  }

  // Dark page while the Spray module is open (the rest of AIO stays as it is).
  useEffect(() => { document.body.classList.add('spray-dark'); return () => document.body.classList.remove('spray-dark') }, [])

  const jobs = useMemo(() => mergeJobs(jobsDoc || {}, states), [jobsDoc, states])
  // A farm manager sees their own jobs first: their name on the job, or their farms on their AIO login.
  const myName = (userProfile && userProfile.name) || ''
  const myFarmKeys = useMemo(() => new Set(((userProfile && userProfile.farmIds) || [])
    .map((id) => farms[String(id)] && farms[String(id)].name).filter(Boolean).map(mapKey)), [userProfile, farms])
  const mineFirst = userRole === 'farm_manager' || myFarmKeys.size > 0

  if (error) return <div className="spray"><div className="spray-error">Couldn't load the spray schedule: {error}</div></div>
  if (!jobsDoc) return <div className="spray"><div className="spray-empty">Loading the spray schedule…</div></div>

  return (
    <div className="spray">
      <div className="spray-brand">
        <div className="spray-logo"><img src={jkLogo} alt="JK Farms" /></div>
        <h1>Spray Schedule</h1>
        <Alerts say={say} />
      </div>
      <div className="spray-tabs">
        <button className={view === 'schedule' ? 'active' : ''} onClick={() => setView('schedule')}>Schedule</button>
        {isAdmin && <button className={view === 'crew' ? 'active' : ''} onClick={() => setView('crew')}>Operators</button>}
        {isAdmin && <button className={view === 'managers' ? 'active' : ''} onClick={() => setView('managers')}>Managers</button>}
        {isAdmin && <button className={view === 'alerts' ? 'active' : ''} onClick={() => setView('alerts')}>Alerts</button>}
      </div>
      {view === 'schedule' && <Schedule jobs={jobs} ops={ops} isAdmin={isAdmin} run={run} say={say}
        mine={mineFirst ? (j) => isMine(j, myName, myFarmKeys) : null} />}
      {view === 'crew' && isAdmin && <Crew ops={ops} run={run} say={say} />}
      {view === 'managers' && isAdmin && <Managers farms={farms} run={run} say={say} />}
      {view === 'alerts' && isAdmin && <AlertLog say={say} />}
      {toast && (
        <div className="spray-toast">
          {toast.msg}
          {toast.undo && <button onClick={() => { setToast(null); toast.undo() }}>Undo</button>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------
function Schedule({ jobs, ops, isAdmin, run, say, mine }) {
  const today = todayYmd()
  const [crew, setCrew] = useState('all')
  const [manager, setManager] = useState('')
  const [range, setRange] = useState('week')
  const [open, setOpen] = useState({})
  const [showDone, setShowDone] = useState(false)
  const [showHidden, setShowHidden] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const wx = useWeather(jobs)

  const managers = useMemo(() => [...new Set(jobs.map((j) => j.manager).filter(Boolean))].sort(), [jobs])
  const pass = (j) => (crew === 'all' || j.source === crew) && (!manager || j.manager === manager)
  const live = jobs.filter((j) => !j.hidden && pass(j))
  const openJobs = live.filter((j) => !j.done && inRange(j, range, today))
  const doneJobs = live.filter((j) => j.done).sort((a, b) => (String(b.done.completed_date) > String(a.done.completed_date) ? 1 : -1))
  const hidden = jobs.filter((j) => j.hidden)
  const myJobs = mine ? openJobs.filter(mine).sort((a, b) => (a.planned_date < b.planned_date ? -1 : a.planned_date > b.planned_date ? 1 : 0)) : []
  const L = lanes(mine ? openJobs.filter((j) => !mine(j)) : openJobs)
  const counts = {
    today: openJobs.filter((j) => j.planned_date <= today).length,
    acres: Math.round(openJobs.reduce((a, j) => a + (Number(j.acres) || 0), 0))
  }

  const toggle = (k) => setOpen((o) => Object.assign({}, o, { [k]: !o[k] }))
  const actions = {
    done: async (j) => {
      const r = await run({ action: 'done', jobKey: j.job_key })
      say('Done: ' + j.field + (r && r.alerted ? ' · alert to ' + r.alerted : ''), async () => { await run({ action: 'undo', jobKey: j.job_key }); say('Back on the schedule, alert cancelled') })
    },
    undo: async (j) => { await run({ action: 'undo', jobKey: j.job_key }); say('Back on the schedule') },
    assign: async (j, operator, rig) => { await run({ action: 'assign', jobKey: j.job_key, operator, rig }); say(operator ? operator + ' on ' + j.field : 'Operator cleared') },
    move: async (j, date) => {
      const r = await run({ action: 'move', jobKey: j.job_key, date })
      say(r.moved ? 'Moved to ' + fmtDay(r.planned_date) : 'Back to the AgWorld date')
    },
    hide: async (j) => {
      if (!window.confirm('Remove ' + j.field + ' from the schedule?\n\nIt stays in AgWorld. If the job changes in AgWorld it comes back by itself, or restore it under Removed jobs.')) return
      await run({ action: 'hide', jobKey: j.job_key })
      say('Removed ' + j.field, async () => { await run({ action: 'restore', jobKey: j.job_key }); say('Back on the schedule') })
    },
    restore: async (j) => { await run({ action: 'restore', jobKey: j.job_key }); say('Back on the schedule') }
  }
  const doSync = async (mode) => {
    setSyncing(true)
    try {
      const r = (await syncNow({ mode })).data
      say(r && r.skipped && typeof r.skipped === 'string' ? 'A sync is already running.' : 'AgWorld synced: ' + (r ? r.kept : '?') + ' jobs')
    } catch (e) { say('Sync failed: ' + (e.message || e)) }
    setSyncing(false)
  }

  return (
    <div>
      <div className="spray-bar">
        <div className="spray-seg">
          {[['all', 'All'], ['drone', 'Drone'], ['ground', 'Ag Rows']].map(([v, l]) => (
            <button key={v} className={crew === v ? 'active' : ''} onClick={() => setCrew(v)}>{l}</button>
          ))}
        </div>
        <select value={manager} onChange={(e) => setManager(e.target.value)}>
          <option value="">All managers</option>
          {managers.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <div className="spray-seg">
          {RANGES.map(([v, l]) => <button key={v} className={range === v ? 'active' : ''} onClick={() => setRange(v)}>{l}</button>)}
        </div>
        {isAdmin && <button onClick={() => doSync('hourly')} disabled={syncing} title="Pull what changed in AgWorld">{syncing ? 'Syncing…' : 'Sync AgWorld'}</button>}
      </div>
      <div className="spray-summary">
        <span><b>{openJobs.length}</b> open job{openJobs.length === 1 ? '' : 's'}</span>
        <span><b>{counts.today}</b> today or past due</span>
        <span><b>{counts.acres.toLocaleString()}</b> ac</span>
      </div>

      {mine && (
        <div className="spray-lane spray-mine">
          <div className="spray-lane-head">
            <span>Your farms</span>
            <span className="spray-muted">{myJobs.length} job{myJobs.length === 1 ? '' : 's'} · {Math.round(myJobs.reduce((a, j) => a + (Number(j.acres) || 0), 0)).toLocaleString()} ac</span>
          </div>
          {!myJobs.length && <div className="spray-empty">Nothing on your farms {range === 'today' ? 'today' : range === 'week' ? 'in the next 7 days' : 'coming up'}.</div>}
          {myJobs.map((j, i) => (
            <div key={j.job_key}>
              {(i === 0 || dayLabel(myJobs[i - 1].planned_date, today) !== dayLabel(j.planned_date, today)) &&
                <div className={'spray-day' + (j.planned_date < today ? ' late' : '')}>{dayLabel(j.planned_date, today)}</div>}
              <JobCard j={j} today={today} wx={wx[j.job_key]} ops={ops} isAdmin={isAdmin}
                open={!!open[j.job_key]} onToggle={() => toggle(j.job_key)} actions={actions} />
            </div>
          ))}
          {L.length > 0 && <div className="spray-rest">Rest of the schedule</div>}
        </div>
      )}
      {!L.length && !mine && <div className="spray-empty">Nothing scheduled {range === 'today' ? 'today' : range === 'week' ? 'in the next 7 days' : ''}.</div>}
      {L.map((lane) => (
        <div className="spray-lane" key={lane.operator || '_none'}>
          <div className="spray-lane-head">
            <span className={lane.operator ? '' : 'spray-unassigned'}>{lane.operator || 'No operator yet'}</span>
            <span className="spray-muted">{lane.jobs.length} job{lane.jobs.length === 1 ? '' : 's'} · {Math.round(lane.jobs.reduce((a, j) => a + (Number(j.acres) || 0), 0)).toLocaleString()} ac</span>
          </div>
          {lane.jobs.map((j, i) => (
            <div key={j.job_key}>
              {(i === 0 || dayLabel(lane.jobs[i - 1].planned_date, today) !== dayLabel(j.planned_date, today)) &&
                <div className={'spray-day' + (j.planned_date < today ? ' late' : '')}>{dayLabel(j.planned_date, today)}</div>}
              <JobCard j={j} today={today} wx={wx[j.job_key]} ops={ops} isAdmin={isAdmin}
                open={!!open[j.job_key]} onToggle={() => toggle(j.job_key)} actions={actions} />
            </div>
          ))}
        </div>
      ))}

      <div className="spray-section">
        <button onClick={() => setShowDone((s) => !s)}>{showDone ? 'Hide' : 'Show'} done jobs ({doneJobs.length})</button>
      </div>
      {showDone && doneJobs.map((j) => (
        <JobCard key={j.job_key} j={j} today={today} wx={null} ops={ops} isAdmin={isAdmin}
          open={!!open[j.job_key]} onToggle={() => toggle(j.job_key)} actions={actions} />
      ))}

      {isAdmin && (
        <>
          <div className="spray-section">
            <button onClick={() => setShowHidden((s) => !s)}>{showHidden ? 'Hide' : 'Show'} removed jobs ({hidden.length})</button>
          </div>
          {showHidden && (hidden.length ? hidden.map((j) => (
            <div className="spray-hidden" key={j.job_key}>
              <div>
                <b>{j.field}</b>
                <div className="spray-muted">{[j.title, fmtDay(j.planned_date), j.source === 'drone' ? 'Drone' : 'Ag Rows'].filter(Boolean).join(' · ')}</div>
                <div className="spray-muted">Removed {j.hidden.at ? fmtDay(String(j.hidden.at).slice(0, 10)) : ''}{j.hidden.by ? ' by ' + j.hidden.by : ''}</div>
              </div>
              <button onClick={() => actions.restore(j)}>Restore</button>
            </div>
          )) : <div className="spray-empty">Nothing removed.</div>)}
        </>
      )}
    </div>
  )
}

function JobCard({ j, today, wx, ops, isAdmin, canDone, open, onToggle, actions }) {
  const kind = kindOf(j)
  const mayDone = canDone === undefined ? isAdmin : canDone   // crew links: Done without the admin details
  const phone = j.manager_phone   // from the Spray Managers tab
  const [busy, setBusy] = useState(false)
  const guard = (fn) => async (e) => {
    if (e) e.stopPropagation()
    setBusy(true)
    try { await fn() } catch (err) { /* message already shown */ }
    setBusy(false)
  }
  const late = !j.done && j.planned_date < today
  return (
    <div className={'spray-card k-' + kind + (j.done ? ' done' : '') + (late ? ' late' : '')}>
      <div className="spray-card-main" onClick={onToggle}>
        <div className="spray-card-top">
          <span className={'spray-tag k-' + kind}>{KIND_LABEL[kind]}</span>
          <span className="spray-muted">{fmtDay(j.planned_date)}{j.moved ? ' (moved)' : ''}</span>
          {j.done && <span className="spray-donetag">✓ Done {j.done.completed_date ? fmtDay(j.done.completed_date, { weekday: undefined }) : ''}</span>}
        </div>
        <div className="spray-field">{cropEmoji(j.crop)} {j.field}</div>
        <div className="spray-meta">{[j.crop, (Number(j.acres) || 0).toLocaleString() + ' ac', j.manager].filter(Boolean).join(' · ')}</div>
        <div className={'spray-op' + (j.operator ? '' : ' none')}>{j.operator ? j.operator + (j.source === 'drone' && j.rig ? ' · ' + j.rig : '') : 'No operator yet'}</div>
        {wx && <Weather w={wx} />}
      </div>
      <div className="spray-actions">
        {j.agworld_link && <a className="spray-btn" href={j.agworld_link} target="_blank" rel="noreferrer"><FileText size={18} />PDF</a>}
        {j.pin_url && <a className="spray-btn" href={j.pin_url} target="_blank" rel="noreferrer"><Navigation size={18} />Directions</a>}
        {phone && <a className="spray-btn" href={'tel:' + phone.replace(/[^\d+]/g, '')}><Phone size={18} />{String(j.manager).split(' ')[0]}</a>}
        {mayDone && !j.done && <button className="spray-btn save" disabled={busy} onClick={guard(() => actions.done(j))}><Check size={18} strokeWidth={3} />Done</button>}
        {mayDone && j.done && j.done.entered_by === 'App (waiting on AgWorld)' && <button className="spray-btn" disabled={busy} onClick={guard(() => actions.undo(j))}><Undo2 size={18} />Undo</button>}
      </div>
      {open && <Details j={j} ops={ops} isAdmin={isAdmin} actions={actions} busy={busy} guard={guard} />}
    </div>
  )
}

function Weather({ w }) {
  const lvlNow = w.now ? windLevel(w.now.wind, w.now.gust) : 0
  const lvlMax = windLevel(w.maxWind, w.maxGust)
  return (
    <div className="spray-wx">
      {w.now && <span className={'wx l' + lvlNow}><b>NOW</b> {w.now.wind} mph {w.now.dir} · gust {w.now.gust} · {w.now.temp}°</span>}
      <span className={'wx l' + lvlMax}><b>{w.now ? 'TODAY MAX' : 'MAX'}</b> {w.maxWind} mph{w.maxGust != null ? ' · gust ' + w.maxGust : ''}</span>
    </div>
  )
}

function Details({ j, ops, isAdmin, actions, busy, guard }) {
  const crewOps = ops.filter((o) => o.active !== false && (o.crew === 'drone') === (j.source === 'drone'))
  const [op, setOp] = useState(j.operator)
  useEffect(() => { setOp(j.operator) }, [j.operator])
  // Drone jobs carry the pilot's drone (Operators tab); Ag Rows jobs carry just the operator.
  const droneOf = (name) => { const o = ops.find((x) => x.name === name); return j.source === 'drone' && o ? (o.rig || '') : '' }
  const products = Array.isArray(j.product_detail) && j.product_detail.length ? j.product_detail : String(j.products || '').split(',').filter(Boolean).map((n) => ({ name: n.trim() }))
  return (
    <div className="spray-details">
      {j.title && <div><span className="spray-muted">AgWorld:</span> {j.title}</div>}
      {products.length > 0 && (
        <div className="spray-products">
          {products.map((p, i) => <div key={i}>{p.name}{p.rate ? <span className="spray-muted"> · {p.rate}</span> : null}</div>)}
        </div>
      )}
      {j.fields && j.fields.length > 1 && <div className="spray-muted">{j.fields.map((f) => f.name + ' ' + f.acres + ' ac').join(' · ')}</div>}
      {j.done && (
        <div className="spray-box">
          <b>{j.done.entered_by === 'App (waiting on AgWorld)' ? 'Marked done in the app, waiting on AgWorld' : 'Closed in AgWorld'}</b>
          <div>{[j.done.completed_date && fmtDay(j.done.completed_date), j.done.acres_done && j.done.acres_done + ' ac',
            j.done.gallons && Math.round(j.done.gallons).toLocaleString() + ' gal', j.done.gpa && j.done.gpa + ' GPA', j.done.operator].filter(Boolean).join(' · ')}</div>
          {j.done.conditions && <div className="spray-muted">{j.done.conditions}</div>}
        </div>
      )}
      {isAdmin && (
        <>
          <div className="spray-row">
            <select value={op} onChange={(e) => setOp(e.target.value)}>
              <option value="">No operator</option>
              {op && !crewOps.some((o) => o.name === op) && <option value={op}>{op}</option>}
              {crewOps.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
            </select>
            {j.source === 'drone' && op && droneOf(op) && <span className="spray-muted">{droneOf(op)}</span>}
            <button className="save" disabled={busy || op === j.operator} onClick={guard(() => actions.assign(j, op, droneOf(op)))}>Save</button>
          </div>
          {!j.done && (
            <div className="spray-row">
              <span className="spray-muted">Move to</span>
              <input type="date" defaultValue={j.planned_date} onChange={(e) => e.target.value && guard(() => actions.move(j, e.target.value))()} />
              <button disabled={busy} onClick={guard(() => actions.move(j, addDays(j.planned_date, 1)))}>+1 day</button>
              <button disabled={busy} onClick={guard(() => actions.move(j, addDays(j.planned_date, 2)))}>+2 days</button>
              {j.moved && <button disabled={busy} onClick={guard(() => actions.move(j, ''))}>Back to AgWorld date ({fmtDay(j.agworld_date)})</button>}
            </div>
          )}
          <div className="spray-row">
            <button className="spray-danger" disabled={busy} onClick={guard(() => actions.hide(j))}>Remove from schedule</button>
            {j.agworld_page && <a href={j.agworld_page} target="_blank" rel="noreferrer">Open in AgWorld</a>}
          </div>
        </>
      )}
    </div>
  )
}

// Weather at each open job's pin, for its date (16-day forecast). One request per pin, refreshed hourly.
function useWeather(jobs) {
  const [data, setData] = useState({})
  const cache = useRef({})
  const today = todayYmd()
  // Past-due jobs show today's weather (that's when they'd get done); the rest show their own day.
  const dayFor = (j) => (j.planned_date < today ? today : j.planned_date)
  const want = jobs.filter((j) => !j.done && !j.hidden && j.lat != null && j.lng != null && dayFor(j) <= addDays(today, 15))
  const keyOf = (j) => Number(j.lat).toFixed(2) + ',' + Number(j.lng).toFixed(2)
  const sig = want.map((j) => j.job_key + '@' + keyOf(j) + '@' + dayFor(j)).join('|')
  useEffect(() => {
    let alive = true
    const load = async () => {
      const pins = {}
      want.forEach((j) => { pins[keyOf(j)] = j })
      await Promise.all(Object.keys(pins).map(async (k) => {
        const c = cache.current[k]
        if (c && Date.now() - c.at < 3600000) return
        try {
          const [lat, lng] = k.split(',')
          const res = await fetch(weatherUrl(lat, lng))
          if (res.ok) cache.current[k] = { at: Date.now(), data: await res.json() }
        } catch (e) { /* no weather is fine */ }
      }))
      if (!alive) return
      const out = {}
      want.forEach((j) => { const c = cache.current[keyOf(j)]; if (c) out[j.job_key] = summarizeWeather(c.data, dayFor(j), todayYmd()) })
      setData(out)
    }
    load()
    const t = setInterval(load, 3600000)
    return () => { alive = false; clearInterval(t) }
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps
  return data
}

// ---------------------------------------------------------------------------
// Operators tab (Spray admin): add / edit / delete operators, and their no-login links.
// Drone pilots carry the drone (and trailer) they run; it rides onto the drone jobs they're put on.
// ---------------------------------------------------------------------------
function Crew({ ops, run, say }) {
  const blank = { id: '', name: '', crew: 'ground', rig: '', phone: '', aliases: '', active: true }
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => Object.assign({}, f, { [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const save = async () => {
    if (!form.name.trim()) { say('Enter a name.'); return }
    setBusy(true)
    try { await run(Object.assign({ action: 'saveOperator' }, form, { rig: form.crew === 'drone' ? form.rig : '' })); say((form.id ? 'Saved ' : 'Added ') + form.name); setForm(blank) } catch (e) { /* shown */ }
    setBusy(false)
  }
  const del = async (o) => {
    if (!window.confirm('Delete ' + o.name + ' from the crew list? Their link stops working too. Jobs already assigned keep the name.')) return
    setBusy(true)
    try {
      if (links[normName(o.name)]) await linkAdmin({ action: 'off', name: o.name })
      await run({ action: 'deleteOperator', id: o.id }); await loadLinks(); say('Deleted ' + o.name)
    } catch (e) { /* shown */ }
    setBusy(false)
  }
  // No-login crew links (functions/sprayCrewLinks.js): one per person, replace or turn off any time.
  const [links, setLinks] = useState({})
  const loadLinks = async () => {
    try {
      const r = (await linkAdmin({ action: 'list' })).data
      const m = {}; (r.links || []).forEach((l) => { m[normName(l.name)] = l }); setLinks(m)
    } catch (e) { /* shown when used */ }
  }
  useEffect(() => { loadLinks() }, [])
  const urlOf = (code) => window.location.origin + '/crew/' + code
  const send = async (o, code) => {
    const url = urlOf(code)
    const text = 'Your spray schedule (' + (o.crew === 'drone' ? 'drone jobs' : 'Ag Rows jobs') + '). Keep this text and tap the link to open it: '
    try {
      if (navigator.share) { await navigator.share({ title: 'Spray schedule', text, url }); return }
    } catch (e) { if (e && e.name === 'AbortError') return }
    try { await navigator.clipboard.writeText(url); say('Link copied. Paste it in a text to ' + o.name) }
    catch (e) { window.prompt('Copy this link for ' + o.name, url) }
  }
  const makeLink = async (o) => {
    setBusy(true)
    try { const r = (await linkAdmin({ action: 'make', name: o.name, crew: o.crew })).data; await loadLinks(); await send(o, r.code) }
    catch (e) { say(e.message || String(e)) }
    setBusy(false)
  }
  const linkOff = async (o) => {
    if (!window.confirm('Turn off ' + o.name + '\'s link? It stops working right away.')) return
    setBusy(true)
    try { await linkAdmin({ action: 'off', name: o.name }); await loadLinks(); say(o.name + '\'s link is off') }
    catch (e) { say(e.message || String(e)) }
    setBusy(false)
  }
  const group = (c) => ops.filter((o) => o.crew === c)
  return (
    <div>
      <div className="spray-box">
        <b>{form.id ? 'Edit ' + form.name : 'Add an operator'}</b>
        <div className="spray-form">
          <label>Name<input value={form.name} onChange={set('name')} placeholder="As it should show on jobs" /></label>
          <label>Crew<select value={form.crew} onChange={set('crew')}><option value="ground">Ag Rows</option><option value="drone">Drone</option></select></label>
          {form.crew === 'drone' && <label>Drone <span className="spray-muted">(and trailer they run)</span><input value={form.rig} onChange={set('rig')} placeholder="e.g. Bluebird, trailer 2" /></label>}
          <label>Phone<input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="(208) 555-0123" /></label>
          <label className="wide">Other spellings <span className="spray-muted">(how AgWorld or Paycom writes the name, comma-separated)</span><input value={form.aliases} onChange={set('aliases')} placeholder="e.g. Greg Burton" /></label>
          <label className="check"><input type="checkbox" checked={form.active !== false} onChange={set('active')} /> Active</label>
        </div>
        <div className="spray-row">
          <button className="save" disabled={busy} onClick={save}>{form.id ? 'Save' : 'Add'}</button>
          {form.id && <button disabled={busy} onClick={() => setForm(blank)}>Cancel</button>}
        </div>
        <div className="spray-muted" style={{ marginTop: 6 }}>
          Make a link for each operator below and text it to them: no sign-in, Ag Rows see Ag Rows jobs, drone pilots see drone jobs.
          Farm managers and who gets field-done alerts are on the Managers tab.
        </div>
      </div>
      {[['drone', 'Drone crew'], ['ground', 'Ag Rows']].map(([c, label]) => (
        <div key={c}>
          <div className="spray-day">{label} ({group(c).length})</div>
          {group(c).length ? group(c).map((o) => (
            <div className={'spray-hidden' + (o.active === false ? ' off' : '')} key={o.id}>
              <div>
                <b>{o.name}</b>{o.active === false && <span className="spray-muted"> · inactive</span>}
                <div className="spray-muted">{[o.crew === 'drone' && o.rig && '🛸 ' + o.rig, o.phone, o.aliases && 'also: ' + o.aliases].filter(Boolean).join(' · ')}</div>
                {links[normName(o.name)] && <div className="spray-muted">Link {links[normName(o.name)].lastUsed ? 'last opened ' + new Date(links[normName(o.name)].lastUsed).toLocaleDateString() : 'not opened yet'}</div>}
              </div>
              <div className="spray-row" style={{ margin: 0 }}>
                <button disabled={busy} onClick={() => setForm(Object.assign({}, blank, o))}>Edit</button>
                {links[normName(o.name)]
                  ? <>
                    <button disabled={busy} onClick={() => send(o, links[normName(o.name)].code)}>Send link</button>
                    <button disabled={busy} onClick={() => makeLink(o)}>New link</button>
                    <button className="spray-danger" disabled={busy} onClick={() => linkOff(o)}>Turn off</button>
                  </>
                  : o.active !== false && <button className="save" disabled={busy} onClick={() => makeLink(o)}>Make link</button>}
                <button className="spray-danger" disabled={busy} onClick={() => del(o)}>Delete</button>
              </div>
            </div>
          )) : <div className="spray-empty">Nobody yet. Add them above.</div>}
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Phone alerts: "field is done" notifications for this phone (sprayPush.js)
// ---------------------------------------------------------------------------
function Alerts({ say }) {
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [openBell, setOpenBell] = useState(false)   // alerts on: just a bell in the header until tapped
  useEffect(() => { pushState().then(setSt).catch(() => setSt('unsupported')); refreshPush().catch(() => {}) }, [])
  if (!st || st === 'unsupported') return null
  const on = async () => {
    setBusy(true); setNote('')
    try {
      const r = await turnOn()
      if (r.ok) {
        setSt('on'); setOpenBell(!!(r.onSheet === false))
        setNote(r.onSheet === false ? 'Alerts are on for this phone, but your name or email isn\'t on the Spray Managers tab yet, so Done alerts won\'t come.' : '')
        say('Alerts on for this phone')
      } else setSt(r.error === 'blocked' ? 'blocked' : 'off')
    } catch (e) { setNote(e.message || String(e)) }
    setBusy(false)
  }
  const off = async () => { setBusy(true); await turnOff(); setSt('off'); setNote(''); setOpenBell(false); setBusy(false); say('Alerts off for this phone') }
  const test = async () => {
    setBusy(true)
    try { const r = await sendTest(); say(r.tested ? 'Test alert sent. It should pop up in a few seconds.' : 'No phone with alerts on for your login.') }
    catch (e) { say(e.message || String(e)) }
    setBusy(false)
  }
  if (st === 'on' && !openBell) {
    return <button className="spray-bell" title="Field-done alerts are on" aria-label="Field-done alerts are on" onClick={() => setOpenBell(true)}>🔔</button>
  }
  return (
    <div className="spray-alerts">
      {st === 'on' && <>
        <span>🔔 Field-done alerts are on for this phone</span>
        <span className="spray-row" style={{ margin: 0 }}>
          <button disabled={busy} onClick={test}>Send a test</button>
          <button disabled={busy} onClick={off}>Turn off</button>
          <button disabled={busy} onClick={() => { setOpenBell(false); setNote('') }}>Close</button>
        </span>
      </>}
      {st === 'off' && <>
        <span>Get an alert on this phone when your fields are done</span>
        <button className="save" disabled={busy} onClick={on}>Turn on alerts</button>
      </>}
      {st === 'blocked' && <span>Alerts are blocked for AIO on this phone. Turn them on in the phone's Settings → Notifications → AIO, then come back.</span>}
      {st === 'ios-home' && <span>For field-done alerts on iPhone: in Safari tap Share → <b>Add to Home Screen</b>, then open AIO from that icon.</span>}
      {note && <div className="spray-muted" style={{ flexBasis: '100%' }}>{note}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Crew link page: /crew/<code>, no sign-in (functions/sprayCrewLinks.js sprayCrew)
// Ag Rows links: all Ag Rows jobs; drone links: drone jobs. Done on any of them.
// ---------------------------------------------------------------------------
export function SprayCrew({ code }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [open, setOpen] = useState({})
  const [showDone, setShowDone] = useState(false)
  const [toast, setToast] = useState(null)
  const toastTimer = useRef(null)
  const say = (msg, undo) => {
    setToast({ msg, undo })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), undo ? 7000 : 2600)
  }
  const load = async () => {
    try { setData((await crewCall({ code, action: 'load' })).data); setError(null) }
    catch (e) { setError(e.message || String(e)) }
  }
  useEffect(() => {
    document.body.classList.add('spray-dark')
    load()
    const t = setInterval(load, 60000)
    const onVis = () => { if (document.visibilityState === 'visible') load() }
    document.addEventListener('visibilitychange', onVis)
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); document.body.classList.remove('spray-dark') }
  }, [code]) // eslint-disable-line react-hooks/exhaustive-deps
  const jobs = (data && data.jobs) || []
  const wx = useWeather(jobs)
  const today = todayYmd()
  const run = async (action, j) => {
    try {
      const r = (await crewCall({ code, action, jobKey: j.job_key })).data
      setData((d) => Object.assign({}, d, { jobs: r.jobs }))
      return r
    } catch (e) { say(e.message || String(e)); throw e }
  }
  const actions = {
    done: async (j) => { await run('done', j); say('Done: ' + j.field, async () => { await run('undo', j); say('Back on the schedule') }) },
    undo: async (j) => { await run('undo', j); say('Back on the schedule') }
  }
  const byDate = (a, b) => (a.planned_date < b.planned_date ? -1 : a.planned_date > b.planned_date ? 1 : String(a.field).localeCompare(String(b.field)))
  const openJobs = jobs.filter((j) => !j.done).sort(byDate)
  const me = data ? normName(data.name) : ''
  const mine = openJobs.filter((j) => normName(j.operator) === me)
  const rest = openJobs.filter((j) => normName(j.operator) !== me)
  const done = jobs.filter((j) => j.done).sort((a, b) => (String(b.done.completed_date) > String(a.done.completed_date) ? 1 : -1))
  const toggle = (k) => setOpen((o) => Object.assign({}, o, { [k]: !o[k] }))
  const list = (arr) => arr.map((j, i) => (
    <div key={j.job_key}>
      {(i === 0 || dayLabel(arr[i - 1].planned_date, today) !== dayLabel(j.planned_date, today)) &&
        <div className={'spray-day' + (j.planned_date < today ? ' late' : '')}>{dayLabel(j.planned_date, today)}</div>}
      <JobCard j={j} today={today} wx={wx[j.job_key]} ops={[]} isAdmin={false} canDone open={!!open[j.job_key]} onToggle={() => toggle(j.job_key)} actions={actions} />
    </div>
  ))
  return (
    <div className="spray">
      <div className="spray-brand">
        <div className="spray-logo"><img src={jkLogo} alt="JK Farms" /></div>
        <h1>Spray Schedule</h1>
      </div>
      {error && <div className="spray-error">{error}</div>}
      {!data && !error && <div className="spray-empty">Loading the spray schedule…</div>}
      {data && (
        <>
          <div className="spray-summary">
            <span><b>{data.name}</b> · {data.crew === 'drone' ? 'Drone crew' : 'Ag Rows'}</span>
            <span><b>{openJobs.length}</b> open jobs</span>
            <span><b>{Math.round(openJobs.reduce((a, j) => a + (Number(j.acres) || 0), 0)).toLocaleString()}</b> ac</span>
          </div>
          {mine.length > 0 && (
            <div className="spray-lane spray-mine">
              <div className="spray-lane-head"><span>Yours</span><span className="spray-muted">{mine.length} jobs</span></div>
              {list(mine)}
            </div>
          )}
          <div className="spray-lane">
            <div className="spray-lane-head"><span>{data.crew === 'drone' ? 'All drone jobs' : 'All Ag Rows jobs'}</span><span className="spray-muted">{rest.length} jobs</span></div>
            {rest.length ? list(rest) : <div className="spray-empty">Nothing else on the schedule.</div>}
          </div>
          {done.length > 0 && (
            <div className="spray-section">
              <button onClick={() => setShowDone(!showDone)}>{showDone ? 'Hide' : 'Show'} done this week ({done.length})</button>
              {showDone && <div style={{ marginTop: 8 }}>{done.map((j) => <JobCard key={j.job_key} j={j} today={today} wx={null} ops={[]} isAdmin={false} canDone open={!!open[j.job_key]} onToggle={() => toggle(j.job_key)} actions={actions} />)}</div>}
            </div>
          )}
        </>
      )}
      {toast && (
        <div className="spray-toast">
          <span>{toast.msg}</span>
          {toast.undo && <button onClick={() => { const u = toast.undo; setToast(null); u() }}>Undo</button>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Alerts tab (Spray admins): did the field-done alerts go out, and if not, why
// ---------------------------------------------------------------------------
const ALERT_STATUS = {
  sent: 'Sent', queued: 'Waiting (Undo window / next send)', no_phones: 'No phone: nobody on it has turned on alerts in AIO, or their AIO email doesn\'t match the Managers tab',
  no_one: 'Nobody to send to (no farm manager on the job, nobody on All jobs)', stale: 'Too old, skipped', error: 'Failed'
}
function AlertLog({ say }) {
  const [log, setLog] = useState(null)
  const [busy, setBusy] = useState(false)
  const load = async (sendNow, testLikeDone) => {
    setBusy(true)
    try {
      const r = (await alertLogCall(testLikeDone ? { testLikeDone: true } : sendNow ? { sendNow: true } : {})).data
      setLog(r)
      if (r.test) say('Test sent to ' + r.test.sent + ' of ' + r.test.phones + ' phone' + (r.test.phones === 1 ? '' : 's') + (r.test.failed ? ', ' + r.test.failed + ' failed' : ''))
      else if (sendNow) say(r.sent ? 'Sent ' + r.sent.sent + ', no phone ' + r.sent.noPhone + ', errors ' + r.sent.errors : 'Nothing waiting')
    } catch (e) { say(e.message || String(e)) }
    setBusy(false)
  }
  useEffect(() => { load(false) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const ago = (t) => { if (!t) return 'never'; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : new Date(t).toLocaleString() }
  return (
    <div className="spray-box">
      <div className="spray-row" style={{ justifyContent: 'space-between' }}>
        <b>Recent field-done alerts</b>
        <span className="spray-row" style={{ margin: 0 }}>
          <button disabled={busy} onClick={() => load(false)}>Refresh</button>
          <button disabled={busy} onClick={() => load(false, true)}>Test like a Done</button>
          {log && <button className="save" disabled={busy} onClick={() => load(true)}>Send now</button>}
        </span>
      </div>
      {log && (
        <div style={{ marginTop: 8 }}>
          <div className="spray-muted">Sender last ran {ago(log.lastRun)} (it runs every 2 minutes).
            Phones with alerts on: {log.phones.length ? log.phones.map((p) => p.who + (p.count > 1 ? ' ×' + p.count : '')).join(', ') : 'none'}</div>
          {log.alerts.length ? log.alerts.map((a) => (
            <div key={a.jobKey} className="spray-hidden" style={{ marginTop: 6 }}>
              <div>
                <b>{a.title}</b> <span className="spray-muted">· {a.how === 'agworld' ? 'closed in AgWorld' : 'Done in AIO'} · {ago(a.createdAt)}</span>
                <div className="spray-muted">For: {a.people.join(', ') || 'nobody'} · phones that match now: {a.phonesNow}</div>
                <div className={a.status === 'sent' ? '' : 'spray-unassigned'}>{ALERT_STATUS[a.status] || a.status}{a.status === 'sent' ? ' to ' + a.phones + ' phone' + (a.phones === 1 ? '' : 's') : ''}{a.lastError ? ': ' + a.lastError : ''}</div>
              </div>
            </div>
          )) : <div className="spray-empty">No alerts yet.</div>}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Managers tab (Spray admin): farm managers for the spray schedule, separate from AIO's Users list.
// Their farms make them the manager on those jobs (name + Call button); "alerts" picks which
// field-done alerts they get. Kept in sprayContacts through sprayAct (no browser access).
// ---------------------------------------------------------------------------
const NOTIFY_CHOICES = [['', 'Their farms'], ['all', 'All jobs'], ['spreads', 'Spreads']]
const NOTIFY_NOTES = {
  '': 'Alerts for jobs on their farms.',
  all: 'Every field-done alert (drone + Ag Rows). Farms checked still make them the manager on those jobs.',
  spreads: 'Alerts for Ag Rows spread jobs, plus any farms checked.'
}
function Managers({ farms, run, say }) {
  const blank = { id: '', name: '', phone: '', email: '', farms: [], notify: '' }
  const [list, setList] = useState(null)
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const load = async (data) => {
    setBusy(true)
    try { const r = await run(data || { action: 'listManagers' }); setList(r.managers || []); return true }
    catch (e) { return false }
    finally { setBusy(false) }
  }
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const farmNames = Object.values(farms || {}).map((f) => f && f.name).filter(Boolean).sort((a, b) => a.localeCompare(b))
  const has = (name) => form.farms.some((f) => mapKey(f) === mapKey(name))
  const toggleFarm = (name) => setForm((f) => Object.assign({}, f, { farms: has(name) ? f.farms.filter((x) => mapKey(x) !== mapKey(name)) : f.farms.concat([name]) }))
  const extra = form.farms.filter((f) => !farmNames.some((n) => mapKey(n) === mapKey(f)))   // saved names AIO's farm list doesn't have
  const set = (k) => (e) => setForm((f) => Object.assign({}, f, { [k]: e.target.value }))
  const save = async () => {
    if (!form.name.trim()) { say('Enter a name.'); return }
    if (await load(Object.assign({ action: 'saveManager' }, form))) { say((form.id ? 'Saved ' : 'Added ') + form.name); setForm(blank) }
  }
  const del = async (m) => {
    if (!window.confirm('Remove ' + m.name + ' from the managers list? Their jobs lose the name and Call button, and they stop getting alerts.')) return
    if (await load({ action: 'deleteManager', id: m.id })) say('Removed ' + m.name)
  }
  const label = (n) => (NOTIFY_CHOICES.find((c) => c[0] === (n || '')) || NOTIFY_CHOICES[0])[1]
  return (
    <div>
      <div className="spray-box">
        <b>{form.id ? 'Edit ' + form.name : 'Add a manager'}</b>
        <div className="spray-form">
          <label>Name<input value={form.name} onChange={set('name')} placeholder="As AgWorld comments name them" /></label>
          <label>Phone<input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="(208) 555-0123" /></label>
          <label className="wide">Email <span className="spray-muted">(the one they sign into AIO with, so alerts find their phone)</span><input value={form.email} onChange={set('email')} inputMode="email" /></label>
        </div>
        <div className="spray-muted" style={{ margin: '8px 0 4px' }}>Farms</div>
        <div className="spray-farms">
          {farmNames.map((n) => <label key={n}><input type="checkbox" checked={has(n)} onChange={() => toggleFarm(n)} /> {n}</label>)}
          {extra.map((n) => <label key={'x' + n} title="Not in AIO's farm list"><input type="checkbox" checked onChange={() => toggleFarm(n)} /> {n} <span className="spray-muted">(typed)</span></label>)}
        </div>
        <div className="spray-muted" style={{ margin: '10px 0 4px' }}>Field-done alerts</div>
        <div className="spray-seg">
          {NOTIFY_CHOICES.map(([v, l]) => <button key={v} type="button" className={(form.notify || '') === v ? 'active' : ''} onClick={() => setForm((f) => Object.assign({}, f, { notify: v }))}>{l}</button>)}
        </div>
        <div className="spray-muted" style={{ marginTop: 4 }}>{NOTIFY_NOTES[form.notify || '']}</div>
        <div className="spray-row" style={{ marginTop: 10 }}>
          <button className="save" disabled={busy} onClick={save}>{form.id ? 'Save' : 'Add'}</button>
          {form.id && <button disabled={busy} onClick={() => setForm(blank)}>Cancel</button>}
        </div>
      </div>
      <div className="spray-day">Managers ({list ? list.length : '…'})</div>
      {list && (list.length ? list.map((m) => (
        <div className="spray-hidden" key={m.id}>
          <div>
            <b>{m.name}</b> <span className="spray-muted">· {label(m.notify)}</span>
            <div className="spray-muted">{[m.farms.join(', '), m.phone, m.email].filter(Boolean).join(' · ') || 'No farms, phone or email yet'}</div>
          </div>
          <div className="spray-row" style={{ margin: 0 }}>
            <button disabled={busy} onClick={() => setForm(Object.assign({}, blank, m))}>Edit</button>
            <button className="spray-danger" disabled={busy} onClick={() => del(m)}>Remove</button>
          </div>
        </div>
      )) : <div className="spray-empty">Nobody yet. Add your farm managers above.</div>)}
    </div>
  )
}
