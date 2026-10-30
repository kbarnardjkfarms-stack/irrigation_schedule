import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, doc, onSnapshot, setDoc } from 'firebase/firestore'
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import FieldLinks from './FieldLinks.jsx'
import { effectiveYield, fieldKey, fmt, unitFor } from './yieldMath.js'
import { buildRotation, fieldStats, satelliteAgreement, seasonYear, yieldByGap } from './rotationMath.js'

// Rotation tab for the Contracts module, plus the useRotation() hook the
// Allocate view also uses for its "last 6 years" strip.
//
// History: yieldHistory (the yield workbook lists every field every year
// from 2007; before 2021 it mostly only lists potato and beet fields, so
// other years show as "no record", not as a gap). Going forward: Agworld's
// per-season crop for every synced season (2026 on, including next season
// once it's planned in Agworld). Agworld wins for any year it has.

export const ROT_COLOR = {
  POTATO: { bg: '#C8A27A', fg: '#3B230C', abbr: 'POT' }, 'MINI POTATOES': { bg: '#DDBF98', fg: '#3B230C', abbr: 'MINI' },
  BEETS: { bg: '#B9A6E3', fg: '#2B1C55', abbr: 'BTS' }, CORN: { bg: '#F2D76B', fg: '#5C4500', abbr: 'CRN' },
  'SWEET CORN': { bg: '#F7E39A', fg: '#5C4500', abbr: 'SWC' }, HAY: { bg: '#A9CF84', fg: '#183A05', abbr: 'HAY' },
  BARLEY: { bg: '#E6D3A3', fg: '#4E3D0F', abbr: 'BAR' }, WHEAT: { bg: '#E0C98F', fg: '#4E3D0F', abbr: 'WHT' },
  'SMALL GRAIN': { bg: '#E6D3A3', fg: '#4E3D0F', abbr: 'GRN' }, BEANS: { bg: '#A9C8EA', fg: '#17365A', abbr: 'BNS' },
  ONIONS: { bg: '#EFA9C0', fg: '#4B1528', abbr: 'ONI' }, RYE: { bg: '#D6CCAE', fg: '#3F3826', abbr: 'RYE' },
  FALLOW: { bg: '#E4E1D8', fg: '#5A574C', abbr: 'FAL' }, MELONS: { bg: '#B7E0AE', fg: '#1F4A16', abbr: 'MEL' },
  PUMPKINS: { bg: '#F2BE7C', fg: '#6B3D02', abbr: 'PMK' }, MINT: { bg: '#9FE1CB', fg: '#04342C', abbr: 'MNT' }
}
export const rotColor = (c) => ROT_COLOR[c] || { bg: '#CFCCC2', fg: '#2C2C2A', abbr: (c || '').slice(0, 3) }

const BAR = '#2a78d6', BAR2 = '#eb6834', INK2 = '#52514e', MUTED = '#888', GRID = '#ebe7dc'

// Loads both rotation sources and joins them. Shared by the Rotation tab
// and the Allocate view.
export function useRotation(baseFieldsById, seasons, enabled = true) {
  const [historyDocs, setHistoryDocs] = useState(null)
  const [historyError, setHistoryError] = useState(null)
  const [seasonDocs, setSeasonDocs] = useState([])
  const [satDocs, setSatDocs] = useState([])
  const [satStatus, setSatStatus] = useState(null)
  const [satFirst, setSatFirst] = useState(false)
  const [lineageDocs, setLineageDocs] = useState({ links: {}, suggestions: null, dismissed: [] })

  // Only starts reading once a tab that needs it is opened, then stays live.
  const [on, setOn] = useState(enabled)
  useEffect(() => { if (enabled) setOn(true) }, [enabled])

  useEffect(() => {
    if (!on) return undefined
    return onSnapshot(collection(db, 'yieldHistory'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setHistoryDocs(list); setHistoryError(null)
    }, (e) => { setHistoryDocs([]); setHistoryError(e.code === 'permission-denied' ? 'no-access' : e.message) })
  }, [on])

  // Every field's crop for every synced Agworld season (collection-group
  // read across fields/{id}/seasons/{id}; the top-level seasons docs that
  // also match are skipped since they have no parent field).
  useEffect(() => {
    if (!on) return undefined
    return onSnapshot(collectionGroup(db, 'seasons'), (snap) => {
      const list = []
      snap.forEach((d) => {
        const parentField = d.ref.parent.parent
        if (!parentField) return
        list.push({ fieldId: parentField.id, ...d.data() })
      })
      setSeasonDocs(list)
    }, () => setSeasonDocs([]))
  }, [on])

  // Shared choice of which wins when the records and the satellite both have
  // a crop: yieldSettings/rotation.satFirst (Admin/Owner set it on the
  // Rotation tab). Unreadable (no Yields module) -> records first.
  useEffect(() => {
    if (!on) return undefined
    return onSnapshot(doc(db, 'yieldSettings', 'rotation'), (d) => setSatFirst(!!(d.exists() && d.data().satFirst)), () => setSatFirst(false))
  }, [on])

  // Field history links (fieldLineage/{currentFieldKey}) + the map
  // suggestions and dismissed list kept in the same collection.
  useEffect(() => {
    if (!on) return undefined
    return onSnapshot(collection(db, 'fieldLineage'), (snap) => {
      const links = {}
      let suggestions = null, dismissed = []
      snap.forEach((d) => {
        if (d.id === '_suggestions') suggestions = d.data()
        else if (d.id === '_dismissed') dismissed = d.data().pairs || []
        else links[d.id] = d.data()
      })
      setLineageDocs({ links, suggestions, dismissed })
    }, () => setLineageDocs({ links: {}, suggestions: null, dismissed: [] }))
  }, [on])

  // USDA satellite crop history (rotationSat/{agworldFieldId}, written by the
  // satelliteRotation Cloud Functions; "_status" holds the last run).
  useEffect(() => {
    if (!on) return undefined
    return onSnapshot(collection(db, 'rotationSat'), (snap) => {
      const list = []
      let st = null
      snap.forEach((d) => { if (d.id === '_status') st = d.data(); else list.push({ id: d.id, ...d.data() }) })
      setSatDocs(list); setSatStatus(st)
    }, () => { setSatDocs([]); setSatStatus(null) })
  }, [on])

  const yearBySeasonId = useMemo(() => Object.fromEntries((seasons || []).map((s) => [String(s.id), seasonYear(s)])), [seasons])

  const agRows = useMemo(() => seasonDocs.map((sd) => {
    const base = baseFieldsById[sd.fieldId]
    return base ? { name: base.name, farmName: base.farmName, year: yearBySeasonId[String(sd.seasonId)] || seasonYear({ name: sd.seasonName }), crop: sd.cropName } : null
  }).filter((r) => r && r.year), [seasonDocs, baseFieldsById, yearBySeasonId])

  const satRows = useMemo(() => {
    const out = []
    satDocs.forEach((d) => {
      const base = baseFieldsById[d.fieldId || d.id]
      const name = base ? base.name : d.fieldName
      Object.entries(d.years || {}).forEach(([y, v]) => {
        if (v && v.crop) out.push({ name, farmName: base ? base.farmName : d.farmName, year: Number(y), crop: v.crop, share: v.share, cdlName: v.cdlName })
      })
    })
    return out
  }, [satDocs, baseFieldsById])

  // With and without the satellite fill, so the Rotation tab can toggle it.
  // Records-first is always built too: the satellite-vs-records match check
  // compares against the records' own crops.
  const lineage = lineageDocs.links
  const rotationRecordsFirst = useMemo(() => buildRotation(historyDocs || [], agRows, satRows, { lineage }), [historyDocs, agRows, satRows, lineage])
  const rotationSatFirst = useMemo(() => (satFirst ? buildRotation(historyDocs || [], agRows, satRows, { satFirst: true, lineage }) : null), [historyDocs, agRows, satRows, satFirst, lineage])
  const rotation = satFirst ? rotationSatFirst : rotationRecordsFirst
  const rotationNoSat = useMemo(() => buildRotation(historyDocs || [], agRows, [], { lineage }), [historyDocs, agRows, lineage])

  // Names history was recorded under (workbook / entered / synced yields),
  // with how many years each has — the choices for a history link.
  const historyFields = useMemo(() => {
    const m = {}
    ;(historyDocs || []).forEach((d) => {
      if (d.deleted) return
      const k = d.fieldKey || fieldKey(d.fieldName)
      if (!k) return
      const e = (m[k] = m[k] || { key: k, name: d.fieldName || k, yrs: new Set() })
      if (d.crop || (d.agworld && d.agworld.crop)) e.yrs.add(d.year)
    })
    return Object.values(m).map((e) => ({ key: e.key, name: e.name, years: e.yrs.size })).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  }, [historyDocs])
  const satYearsByKey = useMemo(() => {
    const m = {}
    satDocs.forEach((d) => {
      const base = baseFieldsById[d.fieldId || d.id]
      const k = fieldKey(base ? base.name : d.fieldName)
      m[k] = Object.values(d.years || {}).filter((v) => v && v.crop).length
    })
    return m
  }, [satDocs, baseFieldsById])

  const yieldRecords = useMemo(() => (historyDocs || []).filter((d) => !d.deleted).map((d) => ({ ...d, _yield: effectiveYield(d).value })), [historyDocs])

  return { rotation, rotationNoSat, rotationRecordsFirst, satFirst, yieldRecords, loading: historyDocs === null, historyError, satStatus, satFieldCount: satDocs.length,
    lineage, lineageSuggestions: lineageDocs.suggestions, lineageDismissed: lineageDocs.dismissed, historyFields, satYearsByKey }
}

// Small year strip used in tables.
export function RotationStrip({ field, from, to, highlight }) {
  const cells = []
  for (let y = from; y <= to; y++) {
    const v = field && field.years[y]
    const c = v && v.crop ? rotColor(v.crop) : null
    cells.push(
      <span key={y} className={`rot-mini ${c ? '' : 'none'} ${highlight && v && v.crop === highlight ? 'hl' : ''} ${v && v.source === 'satellite' ? 'sat' : ''} ${v && v.inheritedFrom ? 'inh' : ''}`}
        style={c ? { background: c.bg, color: c.fg } : undefined}
        title={`${y}: ${v && v.crop ? v.crop : 'no record'}${v && v.source === 'agworld' ? ' (Agworld)' : ''}${v && v.source === 'satellite' ? ' (USDA satellite)' : ''}${v && v.recordCrop ? ` · records say ${v.recordCrop}` : ''}${v && v.inheritedFrom ? ` · from ${v.inheritedFrom}` : ''}`}>
        {c ? c.abbr.slice(0, 1) : ''}
      </span>
    )
  }
  return <span className="rot-mini-strip">{cells}</span>
}

function cropLabel(c) { return c ? c.charAt(0) + c.slice(1).toLowerCase() : '' }

function HBar({ title, sub, data, valueKey, color, labelFn, tipFn, empty, refX }) {
  return (
    <div className="yields-card rot-chart">
      <div className="yields-card-title">{title}</div>
      {sub && <div className="contracts-sub">{sub}</div>}
      {data.length === 0 ? <p className="contracts-empty">{empty || 'Nothing to show.'}</p> : (
        <ResponsiveContainer width="100%" height={data.length * 24 + 30}>
          <BarChart data={data} layout="vertical" margin={{ top: 6, right: 70, bottom: 0, left: 4 }} barCategoryGap={3}>
            <CartesianGrid stroke={GRID} horizontal={false} />
            <XAxis type="number" hide domain={[0, 'dataMax']} />
            <YAxis type="category" dataKey="name" width={118} tick={{ fontSize: 11, fill: '#2b2b26' }} tickLine={false} axisLine={false} interval={0} />
            <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={({ active, payload }) => (active && payload && payload.length ? <div className="yields-tip">{tipFn(payload[0].payload)}</div> : null)} />
            {refX != null && <ReferenceLine x={refX} stroke={INK2} strokeDasharray="4 4" />}
            <Bar dataKey={valueKey} fill={color} radius={[0, 4, 4, 0]} maxBarSize={16} isAnimationActive={false}>
              <LabelList dataKey={valueKey} position="right" content={(p) => <text x={p.x + p.width + 6} y={p.y + p.height / 2 + 4} fontSize={11} fill={INK2}>{labelFn(data[p.index])}</text>} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  )
}

export default function ContractsRotation({ rotationData, seasonFields, selectedFarmId, seasonYearNum, canEdit }) {
  const [useSat, setUseSat] = useState(true)
  const { yieldRecords, loading, historyError, satStatus, satFieldCount, satFirst, rotationRecordsFirst } = rotationData
  const rotation = useSat ? rotationData.rotation : rotationData.rotationNoSat
  const [focus, setFocus] = useState('POTATO')
  const [compare, setCompare] = useState('BEETS')
  const [windowYears, setWindowYears] = useState(15)
  const [scope, setScope] = useState('season') // 'season' | 'all'
  const [q, setQ] = useState('')
  const [currentFilter, setCurrentFilter] = useState('all') // crop this season
  const [sort, setSort] = useState({ key: 'yearsOut', dir: -1 })
  const refYear = seasonYearNum || new Date().getFullYear()

  const cropChoices = useMemo(() => {
    const m = {}
    Object.values(rotation).forEach((f) => Object.values(f.years).forEach((v) => { if (v.crop) m[v.crop] = (m[v.crop] || 0) + 1 }))
    return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([c]) => c).filter((c) => c !== 'FALLOW')
  }, [rotation])

  // Which fields: this season's Agworld fields (default — the ones you can
  // actually contract) or everything on record.
  const rows = useMemo(() => {
    const seasonByKey = {}
    seasonFields.forEach((f) => { seasonByKey[f.key] = f })
    const keys = scope === 'season'
      ? seasonFields.filter((f) => selectedFarmId === 'all' || String(f.farmId) === String(selectedFarmId)).map((f) => f.key)
      : Object.keys(rotation)
    const out = []
    new Set(keys).forEach((k) => {
      const field = rotation[k] || { key: k, name: (seasonByKey[k] || {}).name || k, years: {} }
      const sf = seasonByKey[k]
      const name = sf ? sf.name : field.name
      const farm = sf ? sf.farmName : (field.farmName || field.area)
      const thisSeason = sf ? (sf.rotCrop || sf.crop) : (field.years[refYear] && field.years[refYear].crop) || null
      if (currentFilter !== 'all' && thisSeason !== currentFilter) return
      if (q && !`${name} ${farm || ''}`.toLowerCase().includes(q.toLowerCase())) return
      const fs = fieldStats(field, focus, refYear, windowYears)
      const cs = fieldStats(field, compare, refYear, 5)
      const recordYears = Object.keys(field.years).map(Number).filter((y) => y <= refYear)
      out.push({
        key: k, name, farm, field, thisSeason, acres: sf ? sf.acres : null,
        ...fs,
        // Sorting/charting value for "years out": never on record counts as
        // out for the whole record, flagged so it reads as a minimum.
        outSort: fs.yearsOut != null ? fs.yearsOut : (fs.neverSince != null ? refYear - fs.neverSince + 1 : -1),
        compareCount: cs.count,
        firstYear: recordYears.length ? Math.min(...recordYears) : null
      })
    })
    return out
  }, [rotation, seasonFields, scope, selectedFarmId, currentFilter, q, focus, compare, windowYears, refYear])

  const sorted = useMemo(() => {
    const key = sort.key === 'yearsOut' ? 'outSort' : sort.key
    return [...rows].sort((a, b) => {
      const x = a[key], y = b[key]
      if (x == null && y == null) return a.name.localeCompare(b.name, undefined, { numeric: true })
      if (x == null) return 1
      if (y == null) return -1
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true })
      return c * sort.dir || a.name.localeCompare(b.name, undefined, { numeric: true })
    })
  }, [rows, sort])

  // Year columns: the window, plus any later year Agworld already has (next season's plan).
  const maxYear = useMemo(() => {
    let m = refYear
    rows.forEach((r) => Object.keys(r.field.years).forEach((y) => { if (Number(y) > m && Number(y) <= refYear + 2) m = Number(y) }))
    return m
  }, [rows, refYear])
  const years = []
  for (let y = refYear - windowYears + 1; y <= maxYear; y++) years.push(y)

  // Charts (top 12 each)
  const notInFocusNow = rows.filter((r) => r.thisSeason !== focus)
  const longestOut = [...notInFocusNow].filter((r) => r.outSort > 0).sort((a, b) => b.outSort - a.outSort).slice(0, 12)
  const mostCompare = [...rows].filter((r) => r.compareCount > 0).sort((a, b) => b.compareCount - a.compareCount || a.name.localeCompare(b.name)).slice(0, 12)
  const tightest = [...rows].filter((r) => r.count >= 2 || (r.count >= 1 && r.minGap != null))
    .sort((a, b) => (a.minGap ?? 99) - (b.minGap ?? 99) || b.count - a.count).slice(0, 12)

  const gapData = useMemo(() => {
    const pts = yieldByGap(rotation, yieldRecords, focus)
    const buckets = {}
    pts.forEach((p) => {
      const k = p.gap >= 7 ? '7+' : String(p.gap)
      const b = (buckets[k] = buckets[k] || { gap: k, n: 0, w: 0, a: 0, sum: 0 })
      b.n++; b.sum += p.yield
      if (p.acres > 0) { b.w += p.yield * p.acres; b.a += p.acres }
    })
    return ['1', '2', '3', '4', '5', '6', '7+'].map((k) => buckets[k]).filter(Boolean)
      .map((b) => ({ ...b, avg: b.a > 0 ? b.w / b.a : b.sum / b.n, label: k2label(b.gap) }))
  }, [rotation, yieldRecords, focus])
  const gapOverall = gapData.length ? gapData.reduce((s, b) => s + b.avg * b.n, 0) / gapData.reduce((s, b) => s + b.n, 0) : null

  const avgOut = (() => { const v = rows.filter((r) => r.yearsOut != null); return v.length ? v.reduce((s, r) => s + r.yearsOut, 0) / v.length : null })()
  const ready4 = notInFocusNow.filter((r) => r.outSort >= 4).length
  const inFocusNow = rows.filter((r) => r.thisSeason === focus)

  const head = (key, label, cls = 'num') => (
    <th className={`agronomy-sortable ${cls}`} onClick={() => setSort((p) => ({ key, dir: p.key === key ? -p.dir : -1 }))}>
      {label}{sort.key === key ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
    </th>
  )

  if (loading) return <p className="contracts-empty">Loading rotation history…</p>

  return (
    <>
      <div className="yields-filters">
        <label className="rot-ctl">Focus crop
          <select value={focus} onChange={(e) => setFocus(e.target.value)}>{cropChoices.map((c) => <option key={c} value={c}>{cropLabel(c)}</option>)}</select>
        </label>
        <label className="rot-ctl">Compare crop
          <select value={compare} onChange={(e) => setCompare(e.target.value)}>{cropChoices.map((c) => <option key={c} value={c}>{cropLabel(c)}</option>)}</select>
        </label>
        <label className="rot-ctl">Look back
          <select value={windowYears} onChange={(e) => setWindowYears(Number(e.target.value))}>{[5, 10, 15].map((n) => <option key={n} value={n}>{n} years ({refYear - n + 1}–{refYear})</option>)}</select>
        </label>
        <label className="rot-ctl">Fields
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="season">In Agworld for {refYear}</option>
            <option value="all">Everything on record</option>
          </select>
        </label>
        <label className="rot-ctl">Crop in {refYear}
          <select value={currentFilter} onChange={(e) => setCurrentFilter(e.target.value)}>
            <option value="all">Any</option>
            {cropChoices.map((c) => <option key={c} value={c}>{cropLabel(c)}</option>)}
          </select>
        </label>
        <input className="agronomy-search-input" placeholder="Search field or farm…" value={q} onChange={(e) => setQ(e.target.value)} style={{ alignSelf: 'flex-end' }} />
        <label className="yields-check" style={{ alignSelf: 'flex-end', paddingBottom: 6 }} title="Fill years with no workbook or Agworld record from the USDA satellite crop map">
          <input type="checkbox" checked={useSat} onChange={(e) => setUseSat(e.target.checked)} /> Fill gaps with USDA satellite
        </label>
      </div>

      <SatellitePanel status={satStatus} fieldCount={satFieldCount} canEdit={canEdit} satFirst={satFirst} rotationRecordsFirst={rotationRecordsFirst} />
      <FieldLinks currentFields={seasonFields.map((f) => ({ key: f.key, name: f.name, farmName: f.farmName }))} historyFields={rotationData.historyFields || []}
        lineage={rotationData.lineage || {}} mapSuggestions={rotationData.lineageSuggestions} dismissed={rotationData.lineageDismissed}
        satYearsByKey={rotationData.satYearsByKey || {}} canEdit={canEdit} />

      {historyError === 'no-access' && <div className="agronomy-error-banner">Only Agworld seasons are shown — your login doesn’t have the Yield history module, which holds the 2007-on rotation history.</div>}

      <div className="agronomy-kpi-grid">
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Fields</p><p className="agronomy-kpi-value">{fmt(rows.length)}</p></div>
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">In {cropLabel(focus).toLowerCase()} for {refYear}</p><p className="agronomy-kpi-value">{fmt(inFocusNow.length)} <span className="agronomy-kpi-unit">{fmt(inFocusNow.reduce((s, r) => s + (r.acres || 0), 0))} ac</span></p></div>
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Avg years since {cropLabel(focus).toLowerCase()}</p><p className="agronomy-kpi-value">{avgOut == null ? '—' : fmt(avgOut, 1)}</p></div>
        <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Out 4+ years (not in it now)</p><p className="agronomy-kpi-value">{fmt(ready4)}</p></div>
      </div>

      <div className="rot-charts">
        <HBar title={`Longest out of ${cropLabel(focus).toLowerCase()}`} sub={`Years since last ${cropLabel(focus).toLowerCase()} crop, as of ${refYear}. “never” = not on record since the first year listed.`}
          data={longestOut} valueKey="outSort" color={BAR}
          labelFn={(r) => (r.yearsOut != null ? `${r.yearsOut} yr · ${r.last}` : `never · since ${r.neverSince}`)}
          tipFn={(r) => <><div className="yields-tip-title">{r.name}</div><div className="yields-tip-row muted"><i /><span>Last {cropLabel(focus).toLowerCase()}</span><span>{r.last || 'not on record'}</span></div><div className="yields-tip-row muted"><i /><span>Farm</span><span>{r.farm || '—'}</span></div></>} />
        <HBar title={`Most ${cropLabel(compare).toLowerCase()} in the last 5 years`} sub={`${refYear - 4}–${refYear}`}
          data={mostCompare} valueKey="compareCount" color={BAR2}
          labelFn={(r) => `${r.compareCount} of 5`}
          tipFn={(r) => <><div className="yields-tip-title">{r.name}</div><div className="yields-tip-row muted"><i /><span>{cropLabel(compare)} years</span><span>{r.compareCount}</span></div></>} />
        <HBar title={`Tightest ${cropLabel(focus).toLowerCase()} rotations`} sub={`Sorted by the shortest break between ${cropLabel(focus).toLowerCase()} crops in the last ${windowYears} years. Bar = how many ${cropLabel(focus).toLowerCase()} crops in that span; “min 2 yr” = back again after 2 years.`}
          data={tightest} valueKey="count" color="#A32D2D"
          labelFn={(r) => `${r.count}× · min ${r.minGap != null ? r.minGap : '—'} yr`}
          tipFn={(r) => <><div className="yields-tip-title">{r.name}</div><div className="yields-tip-row muted"><i /><span>{cropLabel(focus)} years</span><span>{r.count}</span></div><div className="yields-tip-row muted"><i /><span>Shortest gap</span><span>{r.minGap ?? '—'} yr</span></div><div className="yields-tip-row muted"><i /><span>Average gap</span><span>{r.avgGap != null ? fmt(r.avgGap, 1) : '—'} yr</span></div></>} />
      </div>

      {gapData.length > 0 && (
        <div className="yields-card">
          <div className="yields-card-title">{cropLabel(focus)} yield by years since the last {cropLabel(focus).toLowerCase()} crop</div>
          <div className="contracts-sub">Every {cropLabel(focus).toLowerCase()} yield on record (all fields, all years), acre-weighted {unitFor(focus)}/ac. Dashed line = average across these.</div>
          <ResponsiveContainer width="100%" height={250}>
            <BarChart data={gapData} margin={{ top: 22, right: 10, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="label" tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={{ stroke: GRID }} />
              <YAxis tick={{ fontSize: 11, fill: MUTED }} tickLine={false} axisLine={false} width={44} tickFormatter={(v) => fmt(v)} />
              <Tooltip cursor={{ fill: 'rgba(0,0,0,0.04)' }} content={({ active, payload }) => {
                if (!active || !payload || !payload.length) return null
                const d = payload[0].payload
                return <div className="yields-tip"><div className="yields-tip-title">{d.label}</div><div className="yields-tip-row"><i style={{ background: BAR }} /><span>Avg yield</span><strong>{fmt(d.avg)}</strong></div><div className="yields-tip-row muted"><i /><span>Field-years</span><span>{d.n}</span></div><div className="yields-tip-unit">{unitFor(focus)}/ac</div></div>
              }} />
              {gapOverall && <ReferenceLine y={gapOverall} stroke={INK2} strokeDasharray="4 4" />}
              <Bar dataKey="avg" radius={[4, 4, 0, 0]} maxBarSize={56} isAnimationActive={false}>
                {gapData.map((d) => <Cell key={d.gap} fill={d.gap === '1' ? '#A32D2D' : BAR} />)}
                <LabelList dataKey="avg" position="top" content={(p) => <text x={p.x + p.width / 2} y={p.y - 6} textAnchor="middle" fontSize={11} fill={INK2}>{fmt(gapData[p.index].avg)} · n={gapData[p.index].n}</text>} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Rotation history</div>
            <div className="contracts-sub">One row per field, one cell per year. Click a column heading to sort. Faded, dashed cells come from the USDA satellite crop map{satFirst && useSat ? ' (satellite first: it wins wherever it has a year; a corner mark means your records said something else)' : ' (only where the workbook and Agworld have nothing)'}; hover for the detail. Blank = no record.</div>
          </div>
          <div className="rot-legend">
            {[focus, compare, ...cropChoices.filter((c) => c !== focus && c !== compare)].slice(0, 9).map((c) => {
              const col = rotColor(c)
              return <span key={c}><i style={{ background: col.bg }} />{cropLabel(c)}</span>
            })}
            {useSat && <span><i className="rot-legend-sat" />USDA satellite</span>}
            <span><i className="rot-legend-inh" />Linked history</span>
          </div>
        </div>
        <div className="table-scroll" style={{ maxHeight: '70vh' }}>
          <table className="contracts-table rot-table">
            <thead>
              <tr>
                {head('name', 'Field', 'rot-field')}
                {years.map((y) => <th key={y} className={`rot-year ${y === refYear ? 'ref' : ''} ${y > refYear ? 'future' : ''}`}>{String(y).slice(2)}</th>)}
                {head('yearsOut', `Yrs out`)}
                {head('count', `${cropLabel(focus).slice(0, 4)}. ${windowYears}y`)}
                {head('minGap', 'Min gap')}
                {head('compareCount', `${cropLabel(compare).slice(0, 4)}. 5y`)}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => (
                <tr key={r.key}>
                  <td className="rot-field"><strong>{r.name}</strong><div className="contracts-sub" style={{ marginTop: 0 }}>{r.farm || '—'}{r.field.linkedFrom && r.field.linkedFrom.length ? ` · + ${r.field.linkedFrom.join(', ')}` : ''}</div></td>
                  {years.map((y) => {
                    const v = r.field.years[y]
                    const c = v && v.crop ? rotColor(v.crop) : null
                    return (
                      <td key={y} className={`rot-cell ${y === refYear ? 'ref' : ''} ${v && v.crop === focus ? 'focus' : ''} ${v && v.source === 'satellite' ? 'sat' : ''} ${v && v.recordCrop ? 'override' : ''} ${v && v.inheritedFrom ? 'inh' : ''}`}
                        title={`${r.name} ${y}: ${v && v.crop ? v.crop : 'no record'}${v && v.source === 'agworld' ? ' (Agworld)' : ''}${v && v.source === 'satellite' ? ` (USDA satellite: ${v.cdlName || v.crop}${v.share ? `, ${Math.round(v.share * 100)}% of field` : ''})` : ''}${v && v.recordCrop ? ` · ${v.recordSource === 'agworld' ? 'Agworld' : 'records'} say ${v.recordCrop}` : ''}${v && v.inheritedFrom ? ` · from ${v.inheritedFrom} (linked history)` : ''}${v && v.leasedOut ? ' · leased out' : ''}${r.field.sat && r.field.sat[y] && v && v.source !== 'satellite' && r.field.sat[y].crop !== v.crop ? ` · satellite says ${r.field.sat[y].crop}` : ''}`}>
                        {c ? <span style={{ background: c.bg, color: c.fg }}>{c.abbr}</span> : <span className="none" />}
                      </td>
                    )
                  })}
                  <td className="num"><strong>{r.yearsOut != null ? r.yearsOut : <span className="contracts-sub">never</span>}</strong></td>
                  <td className="num">{r.count}</td>
                  <td className="num" style={{ color: r.minGap != null && r.minGap <= 2 ? '#A32D2D' : undefined }}>{r.minGap ?? '—'}</td>
                  <td className="num">{r.compareCount}</td>
                </tr>
              ))}
              {sorted.length === 0 && <tr><td colSpan={years.length + 5} className="contracts-empty">No fields match.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

function k2label(k) {
  if (k === '1') return '1 yr (back-to-back)'
  if (k === '7+') return '7+ yrs'
  return `${k} yrs`
}

// Status of the USDA satellite crop history + the backfill button. The
// Cloud Function works for ~7 minutes per call and reports what's left, so
// the button keeps calling it until everything is filled.
function SatellitePanel({ status, fieldCount, canEdit, satFirst, rotationRecordsFirst }) {
  const [running, setRunning] = useState(false)
  const [msg, setMsg] = useState(null)
  const [open, setOpen] = useState(false)
  const [showMatch, setShowMatch] = useState(false)
  const [savingPri, setSavingPri] = useState(false)
  const agree = useMemo(() => (rotationRecordsFirst ? satelliteAgreement(rotationRecordsFirst) : null), [rotationRecordsFirst])

  async function setPriority(v) {
    setSavingPri(true)
    try { await setDoc(doc(db, 'yieldSettings', 'rotation'), { satFirst: v === 'satellite' }, { merge: true }) }
    catch (e) { setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only an Admin or Owner can change this.' : e.message }) }
    finally { setSavingPri(false) }
  }
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`)

  async function run(force) {
    setRunning(true); setMsg(null)
    try {
      const call = httpsCallable(functions, 'syncSatelliteRotationNow', { timeout: 560000 })
      let cutShort = 0
      for (let i = 0; i < 40; i++) {
        let res
        try {
          res = await call({ force: !!force && i === 0 })
          cutShort = 0
        } catch (err) {
          // Every field-year is saved as it's done, so a round that failed or
          // was cut off still made progress; keep going a few times, showing
          // the reason the server recorded.
          const code = String(err.code || '')
          if (/internal|deadline-exceeded|unavailable/.test(code) && ++cutShort <= 5) {
            setMsg({ ok: true, text: `A round stopped early (${err.message || code}); what it finished is saved. Continuing…` })
            continue
          }
          throw err
        }
        const r = res.data || {}
        setMsg({ ok: true, text: `Working… ${fmt(r.filled)} field-years filled this round, ${fmt(r.remaining)} still to look up.` })
        if (!r.remaining || r.processed === 0) {
          setMsg({ ok: !r.failed || r.filled > 0, text: `Done. ${fmt(r.fieldsWithBoundary)} fields with an Agworld outline${r.fieldsWithoutBoundary ? `, ${fmt(r.fieldsWithoutBoundary)} without one (skipped)` : ''}.${r.failed ? ` ${fmt(r.failed)} field-years couldn’t be read from USDA this time; they’re retried weekly.` : ''}` })
          break
        }
      }
    } catch (e) {
      setMsg({ ok: false, text: e.code === 'functions/not-found' ? 'The satellite function isn’t deployed yet (it deploys with the Cloud Functions workflow).' : (e.message || String(e)) })
    } finally {
      setRunning(false)
    }
  }

  const last = status && status.lastRunMs ? new Date(status.lastRunMs).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  return (
    <div className="yields-card rot-sat">
      <div className="yields-card-head" style={{ marginBottom: 0 }}>
        <div>
          <div className="yields-card-title">USDA satellite crop history</div>
          <div className="contracts-sub">
            {status
              ? `${fmt(fieldCount)} fields · ${status.firstYear || 2008}–${status.latestYear || ''} · last finished round ${last || '—'}${status.remaining ? ` · ${fmt(status.remaining)} field-years still to look up` : ''}`
              : 'Not run yet. Fills the years before 2021 (and any other gaps) from the USDA Cropland Data Layer, using each field’s Agworld outline.'}
          </div>
          {status && status.running && status.heartbeatMs && Date.now() - status.heartbeatMs < 10 * 60 * 1000 && (
            <div className="contracts-sub" style={{ color: '#185FA5' }}>
              Running now: {status.progress && status.progress.stage} · {fmt((status.progress && status.progress.filled) || 0)} filled this round
              {status.progress && status.progress.failed ? `, ${fmt(status.progress.failed)} failed` : ''} · updated {Math.max(0, Math.round((Date.now() - status.heartbeatMs) / 1000))}s ago
            </div>
          )}
          {status && status.lastError && (
            <div className="contracts-sub" style={{ color: '#A32D2D' }}>Last problem ({status.lastErrorMs ? new Date(status.lastErrorMs).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : ''}): {status.lastError}</div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <label className="rot-ctl" title="When the records and the satellite both have a crop for a year, which one the rotation uses">When both have a crop
            <select value={satFirst ? 'satellite' : 'records'} disabled={!canEdit || savingPri} onChange={(e) => setPriority(e.target.value)}>
              <option value="records">Records first</option>
              <option value="satellite">Satellite first</option>
            </select>
          </label>
          {agree && agree.n > 0 && <button className="clear-sort-btn" onClick={() => setShowMatch((o) => !o)}>{showMatch ? 'Hide match check' : `Matches records ${pct(agree.familyPct)}`}</button>}
          <button className="clear-sort-btn" onClick={() => setOpen((o) => !o)}>{open ? 'Hide' : 'About'}</button>
          {canEdit && <button className="save" disabled={running} onClick={() => run(false)}>{running ? 'Running…' : status ? 'Update now' : 'Run satellite backfill'}</button>}
        </div>
      </div>
      {open && (
        <div className="contracts-sub" style={{ marginTop: 8, lineHeight: 1.5 }}>
          Source: USDA NASS Cropland Data Layer (the yearly 30 m satellite crop map behind the Crop Sequence Boundaries viewer), read through USDA’s CropScape service. For each field and year it takes the crop covering the most of the field’s Agworld outline.
          USDA rates it about 85–95% accurate for major crops; small, narrow or double-cropped fields are less reliable, so it never overrides the yield workbook or Agworld — it only fills years they don’t have. Runs weekly on its own to pick up new fields and each new year (USDA publishes a year’s map early the following year).
          {status && status.errors && status.errors.length > 0 && <div style={{ marginTop: 6 }}>Last errors: {status.errors.slice(0, 3).join(' · ')}</div>}
          {canEdit && status && <div style={{ marginTop: 6 }}><button className="clear-sort-btn" disabled={running} onClick={() => { if (window.confirm('Look every field up again from scratch? This takes a while.')) run(true) }}>Re-check everything</button></div>}
        </div>
      )}
      {showMatch && agree && agree.n > 0 && (
        <div className="rot-match">
          <p className="contracts-sub" style={{ marginTop: 8 }}>
            Over <strong>{agree.n.toLocaleString()}</strong> field-years where both your records (workbook, entered, Agworld) and the satellite have a crop:
            the satellite names the <strong>same crop {pct(agree.exactPct)}</strong> of the time, and the <strong>same rotation group {pct(agree.familyPct)}</strong>
            (counting wheat / barley / “small grain” as one group, alfalfa / other hay as one, field / sweet corn as one).
            If that second number is high for the crops you care about, “Satellite first” is a safe switch.
          </p>
          <div className="rot-match-grid">
            <div className="table-scroll" style={{ maxHeight: 280 }}>
              <table className="contracts-table contracts-table-auto">
                <thead><tr><th>Records say</th><th className="num">Years</th><th className="num">Same crop</th><th className="num">Same group</th><th>When it differs, satellite says</th></tr></thead>
                <tbody>
                  {agree.crops.map((c) => (
                    <tr key={c.crop}>
                      <td><strong>{cropLabel(c.crop)}</strong></td>
                      <td className="num">{c.n}</td>
                      <td className="num">{pct(c.exact / c.n)}</td>
                      <td className="num" style={{ color: c.family / c.n >= 0.85 ? '#3B6D11' : c.family / c.n < 0.7 ? '#A32D2D' : undefined }}><strong>{pct(c.family / c.n)}</strong></td>
                      <td className="contracts-sub">{Object.entries(c.saidAs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${cropLabel(k)} ${v}`).join(', ') || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-scroll" style={{ maxHeight: 280 }}>
              <table className="contracts-table contracts-table-auto">
                <thead><tr><th>Disagreements ({agree.misses.length})</th><th>Year</th><th>Records</th><th>Satellite</th></tr></thead>
                <tbody>
                  {agree.misses.slice(0, 200).map((m, i) => (
                    <tr key={i}>
                      <td>{m.field}</td><td>{m.year}</td>
                      <td>{cropLabel(m.record)}{m.recordSource === 'agworld' ? ' (AW)' : ''}</td>
                      <td>{cropLabel(m.satellite)}{m.share ? <span className="contracts-sub"> {Math.round(m.share * 100)}%</span> : null}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {msg && <div className={msg.ok ? 'yields-ok' : 'agronomy-error-banner'}>{msg.text}</div>}
    </div>
  )
}
