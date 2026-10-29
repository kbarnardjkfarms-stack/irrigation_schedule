import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, STATUS_COLOR, CROP_COLOR } from './AgronomyConfig.js'
import { useLiveAgronomyCriteria, getCurveRows, mergeFlatTargets } from './AgronomyCriteriaData.js'
import {
  metricValue, curveRangeForWeek, weeksBetween, fmtChartValue,
  IN_SEASON_WEEK_MIN, IN_SEASON_WEEK_MAX, MOISTURE_TARGET
} from './AgronomyByField.jsx'

// Compare fields: one measure across every field in the list (the season and
// farm filters above apply), week by week. Shows how many fields were below /
// in / above range, the average with its spread, and every field as a heat
// map - by weeks since emergence or by calendar date - with filters for
// picking out the fields that are flagged most.

const STATUS_ORDER = ['deficient', 'optimal', 'excess']
const STATUS_WORD = { deficient: 'Below', optimal: 'In range', excess: 'Above' }

const METRICS = [
  { id: 'soil', label: 'Soil NO3', unit: 'ppm', defaultLimit: 20, defaultDir: 'below' },
  { id: 'petiole', label: 'Petiole NO3', unit: 'ppm', defaultLimit: 18000, defaultDir: 'below' },
  { id: 'moisture', label: 'Field moisture', unit: '%', defaultLimit: 70, defaultDir: 'below' },
  { id: 'nitrogen', label: 'N applied', unit: 'lbs N/ac', noStatus: true }
]

const fmtDay = (d) => (d ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '')

// Calendar weeks start on Monday.
function mondayOf(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7))
  return x.getTime()
}
function addDays(ms, n) {
  const x = new Date(ms)
  x.setDate(x.getDate() + n)
  return x.getTime()
}
const toInputDate = (ms) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function AgronomyCompare({ fields }) {
  const [metricId, setMetricId] = useState('moisture')
  const [mode, setMode] = useState('range') // 'range' = target range, 'limit' = custom limit
  const [limitDir, setLimitDir] = useState('below')
  const [limitValue, setLimitValue] = useState('70')
  const [axis, setAxis] = useState('weeks') // 'weeks' | 'dates'
  const [chartType, setChartType] = useState('count') // 'count' | 'percent' | 'trend'
  const [cropFilter, setCropFilter] = useState('all')
  const [varietyFilter, setVarietyFilter] = useState('all')
  const [search, setSearch] = useState('')
  const [flagType, setFlagType] = useState('either') // what counts as "flagged": below | above | either
  const [rowFilter, setRowFilter] = useState('all') // all | selected | latest | min | top
  const [filterN, setFilterN] = useState('3')
  const [fromV, setFromV] = useState('')
  const [toV, setToV] = useState('')
  const [sortBy, setSortBy] = useState('name')
  const [cellMode, setCellMode] = useState('value') // 'value' | 'dot'
  const [pickedKey, setPickedKey] = useState(null)

  const metricDef = METRICS.find((m) => m.id === metricId)
  const noStatus = !!metricDef.noStatus

  useEffect(() => {
    if (metricDef.noStatus) return
    setLimitDir(metricDef.defaultDir)
    setLimitValue(String(metricDef.defaultLimit))
  }, [metricId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setFromV(''); setToV(''); setPickedKey(null) }, [axis])
  useEffect(() => { if (noStatus) setRowFilter('all') }, [noStatus])

  const cropOptions = useMemo(() => [...new Set(fields.map((f) => f.cropName).filter(Boolean))].sort(), [fields])
  useEffect(() => {
    if (cropFilter !== 'all' && !cropOptions.includes(cropFilter)) setCropFilter('all')
  }, [cropOptions, cropFilter])
  const varietyOptions = useMemo(
    () => [...new Set(fields.filter((f) => cropFilter === 'all' || f.cropName === cropFilter).map((f) => f.varietyName).filter(Boolean))].sort(),
    [fields, cropFilter]
  )
  useEffect(() => {
    if (varietyFilter !== 'all' && !varietyOptions.includes(varietyFilter)) setVarietyFilter('all')
  }, [varietyOptions, varietyFilter])

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return fields.filter((f) => f.plantDate
      && (cropFilter === 'all' || f.cropName === cropFilter)
      && (varietyFilter === 'all' || f.varietyName === varietyFilter)
      && (!q || (f.name || '').toLowerCase().includes(q)))
  }, [fields, cropFilter, varietyFilter, search])

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

  // ---- per-field values, bucketed by week / calendar week -----------------
  // allCells[fieldId][bucketKey] = { value, stamp, ewk, status, range }
  const { allCells, allKeys } = useMemo(() => {
    const out = {}
    const keySet = new Set()
    const limit = parseFloat(limitValue)
    const byId = {}
    visible.forEach((f) => { byId[f.id] = { f, plant: new Date(f.plantDate), curve: getCurveRows(curvesByKey, f.cropName, f.varietyName) } })

    const rangeFor = (info, ewk) => {
      if (metricId === 'moisture') return MOISTURE_TARGET
      const m = metricsByType[metricId][0]
      const curveKey = metricId === 'soil' ? 'soilNO3' : 'petioleNO3'
      return (info.curve && curveRangeForWeek(info.curve, ewk, curveKey)) || m.target
    }
    const statusOf = (value, range) => {
      if (noStatus) return null
      if (mode === 'limit') {
        if (!Number.isFinite(limit)) return null
        if (limitDir === 'below') return value <= limit ? 'deficient' : 'optimal'
        return value >= limit ? 'excess' : 'optimal'
      }
      if (!range) return null
      return value < range[0] ? 'deficient' : value > range[1] ? 'excess' : 'optimal'
    }
    const put = (fieldId, date, value, sum) => {
      const info = byId[fieldId]
      if (!info) return
      const ewk = weeksBetween(date, info.plant)
      if (ewk == null || ewk < IN_SEASON_WEEK_MIN || ewk > IN_SEASON_WEEK_MAX) return
      const key = axis === 'weeks' ? ewk : mondayOf(date)
      const stamp = +date
      const row = out[fieldId] || (out[fieldId] = {})
      const prev = row[key]
      if (sum) {
        row[key] = { value: Math.round(((prev ? prev.value : 0) + value) * 10) / 10, stamp, ewk }
      } else {
        if (prev && prev.stamp > stamp) return
        row[key] = { value, stamp, ewk }
      }
      keySet.add(key)
    }

    if (metricId === 'soil' || metricId === 'petiole') {
      const m = metricsByType[metricId][0]
      samples.forEach((s) => {
        if (s.type !== metricId || !s.receivedDt || !byId[s.fieldId]) return
        const v = metricValue(s.values, metricId, m)
        if (v != null) put(s.fieldId, s.receivedDt.toDate(), v, false)
      })
    } else if (metricId === 'moisture') {
      observations.forEach((o) => {
        if (o.moisture != null && o.observedAt && byId[o.fieldId]) put(o.fieldId, o.observedAt.toDate(), o.moisture, false)
      })
    } else {
      nApps.forEach((a) => {
        if (a.nLbsPerAc > 0 && a.date && byId[a.fieldId]) put(a.fieldId, a.date.toDate(), a.nLbsPerAc, true)
      })
    }
    Object.entries(out).forEach(([fieldId, row]) => {
      Object.values(row).forEach((cell) => {
        cell.range = noStatus ? null : rangeFor(byId[fieldId], cell.ewk)
        cell.status = statusOf(cell.value, cell.range)
      })
    })
    const sorted = [...keySet].sort((a, b) => a - b)
    let keys = []
    if (sorted.length) {
      if (axis === 'weeks') {
        keys = Array.from({ length: sorted[sorted.length - 1] - sorted[0] + 1 }, (_, i) => sorted[0] + i)
      } else {
        for (let k = sorted[0]; k <= sorted[sorted.length - 1]; k = addDays(k, 7)) keys.push(k)
      }
    }
    return { allCells: out, allKeys: keys }
  }, [visible, samples, observations, nApps, metricId, mode, limitDir, limitValue, noStatus, curvesByKey, metricsByType, axis])

  // Optional "from / to" window on the horizontal axis.
  const keys = useMemo(() => {
    const parse = (v) => {
      if (v === '' || v == null) return null
      if (axis === 'weeks') return Number.isFinite(Number(v)) ? Number(v) : null
      const d = new Date(`${v}T00:00:00`)
      return Number.isNaN(d.getTime()) ? null : mondayOf(d)
    }
    const lo = parse(fromV), hi = parse(toV)
    return allKeys.filter((k) => (lo == null || k >= lo) && (hi == null || k <= hi))
  }, [allKeys, fromV, toV, axis])

  const keyLabel = (k) => (axis === 'weeks' ? String(k) : fmtDay(new Date(k)))
  const keyLong = (k) => (axis === 'weeks' ? `week ${k}` : `week of ${fmtDay(new Date(k))}`)

  // Median planting date: turns "week 9" into a rough calendar date.
  const medianPlant = useMemo(() => {
    const t = visible.map((f) => new Date(f.plantDate).getTime()).sort((a, b) => a - b)
    return t.length ? t[Math.floor(t.length / 2)] : null
  }, [visible])
  const approxDate = (w) => (medianPlant == null ? '' : fmtDay(new Date(addDays(medianPlant, w * 7))))

  // ---- flags per field, then the row filter --------------------------------
  const isFlagged = (cell) => {
    if (!cell || !cell.status) return false
    if (flagType === 'below') return cell.status === 'deficient'
    if (flagType === 'above') return cell.status === 'excess'
    return cell.status === 'deficient' || cell.status === 'excess'
  }
  const shownKey = pickedKey != null && keys.includes(pickedKey) ? pickedKey : (keys.length ? keys[keys.length - 1] : null)

  const fieldStats = useMemo(() => {
    const out = {}
    visible.forEach((f) => {
      const row = allCells[f.id]
      if (!row) return
      let flagged = 0, reporting = 0, latestKey = null
      keys.forEach((k) => {
        const c = row[k]
        if (!c) return
        reporting++
        if (isFlagged(c)) flagged++
        latestKey = k
      })
      if (!reporting) return
      out[f.id] = { flagged, reporting, pct: flagged / reporting, latest: row[latestKey], latestFlagged: isFlagged(row[latestKey]) }
    })
    return out
  }, [visible, allCells, keys, flagType]) // eslint-disable-line react-hooks/exhaustive-deps

  const shownFields = useMemo(() => {
    const n = Math.max(1, parseInt(filterN, 10) || 1)
    let list = visible.filter((f) => fieldStats[f.id])
    if (!noStatus) {
      if (rowFilter === 'selected') list = list.filter((f) => isFlagged(allCells[f.id][shownKey]))
      else if (rowFilter === 'latest') list = list.filter((f) => fieldStats[f.id].latestFlagged)
      else if (rowFilter === 'min') list = list.filter((f) => fieldStats[f.id].flagged >= n)
      else if (rowFilter === 'top') {
        list = [...list].sort((a, b) => fieldStats[b.id].flagged - fieldStats[a.id].flagged || (a.name || '').localeCompare(b.name || '')).slice(0, n)
      }
    }
    const nameCmp = (a, b) => (a.name || '').localeCompare(b.name || '')
    const latestVal = (f) => fieldStats[f.id].latest.value
    const sorters = {
      name: nameCmp,
      flagged: (a, b) => fieldStats[b.id].flagged - fieldStats[a.id].flagged || nameCmp(a, b),
      pct: (a, b) => fieldStats[b.id].pct - fieldStats[a.id].pct || nameCmp(a, b),
      latestLow: (a, b) => latestVal(a) - latestVal(b) || nameCmp(a, b),
      latestHigh: (a, b) => latestVal(b) - latestVal(a) || nameCmp(a, b),
      crop: (a, b) => (a.cropName || '').localeCompare(b.cropName || '') || nameCmp(a, b)
    }
    return [...list].sort(sorters[sortBy] || nameCmp)
  }, [visible, fieldStats, rowFilter, filterN, flagType, shownKey, allCells, sortBy, noStatus]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- per-bucket numbers for the shown fields -------------------------------
  const perKey = useMemo(() => keys.map((k) => {
    const c = { key: k, deficient: 0, optimal: 0, excess: 0, reporting: 0, sum: 0, min: Infinity, max: -Infinity }
    shownFields.forEach((f) => {
      const cell = allCells[f.id] && allCells[f.id][k]
      if (!cell) return
      c.reporting++
      if (cell.status) c[cell.status]++
      c.sum += cell.value
      c.min = Math.min(c.min, cell.value)
      c.max = Math.max(c.max, cell.value)
    })
    c.avg = c.reporting ? c.sum / c.reporting : null
    return c
  }), [keys, shownFields, allCells])

  const shownCounts = perKey.find((c) => c.key === shownKey)
  const fieldsByStatus = useMemo(() => {
    const out = { deficient: [], optimal: [], excess: [], other: [] }
    if (shownKey == null) return out
    shownFields.forEach((f) => {
      const cell = allCells[f.id] && allCells[f.id][shownKey]
      if (cell) out[cell.status || 'other'].push({ f, cell })
    })
    Object.values(out).forEach((l) => l.sort((a, b) => (a.f.name || '').localeCompare(b.f.name || '')))
    return out
  }, [shownFields, allCells, shownKey])

  // headline numbers
  const flaggedIn = (c) => (flagType === 'below' ? c.deficient : flagType === 'above' ? c.excess : c.deficient + c.excess)
  const latestC = perKey.length ? perKey[perKey.length - 1] : null
  const worst = useMemo(() => {
    if (noStatus) return null
    let best = null
    perKey.forEach((c) => {
      const n = flaggedIn(c)
      if (n > 0 && (!best || n > best.n)) best = { key: c.key, n, of: c.reporting }
    })
    return best
  }, [perKey, flagType, noStatus]) // eslint-disable-line react-hooks/exhaustive-deps
  const mostFlagged = useMemo(() => {
    if (noStatus) return null
    let best = null
    shownFields.forEach((f) => {
      const s = fieldStats[f.id]
      if (s && s.flagged > 0 && (!best || s.flagged > best.n)) best = { f, n: s.flagged, of: s.reporting }
    })
    return best
  }, [shownFields, fieldStats, noStatus])
  const latestFlaggedCount = latestC ? flaggedIn(latestC) : 0

  // ---- chart ------------------------------------------------------------------
  const W = 720, H = 262, padL = 38, padR = 12, padT = 14, padB = 52
  const plotW = W - padL - padR, plotH = H - padT - padB
  const slot = keys.length ? plotW / keys.length : plotW
  const barW = Math.max(4, Math.min(34, slot * 0.72))
  const xCenter = (i) => padL + slot * i + slot / 2
  const tickEvery = keys.length > 24 ? 3 : keys.length > 14 ? 2 : 1
  const limitNum = parseFloat(limitValue)

  const stackMax = chartType === 'percent'
    ? 100
    : Math.max(1, ...perKey.map((c) => (noStatus ? c.reporting : c.deficient + c.optimal + c.excess)))
  const trendVals = perKey.filter((c) => c.reporting).flatMap((c) => [c.min, c.max])
  let tLo = trendVals.length ? Math.min(...trendVals) : 0
  let tHi = trendVals.length ? Math.max(...trendVals) : 1
  const refLo = !noStatus && mode === 'range' && metricId === 'moisture' ? MOISTURE_TARGET[0] : null
  const refHi = !noStatus && mode === 'range' && metricId === 'moisture' ? MOISTURE_TARGET[1] : null
  if (refLo != null) { tLo = Math.min(tLo, refLo); tHi = Math.max(tHi, refHi) }
  if (!noStatus && mode === 'limit' && Number.isFinite(limitNum)) { tLo = Math.min(tLo, limitNum); tHi = Math.max(tHi, limitNum) }
  const pad = (tHi - tLo || 1) * 0.08
  if (tLo >= 0) tLo = Math.max(0, tLo - pad); else tLo -= pad
  tHi += pad
  const yStack = (n) => padT + plotH - (n / stackMax) * plotH
  const yTrend = (v) => padT + plotH - ((v - tLo) / (tHi - tLo || 1)) * plotH
  const stackTicks = [...new Set([0, Math.ceil(stackMax / 2), stackMax])]
  const trendTicks = [tLo, (tLo + tHi) / 2, tHi]

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
    if (mode === 'limit' && cell.status === 'optimal') return { background: '#f1efe8', color: '#555' }
    return c ? { background: c.bg, color: c.fg } : { background: '#eee', color: '#555' }
  }
  const dotCellStyle = (cell) => {
    if (noStatus) return { background: cellStyle(cell).background, color: 'transparent' }
    if (mode === 'limit' && cell.status === 'optimal') return { background: '#f1efe8', color: 'transparent' }
    return { background: cell.status ? STATUS_COLOR[cell.status].dot : '#ccc', color: 'transparent' }
  }
  const statuses = noStatus ? [] : mode === 'limit'
    ? (limitDir === 'below' ? ['deficient', 'optimal'] : ['optimal', 'excess'])
    : STATUS_ORDER

  function downloadCsv() {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`
    const head = ['Field', 'Crop', 'Variety', 'Farm', 'Weeks flagged', 'Weeks reporting', ...keys.map((k) => (axis === 'weeks' ? `Week ${k}` : `Week of ${toInputDate(k)}`))]
    const lines = [head.map(esc).join(',')]
    shownFields.forEach((f) => {
      const s = fieldStats[f.id]
      lines.push([f.name, f.cropName, f.varietyName, f.farmName, s.flagged, s.reporting,
        ...keys.map((k) => (allCells[f.id][k] ? allCells[f.id][k].value : ''))].map(esc).join(','))
    })
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `compare-${metricId}-${axis}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const tile = (label, value, sub, accent) => (
    <div className="agronomy-kpi-card" style={accent ? { borderTop: `3px solid ${accent}` } : undefined}>
      <p className="agronomy-kpi-label">{label}</p>
      <p className="agronomy-kpi-value" style={{ fontSize: 22 }}>{value}</p>
      {sub && <p className="agronomy-kpi-date">{sub}</p>}
    </div>
  )

  const dateOrWeek = { width: axis === 'weeks' ? 60 : 130, marginLeft: 4 }
  const avgText = latestC && latestC.avg != null ? fmtChartValue(Math.round(latestC.avg * 10) / 10) : '—'

  return (
    <div className="agronomy-compare">
      {error && <p className="agronomy-error-banner">Couldn't load samples: {error}</p>}

      {/* ---- what to look at ---- */}
      <div className="agronomy-field-picker" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={metricId} onChange={(e) => setMetricId(e.target.value)}>
          {METRICS.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.unit})</option>)}
        </select>
        <select value={cropFilter} onChange={(e) => setCropFilter(e.target.value)}>
          <option value="all">All crops</option>
          {cropOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        {varietyOptions.length > 1 && (
          <select value={varietyFilter} onChange={(e) => setVarietyFilter(e.target.value)}>
            <option value="all">All varieties</option>
            {varietyOptions.map((v) => <option key={v} value={v}>{v}</option>)}
          </select>
        )}
        <input type="search" placeholder="Find field…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ width: 120 }} />
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
                <input type="number" value={limitValue} onChange={(e) => setLimitValue(e.target.value)} style={{ width: 90 }} aria-label="limit" />
                <span style={{ fontSize: 12, color: '#666' }}>{metricDef.unit}</span>
              </>
            )}
          </>
        )}
      </div>

      {/* ---- how to show it ---- */}
      <div className="agronomy-field-picker" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
        <label style={{ fontSize: 12 }}>Across
          <select value={axis} onChange={(e) => setAxis(e.target.value)} style={{ marginLeft: 4 }}>
            <option value="weeks">weeks since emergence</option>
            <option value="dates">calendar dates</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>Chart
          <select value={chartType} onChange={(e) => setChartType(e.target.value)} style={{ marginLeft: 4 }}>
            <option value="count">number of fields</option>
            <option value="percent">percent of fields</option>
            <option value="trend">average + spread</option>
          </select>
        </label>
        <label style={{ fontSize: 12 }}>From
          <input type={axis === 'weeks' ? 'number' : 'date'} value={fromV} onChange={(e) => setFromV(e.target.value)} style={dateOrWeek} />
        </label>
        <label style={{ fontSize: 12 }}>to
          <input type={axis === 'weeks' ? 'number' : 'date'} value={toV} onChange={(e) => setToV(e.target.value)} style={dateOrWeek} />
        </label>
        {(fromV || toV) && <button className="agronomy-link-btn" onClick={() => { setFromV(''); setToV('') }}>All weeks</button>}
      </div>

      {/* ---- which fields ---- */}
      {!noStatus && (
        <div className="agronomy-field-picker" style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
          <label style={{ fontSize: 12 }}>Flagged means
            <select value={flagType} onChange={(e) => setFlagType(e.target.value)} style={{ marginLeft: 4 }}>
              <option value="either">below or above</option>
              <option value="below">below only</option>
              <option value="above">above only</option>
            </select>
          </label>
          <label style={{ fontSize: 12 }}>Show
            <select value={rowFilter} onChange={(e) => setRowFilter(e.target.value)} style={{ marginLeft: 4 }}>
              <option value="all">all fields</option>
              <option value="selected">flagged in the selected week</option>
              <option value="latest">flagged at their latest reading</option>
              <option value="min">flagged in at least N weeks</option>
              <option value="top">the N most-flagged fields</option>
            </select>
          </label>
          {(rowFilter === 'min' || rowFilter === 'top') && (
            <input type="number" min="1" value={filterN} onChange={(e) => setFilterN(e.target.value)} style={{ width: 56 }} aria-label="N" />
          )}
        </div>
      )}

      <p style={{ fontSize: 11, color: '#666', margin: '6px 0 10px' }}>
        {shownFields.length} of {visible.length} fields {'·'} {axis === 'weeks' ? "weeks since each field's emergence" : 'calendar weeks (Monday start)'} {'·'}{' '}
        {noStatus ? 'amber = lbs of N applied that week.'
          : mode === 'limit' ? `red = ${limitLabel}.`
          : metricId === 'moisture' ? `target ${MOISTURE_TARGET[0]}–${MOISTURE_TARGET[1]}%, the same for every field.`
          : 'each reading is judged against the target for its crop and week.'}
      </p>

      {keys.length === 0 ? (
        <div className="agronomy-chart-empty">
          No {metricDef.label.toLowerCase()} readings for these fields in this window
          {metricId === 'moisture' ? ' - upload a scouting report on the Scouting tab' : ''}
          {metricId === 'nitrogen' ? ' - run the nitrogen sync on the Scouting tab' : ''}.
        </div>
      ) : (
        <>
          {/* ---- headline numbers ---- */}
          <div className="agronomy-kpi-grid" style={{ marginBottom: 12 }}>
            {tile('Fields reporting', latestC ? `${latestC.reporting} of ${shownFields.length}` : '—', latestC ? `latest ${keyLong(latestC.key)}` : null)}
            {!noStatus && tile('Flagged in the latest week', latestC ? `${latestFlaggedCount}` : '—',
              latestC && latestC.reporting ? `${Math.round((latestFlaggedCount / latestC.reporting) * 100)}% of reporting fields` : null, STATUS_COLOR.deficient.dot)}
            {!noStatus && tile('Worst week', worst ? `${worst.n} fields` : '—', worst ? `${keyLong(worst.key)} (of ${worst.of})` : 'no flags', STATUS_COLOR.excess.dot)}
            {!noStatus && tile('Most-flagged field', mostFlagged ? mostFlagged.f.name : '—', mostFlagged ? `${mostFlagged.n} of ${mostFlagged.of} weeks` : 'no flags')}
            {tile(noStatus ? 'Average applied, latest week' : 'Average, latest week', avgText,
              latestC && latestC.reporting ? `range ${fmtChartValue(latestC.min)}–${fmtChartValue(latestC.max)} ${metricDef.unit}` : null, noStatus ? '#C77D0A' : null)}
          </div>

          {/* ---- the chart ---- */}
          <div className="agronomy-chart-card" style={{ marginBottom: 14 }}>
            <p className="agronomy-chart-title">
              {chartType === 'trend'
                ? `Average ${metricDef.label.toLowerCase()} across the fields, with the lowest-to-highest spread`
                : noStatus ? 'Fields applying N each week'
                : `${chartType === 'percent' ? 'Share of fields' : 'Fields'} by status each week - ${metricDef.label}`}
              {' · click a week to list its fields'}
            </p>
            <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
              {chartType !== 'trend' && stackTicks.map((t) => (
                <g key={t}>
                  <line x1={padL} x2={W - padR} y1={yStack(t)} y2={yStack(t)} stroke="#e4e0d4" strokeWidth="1" />
                  <text x={padL - 4} y={yStack(t) + 3} textAnchor="end" fontSize="9" fill="#777">{t}{chartType === 'percent' ? '%' : ''}</text>
                </g>
              ))}
              {chartType === 'trend' && trendTicks.map((t, i) => (
                <g key={i}>
                  <line x1={padL} x2={W - padR} y1={yTrend(t)} y2={yTrend(t)} stroke="#e4e0d4" strokeWidth="1" />
                  <text x={padL - 4} y={yTrend(t) + 3} textAnchor="end" fontSize="9" fill="#777">{fmtChartValue(Math.round(t * 10) / 10)}</text>
                </g>
              ))}
              {chartType === 'trend' && refLo != null && (
                <rect x={padL} width={plotW} y={yTrend(refHi)} height={yTrend(refLo) - yTrend(refHi)} fill={STATUS_COLOR.optimal.dot} fillOpacity="0.14" />
              )}
              {chartType === 'trend' && !noStatus && mode === 'limit' && Number.isFinite(limitNum) && (
                <g>
                  <line x1={padL} x2={W - padR} y1={yTrend(limitNum)} y2={yTrend(limitNum)}
                    stroke={STATUS_COLOR[limitDir === 'below' ? 'deficient' : 'excess'].dot} strokeDasharray="4 3" strokeWidth="1.2" />
                  <text x={W - padR} y={yTrend(limitNum) - 3} textAnchor="end" fontSize="9" fill="#555">limit {limitValue}</text>
                </g>
              )}

              {chartType === 'trend' && (() => {
                const pts = perKey.map((c, i) => ({ c, i })).filter(({ c }) => c.reporting)
                const bandPts = [
                  ...pts.map(({ c, i }) => `${xCenter(i)},${yTrend(c.max)}`),
                  ...[...pts].reverse().map(({ c, i }) => `${xCenter(i)},${yTrend(c.min)}`)
                ].join(' ')
                return (
                  <g>
                    {pts.length > 1 && <polygon points={bandPts} fill="#1F6FB2" fillOpacity="0.14" />}
                    {pts.length > 1 && <polyline points={pts.map(({ c, i }) => `${xCenter(i)},${yTrend(c.avg)}`).join(' ')} fill="none" stroke="#1F4E79" strokeWidth="2" />}
                  </g>
                )
              })()}

              {perKey.map((c, i) => {
                const x = xCenter(i) - barW / 2
                const sel = c.key === shownKey
                let acc = 0
                const segs = noStatus
                  ? [{ key: 'n', n: c.reporting, fill: '#C77D0A' }]
                  : statuses.map((s) => ({ key: s, n: c[s], fill: STATUS_COLOR[s].dot }))
                const total = segs.reduce((t, sg) => t + sg.n, 0)
                return (
                  <g key={c.key} onClick={() => setPickedKey(c.key)} style={{ cursor: 'pointer' }}>
                    <rect x={padL + slot * i} y={padT} width={slot} height={plotH + 22} fill={sel ? 'rgba(60,90,63,0.10)' : 'transparent'} />
                    {chartType !== 'trend' && total > 0 && segs.map((sg) => {
                      if (!sg.n) return null
                      const v0 = chartType === 'percent' ? (acc / total) * 100 : acc
                      const v1 = chartType === 'percent' ? ((acc + sg.n) / total) * 100 : acc + sg.n
                      acc += sg.n
                      const y0 = yStack(v1), h = yStack(v0) - y0
                      return (
                        <g key={sg.key}>
                          <rect x={x} y={y0} width={barW} height={h} fill={sg.fill} />
                          {h >= 11 && barW >= 11 && (
                            <text x={x + barW / 2} y={y0 + h / 2 + 3} textAnchor="middle" fontSize="9" fontWeight="700" fill="#fff">
                              {chartType === 'percent' ? Math.round(v1 - v0) : sg.n}
                            </text>
                          )}
                        </g>
                      )
                    })}
                    {chartType === 'trend' && c.reporting > 0 && (
                      <circle cx={xCenter(i)} cy={yTrend(c.avg)} r={sel ? 5 : 3.5} fill="#1F4E79" stroke="#fff" strokeWidth="1" />
                    )}
                    {chartType === 'trend' && sel && c.reporting > 0 && (
                      <text x={xCenter(i)} y={yTrend(c.avg) - 8} textAnchor="middle" fontSize="10" fontWeight="700" fill="#1F4E79">
                        {fmtChartValue(Math.round(c.avg * 10) / 10)}
                      </text>
                    )}
                    {(i % tickEvery === 0 || sel) && (
                      <>
                        <text x={xCenter(i)} y={H - 34} textAnchor="middle" fontSize="9" fontWeight={sel ? 700 : 400} fill={sel ? '#222' : '#666'}>
                          {keyLabel(c.key)}
                        </text>
                        {axis === 'weeks' && approxDate(c.key) && (
                          <text x={xCenter(i)} y={H - 23} textAnchor="middle" fontSize="8" fill="#999">~{approxDate(c.key)}</text>
                        )}
                      </>
                    )}
                    <title>
                      {keyLong(c.key)}: {c.reporting} reporting
                      {c.reporting ? `, average ${fmtChartValue(Math.round(c.avg * 10) / 10)} ${metricDef.unit} (${fmtChartValue(c.min)}-${fmtChartValue(c.max)})` : ''}
                      {noStatus ? '' : ` - ${statuses.map((s) => `${c[s]} ${wordFor(s)}`).join(', ')}`}
                    </title>
                  </g>
                )
              })}
              <text x={padL + plotW / 2} y={H - 1} textAnchor="middle" fontSize="9" fill="#777">
                {axis === 'weeks' ? 'weeks since emergence (~ = approximate date for the median planting)' : 'week starting (Monday)'}
              </text>
            </svg>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, marginTop: 4 }}>
              {chartType === 'trend'
                ? <>
                    <span><span style={{ color: '#1F4E79' }}>{'●'}</span> average of reporting fields</span>
                    <span><span style={{ color: '#9cbfdc' }}>{'■'}</span> lowest to highest field</span>
                    {refLo != null && <span><span style={{ color: STATUS_COLOR.optimal.dot }}>{'■'}</span> target {refLo}–{refHi}%</span>}
                  </>
                : noStatus
                  ? <span><span style={{ color: '#C77D0A' }}>{'■'}</span> fields that applied N that week</span>
                  : statuses.map((s) => <span key={s}><span style={{ color: STATUS_COLOR[s].dot }}>{'■'}</span> {wordFor(s)}</span>)}
              <span style={{ color: '#888' }}>fields with no reading that week are left out</span>
            </div>
          </div>

          {/* ---- fields in the clicked week ---- */}
          {shownKey != null && shownCounts && (
            <div className="agronomy-chart-card" style={{ marginBottom: 14 }}>
              <p className="agronomy-chart-title">
                {keyLong(shownKey)[0].toUpperCase() + keyLong(shownKey).slice(1)}: {shownCounts.reporting} of {shownFields.length} fields have a reading
                {shownCounts.reporting ? ` - average ${fmtChartValue(Math.round(shownCounts.avg * 10) / 10)} ${metricDef.unit}` : ''}
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

          {/* ---- heat map ---- */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '4px 0 6px', flexWrap: 'wrap' }}>
            <p className="agronomy-section-label" style={{ margin: 0 }}>Every field, every week</p>
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="name">sort: name</option>
              <option value="crop">sort: crop</option>
              {!noStatus && <option value="flagged">sort: most weeks flagged</option>}
              {!noStatus && <option value="pct">sort: highest % of weeks flagged</option>}
              <option value="latestLow">sort: latest reading, lowest first</option>
              <option value="latestHigh">sort: latest reading, highest first</option>
            </select>
            <select value={cellMode} onChange={(e) => setCellMode(e.target.value)}>
              <option value="value">cells show numbers</option>
              <option value="dot">cells show colour only</option>
            </select>
            <button className="agronomy-link-btn" onClick={downloadCsv}>Download as spreadsheet (CSV)</button>
          </div>
          <div style={{ overflow: 'auto', maxHeight: 560, border: '1px solid #ddd8cc', borderRadius: 6, background: '#fff' }}>
            <table style={{ borderCollapse: 'collapse', fontSize: 10, minWidth: 0 }}>
              <thead>
                <tr>
                  <th style={{ position: 'sticky', left: 0, top: 0, zIndex: 3, background: '#f4f2ec', textAlign: 'left', padding: '4px 8px' }}>Field</th>
                  {!noStatus && <th style={{ position: 'sticky', top: 0, zIndex: 2, background: '#f4f2ec', padding: '4px 6px' }} title="weeks flagged / weeks with a reading">Flagged</th>}
                  {keys.map((k) => (
                    <th
                      key={k}
                      onClick={() => setPickedKey(k)}
                      style={{ position: 'sticky', top: 0, zIndex: 2, cursor: 'pointer', padding: '3px 5px', minWidth: 30, lineHeight: 1.15,
                        background: k === shownKey ? '#dfe8d8' : '#f4f2ec', fontWeight: k === shownKey ? 700 : 500 }}
                    >
                      {keyLabel(k)}
                      {axis === 'weeks' && approxDate(k) && <div style={{ fontSize: 8, fontWeight: 400, color: '#888' }}>~{approxDate(k)}</div>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shownFields.length === 0 && (
                  <tr><td colSpan={keys.length + 2} style={{ padding: 12, color: '#888' }}>No fields match these filters.</td></tr>
                )}
                {shownFields.map((f) => {
                  const cropColor = CROP_COLOR[f.cropName]
                  const st = fieldStats[f.id]
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
                      {!noStatus && (
                        <td style={{ textAlign: 'center', padding: '2px 6px', borderTop: '1px solid #eee', fontWeight: 600,
                          color: st.flagged ? STATUS_COLOR.deficient.fg : '#999' }}>
                          {st.flagged}/{st.reporting}
                        </td>
                      )}
                      {keys.map((k) => {
                        const cell = allCells[f.id] && allCells[f.id][k]
                        return (
                          <td
                            key={k}
                            onClick={() => setPickedKey(k)}
                            title={cell ? `${f.name} - ${keyLong(k)}: ${cell.value} ${metricDef.unit}${cell.range ? ` (target ${cell.range[0]}-${cell.range[1]})` : ''} - ${fmtDay(new Date(cell.stamp))}` : ''}
                            style={{ textAlign: 'center', padding: '2px 3px', borderTop: '1px solid #eee', cursor: 'pointer',
                              boxShadow: k === shownKey ? 'inset 0 0 0 1px rgba(60,90,63,0.6)' : 'none',
                              ...(cell ? (cellMode === 'dot' ? dotCellStyle(cell) : cellStyle(cell)) : {}) }}
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
