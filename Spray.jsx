import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import {
  mergeJobs, lanes, dayLabel, inRange, todayYmd, addDays, fmtDay, kindOf, KIND_LABEL, cropEmoji,
  weatherUrl, summarizeWeather, windLevel, phoneBook, normName
} from './sprayMath.js'

// Spray schedule module (drone crew + Ag Rows) — jobs come from AgWorld through
// functions/spraySync.js. Every change goes through the sprayAct function, which
// checks the person's role; this screen only reads.
//
//   sprayJobs/{jobKey}       the job from AgWorld
//   sprayJobState/{jobKey}   assign / done / move / hidden
//   sprayOperators/{id}      the crew list (Admin keeps it in the Crew tab)

const sprayAct = httpsCallable(functions, 'sprayAct')
const syncNow = httpsCallable(functions, 'syncSprayJobsNow', { timeout: 1800000 })

const RANGES = [['today', 'Today'], ['week', '7 days'], ['all', 'All upcoming']]

export default function Spray({ userRole }) {
  const isAdmin = userRole === 'admin' || userRole === 'owner'
  const [view, setView] = useState('schedule')
  const [jobsDoc, setJobsDoc] = useState(null)
  const [states, setStates] = useState({})
  const [ops, setOps] = useState([])
  const [users, setUsers] = useState([])
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
  // Manager phone numbers for the Call button come from AIO's user list (Admins can read it).
  useEffect(() => onSnapshot(collection(db, 'users'), (snap) => {
    const a = []; snap.forEach((d) => a.push(d.data())); setUsers(a)
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
  const phones = useMemo(() => phoneBook(users), [users])

  if (error) return <div className="spray"><div className="spray-error">Couldn't load the spray schedule: {error}</div></div>
  if (!jobsDoc) return <div className="spray"><div className="spray-empty">Loading the spray schedule…</div></div>

  return (
    <div className="spray">
      <div className="spray-tabs">
        <button className={view === 'schedule' ? 'active' : ''} onClick={() => setView('schedule')}>Schedule</button>
        {isAdmin && <button className={view === 'crew' ? 'active' : ''} onClick={() => setView('crew')}>Crew</button>}
      </div>
      {view === 'schedule' && <Schedule jobs={jobs} ops={ops} phones={phones} isAdmin={isAdmin} run={run} say={say} />}
      {view === 'crew' && isAdmin && <Crew ops={ops} run={run} say={say} />}
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
function Schedule({ jobs, ops, phones, isAdmin, run, say }) {
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
  const L = lanes(openJobs)
  const counts = {
    today: openJobs.filter((j) => j.planned_date <= today).length,
    acres: Math.round(openJobs.reduce((a, j) => a + (Number(j.acres) || 0), 0))
  }

  const toggle = (k) => setOpen((o) => Object.assign({}, o, { [k]: !o[k] }))
  const actions = {
    done: async (j) => {
      await run({ action: 'done', jobKey: j.job_key })
      say('Done: ' + j.field, async () => { await run({ action: 'undo', jobKey: j.job_key }); say('Back on the schedule') })
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

      {!L.length && <div className="spray-empty">Nothing scheduled {range === 'today' ? 'today' : range === 'week' ? 'in the next 7 days' : ''}.</div>}
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
              <JobCard j={j} today={today} wx={wx[j.job_key]} phones={phones} ops={ops} isAdmin={isAdmin}
                open={!!open[j.job_key]} onToggle={() => toggle(j.job_key)} actions={actions} />
            </div>
          ))}
        </div>
      ))}

      <div className="spray-section">
        <button onClick={() => setShowDone((s) => !s)}>{showDone ? 'Hide' : 'Show'} done jobs ({doneJobs.length})</button>
      </div>
      {showDone && doneJobs.map((j) => (
        <JobCard key={j.job_key} j={j} today={today} wx={null} phones={phones} ops={ops} isAdmin={isAdmin}
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

function JobCard({ j, today, wx, phones, ops, isAdmin, open, onToggle, actions }) {
  const kind = kindOf(j)
  const phone = phones[normName(j.manager)]
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
        <div className={'spray-op' + (j.operator ? '' : ' none')}>{j.operator ? j.operator + (j.rig ? ' · ' + j.rig : '') : 'No operator yet'}</div>
        {wx && <Weather w={wx} />}
      </div>
      <div className="spray-actions">
        {j.agworld_link && <a className="spray-btn" href={j.agworld_link} target="_blank" rel="noreferrer">PDF</a>}
        {j.pin_url && <a className="spray-btn" href={j.pin_url} target="_blank" rel="noreferrer">Directions</a>}
        {phone && <a className="spray-btn" href={'tel:' + phone.replace(/[^\d+]/g, '')}>Call {String(j.manager).split(' ')[0]}</a>}
        {isAdmin && !j.done && <button className="spray-btn save" disabled={busy} onClick={guard(() => actions.done(j))}>Done</button>}
        {isAdmin && j.done && j.done.entered_by === 'App (waiting on AgWorld)' && <button className="spray-btn" disabled={busy} onClick={guard(() => actions.undo(j))}>Undo</button>}
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
  const [rig, setRig] = useState(j.rig)
  useEffect(() => { setOp(j.operator); setRig(j.rig) }, [j.operator, j.rig])
  const pick = (name) => { setOp(name); const o = crewOps.find((x) => x.name === name); if (o && o.rig) setRig(o.rig) }
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
            <select value={op} onChange={(e) => pick(e.target.value)}>
              <option value="">No operator</option>
              {op && !crewOps.some((o) => o.name === op) && <option value={op}>{op}</option>}
              {crewOps.map((o) => <option key={o.id} value={o.name}>{o.name}</option>)}
            </select>
            <input value={rig} onChange={(e) => setRig(e.target.value)} placeholder={j.source === 'drone' ? 'Drone' : 'Rig'} />
            <button className="save" disabled={busy || (op === j.operator && rig === j.rig)} onClick={guard(() => actions.assign(j, op, rig))}>Save</button>
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
  const want = jobs.filter((j) => !j.done && !j.hidden && j.lat != null && j.lng != null && j.planned_date >= today && j.planned_date <= addDays(today, 15))
  const keyOf = (j) => Number(j.lat).toFixed(2) + ',' + Number(j.lng).toFixed(2)
  const sig = want.map((j) => j.job_key + '@' + keyOf(j) + '@' + j.planned_date).join('|')
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
      want.forEach((j) => { const c = cache.current[keyOf(j)]; if (c) out[j.job_key] = summarizeWeather(c.data, j.planned_date, todayYmd()) })
      setData(out)
    }
    load()
    const t = setInterval(load, 3600000)
    return () => { alive = false; clearInterval(t) }
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps
  return data
}

// ---------------------------------------------------------------------------
// Crew list (Admin) — replaces the Operators tab of the Google sheet
// ---------------------------------------------------------------------------
function Crew({ ops, run, say }) {
  const blank = { id: '', name: '', crew: 'ground', rig: '', phone: '', aliases: '', active: true }
  const [form, setForm] = useState(blank)
  const [busy, setBusy] = useState(false)
  const set = (k) => (e) => setForm((f) => Object.assign({}, f, { [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }))
  const save = async () => {
    if (!form.name.trim()) { say('Enter a name.'); return }
    setBusy(true)
    try { await run(Object.assign({ action: 'saveOperator' }, form)); say((form.id ? 'Saved ' : 'Added ') + form.name); setForm(blank) } catch (e) { /* shown */ }
    setBusy(false)
  }
  const del = async (o) => {
    if (!window.confirm('Delete ' + o.name + ' from the crew list? Jobs already assigned keep the name.')) return
    try { await run({ action: 'deleteOperator', id: o.id }); say('Deleted ' + o.name) } catch (e) { /* shown */ }
  }
  const group = (c) => ops.filter((o) => o.crew === c)
  return (
    <div>
      <div className="spray-box">
        <b>{form.id ? 'Edit ' + form.name : 'Add someone'}</b>
        <div className="spray-form">
          <label>Name<input value={form.name} onChange={set('name')} placeholder="As it should show on jobs" /></label>
          <label>Crew<select value={form.crew} onChange={set('crew')}><option value="ground">Ag Rows</option><option value="drone">Drone</option></select></label>
          <label>{form.crew === 'drone' ? 'Usual drone' : 'Usual rig'}<input value={form.rig} onChange={set('rig')} /></label>
          <label>Phone<input value={form.phone} onChange={set('phone')} inputMode="tel" /></label>
          <label className="wide">Other spellings <span className="spray-muted">(how AgWorld or Paycom writes the name, comma-separated)</span><input value={form.aliases} onChange={set('aliases')} placeholder="e.g. Greg Burton" /></label>
          <label className="check"><input type="checkbox" checked={form.active !== false} onChange={set('active')} /> Active</label>
        </div>
        <div className="spray-row">
          <button className="save" disabled={busy} onClick={save}>{form.id ? 'Save' : 'Add'}</button>
          {form.id && <button onClick={() => setForm(blank)}>Cancel</button>}
        </div>
      </div>
      {[['drone', 'Drone crew'], ['ground', 'Ag Rows']].map(([c, label]) => (
        <div key={c}>
          <div className="spray-day">{label} ({group(c).length})</div>
          {group(c).length ? group(c).map((o) => (
            <div className={'spray-hidden' + (o.active === false ? ' off' : '')} key={o.id}>
              <div>
                <b>{o.name}</b>{o.active === false && <span className="spray-muted"> · inactive</span>}
                <div className="spray-muted">{[o.rig, o.phone, o.aliases && 'also: ' + o.aliases].filter(Boolean).join(' · ')}</div>
              </div>
              <div className="spray-row" style={{ margin: 0 }}>
                <button onClick={() => setForm(Object.assign({}, blank, o))}>Edit</button>
                <button className="spray-danger" onClick={() => del(o)}>Delete</button>
              </div>
            </div>
          )) : <div className="spray-empty">Nobody yet.</div>}
        </div>
      ))}
    </div>
  )
}
