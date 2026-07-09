import { useEffect, useMemo, useState } from 'react'
import { collection, doc, onSnapshot, setDoc } from 'firebase/firestore'
import { db } from './firebase.js'
import fields from './fields.json'

const DAYS = [
  { k: 'mon', en: 'Mon' }, { k: 'tue', en: 'Tue' }, { k: 'wed', en: 'Wed' },
  { k: 'thu', en: 'Thu' }, { k: 'fri', en: 'Fri' }, { k: 'sat', en: 'Sat' }, { k: 'sun', en: 'Sun' }
]
const BLOCKS = { am: { start: 0, end: 12, len: 12, label: 'Morning' }, pm: { start: 12, end: 24, len: 12, label: 'Evening' } }
const GALLONS_PER_ACRE_INCH = 27154
const CROP_COLOR = {
  'SWEET CORN': { bg: '#FAC775', fg: '#412402' }, POTATOES: { bg: '#F5C4B3', fg: '#4A1B0C' },
  ONIONS: { bg: '#CECBF6', fg: '#26215C' }, MINT: { bg: '#9FE1CB', fg: '#04342C' },
  HAY: { bg: '#C0DD97', fg: '#173404' }, CORN: { bg: '#FAC775', fg: '#412402' },
  CARROTS: { bg: '#F5C4B3', fg: '#4A1B0C' }, BEETS: { bg: '#F4C0D1', fg: '#4B1528' }
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
  let hr12 = hr24 % 12; if (hr12 === 0) hr12 = 12
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
  if (!gpm) return 0
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
  const [weekOffset, setWeekOffset] = useState(0)
  const [name, setName] = useState(() => localStorage.getItem('crewName') || '')
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

  useEffect(() => localStorage.setItem('crewName', name), [name])
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])

  const weekStart = useMemo(() => addDays(mondayOf(new Date()), weekOffset * 7), [weekOffset])
  const weekId = isoDate(weekStart)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'weeks', weekId, 'events'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data().events || [] })
      setEventsByField(next)
    })
    return () => unsub()
  }, [weekId])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'fieldSettings'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data().gpm ?? null })
      setGpmByField(next)
    })
    return () => unsub()
  }, [])

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
    const b = BLOCKS[selected.shift]
    setEditingMode('on')
    setEditingHour(existing && existing.type === 'on' ? existing.ts % 24 : b.start + 2)
    setEditingAdditive(existing && existing.type === 'on' ? existing.additive : null)
  }
  function startEditOff(existing) {
    const b = BLOCKS[selected.shift]
    setEditingMode('off')
    setEditingHour(existing && existing.type === 'off' ? existing.ts % 24 : b.end - 2)
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>Grindstone Irrigation</h1>
          <span className={`status ${online ? 'online' : 'offline'}`}>
            {online ? 'Online' : 'Offline — changes will sync automatically'}
          </span>
        </div>
        <input className="name-input" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
      </header>

      <div className="week-nav">
        <button onClick={() => setWeekOffset((w) => w - 1)}>‹ Prev week</button>
        <span className="week-label">{fmtShort(weekStart)} – {fmtShort(addDays(weekStart, 6))}</span>
        <button onClick={() => setWeekOffset((w) => w + 1)}>Next week ›</button>
      </div>

      <div className="mode-buttons">
        <button onClick={() => { setMode('copy-source'); setSelected(null) }}>Copy schedule</button>
        <button onClick={() => { setMode('erase'); setEraseTargets(new Set()); setSelected(null) }}>Erase schedules</button>
      </div>

      {mode === 'copy-source' && <div className="mode-bar">Tap the field whose schedule you want to copy</div>}
      {mode === 'copy-targets' && (
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
      {mode === 'erase' && (
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

      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="sticky-col" rowSpan={2}>Field / crop</th>
              {DAYS.map((d) => <th key={d.k} colSpan={2} className="day-head">{d.en}</th>)}
              <th rowSpan={2} className="inches-head">Scheduled inches</th>
            </tr>
            <tr>
              {DAYS.map((d) => ([
                <th key={d.k + '-am'} className="shift-head">AM</th>,
                <th key={d.k + '-pm'} className="shift-head">PM</th>
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
                <tr key={field.id}>
                  <td className="sticky-col field-cell" style={{ background: isSource ? '#eef3ec' : isCopyTarget ? '#f5faf3' : isEraseTarget ? '#fbeaea' : undefined }} onClick={onNameClick}>
                    {(mode === 'copy-targets' && !isSource) && <span className={`checkbox ${isCopyTarget ? 'checked' : ''}`} />}
                    {mode === 'erase' && <span className={`checkbox erase ${isEraseTarget ? 'checked' : ''}`} />}
                    <strong>{field.fieldName}</strong>
                    {isSource && <span className="source-tag">SOURCE</span>}
                    <br />
                    <span className="crop-badge" style={{ background: color.bg, color: color.fg }}>{field.crop}</span>
                    {!gpm && (
                      <span className="gpm-flag" onClick={(e) => { e.stopPropagation(); const v = prompt('Pivot GPM for ' + field.fieldName + ':'); if (v) saveGpm(field.id, Number(v)) }}>
                        SET GPM
                      </span>
                    )}
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
                        <td key={d.k + shift} className="cell-td">
                          <button disabled={!!mode} className={`cell-btn ${isSel ? 'selected' : ''}`} style={styleForState(state, additive)} onClick={() => openCell(field.id, dayIdx, shift)}>
                            {label}
                          </button>
                        </td>
                      )
                    })
                  ))}
                  <td className="inches-cell">{weeklyInches(events, gpm, field.acres).toFixed(2)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="legend">
        <span><i className="swatch" style={{ background: '#3B6D11' }} />Coming on</span>
        <span><i className="swatch" style={{ background: '#185FA5' }} />On whole block</span>
        <span><i className="swatch" style={{ background: '#A32D2D' }} />Coming off</span>
        <span><i className="swatch" style={{ background: 'linear-gradient(135deg,#185FA5 50%,#EF9F27 50%)' }} />+ Fert</span>
        <span><i className="swatch" style={{ background: 'linear-gradient(135deg,#185FA5 50%,#D85A30 50%)' }} />+ Chem</span>
      </div>

      {selected && !mode && editorField && (
        <div className="editor-panel">
          <div className="editor-title">{editorField.fieldName} · {DAYS[selected.dayIdx].en} {BLOCKS[selected.shift].label}</div>
          {!editingMode ? (
            <div className="editor-row">
              <button onClick={() => startEditOn(editorExisting)}>On at…</button>
              <button onClick={() => startEditOff(editorExisting)}>Off at…</button>
              {editorExisting && <button onClick={() => removeEvent(selected.fieldId, editorExisting)}>Remove</button>}
            </div>
          ) : (
            <>
              <div className="editor-label">Turned {editingMode} at:</div>
              <div className="stepper">
                <button onClick={() => setEditingHour((h) => Math.max(BLOCKS[selected.shift].start, h - 0.5))}>-</button>
                <span>{fmtHour(editingHour)}</span>
                <button onClick={() => setEditingHour((h) => Math.min(BLOCKS[selected.shift].end, h + 0.5))}>+</button>
              </div>

              {editingMode === 'on' && (
                <>
                  <div className="editor-label">Running with:</div>
                  <div className="editor-row">
                    {[[null, 'Just water'], ['fert', '+ Fert'], ['chem', '+ Chem']].map(([val, lbl]) => (
                      <button key={lbl} className={editingAdditive === val ? 'active' : ''} onClick={() => setEditingAdditive(val)}>{lbl}</button>
                    ))}
                  </div>
                </>
              )}

              {editingMode === 'off' && (
                <>
                  <div className="editor-label">Display:</div>
                  <div className="editor-row">
                    {[['time', 'Exact time'], ['stop', 'Off at stop'], ['sis', 'Off at SIS']].map(([val, lbl]) => (
                      <button key={val} className={editingDisplay === val ? 'active' : ''} onClick={() => setEditingDisplay(val)}>{lbl}</button>
                    ))}
                  </div>
                  {editingDisplay === 'sis' && (
                    <>
                      <div className="editor-label">Pivot degrees:</div>
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
    </div>
  )
}
