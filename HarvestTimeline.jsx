import { useMemo, useRef, useState } from 'react'
import { DEFAULT_LIMITS, fmtDate, fmtDays, fmtN, fmtSlot, resourcesAt, slotFactor, slotInfo, weekday } from './harvestMath.js'
import { BLOCKS, CROP_TINT } from './HarvestBoard.jsx'

// Timeline: the sheet's half-day dashboard turned sideways. One row per
// team, one column per half-day. Drag a bar along its row (or onto another
// team's row) to drop it in front of whatever is running at that time.
// Click a day in the header to mark it full / partial / off (rain, Sunday,
// holiday) for every team or just one. Resource totals per half-day run
// along the bottom, red where they pass the limits in Settings.

const FACTORS = [[1, 'Full'], [0.75, '¾'], [0.5, '½'], [0.25, '¼'], [0, 'Off']]
const RES_ROWS = [
  ['trucks', '10-wheelers', 'trucks', (v) => v.toFixed(0)],
  ['pilers', 'Pilers', 'pilers'], ['generators', 'Generators', 'generators'],
  ['airSeps', 'Air seps', 'airSeps'], ['sandMachines', 'Sand machines', 'sandMachines'],
  ['bruiseSamples', 'Bruise samples', 'bruiseSamples'], ['pickers', 'Pickers', 'pickers']
]

export default function HarvestTimeline({ schedule, settings, canEdit, writes, onOpen }) {
  const [W, setW] = useState(22) // px per half-day
  const [drag, setDrag] = useState(null)
  const [drop, setDrop] = useState(null) // { teamId, pos, beforeKey }
  const [pick, setPick] = useState(null) // { slot, x }
  const [pickTeam, setPickTeam] = useState('all')
  const [showRes, setShowRes] = useState(true)
  const [dropMode, setDropMode] = useState('date') // 'date' = start on the day you drop it; 'order' = just slot it in line
  const scroller = useRef(null)

  const teams = settings.teams
  const startDate = schedule.startDate
  const range = useMemo(() => {
    let end = schedule.nowSlot + 10
    Object.values(schedule.teams).forEach((t) => t.rows.forEach((r) => { if (r.endSlot != null) end = Math.max(end, Math.ceil(r.endSlot)) }))
    end = Math.min(end + 6, 2 * 240)
    return { from: 0, to: Math.max(end, 28) }
  }, [schedule])
  const slots = []
  for (let s = range.from; s < range.to; s++) slots.push(s)
  const width = slots.length * W
  const resBySlot = useMemo(() => (showRes ? slots.map((s) => resourcesAt(schedule, s)) : []), [schedule, showRes, range.to]) // eslint-disable-line react-hooks/exhaustive-deps
  const limits = { ...DEFAULT_LIMITS, ...settings.limits }

  function posFromEvent(e, el) {
    const r = el.getBoundingClientRect()
    return (e.clientX - r.left) / W + range.from
  }
  function onRowOver(e, teamId) {
    if (!drag) return
    e.preventDefault()
    const pos = posFromEvent(e, e.currentTarget)
    if (dropMode === 'date') {
      // snap to the half-day under the pointer; it'll start there
      const slot = Math.max(0, Math.floor(pos))
      if (!drop || drop.teamId !== teamId || drop.slot !== slot) setDrop({ teamId, slot, x: slot })
      return
    }
    const rows = (schedule.teams[teamId] ? schedule.teams[teamId].rows : []).filter((r) => r.key !== drag && r.startSlot != null && r.endSlot != null)
    const before = rows.find((r) => (r.startSlot + r.endSlot) / 2 > pos)
    const beforeKey = before ? before.key : null
    const x = before ? before.startSlot : (rows.length ? rows[rows.length - 1].endSlot : schedule.nowSlot)
    if (!drop || drop.teamId !== teamId || drop.beforeKey !== beforeKey) setDrop({ teamId, beforeKey, x })
  }
  function onRowDrop(e, teamId) {
    e.preventDefault()
    if (drag && drop) {
      if (drop.slot != null) { const { date, half } = slotInfo(startDate, drop.slot); writes.placeAt(drag, teamId, date, half) }
      else writes.moveField([drag], teamId, drop.beforeKey)
    }
    setDrag(null); setDrop(null)
  }
  function setFactor(slot, value, whole) {
    const { date, half } = slotInfo(startDate, slot)
    const halves = whole ? ['AM', 'PM'] : [half]
    if (pickTeam === 'all') {
      const cal = { ...(settings.calendar || {}) }
      const day = { ...(cal[date] || {}) }
      halves.forEach((h) => { if (value == null) delete day[h]; else day[h] = value })
      if (Object.keys(day).length) cal[date] = day; else delete cal[date]
      writes.saveSettings({ calendar: cal })
    } else {
      const nextTeams = settings.teams.map((t) => {
        if (t.id !== pickTeam) return t
        const cal = { ...(t.calendar || {}) }
        const day = { ...(cal[date] || {}) }
        halves.forEach((h) => { if (value == null) delete day[h]; else day[h] = value })
        if (Object.keys(day).length) cal[date] = day; else delete cal[date]
        return { ...t, calendar: cal }
      })
      writes.saveSettings({ teams: nextTeams })
    }
    setPick(null)
  }

  const nowX = (schedule.nowSlot - range.from) * W
  return (
    <div className="yields-card harvest-timeline">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Half-day timeline</div>
          <div className="contracts-sub">Drag a bar onto a day to start it then — the fields after it follow in sequence (onto another row to change team). 📌 = held to a start date. {canEdit ? 'Click a day to mark rain / off / short days.' : ''} Hatched = off, pale = partial day.</div>
        </div>
        <div className="agronomy-filter-bar" style={{ margin: 0 }}>
          <select value={dropMode} onChange={(e) => setDropMode(e.target.value)} title="What dropping a bar does">
            <option value="date">Drop = start on that half-day</option>
            <option value="order">Drop = just put it in line</option>
          </select>
          <label className="hb-check"><input type="checkbox" checked={showRes} onChange={(e) => setShowRes(e.target.checked)} /> Resources</label>
          <select value={W} onChange={(e) => setW(Number(e.target.value))}>
            <option value={12}>Zoom: season</option><option value={22}>Zoom: weeks</option><option value={40}>Zoom: days</option>
          </select>
          <button onClick={() => { if (scroller.current) scroller.current.scrollLeft = Math.max(0, nowX - 200) }}>Today</button>
        </div>
      </div>
      <div className="ht-wrap">
        <div className="ht-labels">
          <div className="ht-head-spacer" />
          {teams.map((team) => {
            const t = schedule.teams[team.id]
            return (
              <div key={team.id} className="ht-label" style={{ borderLeftColor: team.color }}>
                <strong>{team.name}</strong>
                <span>{t ? `${Math.round(t.pct * 100)}% · ${fmtDays(t.totalDays - t.doneDays)} left` : ''}</span>
              </div>
            )
          })}
          {showRes && RES_ROWS.map(([k, l]) => <div key={k} className="ht-res-label">{l}</div>)}
        </div>
        <div className="ht-scroll" ref={scroller}>
          <div style={{ width, position: 'relative' }}>
            <div className="ht-head">
              {slots.filter((s) => s % 2 === 0).map((s) => {
                const { date } = slotInfo(startDate, s)
                const dow = weekday(date)
                return (
                  <div key={s} className={`ht-day${dow === 0 ? ' sun' : ''}`} style={{ width: 2 * W }}
                    onClick={(e) => { if (canEdit) setPick({ slot: s, x: (s - range.from) * W }) }} title={fmtDate(date, true)}>
                    {W >= 22 || date.endsWith('01') || dow === 1 ? <span>{W >= 40 ? fmtDate(date, true) : `${Number(date.slice(5, 7))}/${Number(date.slice(8))}`}</span> : null}
                  </div>
                )
              })}
            </div>
            {teams.map((team) => {
              const t = schedule.teams[team.id]
              const rows = t ? t.rows : []
              return (
                <div key={team.id} className={`ht-row${drop && drop.teamId === team.id ? ' drop-ok' : ''}`} onDragOver={(e) => onRowOver(e, team.id)} onDrop={(e) => onRowDrop(e, team.id)}>
                  {slots.map((s) => {
                    const f = slotFactor(settings, team, startDate, s)
                    const logged = t && t.loggedSlots.has(s)
                    const missed = t && !logged && s < schedule.nowSlot && s >= t.startSlot && f > 0 && t.rows.some((r) => !r.done)
                    if (f === 1 && !logged && !missed) return null
                    return <div key={s} className={`ht-cell${f === 0 ? ' off' : f < 1 ? ' part' : ''}${logged ? ' logged' : ''}${missed ? ' missed' : ''}`} style={{ left: (s - range.from) * W, width: W }} title={missed ? 'Not logged yet' : logged ? 'Logged' : ''} />
                  })}
                  {rows.map((r) => {
                    if (r.startSlot == null || r.endSlot == null) return null
                    const left = (r.startSlot - range.from) * W
                    const w = Math.max(6, (r.endSlot - r.startSlot) * W - 2)
                    const block = r.kind === 'block'
                    return (
                      <div key={r.key} className={`ht-bar ${r.status}${block ? ' block' : ''}${drag === r.key ? ' dragging' : ''}`} draggable={canEdit}
                        onDragStart={(e) => { setDrag(r.key); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', r.key) } catch { /* */ } }}
                        onDragEnd={() => { setDrag(null); setDrop(null) }}
                        onClick={() => onOpen(r.key)}
                        style={{ left, width: w, background: block ? undefined : CROP_TINT[r.crop] || '#D3D1C7', borderColor: team.color }}
                        title={`${r.pinLate ? `Wanted ${fmtSlot(startDate, r.pinSlot)} but the fields ahead run late — ` : ''}${r.name} — ${fmtSlot(startDate, r.startSlot)} → ${fmtSlot(startDate, Math.ceil(r.endSlot) - 1)} · ${fmtDays(r.days)}${block ? '' : ` · ${fmtN(r.acres)} ac`}${r.killDate ? ` · kill ${r.killDate}` : ''}`}>
                        {r.status === 'active' && <div className="ht-bar-prog" style={{ width: `${r.pct * 100}%` }} />}
                        <span>{r.status === 'done' ? '✓ ' : ''}{r.pinSlot != null ? '📌' : ''}{r.name}</span>
                        {r.killStatus === 'overdue' && <b className="ht-kill" title="Kill date passed">!</b>}
                      </div>
                    )
                  })}
                  {drop && drop.teamId === team.id && (
                    <div className="ht-drop" style={{ left: (drop.x - range.from) * W - 1 }}>
                      {drop.slot != null && <span className="ht-drop-label">Start {fmtSlot(startDate, drop.slot, true)}</span>}
                    </div>
                  )}
                  {rows.filter((r) => r.waitFrom != null && r.startSlot != null).map((r) => (
                    <div key={'w' + r.key} className="ht-wait" style={{ left: (r.waitFrom - range.from) * W, width: Math.max(2, (r.startSlot - r.waitFrom) * W) }} title={`Waiting for ${r.name} to start ${fmtSlot(startDate, r.pinSlot)}`} />
                  ))}
                </div>
              )
            })}
            {showRes && RES_ROWS.map(([k, , lk, f]) => (
              <div key={k} className="ht-res-row">
                {resBySlot.map((r, i) => {
                  const v = r[k]
                  if (!v) return null
                  const over = v > limits[lk]
                  return <div key={i} className={`ht-res${over ? ' over' : ''}`} style={{ left: i * W, width: W }} title={`${fmtSlot(startDate, slots[i])}: ${f ? f(v) : v}${over ? ` (limit ${limits[lk]})` : ''}`}>{W >= 22 ? (f ? f(v) : v) : ''}</div>
                })}
              </div>
            ))}
            {nowX >= 0 && nowX <= width && <div className="ht-now" style={{ left: nowX }} />}
            {pick && (
              <div className="ht-pick" style={{ left: Math.min(pick.x, width - 230) }} onClick={(e) => e.stopPropagation()}>
                <div className="ht-pick-title">{fmtDate(slotInfo(startDate, pick.slot).date, true)}</div>
                <select value={pickTeam} onChange={(e) => setPickTeam(e.target.value)}>
                  <option value="all">All teams</option>
                  {teams.map((t) => <option key={t.id} value={t.id}>{t.name} only</option>)}
                </select>
                {['Whole day', 'AM', 'PM'].map((lab, i) => (
                  <div key={lab} className="ht-pick-row">
                    <span>{lab}</span>
                    {FACTORS.map(([v, l]) => <button key={l} className="clear-sort-btn" onClick={() => setFactor(pick.slot + (i === 2 ? 1 : 0), v, i === 0)}>{l}</button>)}
                  </div>
                ))}
                {pickTeam !== 'all' && (
                  <div className="ht-pick-ins">
                    <div className="contracts-sub" style={{ marginTop: 0 }}>Or put a block in {teams.find((t) => t.id === pickTeam).name}’s line starting this day:</div>
                    {BLOCKS.map(([l, d]) => (
                      <button key={l} className="clear-sort-btn" onClick={() => {
                        const { date } = slotInfo(startDate, pick.slot)
                        writes.addBlock(pickTeam, l, d, writes.keyStartingFrom(pickTeam, pick.slot, null), { date, half: 'AM' }); setPick(null)
                      }}>{l}</button>
                    ))}
                  </div>
                )}
                <div className="contracts-sub" style={{ margin: '2px 0 6px' }}>Off / partial pushes everything back without splitting the line — best for rain.</div>
                <div className="ht-pick-row"><button className="clear-sort-btn" onClick={() => { setFactor(pick.slot, null, true) }}>Reset to normal</button><button className="clear-sort-btn" onClick={() => setPick(null)}>Close</button></div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
