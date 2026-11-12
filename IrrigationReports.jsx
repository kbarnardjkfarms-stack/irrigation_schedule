import { useEffect, useMemo, useRef, useState } from 'react'
import { DEMO_WEEKLY } from './reportDemoData.js'

// Irrigation Reports view (opened from the views dropdown in the header).
//
// Right now this shows DEMO data (reportDemoData.js): Acequia potato fields,
// 2026. Crop ET, rain and the moisture readings are real; scheduled and
// applied water are modeled. When live data exists, replace DEMO_WEEKLY with
// the real rows (same shape) and drop the demo badge.

const DRY = 71
const WET = 88
const MAXF = 4
const COLORS = ['#2f6f9f', '#c2692b', '#4d8a4a', '#8a5aa8']
const INK = '#2b2b26'
const MUTED = '#6f6c62'
const LINE = '#e4e1d8'
const GRID = '#ece9e0'
const PANEL = '#fff'
const OK = '#4d8a4a'
const BAD = '#b3402e'
const WARN = '#b07a16'

const isRead = (v) => v != null && v !== ''
const f0 = (v) => String(Math.round(v))
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1)
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2)
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const weekLabel = (w) => MONTHS[Number(w.slice(5, 7)) - 1] + ' ' + Number(w.slice(8, 10))

const MEASURES = {
  appPct: { label: 'Applied water, % of actual ET', title: 'Applied, % of actual ET', fmt: (v) => f0(v) + '%', ref: 100 },
  schedPct: { label: 'Scheduled water, % of ET estimate', title: 'Scheduled, % of ET estimate', fmt: (v) => f0(v) + '%', ref: 100 },
  appIn: { label: 'Applied water (inches per week)', title: 'Applied, in per week', fmt: (v) => f2(v) + ' in' },
  etActual: { label: 'Actual crop ET (inches per week)', title: 'Actual crop ET, in per week', fmt: (v) => f2(v) + ' in' },
  moisture: { label: 'Soil moisture readings (%)', title: 'Soil moisture, %', fmt: (v) => f0(v) + '%', band: true }
}

const sum = (rows, k) => rows.reduce((a, r) => a + Number(r[k]), 0)
const avgOf = (rows, k) => Math.round((sum(rows, k) / rows.length) * 100) / 100

// ---- the numbers (all worked out here from the weekly rows) ----
function buildReport(weekly) {
  const byField = new Map()
  const byWeek = new Map()
  weekly.forEach((r) => {
    if (!byField.has(r.field)) byField.set(r.field, [])
    byField.get(r.field).push(r)
    if (!byWeek.has(r.week)) byWeek.set(r.week, [])
    byWeek.get(r.week).push(r)
  })
  const fieldNames = [...byField.keys()].sort()
  byField.forEach((rows) => rows.sort((a, b) => (a.week < b.week ? -1 : 1)))
  const weeks = [...byWeek.keys()].sort()

  const readings = weekly.filter((r) => isRead(r.moisture))
  const okWeeks = weekly.filter((r) => r.etActual >= 0.3)
  const miss = okWeeks.reduce((a, r) => a + Math.abs(r.etEstimate - r.etActual), 0) / (sum(okWeeks, 'etActual') || 1)
  const n = fieldNames.length || 1
  const summary = {
    fields: fieldNames.length,
    etActual: sum(weekly, 'etActual') / n,
    scheduled: sum(weekly, 'schedIn') / n,
    applied: sum(weekly, 'appIn') / n,
    appliedPct: Math.round((100 * sum(weekly, 'appIn')) / (sum(weekly, 'etActual') || 1)),
    readings: readings.length,
    dry: readings.filter((r) => r.moisture < DRY).length,
    estMiss: Math.round(100 * miss)
  }

  const farmWeekly = weeks.map((week) => {
    const g = byWeek.get(week)
    const rd = g.filter((r) => isRead(r.moisture))
    return {
      week,
      etEstimate: avgOf(g, 'etEstimate'),
      etActual: avgOf(g, 'etActual'),
      rain: avgOf(g, 'rain'),
      schedIn: avgOf(g, 'schedIn'),
      appIn: avgOf(g, 'appIn'),
      moisture: rd.length ? Math.round(sum(rd, 'moisture') / rd.length) : null
    }
  })

  const rdAll = weekly.filter((r) => isRead(r.moisture) && r.etActual > 0)
  const bands = [
    ['Below 71% (dry)', (m) => m < DRY],
    ['71 to 88% (on target)', (m) => m >= DRY && m <= WET],
    ['Above 88% (wet)', (m) => m > WET]
  ].map(([band, test]) => {
    const g = rdAll.filter((r) => test(r.moisture))
    return {
      band,
      readings: g.length,
      schedPct: g.length ? Math.round((100 * sum(g, 'schedIn')) / (sum(g, 'etEstimate') || 1)) : null,
      appPct: g.length ? Math.round((100 * sum(g, 'appIn')) / (sum(g, 'etActual') || 1)) : null
    }
  })

  const fieldSummary = fieldNames.map((field) => {
    const g = byField.get(field)
    const rd = g.filter((r) => isRead(r.moisture))
    return {
      field,
      etActual: sum(g, 'etActual'),
      scheduled: sum(g, 'schedIn'),
      applied: sum(g, 'appIn'),
      appliedPct: Math.round((100 * sum(g, 'appIn')) / (sum(g, 'etActual') || 1)),
      readings: rd.length,
      dry: rd.filter((r) => r.moisture < DRY).length
    }
  })

  // per field per week, with the percent views (weeks with almost no ET stay blank)
  const pct = new Map()
  byField.forEach((rows, field) => {
    const m = new Map()
    rows.forEach((r) => {
      const quiet = r.etActual < 0.05 && r.etEstimate < 0.05
      m.set(r.week, {
        appPct: r.etActual >= 0.3 ? Math.round((100 * r.appIn) / r.etActual) : null,
        schedPct: r.etEstimate >= 0.3 ? Math.round((100 * r.schedIn) / r.etEstimate) : null,
        appIn: quiet ? null : r.appIn,
        etActual: quiet ? null : r.etActual,
        moisture: isRead(r.moisture) ? Number(r.moisture) : null
      })
    })
    pct.set(field, m)
  })

  return { fieldNames, byField, weeks, summary, farmWeekly, bands, fieldSummary, pct }
}

function useWidth() {
  const ref = useRef(null)
  const [w, setW] = useState(600)
  useEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const read = () => setW(Math.max(280, Math.floor(el.clientWidth || 600)))
    read()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read)
      return () => window.removeEventListener('resize', read)
    }
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceMax(v) {
  const steps = [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500]
  return steps.find((s) => s >= v) || Math.ceil(v)
}

// ---- charts (hand-drawn SVG) ----
function ChartFrame({ height, children, tip, onLeave, label }) {
  const [ref, w] = useWidth()
  return (
    <div ref={ref} style={{ position: 'relative', width: '100%' }} onMouseLeave={onLeave}>
      <svg role="img" aria-label={label} viewBox={`0 0 ${w} ${height}`} width={w} height={height} style={{ display: 'block', fontSize: 11 }}>
        {children(w)}
      </svg>
      {tip}
    </div>
  )
}

function Tip({ tip, boxW }) {
  if (!tip) return null
  const left = tip.x + 14 + 190 > boxW ? Math.max(0, tip.x - 204) : tip.x + 14
  return (
    <div
      style={{
        position: 'absolute', left, top: Math.max(0, tip.y - 20), pointerEvents: 'none', zIndex: 5,
        background: '#fff', border: `1px solid ${LINE}`, boxShadow: '0 4px 14px rgba(0,0,0,.12)',
        borderRadius: 8, padding: '8px 10px', fontSize: 12, color: MUTED, lineHeight: 1.5, whiteSpace: 'nowrap'
      }}
    >
      {tip.lines.map((l, i) => (
        <div key={i}>{l}</div>
      ))}
    </div>
  )
}

function useTip() {
  const [tip, setTip] = useState(null)
  const show = (e, lines) => {
    const box = e.currentTarget.ownerSVGElement.parentElement.getBoundingClientRect()
    setTip({ x: e.clientX - box.left, y: e.clientY - box.top, lines, boxW: box.width })
  }
  return [tip, show, () => setTip(null)]
}

function XAxis({ weeks, x, bw, w, y0, m }) {
  const every = Math.max(1, Math.ceil(weeks.length / Math.max(2, Math.floor((w - m.l - m.r) / 52))))
  return (
    <g>
      <line x1={m.l} x2={w - m.r} y1={y0} y2={y0} stroke="#b9b5a8" />
      {weeks.map((wk, i) =>
        i % every === 0 ? (
          <text key={wk} x={x(wk) + bw / 2} y={y0 + 16} textAnchor="middle" fill={MUTED}>
            {weekLabel(wk)}
          </text>
        ) : null
      )}
    </g>
  )
}

function bandScale(weeks, w, m) {
  const step = (w - m.l - m.r) / weeks.length
  const bw = step * 0.82
  const idx = new Map(weeks.map((wk, i) => [wk, i]))
  return { bw, x: (wk) => m.l + idx.get(wk) * step + (step - bw) / 2 }
}

function weekTipLines(d, field) {
  return [
    <b key="h" style={{ color: INK }}>{field || 'Farm average'}</b>,
    'Week of ' + weekLabel(d.week),
    'ET estimate ' + f2(d.etEstimate) + ' in, actual ' + f2(d.etActual) + ' in',
    'Scheduled ' + f2(d.schedIn) + ' in, applied ' + f2(d.appIn) + ' in',
    'Moisture ' + (isRead(d.moisture) ? d.moisture + '%' : 'no reading')
  ]
}

function WaterChart({ rows, field }) {
  const [tip, show, hide] = useTip()
  const H = 280
  const m = { l: 40, r: 10, t: 34, b: 26 }
  const weeks = rows.map((d) => d.week)
  const ymax = niceMax(Math.max(0.5, ...rows.map((d) => Math.max(d.schedIn, d.appIn, d.etActual, d.etEstimate))) * 1.05)
  return (
    <ChartFrame height={H} label="Weekly scheduled and applied inches against crop ET" onLeave={hide} tip={<Tip tip={tip} boxW={tip ? tip.boxW : 600} />}>
      {(w) => {
        const { x, bw } = bandScale(weeks, w, m)
        const y = (v) => H - m.b - (v / ymax) * (H - m.b - m.t)
        const ticks = [0, 1, 2, 3, 4, 5].map((i) => (ymax * i) / 5)
        const cx = (d) => x(d.week) + bw / 2
        const path = (key) => rows.map((d, i) => (i ? 'L' : 'M') + cx(d).toFixed(1) + ' ' + y(d[key]).toFixed(1)).join(' ')
        const half = bw / 2 - 0.5
        let lx = m.l
        const legend = [['Scheduled', 'bar', COLORS[0]], ['Applied', 'bar', COLORS[1]], ['Actual ET', 'line', INK], ['ET estimate', 'dash', MUTED]]
        return (
          <g>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={GRID} />
                <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fill={MUTED}>{t % 1 ? f1(t) : f0(t)}</text>
              </g>
            ))}
            <text x={m.l - 6} y={m.t - 18} textAnchor="end" fill={MUTED}>in / week</text>
            {rows.map((d) => (
              <g key={d.week}>
                <rect x={x(d.week)} width={half} y={y(d.schedIn)} height={Math.max(0, y(0) - y(d.schedIn))} fill={COLORS[0]} />
                <rect x={x(d.week) + half + 1} width={half} y={y(d.appIn)} height={Math.max(0, y(0) - y(d.appIn))} fill={COLORS[1]} />
              </g>
            ))}
            <path d={path('etEstimate')} fill="none" stroke={MUTED} strokeWidth="1.6" strokeDasharray="4 3" />
            <path d={path('etActual')} fill="none" stroke={INK} strokeWidth="2.2" />
            <XAxis weeks={weeks} x={x} bw={bw} w={w} y0={H - m.b} m={m} />
            {legend.map(([t, kind, col]) => {
              const x0 = lx
              lx += (kind === 'bar' ? 15 : 21) + t.length * 6.2 + 14
              return (
                <g key={t} transform={`translate(${x0},10)`}>
                  {kind === 'bar' ? <rect width="10" height="10" y="-1" fill={col} /> : <line x1="0" x2="16" y1="4" y2="4" stroke={col} strokeWidth="2" strokeDasharray={kind === 'dash' ? '4 3' : undefined} />}
                  <text x={kind === 'bar' ? 15 : 21} y="9" fill={MUTED}>{t}</text>
                </g>
              )
            })}
            {rows.map((d) => (
              <rect key={'h' + d.week} x={x(d.week) - 2} width={bw + 4} y={m.t} height={H - m.b - m.t} fill="transparent" onMouseMove={(e) => show(e, weekTipLines(d, field))} />
            ))}
          </g>
        )
      }}
    </ChartFrame>
  )
}

function MoistureChart({ rows, field }) {
  const [tip, show, hide] = useTip()
  const H = 200
  const m = { l: 40, r: 10, t: 12, b: 26 }
  const weeks = rows.map((d) => d.week)
  return (
    <ChartFrame height={H} label="Weekly soil moisture readings against the 71 to 88 percent target band" onLeave={hide} tip={<Tip tip={tip} boxW={tip ? tip.boxW : 600} />}>
      {(w) => {
        const { x, bw } = bandScale(weeks, w, m)
        const y = (v) => H - m.b - ((v - 55) / 40) * (H - m.b - m.t)
        const cx = (d) => x(d.week) + bw / 2
        const pts = rows.filter((d) => isRead(d.moisture))
        return (
          <g>
            <rect x={m.l} width={w - m.l - m.r} y={y(WET)} height={y(DRY) - y(WET)} fill={OK} opacity="0.14" />
            {[60, 71, 80, 88, 90].map((t) => (
              <g key={t}>
                <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fill={MUTED}>{t}%</text>
                <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeDasharray={t === DRY || t === WET ? '3 3' : undefined} />
              </g>
            ))}
            <path d={pts.map((d, i) => (i ? 'L' : 'M') + cx(d).toFixed(1) + ' ' + y(d.moisture).toFixed(1)).join(' ')} fill="none" stroke="#b9b5a8" strokeWidth="1.4" />
            {pts.map((d) => (
              <circle key={d.week} cx={cx(d)} cy={y(d.moisture)} r="4.5" fill={d.moisture < DRY ? BAD : d.moisture > WET ? WARN : OK} />
            ))}
            <XAxis weeks={weeks} x={x} bw={bw} w={w} y0={H - m.b} m={m} />
            {rows.map((d) => (
              <rect key={'h' + d.week} x={x(d.week) - 2} width={bw + 4} y={m.t} height={H - m.b - m.t} fill="transparent" onMouseMove={(e) => show(e, weekTipLines(d, field))} />
            ))}
          </g>
        )
      }}
    </ChartFrame>
  )
}

function CompareChart({ report, fields, measure }) {
  const [tip, show, hide] = useTip()
  const M = MEASURES[measure]
  const H = 300
  const m = { l: 46, r: 10, t: 14, b: 26 }
  const weeks = report.weeks
  const series = fields.map((name, i) => ({
    name,
    color: COLORS[i % COLORS.length],
    pts: weeks.map((wk) => {
      const row = report.pct.get(name) && report.pct.get(name).get(wk)
      return { week: wk, v: row && row[measure] != null ? row[measure] : null }
    })
  }))
  const vmax = Math.max(1, ...series.flatMap((s) => s.pts.map((p) => (p.v == null ? 0 : p.v))))
  const top = M.band ? 95 : M.ref ? Math.max(120, niceMax(vmax * 1.05)) : niceMax(vmax * 1.1)
  const bottom = M.band ? 55 : 0
  return (
    <ChartFrame height={H} label="Weekly values for the picked fields, one line per field" onLeave={hide} tip={<Tip tip={tip} boxW={tip ? tip.boxW : 600} />}>
      {(w) => {
        const { x, bw } = bandScale(weeks, w, m)
        const y = (v) => H - m.b - ((v - bottom) / (top - bottom)) * (H - m.b - m.t)
        const cx = (wk) => x(wk) + bw / 2
        const ticks = M.band ? [60, 71, 80, 88, 90] : [0, 1, 2, 3, 4, 5, 6].map((i) => (top * i) / 6)
        return (
          <g>
            {M.band && <rect x={m.l} width={w - m.l - m.r} y={y(WET)} height={y(DRY) - y(WET)} fill={OK} opacity="0.14" />}
            {ticks.map((t) => (
              <g key={t}>
                <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={GRID} />
                <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fill={MUTED}>{M.band || M.ref ? f0(t) + '%' : t % 1 ? f1(t) : f0(t)}</text>
              </g>
            ))}
            {M.ref && <line x1={m.l} x2={w - m.r} y1={y(M.ref)} y2={y(M.ref)} stroke="#7a766a" strokeWidth="1.4" strokeDasharray="5 4" />}
            {series.map((s) => {
              const pts = s.pts.filter((p) => p.v != null)
              // gaps break the line for the weekly views; moisture joins its readings
              const segs = []
              if (M.band) segs.push(pts)
              else {
                let cur = []
                s.pts.forEach((p) => {
                  if (p.v == null) {
                    if (cur.length) segs.push(cur)
                    cur = []
                  } else cur.push(p)
                })
                if (cur.length) segs.push(cur)
              }
              return (
                <g key={s.name}>
                  {segs.map((seg, i) => (
                    <path key={i} d={seg.map((p, j) => (j ? 'L' : 'M') + cx(p.week).toFixed(1) + ' ' + y(p.v).toFixed(1)).join(' ')} fill="none" stroke={s.color} strokeWidth="2.2" />
                  ))}
                  {pts.map((p) => (
                    <circle key={p.week} cx={cx(p.week)} cy={y(p.v)} r={M.band ? 4.5 : 2.6} fill={s.color} />
                  ))}
                </g>
              )
            })}
            <XAxis weeks={weeks} x={x} bw={bw} w={w} y0={H - m.b} m={m} />
            {weeks.map((wk) => (
              <rect
                key={'h' + wk}
                x={x(wk) - 2}
                width={bw + 4}
                y={m.t}
                height={H - m.b - m.t}
                fill="transparent"
                onMouseMove={(e) =>
                  show(e, [
                    <b key="h" style={{ color: INK }}>Week of {weekLabel(wk)}</b>,
                    M.title,
                    ...series.map((s) => {
                      const p = s.pts.find((q) => q.week === wk)
                      return (
                        <div key={s.name}>
                          <span style={{ color: s.color }}>{'●'}</span> {s.name} <b style={{ color: INK }}>{p && p.v != null ? M.fmt(p.v) : M.band ? 'no reading' : 'blank'}</b>
                        </div>
                      )
                    })
                  ])
                }
              />
            ))}
          </g>
        )
      }}
    </ChartFrame>
  )
}

// ---- tables ----
function flagsFor(d) {
  const out = []
  if (isRead(d.moisture) && d.moisture < DRY) out.push([BAD, 'Dry reading'])
  if (isRead(d.moisture) && d.moisture > WET) out.push([WARN, 'Wet reading'])
  if (d.etActual >= 0.3 && d.appIn < 0.85 * d.etActual) out.push([WARN, 'Applied under ET'])
  if (d.etActual >= 0.3 && d.appIn > 1.15 * d.etActual) out.push([WARN, 'Applied over ET'])
  return out
}

const th = { textAlign: 'right', padding: '7px 10px', fontSize: 12, borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap', fontWeight: 600, color: MUTED }
const td = { textAlign: 'right', fontSize: 13, padding: '7px 10px', borderBottom: `1px solid ${LINE}`, whiteSpace: 'nowrap' }
// the app's global table rule sets min-width: 1180px, so it is reset here
const tableStyle = { borderCollapse: 'collapse', width: '100%', minWidth: 0, fontSize: 13, fontVariantNumeric: 'tabular-nums' }

function WeekTable({ rows }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ ...tableStyle, minWidth: 720 }}>
        <thead>
          <tr>
            {['Week of', 'ET estimate (in)', 'Actual ET (in)', 'Rain (in)', 'Scheduled (in)', 'Applied (in)', 'Moisture (%)', 'Flag'].map((h, i) => (
              <th key={h} style={{ ...th, textAlign: i === 0 || i === 7 ? 'left' : 'right' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => (
            <tr key={d.week}>
              <td style={{ ...td, textAlign: 'left' }}>{weekLabel(d.week)}</td>
              {[d.etEstimate, d.etActual, d.rain, d.schedIn, d.appIn].map((v, i) => (
                <td key={i} style={td}>{f2(v)}</td>
              ))}
              <td style={td}>{isRead(d.moisture) ? d.moisture : ''}</td>
              <td style={{ ...td, textAlign: 'left' }}>
                {flagsFor(d).map(([col, txt], i) => (
                  <span key={txt}>{i ? ', ' : ''}<span style={{ color: col }}>{txt}</span></span>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Swatch({ color }) {
  return <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: color, flex: 'none' }} />
}

function Section({ title, note, children, style }) {
  return (
    <section style={style}>
      <h2 style={{ fontSize: 16, fontWeight: 600, margin: '0 0 6px' }}>{title}</h2>
      {note && <p style={{ margin: '0 0 8px', color: MUTED, fontSize: 12.5, lineHeight: 1.5, maxWidth: '75ch' }}>{note}</p>}
      {children}
    </section>
  )
}

const noteStyle = { margin: 0, color: MUTED, fontSize: 12.5, lineHeight: 1.5, maxWidth: '75ch' }
const selectStyle = { font: 'inherit', fontSize: 13, padding: '6px 8px', border: `1px solid ${LINE}`, borderRadius: 6, background: '#fff', color: INK }

export default function IrrigationReports() {
  const report = useMemo(() => buildReport(DEMO_WEEKLY), [])
  const { fieldNames, summary } = report
  const [fields, setFields] = useState(() => ['ENCRAFT', 'WILSON N'].filter((f) => fieldNames.includes(f)))
  const [measure, setMeasure] = useState('appPct')

  const toggle = (name) =>
    setFields((cur) => (cur.includes(name) ? cur.filter((x) => x !== name) : [...cur, name].slice(-MAXF)))

  const n = fields.length
  const single = n === 1 ? fields[0] : null
  const weekRows = single ? report.byField.get(single) : report.farmWeekly
  const colorOf = (i) => (n > 1 ? COLORS[i % COLORS.length] : MUTED)

  const fieldRows = [...report.fieldSummary].sort((a, b) => {
    const ia = fields.indexOf(a.field)
    const ib = fields.indexOf(b.field)
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    return a.field < b.field ? -1 : 1
  })

  const kpis = [
    ['Crop ET per field (in)', f1(summary.etActual)],
    ['Scheduled per field (in)', f1(summary.scheduled)],
    ['Applied per field (in)', f1(summary.applied)],
    ['Applied as share of ET (%)', f0(summary.appliedPct)]
  ]

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '16px 12px 40px', display: 'flex', flexDirection: 'column', gap: 26, color: INK }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>Acequia potato water report, 2026</h1>
        <p style={{ display: 'inline-block', margin: '8px 0 0', padding: '3px 10px', borderRadius: 999, fontSize: 12, background: '#fff', border: `1px solid ${WARN}` }}>
          Demo data: scheduled and applied water are modeled. Crop ET, rain and moisture readings are real.
        </p>
        <p style={{ margin: '12px 0 0', fontSize: 16, lineHeight: 1.55, maxWidth: '70ch' }}>
          Across <b>{summary.fields}</b> potato fields, applied water covered <b>{summary.appliedPct}</b>% of crop ET from April to September.
          Of <b>{summary.readings}</b> moisture readings, <b>{summary.dry}</b> were below the 71% line. The Monday ET estimate missed the week's actual ET by <b>{summary.estMiss}</b>% on average.
        </p>
      </header>

      <section aria-label="Season totals per field" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
        {kpis.map(([label, val]) => (
          <div key={label} style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
            <span style={{ fontSize: 28, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>{val}</span>
          </div>
        ))}
      </section>

      <section aria-label="Choose fields" style={{ position: 'sticky', top: 0, zIndex: 6, background: '#f7f5f0', padding: '10px 0', borderBottom: `1px solid ${LINE}` }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minHeight: 34, alignItems: 'center' }}>
            {fields.map((name, i) => (
              <button key={name} type="button" title={'Take ' + name + ' out'} onClick={() => toggle(name)}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 999, fontSize: 12.5 }}>
                <Swatch color={colorOf(i)} />
                <span>{name}</span>
                <span style={{ color: MUTED }}>{'×'}</span>
              </button>
            ))}
            {!n && <span style={noteStyle}>All potato fields (average)</span>}
          </div>
          <select
            style={selectStyle}
            aria-label="Add a field"
            value=""
            onChange={(e) => {
              const v = e.target.value
              if (v === '__all') setFields([])
              else if (v) toggle(v)
            }}
          >
            <option value="">{n ? 'Add a field…' : 'Pick a field…'}</option>
            {fieldNames.filter((f) => !fields.includes(f)).map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
            {n > 0 && <option value="__all">All fields (average)</option>}
          </select>
        </div>
        <p style={{ ...noteStyle, marginTop: 6 }}>
          {n === 0 && 'No field picked, so this is the average of all the potato fields. Add a field to look at it alone, or add two or more to compare them.'}
          {n === 1 && 'One field picked. Add another to compare them side by side.'}
          {n >= 2 && 'Comparing fields side by side. Up to 4 at a time: picking a fifth drops the first one.'}
        </p>
      </section>

      {n >= 2 ? (
        <Section title="Fields side by side">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label htmlFor="rp-measure" style={noteStyle}>Compare</label>
            <select id="rp-measure" style={selectStyle} value={measure} onChange={(e) => setMeasure(e.target.value)} aria-label="What to compare">
              {Object.entries(MEASURES).map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div style={{ marginTop: 8 }}>
            <CompareChart report={report} fields={fields} measure={measure} />
          </div>
          <p style={{ ...noteStyle, marginTop: 8 }}>
            One line per field. Point at a week to see every field's number for it. For the percent views, 100% means the field got what the crop used. Weeks before planting or with almost no ET are left blank.
          </p>
        </Section>
      ) : (
        <>
          <Section title={single ? 'Water against crop ET, week by week: ' + single : 'Water against crop ET, week by week'}>
            <WaterChart rows={weekRows} field={single} />
            <h2 style={{ fontSize: 16, fontWeight: 600, margin: '22px 0 6px' }}>Soil moisture readings</h2>
            <MoistureChart rows={weekRows} field={single} />
          </Section>
        </>
      )}

      <Section title="What the water looked like around each kind of reading"
        note="Each moisture reading is matched to the same week's schedule. Scheduled is compared with the Monday ET estimate, applied with the week's actual ET. This one covers every potato field.">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ ...tableStyle, minWidth: 560 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Moisture reading</th>
                <th style={th}>Readings</th>
                <th style={th}>Scheduled vs estimate (%)</th>
                <th style={th}>Applied vs ET (%)</th>
              </tr>
            </thead>
            <tbody>
              {report.bands.map((b) => (
                <tr key={b.band}>
                  <td style={{ ...td, textAlign: 'left' }}>{b.band}</td>
                  <td style={td}>{b.readings}</td>
                  <td style={td}>{b.schedPct == null ? '' : f0(b.schedPct)}</td>
                  <td style={td}>{b.appPct == null ? '' : f0(b.appPct)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {n < 2 && (
        <Section title={single ? 'Week by week: ' + single : 'Week by week: average of all fields'}>
          <WeekTable rows={weekRows} />
        </Section>
      )}

      <Section title="Every field, whole season" note="Tap a field to add it to the comparison, or tap it again to take it out. Picked fields come first.">
        <div style={{ overflowX: 'auto' }}>
          <table style={{ ...tableStyle, minWidth: 700 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Field</th>
                <th style={th}>Crop ET (in)</th>
                <th style={th}>Scheduled (in)</th>
                <th style={th}>Applied (in)</th>
                <th style={th}>Applied vs ET (%)</th>
                <th style={th}>Readings</th>
                <th style={th}>Below 71%</th>
              </tr>
            </thead>
            <tbody>
              {fieldRows.map((d) => {
                const i = fields.indexOf(d.field)
                return (
                  <tr
                    key={d.field}
                    tabIndex={0}
                    onClick={() => toggle(d.field)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(d.field) } }}
                    style={{ cursor: 'pointer', background: i >= 0 ? '#fff' : undefined }}
                  >
                    <td style={{ ...td, textAlign: 'left' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {i >= 0 && <Swatch color={colorOf(i)} />}
                        {d.field}
                      </span>
                    </td>
                    <td style={td}>{f1(d.etActual)}</td>
                    <td style={td}>{f1(d.scheduled)}</td>
                    <td style={td}>{f1(d.applied)}</td>
                    <td style={td}>{f0(d.appliedPct)}</td>
                    <td style={td}>{d.readings}</td>
                    <td style={td}>{d.dry}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <details style={{ borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
        <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Where these numbers come from</summary>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8, fontSize: 14, lineHeight: 1.55, maxWidth: '75ch' }}>
          <p style={{ margin: 0 }}>Crop ET is the AgriMet Rupert station's measured daily alfalfa-reference ET for 2026, multiplied by AIO's draft potato crop curve and each field's plant date from AgWorld. Rupert is the station AIO uses for Acequia.</p>
          <p style={{ margin: 0 }}>The ET estimate is what AIO could have said on Monday, using the previous seven days of weather for the whole week. Actual ET uses the measured days.</p>
          <p style={{ margin: 0 }}>Moisture readings are the percentages logged from the weekly digs and imported into the Agronomy scouting data. A week with no reading shows no dot.</p>
          <p style={{ margin: 0 }}>Scheduled and applied water are modeled for this demo, because the 2026 season was not scheduled in AIO. The model leans the schedule down in weeks with a dry reading and up in weeks with a wet one, and assumes 6.5 gallons per minute per acre. A few weeks include a pivot stop that cut applied water. None of it comes from the farm's records.</p>
        </div>
      </details>
    </div>
  )
}
