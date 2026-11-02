import { useMemo, useState } from 'react'
import { balanceAssign, fmtDays, fmtN, fmtSlot } from './harvestMath.js'
import { paceChip } from './Harvest.jsx'

// Schedule board: the unscheduled fields on the left (filter by crop / farm
// / search), one column per team on the right. Drag a field into a team's
// line, drag within a line to re-order, drag between teams, or drag back to
// the left to take it off the schedule. Tick several on the left and drag
// any one of them to move the lot. On a phone/tablet use the tick boxes +
// "Add to team", or open a card to move it.

const CROP_TINT = { POTATO: '#D6B48C', BEETS: '#C9B8EE', ONIONS: '#F4C0D1', CORN: '#FCE9A8', 'MINI POTATOES': '#E8CFAE' }

export default function HarvestBoard({ allFields, schedule, settings, canEdit, writes, onOpen }) {
  const [crop, setCrop] = useState('default')
  const [farm, setFarm] = useState('all')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState('name')
  const [sel, setSel] = useState(() => new Set())
  const [bulkTeam, setBulkTeam] = useState('')
  const [drag, setDrag] = useState(null) // { keys: [...], from }
  const [dropAt, setDropAt] = useState(null) // { teamId, beforeKey } | { pool: true }
  const [fillOpen, setFillOpen] = useState(false)
  const [fillTeams, setFillTeams] = useState(() => new Set())
  const [custom, setCustom] = useState({ name: '', crop: 'POTATO', acres: '' })

  const pool = allFields.filter((f) => !f.teamId && f.kind !== 'block')
  const cropCounts = useMemo(() => {
    const m = {}
    pool.forEach((f) => { m[f.crop] = (m[f.crop] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [pool])
  // Default to the harvest crops when they're there, otherwise everything.
  const harvestCrops = cropCounts.filter(([c]) => ['POTATO', 'BEETS', 'ONIONS', 'MINI POTATOES'].includes(c)).map(([c]) => c)
  const cropSet = crop === 'default' ? (harvestCrops.length ? new Set(harvestCrops) : null) : crop === 'all' ? null : new Set([crop])
  const farms = [...new Set(pool.map((f) => f.farmName).filter(Boolean))].sort()

  const shown = pool
    .filter((f) => !cropSet || cropSet.has(f.crop))
    .filter((f) => farm === 'all' || f.farmName === farm)
    .filter((f) => !q || `${f.name} ${f.variety || ''} ${f.farmName || ''} ${f.contract || ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => sort === 'acres' ? b.acres - a.acres
      : sort === 'farm' ? (a.farmName || '').localeCompare(b.farmName || '') || a.name.localeCompare(b.name, undefined, { numeric: true })
        : sort === 'variety' ? (a.variety || '').localeCompare(b.variety || '') || a.name.localeCompare(b.name, undefined, { numeric: true })
          : a.name.localeCompare(b.name, undefined, { numeric: true }))
  const shownAcres = shown.reduce((s, f) => s + f.acres, 0)

  const toggle = (k) => setSel((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const allShownSelected = shown.length > 0 && shown.every((f) => sel.has(f.key))

  // ---- drag & drop ---------------------------------------------------------
  function startDrag(e, f, from) {
    if (!canEdit) return
    const keys = from === 'pool' && sel.has(f.key) && sel.size > 1 ? shown.filter((x) => sel.has(x.key)).map((x) => x.key) : [f.key]
    setDrag({ keys, from })
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', keys.join(',')) } catch { /* some browsers */ }
  }
  function endDrag() { setDrag(null); setDropAt(null) }
  function overCard(e, teamId, rows, i) {
    if (!drag) return
    e.preventDefault(); e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > r.top + r.height / 2
    const beforeKey = after ? (rows[i + 1] ? rows[i + 1].key : null) : rows[i].key
    if (!dropAt || dropAt.teamId !== teamId || dropAt.beforeKey !== beforeKey) setDropAt({ teamId, beforeKey })
  }
  function overLane(e, teamId) {
    if (!drag) return
    e.preventDefault()
    if (!dropAt || dropAt.teamId !== teamId) setDropAt({ teamId, beforeKey: null })
  }
  function dropLane(e, teamId) {
    e.preventDefault()
    if (!drag) return
    const beforeKey = dropAt && dropAt.teamId === teamId ? dropAt.beforeKey : null
    if (!drag.keys.includes(beforeKey)) writes.moveField(drag.keys, teamId, beforeKey)
    if (drag.keys.length > 1) setSel(new Set())
    endDrag()
  }
  function dropPool(e) {
    e.preventDefault()
    if (drag && drag.from !== 'pool') {
      const blocks = drag.keys.filter((k) => (allFields.find((x) => x.key === k) || {}).kind === 'block')
      blocks.forEach((k) => writes.removeField(k))
      const rest = drag.keys.filter((k) => !blocks.includes(k))
      if (rest.length) writes.moveField(rest, null)
    }
    endDrag()
  }

  function autoFill() {
    const teams = [...fillTeams]
    if (!teams.length || !shown.length) return
    const loads = Object.fromEntries(teams.map((t) => [t, schedule.teams[t] ? schedule.teams[t].totalDays - schedule.teams[t].doneDays : 0]))
    const pairs = balanceAssign(shown, loads, settings)
    writes.assignMany(pairs)
    setFillOpen(false)
  }

  return (
    <div className="harvest-board">
      <div className={`hb-pool${drag && drag.from !== 'pool' ? ' drop-ok' : ''}`} onDragOver={(e) => { if (drag && drag.from !== 'pool') e.preventDefault() }} onDrop={dropPool}>
        <div className="hb-pool-head">
          <div className="yields-card-title">Unscheduled fields</div>
          <div className="contracts-sub">{shown.length} shown · {fmtN(shownAcres)} ac{drag && drag.from !== 'pool' ? ' — drop here to take off the schedule' : ''}</div>
        </div>
        <div className="hb-crops">
          <button className={crop === 'default' ? 'active' : ''} onClick={() => setCrop('default')} title="Potatoes, beets and onions">Harvest crops</button>
          {cropCounts.map(([c, n]) => (
            <button key={c} className={crop === c ? 'active' : ''} onClick={() => setCrop(c)}>
              <i style={{ background: CROP_TINT[c] || '#D3D1C7' }} />{c.toLowerCase()} <span>{n}</span>
            </button>
          ))}
          <button className={crop === 'all' ? 'active' : ''} onClick={() => setCrop('all')}>All</button>
        </div>
        <div className="hb-pool-tools">
          <input className="agronomy-search-input" placeholder="Search field, variety, farm…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={farm} onChange={(e) => setFarm(e.target.value)}>
            <option value="all">All farms</option>
            {farms.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="name">Sort: name</option><option value="farm">Sort: farm</option>
            <option value="variety">Sort: variety</option><option value="acres">Sort: acres</option>
          </select>
        </div>
        {canEdit && (
          <div className="hb-pool-tools">
            <label className="hb-check"><input type="checkbox" checked={allShownSelected} onChange={() => setSel(allShownSelected ? new Set() : new Set(shown.map((f) => f.key)))} /> All</label>
            <select value={bulkTeam} onChange={(e) => setBulkTeam(e.target.value)}>
              <option value="">Add {sel.size || ''} ticked to…</option>
              {settings.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
            <button className="save" disabled={!sel.size || !bulkTeam} onClick={() => { writes.addMany(shown.filter((f) => sel.has(f.key)).map((f) => f.key), bulkTeam); setSel(new Set()) }}>Add</button>
            <button onClick={() => setFillOpen((o) => !o)} title="Spread the shown fields across teams so they finish about the same day">Auto-fill…</button>
          </div>
        )}
        {fillOpen && (
          <div className="hb-fill">
            <div className="contracts-sub" style={{ marginTop: 0 }}>Spread the {shown.length} shown field{shown.length === 1 ? '' : 's'} across these teams so they finish as evenly as possible (biggest fields first). Fields go on the end of each line — re-order after.</div>
            <div className="hb-fill-teams">
              {settings.teams.map((t) => (
                <label key={t.id} className="hb-check"><input type="checkbox" checked={fillTeams.has(t.id)} onChange={() => setFillTeams((s) => { const n = new Set(s); n.has(t.id) ? n.delete(t.id) : n.add(t.id); return n })} /><i style={{ background: t.color }} />{t.name}</label>
              ))}
            </div>
            <button className="save" disabled={!fillTeams.size || !shown.length} onClick={autoFill}>Fill {fillTeams.size} team{fillTeams.size === 1 ? '' : 's'}</button>
          </div>
        )}
        <div className="hb-pool-list">
          {shown.map((f) => (
            <div key={f.key} className={`hb-card pool${sel.has(f.key) ? ' sel' : ''}${drag && drag.keys.includes(f.key) ? ' dragging' : ''}`}
              draggable={canEdit} onDragStart={(e) => startDrag(e, f, 'pool')} onDragEnd={endDrag} onClick={() => onOpen(f.key)}>
              {canEdit && <input type="checkbox" checked={sel.has(f.key)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(f.key)} />}
              <span className="hb-crop-dot" style={{ background: CROP_TINT[f.crop] || '#D3D1C7' }} />
              <div className="hb-card-main">
                <div className="hb-card-name">{f.name}{f.source === 'custom' && <span className="hb-tag">not in Agworld</span>}</div>
                <div className="hb-card-sub">{[f.variety, f.farmName, f.contract].filter(Boolean).join(' · ') || f.crop.toLowerCase()}</div>
              </div>
              <div className="hb-card-num">{fmtN(f.acres)} ac</div>
            </div>
          ))}
          {!shown.length && <div className="contracts-sub" style={{ padding: 10 }}>{pool.length ? 'No unscheduled fields match.' : 'Every field is on a team.'}</div>}
        </div>
        {canEdit && (
          <div className="hb-custom">
            <div className="agronomy-section-label" style={{ marginTop: 6 }}>Field not in Agworld?</div>
            <div className="hb-pool-tools">
              <input className="yields-cell-input" style={{ width: 130, textAlign: 'left' }} placeholder="Name" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} />
              <select value={custom.crop} onChange={(e) => setCustom({ ...custom, crop: e.target.value })}>
                {['POTATO', 'BEETS', 'ONIONS', 'MINI POTATOES'].map((c) => <option key={c} value={c}>{c.toLowerCase()}</option>)}
              </select>
              <input className="yields-cell-input" style={{ width: 60 }} placeholder="Acres" inputMode="decimal" value={custom.acres} onChange={(e) => setCustom({ ...custom, acres: e.target.value })} />
              <button disabled={!custom.name.trim()} onClick={() => writes.addCustom(custom.name.trim(), custom.crop, custom.acres).then(() => setCustom({ ...custom, name: '', acres: '' }))}>Add</button>
            </div>
          </div>
        )}
      </div>

      <div className="hb-lanes">
        {settings.teams.map((team) => {
          const t = schedule.teams[team.id]
          const rows = t ? t.rows : []
          const chip = t ? paceChip(t) : { cls: 'idle', text: '' }
          const isDropLane = dropAt && dropAt.teamId === team.id
          return (
            <div key={team.id} className={`hb-lane${isDropLane ? ' drop-ok' : ''}`} style={{ '--team': team.color }}
              onDragOver={(e) => overLane(e, team.id)} onDrop={(e) => dropLane(e, team.id)}>
              <div className="hb-lane-head">
                <div className="hb-lane-title"><i style={{ background: team.color }} />{team.name}<span className={`hb-pace ${chip.cls}`}>{chip.text}</span></div>
                <div className="contracts-sub" style={{ marginTop: 2 }}>
                  {rows.filter((r) => r.kind !== 'block').length} fields · {fmtN(t ? t.acres : 0)} ac · {fmtDays(t ? t.totalDays : 0)}
                </div>
                <div className="contracts-sub" style={{ marginTop: 0 }}>Finish {t && t.finishSlot != null ? fmtSlot(schedule.startDate, Math.ceil(t.finishSlot) - 1, true) : '—'}</div>
                <div className="hb-lane-bar"><div style={{ width: `${Math.min(100, (t ? t.pct : 0) * 100)}%` }} /></div>
              </div>
              <div className="hb-lane-list">
                {rows.map((r, i) => (
                  <div key={r.key}>
                    {isDropLane && dropAt.beforeKey === r.key && <div className="hb-drop-line" />}
                    <LaneCard r={r} startDate={schedule.startDate} canEdit={canEdit} dragging={drag && drag.keys.includes(r.key)}
                      onDragStart={(e) => startDrag(e, r, team.id)} onDragEnd={endDrag} onDragOver={(e) => overCard(e, team.id, rows, i)}
                      onClick={() => onOpen(r.key)} />
                  </div>
                ))}
                {isDropLane && dropAt.beforeKey == null && <div className="hb-drop-line" />}
                {!rows.length && <div className="hb-empty">Drag fields here</div>}
              </div>
              {canEdit && (
                <div className="hb-lane-foot">
                  <button className="clear-sort-btn" onClick={() => writes.addBlock(team.id, 'Move day', 1)} title="Adds a 1-day move block to the end of the line — drag it where it belongs">+ Move day</button>
                  <button className="clear-sort-btn" onClick={() => writes.addBlock(team.id, 'Down time', 0.5)}>+ Down ½ day</button>
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function LaneCard({ r, startDate, canEdit, dragging, onDragStart, onDragEnd, onDragOver, onClick }) {
  const block = r.kind === 'block'
  return (
    <div className={`hb-card lane ${r.status}${block ? ' block' : ''}${dragging ? ' dragging' : ''}`} draggable={canEdit}
      onDragStart={onDragStart} onDragEnd={onDragEnd} onDragOver={onDragOver} onClick={onClick}>
      {!block && <span className="hb-crop-dot" style={{ background: CROP_TINT[r.crop] || '#D3D1C7' }} />}
      <div className="hb-card-main">
        <div className="hb-card-name">
          {r.name}
          {r.status === 'done' && <span className="hb-tag done">done</span>}
          {r.status === 'active' && <span className="hb-tag active">{Math.round(r.pct * 100)}%</span>}
          {r.killStatus === 'overdue' && <span className="hb-tag warn" title={`Kill date was ${r.killDate}`}>kill overdue</span>}
          {r.killStatus === 'soon' && <span className="hb-tag soon" title={`Kill by ${r.killDate}`}>kill {r.killDate.slice(5).replace('-', '/')}</span>}
          {r.source === 'missing' && <span className="hb-tag warn">not in Agworld this season</span>}
        </div>
        <div className="hb-card-sub">
          {block ? `${fmtDays(r.days)}` : `${r.variety || r.crop.toLowerCase()} · ${fmtN(r.acres)} ac · ${fmtN(r.total)} ${r.unit} · ${fmtDays(r.days)}`}
        </div>
        <div className="hb-card-when">
          {r.startSlot != null ? fmtSlot(startDate, r.startSlot) : '—'} → {r.endSlot != null ? fmtSlot(startDate, Math.ceil(r.endSlot) - 1) : '—'}
          {r.trucks != null && !block && <span title="10-wheelers needed"> · {r.trucks} trucks</span>}
        </div>
        {r.status === 'active' && <div className="hb-mini-bar"><div style={{ width: `${r.pct * 100}%` }} /></div>}
      </div>
    </div>
  )
}

export { CROP_TINT }
