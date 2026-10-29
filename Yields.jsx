import { useEffect, useMemo, useRef, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import {
  Area, Bar, BarChart, CartesianGrid, ComposedChart, Legend, Line, ReferenceLine,
  ResponsiveContainer, Scatter, ScatterChart, Tooltip, XAxis, YAxis, ZAxis, Cell, LabelList
} from 'recharts'
import { db } from './firebase.js'
import YieldImport from './YieldImport.jsx'
import { MAX_SERIES, SERIES, dayOfYear, doyLabel, effectiveYield, fmt, groupBy, summarize, unitFor } from './yieldMath.js'

// Yield History module. History comes from the team's yield workbook
// (imported on the Import tab); new seasons come in from Agworld's
// harvested weight/area through the nightly syncAgworldFields job (see
// functions/index.js). Both land in yieldHistory/{FIELDKEY}__{YEAR}.
//
// Read: Admin, Owner, Farm manager (firestore.rules). Import: Admin/Owner.

const CROP_COLOR = {
  POTATO: { bg: '#D6B48C', fg: '#4A2E12' }, 'MINI POTATOES': { bg: '#E8CDA9', fg: '#4A2E12' },
  CORN: { bg: '#FCE9A8', fg: '#7A5C02' }, 'SWEET CORN': { bg: '#FCE9A8', fg: '#7A5C02' },
  HAY: { bg: '#C0DD97', fg: '#173404' }, BEETS: { bg: '#E0D6F5', fg: '#3D2B6B' },
  FALLOW: { bg: '#E4E1D8', fg: '#5A574C' }, ONIONS: { bg: '#F4C0D1', fg: '#4B1528' },
  MINT: { bg: '#9FE1CB', fg: '#04342C' }, CARROTS: { bg: '#FAD9BB', fg: '#7A3E0A' },
  BEANS: { bg: '#D9E7F5', fg: '#1C3D5E' }, BARLEY: { bg: '#EFE3C2', fg: '#5E4A12' },
  'SMALL GRAIN': { bg: '#EFE3C2', fg: '#5E4A12' }, RYE: { bg: '#E6DDC6', fg: '#4F4630' },
  MELONS: { bg: '#CDEBC6', fg: '#1F4A16' }, PUMPKINS: { bg: '#F5C98A', fg: '#6B3D02' }
}
const cropColor = (c) => CROP_COLOR[c] || { bg: '#D3D1C7', fg: '#2C2C2A' }
function CropBadge({ crop }) {
  if (!crop) return <span className="contracts-sub">—</span>
  const c = cropColor(crop)
  return <span className="crop-badge" style={{ background: c.bg, color: c.fg }}>{crop}</span>
}

const INK = '#2b2b26', INK2 = '#52514e', MUTED = '#888', GRID = '#ebe7dc'
const AVG_COLOR = INK2

const DIMENSIONS = {
  variety: { label: 'Variety', get: (r) => r.variety },
  area: { label: 'Area', get: (r) => r.area },
  manager: { label: 'Manager', get: (r) => r.manager },
  previousCrop: { label: 'Previous crop', get: (r) => r.previousCrop },
  irrigation: { label: 'Irrigation', get: (r) => r.irrigation }
}

const SCATTER_X = {
  plantDoy: { label: 'Plant date', fmt: doyLabel },
  harvestDoy: { label: 'Harvest date', fmt: doyLabel },
  seedSpacing: { label: 'Seed spacing (in)', fmt: (v) => fmt(v, 1) },
  elevation: { label: 'Elevation (ft)', fmt: (v) => fmt(v) },
  acres: { label: 'Field acres', fmt: (v) => fmt(v) },
  standCount: { label: 'Stand count', fmt: (v) => fmt(v) },
  tareFactor: { label: 'Tare factor', fmt: (v) => fmt(v * 100, 1) + '%' },
  dryMatterSugar: { label: 'Dry matter / sugar', fmt: (v) => (v < 1 ? fmt(v * 100, 1) + '%' : fmt(v, 2)) },
  year: { label: 'Year', fmt: (v) => String(v) }
}

/* ------------------------------------------------------------------ */
/* Small building blocks                                              */
/* ------------------------------------------------------------------ */

function useOutsideClose(open, setOpen) {
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [open, setOpen])
  return ref
}

// Excel-style checklist dropdown: options keep their place as you tick them.
function FilterMenu({ label, options, value, onChange, width = 230 }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useOutsideClose(open, setOpen)
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()))
  const summary = value.length === 0 ? '' : value.length === 1 ? `: ${(options.find((o) => o.value === value[0]) || { label: value[0] }).label}` : `: ${value.length}`
  return (
    <div className="yields-menu" ref={ref}>
      <button className={value.length ? 'active' : ''} onClick={() => setOpen((o) => !o)}>{label}{summary} ▾</button>
      {open && (
        <div className="sort-menu yields-menu-panel" style={{ width }}>
          {options.length > 8 && <input className="yields-menu-search" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />}
          <div className="sort-menu-checklist">
            {shown.map((o) => (
              <label key={o.value}>
                <input type="checkbox" checked={value.includes(o.value)}
                  onChange={() => onChange(value.includes(o.value) ? value.filter((v) => v !== o.value) : [...value, o.value])} />
                <span style={{ flex: 1 }}>{o.label}</span>
                {o.count != null && <span className="yields-count">{o.count}</span>}
              </label>
            ))}
            {shown.length === 0 && <span className="contracts-sub">No matches</span>}
          </div>
          {value.length > 0 && <button onClick={() => onChange([])} style={{ width: '100%' }}>Clear</button>}
        </div>
      )}
    </div>
  )
}

function ChartTip({ active, payload, label, unit, labelFmt }) {
  if (!active || !payload || !payload.length) return null
  const rows = payload.filter((p) => p.value != null && p.dataKey !== 'band')
  const band = payload.find((p) => p.dataKey === 'band')
  return (
    <div className="yields-tip">
      <div className="yields-tip-title">{labelFmt ? labelFmt(label) : label}</div>
      {rows.map((p) => (
        <div key={p.dataKey} className="yields-tip-row">
          <i style={{ background: p.color || p.stroke || p.fill }} />
          <span>{p.name}</span>
          <strong>{fmt(p.value, 0)}</strong>
        </div>
      ))}
      {band && band.value && <div className="yields-tip-row muted"><i /><span>Range</span><span>{fmt(band.value[0])}–{fmt(band.value[1])}</span></div>}
      {payload[0] && payload[0].payload && payload[0].payload.n != null && <div className="yields-tip-row muted"><i /><span>Fields</span><span>{payload[0].payload.n}</span></div>}
      <div className="yields-tip-unit">{unit}/ac</div>
    </div>
  )
}

// Legend that skips the shaded range band (it's explained in the subtitle).
function LegendRow({ payload }) {
  return (
    <div className="yields-legend">
      {(payload || []).filter((p) => p.dataKey !== 'band').map((p) => (
        <span key={p.dataKey}>
          <i style={{ background: p.color, ...(p.payload && p.payload.strokeDasharray ? { background: 'none', borderTop: `2px dashed ${p.color}`, height: 0 } : {}) }} />{p.value}
        </span>
      ))}
    </div>
  )
}

function Kpi({ label, value, unit, sub }) {
  return (
    <div className="agronomy-kpi-card">
      <p className="agronomy-kpi-label">{label}</p>
      <p className="agronomy-kpi-value">{value} {unit && <span className="agronomy-kpi-unit">{unit}</span>}</p>
      {sub && <p className="contracts-sub" style={{ margin: '2px 0 0' }}>{sub}</p>}
    </div>
  )
}

function toCsv(rows, cols) {
  const esc = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s }
  return [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(c.csv ? c.csv(r) : r[c.key])).join(','))].join('\n')
}
function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob); a.download = name; a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}

/* ------------------------------------------------------------------ */
/* Module                                                             */
/* ------------------------------------------------------------------ */

export default function Yields({ userRole }) {
  const canImport = userRole === 'admin' || userRole === 'owner'
  const [docs, setDocs] = useState(null)
  const [error, setError] = useState(null)
  const [view, setView] = useState('trends')

  const [crop, setCrop] = useState('POTATO')
  const [yearFrom, setYearFrom] = useState(null)
  const [yearTo, setYearTo] = useState(null)
  const [dims, setDims] = useState({ variety: [], area: [], manager: [], previousCrop: [], irrigation: [] })
  const [selFields, setSelFields] = useState([]) // fieldKeys, in the order picked (keeps each field's color)
  const [includeLeased, setIncludeLeased] = useState(false)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'yieldHistory'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setDocs(list); setError(null)
    }, (e) => setError(e.code === 'permission-denied'
      ? 'No permission to read yield history. If this is the first time the module has been opened, the new firestore.rules may not be deployed yet.'
      : e.message))
    return () => unsub()
  }, [])

  // One shape for every record, whether it came from the workbook, Agworld,
  // or both (workbook values win; Agworld fills gaps).
  const records = useMemo(() => (docs || []).map((d) => {
    const ag = d.agworld || {}
    const c = d.crop || ag.crop || null
    const ey = effectiveYield(d)
    const harvestDate = d.harvestDate || ag.harvestDate || null
    return {
      ...d,
      crop: c,
      fieldName: d.fieldName || ag.fieldName || d.fieldKey,
      variety: d.variety || ag.variety || null,
      acres: d.acres != null ? d.acres : (ag.harvestedArea != null ? ag.harvestedArea : null),
      area: d.area || ag.farmName || null,
      harvestDate,
      harvestDoy: d.harvestDoy != null ? d.harvestDoy : dayOfYear(harvestDate),
      unit: d.unit || unitFor(c),
      _yield: ey.value,
      _source: ey.source
    }
  }), [docs])

  const allYears = useMemo(() => [...new Set(records.map((r) => r.year))].filter(Boolean).sort((a, b) => a - b), [records])
  const yFrom = yearFrom || allYears[0]
  const yTo = yearTo || allYears[allYears.length - 1]

  const cropOptions = useMemo(() => {
    const m = {}
    records.forEach((r) => { if (r.crop && r._yield > 0) m[r.crop] = (m[r.crop] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [records])

  // Everything for the crop + years, before the dimension/field filters.
  // Option lists come from here so a checklist doesn't shrink as you tick it.
  const cropRecs = useMemo(() => records.filter((r) => (crop === 'all' || r.crop === crop)
    && r.year >= yFrom && r.year <= yTo && (includeLeased || !r.leasedOut)), [records, crop, yFrom, yTo, includeLeased])

  const dimOptions = useMemo(() => {
    const out = {}
    Object.entries(DIMENSIONS).forEach(([k, d]) => {
      const m = {}
      cropRecs.forEach((r) => { const v = d.get(r); if (v) m[v] = (m[v] || 0) + 1 })
      out[k] = Object.entries(m).sort((a, b) => b[1] - a[1]).map(([v, n]) => ({ value: v, label: v, count: n }))
    })
    return out
  }, [cropRecs])

  const fieldOptions = useMemo(() => {
    const m = {}
    cropRecs.forEach((r) => {
      const e = (m[r.fieldKey] = m[r.fieldKey] || { value: r.fieldKey, label: r.fieldName, count: 0 })
      if (r._yield > 0) e.count++
    })
    return Object.values(m).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }))
  }, [cropRecs])
  const fieldNameByKey = useMemo(() => {
    const m = {}
    records.forEach((r) => { if (!m[r.fieldKey]) m[r.fieldKey] = r.fieldName })
    return m
  }, [records])

  // "base" = all filters except the field picker. Averages are drawn from
  // here so a selected field is always compared against its peers.
  const base = useMemo(() => cropRecs.filter((r) => Object.entries(dims).every(([k, vals]) => vals.length === 0 || vals.includes(DIMENSIONS[k].get(r)))),
    [cropRecs, dims])
  const focus = useMemo(() => (selFields.length ? base.filter((r) => selFields.includes(r.fieldKey)) : base), [base, selFields])

  const unit = crop === 'all' ? 'units' : unitFor(crop)
  const activeFilterCount = Object.values(dims).reduce((s, v) => s + v.length, 0) + selFields.length + (yearFrom || yearTo ? 1 : 0)

  function clearAll() {
    setDims({ variety: [], area: [], manager: [], previousCrop: [], irrigation: [] })
    setSelFields([]); setYearFrom(null); setYearTo(null)
  }

  const existingById = useMemo(() => Object.fromEntries((docs || []).map((d) => [d.id, true])), [docs])

  if (docs === null && !error) return <div className="agronomy"><p className="contracts-empty">Loading yield history…</p></div>

  const empty = records.length === 0

  return (
    <div className="agronomy yields">
      <div className="agronomy-view-toggle" style={{ flexWrap: 'wrap' }}>
        {[['trends', 'Trends'], ['field', 'Field history'], ['compare', 'Compare'], ['records', 'Records']].map(([k, l]) => (
          <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)} disabled={empty}>{l}</button>
        ))}
        {canImport && <button className={view === 'import' ? 'active' : ''} onClick={() => setView('import')}>Import</button>}
      </div>

      {error && <div className="agronomy-error-banner">{error}</div>}

      {empty && view !== 'import' && (
        <div className="editor-panel">
          <div className="editor-field-name">No yield history yet</div>
          <p className="contracts-sub">{canImport ? 'Open the Import tab and upload THE Yield Database workbook to load the history. New harvests will then arrive from Agworld automatically.' : 'An Admin or Owner needs to import the yield workbook first.'}</p>
          {canImport && <button className="save" onClick={() => setView('import')}>Go to Import</button>}
        </div>
      )}

      {view === 'import' && canImport && <YieldImport existingById={existingById} />}

      {!empty && view !== 'import' && view !== 'field' && (
        <div className="yields-filters">
          <select value={crop} onChange={(e) => { setCrop(e.target.value); setSelFields([]); setDims({ variety: [], area: [], manager: [], previousCrop: [], irrigation: [] }) }}>
            {cropOptions.map(([c, n]) => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()} ({n})</option>)}
            {view === 'records' && <option value="all">All crops</option>}
          </select>
          <span className="yields-years">
            <select value={yFrom || ''} onChange={(e) => setYearFrom(Number(e.target.value))}>
              {allYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <span>–</span>
            <select value={yTo || ''} onChange={(e) => setYearTo(Number(e.target.value))}>
              {allYears.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
          </span>
          <FilterMenu label="Fields" options={fieldOptions} value={selFields} width={260}
            onChange={(v) => setSelFields(v.slice(0, 40))} />
          {Object.entries(DIMENSIONS).map(([k, d]) => (
            <FilterMenu key={k} label={d.label} options={dimOptions[k]} value={dims[k]} onChange={(v) => setDims({ ...dims, [k]: v })} />
          ))}
          <label className="yields-check"><input type="checkbox" checked={includeLeased} onChange={(e) => setIncludeLeased(e.target.checked)} /> Leased out</label>
          {activeFilterCount > 0 && <button className="clear-sort-btn" onClick={clearAll}>Clear filters</button>}
        </div>
      )}

      {!empty && selFields.length > 0 && view !== 'import' && view !== 'field' && (
        <div className="yields-chips">
          {selFields.map((k, i) => (
            <span key={k} className="yields-chip">
              <i style={{ background: i < MAX_SERIES ? SERIES[i] : MUTED }} />{fieldNameByKey[k] || k}
              <button aria-label={`Remove ${fieldNameByKey[k]}`} onClick={() => setSelFields(selFields.filter((x) => x !== k))}>×</button>
            </span>
          ))}
          {selFields.length > MAX_SERIES && <span className="contracts-sub">Only the first {MAX_SERIES} fields get their own line; the rest still count in KPIs and tables.</span>}
        </div>
      )}

      {!empty && view === 'trends' && <TrendsView base={base} focus={focus} selFields={selFields} fieldNameByKey={fieldNameByKey} unit={unit} crop={crop} yFrom={yFrom} yTo={yTo} />}
      {!empty && view === 'field' && <FieldHistoryView records={records} fieldNameByKey={fieldNameByKey} initialKey={selFields[0]} includeLeased={includeLeased} preferCrop={crop} />}
      {!empty && view === 'compare' && <CompareView base={base} focus={focus} selFields={selFields} fieldNameByKey={fieldNameByKey} unit={unit} />}
      {!empty && view === 'records' && <RecordsView rows={focus} />}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Trends                                                             */
/* ------------------------------------------------------------------ */

function TrendsView({ base, focus, selFields, fieldNameByKey, unit, crop, yFrom, yTo }) {
  const [lines, setLines] = useState('overall') // overall | variety | area | manager | previousCrop | irrigation
  const fieldMode = selFields.length > 0
  const shownFields = selFields.slice(0, MAX_SERIES)

  // Top groups by acres, colored in fixed order.
  const groups = useMemo(() => {
    if (fieldMode || lines === 'overall') return []
    const g = groupBy(base.filter((r) => r._yield > 0), DIMENSIONS[lines].get)
    return [...g.entries()].map(([k, rs]) => ({ key: k, acres: rs.reduce((s, r) => s + (r.acres || 0), 0) }))
      .sort((a, b) => b.acres - a.acres).slice(0, MAX_SERIES).map((x) => x.key)
  }, [base, lines, fieldMode])

  const data = useMemo(() => {
    const byYear = groupBy(base, (r) => r.year)
    const out = []
    for (let y = yFrom; y <= yTo; y++) {
      const rs = byYear.get(y) || []
      const s = summarize(rs)
      const row = { year: y, avg: s.avg, n: s.n, acres: s.acres, band: s.n > 1 ? [s.min, s.max] : null, min: s.min, max: s.max }
      shownFields.forEach((k) => { row['f_' + k] = summarize(rs.filter((r) => r.fieldKey === k)).avg })
      groups.forEach((g, i) => { row['g_' + i] = summarize(rs.filter((r) => DIMENSIONS[lines].get(r) === g)).avg })
      out.push(row)
    }
    // Trim empty years at either end so the axis doesn't run into blank space.
    let a = 0, b = out.length - 1
    while (a <= b && out[a].avg == null) a++
    while (b >= a && out[b].avg == null) b--
    return out.slice(a, b + 1)
  }, [base, yFrom, yTo, shownFields, groups, lines])

  const sAll = summarize(focus)
  const withAvg = data.filter((d) => d.avg != null)
  const best = withAvg.reduce((m, d) => (!m || d.avg > m.avg ? d : m), null)
  const last = withAvg[withAvg.length - 1]
  const prior5 = withAvg.filter((d) => last && d.year < last.year && d.year >= last.year - 5)
  const prior5Avg = prior5.length ? prior5.reduce((s, d) => s + d.avg, 0) / prior5.length : null
  const delta = last && prior5Avg ? ((last.avg - prior5Avg) / prior5Avg) * 100 : null

  if (crop === 'all') return <p className="contracts-empty">Pick one crop to chart — yield units differ by crop.</p>

  return (
    <>
      <div className="agronomy-kpi-grid">
        <Kpi label={fieldMode ? 'Selected field-years' : 'Field-years with yield'} value={fmt(sAll.n)} sub={`${fmt(sAll.acres)} ac`} />
        <Kpi label={fieldMode ? 'Selected fields avg' : 'Acre-weighted avg'} value={fmt(sAll.avg)} unit={`${unit}/ac`}
          sub={fieldMode ? `All fields: ${fmt(summarize(base).avg)} ${unit}/ac` : `Range ${fmt(sAll.min)}–${fmt(sAll.max)}`} />
        <Kpi label="Best year (all fields)" value={best ? best.year : '—'} sub={best ? `${fmt(best.avg)} ${unit}/ac` : null} />
        <Kpi label={last ? `${last.year} vs prior 5 yrs` : 'Latest year'} value={delta == null ? '—' : `${delta > 0 ? '+' : ''}${fmt(delta, 1)}%`}
          sub={last ? `${fmt(last.avg)} vs ${fmt(prior5Avg)} ${unit}/ac` : null} />
      </div>

      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">{crop.charAt(0) + crop.slice(1).toLowerCase()} yield by year</div>
            <div className="contracts-sub">{fieldMode ? 'Selected fields vs. the acre-weighted average of every field matching the filters' : 'Acre-weighted average; shaded band = lowest to highest field'}</div>
          </div>
          {!fieldMode && (
            <select value={lines} onChange={(e) => setLines(e.target.value)}>
              <option value="overall">One line: all fields</option>
              {Object.entries(DIMENSIONS).map(([k, d]) => <option key={k} value={k}>Line per {d.label.toLowerCase()}</option>)}
            </select>
          )}
        </div>
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={data} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="year" tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={{ stroke: GRID }} />
            <YAxis tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => fmt(v)} />
            <Tooltip content={<ChartTip unit={unit} />} cursor={{ stroke: '#ccc', strokeDasharray: '3 3' }} />
            {(lines === 'overall' || fieldMode) && (
              <Area type="monotone" dataKey="band" name="Range" fill={SERIES[0]} fillOpacity={fieldMode ? 0.06 : 0.12} stroke="none" isAnimationActive={false} legendType="none" activeDot={false} connectNulls />
            )}
            {lines === 'overall' && !fieldMode && (
              <Line isAnimationActive={false} type="monotone" dataKey="avg" name="All fields (avg)" stroke={SERIES[0]} strokeWidth={2.5} dot={{ r: 3.5, strokeWidth: 0, fill: SERIES[0] }} activeDot={{ r: 5 }} connectNulls />
            )}
            {fieldMode && (
              <Line isAnimationActive={false} type="monotone" dataKey="avg" name="All fields (avg)" stroke={AVG_COLOR} strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls />
            )}
            {shownFields.map((k, i) => (
              <Line isAnimationActive={false} key={k} type="linear" dataKey={'f_' + k} name={fieldNameByKey[k] || k} stroke={SERIES[i]} strokeWidth={2}
                dot={{ r: 4.5, strokeWidth: 2, stroke: '#fff', fill: SERIES[i] }} activeDot={{ r: 6 }} connectNulls />
            ))}
            {!fieldMode && groups.map((g, i) => (
              <Line isAnimationActive={false} key={g} type="monotone" dataKey={'g_' + i} name={g} stroke={SERIES[i]} strokeWidth={2} dot={{ r: 3, strokeWidth: 0, fill: SERIES[i] }} connectNulls />
            ))}
            {(fieldMode || groups.length > 0 || lines === 'overall') && <Legend content={<LegendRow />} />}
          </ComposedChart>
        </ResponsiveContainer>
        {fieldMode && <p className="contracts-hint" style={{ margin: '4px 0 0' }}>Lines connect the years each field was in {crop.toLowerCase()} — gaps between dots are rotation years.</p>}
      </div>

      <details className="yields-table-toggle">
        <summary>Year-by-year table</summary>
        <div className="table-scroll" style={{ maxHeight: 360 }}>
          <table className="contracts-table">
            <thead>
              <tr>
                <th>Year</th><th className="num">Fields</th><th className="num">Acres</th><th className="num">Avg</th><th className="num">Low</th><th className="num">High</th>
                {shownFields.map((k) => <th key={k} className="num">{fieldNameByKey[k]}</th>)}
                {groups.map((g) => <th key={g} className="num">{g}</th>)}
              </tr>
            </thead>
            <tbody>
              {[...data].reverse().map((d) => (
                <tr key={d.year}>
                  <td><strong>{d.year}</strong></td><td className="num">{d.n}</td><td className="num">{fmt(d.acres)}</td>
                  <td className="num"><strong>{fmt(d.avg)}</strong></td><td className="num">{fmt(d.min)}</td><td className="num">{fmt(d.max)}</td>
                  {shownFields.map((k) => <td key={k} className="num">{fmt(d['f_' + k])}</td>)}
                  {groups.map((g, i) => <td key={g} className="num">{fmt(d['g_' + i])}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Field history                                                      */
/* ------------------------------------------------------------------ */

function FieldHistoryView({ records, fieldNameByKey, initialKey, includeLeased, preferCrop }) {
  const [key, setKey] = useState(initialKey || null)
  const [q, setQ] = useState('')
  const [chartCrop, setChartCrop] = useState(null)

  const fieldList = useMemo(() => {
    const m = {}
    records.forEach((r) => {
      const e = (m[r.fieldKey] = m[r.fieldKey] || { key: r.fieldKey, name: r.fieldName, area: r.area, years: 0, crops: new Set() })
      e.years++; if (r.crop) e.crops.add(r.crop); if (r.area) e.area = r.area
    })
    return Object.values(m).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }, [records])

  const hist = useMemo(() => records.filter((r) => r.fieldKey === key).sort((a, b) => a.year - b.year), [records, key])
  const harvestedCrops = useMemo(() => {
    const m = {}
    hist.forEach((r) => { if (r._yield > 0 && r.crop) m[r.crop] = (m[r.crop] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([c]) => c)
  }, [hist])
  const cc = chartCrop && harvestedCrops.includes(chartCrop) ? chartCrop : (harvestedCrops.includes(preferCrop) ? preferCrop : harvestedCrops[0])

  // Average of every field in the same crop, same year — the yardstick.
  const avgByYear = useMemo(() => {
    const m = {}
    if (!cc) return m
    const byYear = groupBy(records.filter((r) => r.crop === cc && (includeLeased || !r.leasedOut)), (r) => r.year)
    byYear.forEach((rs, y) => { m[y] = summarize(rs).avg })
    return m
  }, [records, cc, includeLeased])

  const chartData = hist.filter((r) => r.crop === cc && r._yield > 0).map((r) => ({
    year: r.year, field: r._yield, avg: avgByYear[r.year] ?? null, idx: avgByYear[r.year] ? (r._yield / avgByYear[r.year]) * 100 : null
  }))
  const idxs = chartData.filter((d) => d.idx != null)
  const meanIdx = idxs.length ? idxs.reduce((s, d) => s + d.idx, 0) / idxs.length : null
  const unit = unitFor(cc)
  const shown = fieldList.filter((f) => !q || f.name.toLowerCase().includes(q.toLowerCase()) || (f.area || '').toLowerCase().includes(q.toLowerCase()))
  const fieldInfo = fieldList.find((f) => f.key === key)

  return (
    <div className="yields-field-layout">
      <div className="yields-field-list">
        <input className="agronomy-search-input" style={{ width: '100%' }} placeholder={`Search ${fieldList.length} fields…`} value={q} onChange={(e) => setQ(e.target.value)} />
        <div className="yields-field-scroll">
          {shown.map((f) => (
            <button key={f.key} className={f.key === key ? 'active' : ''} onClick={() => { setKey(f.key); setChartCrop(null) }}>
              <span>{f.name}</span><span className="yields-count">{f.area || ''} · {f.years}y</span>
            </button>
          ))}
        </div>
      </div>
      <div style={{ minWidth: 0 }}>
        {!key && <p className="contracts-empty">Pick a field to see every year it’s been farmed, its rotation, and how it yields against the rest of the operation.</p>}
        {key && (
          <>
            <div className="yields-card">
              <div className="yields-card-title" style={{ fontSize: 16 }}>{fieldNameByKey[key]}</div>
              <div className="contracts-sub">{fieldInfo && fieldInfo.area ? fieldInfo.area + ' · ' : ''}{hist.length} year{hist.length === 1 ? '' : 's'} on record ({hist[0] && hist[0].year}–{hist[hist.length - 1] && hist[hist.length - 1].year})</div>
              <div className="yields-rotation" role="list" aria-label="Rotation by year">
                {hist.map((r) => {
                  const c = cropColor(r.crop)
                  return (
                    <div key={r.id} role="listitem" className="yields-rot-cell" style={{ background: c.bg, color: c.fg }} title={`${r.year}: ${r.crop || 'no crop'}${r.variety ? ' · ' + r.variety : ''}${r._yield ? ' · ' + fmt(r._yield) + ' ' + r.unit + '/ac' : ''}`}>
                      <div className="yields-rot-year">{String(r.year).slice(2)}</div>
                      <div className="yields-rot-crop">{(r.crop || '—').slice(0, 4)}</div>
                    </div>
                  )
                })}
              </div>
            </div>

            {cc && (
              <div className="yields-card">
                <div className="yields-card-head">
                  <div>
                    <div className="yields-card-title">{cc.charAt(0) + cc.slice(1).toLowerCase()} yield vs. operation average</div>
                    <div className="contracts-sub">
                      {meanIdx != null ? `On average this field yields ${fmt(meanIdx)}% of the operation’s ${cc.toLowerCase()} average (${idxs.length} crop${idxs.length === 1 ? '' : 's'}).` : ''}
                    </div>
                  </div>
                  {harvestedCrops.length > 1 && (
                    <select value={cc} onChange={(e) => setChartCrop(e.target.value)}>
                      {harvestedCrops.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                  )}
                </div>
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={chartData} margin={{ top: 10, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="year" tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={{ stroke: GRID }} />
                    <YAxis tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => fmt(v)} />
                    <Tooltip content={<ChartTip unit={unit} />} cursor={{ fill: 'rgba(0,0,0,0.04)' }} />
                    <Bar isAnimationActive={false} dataKey="field" name={fieldNameByKey[key]} fill={SERIES[0]} radius={[4, 4, 0, 0]} maxBarSize={44} />
                    <Line isAnimationActive={false} type="monotone" dataKey="avg" name="Operation avg" stroke={AVG_COLOR} strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: AVG_COLOR, strokeWidth: 0 }} />
                    <Legend content={<LegendRow />} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            )}

            <div className="table-scroll" style={{ maxHeight: 'none' }}>
              <table className="contracts-table contracts-table-auto">
                <thead>
                  <tr>
                    <th>Year</th><th>Crop</th><th className="hide-sm">Variety</th><th className="num">Acres</th><th className="num">Yield/ac</th>
                    <th className="num">vs avg</th><th className="hide-sm">Prev crop</th><th className="hide-sm">Planted</th><th className="hide-sm">Harvested</th><th className="hide-sm">Manager</th>
                  </tr>
                </thead>
                <tbody>
                  {[...hist].reverse().map((r) => {
                    const avg = r.crop ? summarize(records.filter((x) => x.crop === r.crop && x.year === r.year && (includeLeased || !x.leasedOut))).avg : null
                    const idx = r._yield > 0 && avg ? (r._yield / avg) * 100 : null
                    return (
                      <tr key={r.id}>
                        <td><strong>{r.year}</strong></td>
                        <td><CropBadge crop={r.crop} /></td>
                        <td className="hide-sm">{r.variety || '—'}</td>
                        <td className="num">{fmt(r.acres, 1)}</td>
                        <td className="num">{r._yield > 0 ? <><strong>{fmt(r._yield)}</strong> <span className="contracts-sub">{r.unit}</span>{r._source === 'agworld' && <span className="yields-src" title="From Agworld harvest record">AW</span>}</> : '—'}</td>
                        <td className="num" style={{ color: idx == null ? MUTED : idx >= 100 ? '#3B6D11' : '#A32D2D' }}>{idx == null ? '—' : fmt(idx) + '%'}</td>
                        <td className="hide-sm">{r.previousCrop || '—'}</td>
                        <td className="hide-sm">{r.plantDate ? doyLabel(dayOfYear(r.plantDate)) : '—'}</td>
                        <td className="hide-sm">{r.harvestDate ? doyLabel(dayOfYear(r.harvestDate)) : '—'}</td>
                        <td className="hide-sm">{r.leasedOut ? 'Leased out' : (r.manager || '—')}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Compare                                                            */
/* ------------------------------------------------------------------ */

function linreg(pts) {
  const n = pts.length
  if (n < 3) return null
  let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0
  pts.forEach(({ x, y }) => { sx += x; sy += y; sxx += x * x; sxy += x * y; syy += y * y })
  const den = n * sxx - sx * sx
  if (!den) return null
  const m = (n * sxy - sx * sy) / den
  const b = (sy - m * sx) / n
  const r = (n * sxy - sx * sy) / Math.sqrt(den * (n * syy - sy * sy))
  return { m, b, r2: r * r }
}

function CompareView({ base, focus, selFields, fieldNameByKey, unit }) {
  const [by, setBy] = useState('variety')
  const [minN, setMinN] = useState(3)
  const [xKey, setXKey] = useState('plantDoy')

  const overall = summarize(base).avg
  const bars = useMemo(() => {
    const get = by === 'field' ? (r) => r.fieldName : by === 'seedSpacing' ? (r) => (r.seedSpacing ? `${r.seedSpacing}"` : null) : by === 'decade' ? (r) => `${Math.floor(r.year / 5) * 5}–${Math.floor(r.year / 5) * 5 + 4}` : DIMENSIONS[by].get
    const g = groupBy((selFields.length && by !== 'field' ? focus : base).filter((r) => r._yield > 0), get)
    return [...g.entries()].map(([k, rs]) => ({ name: k, ...summarize(rs) }))
      .filter((d) => d.n >= minN).sort((a, b) => b.avg - a.avg).slice(0, 30)
  }, [base, focus, selFields, by, minN])

  const pts = useMemo(() => focus.filter((r) => r._yield > 0 && r[xKey] != null && isFinite(r[xKey])).map((r) => ({ x: r[xKey], y: r._yield, field: r.fieldName, year: r.year, variety: r.variety, key: r.fieldKey })), [focus, xKey])
  const reg = linreg(pts)
  const xs = pts.map((p) => p.x)
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  const regLine = reg && isFinite(xMin) ? [{ x: xMin, y: reg.m * xMin + reg.b }, { x: xMax, y: reg.m * xMax + reg.b }] : null
  const xFmt = SCATTER_X[xKey].fmt
  const colorFor = (k) => { const i = selFields.indexOf(k); return i >= 0 && i < MAX_SERIES ? SERIES[i] : SERIES[0] }

  return (
    <>
      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Average yield by {by === 'field' ? 'field' : by === 'seedSpacing' ? 'seed spacing' : by === 'decade' ? '5-year period' : DIMENSIONS[by].label.toLowerCase()}</div>
            <div className="contracts-sub">Acre-weighted {unit}/ac · dashed line = overall average ({fmt(overall)}) · groups with fewer than {minN} records hidden</div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <select value={by} onChange={(e) => setBy(e.target.value)}>
              {Object.entries(DIMENSIONS).map(([k, d]) => <option key={k} value={k}>By {d.label.toLowerCase()}</option>)}
              <option value="seedSpacing">By seed spacing</option>
              <option value="field">By field</option>
              <option value="decade">By 5-year period</option>
            </select>
            <select value={minN} onChange={(e) => setMinN(Number(e.target.value))}>
              {[1, 3, 5, 10].map((n) => <option key={n} value={n}>Min {n} record{n === 1 ? '' : 's'}</option>)}
            </select>
          </div>
        </div>
        {bars.length === 0 ? <p className="contracts-empty">Nothing to compare with these filters.</p> : (
          <ResponsiveContainer width="100%" height={Math.max(160, bars.length * 30 + 40)}>
            <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 60, bottom: 4, left: 8 }} barCategoryGap={4}>
              <CartesianGrid stroke={GRID} horizontal={false} />
              <XAxis type="number" tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v)} />
              <YAxis type="category" dataKey="name" width={130} tick={{ fontSize: 11, fill: INK }} tickLine={false} axisLine={false} interval={0} />
              <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null
                const d = payload[0].payload
                return (
                  <div className="yields-tip">
                    <div className="yields-tip-title">{d.name}</div>
                    <div className="yields-tip-row"><i style={{ background: SERIES[0] }} /><span>Avg</span><strong>{fmt(d.avg)}</strong></div>
                    <div className="yields-tip-row muted"><i /><span>Range</span><span>{fmt(d.min)}–{fmt(d.max)}</span></div>
                    <div className="yields-tip-row muted"><i /><span>Records</span><span>{d.n} · {fmt(d.acres)} ac</span></div>
                    <div className="yields-tip-unit">{unit}/ac · {overall ? `${fmt((d.avg / overall) * 100)}% of overall` : ''}</div>
                  </div>
                )
              }} />
              {overall && <ReferenceLine x={overall} stroke={AVG_COLOR} strokeDasharray="5 4" />}
              <Bar isAnimationActive={false} dataKey="avg" fill={SERIES[0]} radius={[0, 4, 4, 0]} maxBarSize={20}>
                <LabelList dataKey="avg" position="right" formatter={(v) => fmt(v)} style={{ fontSize: 11, fill: INK2 }} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Yield vs. {SCATTER_X[xKey].label.toLowerCase()}</div>
            <div className="contracts-sub">
              {pts.length} field-years{reg ? ` · trend ${reg.m >= 0 ? '+' : ''}${fmt(reg.m, xKey === 'tareFactor' || xKey === 'dryMatterSugar' ? 0 : 1)} ${unit}/ac per ${xKey.endsWith('Doy') ? 'day' : xKey === 'year' ? 'year' : 'unit'} · R² ${fmt(reg.r2, 2)}` : ''}
              {selFields.length ? ' · selected fields only' : ''}
            </div>
          </div>
          <select value={xKey} onChange={(e) => setXKey(e.target.value)}>
            {Object.entries(SCATTER_X).map(([k, d]) => <option key={k} value={k}>{d.label}</option>)}
          </select>
        </div>
        {pts.length === 0 ? <p className="contracts-empty">No records have both a yield and a {SCATTER_X[xKey].label.toLowerCase()}.</p> : (
          <ResponsiveContainer width="100%" height={320}>
            <ScatterChart margin={{ top: 10, right: 16, bottom: 4, left: 0 }}>
              <CartesianGrid stroke={GRID} />
              <XAxis type="number" dataKey="x" domain={['dataMin', 'dataMax']} tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={{ stroke: GRID }} tickFormatter={xFmt} name={SCATTER_X[xKey].label} />
              <YAxis type="number" dataKey="y" tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} width={48} tickFormatter={(v) => fmt(v)} />
              <ZAxis range={[48, 48]} />
              <Tooltip cursor={{ strokeDasharray: '3 3' }} content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null
                const d = payload[0].payload
                if (d.field == null) return null
                return (
                  <div className="yields-tip">
                    <div className="yields-tip-title">{d.field} · {d.year}</div>
                    <div className="yields-tip-row"><i style={{ background: colorFor(d.key) }} /><span>Yield</span><strong>{fmt(d.y)}</strong></div>
                    <div className="yields-tip-row muted"><i /><span>{SCATTER_X[xKey].label}</span><span>{xFmt(d.x)}</span></div>
                    {d.variety && <div className="yields-tip-row muted"><i /><span>Variety</span><span>{d.variety}</span></div>}
                    <div className="yields-tip-unit">{unit}/ac</div>
                  </div>
                )
              }} />
              <Scatter data={pts} isAnimationActive={false}>
                {pts.map((p, i) => <Cell key={i} fill={colorFor(p.key)} fillOpacity={selFields.length ? 0.85 : 0.45} stroke="#fff" strokeWidth={1} />)}
              </Scatter>
              {regLine && <Scatter data={regLine} line={{ stroke: AVG_COLOR, strokeWidth: 2, strokeDasharray: '5 4' }} shape={() => null} isAnimationActive={false} legendType="none" />}
            </ScatterChart>
          </ResponsiveContainer>
        )}
      </div>
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Records                                                            */
/* ------------------------------------------------------------------ */

const RECORD_COLS = [
  { key: 'year', label: 'Year', num: true },
  { key: 'fieldName', label: 'Field' },
  { key: 'area', label: 'Area', sm: true },
  { key: 'crop', label: 'Crop' },
  { key: 'variety', label: 'Variety', sm: true },
  { key: 'acres', label: 'Acres', num: true, f: (v) => fmt(v, 1) },
  { key: '_yield', label: 'Yield/ac', num: true, f: (v) => fmt(v), csv: (r) => (r._yield != null ? r._yield.toFixed(1) : '') },
  { key: 'unit', label: 'Unit', sm: true },
  { key: 'previousCrop', label: 'Prev crop', sm: true },
  { key: 'plantDate', label: 'Planted', sm: true },
  { key: 'harvestDate', label: 'Harvested', sm: true },
  { key: 'irrigation', label: 'Irrigation', sm: true },
  { key: 'manager', label: 'Manager', sm: true },
  { key: '_source', label: 'Source', sm: true }
]

function RecordsView({ rows }) {
  const [sort, setSort] = useState({ key: 'year', dir: -1 })
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(100)
  const sorted = useMemo(() => {
    const s = q.trim().toLowerCase()
    const list = rows.filter((r) => !s || `${r.fieldName} ${r.area || ''} ${r.variety || ''} ${r.manager || ''} ${r.year}`.toLowerCase().includes(s))
    return list.sort((a, b) => {
      const x = a[sort.key], y = b[sort.key]
      if (x == null && y == null) return 0
      if (x == null) return 1
      if (y == null) return -1
      return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })) * sort.dir
    })
  }, [rows, sort, q])
  const s = summarize(sorted)

  return (
    <>
      <div className="agronomy-filter-bar">
        <input className="agronomy-search-input" placeholder="Search field, area, variety, manager…" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="contracts-sub">{fmt(sorted.length)} records · {fmt(s.acres)} ac with yield · avg {fmt(s.avg)}</span>
        <button onClick={() => download('yield-history.csv', toCsv(sorted, RECORD_COLS))}>Export CSV</button>
      </div>
      <div className="table-scroll" style={{ maxHeight: '70vh' }}>
        <table className="contracts-table contracts-table-auto">
          <thead>
            <tr>
              {RECORD_COLS.map((c) => (
                <th key={c.key} className={`agronomy-sortable ${c.num ? 'num' : ''} ${c.sm ? 'hide-sm' : ''}`}
                  onClick={() => setSort((p) => ({ key: c.key, dir: p.key === c.key ? -p.dir : (c.num ? -1 : 1) }))}>
                  {c.label}{sort.key === c.key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, limit).map((r) => (
              <tr key={r.id}>
                {RECORD_COLS.map((c) => (
                  <td key={c.key} className={`${c.num ? 'num' : ''} ${c.sm ? 'hide-sm' : ''}`}>
                    {c.key === 'crop' ? <CropBadge crop={r.crop} />
                      : c.key === '_source' ? (r._source === 'agworld' ? 'Agworld' : r._source === 'spreadsheet' ? 'Workbook' : '—')
                        : c.f ? c.f(r[c.key]) : (r[c.key] ?? '—')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sorted.length > limit && <button className="agronomy-load-more" onClick={() => setLimit(limit + 200)}>Show more ({fmt(sorted.length - limit)} left)</button>}
    </>
  )
}

