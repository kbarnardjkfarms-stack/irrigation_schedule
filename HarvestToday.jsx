import { useMemo, useState } from 'react'
import {
  allocateTrucks, currentSlot, daysBetween, fmtDate, fmtDays, fmtN, fmtSlot, isoToday, resourcesAt,
  resourceWarnings, slotFactor, slotInfo, slotOf
} from './harvestMath.js'
import { paceChip } from './Harvest.jsx'

// Today & progress — the "Goals Today" sheet plus progress logging.
//   - pick a half-day: what each team is on, its goal, trucks needed
//   - truck split across teams (exact if there are enough; otherwise up to
//     3 priority teams first, the rest evenly)
//   - log each team's half-day: full / partial / down, optional amount dug,
//     field finished. This is what drives ahead/behind and % done.
//   - kill-date and water-up reminders coming up

const WORK = [[1, 'Full'], [0.75, '¾'], [0.5, '½'], [0.25, '¼'], [0, 'Down']]

export default function HarvestToday({ schedule, settings, canEdit, writes, logs, onOpen }) {
  const startDate = schedule.startDate
  const [date, setDate] = useState(() => isoToday())
  const [half, setHalf] = useState(() => (new Date().getHours() < 12 ? 'AM' : 'PM'))
  const [available, setAvailable] = useState(null)
  const [logFor, setLogFor] = useState(null) // teamId
  const slot = slotOf(startDate, date, half)
  const res = useMemo(() => resourcesAt(schedule, slot), [schedule, slot])
  const warnings = resourceWarnings(res, settings.limits)
  const priority = settings.priorityTeams || []
  const trucksAvail = available ?? settings.limits.trucks
  const needs = {}
  // A team logged as down this half-day has no projected bar here — show
  // the field it's sitting on anyway.
  const fieldFor = (id) => res.fields[id] || (schedule.teams[id] && schedule.teams[id].loggedSlots.has(slot) ? schedule.teams[id].current : null)
  settings.teams.forEach((t) => { const f = res.fields[t.id]; if (f && f.trucks) needs[t.id] = f.trucks })
  const split = allocateTrucks(needs, trucksAvail, priority)

  const togglePriority = (id) => {
    const next = priority.includes(id) ? priority.filter((x) => x !== id) : [...priority, id].slice(-3)
    writes.saveSettings({ priorityTeams: next })
  }

  // reminders
  const today = isoToday()
  const upcoming = []
  Object.values(schedule.byKey).forEach((r) => {
    if (r.kind === 'block' || r.done || r.status === 'active') return
    if (r.killDate && !r.killed) {
      const d = daysBetween(today, r.killDate)
      if (d <= 14) upcoming.push({ r, what: 'Kill', date: r.killDate, d })
    }
    if (r.waterUpDate) {
      const d = daysBetween(today, r.waterUpDate)
      if (d >= -2 && d <= 7) upcoming.push({ r, what: 'Water-up check', date: r.waterUpDate, d })
    }
  })
  upcoming.sort((a, b) => a.date.localeCompare(b.date))

  const teamName = Object.fromEntries(settings.teams.map((t) => [t.id, t.name]))
  const recent = [...logs].sort((a, b) => `${b.date}${b.half}`.localeCompare(`${a.date}${a.half}`) || (b.at || 0) - (a.at || 0)).slice(0, 40)

  return (
    <>
      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Goals for {fmtDate(date, true)} {half}</div>
            <div className="contracts-sub">Projected field per team, goal for the half-day and 10-wheelers needed (same formula as the sheet).</div>
          </div>
          <div className="agronomy-filter-bar" style={{ margin: 0 }}>
            <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <div className="agronomy-view-toggle" style={{ margin: 0 }}>
              {['AM', 'PM'].map((h) => <button key={h} className={half === h ? 'active' : ''} onClick={() => setHalf(h)}>{h}</button>)}
            </div>
            <button onClick={() => { setDate(isoToday()); setHalf(new Date().getHours() < 12 ? 'AM' : 'PM') }}>Now</button>
            <label className="hb-check">Trucks available <input className="yields-cell-input" style={{ width: 52 }} inputMode="numeric" value={trucksAvail} onChange={(e) => setAvailable(Number(e.target.value) || 0)} /></label>
          </div>
        </div>
        {warnings.length > 0 && <div className="agronomy-error-banner" style={{ marginBottom: 8 }}>Over the limit this half-day: {warnings.join(' · ')}</div>}
        <div className="table-scroll">
          <table className="contracts-table contracts-table-auto harvest-today">
            <thead>
              <tr>
                <th>Team</th><th>Field</th><th>Destination</th><th className="num">One-way min</th><th className="num">Goal this ½ day</th>
                <th className="num">Day</th><th className="num">Trucks needed</th><th title="Up to 3 teams that get their trucks first when short">Priority</th><th className="num">Trucks assigned</th>
                <th>Pace</th>{canEdit && <th />}
              </tr>
            </thead>
            <tbody>
              {settings.teams.map((team) => {
                const t = schedule.teams[team.id]
                const f = fieldFor(team.id)
                const factor = slotFactor(settings, team, startDate, slot)
                const chip = t ? paceChip(t) : { cls: 'idle', text: '' }
                const log = t && t.logs.find((l) => l.slot === slot)
                return (
                  <tr key={team.id}>
                    <td><span className="hb-team-dot" style={{ background: team.color }} />{team.name}</td>
                    <td>{f ? <button className="link-btn" onClick={() => onOpen(f.key)}>{f.name}</button> : <span className="contracts-sub">—</span>}
                      {f && f.kind !== 'block' && <div className="contracts-sub" style={{ marginTop: 0 }}>{[f.variety, f.killType, f.bay && `bay ${f.bay}`].filter(Boolean).join(' · ')}</div>}</td>
                    <td>{f ? f.destination || <span className="contracts-sub">—</span> : ''}</td>
                    <td className="num">{f && f.oneWayMin != null ? fmtN(f.oneWayMin, 1) : '—'}</td>
                    <td className="num">{f && f.kind !== 'block' ? `${fmtN((f.goal / 2) * factor)} ${f.unit}` : '—'}{factor < 1 && <div className="contracts-sub" style={{ marginTop: 0 }}>{factor === 0 ? 'off' : `${factor * 100}% day`}</div>}</td>
                    <td className="num">{f ? `${f.dayLength} h` : '—'}</td>
                    <td className="num">{f && f.trucks != null ? f.trucks : f && f.kind !== 'block' ? <span className="contracts-sub" title="Set the one-way drive minutes on the field">set min</span> : '—'}</td>
                    <td><input type="checkbox" disabled={!canEdit} checked={priority.includes(team.id)} onChange={() => togglePriority(team.id)} /></td>
                    <td className="num"><strong>{split.alloc[team.id] ?? (needs[team.id] ? 0 : '—')}</strong></td>
                    <td><span className={`hb-pace ${chip.cls}`}>{chip.text}</span>{log && <div className="contracts-sub" style={{ marginTop: 2 }}>logged {WORK.find(([v]) => v === Number(log.fraction))?.[1] || log.fraction}</div>}</td>
                    {canEdit && <td><button className={logFor === team.id ? 'active' : ''} onClick={() => setLogFor(logFor === team.id ? null : team.id)}>{log ? 'Edit log' : 'Log'}</button></td>}
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={6}><strong>Total</strong> {Object.entries(res.goal).map(([u, v]) => `${fmtN(v)} ${u}`).join(' + ')}</td>
                <td className="num"><strong>{res.trucks.toFixed(1)}</strong></td><td />
                <td className="num"><strong>{Object.values(split.alloc).reduce((s, v) => s + v, 0)}</strong></td>
                <td colSpan={canEdit ? 2 : 1} className="contracts-sub">{split.short > 0 ? `${split.short} short` : `${split.leftover} spare`}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="harvest-res-strip">
          {[['Pilers', res.pilers, 'pilers'], ['Generators', res.generators, 'generators'], ['Air seps', res.airSeps, 'airSeps'], ['Sand machines', res.sandMachines, 'sandMachines'], ['Eliminators', res.eliminators], ['Pull tractors', res.pullTractors], ['Airknives', res.airknives], ['Bruise samples', res.bruiseSamples, 'bruiseSamples'], ['Pickers', res.pickers, 'pickers']].map(([l, v, k]) => (
            <span key={l} className={k && v > settings.limits[k] ? 'over' : ''}>{l} <strong>{v}</strong>{k ? <small>/{settings.limits[k]}</small> : null}</span>
          ))}
        </div>
        {logFor && canEdit && (
          <LogForm key={`${logFor}-${slot}`} team={settings.teams.find((t) => t.id === logFor)} t={schedule.teams[logFor]} date={date} half={half} slot={slot}
            current={fieldFor(logFor)} writes={writes} startDate={startDate} onDone={() => setLogFor(null)} />
        )}
      </div>

      <div className="harvest-two">
        <div className="yields-card">
          <div className="yields-card-title">Coming up</div>
          <div className="contracts-sub">Kill dates (start − skin-set days) in the next 2 weeks and water-up checks (start − 7 days).</div>
          {!upcoming.length && <div className="contracts-sub" style={{ marginTop: 10 }}>Nothing due — set skin-set days on fields to get kill reminders.</div>}
          <div className="table-scroll" style={{ maxHeight: 340, marginTop: 8 }}>
            <table className="contracts-table contracts-table-auto">
              <tbody>
                {upcoming.map(({ r, what, date: d, d: n }) => (
                  <tr key={r.key + what}>
                    <td style={{ whiteSpace: 'nowrap' }} className={n < 0 ? 'harvest-overdue' : ''}>{fmtDate(d, true)}</td>
                    <td>{what}</td>
                    <td><button className="link-btn" onClick={() => onOpen(r.key)}>{r.name}</button></td>
                    <td><span className="hb-team-dot" style={{ background: (settings.teams.find((t) => t.id === r.teamId) || {}).color }} />{teamName[r.teamId]}</td>
                    <td className="contracts-sub">{n < 0 ? `${-n} day${n === -1 ? '' : 's'} ago` : n === 0 ? 'today' : `in ${n} day${n === 1 ? '' : 's'}`}{r.killType && what === 'Kill' ? ` · ${r.killType}` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div className="yields-card">
          <div className="yields-card-head" style={{ marginBottom: 0 }}>
            <div>
              <div className="yields-card-title">Progress log</div>
              <div className="contracts-sub">Unlogged half-days count as no progress. “Catch up” fills them as full days in one go.</div>
            </div>
          </div>
          {canEdit && (
            <div className="agronomy-filter-bar" style={{ marginTop: 8 }}>
              {settings.teams.map((team) => {
                const t = schedule.teams[team.id]
                if (!t || !t.rows.length) return null
                const missing = []
                for (let s = t.startSlot; s < schedule.nowSlot; s++) {
                  if (!t.loggedSlots.has(s) && slotFactor(settings, team, startDate, s) > 0) missing.push(s)
                }
                if (!missing.length || t.rows.every((r) => r.done)) return null
                return (
                  <button key={team.id} className="clear-sort-btn" title={`Log ${missing.length} unlogged half-days as full days`}
                    onClick={() => { if (window.confirm(`Mark ${missing.length} unlogged half-day${missing.length === 1 ? '' : 's'} for ${team.name} as full days worked?`)) writes.saveLogs(missing.map((s) => ({ teamId: team.id, ...slotInfo(startDate, s), fraction: 1, catchUp: true }))) }}>
                    <span className="hb-team-dot" style={{ background: team.color }} />Catch up {team.name} ({missing.length})
                  </button>
                )
              })}
            </div>
          )}
          <div className="table-scroll" style={{ maxHeight: 340, marginTop: 8 }}>
            <table className="contracts-table contracts-table-auto">
              <thead><tr><th>Half-day</th><th>Team</th><th>Worked</th><th>Field / amount</th><th>Note</th>{canEdit && <th />}</tr></thead>
              <tbody>
                {recent.map((l) => (
                  <tr key={l.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(l.date, true)} {l.half}</td>
                    <td>{teamName[l.teamId] || l.teamId}</td>
                    <td>{WORK.find(([v]) => v === Number(l.fraction))?.[1] || l.fraction}{l.catchUp ? ' (catch-up)' : ''}</td>
                    <td>{l.fieldKey ? (schedule.byKey[l.fieldKey] || {}).name || l.fieldKey : ''}{l.amount != null ? ` · ${fmtN(l.amount)}` : ''}{l.finishedField ? ' · finished' : ''}</td>
                    <td className="contracts-sub">{l.note || ''}</td>
                    {canEdit && <td><button className="clear-sort-btn" onClick={() => writes.deleteLog(l.id)}>Delete</button></td>}
                  </tr>
                ))}
                {!recent.length && <tr><td colSpan={6} className="contracts-sub">No half-days logged yet.</td></tr>}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  )
}

function LogForm({ team, t, date, half, slot, current, writes, startDate, onDone }) {
  const existing = t && t.logs.find((l) => l.slot === slot)
  const open = t ? t.rows.filter((r) => !r.done || (existing && r.key === existing.fieldKey)) : []
  const [fraction, setFraction] = useState(existing ? Number(existing.fraction) : 1)
  const [fieldKey, setFieldKey] = useState(existing ? existing.fieldKey || '' : '')
  const [amount, setAmount] = useState(existing && existing.amount != null ? String(existing.amount) : '')
  const [finished, setFinished] = useState(existing ? !!existing.finishedField : false)
  const [note, setNote] = useState(existing ? existing.note || '' : '')
  const chosen = open.find((r) => r.key === (fieldKey || (current && current.key)))
  const future = slot > currentSlot(startDate)
  function save() {
    const e = { teamId: team.id, date, half, fraction }
    if (fieldKey) e.fieldKey = fieldKey
    if (amount !== '' && isFinite(Number(amount))) { e.amount = Number(amount); if (!e.fieldKey && chosen) e.fieldKey = chosen.key }
    if (finished) { e.finishedField = true; if (!e.fieldKey && chosen) e.fieldKey = chosen.key }
    if (note.trim()) e.note = note.trim()
    writes.saveLog(e).then(onDone)
  }
  return (
    <div className="harvest-logform" style={{ borderLeftColor: team.color }}>
      <div className="yields-card-title">Log {team.name} — {fmtDate(date, true)} {half}{future ? ' (ahead of time)' : ''}</div>
      <div className="agronomy-filter-bar" style={{ marginTop: 8 }}>
        <span className="contracts-sub" style={{ marginTop: 0 }}>Worked</span>
        {WORK.map(([v, l]) => <button key={l} className={fraction === v ? 'active' : ''} onClick={() => setFraction(v)}>{l}</button>)}
      </div>
      <div className="agronomy-filter-bar">
        <select value={fieldKey} onChange={(e) => setFieldKey(e.target.value)}>
          <option value="">Field: next in line{current ? ` (${current.name})` : ''}</option>
          {open.map((r) => <option key={r.key} value={r.key}>{r.name}{r.status === 'active' ? ` — ${Math.round(r.pct * 100)}% dug` : ''}</option>)}
        </select>
        <label className="hb-check">Amount dug <input className="yields-cell-input" inputMode="decimal" placeholder={chosen && chosen.kind !== 'block' ? `${fmtN((chosen.goal / 2) * fraction)} ${chosen.unit}` : ''} value={amount} onChange={(e) => setAmount(e.target.value)} /> {chosen && chosen.kind !== 'block' ? chosen.unit : ''}</label>
        <label className="hb-check"><input type="checkbox" checked={finished} onChange={(e) => setFinished(e.target.checked)} /> Field finished</label>
        <input className="agronomy-search-input" style={{ minWidth: 160 }} placeholder="Note (rain, breakdown…)" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="contracts-sub" style={{ marginTop: 0, marginBottom: 8 }}>
        Leave the amount blank to credit the goal for the time worked{chosen && chosen.kind !== 'block' ? ` (${fmtN((chosen.goal / 2) * fraction)} ${chosen.unit})` : ''}. Work runs down the line in order, so a field that finishes mid-shift rolls into the next one.
        {chosen && chosen.status === 'active' ? ` ${chosen.name} has ${fmtDays(chosen.remainingDays)} left.` : ''}
      </div>
      <div className="agronomy-filter-bar">
        <button className="save" onClick={save}>Save</button>
        {existing && <button onClick={() => writes.deleteLog(existing.id).then(onDone)}>Delete log</button>}
        <button onClick={onDone}>Cancel</button>
        <span className="contracts-sub" style={{ marginTop: 0 }}>{fmtSlot(startDate, slot, true)}</span>
      </div>
    </div>
  )
}
