import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, STATUS_COLOR, CROP_COLOR } from './AgronomyConfig.js'
import { useLiveAgronomyCriteria, getCurveRows, mergeFlatTargets } from './AgronomyCriteriaData.js'
import {
  metricValue, curveRangeForWeek, weeksBetween, fmtChartValue,
  IN_SEASON_WEEK_MIN, IN_SEASON_WEEK_MAX, MOISTURE_TARGET
} from './AgronomyByField.jsx'

// Compare fields: one measure across every field in the list (the season,
// farm and crop filters apply), week by week since each field's emergence.
// Answers "how many fields were below range in week 9", "which fields were
// 70% moisture or lower", and shows the whole season as a heat map.

const STATUS_ORDER = ['deficient', 'optimal', 'excess']
const STATUS_WORD = { deficient: 'Below', optimal: 'In range', excess: 'Above' }

const METRICS = [
  { id: 'soil', label: 'Soil NO3', unit: 'ppm', defaultLimit: 20, defaultDir: 'below' },
  { id: 'petiole', label: 'Petiole NO3', unit: 'ppm', defaultLimit: 18000, defaultDir: 'below' },
  { id: 'moisture', label: 'Field moisture', unit: '%', defaultLimit: 70, defaultDir: 'below' },
  { id: 'nitrogen', label: 'N applied', unit: 'lbs N/ac', noStatus: true }
]

function fmtDay(d) {
  return d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : ''
}

export default function AgronomyCompare({ fields }) {
  const [metricId, setMetricId] = useState('moisture')
  const [mode, setMode] = useState('range') // 'range' = target range, 'limit' = custom limit
  const [limitDir, setLimitDir] = useState('below')
  const [limitValue, setLimitValue] = useState('70')
  const [cropFilter, setCropFilter] = useState('all')
  const [sortBy, setSortBy] = useState('name')
  const [pickedWeek, setPickedWeek] = useState(null)

  const metricDef = METRICS.find((m) => m.id === metricId)
  const noStatus = !!metricDef.noStatus

  // Sensible limit for each measure when it's picked.
  useEffect(() => {
    if (metricDef.noStatus) return
    setLimitDir(metricDef.defaultDir)
    setLimitValue(String(metricDef.defaultLimit))
  }, [metricId]) // eslint-disable-line react-hooks/exhaustive-deps

  const cropOptions = useMemo(() => [...new Set(fields.map((f) => f.cropName).filter(Boolean))].sort(), [fields])
  useEffect(() => {
    if (cropFilter !== 'all' && !cropOptions.includes(cropFilter)) setCropFilter('all')
  }, [cropOptions, cropFilter])
  const visible = useMemo(
    () => fields.filter((f) => f.plantDate && (cropFilter === 'all' || f.cropName === cropFilter)),
    [fields, cropFilter]
  )

  // ---- data: everything in the season, filtered in the browser ------------
  const seasonStart = useMemo(() => {
    const years = fields.filter((f) => f.plantDate).map((f) => new Date(f.plantDate).getFullYear())
    return new Date(years.length ? Math.min(...years) : new Date().getFullYear(), 0, 1)
  }, [fields])

  const [samples, setSamples] = useState([])
  const [observations, setObservations] = useState([])
  const [nApps, setNApps] = useState([])
  const [error, setError] = useState(null)

  useEffect(() => {
    const q = query(collection(db, 'samples'), where('receivedDt', '>=', seasonStart))
    return onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => {
          const v = d.data()
          if (v.type === 'soil' || v.type === 'petiole') list.push(v)
        })
        setSamples(list)
        setError(null)
      },
      (err) => { console.error('AgronomyCompare samples query failed:', err); setError(err.message) }
    )
  }, [seasonStart])
  useEffect(() => onSnapshot(
    collection(db, 'scoutingObservations'),
    (snap) => {
      const list = []
      snap.forEach((d) => { const v = d.data(); if (v.fieldId) list.push(v) })
      setObservations(list)
    },
    (err) => console.error('AgronomyCompare scouting query failed:', err)
  ), [])
  useEffect(() => onSnapshot(
    collection(db, 'nApplications'),
    (snap) => {
      const list = []
      snap.forEach((d) => list.push(d.data()))
      setNApps(list)
    },
    (err) => console.error('AgronomyCompare nApplications query failed:', err)
  ), [])

  const { flatTargets, curvesByKey } = useLiveAgronomyCriteria()
  const metricsByType = useMemo(() => mergeFlatTargets(METRICS_BY_TYPE, flatTargets), [flatTargets])

  // ---- per-field weekly values -----------------------------------------------
  // cells[fieldId][week] = { value, range, status }
  const { cells, weeks } = useMemo(() => {
    const out = {}
    const weekSet = new Set()
    const limit = parseFloat(limitValue)
    const byId = {}
    visible.forEach((f) => { byId[f.id] = { f, plant: new Date(f.plantDate), curve: getCurveRows(curvesByKey, f.cropName, f.varietyName) } })

    const rangeFor = (info, week) => {
      if (metricId === 'moisture') return MOISTURE_TARGET
      const type = metricId
      const m = metricsByType[type][0]
      const curveKey = type === 'soil' ? 'soilNO3' : 'petioleNO3'
      return (info.curve && curveRangeForWeek(info.curve, week, curveKey)) || m.target
    }
    const statusOf = (value, info, week) => {
      if (noStatus) return null
      if (mode === 'limit') {
        if (!Number.isFinite(limit)) return null
        if (limitDir === 'below') return value <= limit ? 'deficient' : 'optimal'
        return value >= limit ? 'excess' : 'optimal'
      }
      const r = rangeFor(info, week)
      if (!r) return null
      return value < r[0] ? 'deficient' : value > r[1] ? 'excess' : 'optimal'
    }
    const put = (fieldId, week, value, stamp, sum) => {
      const info = byId[fieldId]
      if (!info || week == null || week < IN_SEASON_WEEK_MIN || week > IN_SEASON_WEEK_MAX) return
      const row = out[fieldId] || (out[fieldId] = {})
      const prev = row[week]
      if (sum) value = (prev ? prev.value : 0) + value
      else if (prev && prev.stamp > stamp) return
      row[week] = { value: sum ? Math.round(value * 10) / 10 : value, stamp, status: null, range: null }
      weekSet.add(week)
    }

    if (metricId === 'soil' || metricId === 'petiole') {
      const m = metricsByType[metricId][0]
      samples.forEach((s) => {
        if (s.type !== metricId || !s.receivedDt || !byId[s.fieldId]) return
        const v = metricValue(s.values, metricId, m)
        if (v == null) return
        const d = s.receivedDt.toDate()
        put(s.fieldId, weeksBetween(d, byId[s.fieldId].plant), v, +d, false)
      })
    } else if (metricId === 'moisture') {
      observations.forEach((o) => {
        if (o.moisture == null || !o.observedAt || !byId[o.fieldId]) return
        const d = o.observedAt.toDate()
        put(o.fieldId, weeksBetween(d, byId[o.fieldId].plant), o.moisture, +d, false)
      })
    } else {
      nApps.forEach((a) => {
        if (!(a.nLbsPerAc > 0) || !a.date || !byId[a.fieldId]) return
        const d = a.date.toDate()
        put(a.fieldId, weeksBetween(d, byId[a.fieldId].plant), a.nLbsPerAc, +d, true)
      })
    }
    // judge each cell
    Object.entries(out).forEach(([fieldId, row]) => {
      Object.entries(row).forEach(([wk, cell]) => {
        const week = Number(wk)
        cell.range = noStatus ? null : rangeFor(byId[fieldId], week)
        cell.status = statusOf(cell.value, byId[fieldId], week)
      })
    })
    const all = [...weekSet].sort((a, b) => a - b)
    const contiguous = all.length ? Array.from({ length: all[all.length - 1] - all[0] + 1 }, (_, i) => all[0] + i) : []
    return { cells: out, weeks: contiguous }
  }, [visible, samples, observations, nApps, metricId, mode, limitDir, limitValue, noStatus, curvesByKey, metricsByType])

  // Which week the lists below show: the picked one, else the newest with data.
  const shownWeek = pickedWeek != null && weeks.includes(pickedWeek) ? pickedWeek : (weeks.length ? weeks[weeks.length - 1] : null)

  // ---- counts per week --------------------------------------------------------
  const counts = useMemo(() => weeks.map((w) => {
    const c = { week: w, deficient: 0, optimal: 0, excess: 0, reporting: 0, nTotal: 0 }
    visible.forEach((f) => {
      const cell = cells[f.id] && cells[f.id][w]
      if (!cell) return
      c.reporting++
      if (cell.status) c[cell.status]++
      c.nTotal += cell.value
    })
    return c
  }), [weeks, visible, cells])

  const rows = useMemo(() => {
    const list = visible.filter((f) => cells[f.id])
    const flagged = (f) => Object.values(cells[f.id]).filter((c) => c.status === 'deficient' || c.status === 'excess').length
    list.sort(sortBy === 'flagged'
      ? (a, b) => flagged(b) - flagged(a) || (a.name || '').localeCompare(b.name || '')
      : (a, b) => (a.name || '').localeCompare(b.name || ''))
    return list
  }, [visible, cells, sortBy])

  const shownCounts = counts.find((c) => c.week === shownWeek)
  const fieldsByStatus = useMemo(() => {
    const out = { deficient: [], optimal: [], excess: [], other: [] }
    if (shownWeek == null) return out
    visible.forEach((f) => {
      const cell = cells[f.id] && cells[f.id][shownWeek]
      if (!cell) return
      out[cell.status || 'other'].push({ f, cell })
    })
    Object.values(out).forEach((l) => l.sort((a, b) => (a.f.name || '').localeCompare(b.f.name || '')))
    return out
  }, [visible, cells, shownWeek])

  // ---- chart ------------------------------------------------------------------
  const W = 720, H = 236, padL = 34, padR = 10, padT = 14, padB = 34
  const plotW = W - padL - padR, plotH = H - padT - padB
  const stackMax = noStatus
    ? Math.max(1, ...counts.map((c) => c.reporting))
    : Math.max(1, ...counts.map((c) => c.deficient + c.optimal + c.excess))
  const slot = weeks.length ? plotW / weeks.length : plotW
  const barW = Math.max(4, Math.min(34, slot * 0.72))
  const yOf = (n) => padT + plotH - (n / stackMax) * plotH
  const xCenter = (i) => padL + slot * i + slot / 2
  const tickEvery = weeks.length > 24 ? 3 : weeks.length > 14 ? 2 : 1
  const yTicks = [...new Set([0, Math.ceil(stackMax / 2), stackMax])]

  const limitLabel = mode === 'limit' ? `${limitDir === 'below' ? '≤' : '≥'} ${limitValue} ${metricDef.unit}` : null
  const wordFor = (s) => (mode === 'limit' && !noStatus
    ? (s === 'deficient' ? `${limitValue} or below` : s === 'excess' ? `${limitValue} or above` : 'Not flagged')
    : STATUS_WORD[s])
  const chipStyle = (status) => {
    const c = status ? STATUS_COLOR[status] : null
    return { display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontWeight: 600, fontSize: 11, ...(c ? { background: c.bg, color: c.fg } : { background: '#eee', color: '#555' }) }
  }
  const cellStyle = (cell) => {
    if (noStatus) {
      const a = Math.min(1, cell.value / 80)
      return { background: `rgba(199,125,10,${0.15 + a * 0.6})`, color: '#4a2f00' }
    }
    const c = cell.status ? STATUS_COLOR[cell.status] : null
    // limit mode: only flagged cells are coloured, the rest stay plain
    if (mode === 'limit' && cell.status === 'optimal') return { background: '#f1efe8', color: '#555' }
    return c ? { background: c.bg, color: c.fg } : { background: '#eee', color: '#555' }
  }

  const statuses = noStatus ? [] : mode === 'limit'
    ? (limitDir === 'below' ? ['deficient', 'optimal'] : ['optimal', 'excess'])
    : STATUS_ORDER

  return (
    <div className="agronomy-compare">
      {error && <p className="agronomy-error-banner">Couldn't load samples: {error}</p>}

      <div className="agronomy-field-picker" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={metricId} onChange={(e) => setMetricId(e.target.value)}>
          {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.unit})</option>)}
        </select>
        <select value={cropFilter} onChange={(e) => setCropFilter(e.target.value)}>
          <option value="all">All crops</option>
          {cropOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {!noStatus && (
          <>
            <select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="range">vs target range</option>
              <option value="limit">vs my own limit</option>
            </select>
            {mode === 'limit' && (
              <>
                <select value={limitDir} onChange={(e) => setLimitDir(e.target.value)}>
                  <option value="below">at or below</option>
                  <option value="above">at or above</option>
                </select>
                <input
                  type="number" value={limitValue} onChange={(e) => setLimitValue(e.target.value)}
                  style={{ width: 90 }} aria-label="limit"
                />
                <span style={{ fontSize: 12, color: '#666' }}>{metricDef.unit}</span>
              </>
            )}
          </>
        )}
      </div>
      <p style={{ fontSize: 11, color: '#666', margin: '4px 0 10px' }}>
        {visible.length} fields in this list {'·'} weeks since each field's emergence {'·'}{' '}
        {noStatus ? 'amber = lbs of N applied that week.'
          : mode === 'limit' ? `red = ${limitLabel}.`
          : metricId === 'moisture' ? `target ${MOISTURE_TARGET[0]}–${MOISTURE_TARGET[1]}%, the same for every field.`
          : 'each reading is judged against the target for its crop and week.'}
      </p>

      {weeks.length === 0 ? (
        <div className="agronomy-chart-empty">
          No {metricDef.label.toLowerCase()} readings for these fields this season
          {metricId === 'moisture' ? ' - upload a scouting report on the Scouting tab' : ''}
          {metricId === 'nitrogen' ? ' - run the nitrogen sync on the Scouting tab' : ''}.
        </div>
      ) : (
        <>
          <div className="agronomy-chart-card" style={{ marginBottom: 14 }}>
            <p className="agronomy-chart-title">
              {noStatus ? 'Fields applying N each week' : `Fields by status each week - ${metricDef.label}`}
              {' · click a week to list its fields'}
            </p>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
              {yTicks.map((t) => (
                <g key={t}>
                  <line x1={padL} x2={W - padR} y1={yOf(t)} y2={yOf(t)} stroke="#e4e0d4" strokeWidth="1" />
                  <text x={padL - 4} y={yOf(t) + 3} textAnchor="end" fontSize="9" fill="#777">{t}</text>
                </g>
              ))}
              {counts.map((c, i) => {
                const x = xCenter(i) - barW / 2
                const sel = c.week === shownWeek
                let acc = 0
                const segs = noStatus
                  ? [{ key: 'n', n: c.reporting, fill: '#C77D0A' }]
                  : statuses.map((s) => ({ key: s, n: c[s], fill: STATUS_COLOR[s].dot }))
                return (
                  <g key={c.week} onClick={() => setPickedWeek(c.week)} style={{ cursor: 'pointer' }}>
                    <rect x={padL + slot * i} y={padT} width={slot} height={plotH + 18} fill={sel ? 'rgba(60,90,63,0.10)' : 'transparent'} />
                    {segs.map((sg) => {
                      if (!sg.n) return null
                      const y0 = yOf(acc + sg.n), h = yOf(acc) - y0
                      acc += sg.n
                      return (
                        <g key={sg.key}>
                          <rect x={x} y={y0} width={barW} height={h} fill={sg.fill} />
                          {h >= 11 && barW >= 9 && (
                            <text x={x + barW / 2} y={y0 + h / 2 + 3} textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">{sg.n}</text>
                          )}
                        </g>
                      )
                    })}
                    {(i % tickEvery === 0 || sel) && (
                      <text x={xCenter(i)} y={H - 18} textAnchor="middle" fontSize="9" fontWeight={sel ? 700 : 400} fill={sel ? '#222' : '#666'}>
                        {c.week}
                      </text>
                    )}
                    <title>
                      Week {c.week}: {c.reporting} reporting
                      {noStatus ? '' : ` - ${statuses.map((s) => `${c[s]} ${wordFor(s)}`).join(', ')}`}
                    </title>
                  </g>
                )
              })}
              <text x={padL + plotW / 2} y={H - 1} textAnchor="middle" fontSize="9" fill="#777">weeks since emergence</text>
            </svg>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, marginTop: 4 }}>
              {noStatus
                ? <span><span style={{ color: '#C77D0A' }}>{'■'}</span> fields that applied N that week</span>
                : statuses.map((s) => (
                  <span key={s}><span style={{ color: STATUS_COLOR[s].dot }}>{'■'}</span> {wordFor(s)}</span>
                ))}
              <span style={{ color: '#888' }}>fields with no reading that week are left out</span>
            </div>
          </div>

          {shownWeek != null && shownCounts && (
            <div className="agronomy-chart-card" style={{ marginBottom: 14 }}>
              <p className="agronomy-chart-title">
                Week {shownWeek}: {shownCounts.reporting} of {visible.length} fields have a reading
                {noStatus ? ` - ${Math.round((shownCounts.nTotal / Math.max(1, shownCounts.reporting)) * 10) / 10} lbs N/ac on average` : ''}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
                {(noStatus ? ['other'] : statuses).map((s) => (
                  <div key={s}>
                    <p style={{ fontSize: 12, fontWeight: 700, margin: '0 0 4px', color: s === 'other' ? '#555' : STATUS_COLOR[s].fg }}>
                      {s === 'other' ? 'Applied N' : wordFor(s)} ({fieldsByStatus[s].length})
                    </p>
                    {fieldsByStatus[s].length === 0 && <p style={{ fontSize: 11, color: '#999', margin: 0 }}>none</p>}
                    {fieldsByStatus[s].map(({ f, cell }) => (
                      <div key={f.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 12, padding: '1px 0' }}>
                        <span>{f.name}</span>
                        <span style={chipStyle(cell.status)}>{fmtChartValue(cell.value)}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 6px' }}>
            <p className="agronomy-section-label" style={{ margin: 0 }}>Every field, every week</p>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="name">sort by name</option>
              {!noStatus && <option value="flagged">sort by most weeks flagged</option>}
            </select>
          </div>
          <div style={{ overflow: 'auto', maxHeight: 560, border: '1px solid #ddd8cc', borderRadius: 6, background: '#fff' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 10, minWidth: 0 }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, top: 0, zIndex: 3, background: '#f4f2ec', textAlign: 'left', padding: '4px 8px' }}>Field</th>
                  {weeks.map((w) => (
                    <th
                      key={w}
                      onClick={() => setPickedWeek(w)}
                      style={{ position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer', padding: '4px 5px', minWidth: 30,
                        background: w === shownWeek ? '#dfe8d8' : '#f4f2ec', fontWeight: w === shownWeek ? 700 : 500 }}
                    >
                      {w}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((f) => {
                  const cropColor = CROP_COLOR[f.cropName]
                  return (
                    <tr key={f.id}>
                      <td style={{ position: 'sticky', left: 0, zIndex: 1, background: '#fff', padding: '2px 8px', whiteSpace: 'nowrap', borderTop: '1px solid #eee' }}>
                        {f.name}
                        {f.cropName && (
                          <span style={{ marginLeft: 6, fontSize: 9, padding: '0 5px', borderRadius: 3, background: cropColor ? cropColor.bg : '#D3D1C7', color: cropColor ? cropColor.fg : '#2C2C2A' }}>
                            {f.cropName}
                          </span>
                        )}
                      </td>
                      {weeks.map((w) => {
                        const cell = cells[f.id] && cells[f.id][w]
                        return (
                          <td
                            key={w}
                            onClick={() => setPickedWeek(w)}
                            title={cell ? `${f.name} - week ${w}: ${cell.value} ${metricDef.unit}${cell.range ? ` (target ${cell.range[0]}-${cell.range[1]})` : ''}` : ''}
                            style={{ textAlign: 'center', padding: '2px 3px', borderTop: '1px solid #eee', cursor: 'pointer',
                              boxShadow: w === shownWeek ? 'inset 0 0 0 1px rgba(60,90,63,0.6)' : 'none',
                              ...(cell ? cellStyle(cell) : {}) }}
                          >
                            {cell ? fmtChartValue(cell.value) : ''}
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
