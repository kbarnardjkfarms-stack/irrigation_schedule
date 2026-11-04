import { useMemo, useState } from 'react'
import { doc, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { cropFor, cropLabel, cropsFromDesc, isOtherArea, kmzToKml, mapKey, packRing, parseKml, parseMainPlan, shapeAcres } from './mapMath.js'

// Farm Map: the Fields & links table and the Import tab (Google farm map
// KML/KMZ, Main Field Plan workbook).

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)

async function commitAll(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const b = writeBatch(db)
    ops.slice(i, i + 400).forEach(([kind, ref, data, opt]) => (kind === 'del' ? b.delete(ref) : b.set(ref, data, opt || {})))
    await b.commit()
  }
}
const stripHtml = (s) => String(s || '').replace(/<[^>]+>/g, ' ').replace(/ /g, ' ').replace(/[ \t]+/g, ' ').trim().slice(0, 1500)

// ---------------------------------------------------------------------------
export function FieldsTable({ fields, planByKey, canEdit, onSave, onOpen, year }) {
  const [filter, setFilter] = useState('attention')
  const [q, setQ] = useState('')
  const planOptions = useMemo(() => Object.values(planByKey).sort((a, b) => a.field.localeCompare(b.field, undefined, { numeric: true })), [planByKey])
  const usedPlan = new Set(fields.filter((f) => f.plan).map((f) => f.plan.key))
  const orphanPlan = planOptions.filter((r) => !usedPlan.has(r.key))
  const issues = (f) => {
    const out = []
    if (f.kind === 'other') return out
    if (!f.plan) out.push('no plan row')
    else if (f.plan.acres && f.acres && Math.abs(f.acres - f.plan.acres) / f.plan.acres > 0.1) out.push('acres differ')
    if (!f.ag) out.push('no Agworld match')
    return out
  }
  const rows = fields
    .filter((f) => filter === 'all' || (filter === 'other' ? f.kind === 'other' : filter === 'attention' ? issues(f).length > 0 : f.kind !== 'other'))
    .filter((f) => !q || `${f.name} ${f.farm} ${f.plan ? f.plan.field : ''}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (a.farm || '').localeCompare(b.farm || '') || a.name.localeCompare(b.name, undefined, { numeric: true }))
  return (
    <>
      <div className="yields-card">
        <div className="yields-card-head">
          <div>
            <div className="yields-card-title">Fields &amp; links</div>
            <div className="contracts-sub">Every outline on the map, the Main Field Plan row it uses, and the Agworld field with the same name. Fix links here; click a name to see it on the map.</div>
          </div>
          <div className="agronomy-filter-bar" style={{ margin: 0 }}>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="attention">Needs attention</option><option value="fields">Farmed fields</option><option value="other">Other areas</option><option value="all">Everything</option>
            </select>
            <input className="agronomy-search-input" style={{ minWidth: 150 }} placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="table-scroll" style={{ maxHeight: 620 }}>
          <table className="contracts-table contracts-table-auto">
            <thead><tr><th>Field</th><th>Farm</th><th>Type</th><th className="num">Map ac</th><th>Plan row</th><th className="num">Plan ac</th><th>{year} crop</th><th>Agworld</th><th>Check</th></tr></thead>
            <tbody>
              {rows.map((f) => (
                <tr key={f.id}>
                  <td><button className="link-btn" onClick={() => onOpen(f.id)}>{f.name}</button></td>
                  <td>{f.farm}</td>
                  <td>{canEdit
                    ? <select value={f.kind || 'field'} onChange={(e) => onSave(f.id, { kind: e.target.value, kindSet: true })}><option value="field">Field</option><option value="other">Other</option></select>
                    : f.kind === 'other' ? 'Other' : 'Field'}</td>
                  <td className="num">{f.acres}</td>
                  <td>{f.kind === 'other' ? '' : canEdit
                    ? <select value={f.planKey || ''} onChange={(e) => onSave(f.id, { planKey: e.target.value || null })} style={{ maxWidth: 180 }}>
                      <option value="">{f.plan && !f.planKey ? `${f.plan.field} (by name)` : '— none —'}</option>
                      {planOptions.map((r) => <option key={r.key} value={r.key}>{r.field} — {r.farm}</option>)}
                    </select>
                    : f.plan ? f.plan.field : '—'}</td>
                  <td className="num">{f.plan ? f.plan.acres : ''}</td>
                  <td>{f.kind === 'other' ? '' : cropLabel(cropFor(f, year).crop)}</td>
                  <td>{f.ag ? f.ag.name : <span className="contracts-sub">—</span>}</td>
                  <td>{issues(f).map((x) => <span key={x} className="hb-tag warn" style={{ marginRight: 3 }}>{x}</span>)}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="contracts-sub">Nothing here.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
      {orphanPlan.length > 0 && (
        <div className="yields-card">
          <div className="yields-card-title">Plan rows with no outline on the map ({orphanPlan.length})</div>
          <div className="contracts-sub">Draw them on the Map (“+ Field by corners” / “+ Pivot circle”) or link an existing outline to them above.</div>
          <div className="fm-chips">{orphanPlan.map((r) => <span key={r.key} className="yields-chip" style={{ paddingRight: 10 }}>{r.field} <span className="contracts-sub" style={{ margin: 0 }}>{r.farm} · {r.acres || '?'} ac</span></span>)}</div>
        </div>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------
export function MapImport({ rawFields, points, planRows, run }) {
  return (
    <div className="harvest-two">
      <KmlImport rawFields={rawFields} points={points} run={run} />
      <PlanImport planRows={planRows} run={run} />
    </div>
  )
}

function KmlImport({ rawFields, points, run }) {
  const [parsed, setParsed] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  const [overwriteEdited, setOverwriteEdited] = useState(false)
  const [removeMissing, setRemoveMissing] = useState(false)

  async function onFile(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    setErr(null); setParsed(null)
    try {
      const buf = await file.arrayBuffer()
      const text = /\.kmz$/i.test(file.name) ? await kmzToKml(buf) : new TextDecoder().decode(buf)
      const r = parseKml(text)
      // stable ids: farm + name (+ count for repeats like CREP)
      const n = {}
      r.fields.forEach((f) => { const base = `${mapKey(f.farm)}__${mapKey(f.name) || 'UNNAMED'}`; n[base] = (n[base] || 0) + 1; f.id = `${base}__${n[base]}` })
      const np = {}
      r.points.forEach((p) => { const base = `${mapKey(p.farm)}__${mapKey(p.name) || 'POINT'}`; np[base] = (np[base] || 0) + 1; p.id = `${base}__${np[base]}` })
      setParsed({ ...r, fileName: file.name })
    } catch (ex) { setErr(ex.message || String(ex)) }
  }
  const byId = useMemo(() => Object.fromEntries(rawFields.map((f) => [f.id, f])), [rawFields])
  const stats = parsed ? {
    added: parsed.fields.filter((f) => !byId[f.id]).length,
    updated: parsed.fields.filter((f) => byId[f.id] && (overwriteEdited || !['edited', 'drawn'].includes(byId[f.id].source))).length,
    keptEdited: parsed.fields.filter((f) => byId[f.id] && !overwriteEdited && ['edited', 'drawn'].includes(byId[f.id].source)).length,
    missing: rawFields.filter((f) => !f.archived && f.source === 'kml' && !parsed.fields.some((x) => x.id === f.id)),
    farms: [...new Set(parsed.fields.map((f) => f.farm))],
    other: parsed.fields.filter((f) => isOtherArea(f.name)).length
  } : null

  function doImport() {
    setBusy(true)
    const ops = []
    parsed.fields.forEach((f) => {
      const old = byId[f.id]
      if (old && !overwriteEdited && ['edited', 'drawn'].includes(old.source)) return
      const data = {
        name: f.name, key: mapKey(f.name), farm: f.farm, rings: f.rings.map((r) => packRing(r.pts, r.hole)), acres: shapeAcres(f.rings),
        desc: stripHtml(f.desc) || null, descCrops: cropsFromDesc(f.desc), source: 'kml', archived: false, importedFrom: parsed.fileName, updatedBy: who(), updatedAt: Date.now()
      }
      if (!old || !old.kindSet) data.kind = isOtherArea(f.name) ? 'other' : 'field'
      ops.push(['set', doc(db, 'farmFields', f.id), data, { merge: true }])
    })
    if (removeMissing) stats.missing.forEach((f) => ops.push(['set', doc(db, 'farmFields', f.id), { archived: true, updatedBy: who(), updatedAt: Date.now() }, { merge: true }]))
    const keep = new Set(parsed.points.map((p) => p.id))
    parsed.points.forEach((p) => ops.push(['set', doc(db, 'farmPoints', p.id), { name: p.name, farm: p.farm, lat: p.lat, lng: p.lng, type: p.type, updatedAt: Date.now() }]))
    points.filter((p) => !keep.has(p.id)).forEach((p) => ops.push(['del', doc(db, 'farmPoints', p.id)]))
    run(async () => { await commitAll(ops); setParsed(null) }, `Map imported: ${stats.added} new, ${stats.updated} updated outlines, ${parsed.points.length} points.`)
    setBusy(false)
  }
  return (
    <div className="yields-card">
      <div className="yields-card-title">1 · Farm map (KML / KMZ)</div>
      <div className="contracts-sub">From Google My Maps: ⋮ → Export to KML/KMZ (whole map). Each folder becomes a farm, each shape a field, each pin a point (cellars, shops, beet dumps…). Re-importing updates outlines and keeps your links and notes.</div>
      <input type="file" accept=".kml,.kmz" onChange={onFile} style={{ marginTop: 10 }} />
      {err && <div className="agronomy-error-banner" style={{ marginTop: 8 }}>{err}</div>}
      {parsed && stats && (
        <>
          <div className="harvest-import-sum">
            <span><strong>{parsed.fields.length}</strong> shapes</span><span><strong>{stats.farms.length}</strong> farms</span>
            <span><strong>{parsed.points.length}</strong> points</span><span><strong>{stats.added}</strong> new</span><span><strong>{stats.updated}</strong> updated</span>
            {stats.other > 0 && <span><strong>{stats.other}</strong> look like CREP / canal / dry areas</span>}
          </div>
          <div className="contracts-sub" style={{ marginTop: 0 }}>Farms: {stats.farms.join(', ')}</div>
          {stats.keptEdited > 0 && <label className="hb-check" style={{ marginTop: 6 }}><input type="checkbox" checked={overwriteEdited} onChange={(e) => setOverwriteEdited(e.target.checked)} /> Also replace {stats.keptEdited} boundar{stats.keptEdited === 1 ? 'y' : 'ies'} edited in AIO</label>}
          {stats.missing.length > 0 && <label className="hb-check" style={{ marginTop: 6 }}><input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} /> Remove {stats.missing.length} field{stats.missing.length === 1 ? '' : 's'} that aren’t in this file ({stats.missing.slice(0, 5).map((f) => f.name).join(', ')}{stats.missing.length > 5 ? '…' : ''})</label>}
          <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
            <button className="save" disabled={busy} onClick={doImport}>Import map</button>
            <button onClick={() => setParsed(null)}>Cancel</button>
          </div>
        </>
      )}
      <div className="contracts-sub" style={{ marginTop: 10 }}>On the map now: {rawFields.filter((f) => !f.archived).length} shapes, {points.length} points.</div>
    </div>
  )
}

function PlanImport({ planRows, run }) {
  const [parsed, setParsed] = useState(null)
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  async function onFile(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    setErr(null); setParsed(null)
    try {
      const XLSX = await import('xlsx')
      const buf = await file.arrayBuffer()
      const names = XLSX.read(buf, { type: 'array', bookSheets: true }).SheetNames
      const sheet = names.find((n) => /^main$/i.test(n)) || names[0]
      const wb = XLSX.read(buf, { type: 'array', sheets: [sheet] })
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: null })
      setParsed({ ...parseMainPlan(rows), fileName: file.name, sheet })
    } catch (ex) { setErr(ex.message || String(ex)) }
  }
  const crops = parsed ? parsed.rows.reduce((m, r) => { const c = r.crops[parsed.planYear]; if (c) m[c] = (m[c] || 0) + (r.acres || 0); return m }, {}) : {}
  function doImport() {
    setBusy(true)
    const ops = []
    const keep = new Set()
    parsed.rows.forEach((r) => {
      const id = `${parsed.planYear}__${r.key}`
      keep.add(id)
      const clean = Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined))
      ops.push(['set', doc(db, 'fieldPlanRows', id), { ...clean, importedFrom: parsed.fileName, importedBy: who(), importedAt: Date.now() }])
    })
    planRows.filter((r) => r.planYear === parsed.planYear && !keep.has(r.id)).forEach((r) => ops.push(['del', doc(db, 'fieldPlanRows', r.id)]))
    run(async () => { await commitAll(ops); setParsed(null) }, `${parsed.planYear} plan imported: ${parsed.rows.length} fields.`)
    setBusy(false)
  }
  const years = [...new Set(planRows.map((r) => r.planYear))].sort()
  return (
    <div className="yields-card">
      <div className="yields-card-title">2 · Main Field Plan (.xlsm / .xlsx)</div>
      <div className="contracts-sub">Reads the <strong>Main</strong> sheet: field, farm, entity, acres, every “YYYY Crop” column and the basic plan data (variety, buyer, soil, last potatoes, eligibility…). The map colours from it. Re-import any time the plan changes.</div>
      <input type="file" accept=".xlsx,.xlsm,.xls" onChange={onFile} style={{ marginTop: 10 }} />
      {err && <div className="agronomy-error-banner" style={{ marginTop: 8 }}>{err}</div>}
      {parsed && (
        <>
          <div className="harvest-import-sum">
            <span><strong>{parsed.planYear}</strong> plan</span><span><strong>{parsed.rows.length}</strong> fields</span>
            <span>crop years {parsed.years[0]}–{parsed.years[parsed.years.length - 1]}</span>
          </div>
          <div className="contracts-sub" style={{ marginTop: 0 }}>{parsed.planYear}: {Object.entries(crops).sort((a, b) => b[1] - a[1]).map(([c, a]) => `${cropLabel(c)} ${Math.round(a).toLocaleString()} ac`).join(' · ')}</div>
          {years.includes(parsed.planYear) && <div className="contracts-sub">This replaces the {parsed.planYear} plan already in AIO.</div>}
          <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>
            <button className="save" disabled={busy} onClick={doImport}>Import plan</button>
            <button onClick={() => setParsed(null)}>Cancel</button>
          </div>
        </>
      )}
      <div className="contracts-sub" style={{ marginTop: 10 }}>{years.length ? `Plans in AIO: ${years.join(', ')} (${planRows.length} rows)` : 'No plan imported yet.'}</div>
    </div>
  )
}

