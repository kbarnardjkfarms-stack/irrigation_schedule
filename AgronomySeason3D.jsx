import { useMemo, useRef, useState } from 'react'
import { STATUS_COLOR } from './AgronomyConfig.js'

// A rotatable pseudo-3D view of the season: one upright "panel" per measure
// (soil NO3, petiole NO3, field moisture) stacked front to back, all sharing
// the same weeks-since-emergence axis along the bottom.
//
// The three measures are in different units (ppm, ppm, %), so each panel is
// drawn on its own TARGET scale: the green slab is that measure's target
// range for that week (0 = bottom of range, 1 = top), so a point sitting in
// the slab is in range, below it is red, above it is orange - whatever the
// units. Real values are in the readout under the chart and in each dot's
// hover text. Points far outside the range are pinned to the panel's edge.
//
// Hand-rolled SVG, no 3D library. Drag to rotate, click a dot to pick that
// week (same selection the rest of the By field tab uses).

const W = 640
const H = 360
const N_MIN = -0.6 // normalized value shown at the panel bottom
const N_MAX = 1.6 // ... and top
const DEPTH = 0.9 // distance between front and back panel (x-axis length is 2)

const clampN = (n) => Math.max(N_MIN, Math.min(N_MAX, n))
const toY = (n) => (clampN(n) - N_MIN) / (N_MAX - N_MIN) // 0..1 up the panel

export default function AgronomySeason3D({ series, selectedWeek, onSelect, fmtDate }) {
  const [yaw, setYaw] = useState(-32) // degrees, turn left/right
  const [pitch, setPitch] = useState(22) // degrees, tilt down onto the floor
  const drag = useRef(null)
  const moved = useRef(false)

  const lanes = series.filter(Boolean)
  const allX = lanes.flatMap((l) => l.points.map((p) => p.x))
  const hasData = allX.length > 0
  const minX = hasData ? Math.min(...allX) : 0
  const maxX = hasData ? Math.max(...allX) : 1
  const spanX = maxX - minX || 1

  // World coordinates: u along the weeks (0..2), v up (0..1), d depth lane.
  const geom = useMemo(() => {
    const a = (yaw * Math.PI) / 180
    const b = (pitch * Math.PI) / 180
    const cosA = Math.cos(a), sinA = Math.sin(a), cosB = Math.cos(b), sinB = Math.sin(b)
    const n = lanes.length
    const scale = 98
    const project = (u, v, d) => {
      // centre the box on the origin, then rotate (yaw about vertical, tilt about horizontal)
      const x = u - 1
      const y = v - 0.5
      const z = n > 1 ? (d / (n - 1) - 0.5) * DEPTH * 2 : 0
      const x1 = x * cosA + z * sinA
      const z1 = -x * sinA + z * cosA
      const y2 = y * cosB - z1 * sinB
      const z2 = y * sinB + z1 * cosB
      return { sx: W / 2 + x1 * scale, sy: H / 2 - 6 - y2 * scale * 1.35, depth: z2 }
    }
    return { project }
  }, [yaw, pitch, lanes.length])

  const { project } = geom
  const uOf = (x) => ((x - minX) / spanX) * 2
  const pt = (p) => `${p.sx.toFixed(1)},${p.sy.toFixed(1)}`

  // Back-to-front draw order so near panels cover far ones.
  const order = lanes
    .map((l, i) => ({ l, i, depth: project(1, 0.5, i).depth }))
    .sort((p, q) => q.depth - p.depth)

  const tickWeeks = useMemo(() => {
    if (!hasData) return []
    const count = Math.max(2, Math.min(7, maxX - minX + 1))
    return [...new Set(Array.from({ length: count }, (_, i) => Math.round(minX + (spanX * i) / (count - 1))))]
  }, [hasData, minX, maxX, spanX])

  function onPointerDown(e) {
    drag.current = { x: e.clientX, y: e.clientY, yaw, pitch }
    moved.current = false
    if (e.currentTarget.setPointerCapture) {
      try { e.currentTarget.setPointerCapture(e.pointerId) } catch (err) { /* ignore */ }
    }
  }
  function onPointerMove(e) {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x, dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 4) moved.current = true
    setYaw(Math.max(-80, Math.min(80, d.yaw + dx * 0.4)))
    setPitch(Math.max(2, Math.min(70, d.pitch + dy * 0.3)))
  }
  function onPointerUp() { drag.current = null }

  if (!hasData) {
    return <div className="agronomy-chart-empty">Nothing to plot yet - no soil NO3, petiole NO3 or moisture readings for this season</div>
  }

  const selectedReadout = lanes.map((l) => {
    const upTo = l.points.filter((p) => selectedWeek == null || p.x <= selectedWeek)
    return { lane: l, p: upTo.length ? upTo[upTo.length - 1] : null }
  })

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', touchAction: 'none', cursor: 'grab', display: 'block', userSelect: 'none', WebkitUserSelect: 'none' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {order.map(({ l, i }) => {
          const corners = [project(0, 0, i), project(2, 0, i), project(2, 1, i), project(0, 1, i)]
          const slab = [project(0, toY(0), i), project(2, toY(0), i), project(2, toY(1), i), project(0, toY(1), i)]
          const line = l.points.map((p) => project(uOf(p.x), toY(p.norm), i))
          const sel = selectedWeek != null && selectedWeek >= minX && selectedWeek <= maxX
          const selTop = sel ? project(uOf(selectedWeek), 1, i) : null
          const selBottom = sel ? project(uOf(selectedWeek), 0, i) : null
          const lbl = project(0, 1, i)
          return (
            <g key={l.key}>
              {/* the panel */}
              <polygon points={corners.map(pt).join(' ')} fill="#ffffff" fillOpacity="0.35" stroke="#c9c6bb" strokeWidth="1" />
              {/* target slab: green = in range */}
              <polygon points={slab.map(pt).join(' ')} fill={STATUS_COLOR.optimal.dot} fillOpacity="0.22" stroke={STATUS_COLOR.optimal.dot} strokeOpacity="0.5" strokeWidth="1" />
              {sel && <line x1={selTop.sx} y1={selTop.sy} x2={selBottom.sx} y2={selBottom.sy} stroke="#555" strokeWidth="1" strokeDasharray="3 3" />}
              {l.points.length > 1 && (
                <polyline points={line.map(pt).join(' ')} fill="none" stroke={l.color} strokeWidth="2" strokeLinejoin="round" />
              )}
              {l.points.map((p, k) => {
                const top = line[k]
                const floor = project(uOf(p.x), 0, i)
                const dot = (p.status && STATUS_COLOR[p.status]?.dot) || l.color
                const isSel = selectedWeek === p.x
                return (
                  <g key={k} onClick={() => { if (!moved.current && onSelect) onSelect(p.x) }} style={{ cursor: 'pointer' }}>
                    <line x1={floor.sx} y1={floor.sy} x2={top.sx} y2={top.sy} stroke={dot} strokeOpacity="0.25" strokeWidth="1" />
                    <circle cx={top.sx} cy={top.sy} r="10" fill="transparent" />
                    <circle cx={top.sx} cy={top.sy} r={isSel ? 6 : 4} fill={dot} stroke={isSel ? '#222' : '#fff'} strokeWidth={isSel ? 2 : 1} />
                    <title>
                      {l.label}: {p.y}{l.unit ? ` ${l.unit}` : ''} - wk {p.x}{p.date && fmtDate ? ` (${fmtDate(p.date)})` : ''}
                      {p.range ? ` - target ${p.range[0]}-${p.range[1]}` : ''}
                    </title>
                    {isSel && (
                      <text x={top.sx} y={top.sy - 9} textAnchor="middle" fontSize="10" fontWeight="700" fill={dot}>{p.y}</text>
                    )}
                  </g>
                )
              })}
              {l.points.length === 0 && (
                <text x={(slab[0].sx + slab[2].sx) / 2} y={(slab[0].sy + slab[2].sy) / 2} textAnchor="middle" fontSize="10" fill="#999">
                  no readings
                </text>
              )}
              <text x={lbl.sx} y={lbl.sy - 5} textAnchor="start" fontSize="11" fontWeight="700" fill={l.color} style={{ pointerEvents: 'none' }}>{l.label}</text>
            </g>
          )
        })}
        {/* week ticks along the front floor edge */}
        {tickWeeks.map((t) => {
          const frontLane = Math.max(0, lanes.length - 1)
          const p0 = project(uOf(t), 0, frontLane)
          // push the label a little in front of the floor edge
          const p1 = project(uOf(t), -0.12, frontLane)
          return (
            <g key={t}>
              <line x1={p0.sx} y1={p0.sy} x2={p1.sx} y2={p1.sy} stroke="#999" strokeWidth="1" />
              <text x={p1.sx} y={p1.sy + 10} textAnchor="middle" fontSize="9" fill="#666">Wk {t}</text>
            </g>
          )
        })}
      </svg>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', fontSize: 11, margin: '4px 0 8px' }}>
        <span>Drag to rotate</span>
        <button className="agronomy-link-btn" onClick={() => { setYaw(-32); setPitch(22) }}>Reset view</button>
        <button className="agronomy-link-btn" onClick={() => { setYaw(0); setPitch(2) }}>Flat (side on)</button>
        <span style={{ color: '#666' }}>Green slab = target range. Dot below it is red, above is orange.</span>
      </div>

      <table className="agronomy-chart-readings" style={{ minWidth: 0, width: '100%', fontSize: 11 }}>
        <thead>
          <tr><th>{selectedWeek != null ? `As of week ${selectedWeek}` : 'Latest'}</th><th>Reading</th><th>Target</th><th>Week</th></tr>
        </thead>
        <tbody>
          {selectedReadout.map(({ lane, p }) => {
            const c = p && p.status ? STATUS_COLOR[p.status] : null
            return (
              <tr key={lane.key}>
                <td style={{ color: lane.color, fontWeight: 600 }}>{lane.label}</td>
                <td>
                  {p ? (
                    <span style={{ display: 'inline-block', padding: '1px 7px', borderRadius: 4, fontWeight: 600, ...(c ? { background: c.bg, color: c.fg } : {}) }}>
                      {p.y}{lane.unit ? ` ${lane.unit}` : ''}
                    </span>
                  ) : '—'}
                </td>
                <td>{p && p.range ? `${p.range[0]}–${p.range[1]}` : '—'}</td>
                <td>{p ? p.x : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

// Position within the target range: 0 = bottom of range, 1 = top. Exported so
// the By field tab can build the series without repeating the maths.
export function normalizeToRange(value, range) {
  if (value == null || !range) return 0.5
  const span = range[1] - range[0]
  if (!span) return value === range[0] ? 0.5 : (value > range[0] ? 1.5 : -0.5)
  return (value - range[0]) / span
}
