import { useMemo, useState } from 'react'
import {
  DEFAULT_CROPS, DEFAULT_LIMITS, DEFAULT_TRUCKING, cropSettings, fieldPlan, fmtDate, fmtDays, fmtN, fmtSlot,
  parseFieldTable, slotInfo
} from './harvestMath.js'
import { deleteDoc, doc, writeBatch } from 'firebase/firestore'
import { db } from './firebase.js'
import { fieldKey } from './yieldMath.js'
import { hfId } from './Harvest.jsx'

// Field drawer (edit one field's harvest details), the Field details table
// (with workbook import + Excel export) and the Settings tab.

const CLEANING = ['Air Sep', 'Sand Machine', 'Eliminator table only', 'Clod Hopper']
const KILL = ['Spray', 'Split', 'Split/Spray', 'Splitter', 'Beat', 'Flail']

// ---------------------------------------------------------------------------
// Field drawer
// ---------------------------------------------------------------------------
export function FieldDrawer({ field, schedule, settings, canEdit, writes, onClose }) {
  const f = field
  const block = f.kind === 'block'
  const team = settings.teams.find((t) => t.id === f.teamId) || null
  const plan = fieldPlan(f, settings, team)
  const cs = cropSettings(settings, f.crop)
  const [form, setForm] = useState(() => ({
    name: f.name || '', blockDays: f.blockDays ?? '', yieldPerAcre: f.yieldPerAcre ?? '', goalPerDay: f.goalPerDay ?? '', dayLength: f.dayLength ?? '',
    oneWayMin: f.oneWayMin != null ? Math.round(f.oneWayMin * 100) / 100 : '', destination: f.destination || '', bay: f.bay ?? '', skinSetDays: f.skinSetDays ?? '',
    killType: f.killType || '', killed: !!f.killed, buyer: f.buyer || '', storage: f.storage || '', area: f.area || '',
    postHarvestSpray: f.postHarvestSpray || '', pileHeight: f.pileHeight ?? '', stopLoadingTemp: f.stopLoadingTemp ?? '',
    acresOverride: f.acresOverride ?? '', notes: f.notes || '', finished: !!f.finished,
    resources: { generators: '', pilers: '', cleaningUnit: '', pullTractor: '', bruiseSamples: '', airknife: '', pickers: '', ...(f.resources || {}) }
  }))
  const set = (k, v) => setForm((x) => ({ ...x, [k]: v }))
  const [startTeam, setStartTeam] = useState(f.teamId || '')
  const [startDate, setStartDate] = useState(() => (f.startOn && f.startOn.date) || (f.startSlot != null ? slotInfo(schedule.startDate, f.startSlot).date : ''))
  const [startHalf, setStartHalf] = useState(() => (f.startOn && f.startOn.half) || (f.startSlot != null ? slotInfo(schedule.startDate, f.startSlot).half : 'AM'))
  const setR = (k, v) => setForm((x) => ({ ...x, resources: { ...x.resources, [k]: v } }))
  const n = (v) => (v === '' || v == null ? null : Number(v))
  const s = (v) => (v === '' || v == null ? null : String(v).trim() || null)

  function save() {
    const patch = block
      ? { name: s(form.name) || 'Move day', blockDays: Math.max(0.5, Math.round((n(form.blockDays) ?? 1) * 2) / 2), notes: s(form.notes) }
      : {
          yieldPerAcre: n(form.yieldPerAcre), goalPerDay: n(form.goalPerDay), dayLength: n(form.dayLength), oneWayMin: n(form.oneWayMin),
          destination: s(form.destination), bay: s(form.bay), skinSetDays: n(form.skinSetDays), killType: s(form.killType), killed: !!form.killed,
          buyer: s(form.buyer), storage: s(form.storage), area: s(form.area), postHarvestSpray: s(form.postHarvestSpray),
          pileHeight: n(form.pileHeight), stopLoadingTemp: s(form.stopLoadingTemp), notes: s(form.notes), finished: !!form.finished,
          acresOverride: n(form.acresOverride),
          resources: Object.fromEntries(Object.entries(form.resources).map(([k, v]) => [k, k === 'cleaningUnit' ? s(v) : n(v)]))
        }
    writes.saveField(f.key, patch).then(onClose)
  }
  function moveTo(teamId, where) {
    const lane = (schedule.teams[teamId] ? schedule.teams[teamId].rows : []).filter((r) => r.key !== f.key)
    const myIdx = schedule.teams[teamId] ? schedule.teams[teamId].rows.findIndex((r) => r.key === f.key) : -1
    let beforeKey = null
    if (where === 'top') beforeKey = lane[0] ? lane[0].key : null
    else if (where === 'up' && myIdx > 0) beforeKey = lane[myIdx - 1] ? lane[myIdx - 1].key : null
    else if (where === 'down' && myIdx >= 0) beforeKey = lane[myIdx + 1] ? lane[myIdx + 1].key : null
    writes.moveField([f.key], teamId, beforeKey)
  }

  const inp = (k, label, ph, opts = {}) => (
    <label className="hd-field"><span>{label}</span>
      <input disabled={!canEdit} inputMode={opts.text ? undefined : 'decimal'} list={opts.list} placeholder={ph == null ? '' : String(ph)} value={form[k]} onChange={(e) => set(k, e.target.value)} />
    </label>
  )
  return (
    <div className="hd-backdrop" onClick={onClose}>
      <div className="hd-drawer" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={`${f.name} harvest details`}>
        <div className="hd-head" style={{ borderTopColor: team ? team.color : '#ccc' }}>
          <div>
            <div className="yields-card-title" style={{ fontSize: 16 }}>{f.name}</div>
            <div className="contracts-sub">{block ? 'Move / down-time block' : [f.crop && f.crop.toLowerCase(), f.variety, f.farmName, `${fmtN(plan.acres)} ac`, f.contract && `contract: ${f.contract}`].filter(Boolean).join(' · ')}</div>
            {f.source === 'custom' && <div className="contracts-sub">Not an Agworld field — added by hand or from the workbook.</div>}
          </div>
          <button onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="hd-stats">
          <div><span>Team</span><strong>{team ? team.name : 'Unscheduled'}</strong></div>
          {!block && <div><span>Total</span><strong>{fmtN(plan.total)} {plan.unit}</strong><small>{fmtN(plan.yieldPerAcre)}/ac ({plan.yieldSource === 'history' ? 'field avg' : plan.yieldSource === 'set' ? 'set' : 'crop default'})</small></div>}
          <div><span>Days</span><strong>{fmtDays(plan.days)}</strong>{!block && <small>goal {fmtN(plan.goal)}/day · {plan.dayLength} h</small>}</div>
          {f.startSlot != null && <div><span>When</span><strong>{fmtSlot(schedule.startDate, f.startSlot, true)}</strong><small>to {f.endSlot != null ? fmtSlot(schedule.startDate, Math.ceil(f.endSlot) - 1, true) : '—'}</small></div>}
          {!block && <div><span>10-wheelers</span><strong>{plan.trucks ?? '—'}</strong>{plan.trucks == null && <small>needs one-way minutes</small>}</div>}
          {f.killDate && <div><span>Kill by</span><strong className={f.killStatus === 'overdue' ? 'harvest-overdue' : ''}>{fmtDate(f.killDate, true)}</strong><small>water-up check {fmtDate(f.waterUpDate)}</small></div>}
          {f.status === 'active' && <div><span>Dug</span><strong>{Math.round(f.pct * 100)}%</strong><small>{fmtDays(f.remainingDays)} left</small></div>}
        </div>

        {canEdit && (
          <div className="hd-section">
            <div className="agronomy-section-label">Team &amp; position</div>
            <div className="agronomy-filter-bar">
              <select value={f.teamId || ''} onChange={(e) => e.target.value ? writes.moveField([f.key], e.target.value, null) : (block ? (writes.removeField(f.key), onClose()) : writes.moveField([f.key], null))}>
                <option value="">— Unscheduled —</option>
                {settings.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {f.teamId && <>
                <button onClick={() => moveTo(f.teamId, 'top')}>⤒ First</button>
                <button onClick={() => moveTo(f.teamId, 'up')}>↑ Up</button>
                <button onClick={() => moveTo(f.teamId, 'down')}>↓ Down</button>
                <button onClick={() => moveTo(f.teamId, 'bottom')}>⤓ Last</button>
              </>}
            </div>
            <div className="agronomy-section-label">Start on a date</div>
            <div className="agronomy-filter-bar">
              <select value={startTeam} onChange={(e) => setStartTeam(e.target.value)}>
                <option value="">Team…</option>
                {settings.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              <div className="agronomy-view-toggle" style={{ margin: 0 }}>
                {['AM', 'PM'].map((h) => <button key={h} className={startHalf === h ? 'active' : ''} onClick={() => setStartHalf(h)}>{h}</button>)}
              </div>
              <button className="save" disabled={!startTeam || !startDate} onClick={() => { writes.placeAt(f.key, startTeam, startDate, startHalf); onClose() }}>Start here</button>
              {f.startOn && <button onClick={() => { writes.clearStart(f.key); onClose() }}>Clear date</button>}
            </div>
            <div className="contracts-sub" style={{ marginTop: 0 }}>
              Slots it into the line at that date and holds it until then; everything after it follows in sequence.
              {f.pinLate ? ` ⚠ The fields ahead of it run past ${fmtSlot(schedule.startDate, f.pinSlot, true)}, so it can’t start until ${fmtSlot(schedule.startDate, f.startSlot, true)} — move something or open a gap.` : ''}
            </div>
          </div>
        )}

        {block ? (
          <div className="hd-section hd-grid">
            {inp('name', 'Label', 'Move day', { text: true })}
            {inp('blockDays', 'Days (half-day steps)', 1)}
            {inp('notes', 'Notes', '', { text: true })}
          </div>
        ) : (
          <>
            <div className="hd-section">
              <div className="agronomy-section-label">Production — blank uses the default shown</div>
              <div className="hd-grid">
                {inp('yieldPerAcre', `Yield projection (${plan.unit}/ac)`, f.histYield != null ? Math.round(f.histYield) : cs.yieldPerAcre)}
                {inp('goalPerDay', `Production goal (${plan.unit}/day)`, (team && team.goalPerDay) || cs.goalPerDay)}
                {inp('dayLength', 'Working day (hours)', (team && team.dayLength) || settings.dayLength)}
                {inp('acresOverride', 'Acres (override)', f.source === 'agworld' ? f.acres : '')}
              </div>
            </div>
            <div className="hd-section">
              <div className="agronomy-section-label">Logistics</div>
              <div className="hd-grid">
                {inp('destination', 'Destination', '', { text: true, list: 'harvest-dest' })}
                {inp('oneWayMin', 'Drive one way (min)', '')}
                {inp('bay', 'Bay', '', { text: true })}
                {inp('area', 'Area / dump', '', { text: true })}
                {inp('buyer', 'Buyer', f.contract || '', { text: true })}
                {inp('storage', 'Storage or direct', '', { text: true })}
                {inp('pileHeight', 'Pile height', '')}
                {inp('stopLoadingTemp', 'Stop loading temp', '', { text: true })}
                {inp('postHarvestSpray', 'Post-harvest spray', '', { text: true })}
              </div>
            </div>
            <div className="hd-section">
              <div className="agronomy-section-label">Vine kill</div>
              <div className="hd-grid">
                {inp('skinSetDays', 'Skin-set days (kill → dig)', '')}
                <label className="hd-field"><span>Kill type</span>
                  <input disabled={!canEdit} list="harvest-kill" value={form.killType} onChange={(e) => set('killType', e.target.value)} />
                </label>
                <label className="hd-field hd-check"><input type="checkbox" disabled={!canEdit} checked={form.killed} onChange={(e) => set('killed', e.target.checked)} /> <span>Vines killed</span></label>
              </div>
            </div>
            <div className="hd-section">
              <div className="agronomy-section-label">Resources this field needs</div>
              <div className="hd-grid">
                {[['generators', 'Generators'], ['pilers', 'Pilers'], ['pullTractor', 'Pull tractors'], ['bruiseSamples', 'Bruise samples'], ['airknife', 'Airknives'], ['pickers', 'Pickers']].map(([k, l]) => (
                  <label key={k} className="hd-field"><span>{l}</span><input disabled={!canEdit} inputMode="decimal" value={form.resources[k] ?? ''} onChange={(e) => setR(k, e.target.value)} /></label>
                ))}
                <label className="hd-field"><span>Cleaning unit</span>
                  <select disabled={!canEdit} value={form.resources.cleaningUnit || ''} onChange={(e) => setR('cleaningUnit', e.target.value)}>
                    <option value="">—</option>{CLEANING.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </label>
              </div>
            </div>
            <div className="hd-section">
              {inp('notes', 'Notes', '', { text: true })}
              <label className="hd-field hd-check"><input type="checkbox" disabled={!canEdit} checked={form.finished} onChange={(e) => set('finished', e.target.checked)} /> <span>Field finished (counts as 100% dug)</span></label>
            </div>
          </>
        )}
        <datalist id="harvest-kill">{KILL.map((k) => <option key={k} value={k} />)}</datalist>
        <datalist id="harvest-dest">{[...new Set(Object.values(schedule.byKey).map((r) => r.destination).filter(Boolean))].sort().map((d) => <option key={d} value={d} />)}</datalist>
        {canEdit && (
          <div className="agronomy-filter-bar hd-foot">
            <button className="save" onClick={save}>Save</button>
            <button onClick={onClose}>Cancel</button>
            {(f.teamId || f.source !== 'agworld') && (
              <button style={{ marginLeft: 'auto', color: '#A32D2D' }} onClick={() => { writes.removeField(f.key); onClose() }}>
                {block || f.source !== 'agworld' ? 'Delete' : 'Take off schedule'}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field details table + import / export
// ---------------------------------------------------------------------------
export function FieldsTable({ allFields, schedule, settings, canEdit, writes, onOpen, seasonName }) {
  const [team, setTeam] = useState('all')
  const [q, setQ] = useState('')
  const [importing, setImporting] = useState(false)
  const teamIdx = Object.fromEntries(settings.teams.map((t, i) => [t.id, i]))
  const rows = Object.values(schedule.byKey)
    .filter((r) => team === 'all' || r.teamId === team)
    .filter((r) => !q || `${r.name} ${r.variety || ''} ${r.destination || ''} ${r.buyer || ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (teamIdx[a.teamId] - teamIdx[b.teamId]) || (a.order ?? 0) - (b.order ?? 0))
  const tName = Object.fromEntries(settings.teams.map((t) => [t.id, t]))

  async function exportXlsx() {
    const XLSX = await import('xlsx')
    const sheetRows = rows.map((r) => ({
      Team: (tName[r.teamId] || {}).name, Field: r.name, Crop: r.crop, Variety: r.variety || '', Acres: r.acres,
      'Yield / ac': r.kind === 'block' ? '' : Math.round(r.yieldPerAcre), 'Total yield': r.kind === 'block' ? '' : Math.round(r.total), Unit: r.unit,
      'Goal / day': r.kind === 'block' ? '' : r.goal, 'Hours digging': r.dayLength, 'Days required': Math.round(r.days * 100) / 100,
      Start: r.startSlot != null ? fmtSlot(schedule.startDate, r.startSlot) : '', Finish: r.endSlot != null ? fmtSlot(schedule.startDate, Math.ceil(r.endSlot) - 1) : '',
      '10 wheelers': r.trucks ?? '', 'One-way min': r.oneWayMin ?? '', Destination: r.destination || '', Bay: r.bay ?? '',
      'Skin set': r.skinSetDays ?? '', 'Kill date': r.killDate || '', 'Kill type': r.killType || '', Buyer: r.buyer || r.contract || '',
      'Storage or direct': r.storage || '', '% dug': Math.round(r.pct * 100), Status: r.status
    }))
    // half-day grid like the Desktop Dashboard
    const grid = []
    let last = 0
    Object.values(schedule.teams).forEach((t) => t.rows.forEach((r) => { if (r.endSlot != null) last = Math.max(last, Math.ceil(r.endSlot)) }))
    for (let s = 0; s < last; s++) {
      const { date, half } = slotInfo(schedule.startDate, s)
      const row = { Date: date, Half: half }
      settings.teams.forEach((tm) => {
        const t = schedule.teams[tm.id]
        const hit = t && t.rows.find((r) => r.startSlot != null && r.endSlot != null && r.startSlot < s + 1 && r.endSlot > s)
        row[tm.name] = hit ? hit.name : ''
      })
      grid.push(row)
    }
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(sheetRows), 'Field Table')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(grid), 'Half-day schedule')
    XLSX.writeFile(wb, `harvest_plan_${seasonName || ''}.xlsx`)
  }

  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Field details</div>
          <div className="contracts-sub">Everything on the schedule, in line order — the AIO version of the Field Table. Click a row to edit.</div>
        </div>
        <div className="agronomy-filter-bar" style={{ margin: 0 }}>
          <select value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="all">All teams</option>
            {settings.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <input className="agronomy-search-input" style={{ minWidth: 160 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          <button onClick={exportXlsx} disabled={!rows.length}>Export to Excel</button>
          {canEdit && <button className={importing ? 'active' : ''} onClick={() => setImporting((x) => !x)}>Import workbook…</button>}
        </div>
      </div>
      {importing && <ImportPanel allFields={allFields} settings={settings} writes={writes} onDone={() => setImporting(false)} />}
      <div className="table-scroll" style={{ maxHeight: 620 }}>
        <table className="contracts-table contracts-table-auto harvest-fields">
          <thead>
            <tr>
              <th>Team</th><th>Field</th><th>Variety</th><th className="num">Acres</th><th className="num">Yield/ac</th><th className="num">Total</th>
              <th className="num">Goal/day</th><th className="num">Hrs</th><th className="num">Days</th><th>Start</th><th>Finish</th>
              <th className="num">Trucks</th><th className="num">1-way min</th><th>Destination</th><th>Kill</th><th>Buyer</th><th className="num">Dug</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} onClick={() => onOpen(r.key)} className={`clickable${r.status === 'done' ? ' harvest-done-row' : ''}`}>
                <td><span className="hb-team-dot" style={{ background: (tName[r.teamId] || {}).color }} />{(tName[r.teamId] || {}).name}</td>
                <td><strong>{r.name}</strong></td>
                <td>{r.kind === 'block' ? <span className="contracts-sub">block</span> : r.variety || r.crop.toLowerCase()}</td>
                <td className="num">{r.kind === 'block' ? '' : fmtN(r.acres)}</td>
                <td className="num" title={r.yieldSource}>{r.kind === 'block' ? '' : fmtN(r.yieldPerAcre)}{r.yieldSource === 'default' && r.kind !== 'block' ? '*' : ''}</td>
                <td className="num">{r.kind === 'block' ? '' : `${fmtN(r.total)} ${r.unit}`}</td>
                <td className="num">{r.kind === 'block' ? '' : fmtN(r.goal)}</td>
                <td className="num">{r.dayLength}</td>
                <td className="num">{(Math.round(r.days * 10) / 10).toFixed(1)}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.startSlot != null ? fmtSlot(schedule.startDate, r.startSlot) : '—'}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.endSlot != null ? fmtSlot(schedule.startDate, Math.ceil(r.endSlot) - 1) : '—'}</td>
                <td className="num">{r.trucks ?? ''}</td>
                <td className="num">{r.oneWayMin != null ? fmtN(r.oneWayMin, 1) : ''}</td>
                <td>{r.destination || ''}</td>
                <td className={r.killStatus === 'overdue' ? 'harvest-overdue' : ''} style={{ whiteSpace: 'nowrap' }}>{r.killDate ? fmtDate(r.killDate) : ''}{r.killed ? ' ✓' : ''}</td>
                <td>{r.buyer || r.contract || ''}</td>
                <td className="num">{r.kind === 'block' ? '' : `${Math.round(r.pct * 100)}%`}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={17} className="contracts-sub">Nothing scheduled yet — drag fields onto teams on the Schedule board, or import your workbook.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="contracts-sub">* yield projection is the crop default — set it on the field, or it uses the field’s own average from Yields when there is one.</div>
    </div>
  )
}

function ImportPanel({ allFields, settings, writes, onDone }) {
  const [parsed, setParsed] = useState(null)
  const [err, setErr] = useState(null)
  const [replace, setReplace] = useState(true)
  const [useAcres, setUseAcres] = useState(false)
  const [useStart, setUseStart] = useState(false)
  const [busy, setBusy] = useState(false)

  const agByKey = useMemo(() => {
    const m = {}
    allFields.forEach((f) => { if (f.source === 'agworld') m[fieldKey(f.name)] = f })
    return m
  }, [allFields])
  const teamByName = Object.fromEntries(settings.teams.map((t) => [t.name.toLowerCase(), t.id]))

  async function onFile(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    setErr(null); setParsed(null)
    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      // Only parse the sheets we need — the dashboards are huge.
      const names = XLSX.read(buf, { type: 'array', bookSheets: true }).SheetNames
      const name = names.find((n) => /field table/i.test(n)) || names[0]
      const wb = XLSX.read(buf, { type: 'array', sheets: [name] })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: true, defval: null })
      // First half-day of the Desktop Dashboard = the plan's start date.
      let startDate = null
      const dash = names.find((n) => /desktop dashboard/i.test(n))
      if (dash) {
        const a3 = (XLSX.read(buf, { type: 'array', sheets: [dash], sheetRows: 4 }).Sheets[dash] || {}).A3
        if (a3 && typeof a3.v === 'number' && a3.v > 40000) startDate = new Date(Math.round((a3.v - 25569) * 86400000)).toISOString().slice(0, 10)
      }
      const items = parseFieldTable(rows).map((it) => {
        const ag = it.kind === 'block' ? null : agByKey[fieldKey(it.name)]
        return { ...it, ag, teamId: it.team ? teamByName[it.team.toLowerCase()] || null : null }
      })
      setParsed({ sheet: name, items, startDate })
      setUseStart(!!startDate && startDate !== settings.startDate)
    } catch (ex) { setErr(ex.message || String(ex)) }
  }

  const items = parsed ? parsed.items : []
  const fieldsIn = items.filter((i) => i.kind !== 'block')
  const matched = fieldsIn.filter((i) => i.ag)
  const unmatched = fieldsIn.filter((i) => !i.ag)
  const blocks = items.filter((i) => i.kind === 'block' && i.teamId)
  const unknownTeams = [...new Set(items.filter((i) => i.team && !i.teamId).map((i) => i.team))]

  async function doImport() {
    setBusy(true)
    const sid = writes.sid
    const keep = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null && v !== ''))
    const docs = []
    // order inside each team: workbook Order, then sheet order for blanks
    const seq = {}
    const orderFor = (it, i) => (it.teamId ? (it.order != null ? it.order * 1000 : 900000 + i) : null)
    items.forEach((it, i) => {
      if (it.kind === 'block') {
        if (!it.teamId) return
        seq[it.teamId] = (seq[it.teamId] || 0) + 1
        const key = `blk_imp${String(it.teamId)}${it.order ?? 'x'}_${i}`
        docs.push([key, { seasonId: sid, key, kind: 'block', name: it.name, blockDays: it.blockDays, crop: null, teamId: it.teamId, order: orderFor(it, i), updatedAt: Date.now(), imported: true }])
        return
      }
      const details = keep({
        yieldPerAcre: it.yieldPerAcre, goalPerDay: it.goalPerDay, dayLength: it.dayLength, oneWayMin: it.oneWayMin, destination: it.destination,
        bay: it.bay != null ? String(it.bay) : null, skinSetDays: it.skinSetDays, killType: it.killType, buyer: it.buyer, storage: it.storage, area: it.area,
        postHarvestSpray: it.postHarvestSpray, pileHeight: it.pileHeight, stopLoadingTemp: it.stopLoadingTemp
      })
      const resources = keep(it.resources || {})
      const placement = replace ? { teamId: it.teamId || null, order: orderFor(it, i) } : {}
      if (it.ag) {
        docs.push([it.ag.key, { seasonId: sid, key: it.ag.key, fieldId: it.ag.key, name: it.ag.name, crop: it.ag.crop, ...details, resources, ...placement, ...(useAcres && it.acres ? { acresOverride: it.acres } : {}), updatedAt: Date.now() }])
      } else {
        const key = `x_${fieldKey(it.name)}`
        docs.push([key, { seasonId: sid, key, name: it.name, crop: it.crop, variety: it.variety, farmName: it.farm, acresOverride: it.acres || 0, ...details, resources, ...placement, updatedAt: Date.now() }])
      }
    })
    if (useStart && parsed.startDate) await writes.saveSettings({ startDate: parsed.startDate })
    await writes.run(async () => {
      if (replace) {
        // old move/down blocks would double up with the workbook's
        const oldBlocks = allFields.filter((f) => f.kind === 'block')
        for (const b of oldBlocks) await deleteDoc(doc(db, 'harvestFields', hfId(sid, b.key)))
      }
      for (let i = 0; i < docs.length; i += 300) {
        const b = writeBatch(db)
        docs.slice(i, i + 300).forEach(([key, d]) => b.set(doc(db, 'harvestFields', hfId(sid, key)), d, { merge: true }))
        await b.commit()
      }
    }, `Imported ${matched.length + unmatched.length} fields and ${blocks.length} move/down blocks.`)
    setBusy(false)
    onDone()
  }

  return (
    <div className="harvest-import">
      <div className="contracts-sub" style={{ marginTop: 0 }}>Pick your harvest plan workbook (.xlsm / .xlsx). AIO reads its <strong>Field Table</strong> sheet: team, order, yield projection, target output, hours digging, drive time, destination, skin set, kill type, buyer and the resource columns. Fields are matched to Agworld by name; anything that doesn’t match is added as a field that isn’t in Agworld. “Move Day” rows become move blocks; “Done” rows are skipped.</div>
      <input type="file" accept=".xlsx,.xlsm,.xls" onChange={onFile} style={{ marginTop: 8 }} />
      {err && <div className="agronomy-error-banner" style={{ marginTop: 8 }}>{err}</div>}
      {parsed && (
        <>
          <div className="harvest-import-sum">
            <span><strong>{matched.length}</strong> matched to Agworld</span>
            <span><strong>{unmatched.length}</strong> not in Agworld (will be added)</span>
            <span><strong>{blocks.length}</strong> move days</span>
            <span><strong>{items.filter((i) => i.teamId).length}</strong> with a team</span>
          </div>
          {unknownTeams.length > 0 && <div className="agronomy-error-banner">These team names don’t match a team in Settings and will come in unscheduled: {unknownTeams.join(', ')}</div>}
          {unmatched.length > 0 && <details style={{ marginBottom: 8 }}><summary className="contracts-sub">Not matched: {unmatched.slice(0, 12).map((u) => u.name).join(', ')}{unmatched.length > 12 ? '…' : ''}</summary><div className="contracts-sub">{unmatched.map((u) => u.name).join(', ')}</div></details>}
          <div className="agronomy-filter-bar">
            <label className="hb-check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Use the workbook’s teams &amp; order (replaces placement and move blocks)</label>
            {parsed.startDate && <label className="hb-check"><input type="checkbox" checked={useStart} onChange={(e) => setUseStart(e.target.checked)} /> Start the plan {fmtDate(parsed.startDate, true)} (from the dashboard)</label>}
            <label className="hb-check"><input type="checkbox" checked={useAcres} onChange={(e) => setUseAcres(e.target.checked)} /> Use workbook acres instead of Agworld’s</label>
          </div>
          <div className="agronomy-filter-bar">
            <button className="save" disabled={busy} onClick={doImport}>{busy ? 'Importing…' : `Import ${items.length} rows`}</button>
            <button onClick={onDone}>Cancel</button>
          </div>
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const TEAM_COLORS = ['#7B4FC9', '#D23B3B', '#E8801A', '#2E9B4F', '#D9B300', '#9A9890', '#2A6FD6', '#5B5F66', '#0F8C8C', '#B5487A']

export function HarvestSettings({ settings, canEdit, writes, allFields }) {
  const [s, setS] = useState(() => JSON.parse(JSON.stringify(settings)))
  const [dirty, setDirty] = useState(false)
  const up = (patch) => { setS((x) => ({ ...x, ...patch })); setDirty(true) }
  const cropList = [...new Set([...Object.keys(DEFAULT_CROPS), ...allFields.filter((f) => f.teamId && f.crop && f.kind !== 'block').map((f) => f.crop)])]
  const teamCounts = {}
  allFields.forEach((f) => { if (f.teamId) teamCounts[f.teamId] = (teamCounts[f.teamId] || 0) + 1 })
  const ro = !canEdit

  function setCrop(c, k, v) {
    const crops = { ...(s.crops || {}) }
    crops[c] = { ...(crops[c] || {}), [k]: v === '' ? undefined : (k === 'unit' ? v : Number(v)) }
    Object.keys(crops[c]).forEach((kk) => crops[c][kk] === undefined && delete crops[c][kk])
    up({ crops })
  }
  function setTeam(i, patch) { const teams = s.teams.map((t, j) => (j === i ? { ...t, ...patch } : t)); up({ teams }) }
  function moveTeam(i, d) { const teams = [...s.teams]; const j = i + d; if (j < 0 || j >= teams.length) return; [teams[i], teams[j]] = [teams[j], teams[i]]; up({ teams }) }
  function addTeam() {
    const id = `team${Date.now().toString(36)}`
    up({ teams: [...s.teams, { id, name: `Team ${s.teams.length + 1}`, color: TEAM_COLORS[s.teams.length % TEAM_COLORS.length] }] })
  }
  function save() {
    const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === undefined || (typeof v === 'number' && !isFinite(v)) ? null : v)))
    const teams = s.teams.map((t) => clean({ ...t, dayLength: t.dayLength === '' ? null : t.dayLength, goalPerDay: t.goalPerDay === '' ? null : t.goalPerDay, startDate: t.startDate || null }))
    writes.saveSettings(clean({
      startDate: s.startDate, dayLength: Number(s.dayLength) || 12, rateMode: s.rateMode, standardDay: Number(s.standardDay) || 12, sundaysOff: !!s.sundaysOff,
      teams, crops: s.crops || {}, limits: s.limits, trucking: s.trucking, calendar: s.calendar || {}
    })).then(() => setDirty(false))
  }
  const calRows = []
  Object.entries(s.calendar || {}).forEach(([d, v]) => calRows.push({ d, team: null, v }))
  s.teams.forEach((t) => Object.entries(t.calendar || {}).forEach(([d, v]) => calRows.push({ d, team: t, v })))
  calRows.sort((a, b) => a.d.localeCompare(b.d))
  function dropCal(row) {
    if (!row.team) { const cal = { ...s.calendar }; delete cal[row.d]; up({ calendar: cal }) } else {
      setTeam(s.teams.indexOf(row.team), { calendar: Object.fromEntries(Object.entries(row.team.calendar || {}).filter(([d]) => d !== row.d)) })
    }
  }
  const numIn = (val, on, w = 70, ph = '') => <input className="yields-cell-input" style={{ width: w }} disabled={ro} inputMode="decimal" placeholder={ph} value={val ?? ''} onChange={(e) => on(e.target.value === '' ? '' : Number(e.target.value))} />

  return (
    <div className="harvest-settings">
      {canEdit && (
        <div className="harvest-save-bar">
          <span className="contracts-sub" style={{ marginTop: 0 }}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
          <button className="save" disabled={!dirty} onClick={save}>Save settings</button>
          <button disabled={!dirty} onClick={() => { setS(JSON.parse(JSON.stringify(settings))); setDirty(false) }}>Undo changes</button>
        </div>
      )}
      <div className="harvest-two">
        <div className="yields-card">
          <div className="yields-card-title">Season</div>
          <div className="hd-grid" style={{ marginTop: 8 }}>
            <label className="hd-field"><span>First harvest day</span><input type="date" disabled={ro} value={s.startDate || ''} onChange={(e) => up({ startDate: e.target.value })} /></label>
            <label className="hd-field"><span>Working day length (hours)</span>{numIn(s.dayLength, (v) => up({ dayLength: v }), 90)}</label>
            <label className="hd-field"><span>Production goal is…</span>
              <select disabled={ro} value={s.rateMode} onChange={(e) => up({ rateMode: e.target.value })}>
                <option value="day">fixed per day (like the sheet)</option>
                <option value="scale">scaled by day length</option>
              </select>
            </label>
            {s.rateMode === 'scale' && <label className="hd-field"><span>Goals are for a day of (hours)</span>{numIn(s.standardDay, (v) => up({ standardDay: v }), 90, 12)}</label>}
            <label className="hd-field hd-check"><input type="checkbox" disabled={ro} checked={!!s.sundaysOff} onChange={(e) => up({ sundaysOff: e.target.checked })} /><span>Sundays off</span></label>
          </div>
          <div className="contracts-sub">Fixed: the goal is what a crew digs in a day whatever its length; day length drives trucks. Scaled: goals are for a standard day, so a 14 h day on a 12 h standard digs 14/12 of the goal (and shorter days less).</div>
          <div className="agronomy-section-label">Trucking formula</div>
          <div className="hd-grid">
            <label className="hd-field"><span>Hours not hauling / day</span>{numIn(s.trucking.nonHaulHours, (v) => up({ trucking: { ...s.trucking, nonHaulHours: v } }), 70, DEFAULT_TRUCKING.nonHaulHours)}</label>
            <label className="hd-field"><span>Round trip = one-way min ×</span>{numIn(s.trucking.tripFactor, (v) => up({ trucking: { ...s.trucking, tripFactor: v } }), 70, DEFAULT_TRUCKING.tripFactor)}</label>
            <label className="hd-field"><span>+ minutes (load / dump)</span>{numIn(s.trucking.tripFixedMin, (v) => up({ trucking: { ...s.trucking, tripFixedMin: v } }), 70, DEFAULT_TRUCKING.tripFixedMin)}</label>
          </div>
        </div>
        <div className="yields-card">
          <div className="yields-card-title">Limits (red when over)</div>
          <div className="hd-grid" style={{ marginTop: 8 }}>
            {[['trucks', '10-wheelers available'], ['pilers', 'Pilers'], ['generators', 'Generators'], ['airSeps', 'Air seps'], ['sandMachines', 'Sand machines'], ['bruiseSamples', 'Bruise samples / ½ day'], ['pickers', 'Pickers']].map(([k, l]) => (
              <label key={k} className="hd-field"><span>{l}</span>{numIn(s.limits[k], (v) => up({ limits: { ...s.limits, [k]: v } }), 70, DEFAULT_LIMITS[k])}</label>
            ))}
          </div>
        </div>
      </div>

      <div className="yields-card">
        <div className="yields-card-title">Crop defaults</div>
        <div className="contracts-sub">Used for any field without its own number. Load = one 10-wheeler (sheet: 250 cwt potatoes, 12.5 tons beets).</div>
        <div className="table-scroll" style={{ marginTop: 8 }}>
          <table className="contracts-table contracts-table-auto">
            <thead><tr><th>Crop</th><th>Unit</th><th className="num">Yield / ac</th><th className="num">Goal / day</th><th className="num">Load size</th></tr></thead>
            <tbody>
              {cropList.map((c) => {
                const cur = cropSettings(s, c)
                const own = (s.crops || {})[c] || {}
                return (
                  <tr key={c}>
                    <td>{c.toLowerCase()}</td>
                    <td><select disabled={ro} value={cur.unit} onChange={(e) => setCrop(c, 'unit', e.target.value)}>{['cwt', 'tons', 'bu'].map((u) => <option key={u}>{u}</option>)}</select></td>
                    <td className="num">{numIn(own.yieldPerAcre, (v) => setCrop(c, 'yieldPerAcre', v), 80, cur.yieldPerAcre)}</td>
                    <td className="num">{numIn(own.goalPerDay, (v) => setCrop(c, 'goalPerDay', v), 80, cur.goalPerDay)}</td>
                    <td className="num">{numIn(own.loadSize, (v) => setCrop(c, 'loadSize', v), 70, cur.loadSize)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Teams</div>
            <div className="contracts-sub">Blank day length / goal = use the season and crop defaults. A later start date holds that team back.</div>
          </div>
          {canEdit && <button onClick={addTeam}>+ Add team</button>}
        </div>
        <div className="table-scroll">
          <table className="contracts-table contracts-table-auto">
            <thead><tr><th /><th>Name</th><th>Colour</th><th>Starts</th><th className="num">Day length</th><th className="num">Goal / day</th><th className="num">Fields</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {s.teams.map((t, i) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{canEdit && <><button className="clear-sort-btn" onClick={() => moveTeam(i, -1)}>↑</button><button className="clear-sort-btn" onClick={() => moveTeam(i, 1)}>↓</button></>}</td>
                  <td><input className="yields-cell-input" style={{ width: 110, textAlign: 'left' }} disabled={ro} value={t.name} onChange={(e) => setTeam(i, { name: e.target.value })} /></td>
                  <td><input type="color" disabled={ro} value={t.color} onChange={(e) => setTeam(i, { color: e.target.value })} /></td>
                  <td><input type="date" disabled={ro} value={t.startDate || ''} onChange={(e) => setTeam(i, { startDate: e.target.value || null })} /></td>
                  <td className="num">{numIn(t.dayLength, (v) => setTeam(i, { dayLength: v }), 60, s.dayLength)}</td>
                  <td className="num">{numIn(t.goalPerDay, (v) => setTeam(i, { goalPerDay: v }), 80, 'crop')}</td>
                  <td className="num">{teamCounts[t.id] || 0}</td>
                  {canEdit && <td><button className="clear-sort-btn" disabled={!!teamCounts[t.id]} title={teamCounts[t.id] ? 'Move its fields off first' : ''} onClick={() => up({ teams: s.teams.filter((_, j) => j !== i) })}>Remove</button></td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="yields-card">
        <div className="yields-card-title">Off / short days</div>
        <div className="contracts-sub">Set these by clicking a day on the Timeline. 1 = full half-day, 0 = off.</div>
        <div className="table-scroll" style={{ marginTop: 8, maxHeight: 260 }}>
          <table className="contracts-table contracts-table-auto">
            <thead><tr><th>Date</th><th>Who</th><th className="num">AM</th><th className="num">PM</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {calRows.map((r) => (
                <tr key={r.d + (r.team ? r.team.id : '')}>
                  <td>{fmtDate(r.d, true)}</td><td>{r.team ? r.team.name : 'All teams'}</td>
                  <td className="num">{r.v.AM ?? 1}</td><td className="num">{r.v.PM ?? 1}</td>
                  {canEdit && <td><button className="clear-sort-btn" onClick={() => dropCal(r)}>Remove</button></td>}
                </tr>
              ))}
              {!calRows.length && <tr><td colSpan={5} className="contracts-sub">None — every day is a full working day{s.sundaysOff ? ' except Sundays' : ''}.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
