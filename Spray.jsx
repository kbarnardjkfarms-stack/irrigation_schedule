import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import {
  mergeJobs, lanes, dayLabel, inRange, todayYmd, addDays, fmtDay, kindOf, KIND_LABEL, cropEmoji,
  weatherUrl, summarizeWeather, windLevel, mapKey, isMine, normName, RAIN_SHOW_PCT
} from './sprayMath.js'
import jkLogo from './jk-farms-logo.png'
import { FileText, Navigation, Phone, PhoneCall, Check, Undo2, UserRound, Trash2, MapPin, CircleCheck } from 'lucide-react'
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
        <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>Calendar</button>
        {isAdmin && <button className={view === 'crew' ? 'active' : ''} onClick={() => setView('crew')}>Operators</button>}
        {isAdmin && <button className={view === 'managers' ? 'active' : ''} onClick={() => setView('managers')}>Managers</button>}
        {isAdmin && <button className={view === 'alerts' ? 'active' : ''} onClick={() => setView('alerts')}>Alerts</button>}
      </div>
      {view === 'schedule' && <Schedule jobs={jobs} ops={ops} isAdmin={isAdmin} run={run} say={say}
        mine={mineFirst ? (j) => isMine(j, myName, myFarmKeys) : null} />}
      {view === 'calendar' && <Calendar jobs={jobs} ops={ops} isAdmin={isAdmin} run={run} say={say} />}
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
// What the job buttons do (Schedule and Calendar share these).
function jobActions(run, say) {
  return {
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
}

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
  const actions = jobActions(run, say)
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
  // The operator's phone (Operators tab), so a farm manager can call whoever is on the job
  const opRow = j.operator ? (ops || []).find((o) => normName(o.name) === normName(j.operator) ||
    String(o.aliases || '').split(',').some((a) => normName(a) && normName(a) === normName(j.operator))) : null
  const opPhone = opRow && opRow.phone ? String(opRow.phone) : ''
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
        <div className="spray-card-head">
          <div className="spray-field">{cropEmoji(j.crop)} {j.field}</div>
          <div className="spray-card-corner">
            <span className={'spray-tag k-' + kind}>{KIND_LABEL[kind]}</span>
            {isAdmin && !j.done && actions.hide && <button className="spray-trash" title="Remove from schedule" aria-label="Remove from schedule" disabled={busy} onClick={guard(() => actions.hide(j))}><Trash2 size={18} /></button>}
          </div>
        </div>
        <div className="spray-meta">{[j.crop, (Number(j.acres) || 0).toLocaleString() + ' ac', j.manager].filter(Boolean).join(' · ')}{j.moved ? ' · moved' : ''}</div>
        {!j.done && <div className={'spray-op' + (j.operator ? '' : ' none')}><UserRound size={15} /> {j.operator ? j.operator + (j.source === 'drone' && j.rig ? ' · ' + j.rig : '') : 'No operator yet'}</div>}
        {j.done && <div className="spray-donetag">✓ Done {j.done.completed_date ? fmtDay(j.done.completed_date) : ''}{j.done.operator ? ' · ' + j.done.operator : ''}{j.done.entered_by === 'App (waiting on AgWorld)' ? ' · waiting on AgWorld' : ''}</div>}
        {wx && !j.done && <Weather w={wx} today={today} />}
      </div>
      <div className="spray-actions">
        {j.agworld_link && <a className="spray-btn" href={j.agworld_link} target="_blank" rel="noreferrer"><FileText size={18} />PDF</a>}
        {j.pin_url && <a className="spray-btn" href={j.pin_url} target="_blank" rel="noreferrer"><Navigation size={18} />Directions</a>}
        {phone && <a className="spray-btn" href={'tel:' + phone.replace(/[^\d+]/g, '')} title={'Call ' + j.manager + ' (farm manager)'}><Phone size={18} />Call {String(j.manager).split(' ')[0]}</a>}
        {opPhone && !j.done && <a className="spray-btn" href={'tel:' + opPhone.replace(/[^\d+]/g, '')} title={'Call ' + j.operator + ' (operator)'}><PhoneCall size={18} />Call {String(j.operator).split(' ')[0]}</a>}
        {mayDone && !j.done && <button className="spray-btn save" disabled={busy} onClick={guard(() => actions.done(j))}><CircleCheck size={18} />Done</button>}
        {mayDone && j.done && j.done.entered_by === 'App (waiting on AgWorld)' && <button className="spray-btn" disabled={busy} onClick={guard(() => actions.undo(j))}><Undo2 size={18} />Undo</button>}
      </div>
      {open && <Details j={j} ops={ops} wx={wx} today={today} isAdmin={isAdmin} opPhone={opPhone} actions={actions} busy={busy} guard={guard} />}
    </div>
  )
}

// Weather boxes on a card, like the Google app: NOW (today), the day's MAX wind with its main
// direction and gusts, and RAIN when the chance is worth noticing.
function Weather({ w, today }) {
  const lvl = (l) => (l === 2 ? ' bad' : l === 1 ? ' warn' : '')
  const day = w.date && w.date !== today ? fmtDay(w.date).split(',')[0].toUpperCase() + ' MAX' : 'TODAY MAX'
  return (
    <div className="spray-wxb">
      {w.now && <div className={'wb' + lvl(windLevel(w.now.wind, w.now.gust))}><small>NOW</small><b>{w.now.wind} {w.now.dir} · G{w.now.gust}</b></div>}
      <div className={'wb' + lvl(windLevel(w.maxWind, w.maxGust))}><small>{day}</small><b>{w.maxWind}{!w.now && w.dir ? ' ' + w.dir : ''}{w.maxGust != null ? ' · G' + w.maxGust : ''}</b></div>
      {w.rain != null && w.rain >= RAIN_SHOW_PCT && <div className="wb warn"><small>RAIN</small><b>{w.rain}%</b></div>}
    </div>
  )
}

// The opened card: panels like the Google app (Date, Weather, Job, Farm manager, Operator, Remove).
function Details({ j, ops, wx, today, isAdmin, opPhone, actions, busy, guard }) {
  const crewOps = ops.filter((o) => o.active !== false && (o.crew === 'drone') === (j.source === 'drone'))
  // Drone jobs carry the pilot's drone (Operators tab); Ag Rows jobs carry just the operator.
  const droneOf = (name) => { const o = ops.find((x) => x.name === name); return j.source === 'drone' && o ? (o.rig || '') : '' }
  const tel = (p) => 'tel:' + String(p).replace(/[^\d+]/g, '')
  const products = Array.isArray(j.product_detail) && j.product_detail.length ? j.product_detail : String(j.products || '').split(',').filter(Boolean).map((n) => ({ name: n.trim() }))
  const fields = j.fields && j.fields.length ? j.fields : [{ name: j.field, acres: j.acres, pin: j.pin_url }]
  const pickOp = (name) => guard(() => actions.assign(j, name, droneOf(name)))()
  return (
    <div className="spray-panels">
      {isAdmin && !j.done && (
        <div className="spray-panel">
          <h4>Date</h4>
          <input type="date" defaultValue={j.planned_date} key={j.planned_date} onChange={(e) => e.target.value && e.target.value !== j.planned_date && guard(() => actions.move(j, e.target.value))()} />
          <div className="spray-row" style={{ marginTop: 6 }}>
            <button disabled={busy} onClick={guard(() => actions.move(j, addDays(j.planned_date, 1)))}>+1 day</button>
            <button disabled={busy} onClick={guard(() => actions.move(j, addDays(j.planned_date, 2)))}>+2 days</button>
            {j.moved && <button disabled={busy} onClick={guard(() => actions.move(j, ''))}>Back to AgWorld date</button>}
          </div>
          <div className="spray-muted">{j.moved ? 'AgWorld still has ' + fmtDay(j.agworld_date) + '.' : 'Moves it on the schedule only. AgWorld keeps its date.'}</div>
        </div>
      )}
      {!isAdmin && j.moved && !j.done && (
        <div className="spray-panel"><h4>Date</h4><div>{fmtDay(j.planned_date)}</div><div className="spray-muted">Moved from {fmtDay(j.agworld_date)} (AgWorld's date).</div></div>
      )}
      {!j.done && (
        <div className="spray-panel">
          {!wx ? <><h4>Weather</h4><div className="spray-muted">{j.lat == null ? 'No map pin for this field yet, so no weather.' : 'Loading…'}</div></> : <>
            <h4>Weather at the field · {fmtDay(wx.date || j.planned_date)}</h4>
            {wx.now && <div>Right now: <b>{wx.now.wind} mph {wx.now.dir}</b>, gusts {wx.now.gust}, {wx.now.temp}°F</div>}
            <div>{wx.now ? 'Rest of today' : 'Forecast'}: wind up to <b>{wx.maxWind} mph</b>{wx.dir ? ', mostly ' + wx.dir : ''}{wx.maxGust != null ? <>, gusts up to <b>{wx.maxGust}</b></> : null}</div>
            {(wx.rain != null || wx.lo != null) && <div>{wx.rain != null ? 'Rain chance ' + wx.rain + '%' : ''}{wx.rain != null && wx.lo != null ? ' · ' : ''}{wx.lo != null ? wx.lo + '–' + wx.hi + '°F' : ''}</div>}
          </>}
        </div>
      )}
      <div className="spray-panel">
        <h4>Job · {fmtDay(j.planned_date)}</h4>
        {j.title && <div className="spray-muted" style={{ marginBottom: 6 }}>{j.title}</div>}
        {j.agworld_link ? <a className="spray-linkbtn" href={j.agworld_link} target="_blank" rel="noreferrer"><FileText size={16} /> Open work order PDF</a> : <div className="spray-muted">No AgWorld link</div>}
        <div style={{ marginTop: 10 }}>
          {fields.map((f, i) => (
            <div className="spray-fieldrow" key={i}>
              <span>{f.name} <span className="spray-muted">{f.acres} ac</span></span>
              {f.pin ? <a href={f.pin} target="_blank" rel="noreferrer"><MapPin size={15} /> Pin</a> : <span className="spray-muted">no pin</span>}
            </div>
          ))}
        </div>
        {products.length > 0 && (
          <div className="spray-products">
            {products.map((p, i) => <div key={i}>{p.name}{p.rate ? <span className="spray-muted"> · {p.rate}</span> : null}</div>)}
          </div>
        )}
      </div>
      <div className="spray-panel">
        <h4>Farm manager</h4>
        {j.manager ? <>
          <div style={{ fontWeight: 600 }}>{j.manager}</div>
          {j.manager_phone ? <a className="spray-linkbtn" href={tel(j.manager_phone)}><Phone size={16} /> Call {j.manager_phone}</a>
            : <div className="spray-muted">No phone on file. Add it on the Managers tab.</div>}
        </> : <div className="spray-muted">No manager on this job. Put it on the first line of the AgWorld comment, or give the farm a manager on the Managers tab.</div>}
        {j.farm && <div className="spray-muted" style={{ marginTop: 6 }}>{j.farm}</div>}
      </div>
      {isAdmin && !j.done ? (
        <div className="spray-panel">
          <h4>Operator</h4>
          <div className="spray-muted" style={{ marginBottom: 6 }}>Pick who's doing it. Saves right away.</div>
          <select value={j.operator || ''} disabled={busy} onChange={(e) => pickOp(e.target.value)} style={{ width: '100%' }}>
            <option value="">No operator</option>
            {j.operator && !crewOps.some((o) => o.name === j.operator) && <option value={j.operator}>{j.operator}</option>}
            {crewOps.map((o) => <option key={o.id} value={o.name}>{o.name}{j.source === 'drone' && o.rig ? ' · ' + o.rig : ''}</option>)}
          </select>
          {opPhone && <a className="spray-linkbtn" href={tel(opPhone)}><PhoneCall size={16} /> Call {opPhone}</a>}
          {!crewOps.length && <div className="spray-muted" style={{ marginTop: 6 }}>No names yet. Add them on the Operators tab.</div>}
        </div>
      ) : j.operator && !j.done ? (
        <div className="spray-panel">
          <h4>Operator</h4>
          <div style={{ fontWeight: 600 }}>{j.operator}{j.source === 'drone' && j.rig ? <span className="spray-muted"> · {j.rig}</span> : null}</div>
          {opPhone && <a className="spray-linkbtn" href={tel(opPhone)}><PhoneCall size={16} /> Call {opPhone}</a>}
        </div>
      ) : null}
      {j.done && (j.done.entered_by === 'App (waiting on AgWorld)' ? (
        <div className="spray-panel">
          <h4>Marked done · waiting on AgWorld</h4>
          <div>{[fmtDay(j.done.completed_date), j.done.operator].filter(Boolean).join(' · ')}</div>
          <div className="spray-muted">Gallons and conditions fill in once it's closed as an actual in AgWorld.</div>
        </div>
      ) : (
        <div className="spray-panel">
          <h4>Applied · closed in AgWorld</h4>
          <div>{[fmtDay(j.done.completed_date), j.done.operator].filter(Boolean).join(' · ')}</div>
          <div>{[j.done.acres_done && j.done.acres_done + ' ac', j.done.gallons && Math.round(j.done.gallons).toLocaleString() + ' gal', j.done.gpa && j.done.gpa + ' GPA'].filter(Boolean).join(' · ')}</div>
          {j.done.conditions && <div className="spray-muted" style={{ marginTop: 4 }}>Applied in: {j.done.conditions}</div>}
        </div>
      ))}
      {isAdmin && !j.done && (
        <div className="spray-panel">
          <h4>Not supposed to be here?</h4>
          <div className="spray-muted" style={{ marginBottom: 8 }}>Takes it off the schedule. AgWorld isn't changed.</div>
          <button className="spray-danger" disabled={busy} onClick={guard(() => actions.hide(j))}><Trash2 size={15} /> Remove from schedule</button>
        </div>
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

// ---------------------------------------------------------------------------
// Calendar tab: a month of jobs, like the Google app. Done jobs sit on the day they were done,
// open ones on their (moved) date. Tap a day for its cards; tap a job to open its card.
// Spray admins can drag a job to another day to move it (schedule only; AgWorld keeps its date).
// ---------------------------------------------------------------------------
const monthStart = (ymd) => ymd.slice(0, 8) + '01'
function shiftMonth(m, n) {
  const d = new Date(m + 'T12:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n)
  return d.toISOString().slice(0, 10)
}
const mondayOf = (ymd) => { const wd = new Date(ymd + 'T12:00:00Z').getUTCDay(); return addDays(ymd, -((wd + 6) % 7)) }

function Calendar({ jobs, ops, isAdmin, run, say }) {
  const today = todayYmd()
  const [month, setMonth] = useState(monthStart(today))
  const [sel, setSel] = useState(today)
  const [crew, setCrew] = useState('all')
  const [open, setOpen] = useState({})
  const [over, setOver] = useState('')
  const actions = jobActions(run, say)
  const dateOf = (j) => (j.done ? (j.done.completed_date || j.planned_date) : j.planned_date)
  const live = jobs.filter((j) => !j.hidden && (crew === 'all' || j.source === crew))
  const by = {}
  live.forEach((j) => { const d = dateOf(j); if (d) (by[d] = by[d] || []).push(j) })
  const order = (a, b) => (a.done ? 1 : 0) - (b.done ? 1 : 0) || kindOf(a).localeCompare(kindOf(b)) || String(a.field).localeCompare(String(b.field))
  const start = mondayOf(month)
  const end = addDays(mondayOf(addDays(shiftMonth(month, 1), -1)), 6)
  const days = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)
  const selJobs = (by[sel] || []).slice().sort(order)
  const wx = useWeather(selJobs.filter((j) => !j.done))
  const name = new Date(month + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', year: 'numeric' })
  const go = (n) => { const m = shiftMonth(month, n); setMonth(m); setSel(m.slice(0, 7) === today.slice(0, 7) ? today : m) }
  const pick = (d, k) => {
    setSel(d)
    if (k) setOpen((o) => Object.assign({}, o, { [k]: true }))
    setTimeout(() => {
      const el = k ? document.querySelector('[data-cal-job="' + k + '"]') : document.getElementById('spray-cal-day')
      if (el) el.scrollIntoView({ block: k ? 'center' : 'start', behavior: 'smooth' })
    }, 40)
  }
  const canMove = (j) => isAdmin && !j.done
  const drop = async (e, d) => {
    e.preventDefault(); setOver('')
    const k = e.dataTransfer.getData('text/plain'), j = live.find((x) => x.job_key === k)
    if (!j || !canMove(j) || d === j.planned_date) return
    try { await actions.move(j, d); setSel(d) } catch (err) { /* message already shown */ }
  }
  const toggle = (k) => setOpen((o) => Object.assign({}, o, { [k]: !o[k] }))
  return (
    <div>
      <div className="spray-bar">
        <button onClick={() => go(-1)} aria-label="Previous month">‹</button>
        <b className="spray-cal-month">{name}</b>
        <button onClick={() => go(1)} aria-label="Next month">›</button>
        {month !== monthStart(today) && <button onClick={() => { setMonth(monthStart(today)); setSel(today) }}>This month</button>}
        <div className="spray-seg">
          {[['all', 'All'], ['drone', 'Drone'], ['ground', 'Ag Rows']].map(([v, l]) => (
            <button key={v} className={crew === v ? 'active' : ''} onClick={() => setCrew(v)}>{l}</button>
          ))}
        </div>
        <span className="spray-cal-legend"><span><i className="k-drone" />Drone</span><span><i className="k-spray" />Spray</span><span><i className="k-spread" />Spread</span></span>
      </div>
      <div className="spray-cal">
        {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((x) => <div className="hd" key={x}>{x}</div>)}
        {days.map((d) => {
          const js = (by[d] || []).slice().sort(order)
          const cls = ['cd', d.slice(0, 7) !== month.slice(0, 7) ? 'out' : '', d === today ? 'today' : '', d === sel ? 'sel' : '', d === over ? 'over' : ''].filter(Boolean).join(' ')
          return (
            <div key={d} className={cls} onClick={() => pick(d)}
              onDragOver={(e) => { e.preventDefault(); if (over !== d) setOver(d) }} onDragLeave={() => setOver('')} onDrop={(e) => drop(e, d)}>
              <div className="n">{Number(d.slice(8))}</div>
              {js.slice(0, 4).map((j) => (
                <span key={j.job_key} className={'mc k-' + kindOf(j) + (j.done ? ' done' : '')} draggable={canMove(j)}
                  onDragStart={(e) => e.dataTransfer.setData('text/plain', j.job_key)}
                  onClick={(e) => { e.stopPropagation(); pick(d, j.job_key) }}
                  title={j.field + ' · ' + (Number(j.acres) || 0).toLocaleString() + ' ac · ' + (j.operator || 'no operator')}>
                  {cropEmoji(j.crop)} {j.field}
                </span>
              ))}
              {js.length > 4 && <div className="more">+{js.length - 4} more</div>}
              <div className="dots">{js.slice(0, 6).map((j) => <i key={j.job_key} className={'k-' + kindOf(j) + (j.done ? ' done' : '')} />)}{js.length > 6 && <b>+</b>}</div>
            </div>
          )
        })}
      </div>
      {isAdmin && <div className="spray-muted spray-cal-tip">Drag a job to another day to move it (on a computer). AgWorld keeps its date.</div>}
      <div className="spray-day" id="spray-cal-day">{fmtDay(sel)} · {selJobs.length} job{selJobs.length === 1 ? '' : 's'}</div>
      {selJobs.length ? selJobs.map((j) => (
        <div key={j.job_key} data-cal-job={j.job_key}>
          <JobCard j={j} today={today} wx={wx[j.job_key]} ops={ops} isAdmin={isAdmin}
            open={!!open[j.job_key]} onToggle={() => toggle(j.job_key)} actions={actions} />
        </div>
      )) : <div className="spray-empty">No jobs this day.</div>}
    </div>
  )
}
