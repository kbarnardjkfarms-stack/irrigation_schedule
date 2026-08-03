import { useEffect, useMemo, useRef, useState, Fragment } from 'react'

import { createPortal } from 'react-dom'

import { collection, collectionGroup, doc, onSnapshot, query, setDoc, where } from 'firebase/firestore'

import { onAuthStateChanged, signOut } from 'firebase/auth'

import { auth, db } from './firebase.js'

import LiveData from './LiveData.jsx'

import Login from './Login.jsx'

import PivotIcon from './PivotIcon.jsx'

import PivotDetailPanel from './PivotDetailPanel.jsx'

const DAYS = [
  { k: 'mon', en: 'Mon' }, { k: 'tue', en: 'Tue' }, { k: 'wed', en: 'Wed' },
  { k: 'thu', en: 'Thu' }, { k: 'fri', en: 'Fri' }, { k: 'sat', en: 'Sat' }, { k: 'sun', en: 'Sun' }
]

// Alternating column shading so it's easier to track a day while scanning
// across the week: even index (Mon, Wed, Fri, Sun) vs odd index (Tue, Thu, Sat).
const DAY_TINTS = ['#C8CCD0', '#B9CCDF']
function dayTint(dayIdx) { return DAY_TINTS[dayIdx % 2] }

const BLOCKS = { am: { start: 0, end: 12, len: 12, label: 'Morning' }, pm: { start: 12, end: 24, len: 12, label: 'Evening' } }

const DEFAULT_HOUR = { am: 8, pm: 17 }

const GALLONS_PER_ACRE_INCH = 27154

const CROP_COLOR = {
  POTATO: { bg: '#D6B48C', fg: '#4A2E12' }, POTATOES: { bg: '#D6B48C', fg: '#4A2E12' },
  CORN: { bg: '#FCE9A8', fg: '#7A5C02' }, 'SWEET CORN': { bg: '#FCE9A8', fg: '#7A5C02' },
  ALFALFA: { bg: '#C0DD97', fg: '#173404' }, HAY: { bg: '#C0DD97', fg: '#173404' },
  'SUGAR BEET': { bg: '#E0D6F5', fg: '#3D2B6B' }, BEETS: { bg: '#E0D6F5', fg: '#3D2B6B' },
  FALLOW: { bg: '#E4E1D8', fg: '#5A574C' }, ONIONS: { bg: '#F4C0D1', fg: '#4B1528' },
  MINT: { bg: '#9FE1CB', fg: '#04342C' }, CARROTS: { bg: '#FAD9BB', fg: '#7A3E0A' },
  SQUASH: { bg: '#F5C98A', fg: '#6B3D02' }
}

function mondayOf(d) {
  const date = new Date(d)
  const day = date.getDay()
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day))
  date.setHours(0, 0, 0, 0)
  return date
}

function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd }

function isoDate(d) { return d.toISOString().slice(0, 10) }

function fmtShort(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }

function fmtHour(h) {
  const hr24 = ((h % 24) + 24) % 24
  const period = hr24 >= 12 ? 'pm' : 'am'
  let hr12 = Math.floor(hr24) % 12; if (hr12 === 0) hr12 = 12
  const mins = Math.round((hr24 % 1) * 60)
  return hr12 + (mins ? ':' + String(mins).padStart(2, '0') : '') + period
}

function onIntervals(events) {
  const evs = [...events].sort((a, b) => a.ts - b.ts)
  const intervals = []
  let state = false, cursor = 0, source = null
  evs.forEach((e) => {
    if (state) intervals.push({ start: cursor, end: e.ts, source })
    cursor = e.ts
    state = e.type === 'on'
    if (state) source = e
  })
  if (state) intervals.push({ start: cursor, end: 168, source })
  return intervals
}

function overlapHours(intervals, start, end) {
  let t = 0
  intervals.forEach((iv) => { t += Math.max(0, Math.min(iv.end, end) - Math.max(iv.start, start)) })
  return t
}

function findEventInBlock(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  const s = dayIdx * 24 + b.start, e = dayIdx * 24 + b.end
  return events.find((ev) => ev.ts >= s && ev.ts < e)
}

function cellHours(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  return overlapHours(onIntervals(events), dayIdx * 24 + b.start, dayIdx * 24 + b.end)
}

function cellAdditive(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  const s = dayIdx * 24 + b.start, e = dayIdx * 24 + b.end
  const iv = onIntervals(events).find((iv) => iv.start < e && iv.end > s)
  return iv && iv.source ? iv.source.additive : null
}

function cellState(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  const hrs = cellHours(events, dayIdx, shift)
  if (hrs <= 0) return 'off'
  if (hrs >= b.len - 0.01) return 'full'
  const ev = findEventInBlock(events, dayIdx, shift)
  if (ev && ev.type === 'on') return 'coming-on'
  if (ev && ev.type === 'off') return 'coming-off'
  return 'full'
}

function weeklyInches(events, gpm, acres) {
  if (!gpm || !acres) return 0
  const totalHours = overlapHours(onIntervals(events), 0, 168)
  return (gpm * totalHours * 60) / (GALLONS_PER_ACRE_INCH * acres)
}

function styleForState(state, additive) {
  let base
  if (state === 'coming-on') base = '#3B6D11'
  else if (state === 'full') base = '#185FA5'
  else if (state === 'coming-off') base = '#A32D2D'
  else return { background: '#f4f2ec', color: '#888' }
  if (additive === 'fert') return { background: `linear-gradient(135deg, ${base} 50%, #EF9F27 50%)`, color: '#fff' }
  if (additive === 'chem') return { background: `linear-gradient(135deg, ${base} 50%, #D85A30 50%)`, color: '#fff' }
  return { background: base, color: '#fff' }
}

export default function App() {
  const [user, setUser] = useState(undefined) // undefined = still checking, null = signed out
  const [userRole, setUserRole] = useState(null)
  const [page, setPage] = useState('home') // 'home' or 'irrigation' — more modules join this list later
  const [weekOffset, setWeekOffset] = useState(0)
  const [view, setView] = useState('schedule')
  const [online, setOnline] = useState(navigator.onLine)
  const [eventsByField, setEventsByField] = useState({})
  const [gpmByField, setGpmByField] = useState({})
  const [selected, setSelected] = useState(null)
  const [editingMode, setEditingMode] = useState(null)
  const [editingHour, setEditingHour] = useState(0)
  const [editingAdditive, setEditingAdditive] = useState(null)
  const [editingDisplay, setEditingDisplay] = useState('time')
  const [editingSisDegrees, setEditingSisDegrees] = useState(180)
  const [mode, setMode] = useState(null)
  const [copySourceId, setCopySourceId] = useState(null)
  const [copyTargets, setCopyTargets] = useState(new Set())
  const [eraseTargets, setEraseTargets] = useState(new Set())
  const [seasons, setSeasons] = useState([])
  const [selectedSeasonId, setSelectedSeasonId] = useState(null)
  const [farms, setFarms] = useState([])
  const [selectedFarmId, setSelectedFarmId] = useState('all')
  const [baseFieldsById, setBaseFieldsById] = useState({})
  const [seasonDataByField, setSeasonDataByField] = useState({})
  const [pivotGuidByFieldId, setPivotGuidByFieldId] = useState({})
  const [pivotsByGuid, setPivotsByGuid] = useState({})
  const [expandedPivotFieldId, setExpandedPivotFieldId] = useState(null)
  const [pivotPanelPos, setPivotPanelPos] = useState({ top: 0, left: 0 })
  const pivotDetailRef = useRef(null)

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, (u) => setUser(u))
    return () => unsub()
  }, [])

  // Close the expanded pivot detail panel when clicking anywhere outside it.
  // Clicking a pivot icon itself already stops propagation and toggles the
  // panel directly, so this only fires for clicks elsewhere on the page.
  useEffect(() => {
    if (!expandedPivotFieldId) return
    function handleClickOutside(e) {
      if (pivotDetailRef.current && !pivotDetailRef.current.contains(e.target)) {
        setExpandedPivotFieldId(null)
      }
    }
    // The panel is positioned at a fixed screen coordinate captured at click
    // time. If the page scrolls afterward, that coordinate no longer lines up
    // with the icon, so just close it rather than let it drift out of place.
    function handleScroll() {
      setExpandedPivotFieldId(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('scroll', handleScroll, true)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('scroll', handleScroll, true)
    }
  }, [expandedPivotFieldId])

  useEffect(() => {
    if (!user) { setUserRole(null); return }
    const unsub = onSnapshot(doc(db, 'users', user.uid), (snap) => {
      setUserRole(snap.exists() ? snap.data().role : null)
    })
    return () => unsub()
  }, [user])

  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const weekStart = useMemo(() => addDays(mondayOf(new Date()), weekOffset * 7), [weekOffset])
  const weekId = isoDate(weekStart)

  // NOTE: every Firestore listener below is now gated on `user` being resolved.
  // Previously these attached on mount regardless of auth state, which could race
  // ahead of Firebase Auth restoring the persisted session (especially on a cold
  // browser start). A listener that hits permission-denied because auth wasn't
  // ready yet does NOT auto-retry once auth resolves — it just sits dead until
  // something recreates it. Gating on `user` means the listener is only ever
  // created once auth is confirmed, so there's nothing stale to get stuck on.
  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(collection(db, 'weeks', weekId, 'events'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data().events || [] })
      setEventsByField(next)
    })
    return () => unsub()
  }, [user, weekId])

  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(collection(db, 'fieldSettings'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data().gpm ?? null })
      setGpmByField(next)
    })
    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(collection(db, 'seasons'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
      setSeasons(list)
      setSelectedSeasonId((prev) => {
        if (prev) return prev
        // Default to the season matching the current calendar year, not just
        // whichever season has the latest startDate — a future-dated test
        // season (e.g. 2030) would otherwise always win that sort.
        const currentYear = String(new Date().getFullYear())
        const currentSeason = list.find((s) => String(s.name) === currentYear)
        return currentSeason ? currentSeason.id : (list[0] ? list[0].id : null)
      })
    })
    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(collection(db, 'farms'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setFarms(list)
    })
    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(collection(db, 'fields'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data() })
      setBaseFieldsById(next)
    })
    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(collection(db, 'pivotFieldMapping'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.data().fieldId] = d.data().pivotGuid })
      setPivotGuidByFieldId(next)
    })
    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!user) return
    const unsub = onSnapshot(collection(db, 'pivots'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data() })
      setPivotsByGuid(next)
    })
    return () => unsub()
  }, [user])

  useEffect(() => {
    if (!user || !selectedSeasonId) return
    const q = query(collectionGroup(db, 'seasons'), where('seasonId', '==', selectedSeasonId))
    const unsub = onSnapshot(q, (snap) => {
      const next = {}
      snap.forEach((d) => {
        const fieldId = d.ref.parent.parent.id
        next[fieldId] = d.data()
      })
      setSeasonDataByField(next)
    })
    return () => unsub()
  }, [user, selectedSeasonId])

  const fields = useMemo(() => {
    return Object.entries(baseFieldsById)
      .filter(([id]) => seasonDataByField[id])
      .map(([id, base]) => {
        const seasonData = seasonDataByField[id] || {}
        return {
          id,
          fieldName: base.name,
          farmId: base.farmId,
          farmName: base.farmName,
          crop: (seasonData.cropName || '').toUpperCase(),
          acres: seasonData.acres || null
        }
      })
      .filter((f) => selectedFarmId === 'all' || String(f.farmId) === String(selectedFarmId))
      .sort((a, b) => {
        const farmCmp = (a.farmName || '').localeCompare(b.farmName || '')
        return farmCmp !== 0 ? farmCmp : (a.fieldName || '').localeCompare(b.fieldName || '')
      })
  }, [baseFieldsById, seasonDataByField, selectedFarmId])

  async function saveEvents(fieldId, events) {
    await setDoc(doc(db, 'weeks', weekId, 'events', fieldId), { events })
  }

  async function saveGpm(fieldId, gpm) {
    await setDoc(doc(db, 'fieldSettings', fieldId), { gpm }, { merge: true })
  }

  function openCell(fieldId, dayIdx, shift) {
    setSelected({ fieldId, dayIdx, shift })
    setEditingMode(null)
  }

  function startEditOn(existing) {
    setEditingMode('on')
    setEditingHour(existing && existing.type === 'on' ? existing.ts % 24 : DEFAULT_HOUR[selected.shift])
    setEditingAdditive(existing && existing.type === 'on' ? existing.additive : null)
  }

  function startEditOff(existing) {
    setEditingMode('off')
    setEditingHour(existing && existing.type === 'off' ? existing.ts % 24 : DEFAULT_HOUR[selected.shift])
    setEditingDisplay(existing && existing.type === 'off' ? existing.display || 'time' : 'time')
    setEditingSisDegrees(existing && existing.sisDegrees != null ? existing.sisDegrees : 180)
  }

  async function saveEditor() {
    const { fieldId, dayIdx, shift } = selected
    const b = BLOCKS[shift]
    const s = dayIdx * 24 + b.start, e = dayIdx * 24 + b.end
    const current = eventsByField[fieldId] || []
    const filtered = current.filter((ev) => !(ev.ts >= s && ev.ts < e))
    const newEvent = { ts: dayIdx * 24 + editingHour, type: editingMode }
    if (editingMode === 'on') newEvent.additive = editingAdditive
    if (editingMode === 'off') {
      newEvent.display = editingDisplay
      if (editingDisplay === 'sis') newEvent.sisDegrees = editingSisDegrees
    }
    await saveEvents(fieldId, [...filtered, newEvent])
    setEditingMode(null)
  }

  async function removeEvent(fieldId, ev) {
    const current = eventsByField[fieldId] || []
    await saveEvents(fieldId, current.filter((e) => e !== ev))
  }

  async function applyCopy() {
    const source = eventsByField[copySourceId] || []
    await Promise.all([...copyTargets].map((id) => saveEvents(id, source)))
    setMode(null); setCopySourceId(null); setCopyTargets(new Set())
  }

  async function applyErase() {
    await Promise.all([...eraseTargets].map((id) => saveEvents(id, [])))
    setMode(null); setEraseTargets(new Set())
  }

  const editorField = selected ? fields.find((f) => f.id === selected.fieldId) : null
  const editorExisting = selected ? findEventInBlock(eventsByField[selected.fieldId] || [], selected.dayIdx, selected.shift) : null

  async function handleSignOut() {
    await signOut(auth)
  }

  if (user === undefined) {
    return <div className="app"><p style={{ padding: '2rem' }}>Loading…</p></div>
  }

  if (!user) {
    return <Login />
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand" onClick={() => setPage('home')} style={{ cursor: 'pointer' }}>
          <h1>AIO</h1>
          <span className={`status ${online ? 'online' : 'offline'}`}>
            {online ? 'Online' : 'Offline — changes will sync automatically'}
          </span>
        </div>
        {page === 'irrigation' && (
          <div className="view-toggle">
            <button className={view === 'schedule' ? 'active' : ''} onClick={() => setView('schedule')}>Schedule</button>
            <button className={view === 'live-data' ? 'active' : ''} onClick={() => setView('live-data')}>Live Data</button>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginLeft: '10px' }}>
          <span style={{ fontSize: '13px', color: '#888' }}>{user.email}{userRole ? ` · ${userRole}` : ''}</span>
          <button onClick={handleSignOut}>Sign out</button>
        </div>
      </header>
      {page === 'home' && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, 160px)', gap: '16px', padding: '24px' }}>
          <div
            onClick={() => setPage('irrigation')}
            style={{ cursor: 'pointer', width: '160px', aspectRatio: '1 / 1', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', gap: '10px', padding: '16px', background: '#fff', border: '1px solid #ddd', borderRadius: '12px' }}
          >
            <div style={{ width: '64px', height: '64px', borderRadius: '16px', background: '#E6F1FB', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#185FA5" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2C12 2 5 10 5 15a7 7 0 0 0 14 0c0-5-7-13-7-13z" />
              </svg>
            </div>
            <div style={{ fontSize: '14px', fontWeight: 500 }}>Irrigation Schedule</div>
          </div>
        </div>
      )}
      {page === 'irrigation' && (
        <>
          {view === 'live-data' && <LiveData />}
          {view === 'schedule' && <div className="filter-bar">
            {seasons.length > 0 && (
              <select
                className="season-select"
                value={selectedSeasonId || ''}
                onChange={(e) => setSelectedSeasonId(e.target.value)}
              >
                {seasons.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
            <select
              className="farm-select"
              value={selectedFarmId}
              onChange={(e) => setSelectedFarmId(e.target.value)}
            >
              <option value="all">All farms</option>
              {farms.map((f) => (
                <option key={f.id} value={f.id}>{f.name}</option>
              ))}
            </select>
          </div>}
          {view === 'schedule' && <div className="week-nav">
            <button onClick={() => setWeekOffset((w) => w - 1)}>‹ Prev week</button>
            <span className="week-label">{fmtShort(weekStart)} – {fmtShort(addDays(weekStart, 6))}</span>
            <button onClick={() => setWeekOffset((w) => w + 1)}>Next week ›</button>
          </div>}
          {view === 'schedule' && <div className="mode-buttons">
            <button onClick={() => { setMode('copy-source'); setSelected(null) }}>Copy schedule</button>
            <button onClick={() => { setMode('erase'); setEraseTargets(new Set()); setSelected(null) }}>Erase schedules</button>
          </div>}
          {view === 'schedule' && mode === 'copy-source' && <div className="mode-bar">Tap the field whose schedule you want to copy</div>}
          {view === 'schedule' && mode === 'copy-targets' && (
            <div className="mode-bar">
              <div>Copying {fields.find((f) => f.id === copySourceId)?.fieldName}'s schedule — tap fields to select</div>
              <div className="mode-bar-actions">
                <button className="apply" disabled={copyTargets.size === 0} onClick={applyCopy}>
                  Apply to {copyTargets.size} {copyTargets.size === 1 ? 'field' : 'fields'}
                </button>
                <button className="cancel" onClick={() => { setMode(null); setCopySourceId(null); setCopyTargets(new Set()) }}>Cancel</button>
              </div>
            </div>
          )}
          {view === 'schedule' && mode === 'erase' && (
            <div className="mode-bar">
              <div>Tap fields to erase their whole week</div>
              <div className="mode-bar-actions">
                <button className="apply danger" disabled={eraseTargets.size === 0} onClick={applyErase}>
                  Erase {eraseTargets.size} {eraseTargets.size === 1 ? 'field' : 'fields'}
                </button>
                <button className="cancel" onClick={() => { setMode(null); setEraseTargets(new Set()) }}>Cancel</button>
              </div>
            </div>
          )}
          {view === 'schedule' && selected && !mode && editorField && (
            <div className="editor-panel">
              <div className="editor-header">
                <span className="editor-dot" style={{ background: dayTint(selected.dayIdx) }} />
                <div>
                  <div className="editor-field-name">{editorField.fieldName}</div>
                  <div className="editor-context">
                    {DAYS[selected.dayIdx].en} · {BLOCKS[selected.shift].label.toLowerCase()}{editingMode ? ` · turned ${editingMode}` : ''}
                  </div>
                </div>
              </div>
              {!editingMode ? (
                <div className="editor-row">
                  <button style={{ background: '#3B6D11', borderColor: '#3B6D11', color: '#fff', fontWeight: 600 }} onClick={() => startEditOn(editorExisting)}>On at…</button>
                  <button style={{ background: '#A32D2D', borderColor: '#A32D2D', color: '#fff', fontWeight: 600 }} onClick={() => startEditOff(editorExisting)}>Off at…</button>
                  {editorExisting && <button onClick={() => removeEvent(selected.fieldId, editorExisting)}>Remove</button>}
                </div>
              ) : (
                <>
                  <div className="editor-label center">Turned {editingMode} at</div>
                  <div className="stepper">
                    <button onClick={() => setEditingHour((h) => Math.max(BLOCKS[selected.shift].start, h - 0.5))}>-</button>
                    <span>{fmtHour(editingHour)}</span>
                    <button onClick={() => setEditingHour((h) => Math.min(BLOCKS[selected.shift].end, h + 0.5))}>+</button>
                  </div>
                  {editingMode === 'on' && (
                    <>
                      <div className="editor-label">Running with</div>
                      <div className="editor-row">
                        {[
                          [null, 'Just water', '#185FA5'],
                          ['fert', '+ Fert', 'linear-gradient(135deg, #185FA5 50%, #EF9F27 50%)'],
                          ['chem', '+ Chem', 'linear-gradient(135deg, #185FA5 50%, #D85A30 50%)']
                        ].map(([val, lbl, bg]) => (
                          <button
                            key={lbl}
                            style={editingAdditive === val ? { background: bg, borderColor: 'transparent', color: '#fff', fontWeight: 600 } : undefined}
                            onClick={() => setEditingAdditive(val)}
                          >{lbl}</button>
                        ))}
                      </div>
                    </>
                  )}
                  {editingMode === 'off' && (
                    <>
                      <div className="editor-label">Display</div>
                      <div className="editor-row">
                        {[['time', 'Exact time'], ['stop', 'Off at stop'], ['sis', 'Off at SIS']].map(([val, lbl]) => (
                          <button key={val} className={editingDisplay === val ? 'active' : ''} onClick={() => setEditingDisplay(val)}>{lbl}</button>
                        ))}
                      </div>
                      {editingDisplay === 'sis' && (
                        <>
                          <div className="editor-label center">Pivot degrees</div>
                          <div className="stepper">
                            <button onClick={() => setEditingSisDegrees((d) => Math.max(0, d - 5))}>-</button>
                            <span>{editingSisDegrees}°</span>
                            <button onClick={() => setEditingSisDegrees((d) => Math.min(360, d + 5))}>+</button>
                          </div>
                        </>
                      )}
                    </>
                  )}
                  <div className="editor-row">
                    <button className="save" onClick={saveEditor}>Save</button>
                    <button onClick={() => setEditingMode(null)}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}
          {view === 'schedule' && <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th className="sticky-col" rowSpan={2}>Field / crop</th>
                  {DAYS.map((d, i) => <th key={d.k} colSpan={2} className="day-head" style={{ background: dayTint(i) }}>{d.en}</th>)}
                  <th rowSpan={2} className="inches-head">Scheduled inches</th>
                </tr>
                <tr>
                  {DAYS.map((d, i) => ([
                    <th key={d.k + '-am'} className="shift-head" style={{ background: dayTint(i) }}>AM</th>,
                    <th key={d.k + '-pm'} className="shift-head" style={{ background: dayTint(i) }}>PM</th>
                  ]))}
                </tr>
              </thead>
              <tbody>
                {fields.map((field) => {
                  const events = eventsByField[field.id] || []
                  const gpm = gpmByField[field.id]
                  const color = CROP_COLOR[field.crop] || { bg: '#D3D1C7', fg: '#2C2C2A' }
                  const isSource = mode === 'copy-targets' && copySourceId === field.id
                  const isCopyTarget = mode === 'copy-targets' && copyTargets.has(field.id)
                  const isEraseTarget = mode === 'erase' && eraseTargets.has(field.id)
                  const pivotGuid = pivotGuidByFieldId[field.id]
                  const pivot = pivotGuid ? pivotsByGuid[pivotGuid] : null
                  const isPivotExpanded = expandedPivotFieldId === field.id

                  function onNameClick() {
                    if (mode === 'copy-source') { setCopySourceId(field.id); setMode('copy-targets'); setCopyTargets(new Set()); return }
                    if (mode === 'copy-targets') {
                      if (field.id === copySourceId) return
                      setCopyTargets((prev) => { const next = new Set(prev); next.has(field.id) ? next.delete(field.id) : next.add(field.id); return next })
                      return
                    }
                    if (mode === 'erase') {
                      setEraseTargets((prev) => { const next = new Set(prev); next.has(field.id) ? next.delete(field.id) : next.add(field.id); return next })
                    }
                  }

                  return (
                    <Fragment key={field.id}>
                      <tr>
                        <td className="sticky-col field-cell" style={{ background: isSource ? '#eef3ec' : isCopyTarget ? '#f5faf3' : isEraseTarget ? '#fbeaea' : undefined }} onClick={onNameClick}>
                          {(mode === 'copy-targets' && !isSource) && <span className={`checkbox ${isCopyTarget ? 'checked' : ''}`} />}
                          {mode === 'erase' && <span className={`checkbox erase ${isEraseTarget ? 'checked' : ''}`} />}
                          <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                            <PivotIcon
                              pivot={pivot}
                              size={55}
                              onClick={(e) => {
                                e.stopPropagation()
                                if (isPivotExpanded) {
                                  setExpandedPivotFieldId(null)
                                } else {
                                  const rect = e.currentTarget.getBoundingClientRect()
                                  setPivotPanelPos({ top: rect.bottom + 4, left: rect.left })
                                  setExpandedPivotFieldId(field.id)
                                }
                              }}
                            />
                            <div>
                              <div>
                                <strong>{field.fieldName}</strong>
                                {isSource && <span className="source-tag">SOURCE</span>}
                              </div>
                              <div style={{ marginTop: '4px' }}>
                                {field.crop && <span className="crop-badge" style={{ background: color.bg, color: color.fg }}>{field.crop}</span>}
                                {field.acres && <span className="acres-tag"> · {field.acres.toFixed(1)} ac</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        {DAYS.map((d, dayIdx) => (
                          ['am', 'pm'].map((shift) => {
                            const state = cellState(events, dayIdx, shift)
                            const additive = cellAdditive(events, dayIdx, shift)
                            const ev = findEventInBlock(events, dayIdx, shift)
                            const isSel = !mode && selected && selected.fieldId === field.id && selected.dayIdx === dayIdx && selected.shift === shift
                            let label = '-'
                            if (state === 'coming-off') {
                              const disp = ev.display || 'time'
                              label = disp === 'stop' ? (<><div className="tiny">OFF AT</div><div>STOP</div></>) :
                                disp === 'sis' ? (<><div className="tiny">OFF AT SIS</div><div>{ev.sisDegrees != null ? ev.sisDegrees + '°' : ''}</div></>) :
                                  (<><div className="tiny">OFF AT</div><div>{fmtHour(ev.ts % 24)}</div></>)
                            } else if (state === 'coming-on') { label = fmtHour(ev.ts % 24) }
                            else if (state === 'full') { label = '' }
                            return (
                              <td key={d.k + shift} className="cell-td" style={{ background: dayTint(dayIdx) }}>
                                <button disabled={!!mode} className={`cell-btn ${isSel ? 'selected' : ''}`} style={styleForState(state, additive)} onClick={() => openCell(field.id, dayIdx, shift)}>
                                  {label}
                                </button>
                              </td>
                            )
                          })
                        ))}
                        <td className="inches-cell">{weeklyInches(events, gpm, field.acres).toFixed(2)}</td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>}
          {view === 'schedule' && <div className="legend">
            <span><i className="swatch" style={{ background: '#3B6D11' }} />Coming on</span>
            <span><i className="swatch" style={{ background: '#185FA5' }} />On whole block</span>
            <span><i className="swatch" style={{ background: '#A32D2D' }} />Coming off</span>
            <span><i className="swatch" style={{ background: 'linear-gradient(135deg,#185FA5 50%,#EF9F27 50%)' }} />+ Fert</span>
            <span><i className="swatch" style={{ background: 'linear-gradient(135deg,#185FA5 50%,#D85A30 50%)' }} />+ Chem</span>
          </div>}
        </>
      )}
      {expandedPivotFieldId && createPortal(
        <div
          ref={pivotDetailRef}
          onClick={(e) => e.stopPropagation()}
          style={{ position: 'fixed', top: pivotPanelPos.top, left: pivotPanelPos.left, zIndex: 1000, boxShadow: '0 6px 16px rgba(0,0,0,0.12)' }}
        >
          <PivotDetailPanel pivot={pivotsByGuid[pivotGuidByFieldId[expandedPivotFieldId]]} />
        </div>,
        document.body
      )}
    </div>
  )
}
