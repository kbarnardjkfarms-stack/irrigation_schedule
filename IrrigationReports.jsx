import { useEffect, useMemo, useRef, useState } from 'react'
import { DEMO_WEEKLY, DEMO_FIELDS, DEMO_CROP_NOTES } from './reportDemoData.js'
import { fetchSeasons, loadLiveReport } from './reportLive.js'

// Irrigation Reports view (opened from the views dropdown in the header).
//
// Two sources, same report:
//   Demo  reportDemoData.js: Acequia 2026. Crop ET, rain and moisture readings
//         are real; scheduled and applied water are modeled.
//   Live  reportLive.js reads what AIO really has for a season. Anything AIO
//         has no number for stays blank and the page says "no data", so real
//         numbers show up on their own as they start getting recorded.
//
// Every field in the season is listed for its crop, with or without data.

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

const has = (v) => v != null && v !== ''
const f0 = (v) => String(Math.round(v))
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1)
const f2 = (v) => (Math.round(v * 100) / 100).toFixed(2)
const d0 = (v) => (has(v) ? f0(v) : '—')
const d1 = (v) => (has(v) ? f1(v) : '—')
const d2 = (v) => (has(v) ? f2(v) : '—')
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const weekLabel = (w) => MONTHS[Number(w.slice(5, 7)) - 1] + ' ' + Number(w.slice(8, 10))

const MEASURES = {
  appPct: { label: 'Applied water, % of actual ET', title: 'Applied, % of actual ET', fmt: (v) => f0(v) + '%', ref: 100 },
  schedPct: { label: 'Scheduled water, % of ET estimate', title: 'Scheduled, % of ET estimate', fmt: (v) => f0(v) + '%', ref: 100 },
  appIn: { label: 'Applied water (inches per week)', title: 'Applied, in per week', fmt: (v) => f2(v) + ' in' },
  etActual: { label: 'Actual crop ET (inches per week)', title: 'Actual crop ET, in per week', fmt: (v) => f2(v) + ' in' },
  moisture: { label: 'Soil moisture readings (%)', title: 'Soil moisture, %', fmt: (v) => f0(v) + '%', band: true }
}

// ---- the numbers ----
// Every sum and average skips weeks with no number (null). A blank is never
// counted as zero.
const vals = (rows, k) => rows.map((r) => r[k]).filter(has).map(Number)
const total = (rows, k) => { const v = vals(rows, k); return v.length ? v.reduce((a, b) => a + b, 0) : null }
const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)
const pairShare = (rows, num, den) => {
  const p = rows.filter((r) => has(r[num]) && has(r[den]))
  const d = p.reduce((a, r) => a + Number(r[den]), 0)
  return p.length && d > 0 ? Math.round((100 * p.reduce((a, r) => a + Number(r[num]), 0)) / d) : null
}

function buildReport(rows, fields) {
  const byField = new Map()
  const byWeek = new Map()
  rows.forEach((r) => {
    if (!byField.has(r.fieldKey)) byField.set(r.fieldKey, [])
    byField.get(r.fieldKey).push(r)
    if (!byWeek.has(r.week)) byWeek.set(r.week, [])
    byWeek.get(r.week).push(r)
  })
  byField.forEach((g) => g.sort((a, b) => (a.week < b.week ? -1 : 1)))
  const weeks = [...byWeek.keys()].sort()

  const readings = rows.filter((r) => has(r.moisture))
  const withEstimate = rows.filter((r) => Number(r.etActual) >= 0.3 && has(r.etEstimate))
  const missDen = withEstimate.reduce((a, r) => a + Number(r.etActual), 0)
  const perField = (k) => mean([...byField.values()].map((g) => total(g, k)).filter((v) => v != null))
  const summary = {
    fields: byField.size,
    etActual: perField('etActual'),
    scheduled: perField('schedIn'),
    applied: perField('appIn'),
    appliedPct: pairShare(rows, 'appIn', 'etActual'),
    readings: readings.length,
    dry: readings.filter((r) => r.moisture < DRY).length,
    estMiss: missDen > 0 ? Math.round((100 * withEstimate.reduce((a, r) => a + Math.abs(r.etEstimate - r.etActual), 0)) / missDen) : null
  }

  const farmWeekly = weeks.map((week) => {
    const g = byWeek.get(week)
    const avg = (k) => { const v = vals(g, k); return v.length ? Math.round(mean(v) * 100) / 100 : null }
    const rd = vals(g, 'moisture')
    return { week, etEstimate: avg('etEstimate'), etActual: avg('etActual'), rain: avg('rain'), schedIn: avg('schedIn'), appIn: avg('appIn'), moisture: rd.length ? Math.round(mean(rd)) : null }
  })

  const rdAll = rows.filter((r) => has(r.moisture) && Number(r.etActual) > 0)
  const bands = [
    ['Below 71% (dry)', (m) => m < DRY],
    ['71 to 88% (on target)', (m) => m >= DRY && m <= WET],
    ['Above 88% (wet)', (m) => m > WET]
  ].map(([band, test]) => {
    const g = rdAll.filter((r) => test(r.moisture))
    return { band, readings: g.length, schedPct: pairShare(g, 'schedIn', 'etEstimate'), appPct: pairShare(g, 'appIn', 'etActual') }
  })

  const fieldSummary = fields.map((f) => {
    const g = byField.get(f.key) || []
    const rd = g.filter((r) => has(r.moisture))
    return {
      field: f, hasData: g.length > 0,
      etActual: total(g, 'etActual'), scheduled: total(g, 'schedIn'), applied: total(g, 'appIn'),
      appliedPct: pairShare(g, 'appIn', 'etActual'), readings: rd.length, dry: rd.filter((r) => r.moisture < DRY).length
    }
  })

  const pct = new Map()
  byField.forEach((g, key) => {
    const m = new Map()
    g.forEach((r) => {
      const quiet = !(Number(r.etActual) >= 0.05 || Number(r.etEstimate) >= 0.05)
      m.set(r.week, {
        appPct: has(r.appIn) && Number(r.etActual) >= 0.3 ? Math.round((100 * r.appIn) / r.etActual) : null,
        schedPct: has(r.schedIn) && Number(r.etEstimate) >= 0.3 ? Math.round((100 * r.schedIn) / r.etEstimate) : null,
        appIn: quiet || !has(r.appIn) ? null : r.appIn,
        etActual: quiet || !has(r.etActual) ? null : r.etActual,
        moisture: has(r.moisture) ? Number(r.moisture) : null
      })
    })
    pct.set(key, m)
  })

  return { byField, weeks, summary, farmWeekly, bands, fieldSummary, pct, hasMoisture: readings.length > 0 }
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

function Tip({ tip }) {
  if (!tip) return null
  const left = tip.x + 14 + 190 > tip.boxW ? Math.max(0, tip.x - 204) : tip.x + 14
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
  const step = (w - m.l - m.r) / Math.max(1, weeks.length)
  const bw = step * 0.82
  const idx = new Map(weeks.map((wk, i) => [wk, i]))
  return { bw, x: (wk) => m.l + idx.get(wk) * step + (step - bw) / 2 }
}

// A line that breaks wherever a week has no number.
function gapPath(rows, key, cx, y) {
  let d = ''
  let pen = false
  rows.forEach((r) => {
    if (!has(r[key])) { pen = false; return }
    d += (pen ? 'L' : 'M') + cx(r).toFixed(1) + ' ' + y(Number(r[key])).toFixed(1) + ' '
    pen = true
  })
  return d
}

function weekTipLines(d, field) {
  return [
    <b key="h" style={{ color: INK }}>{field || 'Average of the fields'}</b>,
    'Week of ' + weekLabel(d.week),
    'ET estimate ' + d2(d.etEstimate) + ' in, actual ' + d2(d.etActual) + ' in',
    'Scheduled ' + d2(d.schedIn) + ' in, applied ' + d2(d.appIn) + ' in',
    'Moisture ' + (has(d.moisture) ? d.moisture + '%' : 'no reading')
  ]
}

function WaterChart({ rows, field }) {
  const [tip, show, hide] = useTip()
  const H = 280
  const m = { l: 40, r: 10, t: 26, b: 26 }
  const weeks = rows.map((d) => d.week)
  const all = rows.flatMap((d) => [d.schedIn, d.appIn, d.etActual, d.etEstimate]).filter(has).map(Number)
  const ymax = niceMax(Math.max(0.5, ...all) * 1.05)
  const legend = [['Scheduled', 'bar', COLORS[0]], ['Applied', 'bar', COLORS[1]], ['Actual ET', 'line', INK], ['ET estimate', 'dash', MUTED]]
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12, color: MUTED, marginBottom: 2 }}>
        {legend.map(([t, kind, col]) => (
          <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <svg width="16" height="10" aria-hidden="true">
              {kind === 'bar' ? <rect width="10" height="10" fill={col} /> : <line x1="0" x2="16" y1="5" y2="5" stroke={col} strokeWidth="2" strokeDasharray={kind === 'dash' ? '4 3' : undefined} />}
            </svg>
            {t}
          </span>
        ))}
      </div>
      <ChartFrame height={H} label="Weekly scheduled and applied inches against crop ET" onLeave={hide} tip={<Tip tip={tip} />}>
        {(w) => {
          const { x, bw } = bandScale(weeks, w, m)
          const y = (v) => H - m.b - (v / ymax) * (H - m.b - m.t)
          const ticks = [0, 1, 2, 3, 4, 5].map((i) => (ymax * i) / 5)
          const cx = (d) => x(d.week) + bw / 2
          const half = bw / 2 - 0.5
          return (
            <g>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={m.l} x2={w - m.r} y1={y(t)} y2={y(t)} stroke={GRID} />
                  <text x={m.l - 6} y={y(t) + 4} textAnchor="end" fill={MUTED}>{t % 1 ? f1(t) : f0(t)}</text>
                </g>
              ))}
              <text x={2} y={m.t - 12} textAnchor="start" fill={MUTED}>in / week</text>
              {rows.map((d) => (
                <g key={d.week}>
                  {has(d.schedIn) && <rect x={x(d.week)} width={half} y={y(d.schedIn)} height={Math.max(0, y(0) - y(d.schedIn))} fill={COLORS[0]} />}
                  {has(d.appIn) && <rect x={x(d.week) + half + 1} width={half} y={y(d.appIn)} height={Math.max(0, y(0) - y(d.appIn))} fill={COLORS[1]} />}
                </g>
              ))}
              <path d={gapPath(rows, 'etEstimate', cx, y)} fill="none" stroke={MUTED} strokeWidth="1.6" strokeDasharray="4 3" />
              <path d={gapPath(rows, 'etActual', cx, y)} fill="none" stroke={INK} strokeWidth="2.2" />
              <XAxis weeks={weeks} x={x} bw={bw} w={w} y0={H - m.b} m={m} />
              {rows.map((d) => (
                <rect key={'h' + d.week} x={x(d.week) - 2} width={bw + 4} y={m.t} height={H - m.b - m.t} fill="transparent" onMouseMove={(e) => show(e, weekTipLines(d, field))} />
              ))}
            </g>
          )
        }}
      </ChartFrame>
    </div>
  )
}

function MoistureChart({ rows, field }) {
  const [tip, show, hide] = useTip()
  const H = 200
  const m = { l: 40, r: 10, t: 12, b: 26 }
  const weeks = rows.map((d) => d.week)
  return (
    <ChartFrame height={H} label="Weekly soil moisture readings against the 71 to 88 percent target band" onLeave={hide} tip={<Tip tip={tip} />}>
      {(w) => {
        const { x, bw } = bandScale(weeks, w, m)
        const y = (v) => H - m.b - ((v - 55) / 40) * (H - m.b - m.t)
        const cx = (d) => x(d.week) + bw / 2
        const pts = rows.filter((d) => has(d.moisture))
        return (
          <g>
            <rect x={m.l} width={w - m.l - m.r} y={y(WET)} height={y(DRY) - y(WET)} fill={OK} opacity="0.14" />
            {[60, 71, 80, 88].map((t) => (
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

function CompareChart({ report, picked, measure }) {
  const [tip, show, hide] = useTip()
  const M = MEASURES[measure]
  const H = 300
  const m = { l: 46, r: 10, t: 14, b: 26 }
  const weeks = report.weeks
  const series = picked.map((f, i) => ({
    name: f.label,
    color: COLORS[i % COLORS.length],
    pts: weeks.map((wk) => {
      const row = report.pct.get(f.key) && report.pct.get(f.key).get(wk)
      return { week: wk, v: row && has(row[measure]) ? row[measure] : null }
    })
  }))
  const vmax = Math.max(1, ...series.flatMap((s) => s.pts.map((p) => (p.v == null ? 0 : p.v))))
  const anyPoint = series.some((s) => s.pts.some((p) => p.v != null))
  const top = M.band ? 95 : M.ref ? Math.max(120, niceMax(vmax * 1.05)) : niceMax(vmax * 1.1)
  const bottom = M.band ? 55 : 0
  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 14px', fontSize: 12, color: MUTED, marginBottom: 2 }}>
        {series.map((s) => (
          <span key={s.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 10, height: 10, borderRadius: '50%', background: s.color, display: 'inline-block' }} />
            {s.name}
          </span>
        ))}
      </div>
      {!anyPoint && <p style={{ ...noteStyle, margin: '4px 0' }}>No data for {M.title.toLowerCase()} on these fields yet.</p>}
      <ChartFrame height={H} label="Weekly values for the picked fields, one line per field" onLeave={hide} tip={<Tip tip={tip} />}>
        {(w) => {
          const { x, bw } = bandScale(weeks, w, m)
          const y = (v) => H - m.b - ((v - bottom) / (top - bottom)) * (H - m.b - m.t)
          const cx = (wk) => x(wk) + bw / 2
          const ticks = M.band ? [60, 71, 80, 88] : [0, 1, 2, 3, 4, 5, 6].map((i) => (top * i) / 6)
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
                            <span style={{ color: s.color }}>{'●'}</span> {s.name} <b style={{ color: INK }}>{p && p.v != null ? M.fmt(p.v) : 'no data'}</b>
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
    </div>
  )
}

// ---- tables ----
function flagsFor(d) {
  const out = []
  if (has(d.moisture) && d.moisture < DRY) out.push([BAD, 'Dry reading'])
  if (has(d.moisture) && d.moisture > WET) out.push([WARN, 'Wet reading'])
  if (has(d.etActual) && has(d.appIn) && d.etActual >= 0.3 && d.appIn < 0.85 * d.etActual) out.push([WARN, 'Applied under ET'])
  if (has(d.etActual) && has(d.appIn) && d.etActual >= 0.3 && d.appIn > 1.15 * d.etActual) out.push([WARN, 'Applied over ET'])
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
                <td key={i} style={{ ...td, color: has(v) ? INK : MUTED }}>{d2(v)}</td>
              ))}
              <td style={td}>{has(d.moisture) ? d.moisture : ''}</td>
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
const labelStyle = { display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 13 }

function Segmented({ value, onChange, options }) {
  return (
    <span role="group" aria-label="Data source" style={{ display: 'inline-flex', border: `1px solid ${LINE}`, borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          style={{ border: 0, borderRadius: 0, padding: '6px 14px', fontSize: 13, background: value === v ? INK : '#fff', color: value === v ? '#fff' : INK }}
        >
          {label}
        </button>
      ))}
    </span>
  )
}

// ---- the page ----
function todayIsoLocal() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function IrrigationReports() {
  const [source, setSource] = useState('demo')
  const [seasons, setSeasons] = useState(null)
  const [seasonId, setSeasonId] = useState('')
  const [live, setLive] = useState({ status: 'idle', data: null, error: '' })
  const cache = useRef({})
  const [farm, setFarm] = useState('all')
  const [crop, setCrop] = useState('')
  const [picked, setPicked] = useState([])
  const [measure, setMeasure] = useState('appPct')

  // Live: load the season list once, then the picked season (kept until refreshed).
  useEffect(() => {
    if (source !== 'live' || seasons) return undefined
    let off = false
    fetchSeasons()
      .then((list) => {
        if (off) return
        setSeasons(list)
        const year = new Date().getFullYear()
        const pick = list.find((s) => s.year === year) || list[0]
        if (pick) setSeasonId(pick.id)
        else setLive({ status: 'error', data: null, error: 'No seasons found in AIO.' })
      })
      .catch((err) => { if (!off) setLive({ status: 'error', data: null, error: err.message || String(err) }) })
    return () => { off = true }
  }, [source, seasons])

  const [reloadTick, setReloadTick] = useState(0)
  useEffect(() => {
    if (source !== 'live' || !seasonId || !seasons) return undefined
    const season = seasons.find((s) => s.id === seasonId)
    if (!season) return undefined
    if (cache.current[seasonId]) { setLive({ status: 'ready', data: cache.current[seasonId], error: '' }); return undefined }
    let off = false
    setLive({ status: 'loading', data: null, error: '' })
    loadLiveReport(season, todayIsoLocal())
      .then((data) => { if (off) return; cache.current[seasonId] = data; setLive({ status: 'ready', data, error: '' }) })
      .catch((err) => { if (!off) setLive({ status: 'error', data: null, error: err.message || String(err) }) })
    return () => { off = true }
  }, [source, seasonId, seasons, reloadTick])

  const isDemo = source === 'demo'
  const dataset = useMemo(() => {
    if (isDemo) return { fields: DEMO_FIELDS, rows: DEMO_WEEKLY, warnings: [], ready: true }
    if (live.status === 'ready' && live.data) return { fields: live.data.fields, rows: live.data.rows, warnings: live.data.warnings || [], ready: true }
    return { fields: [], rows: [], warnings: [], ready: false }
  }, [isDemo, live])

  const farms = useMemo(() => [...new Set(dataset.fields.map((f) => f.farm).filter(Boolean))].sort(), [dataset])
  const farmFields = useMemo(() => dataset.fields.filter((f) => farm === 'all' || f.farm === farm), [dataset, farm])
  const hasRowsByKey = useMemo(() => { const s = new Set(); dataset.rows.forEach((r) => s.add(r.fieldKey)); return s }, [dataset])
  const crops = useMemo(() => {
    const m = new Map()
    farmFields.forEach((f) => {
      const c = m.get(f.crop) || { crop: f.crop, total: 0, withData: 0 }
      c.total += 1
      if (hasRowsByKey.has(f.key)) c.withData += 1
      m.set(f.crop, c)
    })
    return [...m.values()].sort((a, b) => b.withData - a.withData || b.total - a.total || a.crop.localeCompare(b.crop))
  }, [farmFields, hasRowsByKey])

  // Keep the crop valid when the source, season or farm changes.
  useEffect(() => {
    if (!crops.length) return
    if (!crops.some((c) => c.crop === crop)) {
      const next = (isDemo && crops.find((c) => c.crop === 'Potato')) || crops[0]
      setCrop(next.crop)
    }
  }, [crops, crop, isDemo])
  useEffect(() => {
    setPicked(isDemo && crop === 'Potato' ? ['ENCRAFT', 'WILSON N'] : [])
    setMeasure('appPct')
  }, [crop, isDemo, seasonId, farm])
  useEffect(() => { setFarm('all') }, [source, seasonId])

  const cropFields = useMemo(() => farmFields.filter((f) => f.crop === crop), [farmFields, crop])
  const showFarmInLabel = farm === 'all' && farms.length > 1
  const fieldsView = useMemo(
    () => cropFields.map((f) => ({ ...f, label: showFarmInLabel && f.farm ? `${f.name} (${f.farm})` : f.name })),
    [cropFields, showFarmInLabel]
  )
  const cropKeys = useMemo(() => new Set(cropFields.map((f) => f.key)), [cropFields])
  const cropRows = useMemo(() => dataset.rows.filter((r) => cropKeys.has(r.fieldKey)), [dataset, cropKeys])
  const report = useMemo(() => buildReport(cropRows, fieldsView), [cropRows, fieldsView])
  const { summary } = report
  const cropWord = (crop || 'crop').toLowerCase()
  const pickedFields = picked.map((k) => fieldsView.find((f) => f.key === k)).filter(Boolean)
  const n = pickedFields.length
  const single = n === 1 ? pickedFields[0] : null
  const weekRows = single ? (report.byField.get(single.key) || []) : report.farmWeekly
  const hasMoisture = report.hasMoisture
  const hasAnyData = cropRows.length > 0
  const measureOptions = Object.entries(MEASURES).filter(([k]) => k !== 'moisture' || hasMoisture)
  const activeMeasure = MEASURES[measure] && (measure !== 'moisture' || hasMoisture) ? measure : 'appPct'
  const colorOf = (i) => (n > 1 ? COLORS[i % COLORS.length] : MUTED)
  const season = seasons && seasons.find((s) => s.id === seasonId)
  const where = isDemo ? 'Acequia' : (farm === 'all' ? 'All farms' : farm.replace(/\w\S*/g, (t) => t[0] + t.slice(1).toLowerCase()))
  const seasonName = isDemo ? '2026' : (season ? season.name : '')

  const toggle = (key) => setPicked((cur) => (cur.includes(key) ? cur.filter((x) => x !== key) : [...cur, key].slice(-MAXF)))

  const fieldRows = [...report.fieldSummary].sort((a, b) => {
    const ia = picked.indexOf(a.field.key)
    const ib = picked.indexOf(b.field.key)
    if (ia >= 0 || ib >= 0) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    if (a.hasData !== b.hasData) return a.hasData ? -1 : 1
    return a.field.label.localeCompare(b.field.label)
  })

  const kpis = [
    ['Crop ET per field (in)', d1(summary.etActual)],
    ['Scheduled per field (in)', d1(summary.scheduled)],
    ['Applied per field (in)', d1(summary.applied)],
    ['Applied as share of ET (%)', d0(summary.appliedPct)]
  ]

  // Why the fields without data have none, counted for the empty-state message.
  const reasonCounts = useMemo(() => {
    const m = new Map()
    cropFields.filter((f) => !hasRowsByKey.has(f.key)).forEach((f) => {
      const r = (f.issues && f.issues[0]) || 'Nothing recorded yet'
      m.set(r, (m.get(r) || 0) + 1)
    })
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [cropFields, hasRowsByKey])

  const topControls = (
    <section aria-label="Report settings" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px 16px' }}>
      <Segmented value={source} onChange={setSource} options={[['demo', 'Demo data'], ['live', 'Live data']]} />
      {!isDemo && seasons && (
        <label style={labelStyle}>
          <span style={{ color: MUTED }}>Season</span>
          <select style={selectStyle} value={seasonId} onChange={(e) => setSeasonId(e.target.value)} aria-label="Season">
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </label>
      )}
      {!isDemo && dataset.ready && farms.length > 0 && (
        <label style={labelStyle}>
          <span style={{ color: MUTED }}>Farm</span>
          <select style={selectStyle} value={farm} onChange={(e) => setFarm(e.target.value)} aria-label="Farm">
            <option value="all">All farms</option>
            {farms.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        </label>
      )}
      {dataset.ready && crops.length > 0 && (
        <label style={labelStyle}>
          <span style={{ color: MUTED }}>Crop</span>
          <select style={selectStyle} value={crop} onChange={(e) => setCrop(e.target.value)} aria-label="Crop">
            {crops.map((c) => (
              <option key={c.crop} value={c.crop}>
                {c.crop} {c.withData === 0 ? `(${c.total} ${c.total === 1 ? 'field' : 'fields'}, no data)` : c.withData < c.total ? `(${c.withData} of ${c.total} fields)` : `(${c.total} ${c.total === 1 ? 'field' : 'fields'})`}
              </option>
            ))}
          </select>
        </label>
      )}
      {!isDemo && live.status === 'ready' && live.data && (
        <span style={{ ...noteStyle, display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          Read from AIO at {live.data.loadedAt.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
          <button type="button" onClick={() => { delete cache.current[seasonId]; setReloadTick((t) => t + 1) }}>Refresh</button>
        </span>
      )}
    </section>
  )

  const title = `${where} ${cropWord} water report${seasonName ? ', ' + seasonName : ''}`

  if (!isDemo && live.status !== 'ready') {
    return (
      <div style={{ maxWidth: 1080, margin: '0 auto', padding: '16px 12px 40px', display: 'flex', flexDirection: 'column', gap: 18, color: INK }}>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>Water report</h1>
        {topControls}
        <p style={{ ...noteStyle, fontSize: 14 }}>
          {live.status === 'error' ? 'Could not read AIO: ' + live.error : 'Reading the season from AIO…'}
        </p>
      </div>
    )
  }

  return (
    <div style={{ maxWidth: 1080, margin: '0 auto', padding: '16px 12px 40px', display: 'flex', flexDirection: 'column', gap: 26, color: INK }}>
      <header>
        <h1 style={{ margin: 0, fontSize: 26, fontWeight: 600, lineHeight: 1.2 }}>{title}</h1>
        <p style={{ display: 'inline-block', margin: '8px 0 0', padding: '3px 10px', borderRadius: 999, fontSize: 12, background: '#fff', border: `1px solid ${isDemo ? WARN : OK}` }}>
          {isDemo
            ? 'Demo data: scheduled and applied water are modeled. Crop ET, rain and moisture readings are real where they exist.'
            : 'Live data from AIO. A dash means AIO has nothing recorded for it yet.'}
        </p>
        <div style={{ marginTop: 12 }}>{topControls}</div>
        {dataset.warnings.length > 0 && (
          <p style={{ ...noteStyle, marginTop: 8, color: WARN }}>{dataset.warnings.join(' ')}</p>
        )}
        <p style={{ margin: '12px 0 0', fontSize: 16, lineHeight: 1.55, maxWidth: '70ch' }}>
          {!hasAnyData && <>No data for {cropWord} yet.</>}
          {hasAnyData && (
            <>
              <b>{summary.fields}</b> of {cropFields.length} {cropWord} {cropFields.length === 1 ? 'field has' : 'fields have'} data.
              {summary.appliedPct != null
                ? <> Applied water covered <b>{summary.appliedPct}</b>% of crop ET in the weeks both were recorded.</>
                : <> No applied water is recorded yet.</>}
              {hasMoisture
                ? <> Of <b>{summary.readings}</b> moisture readings, <b>{summary.dry}</b> were below the 71% line.</>
                : <> No moisture readings are logged for {cropWord}.</>}
              {summary.estMiss != null && <> The Monday ET estimate missed the week's actual ET by <b>{summary.estMiss}</b>% on average.</>}
            </>
          )}
        </p>
        {isDemo && DEMO_CROP_NOTES[crop] && <p style={{ ...noteStyle, marginTop: 8 }}>{DEMO_CROP_NOTES[crop]}</p>}
        {!hasAnyData && reasonCounts.length > 0 && (
          <ul style={{ ...noteStyle, margin: '8px 0 0', paddingLeft: 18 }}>
            {reasonCounts.map(([r, c]) => <li key={r}>{c} {c === 1 ? 'field' : 'fields'}: {r}</li>)}
          </ul>
        )}
      </header>

      {hasAnyData && (
        <section aria-label="Season totals per field" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12 }}>
          {kpis.map(([label, val]) => (
            <div key={label} style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
              <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
              <span style={{ fontSize: 28, lineHeight: 1.1, fontVariantNumeric: 'tabular-nums', color: val === '—' ? MUTED : INK }}>{val}</span>
              {val === '—' && <span style={{ fontSize: 11, color: MUTED }}>No data yet</span>}
            </div>
          ))}
        </section>
      )}

      {hasAnyData && (
        <section aria-label="Choose fields" style={{ position: 'sticky', top: 0, zIndex: 6, background: '#f7f5f0', padding: '10px 0', borderBottom: `1px solid ${LINE}` }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, minHeight: 34, alignItems: 'center' }}>
              {pickedFields.map((f, i) => (
                <button key={f.key} type="button" title={'Take ' + f.label + ' out'} onClick={() => toggle(f.key)}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 999, fontSize: 12.5 }}>
                  <Swatch color={colorOf(i)} />
                  <span>{f.label}</span>
                  <span style={{ color: MUTED }}>{'×'}</span>
                </button>
              ))}
              {!n && <span style={noteStyle}>All {cropWord} fields (average)</span>}
            </div>
            <select
              style={selectStyle}
              aria-label="Add a field"
              value=""
              onChange={(e) => {
                const v = e.target.value
                if (v === '__all') setPicked([])
                else if (v) toggle(v)
              }}
            >
              <option value="">{n ? 'Add a field…' : 'Pick a field…'}</option>
              {fieldsView.filter((f) => !picked.includes(f.key)).map((f) => (
                <option key={f.key} value={f.key}>{f.label}{hasRowsByKey.has(f.key) ? '' : ' (no data)'}</option>
              ))}
              {n > 0 && <option value="__all">All fields (average)</option>}
            </select>
          </div>
          <p style={{ ...noteStyle, marginTop: 6 }}>
            {n === 0 && `No field picked, so this is the average of the ${cropWord} fields that have data. Add a field to look at it alone, or add two or more to compare them.`}
            {n === 1 && 'One field picked. Add another to compare them side by side.'}
            {n >= 2 && 'Comparing fields side by side. Up to 4 at a time: picking a fifth drops the first one.'}
          </p>
        </section>
      )}

      {hasAnyData && (n >= 2 ? (
        <Section title="Fields side by side">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label htmlFor="rp-measure" style={noteStyle}>Compare</label>
            <select id="rp-measure" style={selectStyle} value={activeMeasure} onChange={(e) => setMeasure(e.target.value)} aria-label="What to compare">
              {measureOptions.map(([k, v]) => (
                <option key={k} value={k}>{v.label}</option>
              ))}
            </select>
          </div>
          <div style={{ marginTop: 8 }}>
            <CompareChart report={report} picked={pickedFields} measure={activeMeasure} />
          </div>
          <p style={{ ...noteStyle, marginTop: 8 }}>
            One line per field. Point at a week to see every field's number for it. For the percent views, 100% means the field got what the crop used. Weeks before planting, with almost no ET, or with no data are left blank.
          </p>
        </Section>
      ) : (
        <Section title={single ? 'Water against crop ET, week by week: ' + single.label : 'Water against crop ET, week by week'}>
          {weekRows.length ? <WaterChart rows={weekRows} field={single ? single.label : null} /> : <p style={noteStyle}>No data for this field yet.</p>}
          {hasMoisture && weekRows.length > 0 && (
            <>
              <h2 style={{ fontSize: 16, fontWeight: 600, margin: '22px 0 6px' }}>Soil moisture readings</h2>
              <MoistureChart rows={weekRows} field={single ? single.label : null} />
            </>
          )}
        </Section>
      ))}

      {hasAnyData && hasMoisture && (
        <Section title="What the water looked like around each kind of reading"
          note={`Each moisture reading is matched to the same week's schedule. Scheduled is compared with the Monday ET estimate, applied with the week's actual ET. This one covers every ${cropWord} field. A dash means that number isn't recorded for those weeks.`}>
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
                    <td style={td}>{b.readings ? d0(b.schedPct) : ''}</td>
                    <td style={td}>{b.readings ? d0(b.appPct) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {hasAnyData && n < 2 && weekRows.length > 0 && (
        <Section title={single ? 'Week by week: ' + single.label : 'Week by week: average of the fields with data'}>
          <WeekTable rows={weekRows} />
        </Section>
      )}

      <Section title={`Every ${cropWord} field, whole season`} note={hasAnyData ? 'Tap a field to add it to the comparison, or tap it again to take it out. Picked fields come first, then the fields with data.' : 'These are the fields in AIO for this crop. None has data yet.'}>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ ...tableStyle, minWidth: hasMoisture ? 880 : 700 }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Field</th>
                <th style={th}>Crop ET (in)</th>
                <th style={th}>Scheduled (in)</th>
                <th style={th}>Applied (in)</th>
                <th style={th}>Applied vs ET (%)</th>
                {hasMoisture && <th style={th}>Readings</th>}
                {hasMoisture && <th style={th}>Below 71%</th>}
                <th style={{ ...th, textAlign: 'left' }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {fieldRows.map((d) => {
                const f = d.field
                const i = picked.indexOf(f.key)
                const status = d.hasData ? ((f.notes && f.notes.length) ? f.notes.join('. ') : '') : 'No data: ' + ((f.issues && f.issues.length) ? f.issues.join('. ') : 'nothing recorded yet')
                return (
                  <tr
                    key={f.key}
                    tabIndex={0}
                    onClick={() => toggle(f.key)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(f.key) } }}
                    style={{ cursor: 'pointer', background: i >= 0 ? '#fff' : undefined, color: d.hasData ? INK : MUTED }}
                  >
                    <td style={{ ...td, textAlign: 'left' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                        {i >= 0 && <Swatch color={colorOf(i)} />}
                        {f.label}
                      </span>
                    </td>
                    <td style={td}>{d1(d.etActual)}</td>
                    <td style={td}>{d1(d.scheduled)}</td>
                    <td style={td}>{d1(d.applied)}</td>
                    <td style={td}>{d0(d.appliedPct)}</td>
                    {hasMoisture && <td style={td}>{d.hasData ? d.readings : '—'}</td>}
                    {hasMoisture && <td style={td}>{d.hasData && d.readings ? d.dry : '—'}</td>}
                    <td style={{ ...td, textAlign: 'left', whiteSpace: 'normal', minWidth: 220, fontSize: 12, color: MUTED }}>{status}</td>
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
          <p style={{ margin: 0 }}>Crop ET is the AgriMet station's measured daily alfalfa-reference ET, multiplied by AIO's draft crop curve for the crop and each field's plant date from AgWorld (alfalfa uses a fixed season-average curve with no plant date). The crop curves are drafts still being checked.</p>
          <p style={{ margin: 0 }}>The ET estimate is what AIO could have said on Monday, using the previous seven days of weather for the whole week. Actual ET uses the measured days.</p>
          <p style={{ margin: 0 }}>Moisture readings are the percentages logged from the weekly digs and imported into the Agronomy scouting data. A week with no reading shows no dot.</p>
          {isDemo ? (
            <p style={{ margin: 0 }}>In the demo, scheduled and applied water are modeled, because the 2026 season was not scheduled in AIO. They assume 6.5 gallons per minute per acre, and a few weeks include a pivot stop that cut applied water. For fields with moisture readings the model leans the schedule down in weeks with a dry reading and up in weeks with a wet one. None of it comes from the farm's records.</p>
          ) : (
            <>
              <p style={{ margin: 0 }}>Scheduled inches come from the saved weekly schedules, using the pivot's GPM and the field's acres. A week with no saved schedule is blank, not zero.</p>
              <p style={{ margin: 0 }}>Applied inches come from the weekly pivot run log (wet hours times the pivot's GPM), the same way the Applied column on the schedule works. AIO started counting on the week of Nov 9, 2026, so earlier weeks are blank.</p>
              <p style={{ margin: 0 }}>Rain is not saved in AIO yet, so the rain column is blank. Weather for weeks before AIO started saving AgriMet each morning is also missing, so older weeks may show no ET until that history is loaded.</p>
            </>
          )}
        </div>
      </details>
    </div>
  )
}
