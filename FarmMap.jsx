import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { collection, collectionGroup, doc, onSnapshot, query, setDoc, updateDoc, where } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { canonCrop, effectiveYield } from './yieldMath.js'
import {
  POT_BUCKETS, centroid, circleRing, cropColor, cropFor, cropLabel, cropsFromDesc, lastPotatoYear, mapKey, matchPlan,
  packRing, potBucket, shapeAcres, unpackRing
} from './mapMath.js'
import { FieldsTable, MapImport } from './FarmMapSetup.jsx'

// Farm Map module — AIO's own map of every field, from the JKF Google farm
// map, coloured by the Main Field Plan for any year.
//
// Data (see firestore.rules):
//   farmFields/{id}     one outline per field / area: name, farm, kind ('field' |
//                       'other' for CREP, canal, dry corners…), rings [{ c:[lng,lat,…], hole }],
//                       acres (from the outline), planKey (manual link to a plan row)
//   farmPoints/{id}     cellars, shops, beet dumps, housing, fuel…
//   fieldPlanRows/{planYear}__{KEY}  one row of the Main Field Plan: crops by year
//                       and the field's basic plan data. The plan module builds on these.
// This is the start of AIO having its own field list instead of Agworld's;
// the card shows which Agworld field each outline lines up with.

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`

export function loadLeaflet() {
  return new Promise((resolve, reject) => {
    if (window.L) return resolve(window.L)
    if (!document.getElementById('leaflet-css')) {
      const link = document.createElement('link')
      link.id = 'leaflet-css'; link.rel = 'stylesheet'
      link.href = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css'
      document.head.appendChild(link)
    }
    const existing = document.getElementById('leaflet-js')
    if (existing) { const iv = setInterval(() => { if (window.L) { clearInterval(iv); resolve(window.L) } }, 50); return }
    const s = document.createElement('script')
    s.id = 'leaflet-js'; s.src = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js'
    s.onload = () => resolve(window.L); s.onerror = () => reject(new Error('Couldn’t load the map library — check the connection.'))
    document.head.appendChild(s)
  })
}

export default function FarmMap({ userRole }) {
  // For now only Admin and Owner edit; Farm managers view.
  const canEdit = userRole === 'admin' || userRole === 'owner'
  const [view, setView] = useState('map')
  const [rawFields, setRawFields] = useState([])
  const [points, setPoints] = useState([])
  const [planRows, setPlanRows] = useState([])
  const [yieldRecs, setYieldRecs] = useState({})
  const [agFields, setAgFields] = useState({})
  const [seasons, setSeasons] = useState([])
  const [agCrops, setAgCrops] = useState({})
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const thisYear = new Date().getFullYear() + (new Date().getMonth() >= 8 ? 1 : 0)
  const [year, setYear] = useState(thisYear)
  const [mode, setMode] = useState('crop')
  const [farm, setFarm] = useState('all')
  const [focus, setFocus] = useState(null)
  const [selId, setSelId] = useState(null)
  const [layers, setLayers] = useState({ labels: true, points: true, other: true, satellite: true })
  const [search, setSearch] = useState('')
  const [edit, setEdit] = useState(null) // { id|null, mode: 'edit'|'draw'|'circle', pts }

  useEffect(() => {
    const onErr = (e) => setError(e.code === 'permission-denied'
      ? 'No permission to read the farm map. If this is the first time the module has been opened, the new firestore.rules may not be deployed yet.'
      : e.message)
    const list = (setter) => (snap) => { const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() })); setter(out); setError(null) }
    const quiet = () => {}
    const u = [
      onSnapshot(collection(db, 'farmFields'), list(setRawFields), onErr),
      onSnapshot(collection(db, 'farmPoints'), list(setPoints), onErr),
      onSnapshot(collection(db, 'fieldPlanRows'), list(setPlanRows), onErr),
      onSnapshot(collection(db, 'fields'), (snap) => { const m = {}; snap.forEach((d) => { m[d.id] = d.data() }); setAgFields(m) }, quiet),
      onSnapshot(collection(db, 'seasons'), list(setSeasons), quiet),
      onSnapshot(collection(db, 'yieldHistory'), (snap) => {
        const m = {}
        snap.forEach((d) => {
          const r = d.data()
          if (r.deleted || !r.fieldKey || !r.year) return
          const k = mapKey(r.fieldName || r.fieldKey)
          ;(m[k] = m[k] || []).push({ year: r.year, crop: r.crop, variety: r.variety, yield: effectiveYield(r).value, unit: r.unit, acres: r.acres })
        })
        setYieldRecs(m)
      }, quiet)
    ]
    return () => u.forEach((x) => x())
  }, [])

  // Agworld's crop for the chosen year — shown beside the plan while AIO moves off Agworld.
  const agSeason = seasons.find((s) => String(s.name) === String(year))
  useEffect(() => {
    if (!agSeason) { setAgCrops({}); return undefined }
    return onSnapshot(query(collectionGroup(db, 'seasons'), where('seasonId', '==', agSeason.id)), (snap) => {
      const m = {}
      snap.forEach((d) => { m[d.ref.parent.parent.id] = d.data() })
      setAgCrops(m)
    }, () => {})
  }, [agSeason && agSeason.id]) // eslint-disable-line react-hooks/exhaustive-deps

  // Newest plan wins; older plans fill in years the newer one doesn't have.
  const planByKey = useMemo(() => {
    const byKey = {}
    ;[...planRows].sort((a, b) => (a.planYear || 0) - (b.planYear || 0)).forEach((r) => {
      const prev = byKey[r.key]
      byKey[r.key] = prev ? { ...r, crops: { ...prev.crops, ...r.crops } } : r
    })
    return byKey
  }, [planRows])
  const agByKey = useMemo(() => {
    const m = {}
    Object.entries(agFields).forEach(([id, f]) => { if (f.name) m[mapKey(f.name)] = { id, ...f } })
    return m
  }, [agFields])

  const fields = useMemo(() => rawFields.filter((f) => !f.archived).map((f) => {
    const rings = (f.rings || []).map((r) => ({ pts: unpackRing(r), hole: !!r.hole }))
    const { row, how } = f.kind === 'other' ? { row: null, how: null } : matchPlan(f, planByKey)
    const k = mapKey(f.name)
    const recs = yieldRecs[k] || (row ? yieldRecs[row.key] : null) || []
    const yieldCrops = {}
    recs.forEach((r) => { if (r.crop) yieldCrops[String(r.year)] = canonCrop(r.crop) })
    const ag = agByKey[k] || (row ? agByKey[row.key] : null) || null
    const outer = rings.find((r) => !r.hole) || rings[0]
    return { ...f, rings, plan: row, planHow: how, yieldCrops, yieldRecs: recs, descCrops: f.descCrops || cropsFromDesc(f.desc), ag, center: outer ? centroid(outer.pts) : null }
  }), [rawFields, planByKey, yieldRecs, agByKey])

  const years = useMemo(() => {
    const s = new Set([thisYear])
    planRows.forEach((r) => Object.keys(r.crops || {}).forEach((y) => s.add(+y)))
    return [...s].filter((y) => y >= thisYear - 8).sort()
  }, [planRows, thisYear])
  const farms = useMemo(() => [...new Set(fields.map((f) => f.farm).filter(Boolean))].sort(), [fields])
  const sel = fields.find((f) => f.id === selId) || null

  // legend: acres by crop (plan acres once per plan row) or by rotation bucket
  const legend = useMemo(() => {
    const seen = new Set(), acc = {}
    let total = 0
    fields.forEach((f) => {
      if (f.kind === 'other' || (farm !== 'all' && f.farm !== farm)) return
      const id = f.plan ? f.plan.key : f.id
      if (seen.has(id)) return
      seen.add(id)
      const ac = (f.plan && f.plan.acres) || f.acres || 0
      const k = mode === 'crop' ? (cropFor(f, year).crop || 'none') : mode === 'pot' ? String(potBucket(f, year)) : f.farm
      acc[k] = (acc[k] || 0) + ac; total += ac
    })
    return { rows: Object.entries(acc).sort((a, b) => (mode === 'pot' ? +a[0] - +b[0] : b[1] - a[1])), total }
  }, [fields, farm, mode, year])

  // ---------------------------------------------------------------------------
  function run(fn, ok) {
    setMsg(null)
    Promise.resolve().then(fn).then(() => ok && setMsg({ ok: true, text: ok })).catch((e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin or Owner can change the map.' : e.message }))
  }
  function saveShape(pts) {
    if (!pts || pts.length < 3) return
    if (edit && edit.id) {
      const f = rawFields.find((x) => x.id === edit.id)
      const holes = (f.rings || []).filter((r) => r.hole)
      const rings = [packRing(pts), ...holes]
      run(() => updateDoc(doc(db, 'farmFields', edit.id), { rings, acres: shapeAcres([{ pts }]), source: 'edited', updatedBy: who(), updatedAt: Date.now() }), 'Boundary saved.')
      setEdit(null)
    } else {
      const name = (edit.name || '').trim() || 'New field'
      const id = newId()
      run(() => setDoc(doc(db, 'farmFields', id), { name, key: mapKey(name), farm: edit.farm || (farm !== 'all' ? farm : 'Unassigned'), kind: 'field', rings: [packRing(pts)], acres: shapeAcres([{ pts }]), source: 'drawn', updatedBy: who(), updatedAt: Date.now() }), `${name} added.`)
      setEdit(null); setSelId(id)
    }
  }
  function saveField(id, patch) { run(() => updateDoc(doc(db, 'farmFields', id), { ...patch, updatedBy: who(), updatedAt: Date.now() }), 'Saved.') }

  const tabs = [['map', 'Map'], ['fields', 'Fields & links'], ...(canEdit ? [['import', 'Import']] : [])]
  return (
    <div className="agronomy farmmap">
      {error && <div className="agronomy-error-banner">{error}</div>}
      <div className="agronomy-view-toggle harvest-tabs">
        {tabs.map(([k, l]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>)}
        <span className="contracts-sub" style={{ marginTop: 0, alignSelf: 'center' }}>{fields.filter((f) => f.kind !== 'other').length} fields · {planRows.length ? `plan ${Math.max(...planRows.map((r) => r.planYear || 0))}` : 'no plan imported yet'}</span>
      </div>
      {msg && <div className={msg.ok ? 'yields-ok harvest-msg' : 'agronomy-error-banner'} onClick={() => setMsg(null)}>{msg.text}</div>}

      {view === 'map' && (
        !rawFields.length ? (
          <div className="yields-card"><div className="yields-card-title">No fields on the map yet</div>
            <div className="contracts-sub">{canEdit ? 'Go to Import and load the farm map (KML/KMZ from Google My Maps or Earth), then the Main Field Plan.' : 'An Admin or Owner needs to import the farm map first.'}</div></div>
        ) : (
          <div className="fm-layout">
            <aside className="fm-rail">
              <div>
                <div className="fm-lab">Crop year</div>
                <div className="fm-years">
                  {years.map((y) => <button key={y} className={y === year ? 'active' : ''} onClick={() => { setYear(y); setFocus(null) }}>{String(y).slice(2)}{y > new Date().getFullYear() ? <i>plan</i> : null}</button>)}
                </div>
              </div>
              <div>
                <div className="fm-lab">Colour by</div>
                <div className="fm-seg">
                  {[['crop', 'Crop'], ['pot', 'Since potatoes'], ['farm', 'Farm']].map(([k, l]) => <button key={k} className={mode === k ? 'active' : ''} onClick={() => { setMode(k); setFocus(null) }}>{l}</button>)}
                </div>
              </div>
              <div className="fm-row">
                <select value={farm} onChange={(e) => { setFarm(e.target.value); setFocus(null) }} aria-label="Farm">
                  <option value="all">All farms</option>{farms.map((f) => <option key={f}>{f}</option>)}
                </select>
              </div>
              <div className="fm-row">
                <input className="agronomy-search-input" list="fm-names" placeholder="Find a field…" value={search} onChange={(e) => {
                  setSearch(e.target.value)
                  const hit = fields.find((f) => f.name.toLowerCase() === e.target.value.toLowerCase())
                  if (hit) { setSelId(hit.id); setSearch('') }
                }} />
                <datalist id="fm-names">{fields.map((f) => <option key={f.id} value={f.name}>{f.farm}</option>)}</datalist>
              </div>
              <div>
                <div className="fm-lab">{mode === 'crop' ? `Acres by crop · ${year}` : mode === 'pot' ? `Potato rotation · ${year}` : 'Acres by farm'}</div>
                <div className="fm-legend">
                  {legend.rows.map(([k, ac]) => {
                    const color = mode === 'crop' ? (k === 'none' ? 'var(--fm-none)' : cropColor(k)) : mode === 'pot' ? POT_BUCKETS[+k][1] : farmColor(k, farms)
                    const label = mode === 'crop' ? (k === 'none' ? 'No crop recorded' : cropLabel(k)) : mode === 'pot' ? POT_BUCKETS[+k][0] : k
                    return (
                      <button key={k} className={focus === k ? 'active' : ''} onClick={() => setFocus(focus === k ? null : k)}>
                        <span className="fm-sw" style={{ background: color }} /><span>{label}</span>
                        <span className="num">{Math.round(ac).toLocaleString()} ac</span><span className="num">{legend.total ? Math.round((ac / legend.total) * 100) : 0}%</span>
                      </button>
                    )
                  })}
                  <div className="fm-total"><span /><b>Total</b><span className="num"><b>{Math.round(legend.total).toLocaleString()} ac</b></span><span /></div>
                </div>
              </div>
              <div className="fm-layers">
                {[['satellite', 'Satellite'], ['labels', 'Field names'], ['points', 'Cellars, shops, dumps…'], ['other', 'CREP / other areas']].map(([k, l]) => (
                  <label key={k} className="hb-check"><input type="checkbox" checked={layers[k]} onChange={(e) => setLayers({ ...layers, [k]: e.target.checked })} /> {l}</label>
                ))}
              </div>
              {canEdit && (
                <div className="fm-tools">
                  <div className="fm-lab">Draw</div>
                  <button disabled={!!edit} onClick={() => { setSelId(null); setEdit({ id: null, mode: 'draw', pts: [], name: '', farm: farm !== 'all' ? farm : '' }) }}>+ Field by corners</button>
                  <button disabled={!!edit} onClick={() => { setSelId(null); setEdit({ id: null, mode: 'circle', pts: [], name: '', farm: farm !== 'all' ? farm : '' }) }}>+ Pivot circle</button>
                </div>
              )}
            </aside>
            <div className="fm-mapbox">
              <LeafletMap fields={fields} points={points} year={year} mode={mode} farm={farm} focus={focus} farms={farms}
                selId={selId} onSelect={(id) => { if (!edit) setSelId(id) }} layers={layers} edit={edit} setEdit={setEdit} />
              {edit && <EditBar edit={edit} setEdit={setEdit} farms={farms} onSave={saveShape} />}
              {sel && !edit && (
                <FieldCard f={sel} year={year} agCrop={sel.ag && agCrops[sel.ag.id] ? agCrops[sel.ag.id] : null} agSeasonName={agSeason && agSeason.name}
                  canEdit={canEdit} farms={farms} planByKey={planByKey} onClose={() => setSelId(null)} onSave={(patch) => saveField(sel.id, patch)}
                  onEditShape={() => { const outer = sel.rings.find((r) => !r.hole) || sel.rings[0]; setEdit({ id: sel.id, mode: 'edit', pts: outer.pts.map((p) => [...p]) }) }} />
              )}
            </div>
          </div>
        )
      )}
      {view === 'fields' && <FieldsTable fields={fields} planByKey={planByKey} canEdit={canEdit} onSave={saveField} year={year}
        onOpen={(id) => { setSelId(id); setView('map') }} />}
      {view === 'import' && canEdit && <MapImport rawFields={rawFields} points={points} planRows={planRows} run={run} />}
    </div>
  )
}

const FARM_PALETTE = ['#2A6FD6', '#E8801A', '#2E9B4F', '#7B4FC9', '#D23B3B', '#0F8C8C', '#B5487A', '#8C6D1F', '#5B5F66', '#D9B300', '#6B8E23', '#A0522D']
export const farmColor = (f, farms) => FARM_PALETTE[Math.max(0, farms.indexOf(f)) % FARM_PALETTE.length]

// ---------------------------------------------------------------------------
// The Leaflet map
// ---------------------------------------------------------------------------
function LeafletMap({ fields, points, year, mode, farm, focus, farms, selId, onSelect, layers, edit, setEdit }) {
  const box = useRef(null)
  const st = useRef({})
  const [ready, setReady] = useState(false)
  const [loadErr, setLoadErr] = useState(null)
  const fitted = useRef(false)

  useEffect(() => {
    let dead = false
    loadLeaflet().then((L) => {
      if (dead || !box.current || st.current.map) return
      const map = L.map(box.current, { zoomControl: true, preferCanvas: false, doubleClickZoom: false }).setView([42.85, -114.9], 9)
      const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { attribution: 'Imagery &copy; Esri', maxZoom: 20, maxNativeZoom: 19 })
      const plain = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap', maxZoom: 20, maxNativeZoom: 19 })
      st.current = { L, map, sat, plain, polys: L.layerGroup().addTo(map), pts: L.layerGroup().addTo(map), edit: L.layerGroup().addTo(map), byId: {} }
      map.on('zoomend', () => { const show = map.getZoom() >= 11; if (show && !map.hasLayer(st.current.pts) && st.current.wantPts) map.addLayer(st.current.pts); if (!show && map.hasLayer(st.current.pts)) map.removeLayer(st.current.pts); applyLabels(); if (st.current.refreshEdit) st.current.refreshEdit() })
      map.on('click', (e) => st.current.onMapClick && st.current.onMapClick(e))
      setReady(true)
    }).catch((e) => setLoadErr(e.message))
    return () => { dead = true; if (st.current.map) { st.current.map.remove(); st.current = {} } }
  }, [])

  // base layer
  useEffect(() => {
    if (!ready) return
    const { map, sat, plain } = st.current
    if (layers.satellite) { map.removeLayer(plain); sat.addTo(map) } else { map.removeLayer(sat); plain.addTo(map) }
  }, [ready, layers.satellite])

  // outlines — rebuilt when the shapes change
  const shapeSig = fields.map((f) => `${f.id}:${f.updatedAt || ''}:${f.rings.length}`).join('|')
  useEffect(() => {
    if (!ready) return
    const { L, polys, map } = st.current
    polys.clearLayers(); st.current.byId = {}
    fields.forEach((f) => {
      const outer = f.rings.filter((r) => !r.hole).map((r) => r.pts.map(([x, y]) => [y, x]))
      const holes = f.rings.filter((r) => r.hole).map((r) => r.pts.map(([x, y]) => [y, x]))
      if (!outer.length) return
      const layer = L.polygon(outer.length === 1 ? [outer[0], ...holes] : outer.map((o) => [o, ...holes]), { weight: 1, color: '#1d1d1b', fillOpacity: 0.7 })
      layer.on('click', (e) => { L.DomEvent.stopPropagation(e); onSelectRef.current(f.id) })
      layer.bindTooltip(f.name, { permanent: true, direction: 'center', className: 'fm-label', interactive: false })
      polys.addLayer(layer)
      st.current.byId[f.id] = { layer, f }
    })
    if (!fitted.current && fields.length) { fitBulk(); fitted.current = true }
    restyle(); applyLabels()
  }, [ready, shapeSig]) // eslint-disable-line react-hooks/exhaustive-deps

  // Fit the bulk of the fields — a couple of far-off ones shouldn't shrink the whole map.
  function fitBulk(farmName) {
    const { L, map } = st.current
    const cs = fields.filter((f) => f.center && f.kind !== 'other' && (!farmName || f.farm === farmName)).map((f) => f.center)
    if (!cs.length) return
    const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))]
    const xs = cs.map((c) => c[0]).sort((a, b) => a - b), ys = cs.map((c) => c[1]).sort((a, b) => a - b)
    const lo = farmName ? 0 : 0.03, hi = farmName ? 1 : 0.97
    map.fitBounds(L.latLngBounds([q(ys, lo), q(xs, lo)], [q(ys, hi), q(xs, hi)]), { padding: [30, 30], maxZoom: 15 })
  }
  const onSelectRef = useRef(onSelect)
  onSelectRef.current = onSelect
  const styleArgs = useRef({})
  styleArgs.current = { year, mode, farm, focus, farms, selId, layers }

  function restyle() {
    const { map } = st.current
    if (!map) return
    const { year, mode, farm, focus, farms, selId, layers } = styleArgs.current
    Object.values(st.current.byId).forEach(({ layer, f }) => {
      const other = f.kind === 'other'
      const crop = cropFor(f, year).crop
      const key = mode === 'crop' ? (crop || 'none') : mode === 'pot' ? String(potBucket(f, year)) : f.farm
      const fill = other ? '#bdb9ac' : mode === 'crop' ? (crop ? cropColor(crop) : '#d7d3c6') : mode === 'pot' ? POT_BUCKETS[+key][1] : farmColor(f.farm, farms)
      const hidden = (other && !layers.other)
      const dim = (farm !== 'all' && f.farm !== farm) || (focus != null && (other || key !== focus))
      layer.setStyle({
        fillColor: fill, fillOpacity: hidden ? 0 : dim ? 0.12 : other ? 0.35 : 0.72,
        color: f.id === selId ? '#ffffff' : '#1d1d1b', weight: f.id === selId ? 3 : 1, opacity: hidden ? 0 : dim ? 0.3 : 0.8,
        dashArray: other ? '3 3' : null
      })
      if (f.id === selId) layer.bringToFront()
    })
    applyLabels()
  }
  function applyLabels() {
    const { map } = st.current
    if (!map) return
    const z = map.getZoom()
    const { farm, layers } = styleArgs.current
    Object.values(st.current.byId).forEach(({ layer, f }) => {
      const show = layers.labels && z >= 13 && f.kind !== 'other' && (farm === 'all' || f.farm === farm)
      const tt = layer.getTooltip()
      if (!tt) return
      if (show && !layer.isTooltipOpen()) layer.openTooltip()
      if (!show && layer.isTooltipOpen()) layer.closeTooltip()
    })
  }
  useEffect(() => { if (ready) restyle() }, [ready, year, mode, farm, focus, selId, layers.other, layers.labels, fields]) // eslint-disable-line react-hooks/exhaustive-deps

  // fly to the selected field / farm
  useEffect(() => {
    if (!ready || !selId || !st.current.byId[selId]) return
    const { map } = st.current
    const b = st.current.byId[selId].layer.getBounds()
    if (!map.getBounds().contains(b) || map.getZoom() < 13) map.fitBounds(b, { maxZoom: 15, padding: [80, 80] })
  }, [ready, selId])
  useEffect(() => {
    if (!ready) return
    if (fitted.current) fitBulk(farm === 'all' ? null : farm)
  }, [ready, farm]) // eslint-disable-line react-hooks/exhaustive-deps

  // points
  useEffect(() => {
    if (!ready) return
    const { L, pts, map } = st.current
    pts.clearLayers()
    st.current.wantPts = layers.points
    if (map.getZoom() < 11) map.removeLayer(pts); else if (layers.points) map.addLayer(pts)
    if (!layers.points) return
    points.forEach((p) => {
      if (!isFinite(p.lat) || !isFinite(p.lng)) return
      const m = L.circleMarker([p.lat, p.lng], { radius: 4.5, weight: 1.5, color: '#fff', fillColor: POINT_COLOR[p.type] || '#333', fillOpacity: 1 })
      m.bindTooltip(`${p.name}<br><small>${p.type}${p.farm ? ' · ' + p.farm : ''}</small>`)
      pts.addLayer(m)
    })
  }, [ready, points, layers.points])

  // drawing / editing
  useEffect(() => {
    if (!ready) return
    const { L, edit: g, map } = st.current
    g.clearLayers()
    st.current.onMapClick = null
    st.current.refreshEdit = edit ? () => setEdit((ed) => (ed ? { ...ed } : ed)) : null
    if (!edit) { map.getContainer().style.cursor = ''; return }
    map.getContainer().style.cursor = 'crosshair'
    const ll = edit.pts.map(([x, y]) => [y, x])
    if (edit.mode === 'circle' && edit.pts.length === 1) {
      L.circleMarker(ll[0], { radius: 5, color: '#fff', fillColor: '#E8801A', fillOpacity: 1 }).addTo(g)
    } else if (ll.length) {
      ;(ll.length >= 3 ? L.polygon(ll, { color: '#FFD54F', weight: 2, fillOpacity: 0.15 }) : L.polyline(ll, { color: '#FFD54F', weight: 2 })).addTo(g)
    }
    // corner handles: drag to move, double-click to remove; midpoints add a corner
    if (edit.mode !== 'circle' || edit.pts.length > 2) {
      ll.forEach((p, i) => {
        const h = L.marker(p, { draggable: true, zIndexOffset: 1000, icon: L.divIcon({ className: 'fm-handle', iconSize: [12, 12] }) }).addTo(g)
        h.on('dragend', (e) => { const q = e.target.getLatLng(); setEdit((ed) => ({ ...ed, pts: ed.pts.map((pp, j) => (j === i ? [q.lng, q.lat] : pp)) })) })
        h.on('dblclick', (e) => { L.DomEvent.stopPropagation(e); setEdit((ed) => ({ ...ed, pts: ed.pts.filter((_, j) => j !== i) })) })
      })
      if (ll.length >= 3) {
        ll.forEach((p, i) => {
          const q = ll[(i + 1) % ll.length]
          // only where the side is long enough on screen to grab a dot without hitting a corner
          if (map.latLngToLayerPoint(p).distanceTo(map.latLngToLayerPoint(q)) < 28) return
          const mid = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2]
          const h = L.marker(mid, { zIndexOffset: -100, icon: L.divIcon({ className: 'fm-handle mid', iconSize: [10, 10] }) }).addTo(g)
          h.on('click', (e) => { L.DomEvent.stopPropagation(e); setEdit((ed) => { const pts = [...ed.pts]; pts.splice(i + 1, 0, [mid[1], mid[0]]); return { ...ed, pts } }) })
        })
      }
    }
    st.current.onMapClick = (e) => {
      const pt = [e.latlng.lng, e.latlng.lat]
      setEdit((ed) => {
        if (!ed) return ed
        if (ed.mode === 'circle') return ed.pts.length === 0 ? { ...ed, pts: [pt] } : ed.pts.length === 1 ? { ...ed, mode: 'edit', pts: circleRing(ed.pts[0], pt) } : ed
        if (ed.mode === 'draw') return { ...ed, pts: [...ed.pts, pt] }
        return ed
      })
    }
  }, [ready, edit]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fm-map" ref={box}>
      {!ready && <div className="fm-loading">{loadErr || 'Loading map…'}</div>}
    </div>
  )
}
const POINT_COLOR = { Cellar: '#C17A3B', 'Beet dump': '#097138', Shop: '#5B5F66', Fuel: '#D23B3B', Housing: '#2A6FD6', Office: '#7B4FC9', 'Jug drop': '#0F8C8C', Transload: '#E8801A', Pump: '#185FA5', Other: '#333' }

function EditBar({ edit, setEdit, farms, onSave }) {
  const isNew = !edit.id
  const hint = edit.mode === 'circle'
    ? (edit.pts.length === 0 ? 'Click the pivot point.' : 'Click the edge of the circle.')
    : edit.mode === 'draw' ? 'Click each corner. Drag a corner to move it, double-click to remove it.'
      : 'Drag corners to move them. Click a small dot to add a corner, double-click a corner to remove it.'
  const acres = edit.pts.length >= 3 ? shapeAcres([{ pts: edit.pts }]) : 0
  return (
    <div className="fm-editbar">
      <div><strong>{isNew ? 'New field' : 'Editing boundary'}</strong> · {hint}{acres ? ` · ${acres} ac` : ''}</div>
      {isNew && (
        <div className="fm-row">
          <input className="yields-cell-input" style={{ width: 150, textAlign: 'left' }} placeholder="Field name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          <input className="yields-cell-input" style={{ width: 130, textAlign: 'left' }} list="fm-farms" placeholder="Farm" value={edit.farm} onChange={(e) => setEdit({ ...edit, farm: e.target.value })} />
          <datalist id="fm-farms">{farms.map((f) => <option key={f} value={f} />)}</datalist>
        </div>
      )}
      <div className="fm-row">
        <button className="save" disabled={edit.pts.length < 3 || (isNew && !edit.name.trim())} onClick={() => onSave(edit.pts)}>Save</button>
        {edit.mode === 'draw' && edit.pts.length > 0 && <button onClick={() => setEdit({ ...edit, pts: edit.pts.slice(0, -1) })}>Undo corner</button>}
        <button onClick={() => setEdit(null)}>Cancel</button>
      </div>
    </div>
  )
}

function FieldCard({ f, year, agCrop, agSeasonName, canEdit, farms, planByKey, onClose, onSave, onEditShape }) {
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState(null)
  const years = []
  for (let y = year - 6; y <= year; y++) years.push(y)
  const cur = cropFor(f, year)
  const p = f.plan || {}
  const lp = lastPotatoYear(f, year)
  const off = p.acres && f.acres ? Math.abs(f.acres - p.acres) / p.acres : 0
  const agC = agCrop ? canonCrop(agCrop.cropName) : null
  const recs = [...(f.yieldRecs || [])].sort((a, b) => b.year - a.year).slice(0, 6)
  const row = (k, v) => (v == null || v === '' ? null : <Fragment key={k}><dt>{k}</dt><dd>{String(v)}</dd></Fragment>)
  const planOptions = Object.values(planByKey).sort((a, b) => a.field.localeCompare(b.field, undefined, { numeric: true }))
  return (
    <div className="fm-card">
      <button className="fm-x" onClick={onClose} aria-label="Close">×</button>
      <div className="fm-card-name">{f.name}</div>
      <div className="contracts-sub" style={{ marginTop: 0 }}>{[f.farm, p.entity, f.kind === 'other' ? 'Other area' : null].filter(Boolean).join(' · ')}{f.plan && f.planHow !== 'name' ? ` · plan row “${p.field}”${f.planHow === 'part' ? ' (by name)' : ''}` : ''}</div>
      {f.kind !== 'other' && (
        <div className="fm-hist">
          {years.map((y) => {
            const c = cropFor(f, y)
            return <div key={y} className={y === year ? 'on' : ''} title={`${y}: ${cropLabel(c.crop)}${c.src ? ` (${c.src})` : ''}`}><i style={{ background: c.crop ? cropColor(c.crop) : 'var(--fm-none)' }} />{String(y).slice(2)}<br />{c.crop ? cropLabel(c.crop).slice(0, 6) : '—'}</div>
          })}
        </div>
      )}
      <dl className="fm-dl">
        {row(`${year} crop`, cur.crop ? `${cropLabel(cur.crop)}${cur.src && cur.src !== 'plan' ? ` (${cur.src})` : ''}` : null)}
        {agC && row(`Agworld ${agSeasonName}`, `${cropLabel(agC)}${agCrop.varietyName ? ` · ${agCrop.varietyName}` : ''}${cur.crop && agC !== cur.crop ? ' ⚠' : ''}`)}
        {row('Plan acres', p.acres)}
        {row('Map acres', f.acres)}
        {row('Variety', [p.variety, p.subVariety].filter(Boolean).join(' / ') || null)}
        {row('Buyer', [p.buyer, p.delivery, p.cellar].filter(Boolean).join(' · ') || null)}
        {row('Last potatoes', lp)}
        {Object.entries(p.potatoEligible || {}).map(([y, v]) => row(`${y} potato eligible`, v))}
        {row('Organic / conv.', p.organic)}
        {row('Soil', p.soil)}
        {row('Plantback', p.plantback)}
        {row('Pest / weed issues', p.pests)}
        {row('Row direction', p.rowDirection)}
        {row('Notes', f.notes)}
      </dl>
      {f.kind !== 'other' && !f.plan && <div className="fm-note">Not linked to a Main Field Plan row. {canEdit ? 'Link it below, or mark it as an other area (CREP, canal…).' : ''}</div>}
      {off > 0.1 && <div className="fm-note">Map outline is {f.acres} ac vs {p.acres} ac in the plan — check the boundary.</div>}
      {f.kind !== 'other' && !f.ag && <div className="contracts-sub">No Agworld field with this name.</div>}
      {recs.length > 0 && (
        <>
          <div className="fm-lab" style={{ marginTop: 10 }}>Yield history</div>
          <table className="fm-yields"><tbody>
            {recs.map((r, i) => <tr key={i}><td>{r.year}</td><td>{cropLabel(canonCrop(r.crop))}</td><td>{r.variety || ''}</td><td className="num">{r.yield ? `${Math.round(r.yield)} ${r.unit || ''}/ac` : '—'}</td></tr>)}
          </tbody></table>
        </>
      )}
      {canEdit && !editing && (
        <div className="fm-row" style={{ marginTop: 10 }}>
          <button onClick={onEditShape}>Edit boundary</button>
          <button onClick={() => { setEditing(true); setForm({ name: f.name, farm: f.farm || '', kind: f.kind || 'field', planKey: f.planKey || '', notes: f.notes || '' }) }}>Edit details</button>
        </div>
      )}
      {canEdit && editing && form && (
        <div className="fm-form">
          <label className="hd-field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label className="hd-field"><span>Farm</span><input list="fm-farms2" value={form.farm} onChange={(e) => setForm({ ...form, farm: e.target.value })} /></label>
          <datalist id="fm-farms2">{farms.map((x) => <option key={x} value={x} />)}</datalist>
          <label className="hd-field"><span>Type</span>
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="field">Farmed field</option><option value="other">Other area (CREP, canal, dry corner…)</option></select>
          </label>
          <label className="hd-field"><span>Main Field Plan row</span>
            <select value={form.planKey} onChange={(e) => setForm({ ...form, planKey: e.target.value })}>
              <option value="">Match by name{f.plan && !f.planKey ? ` (now: ${p.field})` : ''}</option>
              {planOptions.map((r) => <option key={r.key} value={r.key}>{r.field} — {r.farm}</option>)}
            </select>
          </label>
          <label className="hd-field"><span>Notes</span><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          <div className="fm-row">
            <button className="save" onClick={() => { onSave({ name: form.name.trim(), key: mapKey(form.name), farm: form.farm.trim(), kind: form.kind, kindSet: true, planKey: form.planKey || null, notes: form.notes.trim() || null }); setEditing(false) }}>Save</button>
            <button onClick={() => setEditing(false)}>Cancel</button>
            <button style={{ marginLeft: 'auto', color: '#A32D2D' }} onClick={() => { if (window.confirm(`Remove ${f.name} from the map?`)) onSave({ archived: true }) }}>Remove</button>
          </div>
        </div>
      )}
    </div>
  )
}

