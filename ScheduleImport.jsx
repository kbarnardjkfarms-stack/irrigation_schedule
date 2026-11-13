import { useMemo, useRef, useState } from 'react'
import { collection, collectionGroup, doc, getDocs, query, where, writeBatch } from 'firebase/firestore'
import { db } from './firebase.js'
import { SHEET_NAME, extractGrid, hasSchedule, convertUnit, suggestAll } from './scheduleImportMath.js'

// Admin / Owner only. Reads the "WATER SCHEDULE" tab of the Excel irrigation schedule and writes it into
// AIO's weekly schedule (weeks/{Monday}/events/{fieldId}). Nothing is saved until "Import" is pressed.
// Weeks that already have a schedule for a matched field are replaced.

const INK = '#2b2b26'
const MUTED = '#6b6a62'
const LINE = '#ddd8cc'
const WARN = '#8a5a00'
const BAD = '#A32D2D'
const GOOD = '#3c5a3f'

const card = { background: '#fff', border: `0.5px solid ${LINE}`, borderRadius: 10, padding: '14px 16px' }
const h2 = { margin: '0 0 6px', fontSize: 16, fontWeight: 600 }
const note = { margin: '4px 0 0', fontSize: 12.5, color: MUTED, lineHeight: 1.5 }
const th = { textAlign: 'left', padding: '6px 8px', fontSize: 12, color: MUTED, borderBottom: `1px solid ${LINE}`, fontWeight: 600, whiteSpace: 'nowrap' }
const td = { padding: '6px 8px', fontSize: 13, borderBottom: `0.5px solid #eee`, verticalAlign: 'middle' }

function fmtWeek(iso) {
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

export default function ScheduleImport({ userRole, onBack }) {
  const allowed = userRole === 'admin' || userRole === 'owner'
  const fileRef = useRef(null)
  const [stage, setStage] = useState('start') // start | reading | match | checking | ready | writing | done
  const [error, setError] = useState('')
  const [fileName, setFileName] = useState('')
  const [grid, setGrid] = useState(null) // { dates, units } (units with a schedule only)
  const [year, setYear] = useState(null)
  const [fields, setFields] = useState([]) // AIO fields on the 2026 schedule: { id, name, farm }
  const [picks, setPicks] = useState([]) // chosen AIO field id per unit ('' = skip)
  const [existing, setExisting] = useState(null) // Map(week -> Set(fieldId with data))
  const [progress, setProgress] = useState({ done: 0, total: 0 })
  const [result, setResult] = useState(null)

  async function onFile(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    setError(''); setStage('reading'); setFileName(file.name); setExisting(null); setResult(null)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const ws = wb.Sheets[SHEET_NAME]
      if (!ws) throw new Error(`This file has no "${SHEET_NAME}" tab. Tabs found: ${wb.SheetNames.join(', ')}`)
      const g = extractGrid(ws, XLSX)
      if (!g.dates.length) throw new Error('Could not find the dates in row 3 of the Water Schedule tab.')
      const units = g.units.filter(hasSchedule)
      if (!units.length) throw new Error('No On/Off marks were found on the Water Schedule tab.')
      const yr = g.dates[0].iso.slice(0, 4)
      // AIO's own fields for that year: only fields that have a season record are on the schedule.
      const [seasonsSnap, fieldsSnap, farmsSnap] = await Promise.all([
        getDocs(collection(db, 'seasons')), getDocs(collection(db, 'fields')), getDocs(collection(db, 'farms'))
      ])
      let season = null
      seasonsSnap.forEach((d) => { if (String(d.data().name) === yr) season = d.id })
      if (!season) throw new Error(`AIO has no season named ${yr}, so there is nothing to attach the schedule to.`)
      const onSchedule = new Set()
      const sSnap = await getDocs(query(collectionGroup(db, 'seasons'), where('seasonId', '==', season)))
      sSnap.forEach((d) => { onSchedule.add(d.ref.parent.parent.id) })
      const farmName = {}
      farmsSnap.forEach((d) => { farmName[d.id] = d.data().name })
      const list = []
      fieldsSnap.forEach((d) => {
        const f = d.data()
        if (f.hiddenFromIrrigation || !onSchedule.has(d.id)) return
        list.push({ id: d.id, name: f.name || d.id, farm: farmName[f.farmId] || '' })
      })
      list.sort((a, b) => a.name.localeCompare(b.name))
      // Suggest matches among Acequia's fields when there is such a farm, otherwise among all.
      const acequia = list.filter((f) => /acequia/i.test(f.farm))
      const pool = acequia.length ? acequia : list
      setGrid({ dates: g.dates, units })
      setYear(yr)
      setFields(list)
      setPicks(suggestAll(units, pool).map((id) => id || ''))
      setStage('match')
    } catch (err) {
      setError(err.message || String(err)); setStage('start')
    }
  }

  const fieldById = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields])
  const converted = useMemo(() => (grid ? grid.units.map((u) => convertUnit(u, grid.dates)) : []), [grid])

  const duplicates = useMemo(() => {
    const seen = new Map(); const dup = new Set()
    picks.forEach((id) => { if (!id) return; if (seen.has(id)) { dup.add(id) } else seen.set(id, true) })
    return dup
  }, [picks])
  const chosen = picks.map((id, i) => (id ? i : -1)).filter((i) => i >= 0)

  // What would be written: week -> [{ fieldId, events }]
  const plan = useMemo(() => {
    const byWeek = new Map()
    chosen.forEach((i) => {
      converted[i].weeks.forEach((events, week) => {
        if (!events.length) return
        if (!byWeek.has(week)) byWeek.set(week, [])
        byWeek.get(week).push({ fieldId: picks[i], events })
      })
    })
    return [...byWeek.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [chosen.join(','), converted, picks])

  const totals = useMemo(() => {
    const t = { writes: 0, events: 0, defaultHour: 0, clockTime: 0, notes: 0, outsideBlock: 0, contWhileOff: 0, running: [] }
    chosen.forEach((i) => {
      const s = converted[i].stats
      t.defaultHour += s.defaultHour; t.clockTime += s.clockTime; t.notes += s.notes; t.outsideBlock += s.outsideBlock; t.contWhileOff += s.contWhileOff
      if (s.endedRunning) t.running.push(grid.units[i].name)
    })
    plan.forEach(([, rows]) => { t.writes += rows.length; rows.forEach((r) => { t.events += r.events.length }) })
    return t
  }, [chosen.join(','), converted, plan])

  async function checkExisting() {
    setStage('checking'); setError('')
    try {
      const map = new Map()
      for (const [week] of plan) {
        const snap = await getDocs(collection(db, 'weeks', week, 'events'))
        const ids = new Set()
        snap.forEach((d) => { const ev = d.data().events; if (Array.isArray(ev) && ev.length) ids.add(d.id) })
        map.set(week, ids)
      }
      setExisting(map); setStage('ready')
    } catch (err) {
      setError('Could not check what AIO already has: ' + (err.message || err)); setStage('match')
    }
  }

  const replaceCount = existing ? plan.reduce((n, [week, rows]) => n + rows.filter((r) => existing.get(week) && existing.get(week).has(r.fieldId)).length, 0) : 0

  async function runImport() {
    const msg = `Save ${totals.writes} field-weeks (${plan.length} weeks) into AIO?\n\n${replaceCount} of them replace a schedule AIO already has. This cannot be undone.`
    if (!window.confirm(msg)) return
    setStage('writing'); setError('')
    const jobs = []
    plan.forEach(([week, rows]) => rows.forEach((r) => jobs.push({ week, ...r })))
    setProgress({ done: 0, total: jobs.length })
    try {
      let done = 0
      for (let i = 0; i < jobs.length; i += 400) {
        const batch = writeBatch(db)
        jobs.slice(i, i + 400).forEach((j) => batch.set(doc(db, 'weeks', j.week, 'events', j.fieldId), { events: j.events }))
        await batch.commit()
        done = Math.min(jobs.length, i + 400)
        setProgress({ done, total: jobs.length })
      }
      setResult({ writes: jobs.length, weeks: plan.length, replaced: replaceCount, first: plan[0][0], last: plan[plan.length - 1][0] })
      setStage('done')
    } catch (err) {
      setError(`Stopped after ${progress.done} of ${jobs.length} field-weeks: ${err.message || err}. Running the import again is safe: it replaces the same weeks.`)
      setStage('ready')
    }
  }

  if (!allowed) {
    return <div style={{ padding: 24, color: MUTED }}>Only an Admin or Owner can import a schedule.</div>
  }

  const btn = { padding: '8px 14px', borderRadius: 8, fontSize: 14 }
  const primary = { ...btn, background: GOOD, color: '#fff', border: 'none', fontWeight: 600 }
  const canContinue = chosen.length > 0 && duplicates.size === 0

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto', padding: '16px 12px 60px', color: INK, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <button style={btn} onClick={onBack}>&larr; Back</button>
        <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600 }}>Import schedule from Excel</h1>
      </div>

      {error && <div style={{ ...card, borderColor: BAD, color: BAD, fontSize: 14 }} role="alert">{error}</div>}

      <div style={card}>
        <h2 style={h2}>1. Choose the Excel file</h2>
        <p style={note}>Uses the <b>{SHEET_NAME}</b> tab. Nothing is saved until you press Import at the end.</p>
        <div style={{ marginTop: 10 }}>
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm" onChange={onFile} aria-label="Excel file" disabled={stage === 'writing'} />
        </div>
        {stage === 'reading' && <p style={note}>Reading {fileName}&hellip;</p>}
        {grid && stage !== 'reading' && (
          <p style={{ ...note, color: INK }}>
            <b>{fileName}</b>: {grid.units.length} irrigation units have a schedule, {grid.dates[0].iso} to {grid.dates[grid.dates.length - 1].iso}.
            AIO has {fields.length} fields on the {year} schedule.
          </p>
        )}
      </div>

      {grid && (stage === 'match' || stage === 'checking' || stage === 'ready' || stage === 'writing' || stage === 'done') && (
        <div style={card}>
          <h2 style={h2}>2. Match each Excel line to an AIO field</h2>
          <p style={note}>Lines set to &ldquo;Skip&rdquo; are left out. Only fields that exist in AIO are imported. Each AIO field can be used once.</p>
          <div style={{ overflowX: 'auto', marginTop: 8 }}>
            <table style={{ width: '100%', minWidth: 560, borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Excel line</th><th style={th}>Marks</th><th style={th}>AIO field</th></tr></thead>
              <tbody>
                {grid.units.map((u, i) => {
                  const s = converted[i].stats
                  const dup = picks[i] && duplicates.has(picks[i])
                  return (
                    <tr key={u.row}>
                      <td style={td}>{u.name}{s.endedRunning && <span style={{ color: WARN, fontSize: 11.5 }}> &middot; never marked Off</span>}</td>
                      <td style={{ ...td, color: MUTED }}>{s.on} on, {s.off} off</td>
                      <td style={td}>
                        <select
                          aria-label={`AIO field for ${u.name}`}
                          value={picks[i] || ''}
                          disabled={stage === 'writing' || stage === 'done'}
                          onChange={(e) => { const v = e.target.value; setPicks((p) => p.map((x, j) => (j === i ? v : x))); setExisting(null); if (stage === 'ready') setStage('match') }}
                          style={{ padding: '5px 8px', borderRadius: 6, border: `1px solid ${dup ? BAD : LINE}`, maxWidth: 260, background: picks[i] ? '#fff' : '#f6f4ee' }}
                        >
                          <option value="">Skip (not in AIO)</option>
                          {fields.map((f) => <option key={f.id} value={f.id}>{f.name}{f.farm ? ` (${f.farm})` : ''}</option>)}
                        </select>
                        {dup && <span style={{ color: BAD, fontSize: 12 }}> used twice</span>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p style={{ ...note, color: INK }}>
            <b>{chosen.length}</b> of {grid.units.length} lines will be imported, <b>{grid.units.length - chosen.length}</b> skipped.
          </p>
          {stage === 'match' && (
            <div style={{ marginTop: 10 }}>
              <button style={{ ...primary, opacity: canContinue ? 1 : 0.5 }} disabled={!canContinue} onClick={checkExisting}>Next: preview &rarr;</button>
              {duplicates.size > 0 && <span style={{ color: BAD, fontSize: 13, marginLeft: 10 }}>Two lines point at the same AIO field. Change one to Skip.</span>}
            </div>
          )}
          {stage === 'checking' && <p style={note}>Checking what AIO already has&hellip;</p>}
        </div>
      )}

      {existing && (stage === 'ready' || stage === 'writing' || stage === 'done') && (
        <div style={card}>
          <h2 style={h2}>3. Preview</h2>
          <p style={{ margin: '4px 0', fontSize: 14 }}>
            <b>{totals.writes}</b> field-weeks across <b>{plan.length}</b> weeks ({fmtWeek(plan[0][0])} to {fmtWeek(plan[plan.length - 1][0])}), {totals.events} on/off events in all.
            {' '}<b style={{ color: replaceCount ? WARN : INK }}>{replaceCount}</b> of them replace a schedule AIO already has.
          </p>
          <ul style={{ ...note, paddingLeft: 18 }}>
            <li>{totals.clockTime} marks had a clock time (like &ldquo;On 5 PM&rdquo;) and use it. {totals.defaultHour} had none and use the usual hour (8 AM for a morning mark, 5 PM for an evening mark).</li>
            <li>{totals.notes} notes (spray, dig, check, laps and so on) are not imported. AIO has no place for them.</li>
            {totals.outsideBlock > 0 && <li>{totals.outsideBlock} times were written in the wrong half of the day (like &ldquo;On 1 PM&rdquo; in a morning box) and use the usual hour instead.</li>}
            {totals.contWhileOff > 0 && <li>{totals.contWhileOff} boxes were marked running (x) when the line was off. They are ignored.</li>}
            {totals.running.length > 0 && <li style={{ color: WARN }}>{totals.running.length} lines were still running at the end of the schedule with no Off: {totals.running.join(', ')}.</li>}
          </ul>
          <div style={{ overflowX: 'auto', marginTop: 8, maxHeight: 280, overflowY: 'auto' }}>
            <table style={{ width: '100%', minWidth: 420, borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Week of</th><th style={th}>Fields</th><th style={th}>Replaces existing</th></tr></thead>
              <tbody>
                {plan.map(([week, rows]) => {
                  const rep = rows.filter((r) => existing.get(week) && existing.get(week).has(r.fieldId)).length
                  return <tr key={week}><td style={td}>{fmtWeek(week)}</td><td style={td}>{rows.length}</td><td style={{ ...td, color: rep ? WARN : MUTED }}>{rep || '—'}</td></tr>
                })}
              </tbody>
            </table>
          </div>
          {stage === 'ready' && (
            <div style={{ marginTop: 12 }}>
              <button style={primary} onClick={runImport}>Import {totals.writes} field-weeks</button>
            </div>
          )}
          {stage === 'writing' && <p style={{ ...note, color: INK }} role="status">Saving {progress.done} of {progress.total}&hellip;</p>}
        </div>
      )}

      {stage === 'done' && result && (
        <div style={{ ...card, borderColor: GOOD }} role="status">
          <h2 style={{ ...h2, color: GOOD }}>Done</h2>
          <p style={{ margin: 0, fontSize: 14 }}>
            Saved {result.writes} field-weeks ({result.weeks} weeks, {fmtWeek(result.first)} to {fmtWeek(result.last)}). {result.replaced} replaced an existing schedule.
            Open the Schedule and go to any of those weeks to check it.
          </p>
          <div style={{ marginTop: 10 }}><button style={btn} onClick={onBack}>Back to the schedule</button></div>
        </div>
      )}
    </div>
  )
}
