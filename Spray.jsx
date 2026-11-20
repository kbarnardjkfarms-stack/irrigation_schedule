import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [drones, setDrones] = useState([])
  const [flightFor, setFlightFor] = useState(null)   // { job, save } while the flight log is open

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

  // Drones list (Operators tab) for the flight log; only Spray admins mark drone jobs done here.
  useEffect(() => { if (isAdmin) sprayAct({ action: 'listDrones' }).then((r) => setDrones(r.data.drones || [])).catch(() => {}) }, [isAdmin])
  const openFlight = (job, save) => setFlightFor({ job, save })
  const pilots = ops.filter((o) => o.crew === 'drone' && o.active !== false).map((o) => ({ name: o.name, dues: renewalsOf(o) }))

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
        {isAdmin && <button className={view === 'drones' ? 'active' : ''} onClick={() => setView('drones')}>Drones</button>}
        {isAdmin && <button className={view === 'reports' ? 'active' : ''} onClick={() => setView('reports')}>Reports</button>}
        {isAdmin && <button className={view === 'costs' ? 'active' : ''} onClick={() => setView('costs')}>Costs</button>}
        {isAdmin && <button className={view === 'alerts' ? 'active' : ''} onClick={() => setView('alerts')}>Alerts</button>}
      </div>
      {view === 'schedule' && <Schedule jobs={jobs} ops={ops} isAdmin={isAdmin} run={run} say={say} openFlight={openFlight}
        mine={mineFirst ? (j) => isMine(j, myName, myFarmKeys) : null} />}
      {view === 'calendar' && <Calendar jobs={jobs} ops={ops} isAdmin={isAdmin} run={run} say={say} openFlight={openFlight} />}
      {view === 'crew' && isAdmin && <Crew ops={ops} run={run} say={say} />}
      {view === 'drones' && isAdmin && <Drones drones={drones} setDrones={setDrones} run={run} say={say} />}
      {view === 'reports' && isAdmin && <Reports run={run} say={say} pilots={pilots} drones={drones} chiefs={ops.filter((o) => o.crew === 'drone' && o.chief)} />}
      {view === 'costs' && isAdmin && <Costs run={run} say={say} ops={ops} />}
      {flightFor && <FlightForm job={flightFor.job} pilots={pilots} drones={drones.filter((d) => d.active !== false)}
        onSave={flightFor.save} onClose={() => setFlightFor(null)} />}
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
function doneMessage(j, r) {
  return 'Done: ' + j.field + (r && r.alerted ? ' · alert to ' + r.alerted : '') +
    (r && r.missing && r.missing.length ? ' · record is missing: ' + r.missing.join(', ') : '')
}
function jobActions(run, say, openFlight) {
  const finish = async (j, flight) => {
    const r = await run({ action: 'done', jobKey: j.job_key, flight })
    say(doneMessage(j, r), async () => { await run({ action: 'undo', jobKey: j.job_key }); say('Back on the schedule' + (flight ? ', flight record voided' : '') + ', alert cancelled') })
  }
  return {
    // Drone jobs: Done opens the flight log (records + logbooks); Ag Rows jobs: one tap.
    done: async (j) => { if (j.source === 'drone' && openFlight) openFlight(j, (flight) => finish(j, flight)); else await finish(j) },
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

function Schedule({ jobs, ops, isAdmin, run, say, mine, openFlight }) {
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
  const actions = jobActions(run, say, openFlight)
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
  const phone = j.manager_phone   // the farm manager's phone on the AIO Users screen
  // The operator's phone (Operators tab), so a farm manager can call whoever is on the job
  const opRow = j.operator ? (ops || []).find((o) => normName(o.name) === normName(j.operator)) : null
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
            : <div className="spray-muted">No phone on file. Add it to their login on the Users screen.</div>}
        </> : <div className="spray-muted">No manager on this job. Put it on the first line of the AgWorld comment, or tick this farm on a Farm manager's login (Users screen).</div>}
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
const LICENSE_TYPES = [['professional', 'Professional Applicator'], ['private', 'Private Applicator'], ['apprentice', 'Commercial Apprentice']]
// Renewal dates (same rules as functions/sprayRecords.js renewals): the Idaho date on the card wins,
// else 5 years from renewal (2 for an apprentice); FAA recurrent course every 24 calendar months;
// third-class medical 60 calendar months (24 if 40 or older at the exam).
const calEnd = (ymd, n) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ''; const [y, m] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1 + n + 1, 0)).toISOString().slice(0, 10) }
const yearsOn = (ymd, n) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd || '')) return ''; const [y, m, d] = ymd.split('-').map(Number); const e = new Date(Date.UTC(y + n, m - 1, d)); if (e.getUTCMonth() !== m - 1) e.setUTCDate(0); return e.toISOString().slice(0, 10) }
function renewalsOf(o) {
  const out = []
  const lic = o.license_exp || (o.license_issued ? yearsOn(o.license_issued, o.license_type === 'apprentice' ? 2 : 5) : '')
  if (lic) out.push({ kind: 'license', label: 'Idaho license', due: lic, figured: !o.license_exp })
  if (o.crew === 'drone' && o.faa_recurrent) out.push({ kind: 'faa', label: 'FAA recurrent course', due: calEnd(o.faa_recurrent, 24) })
  if (o.crew === 'drone' && o.medical_issued) out.push({ kind: 'medical', label: '3rd-class medical', due: calEnd(o.medical_issued, o.medical_over40 ? 24 : 60) })
  return out
}
const daysTo = (ymd) => Math.round((Date.parse(ymd + 'T12:00:00Z') - Date.parse(todayYmd() + 'T12:00:00Z')) / 86400000)
function Crew({ ops, run, say }) {
  const [tab, setTab] = useState('drone')   // inner tabs: Drone pilots | Ag Rows
  const blankFor = (crew) => ({ id: '', name: '', crew, phone: '', active: true,
    license_no: '', license_type: '', license_cats: '', license_exp: '', license_issued: '', supervisor: '', chief: false, faa_cert: '', part137_date: '', address: '',
    faa_recurrent: '', medical_issued: '', medical_over40: false })
  const blank = blankFor(tab)
  const [form, setForm] = useState(blank)
  const pickTab = (t) => { setTab(t); setForm(blankFor(t)) }
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => Object.assign({}, f, { [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const save = async () => {
    if (!form.name.trim()) { say('Enter a name.'); return }
    setBusy(true)
    try { await run(Object.assign({ action: 'saveOperator' }, form, { crew: tab })); say((form.id ? 'Saved ' : 'Added ') + form.name); setForm(blank) } catch (e) { /* shown */ }
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
  const list = ops.filter((o) => o.crew === tab)
  // licensed Professional Applicators (either crew) who can supervise an apprentice or an unlicensed operator
  const supervisors = ops.filter((o) => o.active !== false && o.license_type === 'professional' && String(o.license_no || '').trim())
  const drone = tab === 'drone'
  const papers = (o) => [
    o.license_no ? (LICENSE_TYPES.find((t) => t[0] === o.license_type) || [0, 'Idaho license'])[1] + ' ' + o.license_no : 'No Idaho license # yet',
    o.license_cats ? 'cat. ' + o.license_cats : '', drone && o.license_no && !/\bAU\b/.test(o.license_cats || '') ? '⚠ no AU category' : '',
    drone && (o.faa_cert ? 'FAA ' + o.faa_cert : 'no FAA cert #'), drone && (o.part137_date ? 'Part 137 ' + fmtDay(o.part137_date) : 'no Part 137 date')
  ].filter(Boolean).join(' · ')
  const dueChips = (o) => renewalsOf(o).map((r) => { const d = daysTo(r.due)
    return <span key={r.kind} className={'spray-due' + (d < 0 ? ' late' : d <= 30 ? ' soon' : '')}>{r.label}: {d < 0 ? 'past due ' : 'due '}{longDay(r.due)}{r.figured ? '*' : ''}</span> })
  const coming = list.filter((o) => o.active !== false).flatMap((o) => renewalsOf(o).map((r) => Object.assign({ name: o.name }, r))).filter((r) => daysTo(r.due) <= 90).sort((a, b) => a.due.localeCompare(b.due))
  return (
    <div>
      <div className="spray-subtabs">
        <button className={drone ? 'active' : ''} onClick={() => pickTab('drone')}>Drone pilots ({ops.filter((o) => o.crew === 'drone').length})</button>
        <button className={!drone ? 'active' : ''} onClick={() => pickTab('ground')}>Ag Rows ({ops.filter((o) => o.crew === 'ground').length})</button>
      </div>
      {coming.length > 0 && <div className="spray-box spray-coming">
        <b>Coming due (next 90 days)</b>
        {coming.map((r, i) => { const d = daysTo(r.due); return <div key={i} className={d < 0 ? 'late' : d <= 30 ? 'soon' : ''}>{r.name} · {r.label} · {d < 0 ? 'past due since ' + longDay(r.due) : longDay(r.due) + ' (' + d + ' days)'}</div> })}
      </div>}
      <div className="spray-box">
        <b>{form.id ? 'Edit ' + form.name : drone ? 'Add a drone pilot' : 'Add an Ag Rows operator'}</b>
        <div className="spray-form">
          <label>Name<input value={form.name} onChange={set('name')} placeholder="As it should show on jobs" /></label>
          <label>Phone<input value={form.phone} onChange={set('phone')} inputMode="tel" placeholder="(208) 555-0123" /></label>
          <div className="spray-formhead">Idaho applicator license</div>
          <label>License type<select value={form.license_type || ''} onChange={set('license_type')}>
            <option value="">Pick</option>
            {LICENSE_TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select></label>
          <label>License #<input value={form.license_no || ''} onChange={set('license_no')} /></label>
          <label>Categories <span className="spray-muted">{drone ? '(drones need AU)' : '(e.g. CO, AC)'}</span><input value={form.license_cats || ''} onChange={set('license_cats')} placeholder={drone ? 'e.g. CO, AU, AC' : 'e.g. CO, AC'} /></label>
          <label>Issued / last renewed<input type="date" max={todayYmd()} value={form.license_issued || ''} onChange={set('license_issued')} /></label>
          <label>Expires <span className="spray-muted">(from the card; blank = {form.license_type === 'apprentice' ? '2' : '5'} years from renewal)</span><input type="date" value={form.license_exp || ''} onChange={set('license_exp')} /></label>
          {(form.license_type === 'apprentice' || !String(form.license_no || '').trim()) && <label className="wide">Supervising Professional Applicator <span className="spray-muted">({form.license_type === 'apprentice' ? 'apprentice' : 'no license yet'}: who they work under)</span>
            <select value={form.supervisor || ''} onChange={set('supervisor')}>
              <option value="">Pick</option>
              {form.supervisor && !supervisors.some((o) => o.name === form.supervisor) && <option value={form.supervisor}>{form.supervisor}</option>}
              {supervisors.filter((o) => o.name !== form.name).map((o) => <option key={o.id} value={o.name}>{o.name} · PA #{o.license_no}</option>)}
            </select>
            {!supervisors.length && <span className="spray-muted">Nobody has a Professional Applicator license on file yet. Add yours as a drone pilot with your license.</span>}
          </label>}
          {drone && <>
            <div className="spray-formhead">FAA</div>
            <label className="check wide"><input type="checkbox" checked={!!form.chief} onChange={set('chief')} /> Chief supervisor on the Part 137 certificate (shows on the FAA reports)</label>
            <label>Certificate #<input value={form.faa_cert || ''} onChange={set('faa_cert')} /></label>
            <label>Part 137 knowledge/skill date <span className="spray-muted">(137.19(e))</span><input type="date" value={form.part137_date || ''} onChange={set('part137_date')} /></label>
            <label>Last recurrent course <span className="spray-muted">(or test date; due every 24 months)</span><input type="date" max={todayYmd()} value={form.faa_recurrent || ''} onChange={set('faa_recurrent')} /></label>
            <label>Third-class medical issued<input type="date" max={todayYmd()} value={form.medical_issued || ''} onChange={set('medical_issued')} /></label>
            <label className="check"><input type="checkbox" checked={!!form.medical_over40} onChange={set('medical_over40')} /> 40 or older at the medical exam (good 2 years, not 5)</label>
            <label className="wide">Address on records <span className="spray-muted">(blank = company: 20511 F Street, Rupert, ID 83350)</span><input value={form.address || ''} onChange={set('address')} /></label>
          </>}
          <label className="check"><input type="checkbox" checked={form.active !== false} onChange={set('active')} /> Active</label>
        </div>
        <div className="spray-row">
          <button className="save" disabled={busy} onClick={save}>{form.id ? 'Save' : 'Add'}</button>
          {form.id && <button disabled={busy} onClick={() => setForm(blank)}>Cancel</button>}
        </div>
        <div className="spray-muted" style={{ marginTop: 6 }}>
          {drone ? 'Drone pilots pick the drone they flew on each job\'s Done form. Their license and FAA numbers are copied into every flight record.'
            : 'Ag Rows operators mark jobs done with one tap; their license is copied into each Ag Rows record.'} Make a link for each person below and text it to them (no sign-in). You get a phone alert 30 and 7 days before anything comes due (* = figured from the issue date).
          Farm managers and who gets field-done alerts are on AIO's Users screen (each person's farms and Phone alerts).
        </div>
      </div>
      {list.length ? list.map((o) => (
        <div className={'spray-hidden' + (o.active === false ? ' off' : '')} key={o.id}>
          <div>
            <b>{o.name}</b>{drone && o.chief && <span className="spray-chief">Chief supervisor</span>}{o.active === false && <span className="spray-muted"> · inactive</span>}
            {o.phone && <div className="spray-muted">{o.phone}</div>}
            {o.supervisor && (o.license_type === 'apprentice' || !o.license_no) && <div className="spray-muted">Works under {o.supervisor}</div>}
            <div className="spray-muted">{papers(o)}</div>
            {renewalsOf(o).length > 0 && <div className="spray-dues">{dueChips(o)}</div>}
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
  )
}

// Drones tab: name + FAA registration for the records and logbooks; battery numbers for the Costs tab.
function Drones({ drones, setDrones, run, say }) {
  const blank = { id: '', name: '', make: '', model: '', faa_reg: '', serial: '', acres_before: '', purchase_price: '', activated: '', active: true, notes: '' }
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => Object.assign({}, f, { [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const go = async (data, msg) => {
    setBusy(true)
    try { const r = await run(data); setDrones(r.drones || []); say(msg); setForm(blank) } catch (e) { /* shown */ }
    setBusy(false)
  }
  const v = (x) => (x == null ? '' : String(x))
  // maintenance log (shows in each drone's logbook on Reports)
  const [maint, setMaint] = useState([])
  const [kinds, setKinds] = useState([])
  const [openLog, setOpenLog] = useState('')
  useEffect(() => { run({ action: 'listMaint' }).then((r) => { setMaint(r.maint || []); setKinds(r.kinds || []) }).catch(() => {}) }, [])
  return (
    <div>
      <div className="spray-box">
        <b>{form.id ? 'Edit ' + form.name : 'Add a drone'}</b>
        <div className="spray-form">
          <label>Nickname <span className="spray-muted">(what pilots pick on Done)</span><input value={form.name} onChange={set('name')} placeholder="e.g. Bluebird" /></label>
          <label>Make<select value={form.make} onChange={set('make')}><option value="">Pick</option><option>DJI</option><option>EAVision</option><option>Other</option></select></label>
          <label>Model<input value={form.model} onChange={set('model')} placeholder="e.g. Agras T50" /></label>
          <label>FAA registration #<input value={form.faa_reg} onChange={set('faa_reg')} placeholder="FA3…" /></label>
          <label>Serial #<input value={form.serial} onChange={set('serial')} /></label>
          <div className="spray-formhead">Purchase</div>
          <label>Purchase price ($) <span className="spray-muted">(drone + 3 batteries + charging station)</span><input type="number" min="0" step="1" inputMode="decimal" value={v(form.purchase_price)} onChange={set('purchase_price')} /></label>
          <label>Activated <span className="spray-muted">(warranty runs 1 year from this day)</span><input type="date" max={todayYmd()} value={form.activated || ''} onChange={set('activated')} /></label>
          <div className="spray-formhead">Acres</div>
          <label>Acres flown before the app <span className="spray-muted">(starting total; flights logged here add on)</span><input type="number" min="0" step="1" inputMode="decimal" value={v(form.acres_before)} onChange={set('acres_before')} /></label>
          <label className="wide">Notes<input value={form.notes} onChange={set('notes')} placeholder="e.g. trailer 2" /></label>
          <label className="check"><input type="checkbox" checked={form.active !== false} onChange={set('active')} /> In service</label>
        </div>
        <div className="spray-row">
          <button className="save" disabled={busy} onClick={() => go(Object.assign({ action: 'saveDrone' }, form), (form.id ? 'Saved ' : 'Added ') + form.name)}>{form.id ? 'Save' : 'Add'}</button>
          {form.id && <button disabled={busy} onClick={() => setForm(blank)}>Cancel</button>}
        </div>
      </div>
      {drones.length ? drones.map((d) => (
        <div className={'spray-hidden spray-wrap' + (d.active === false ? ' off' : '')} key={d.id}>
          <div>
            <b>🛸 {d.name}</b> <span className="spray-muted">{[d.make, d.model].filter(Boolean).join(' ')}{d.active === false ? ' · out of service' : ''}</span>
            <div className="spray-droneac"><b>{Math.round(Number(d.acres_total) || 0).toLocaleString()}</b> acres total
              <span className="spray-muted"> · {Math.round(Number(d.acres_before) || 0).toLocaleString()} before the app + {Math.round(Number(d.acres_logged) || 0).toLocaleString()} logged ({d.flights_logged || 0} flights, {hrs(d.minutes_logged)} hrs)</span></div>
            <div className="spray-muted">{[d.faa_reg ? 'FAA ' + d.faa_reg : 'No FAA registration yet', d.serial && 'S/N ' + d.serial].filter(Boolean).join(' · ')}</div>
            {d.purchase_price != null && <div className="spray-muted">Paid {money(d.purchase_price)} with 3 batteries + charging station</div>}
            {d.warranty_end && (() => {
              const days = Math.round((Date.parse(d.warranty_end + 'T12:00:00Z') - Date.parse(todayYmd() + 'T12:00:00Z')) / 86400000)
              return <div className={days < 0 ? 'spray-muted' : days <= 30 ? 'spray-warnline' : 'spray-okline'}>
                {days < 0 ? 'Warranty ended ' + longDay(d.warranty_end) : 'Warranty until ' + longDay(d.warranty_end) + ' · ' + days + ' day' + (days === 1 ? '' : 's') + ' left'}
                <span className="spray-muted"> (activated {longDay(d.activated)})</span></div>
            })()}
          </div>
          <div className="spray-row" style={{ margin: 0 }}>
            <button className={openLog === d.id ? 'active' : ''} onClick={() => setOpenLog(openLog === d.id ? '' : d.id)}>
              Maintenance ({maint.filter((m) => m.drone_id === d.id && m.status !== 'void').length})</button>
            <button disabled={busy} onClick={() => setForm(Object.assign({}, blank, d))}>Edit</button>
            <button className="spray-danger" disabled={busy} onClick={() => window.confirm('Delete ' + d.name + '? Flight records already saved keep its details.') && go({ action: 'deleteDrone', id: d.id }, 'Deleted ' + d.name)}>Delete</button>
          </div>
          {openLog === d.id && <MaintLog drone={d} list={maint.filter((m) => m.drone_id === d.id)} kinds={kinds} run={run} say={say} setMaint={setMaint} />}
        </div>
      )) : <div className="spray-empty">No drones yet. Add them above so pilots can pick the one they flew on the Done form.</div>}
    </div>
  )
}

// One drone's maintenance log: add an entry, void one (kept on file with the reason).
function MaintLog({ drone, list, kinds, run, say, setMaint }) {
  const blank = { date: todayYmd(), kind: 'Repair', what: '', by: '', cost: '' }
  const [f, setF] = useState(blank)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => { const v = e.target.value; setF((x) => Object.assign({}, x, { [k]: v })) }
  const add = async () => {
    setBusy(true)
    try { const r = await run(Object.assign({ action: 'addMaint', droneId: drone.id }, f)); setMaint(r.maint || []); setF(blank); say('Added to ' + drone.name + '\'s log') } catch (e) { /* shown */ }
    setBusy(false)
  }
  const voidIt = async (m) => {
    const why = window.prompt('Void this entry? It stays on file, marked void. Why?')
    if (!why) return
    try { const r = await run({ action: 'voidMaint', id: m.id, reason: why }); setMaint(r.maint || []); say('Entry voided') } catch (e) { /* shown */ }
  }
  return (
    <div className="spray-maint">
      <div className="spray-form">
        <label>Date<input type="date" value={f.date} max={todayYmd()} onChange={set('date')} /></label>
        <label>Type<select value={f.kind} onChange={set('kind')}>{(kinds.length ? kinds : ['Repair', 'Other']).map((k) => <option key={k}>{k}</option>)}</select></label>
        <label>Done by<input value={f.by} onChange={set('by')} placeholder="name or shop" /></label>
        <label>Cost ($)<input type="number" min="0" step="0.01" inputMode="decimal" value={f.cost} onChange={set('cost')} /></label>
        <label className="wide">What was done<input value={f.what} onChange={set('what')} maxLength={500} placeholder="e.g. replaced arm 3 after a hard landing, firmware 02.01.0400" /></label>
      </div>
      <div className="spray-row"><button className="save" disabled={busy} onClick={add}>Add to log</button></div>
      {list.length ? list.map((m) => (
        <div className={'spray-maintrow' + (m.status === 'void' ? ' void' : '')} key={m.id}>
          <div><b>{fmtDay(m.date)}</b> · {m.kind}{m.cost != null ? ' · ' + money(m.cost) : ''}{m.by ? ' · ' + m.by : ''}
            <div>{m.what}</div>
            {m.status === 'void' && <div className="spray-muted">Void: {(m.void && m.void.reason) || ''}</div>}</div>
          {m.status !== 'void' && <button className="spray-danger" onClick={() => voidIt(m)}>Void</button>}
        </div>
      )) : <div className="spray-muted">Nothing logged yet.</div>}
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
        setNote(r.onSheet === false ? 'Alerts are on for this phone, but no alerts are switched on for you yet (Users screen > Phone alerts), so nothing will come.' : '')
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
  const [tab, setTab] = useState('schedule')   // Ag Rows links: Schedule | Records
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
  const [flightFor, setFlightFor] = useState(null)
  const finish = async (j, flight) => {
    const r = (await crewCall({ code, action: 'done', jobKey: j.job_key, flight })).data
    setData((d) => Object.assign({}, d, { jobs: r.jobs }))
    say(doneMessage(j, r), async () => { await run('undo', j); say('Back on the schedule') })
  }
  const actions = {
    // drone pilots fill in the flight log on Done; Ag Rows is one tap
    done: async (j) => { if (j.source === 'drone') setFlightFor(j); else { try { await finish(j) } catch (e) { say(e.message || String(e)) } } },
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
      {data && data.crew === 'ground' && (
        <div className="spray-tabs">
          <button className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>Schedule</button>
          <button className={tab === 'records' ? 'active' : ''} onClick={() => setTab('records')}>Records</button>
        </div>
      )}
      {data && tab === 'records' && <CrewRecords code={code} me={data.name} />}
      {data && tab === 'schedule' && (
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
      {flightFor && <FlightForm job={flightFor} me={data && data.name} pilots={(data && data.pilots) || []} drones={(data && data.drones) || []}
        onSave={(flight) => finish(flightFor, flight)} onClose={() => setFlightFor(null)} />}
      {toast && (
        <div className="spray-toast">
          <span>{toast.msg}</span>
          {toast.undo && <button onClick={() => { const u = toast.undo; setToast(null); u() }}>Undo</button>}
        </div>
      )}
    </div>
  )
}

// Ag Rows crew link > Records: this year's Ag Rows applications (whole crew) and acres by operator.
function CrewRecords({ code, me }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState('')
  const [mineOnly, setMineOnly] = useState(false)
  useEffect(() => { crewCall({ code, action: 'records' }).then((r) => setD(r.data)).catch((e) => setErr(e.message || String(e))) }, [code])
  if (err) return <div className="spray-error">{err}</div>
  if (!d) return <div className="spray-empty">Loading records…</div>
  const all = d.records || []
  const byOp = {}
  all.forEach((r) => { const k = r.operator.name || 'Nobody assigned'; const o = byOp[k] = byOp[k] || { jobs: 0, acres: 0 }; o.jobs++; o.acres += Number(r.acres) || 0 })
  const ops = Object.keys(byOp).sort((a, b) => byOp[b].acres - byOp[a].acres)
  const total = all.reduce((t, r) => t + (Number(r.acres) || 0), 0)
  const list = (mineOnly ? all.filter((r) => normName(r.operator.name) === normName(me)) : all).slice().reverse()
  return (
    <div>
      <div className="spray-day">Acres by operator · {d.from.slice(0, 4)}</div>
      <div className="spray-box spray-acres">
        {ops.map((k) => (
          <div key={k} className={normName(k) === normName(me) ? 'me' : ''}>
            <span>{k}</span>
            <span className="bar"><i style={{ width: (total ? Math.max(3, byOp[k].acres / total * 100) : 0) + '%' }} /></span>
            <b>{Math.round(byOp[k].acres).toLocaleString()} ac</b><span className="spray-muted">{byOp[k].jobs} job{byOp[k].jobs === 1 ? '' : 's'}</span>
          </div>
        ))}
        {!ops.length && <div className="spray-muted">Nothing done yet this year.</div>}
        {ops.length > 0 && <div className="tot"><span>All Ag Rows</span><span /><b>{Math.round(total).toLocaleString()} ac</b><span className="spray-muted">{all.length} jobs</span></div>}
      </div>
      <div className="spray-bar" style={{ marginTop: 10 }}>
        <div className="spray-seg">
          <button className={!mineOnly ? 'active' : ''} onClick={() => setMineOnly(false)}>Everyone</button>
          <button className={mineOnly ? 'active' : ''} onClick={() => setMineOnly(true)}>Just mine</button>
        </div>
      </div>
      {list.map((r, i) => (
        <div key={r.id}>
          {(i === 0 || list[i - 1].date !== r.date) && <div className="spray-day">{fmtDay(r.date)}</div>}
          <div className="spray-hidden">
            <div>
              <b>{r.site.field}</b> <span className="spray-muted">{[r.job_type === 'Spread' ? 'Spread' : 'Spray', r.site.farm, r.site.crop].filter(Boolean).join(' · ')}</span>
              <div className="spray-muted">{[r.operator.name || 'Nobody assigned', r.done_time ? 'done ' + t12(r.done_time) : '', r.products.map((p) => p.name).join(', ')].filter(Boolean).join(' · ')}</div>
            </div>
            <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}><b>{Math.round(Number(r.acres) || 0).toLocaleString()} ac</b>{r.gallons ? <div className="spray-muted">{Math.round(r.gallons).toLocaleString()} gal</div> : null}</div>
          </div>
        </div>
      ))}
      {!list.length && <div className="spray-empty">No records yet.</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Alerts tab (Spray admins): did the field-done alerts go out, and if not, why
// ---------------------------------------------------------------------------
const ALERT_STATUS = {
  sent: 'Sent', queued: 'Waiting (Undo window / next send)', no_phones: 'No phone: nobody on it has turned on phone alerts in AIO',
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

function Calendar({ jobs, ops, isAdmin, run, say, openFlight }) {
  const today = todayYmd()
  const [month, setMonth] = useState(monthStart(today))
  const [sel, setSel] = useState(today)
  const [crew, setCrew] = useState('all')
  const [open, setOpen] = useState({})
  const [over, setOver] = useState('')
  const actions = jobActions(run, say, openFlight)
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

// ---------------------------------------------------------------------------
// Flight log on Done (drone jobs): saves the application record + logbook entry
// (functions/sprayRecords.js). The server adds the weather at the field pin, the products and EPA
// numbers from AgWorld, and the pilot's license / FAA numbers and the drone's registration.
// ---------------------------------------------------------------------------
const hhmm = (d) => String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
// initial: an existing record's values (Reports > Correct); askReason: a correction needs a reason.
function FlightForm({ job, me, pilots, drones, onSave, onClose, initial, askReason, title }) {
  const now = new Date()
  const firstPilot = (job.operator && pilots.find((p) => normName(p.name) === normName(job.operator))) ||
    (me && pilots.find((p) => normName(p.name) === normName(me))) || (pilots.length === 1 ? pilots[0] : null)
  // The drone is picked for each job (pilots switch drones), so it starts blank.
  const [f, setF] = useState(Object.assign({
    pilot: firstPilot ? firstPilot.name : '', drone: '', date: todayYmd(),
    start: hhmm(new Date(now.getTime() - 2 * 3600000)), end: hhmm(now), flights: '', acres: String(job.acres || ''), notes: '', reason: ''
  }, initial || {}))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const set = (k) => (e) => { const v = e.target.value; setF((x) => Object.assign({}, x, { [k]: v })) }
  const save = async (e) => {
    e.preventDefault(); setErr(''); setBusy(true)
    try { await onSave(Object.assign({}, f, { flights: Number(f.flights), acres: Number(f.acres) })); onClose() }
    catch (x) { setErr(x.message || String(x)) }
    setBusy(false)
  }
  const products = Array.isArray(job.product_detail) ? job.product_detail : []
  const listed = (arr, v) => !v || arr.some((x) => x.name === v)
  return (
    // On document.body so it covers the whole screen (theme.css dark mode filters the page, which
    // would pin a fixed box to the Spray area); class "spray" brings Spray's colours along.
    createPortal(<div className="spray spray-modal" onClick={onClose}>
      <form className="spray-modal-box" onClick={(e) => e.stopPropagation()} onSubmit={save}>
        <div className="spray-field" style={{ fontSize: 22 }}>{cropEmoji(job.crop)} {job.field}</div>
        <div className="spray-muted">{[title || 'Flight log', job.acres ? (Number(job.acres) || 0).toLocaleString() + ' ac on the job' : '', job.farm].filter(Boolean).join(' · ')}</div>
        <div className="spray-form" style={{ marginTop: 10 }}>
          <label>Pilot<select value={f.pilot} onChange={set('pilot')} required>
            <option value="">{pilots.length ? 'Pick the pilot' : 'No drone pilots on the Operators tab'}</option>
            {!listed(pilots, f.pilot) && <option value={f.pilot}>{f.pilot}</option>}
            {pilots.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
          </select></label>
          <label>Drone flown<select value={f.drone} onChange={set('drone')} required>
            <option value="">{drones.length ? 'Pick the drone' : 'No drones on the Drones tab'}</option>
            {!listed(drones, f.drone) && <option value={f.drone}>{f.drone}</option>}
            {drones.map((d) => <option key={d.name} value={d.name}>{d.name}{d.model ? ' · ' + d.model : ''}</option>)}
          </select></label>
          <label>Date flown<input type="date" value={f.date} max={todayYmd()} onChange={set('date')} required /></label>
          <label>Started<input type="time" value={f.start} onChange={set('start')} required /></label>
          <label>Finished<input type="time" value={f.end} onChange={set('end')} required /></label>
          <label>Flights<input type="number" min="1" max="300" inputMode="numeric" placeholder="battery sets flown" value={f.flights} onChange={set('flights')} required /></label>
          <label>Acres sprayed<input type="number" min="0.1" step="0.1" inputMode="decimal" value={f.acres} onChange={set('acres')} required /></label>
          <label className="wide">Notes <span className="spray-muted">(optional: skipped areas, drift concerns, buffer zones…)</span><input value={f.notes} onChange={set('notes')} maxLength={500} /></label>
          {askReason && <label className="wide">Why it's being corrected <span className="spray-muted">(kept in the record's history)</span><input value={f.reason} onChange={set('reason')} minLength={4} maxLength={300} required /></label>}
        </div>
        {(() => { const p = pilots.find((x) => x.name === f.pilot)
          const dues = p ? (p.dues || []).filter((r) => r.due < f.date) : []
          return dues.length ? <div className="spray-error" style={{ marginTop: 6 }}>⚠ {p.name}: {dues.map((r) => r.label + ' ran out ' + fmtDay(r.due)).join(', ')}. The record will be flagged.</div> : null })()}
        {!initial && <div className="spray-muted" style={{ marginTop: 8 }}>
          Saved with the record automatically: the weather at the field for the hours flown, {products.length ? products.map((p) => p.name + (p.rate ? ' ' + p.rate : '')).join(', ') : 'the products'} from AgWorld with EPA numbers and amounts, the pilot's license and FAA numbers, and the drone's registration.
        </div>}
        {err && <div className="spray-error" style={{ marginTop: 8 }}>{err}</div>}
        <div className="spray-row" style={{ marginTop: 12 }}>
          <button type="submit" className="save" disabled={busy}>{busy ? 'Saving…' : initial ? 'Save correction' : job.done ? 'Save flight log' : 'Save & mark done'}</button>
          <button type="button" disabled={busy} onClick={onClose}>Cancel</button>
        </div>
      </form>
    </div>, document.body)
  )
}

// ---------------------------------------------------------------------------
// Reports tab (Spray admins): State (Idaho application records) and FAA (Part 137 records,
// pilot logbooks, drone logbooks), built from the saved flight records (functions/sprayRecords.js).
// Laid out as printed reports; Print gives a clean paper copy for an inspector.
// ---------------------------------------------------------------------------
const hrs = (min) => (Math.round((Number(min) || 0) / 6) / 10).toFixed(1)
const sum = (list, k) => list.reduce((t, r) => t + (Number(r[k]) || 0), 0)
const acresTxt = (n) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString()
const t12 = (hm) => { if (!hm) return ''; const [h, m] = hm.split(':').map(Number); return ((h + 11) % 12 + 1) + ':' + String(m).padStart(2, '0') + (h < 12 ? ' am' : ' pm') }
// weather on a record: the range over the hours sprayed (older records have a single reading)
const windTxt = (w) => (!w || !w.ok ? 'not recorded' : (w.wind_low_mph != null && w.wind_low_mph !== w.wind_mph ? w.wind_low_mph + '–' : '') + w.wind_mph + ' mph from ' + w.dir +
  (w.gust_mph != null ? ' (gusts ' + w.gust_mph + ')' : '') + (w.window ? ' · ' + w.window.split('–').map(t12).join('–') : ''))
const tempTxt = (w) => (!w || !w.ok ? '—' : (w.temp_low_f != null && w.temp_low_f !== w.temp_f ? w.temp_low_f + '–' : '') + w.temp_f + '°F · ' +
  (w.humidity_high_pct != null && w.humidity_high_pct !== w.humidity_pct ? w.humidity_pct + '–' + w.humidity_high_pct : w.humidity_pct) + '% humidity')
const hoursTxt = (w) => (w && w.hours && w.hours.length > 1 ? w.hours.map((h) => t12(h.t) + ' ' + h.wind + (h.gust != null ? 'g' + h.gust : '') + ' ' + h.dir).join(' · ') : '')
const money = (n) => '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 })
const longDay = (ymd) => (ymd ? new Date(ymd + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '')

function Reports({ run, say, pilots, drones, chiefs }) {
  const yr = todayYmd().slice(0, 4)
  const [from, setFrom] = useState(yr + '-01-01')
  const [to, setTo] = useState(todayYmd())
  // Records by year (Idaho keeps 2 years, FAA 12 months; nothing here is ever deleted)
  const yearSel = /^\d{4}-01-01$/.test(from) && (to === from.slice(0, 4) + '-12-31' || (from.slice(0, 4) === yr && to === todayYmd())) ? from.slice(0, 4) : 'custom'
  const pickYear = (y) => { if (y === 'custom') return; setFrom(y + '-01-01'); setTo(y === yr ? todayYmd() : y + '-12-31') }
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [section, setSection] = useState('state')   // state | faa
  const [faa, setFaa] = useState('ops')              // ops | pilots | drones
  const [pilot, setPilot] = useState('')
  const [drone, setDrone] = useState('')
  const [showVoid, setShowVoid] = useState(false)
  const [bookPilot, setBookPilot] = useState('')    // the one pilot (or drone) whose logbook is showing
  const [bookDrone, setBookDrone] = useState('')
  const [gOp, setGOp] = useState('')
  const [form, setForm] = useState(null)              // { job, initial?, save }
  const [hist, setHist] = useState({})
  const load = async () => {
    setBusy(true)
    try { setData(await run({ action: 'listFlights', from, to })) } catch (e) { /* shown */ }
    setBusy(false)
  }
  useEffect(() => { load() }, [from, to])
  const all = (data && data.flights) || []
  // in a logbook view, the logbook picker chooses the pilot / drone instead of the filter
  const usePilot = section === 'faa' && faa === 'pilots' ? '' : pilot, useDrone = section === 'faa' && faa === 'drones' ? '' : drone
  const recs = all.filter((r) => (showVoid || r.status !== 'void') && (!usePilot || r.pilot.name === usePilot) && (!useDrone || r.drone.name === useDrone))
  const live = recs.filter((r) => r.status !== 'void')
  const co = (data && data.company) || { name: 'JK Farms', address: '20511 F Street, Rupert, ID 83350' }
  const period = longDay(from) + ' – ' + longDay(to)
  const pilotNames = [...new Set(all.map((r) => r.pilot.name))].sort()
  const droneNames = [...new Set(all.map((r) => r.drone.name))].sort()
  const activeDrones = drones.filter((d) => d.active !== false)

  const correct = (r) => setForm({
    job: { field: r.site.field, farm: r.site.farm, crop: r.site.crop, acres: r.job_acres },
    initial: { pilot: r.pilot.name, drone: r.drone.name, date: r.date, start: r.start, end: r.end, flights: String(r.flights), acres: String(r.acres), notes: r.notes || '' },
    save: async (f) => { const x = await run({ action: 'editFlight', id: r.id, reason: f.reason, changes: { pilot: f.pilot, drone: f.drone, date: f.date, start: f.start, end: f.end, flights: f.flights, acres: f.acres, notes: f.notes } }); say(x.unchanged ? 'Nothing changed' : 'Record corrected'); await load() }
  })
  const voidIt = async (r) => {
    const why = window.prompt('Void the ' + r.site.field + ' record from ' + longDay(r.date) + '? It stays on file, marked void. Why?')
    if (!why) return
    try { await run({ action: 'voidFlight', id: r.id, reason: why }); say('Record voided'); await load() } catch (e) { /* shown */ }
  }
  const addLog = (u) => setForm({
    job: { field: u.field, farm: u.farm, crop: u.crop, acres: u.acres, product_detail: u.product_detail, operator: u.operator, done: true },
    save: async (f) => { const x = await run({ action: 'logFlight', jobKey: u.job_key, flight: f }); say('Flight log saved' + (x.missing && x.missing.length ? ' · missing: ' + x.missing.join(', ') : '')); await load() }
  })

  const Head = ({ title, sub }) => (
    <div className="rp-head">
      <div><div className="rp-co">{co.name}</div><div className="rp-addr">{co.address}</div></div>
      <div className="rp-title"><b>{title}</b><div>{sub}</div><div>{period}{usePilot ? ' · pilot ' + usePilot : ''}{useDrone ? ' · drone ' + useDrone : ''}</div></div>
    </div>
  )
  const Missing = ({ r }) => (r.missing && r.missing.length ? <div className="rp-miss">Missing: {r.missing.join(', ')}</div> : null)
  const Tools = ({ r }) => (
    <div className="rp-tools no-print">
      <button onClick={() => setHist((h) => Object.assign({}, h, { [r.id]: !h[r.id] }))}>History ({(r.history || []).length})</button>
      {r.status !== 'void' && <button onClick={() => correct(r)}>Correct</button>}
      {r.status !== 'void' && <button className="spray-danger" onClick={() => voidIt(r)}>Void</button>}
    </div>
  )
  const History = ({ r }) => (hist[r.id] ? (
    <div className="rp-hist">
      {(r.history || []).map((h, i) => (
        <div key={i}>{new Date(h.at).toLocaleString()} · {h.by} · {h.what}{h.reason ? ' — ' + h.reason : ''}
          {h.changes ? ' (' + Object.keys(h.changes).map((k) => k + ': ' + h.changes[k][0] + ' → ' + h.changes[k][1]).join('; ') + ')' : ''}</div>
      ))}
    </div>) : null)
  const Foot = ({ r }) => <div className="rp-foot">Record {r.id} · entered by {r.entered_by} ({r.entered_via}) {r.entered_at ? new Date(r.entered_at).toLocaleString() : ''}{(r.history || []).length > 1 ? ' · corrected ' + (r.history.length - 1) + '×' : ''}</div>

  // ---- State: one Idaho application record per flight log ----
  const StateReport = () => (
    <div className="rp">
      <Head title="Pesticide Application Records" sub="Idaho · IDAPA 02.03.03 · keep 2 years" />
      <div className="rp-sum">{live.length} application{live.length === 1 ? '' : 's'} · {acresTxt(sum(live, 'acres'))} acres treated · method: aerial, unmanned aircraft (drone)</div>
      {recs.map((r) => (
        <div className={'rp-rec' + (r.status === 'void' ? ' void' : '')} key={r.id}>
          <div className="rp-rechead"><b>{longDay(r.date)} · {r.site.field}</b><span>{r.site.farm}{r.status === 'void' ? ' · VOID: ' + ((r.void && r.void.reason) || '') : ''}</span></div>
          <div className="rp-grid">
            <div><i>Applied for</i>{r.applied_for.name}, {r.applied_for.address}{r.applied_for.farm ? ' (' + r.applied_for.farm + ')' : ''}</div>
            <div><i>Crop / site</i>{r.site.crop || '—'}</div>
            <div><i>Location</i>{r.site.field}{r.site.farm ? ', ' + r.site.farm : ''}{r.site.lat != null ? ' · ' + Number(r.site.lat).toFixed(5) + ', ' + Number(r.site.lng).toFixed(5) : ''}</div>
            <div><i>Size treated</i>{acresTxt(r.acres)} ac{r.job_acres && r.job_acres !== r.acres ? ' (of ' + acresTxt(r.job_acres) + ' ac)' : ''}</div>
            <div><i>Date &amp; time</i>{longDay(r.date)}, {t12(r.start)} – {t12(r.end)}</div>
            <div><i>Wind</i>{windTxt(r.weather)}</div>
            <div><i>Temp / humidity</i>{tempTxt(r.weather)}</div>
            <div><i>Applicator</i>{r.pilot.name} · {r.pilot.license_type || 'Idaho license'} #{r.pilot.license_no || '—'}{r.pilot.license_cats ? ' (' + r.pilot.license_cats + ')' : ''}</div>
            {r.pilot.supervisor && <div><i>Supervisor</i>{r.pilot.supervisor}</div>}
            <div><i>Equipment</i>{r.drone.name} · {[r.drone.make, r.drone.model].filter(Boolean).join(' ')}{r.drone.faa_reg ? ' · FAA ' + r.drone.faa_reg : ''}</div>
          </div>
          <table className="rp-tbl">
            <thead><tr><th>Brand name</th><th>EPA reg. no.</th><th>Rate</th><th>Total applied</th></tr></thead>
            <tbody>{(r.products || []).length ? r.products.map((p, i) => <tr key={i}><td>{p.name}</td><td>{p.epa_reg_no || '—'}</td><td>{p.rate || '—'}</td><td>{p.total_applied || '—'}</td></tr>)
              : <tr><td colSpan={4}>No products on the AgWorld job</td></tr>}</tbody>
          </table>
          {r.weather && r.weather.ok && <div className="rp-note">Weather: {r.weather.source}, pulled {new Date(r.weather.stamped_at).toLocaleString()}{hoursTxt(r.weather) ? ' · by hour (mph): ' + hoursTxt(r.weather) : ''}</div>}
          {r.notes && <div className="rp-note">Notes: {r.notes}</div>}
          <Missing r={r} /><Foot r={r} /><Tools r={r} /><History r={r} />
        </div>
      ))}
      {!recs.length && <div className="rp-empty">No flight records in this period.</div>}
    </div>
  )

  // ---- FAA: 14 CFR 137.71 operations record + pilot roster ----
  const roster = [...new Map(live.map((r) => [r.pilot.name, r.pilot])).values()]
  const OpsReport = () => (
    <div className="rp">
      <Head title="Agricultural Aircraft Operator Records" sub="14 CFR 137.71 · keep 12 months or more" />
      <div className="rp-sum">Chief supervisor: {(chiefs || []).length ? chiefs.map((c) => c.name + (c.faa_cert ? ' (FAA ' + c.faa_cert + (c.part137_date ? ', 137.19(e) ' + longDay(c.part137_date) : '') + ')' : '')).join('; ') : <span className="rp-miss">not set (Operators › Drone pilots)</span>}</div>
      <div className="rp-sec">Pilots</div>
      <table className="rp-tbl">
        <thead><tr><th>Name</th><th>Address</th><th>FAA certificate #</th><th>137.19(e) date</th></tr></thead>
        <tbody>{roster.map((p) => <tr key={p.name}><td>{p.name}</td><td>{p.address}</td><td>{p.faa_cert || '—'}</td><td>{p.part137_date ? longDay(p.part137_date) : '—'}</td></tr>)}</tbody>
      </table>
      <div className="rp-sec">Operations ({live.length})</div>
      <table className="rp-tbl">
        <thead><tr><th>Date</th><th>Customer</th><th>Field</th><th>Material &amp; quantity</th><th>Pilot</th><th>Aircraft</th></tr></thead>
        <tbody>{recs.map((r) => (
          <tr key={r.id} className={r.status === 'void' ? 'void' : ''}>
            <td>{longDay(r.date)}</td><td>{r.applied_for.name}<div className="rp-small">{r.applied_for.address}</div></td>
            <td>{r.site.field}<div className="rp-small">{r.site.farm} · {acresTxt(r.acres)} ac</div></td>
            <td>{(r.products || []).map((p, i) => <div key={i}>{p.name}: {p.total_applied || '—'}</div>)}</td>
            <td>{r.pilot.name}</td><td>{r.drone.name}<div className="rp-small">{r.drone.faa_reg || 'no FAA reg'}</div></td>
          </tr>))}</tbody>
      </table>
      {!recs.length && <div className="rp-empty">No flight records in this period.</div>}
    </div>
  )

  // ---- FAA: logbooks, one person's (or one drone's) book at a time, totals up top ----
  const Logbook = ({ kind }) => {
    const key = (r) => (kind === 'pilot' ? r.pilot.name : r.drone.name)
    const names = [...new Set(recs.map(key))].sort()
    const pick = kind === 'pilot' ? bookPilot : bookDrone
    const shown = names.indexOf(pick) >= 0 ? pick : names[0]
    return (
      <>
      {names.length > 0 && <div className="rp-pick no-print">
        <span>{kind === 'pilot' ? 'Logbook for' : 'Drone'}</span>
        <select value={shown} onChange={(e) => (kind === 'pilot' ? setBookPilot : setBookDrone)(e.target.value)}>
          {names.map((n) => <option key={n}>{n}</option>)}
        </select>
      </div>}
      <div className="rp">
        {names.filter((n) => n === shown).map((n) => {
          const rows = recs.filter((r) => key(r) === n), ok = rows.filter((r) => r.status !== 'void')
          const who = rows[rows.length - 1]
          const dInfo = drones.find((d) => d.name === n) || {}
          return (
            <div className="rp-book" key={n}>
              <Head title={kind === 'pilot' ? 'Pilot Logbook' : 'Aircraft Logbook'} sub={kind === 'pilot'
                ? n + ' · FAA ' + (who.pilot.faa_cert || '—') + ' · Part 137 ' + (who.pilot.part137_date ? longDay(who.pilot.part137_date) : '—') + ' · ID ' + (who.pilot.license_no || '—')
                : n + ' · ' + [who.drone.make, who.drone.model].filter(Boolean).join(' ') + ' · FAA ' + (who.drone.faa_reg || '—') + (who.drone.serial ? ' · S/N ' + who.drone.serial : '')} />
              <div className="rp-totals">
                <div><b>{new Set(ok.map((r) => r.date)).size}</b>days</div>
                <div><b>{ok.length}</b>jobs</div>
                <div><b>{sum(ok, 'flights')}</b>flights</div>
                <div><b>{hrs(sum(ok, 'minutes'))}</b>hours</div>
                <div><b>{acresTxt(sum(ok, 'acres'))}</b>acres</div>
                {kind === 'drone' && dInfo.acres_total != null && <div><b>{acresTxt(dInfo.acres_total)}</b>lifetime acres</div>}
              </div>
              <table className="rp-tbl">
                <thead><tr><th>Date</th><th>Field</th><th>{kind === 'pilot' ? 'Aircraft' : 'Pilot'}</th><th>Time</th><th>Hrs</th><th>Flights</th><th>Acres</th><th>Notes</th></tr></thead>
                <tbody>{rows.map((r) => (
                  <tr key={r.id} className={r.status === 'void' ? 'void' : ''}>
                    <td>{longDay(r.date)}</td><td>{r.site.field}<div className="rp-small">{r.site.farm}</div></td>
                    <td>{kind === 'pilot' ? r.drone.name + (r.drone.faa_reg ? ' · ' + r.drone.faa_reg : '') : r.pilot.name}</td>
                    <td>{t12(r.start)}–{t12(r.end)}</td><td>{hrs(r.minutes)}</td><td>{r.flights}</td><td>{acresTxt(r.acres)}</td>
                    <td>{r.status === 'void' ? 'VOID' : r.notes || ''}</td>
                  </tr>))}
                  <tr className="rp-tot"><td colSpan={4}>Totals this period</td><td>{hrs(sum(ok, 'minutes'))}</td><td>{sum(ok, 'flights')}</td><td>{acresTxt(sum(ok, 'acres'))}</td><td></td></tr>
                </tbody>
              </table>
              {kind === 'drone' && (() => {
                const ml = ((data && data.maint) || []).filter((m) => m.drone === n && (showVoid || m.status !== 'void'))
                return <>
                  <div className="rp-sec">Maintenance ({ml.filter((m) => m.status !== 'void').length})</div>
                  {ml.length ? <table className="rp-tbl">
                    <thead><tr><th>Date</th><th>Type</th><th>What was done</th><th>By</th><th>Cost</th></tr></thead>
                    <tbody>{ml.slice().reverse().map((m) => <tr key={m.id} className={m.status === 'void' ? 'void' : ''}><td>{longDay(m.date)}</td><td>{m.kind}</td><td>{m.what}</td><td>{m.by}</td><td>{m.cost != null ? money(m.cost) : ''}</td></tr>)}</tbody>
                  </table> : <div className="rp-empty">No maintenance logged in this period.</div>}
                </>
              })()}
              <div className="rp-sign">Reviewed by ______________________ &nbsp; Date __________</div>
            </div>
          )
        })}
        {!names.length && <div className="rp-empty">No flight records in this period.</div>}
      </div>
      </>
    )
  }

  // ---- State: Ag Rows (ground) records, one per job; acres by operator up top ----
  const [crewSec, setCrewSec] = useState('drone')   // State reports: drone | ground
  const [gdata, setGdata] = useState(null)
  const loadG = async () => { try { setGdata(await run({ action: 'listGround', from, to })) } catch (e) { /* shown */ } }
  useEffect(() => { if (section === 'state' && crewSec === 'ground') loadG() }, [from, to, section, crewSec])
  const voidG = async (r) => {
    const why = window.prompt('Void the ' + r.site.field + ' record from ' + longDay(r.date) + '? It stays on file, marked void. Why?')
    if (!why) return
    try { await run({ action: 'voidGround', jobKey: r.job_key, reason: why }); say('Record voided'); await loadG() } catch (e) { /* shown */ }
  }
  const GroundReport = () => {
    const all2 = (gdata && gdata.records) || []
    const opNames = [...new Set(all2.map((r) => r.operator.name || '(nobody assigned)'))].sort()
    const gr = all2.filter((r) => (showVoid || r.status !== 'void') && (!gOp || (r.operator.name || '(nobody assigned)') === gOp))
    const live2 = gr.filter((r) => r.status !== 'void')
    const acresOf = (r) => (r.agworld && r.agworld.acres != null ? Number(r.agworld.acres) : Number(r.acres) || 0)
    const byOp = {}
    live2.forEach((r) => { const k = r.operator.name || '(nobody assigned)'; const o = byOp[k] = byOp[k] || { jobs: 0, acres: 0, gallons: 0, spray: 0, spread: 0 }; o.jobs++; o.acres += acresOf(r); o.gallons += Number(r.agworld && r.agworld.gallons) || 0; if (r.job_type === 'Spread') o.spread += acresOf(r); else o.spray += acresOf(r) })
    if (!gdata) return <div className="spray-empty">Loading Ag Rows records…</div>
    return (
      <>
      <div className="rp-pick no-print"><span>Operator</span>
        <select value={gOp} onChange={(e) => setGOp(e.target.value)}><option value="">All Ag Rows</option>{opNames.map((n) => <option key={n}>{n}</option>)}</select></div>
      <div className="rp">
        <Head title="Pesticide Application Records" sub={'Idaho · IDAPA 02.03.03 · keep 2 years · Ag Rows (ground)' + (gOp ? ' · ' + gOp : '')} />
        <div className="rp-sec">Acres by operator</div>
        <table className="rp-tbl">
          <thead><tr><th>Operator</th><th>Jobs</th><th>Spray ac</th><th>Spread ac</th><th>Total ac</th><th>Gallons (AgWorld)</th></tr></thead>
          <tbody>{Object.keys(byOp).sort().map((k) => <tr key={k}><td>{k}</td><td>{byOp[k].jobs}</td><td>{acresTxt(byOp[k].spray)}</td><td>{acresTxt(byOp[k].spread)}</td><td>{acresTxt(byOp[k].acres)}</td><td>{byOp[k].gallons ? Math.round(byOp[k].gallons).toLocaleString() : '—'}</td></tr>)}
            <tr className="rp-tot"><td>Total</td><td>{live2.length}</td><td>{acresTxt(Object.values(byOp).reduce((t, o) => t + o.spray, 0))}</td><td>{acresTxt(Object.values(byOp).reduce((t, o) => t + o.spread, 0))}</td><td>{acresTxt(Object.values(byOp).reduce((t, o) => t + o.acres, 0))}</td><td>{Math.round(Object.values(byOp).reduce((t, o) => t + o.gallons, 0)).toLocaleString()}</td></tr></tbody>
        </table>
        <div className="rp-sec">Applications ({live2.length})</div>
        {gr.map((r) => (
          <div className={'rp-rec' + (r.status === 'void' ? ' void' : '')} key={r.id}>
            <div className="rp-rechead"><b>{longDay(r.date)} · {r.site.field}</b><span>{[r.job_type === 'Spread' ? 'Spread' : 'Spray', r.site.farm, r.status === 'void' ? 'VOID: ' + ((r.void && r.void.reason) || '') : ''].filter(Boolean).join(' · ')}</span></div>
            <div className="rp-grid">
              <div><i>Applied for</i>{r.applied_for.name}, {r.applied_for.address}{r.applied_for.farm ? ' (' + r.applied_for.farm + ')' : ''}</div>
              <div><i>Crop / site</i>{r.site.crop || '—'}</div>
              <div><i>Location</i>{r.site.field}{r.site.farm ? ', ' + r.site.farm : ''}{r.site.lat != null ? ' · ' + Number(r.site.lat).toFixed(5) + ', ' + Number(r.site.lng).toFixed(5) : ''}</div>
              <div><i>Size treated</i>{acresTxt(acresOf(r))} ac{r.agworld && r.agworld.acres != null ? ' (AgWorld actual)' : ''}</div>
              <div><i>Date &amp; time</i>{longDay(r.date)}{r.done_time ? ', done ' + t12(r.done_time) : ' · time not recorded'}</div>
              <div><i>Wind</i>{windTxt(r.weather)}</div>
              <div><i>Temp / humidity</i>{tempTxt(r.weather)}</div>
              {r.agworld && r.agworld.conditions && <div><i>Conditions in AgWorld</i>{r.agworld.conditions}</div>}
              {r.agworld && r.agworld.gallons != null && <div><i>Spray volume (AgWorld)</i>{Math.round(r.agworld.gallons).toLocaleString()} gal{r.agworld.gpa ? ' · ' + r.agworld.gpa + ' gal/ac' : ''}</div>}
              <div><i>Applicator</i>{r.operator.name || '—'} · {r.operator.license_type || 'Idaho license'} #{r.operator.license_no || '—'}{r.operator.license_cats ? ' (' + r.operator.license_cats + ')' : ''}</div>
              {r.operator.supervisor && <div><i>Supervisor</i>{r.operator.supervisor}</div>}
              <div><i>Method</i>Ground application (Ag Rows)</div>
            </div>
            <table className="rp-tbl">
              <thead><tr><th>Brand name</th><th>EPA reg. no.</th><th>Rate</th><th>Total applied</th></tr></thead>
              <tbody>{(r.products || []).length ? r.products.map((p, i) => <tr key={i}><td>{p.name}</td><td>{p.epa_reg_no || '—'}</td><td>{p.rate || '—'}</td><td>{p.total_applied || '—'}</td></tr>)
                : <tr><td colSpan={4}>No products on the AgWorld job</td></tr>}</tbody>
            </table>
            {r.weather && r.weather.ok && <div className="rp-note">Weather: {r.weather.source}, for the hour before Done{hoursTxt(r.weather) ? ' · by hour (mph): ' + hoursTxt(r.weather) : ''}</div>}
            <Missing r={r} />
            {!r.from_agworld_only && <Foot r={r} />}
            {!r.from_agworld_only && r.status !== 'void' && <div className="rp-tools no-print"><button className="spray-danger" onClick={() => voidG(r)}>Void</button></div>}
          </div>
        ))}
        {!gr.length && <div className="rp-empty">No Ag Rows records in this period.</div>}
      </div>
      </>
    )
  }

  const unlogged = (data && data.unlogged) || []
  return (
    <div>
      <div className="spray-subtabs no-print">
        <button className={section === 'state' ? 'active' : ''} onClick={() => setSection('state')}>State reports</button>
        <button className={section === 'faa' ? 'active' : ''} onClick={() => setSection('faa')}>FAA reports</button>
        <button className={section === 'archive' ? 'active' : ''} onClick={() => setSection('archive')}>Archive</button>
      </div>
      {section === 'archive' ? <ArchivePanel run={run} say={say} /> : <>
      {section === 'state' && <div className="spray-seg no-print" style={{ marginBottom: 10 }}>
        {[['drone', 'Drone'], ['ground', 'Ag Rows']].map(([k, l]) => <button key={k} className={crewSec === k ? 'active' : ''} onClick={() => setCrewSec(k)}>{l}</button>)}
      </div>}
      {section === 'faa' && <div className="spray-seg no-print" style={{ marginBottom: 10 }}>
        {[['ops', 'Part 137 records'], ['pilots', 'Pilot logbooks'], ['drones', 'Drone logbooks']].map(([k, l]) =>
          <button key={k} className={faa === k ? 'active' : ''} onClick={() => setFaa(k)}>{l}</button>)}
      </div>}
      <div className="spray-box rp-ctl no-print">
        <label>Year<select value={yearSel} onChange={(e) => pickYear(e.target.value)}>
          {[0, 1, 2, 3].map((n) => String(Number(yr) - n)).map((y) => <option key={y} value={y}>{y}</option>)}
          <option value="custom">Custom dates</option>
        </select></label>
        <label>From<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label>To<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        {!(section === 'faa' && faa === 'pilots') && !(section === 'state' && crewSec === 'ground') && <label>Pilot<select value={pilot} onChange={(e) => setPilot(e.target.value)}><option value="">All</option>{pilotNames.map((n) => <option key={n}>{n}</option>)}</select></label>}
        {!(section === 'faa' && faa === 'drones') && !(section === 'state' && crewSec === 'ground') && <label>Drone<select value={drone} onChange={(e) => setDrone(e.target.value)}><option value="">All</option>{droneNames.map((n) => <option key={n}>{n}</option>)}</select></label>}
        <label className="check"><input type="checkbox" checked={showVoid} onChange={(e) => setShowVoid(e.target.checked)} /> Show voided</label>
        <button className="save" onClick={() => window.print()}>Print / save PDF</button>
      </div>
      {unlogged.length > 0 && !(section === 'state' && crewSec === 'ground') && <div className="spray-box rp-warn no-print">
        <b>⚠ Drone jobs done with no flight log ({unlogged.length})</b>
        <div className="spray-muted">These were closed (in AgWorld or before flight logs) without a record. Add the flight log so the records are complete.</div>
        {unlogged.map((u) => (
          <div className="spray-hidden" key={u.job_key}>
            <div><b>{u.field}</b> <span className="spray-muted">{[u.farm, u.acres ? u.acres + ' ac' : '', 'done ' + fmtDay(u.completed_date), u.entered_by === 'AgWorld' ? 'closed in AgWorld' : '', u.operator].filter(Boolean).join(' · ')}</span></div>
            <button className="save" onClick={() => addLog(u)}>Add flight log</button>
          </div>))}
      </div>}
      {busy && !data ? <div className="spray-empty">Loading records…</div>
        : section === 'state' ? (crewSec === 'ground' ? <GroundReport /> : <StateReport />) : faa === 'ops' ? <OpsReport /> : <Logbook kind={faa === 'pilots' ? 'pilot' : 'drone'} />}
      </>}
      {form && <FlightForm job={form.job} pilots={pilots} drones={activeDrones} initial={form.initial} askReason={!!form.initial}
        title={form.initial ? 'Correct flight record' : 'Add flight log'} onSave={form.save} onClose={() => setForm(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Reports > Archive: frozen year-end copies of the records (functions/sprayArchive.js). Made
// automatically each January for the year before, or any time with "Archive now". Each copy is a
// readable report (opens in any browser, prints to PDF) plus the data, with a fingerprint that
// shows it hasn't been changed since it was saved. Copies are never overwritten or deleted.
// ---------------------------------------------------------------------------
function ArchivePanel({ run, say }) {
  const yr = Number(todayYmd().slice(0, 4))
  const [list, setList] = useState(null)
  const [year, setYear] = useState(String(yr - (todayYmd().slice(5) < '03-01' ? 1 : 0)))
  const [busy, setBusy] = useState('')
  const load = async () => { try { setList((await run({ action: 'listArchives' })).archives || []) } catch (e) { setList([]) } }
  useEffect(() => { load() }, [])
  const make = async () => {
    setBusy('make')
    try { const r = await run({ action: 'archiveYear', year }); setList(r.archives || []); say('Saved a copy of the ' + year + ' records.') } catch (e) { /* shown */ }
    setBusy('')
  }
  const get = async (a, which) => {
    setBusy(a.id + which)
    try {
      const r = await run({ action: 'getArchiveFile', id: a.id, which })
      const url = URL.createObjectURL(new Blob([r.text], { type: r.type }))
      if (which === 'html') window.open(url, '_blank')
      const link = document.createElement('a'); link.href = url; link.download = r.name; document.body.appendChild(link); link.click(); link.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60000)
      say(r.unchanged ? r.name + ': fingerprint matches, unchanged since it was saved.' : '⚠ ' + r.name + ' doesn\'t match the fingerprint saved with it.')
    } catch (e) { /* shown */ }
    setBusy('')
  }
  const kb = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB')
  const when = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
  return (
    <div>
      <div className="spray-box">
        <b>Year-end archive</b>
        <div className="spray-muted" style={{ margin: '4px 0 8px' }}>A frozen copy of a year's drone and Ag Rows application records, Part 137 records, pilot and drone logbooks and maintenance, kept apart from the live data. AIO saves one on its own each January for the year before. Copies are never changed or deleted; archiving again adds a new copy.</div>
        <div className="rp-ctl">
          <label>Year<select value={year} onChange={(e) => setYear(e.target.value)}>{[0, 1, 2, 3].map((n) => String(yr - n)).map((y) => <option key={y}>{y}</option>)}</select></label>
          <button className="save" disabled={!!busy} onClick={make}>{busy === 'make' ? 'Saving…' : 'Archive now'}</button>
        </div>
      </div>
      {list == null ? <div className="spray-empty">Loading archives…</div>
        : !list.length ? <div className="spray-empty">No archives yet. The first one saves itself in January, or use Archive now.</div>
          : list.map((a) => (
            <div className="spray-box spray-arc" key={a.id}>
              <div><b>{a.year} records</b> <span className="spray-muted">· saved {when(a.at)} · {a.kind === 'auto' ? 'automatic' : 'by ' + a.by}</span></div>
              <div className="spray-muted">{a.counts.drone} drone · {a.counts.ground} Ag Rows{a.counts.voided ? ' · ' + a.counts.voided + ' voided' : ''}{a.counts.unlogged ? ' · ⚠ ' + a.counts.unlogged + ' drone job' + (a.counts.unlogged === 1 ? '' : 's') + ' with no flight log' : ''}</div>
              <div className="spray-arc-btns">
                {(a.files || []).map((f) => <button key={f.which} disabled={!!busy} onClick={() => get(a, f.which)}>
                  {busy === a.id + f.which ? 'Getting…' : f.which === 'html' ? 'Open report' : 'Download data'} <span className="spray-muted">({kb(f.bytes)})</span></button>)}
              </div>
              <div className="spray-muted spray-arc-fp" title="SHA-256 fingerprint of the report file">Fingerprint {((a.files || []).find((f) => f.which === 'html') || {}).sha256}</div>
            </div>))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Costs tab (Spray admins): drone cost per acre, acres per labor hour, labor cost per hour
// (functions/sprayCosts.js). Hours are entered each Sunday for Mon–Sat; pay rates and expenses are
// kept on the server where only Spray admins reach them. Chemical isn't included.
// ---------------------------------------------------------------------------
const COST_PARTS = [
  ['labor', 'Labor', '#3987e5'], ['battery', 'Batteries', '#d95926'], ['wear', 'Drone wear', '#199e70'], ['repairs', 'Repairs', '#c98500'],
  ['fuel', 'Fuel', '#d55181'], ['fixed', 'Yearly fixed', '#0ca30c'], ['other', 'Other', '#9085e9']
]
const usd = (n, d) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }))
const lastMonday = () => { const d = new Date(todayYmd() + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) - 7); return d.toISOString().slice(0, 10) }
const shiftWeek = (w, n) => { const d = new Date(w + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10) }
const wkLabel = (w) => { const a = new Date(w + 'T12:00:00Z'), b = new Date(w + 'T12:00:00Z'); b.setUTCDate(b.getUTCDate() + 5); const f = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); return f(a) + ' – ' + f(b) }

// One small weekly line chart (one measure, one axis), with a hover readout per week.
function WeekLine({ weeks, field, fmt, axisFmt, color, title }) {
  const pts = weeks.filter((w) => w[field] != null)
  const [hov, setHov] = useState(null)
  if (pts.length < 2) return <div className="cost-chart"><div className="cost-ctitle">{title}</div><div className="spray-muted">Shows once there are two weeks with numbers.</div></div>
  const W = 520, H = 150, L = 44, R = 10, T = 12, B = 24
  const max = Math.max(...pts.map((p) => p[field])) * 1.15 || 1
  const x = (i) => L + (pts.length === 1 ? 0 : i * (W - L - R) / (pts.length - 1)), y = (v) => T + (H - T - B) * (1 - v / max)
  const ticks = [0, max / 2, max].map((v) => Math.round(v * 10) / 10)
  const line = pts.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p[field]).toFixed(1)).join(' ')
  return (
    <div className="cost-chart">
      <div className="cost-ctitle">{title}</div>
      <svg viewBox={'0 0 ' + W + ' ' + H} role="img" aria-label={title} onMouseLeave={() => setHov(null)}>
        {ticks.map((t) => <g key={t}><line x1={L} x2={W - R} y1={y(t)} y2={y(t)} className="cost-grid" /><text x={L - 6} y={y(t) + 4} textAnchor="end" className="cost-axis">{(axisFmt || fmt)(t)}</text></g>)}
        <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {pts.map((p, i) => <circle key={p.week} cx={x(i)} cy={y(p[field])} r={hov === i ? 5 : 3.5} fill={color} stroke="var(--sp-card)" strokeWidth="2" />)}
        {pts.map((p, i) => <rect key={'h' + p.week} x={x(i) - (W - L - R) / pts.length / 2} y={T} width={(W - L - R) / pts.length} height={H - T - B} fill="transparent" onMouseEnter={() => setHov(i)} onClick={() => setHov(i)} />)}
        {[0, pts.length - 1].map((i) => <text key={'x' + i} x={x(i)} y={H - 6} textAnchor={i ? 'end' : 'start'} className="cost-axis">{wkLabel(pts[i].week).split(' – ')[0]}</text>)}
        {hov != null && <line x1={x(hov)} x2={x(hov)} y1={T} y2={H - B} className="cost-cross" />}
      </svg>
      <div className="cost-hover">{hov != null ? 'Week of ' + wkLabel(pts[hov].week) + ': ' + fmt(pts[hov][field]) + ' · ' + Math.round(pts[hov].acres).toLocaleString() + ' ac' + (pts[hov].hours ? ' · ' + pts[hov].hours + ' hrs' : '') : 'Tap or hover a week'}</div>
    </div>
  )
}

function Costs({ run, say, ops }) {
  const [year, setYear] = useState(todayYmd().slice(0, 4))
  const [d, setD] = useState(null)
  const [pane, setPane] = useState('numbers')   // numbers | hours | pay | expenses
  const load = async () => { try { setD(await run({ action: 'costs', year })) } catch (e) { /* shown */ } }
  useEffect(() => { load() }, [year])
  const pilotsList = ops.filter((o) => o.crew === 'drone' && o.active !== false).map((o) => o.name)
  return (
    <div>
      <div className="spray-subtabs">
        {[['numbers', 'Numbers'], ['hours', 'Weekly hours'], ['expenses', 'Expenses'], ['pay', 'Pay rates']].map(([k, l]) =>
          <button key={k} className={pane === k ? 'active' : ''} onClick={() => setPane(k)}>{l}</button>)}
      </div>
      {pane === 'numbers' && <CostNumbers d={d} year={year} setYear={setYear} />}
      {pane === 'hours' && <WeekHours run={run} say={say} pilots={pilotsList} onSaved={load} />}
      {pane === 'expenses' && <Expenses run={run} say={say} year={year} onSaved={load} />}
      {pane === 'pay' && <PayRates run={run} say={say} pilots={pilotsList} onSaved={load} />}
    </div>
  )
}

function CostNumbers({ d, year, setYear }) {
  const yNow = Number(todayYmd().slice(0, 4))
  if (!d) return <div className="spray-empty">Loading costs…</div>
  const s = d.season
  const parts = s.parts.filter((p) => p.amount > 0)
  const maxPilotAph = Math.max(1, ...d.pilots.map((p) => p.acres_per_hour || 0))
  return (
    <div>
      <div className="spray-bar">
        <select value={year} onChange={(e) => setYear(e.target.value)}>{[yNow, yNow - 1, yNow - 2].map((y) => <option key={y}>{y}</option>)}</select>
        <span className="spray-muted">Drone crew · {s.acres.toLocaleString()} acres · {s.flights} flights · chemical not included</span>
      </div>
      <div className="cost-tiles">
        <div><b>{usd(s.cost_per_acre)}</b><span>cost per acre</span></div>
        <div><b>{s.acres_per_hour == null ? '—' : s.acres_per_hour}</b><span>acres per labor hour</span></div>
        <div><b>{usd(s.labor_per_hour)}</b><span>labor cost per hour</span></div>
        <div><b>{usd(s.total, 0)}</b><span>total cost</span></div>
      </div>
      {d.fuel_missing.length > 0 && <div className="cost-note warn">⚠ Fuel not in yet for {d.fuel_missing.map((m) => new Date(m + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })).join(', ')}: cost per acre is low until it's added (Expenses).</div>}

      <div className="spray-box">
        <div className="cost-ctitle">What makes up {usd(s.cost_per_acre)} an acre</div>
        {parts.length ? <>
          <div className="cost-stack">{parts.map((p) => { const c = COST_PARTS.find((x) => x[0] === p.key); return <i key={p.key} style={{ flexGrow: p.amount, background: c[2] }} title={c[1] + ': ' + usd(p.per_acre) + '/ac'} /> })}</div>
          <div className="cost-legend">{parts.map((p) => { const c = COST_PARTS.find((x) => x[0] === p.key); return <span key={p.key}><i style={{ background: c[2] }} />{c[1]} <b>{usd(p.per_acre)}</b><em>{usd(p.amount, 0)}</em></span> })}</div>
        </> : <div className="spray-muted">No costs yet for {year}. Enter weekly hours, pay rates and expenses.</div>}
      </div>

      <div className="cost-two">
        <WeekLine weeks={d.weeks} field="cost_per_acre" fmt={(v) => usd(v)} axisFmt={(v) => usd(v, 0)} color="#3987e5" title="Cost per acre, by week" />
        <WeekLine weeks={d.weeks} field="acres_per_hour" fmt={(v) => String(v)} color="#199e70" title="Acres per labor hour, by week" />
      </div>

      {d.flags.length > 0 && <div className="spray-box cost-flags"><div className="cost-ctitle">Worth a look</div>
        {d.flags.map((f, i) => <div key={i}>⚠ {f.week ? 'Week of ' + wkLabel(f.week) + ': ' : ''}{f.what}</div>)}</div>}

      <div className="spray-day">By pilot</div>
      <div className="spray-box cost-scroll">
        {d.pilots.length ? <table className="cost-tbl">
          <thead><tr><th>Pilot</th><th>Acres</th><th>Hours</th><th>Acres / hr</th><th className="cost-barcol" /><th>Cost / hr</th><th>Labor / ac</th></tr></thead>
          <tbody>{d.pilots.map((p) => (
            <tr key={p.name}><td>{p.name}{p.pay_type === 'salary' ? <span className="spray-muted"> · salary</span> : ''}</td><td>{Math.round(p.acres).toLocaleString()}</td><td>{p.hours || '—'}</td>
              <td><b>{p.acres_per_hour == null ? '—' : p.acres_per_hour}</b></td>
              <td className="cost-barcol"><span className="cost-hbar"><i style={{ width: ((p.acres_per_hour || 0) / maxPilotAph * 100) + '%' }} /></span></td>
              <td>{usd(p.cost_per_hour)}</td><td>{usd(p.labor_per_acre)}</td></tr>))}</tbody>
        </table> : <div className="spray-muted">No pilot hours or flights yet.</div>}
      </div>

      <div className="spray-day">By drone</div>
      <div className="spray-box cost-scroll">
        {d.drones.length ? <table className="cost-tbl">
          <thead><tr><th>Drone</th><th>Acres</th><th>Flights</th><th>Ac / flight</th><th>Batteries</th><th>Wear</th><th>Repairs</th><th>Machine $/ac</th></tr></thead>
          <tbody>{d.drones.map((x) => <tr key={x.name}><td>{x.name}</td><td>{Math.round(x.acres).toLocaleString()}</td><td>{x.flights}</td><td>{x.acres_per_flight == null ? '—' : x.acres_per_flight}</td>
            <td>{usd(x.battery, 0)}</td><td>{usd(x.wear, 0)}</td><td>{usd(x.repairs, 0)}</td><td><b>{usd(x.machine_per_acre)}</b></td></tr>)}</tbody>
        </table> : <div className="spray-muted">No flights yet.</div>}
      </div>

      <div className="spray-day">By week</div>
      <div className="spray-box cost-scroll">
        <table className="cost-tbl">
          <thead><tr><th>Week</th><th>Acres</th><th>Hours</th><th>Ac / hr</th>{COST_PARTS.map((c) => <th key={c[0]}>{c[1]}</th>)}<th>Total</th><th>$ / ac</th></tr></thead>
          <tbody>{d.weeks.slice().reverse().map((w) => <tr key={w.week}><td>{wkLabel(w.week)}{w.fuel_missing ? <span className="spray-muted"> · fuel?</span> : ''}</td><td>{Math.round(w.acres)}</td><td>{w.hours || '—'}{w.unpaid_hours ? '*' : ''}</td><td>{w.acres_per_hour == null ? '—' : w.acres_per_hour}</td>
            {COST_PARTS.map((c) => <td key={c[0]}>{w[c[0]] ? usd(w[c[0]], 0) : ''}</td>)}<td>{usd(w.total, 0)}</td><td><b>{usd(w.cost_per_acre)}</b></td></tr>)}</tbody>
        </table>
        {d.weeks.some((w) => w.unpaid_hours) && <div className="spray-muted" style={{ marginTop: 6 }}>* includes hours for someone with no pay rate yet (not in labor cost).</div>}
      </div>
      {d.notes.length > 0 && <div className="cost-note">{d.notes.map((n, i) => <div key={i}>• {n}</div>)}</div>}
      <div className="spray-muted" style={{ margin: '8px 2px' }}>How it's figured: salary ÷ {d.assumptions.salary_hours} per hour · drone purchase price ÷ {d.assumptions.wear_years} a year over that drone's acres · battery purchases over the season's acres · fuel spread over each month's acres · yearly fixed over the season's acres · repairs from the Drones tab maintenance log.</div>
    </div>
  )
}

// Sunday: last week's hours (Mon–Sat), one row per drone pilot.
function WeekHours({ run, say, pilots, onSaved }) {
  const [week, setWeek] = useState(lastMonday())
  const [rows, setRows] = useState({})
  const [pay, setPay] = useState({})
  const [busy, setBusy] = useState(false)
  const key = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 60)
  useEffect(() => { run({ action: 'getWeek', week }).then((r) => {
    const m = {}; Object.values(r.rows || {}).forEach((h) => { m[key(h.name)] = String(h.hours) }); setRows(m); setPay(r.pay || {})
  }).catch(() => {}) }, [week])
  const names = [...new Set(pilots.concat(Object.keys(rows).map((k) => (pilots.find((p) => key(p) === k)) || null).filter(Boolean)))]
  const save = async () => {
    setBusy(true)
    try { await run({ action: 'saveHours', week, rows: names.map((n) => ({ name: n, hours: rows[key(n)] == null ? '' : rows[key(n)] })) }); say('Hours saved for ' + wkLabel(week)); onSaved && onSaved() } catch (e) { /* shown */ }
    setBusy(false)
  }
  const total = names.reduce((t, n) => t + (parseFloat(rows[key(n)]) || 0), 0)
  return (
    <div className="spray-box">
      <div className="spray-bar">
        <button onClick={() => setWeek(shiftWeek(week, -1))}>‹</button>
        <b>Week of {wkLabel(week)}</b>
        <button disabled={shiftWeek(week, 1) > todayYmd()} onClick={() => setWeek(shiftWeek(week, 1))}>›</button>
        {week !== lastMonday() && <button onClick={() => setWeek(lastMonday())}>Last week</button>}
      </div>
      <div className="spray-muted" style={{ margin: '4px 0 8px' }}>Monday–Saturday hours from Paycom. For Sayger, his hours as you know them.</div>
      {names.map((n) => (
        <div className="cost-hrow" key={n}>
          <span>{n}<span className="spray-muted">{pay[key(n)] ? ' · ' + (pay[key(n)].type === 'salary' ? 'salary' : usd(pay[key(n)].rate) + '/hr') : ' · no pay rate yet'}</span></span>
          <input type="number" min="0" max="100" step="0.25" inputMode="decimal" value={rows[key(n)] == null ? '' : rows[key(n)]} placeholder="hrs"
            onChange={(e) => { const v = e.target.value; setRows((r) => Object.assign({}, r, { [key(n)]: v })) }} />
        </div>
      ))}
      {!names.length && <div className="spray-muted">Add drone pilots on the Operators tab first.</div>}
      <div className="spray-row" style={{ marginTop: 10 }}>
        <button className="save" disabled={busy || !names.length} onClick={save}>Save hours</button>
        <span className="spray-muted">{total} hrs total</span>
      </div>
    </div>
  )
}

function PayRates({ run, say, pilots, onSaved }) {
  const [pay, setPay] = useState({})
  const [f, setF] = useState(null)
  const key = (n) => String(n || '').toLowerCase().replace(/[^a-z]/g, '').slice(0, 60)
  useEffect(() => { run({ action: 'listPay' }).then((r) => setPay(r.pay || {})).catch(() => {}) }, [])
  const save = async () => {
    try { const r = await run(Object.assign({ action: 'savePay' }, f)); setPay(r.pay || {}); say('Saved ' + f.name + '\'s pay'); setF(null); onSaved && onSaved() } catch (e) { /* shown */ }
  }
  return (
    <div className="spray-box">
      <div className="spray-muted" style={{ marginBottom: 8 }}>Only Spray admins see these. Salary is figured at salary ÷ 2080 per hour of the hours you enter.</div>
      {pilots.map((n) => { const p = pay[key(n)]; const editing = f && key(f.name) === key(n)
        return (
          <div className="cost-hrow" key={n}>
            <span>{n}</span>
            {editing ? <span className="cost-payedit">
              <select value={f.type} onChange={(e) => setF(Object.assign({}, f, { type: e.target.value }))}><option value="hourly">Hourly</option><option value="salary">Salary</option></select>
              {f.type === 'hourly' ? <input type="number" min="0" step="0.25" inputMode="decimal" placeholder="$/hr" value={f.rate} onChange={(e) => setF(Object.assign({}, f, { rate: e.target.value }))} />
                : <input type="number" min="0" step="100" inputMode="decimal" placeholder="$ a year" value={f.salary} onChange={(e) => setF(Object.assign({}, f, { salary: e.target.value }))} />}
              <button className="save" onClick={save}>Save</button><button onClick={() => setF(null)}>Cancel</button>
            </span> : <span>
              <span className="spray-muted">{p ? (p.type === 'salary' ? usd(p.salary, 0) + ' a year (' + usd(p.salary / 2080) + '/hr)' : usd(p.rate) + '/hr') : 'not set'}</span>
              <button onClick={() => setF({ name: n, type: (p && p.type) || 'hourly', rate: p && p.rate != null ? String(p.rate) : '', salary: p && p.salary != null ? String(p.salary) : '' })}>{p ? 'Change' : 'Set'}</button>
            </span>}
          </div>
        ) })}
      {!pilots.length && <div className="spray-muted">Add drone pilots on the Operators tab first.</div>}
    </div>
  )
}

function Expenses({ run, say, year, onSaved }) {
  const [list, setList] = useState([])
  const blank = { kind: 'fuel', when: todayYmd().slice(0, 7), amount: '', what: '' }
  const [f, setF] = useState(blank)
  const [busy, setBusy] = useState(false)
  useEffect(() => { run({ action: 'listExpenses' }).then((r) => setList(r.expenses || [])).catch(() => {}) }, [])
  const set = (k) => (e) => { const v = e.target.value; setF((x) => Object.assign({}, x, { [k]: v }, k === 'kind' ? { when: v === 'fuel' ? todayYmd().slice(0, 7) : v === 'fixed' ? todayYmd().slice(0, 4) : todayYmd() } : {})) }
  const [droneNames, setDroneNames] = useState([])
  useEffect(() => { run({ action: 'listDrones' }).then((r) => setDroneNames((r.drones || []).map((x) => x.name))).catch(() => {}) }, [])
  const add = async () => {
    setBusy(true)
    try { const r = await run(Object.assign({ action: 'addExpense' }, f)); setList(r.expenses || []); setF(Object.assign({}, blank, { kind: f.kind, when: f.when })); say('Added'); onSaved && onSaved() } catch (e) { /* shown */ }
    setBusy(false)
  }
  const del = async (x) => {
    if (!window.confirm('Delete this expense (' + usd(x.amount) + ')?')) return
    try { const r = await run({ action: 'deleteExpense', id: x.id }); setList(r.expenses || []); onSaved && onSaved() } catch (e) { /* shown */ }
  }
  const KL = { fuel: 'Fuel', battery: 'Batteries', fixed: 'Yearly fixed', other: 'Other' }
  const whenTxt = (x) => (x.kind === 'fuel' ? new Date(x.when + '-15T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : x.kind === 'fixed' ? x.when : fmtDay(x.when))
  const shown = list.filter((x) => String(x.when).slice(0, 4) === year)
  return (
    <div>
      <div className="spray-box">
        <div className="spray-form">
          <label>Type<select value={f.kind} onChange={set('kind')}><option value="fuel">Fuel (monthly total)</option><option value="battery">Batteries bought</option><option value="fixed">Yearly fixed (insurance, fees, software…)</option><option value="other">Other (one time)</option></select></label>
          {f.kind === 'fuel' && <label>Month<input type="month" value={f.when} onChange={set('when')} /></label>}
          {f.kind === 'fixed' && <label>Year<input type="number" min="2020" max="2100" value={f.when} onChange={set('when')} /></label>}
          {(f.kind === 'other' || f.kind === 'battery') && <label>Date<input type="date" max={todayYmd()} value={f.when} onChange={set('when')} /></label>}
          {f.kind === 'battery' && <label>For drone <span className="spray-muted">(optional)</span><select value={f.drone || ''} onChange={set('drone')}><option value="">Whole fleet</option>{droneNames.map((n) => <option key={n}>{n}</option>)}</select></label>}
          <label>Amount ($)<input type="number" min="0" step="0.01" inputMode="decimal" value={f.amount} onChange={set('amount')} /></label>
          <label className="wide">What it was {(f.kind === 'fuel' || f.kind === 'battery') && <span className="spray-muted">(optional{f.kind === 'fuel' ? ", e.g. from the controller's June report" : ''})</span>}<input value={f.what} onChange={set('what')} maxLength={200}
            placeholder={f.kind === 'fixed' ? 'e.g. drone liability insurance' : f.kind === 'other' ? 'e.g. spare nozzles, trailer tires' : f.kind === 'battery' ? 'e.g. 2 x DB1560' : ''} /></label>
        </div>
        <div className="spray-row"><button className="save" disabled={busy} onClick={add}>Add expense</button></div>
        <div className="spray-muted">Repairs go on the Drones tab maintenance log, so they're counted on the right drone.</div>
      </div>
      <div className="spray-day">{year} expenses ({shown.length})</div>
      {shown.map((x) => (
        <div className="spray-hidden" key={x.id}>
          <div><b>{usd(x.amount)}</b> <span className="spray-muted">{KL[x.kind]} · {whenTxt(x)}{x.drone ? ' · ' + x.drone : ''}{x.what ? ' · ' + x.what : ''}</span></div>
          <button className="spray-danger" onClick={() => del(x)}>Delete</button>
        </div>
      ))}
      {!shown.length && <div className="spray-empty">Nothing entered for {year} yet.</div>}
    </div>
  )
}
