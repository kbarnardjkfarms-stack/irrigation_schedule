import { useMemo, useState } from 'react'
import { fmtAc, fmtDate, fmtSlot, recipeJobs } from './groundMath.js'

// Ground work: the Fields & passes table (build passes from the crop
// recipes, add or drop a pass on one field) and Setup (start date, days off,
// equipment and machines with their target acres/day, crop recipes).

const uid = (p) => `${p}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || uid('x')
const cropLabel = (c) => (c ? c.charAt(0) + c.slice(1).toLowerCase() : 'No crop')

// ---------------------------------------------------------------------------
export function GroundJobs({ fields, jobs, settings, sweepNo, g, canEdit, api, seasonId }) {
  const [q, setQ] = useState('')
  const [crop, setCrop] = useState('recipe')
  const cats = settings.categories || []
  const real = jobs.filter((j) => j.kind !== 'block')
  const byField = useMemo(() => {
    const m = {}
    real.forEach((j) => { (m[j.fieldId] = m[j.fieldId] || {})[j.catId] = j })
    return m
  }, [real])
  const unitName = Object.fromEntries(cats.flatMap((c) => c.units.map((u) => [u.id, u.name])))
  const plan = useMemo(() => recipeJobs({ seasonId, fields, recipes: settings.recipes || {}, existing: real }), [seasonId, fields, settings.recipes, real])
  const crops = [...new Set(fields.map((f) => f.crop || ''))].sort()
  const rows = fields
    .filter((f) => crop === 'all' || (crop === 'recipe' ? (settings.recipes[f.crop] || []).length > 0 || byField[f.id] : (f.crop || '') === crop))
    .filter((f) => !q || `${f.name} ${f.farmName || ''} ${sweepNo[f.id]}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => (sweepNo[a.id] || 1e9) - (sweepNo[b.id] || 1e9))
  function build() {
    if (!plan.add.length) return
    api.run(api.batchWrite(plan.add.map((j) => ['set', j.id, { ...j, createdAt: Date.now() }])), `${plan.add.length} pass${plan.add.length === 1 ? '' : 'es'} added from the recipes. Assign them to machines on the Schedule tab.`)
  }
  function dropStale() {
    if (!window.confirm(`Remove ${plan.stale.length} pass${plan.stale.length === 1 ? '' : 'es'} that no recipe calls for any more (crop changed in Agworld, or the recipe changed)? None of them have work logged.`)) return
    api.run(api.batchWrite(plan.stale.map((j) => ['del', j.id])), `${plan.stale.length} removed.`)
  }
  function addPass(f, c) {
    const recipe = settings.recipes[f.crop] || []
    const idx = recipe.indexOf(c.id)
    const mine = Object.values(byField[f.id] || {})
    const step = idx >= 0 ? idx : Math.max(-1, ...mine.map((j) => j.step ?? 0)) + 1
    api.addJob({ id: `${seasonId}__${f.id}__${c.id}`, kind: 'job', fieldId: f.id, fieldName: f.name, farmName: f.farmName || null, crop: f.crop, acres: f.acres, catId: c.id, step, unitId: null, order: null, doneAcres: 0, done: false, manual: true }, `${c.name} added to ${f.name}.`)
  }
  const totals = Object.fromEntries(cats.map((c) => [c.id, real.filter((j) => j.catId === c.id).reduce((s, j) => s + (g ? g.acresOf(j) : Number(j.acres) || 0), 0)]))
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Fields &amp; passes</div>
          <div className="contracts-sub">Every field this season from Agworld, numbered along the southwest → northeast sweep (#1 is the most south-western). Each crop’s recipe (Setup) decides its passes; add or drop a pass on one field here.</div>
        </div>
        <div className="agronomy-filter-bar" style={{ margin: 0 }}>
          <select value={crop} onChange={(e) => setCrop(e.target.value)}>
            <option value="recipe">Crops with a recipe</option><option value="all">All fields</option>
            {crops.map((c) => <option key={c} value={c}>{cropLabel(c)}</option>)}
          </select>
          <input className="agronomy-search-input" style={{ minWidth: 140 }} placeholder="Field, farm, #…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      {canEdit && (
        <div className="agronomy-filter-bar">
          <button className="save" disabled={!plan.add.length} onClick={build}>{plan.add.length ? `Build ${plan.add.length} pass${plan.add.length === 1 ? '' : 'es'} from recipes` : 'All recipe passes are built'}</button>
          {plan.stale.length > 0 && <button onClick={dropStale}>Remove {plan.stale.length} no longer in a recipe</button>}
          {fields.some((f) => !f.pos) && <span className="contracts-sub" style={{ marginTop: 0 }}>{fields.filter((f) => !f.pos).length} field{fields.filter((f) => !f.pos).length === 1 ? ' has' : 's have'} no outline, so {fields.filter((f) => !f.pos).length === 1 ? 'it’s' : 'they’re'} numbered last.</span>}
        </div>
      )}
      <div className="table-scroll" style={{ maxHeight: 640 }}>
        <table className="contracts-table contracts-table-auto gw-jobs">
          <thead><tr><th className="num">#</th><th>Field</th><th>Farm</th><th>Crop</th><th className="num">Acres</th>{cats.map((c) => <th key={c.id} style={{ '--c': c.color }}><i className="gw-dot" />{c.name}</th>)}</tr></thead>
          <tbody>
            {rows.map((f) => (
              <tr key={f.id}>
                <td className="num">{sweepNo[f.id] || ''}</td><td><strong>{f.name}</strong></td><td>{f.farmName || ''}</td><td>{cropLabel(f.crop)}</td><td className="num">{fmtAc(f.acres)}</td>
                {cats.map((c) => {
                  const j = (byField[f.id] || {})[c.id]
                  if (!j) return <td key={c.id}>{canEdit && <button className="gw-add" title={`Add a ${c.name} pass to ${f.name}`} onClick={() => addPass(f, c)}>+</button>}</td>
                  const r = g ? g.res[j.id] : null
                  const pct = j.done ? 1 : (Number(j.doneAcres) || 0) / (g ? g.acresOf(j) || 1 : 1)
                  return (
                    <td key={c.id}>
                      <span className={`gw-chip${j.done ? ' done' : !j.unitId ? ' open' : ''}`} style={{ '--c': c.color }} title={r && r.start != null && !r.done && g ? `${fmtSlot(settings.startDate, r.start, true)} → ${fmtSlot(settings.startDate, r.end)}` : ''}>
                        {j.done ? '✓ done' : j.unitId ? `${unitName[j.unitId] || '?'}${pct > 0 ? ` · ${Math.round(pct * 100)}%` : ''}` : 'not assigned'}
                      </span>
                      {canEdit && !j.done && !(j.doneAcres > 0) && <button className="csp-x" title="Drop this pass" onClick={() => { if (window.confirm(`Drop the ${c.name} pass on ${f.name}?`)) api.deleteJob(j.id, 'Pass dropped.') }}>×</button>}
                    </td>
                  )
                })}
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5 + cats.length} className="contracts-sub">No fields match. {crop === 'recipe' ? 'Add crop recipes on Setup.' : ''}</td></tr>}
          </tbody>
          {rows.length > 0 && <tfoot><tr><td /><td colSpan={3}><strong>{rows.length} fields</strong></td><td className="num"><strong>{fmtAc(rows.reduce((s, f) => s + f.acres, 0))}</strong></td>{cats.map((c) => <td key={c.id}><strong>{fmtAc(totals[c.id])} ac</strong></td>)}</tr></tfoot>}
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
export function GroundSetup({ settings, fields, saveSettings }) {
  const [d, setD] = useState(() => JSON.parse(JSON.stringify({
    startDate: settings.startDate || '', sundaysOff: !!settings.sundaysOff, daysOff: settings.daysOff || [], gapDays: settings.gapDays ?? 0,
    sweepAngle: settings.sweepAngle ?? 45, categories: settings.categories || [], recipes: settings.recipes || {}
  })))
  const [newOff, setNewOff] = useState('')
  const dirty = JSON.stringify(d) !== JSON.stringify({
    startDate: settings.startDate || '', sundaysOff: !!settings.sundaysOff, daysOff: settings.daysOff || [], gapDays: settings.gapDays ?? 0,
    sweepAngle: settings.sweepAngle ?? 45, categories: settings.categories || [], recipes: settings.recipes || {}
  })
  const set = (patch) => setD((x) => ({ ...x, ...patch }))
  const setCat = (i, patch) => set({ categories: d.categories.map((c, j) => (j === i ? { ...c, ...patch } : c)) })
  const setUnit = (i, k, patch) => setCat(i, { units: d.categories[i].units.map((u, j) => (j === k ? { ...u, ...patch } : u)) })
  const crops = [...new Set([...fields.map((f) => f.crop).filter(Boolean), ...Object.keys(d.recipes)])].sort()
  const acresByCrop = {}
  fields.forEach((f) => { if (f.crop) acresByCrop[f.crop] = (acresByCrop[f.crop] || 0) + f.acres })
  function save() {
    const cats = d.categories.map((c) => ({ ...c, rate: Number(c.rate) || 0, startDate: c.startDate || null, units: c.units.map((u) => ({ ...u, rate: Number(u.rate) > 0 ? Number(u.rate) : null })) }))
    saveSettings({ startDate: d.startDate || null, sundaysOff: d.sundaysOff, daysOff: [...d.daysOff].sort(), gapDays: Number(d.gapDays) || 0, sweepAngle: Number(d.sweepAngle) || 0, categories: cats, recipes: d.recipes }, 'Setup saved.')
  }
  return (
    <>
      <div className="yields-card">
        <div className="yields-card-head">
          <div><div className="yields-card-title">Schedule</div><div className="contracts-sub">The schedule runs in half days (AM / PM) from the start date.</div></div>
          <div className="agronomy-filter-bar" style={{ margin: 0 }}>{dirty && <span className="hb-tag warn">Not saved</span>}<button className="save" disabled={!dirty} onClick={save}>Save setup</button></div>
        </div>
        <div className="hd-grid">
          <label className="hd-field"><span>Start date</span><input type="date" value={d.startDate} onChange={(e) => set({ startDate: e.target.value })} /></label>
          <label className="hd-field"><span>Days between passes on a field</span><input inputMode="decimal" value={d.gapDays} onChange={(e) => set({ gapDays: e.target.value })} /></label>
          <label className="hd-field"><span>Field order</span>
            <select value={String(d.sweepAngle)} onChange={(e) => set({ sweepAngle: Number(e.target.value) })}>
              <option value="45">Southwest → northeast</option><option value="0">West → east</option><option value="90">South → north</option><option value="-45">Northwest → southeast</option>
            </select>
          </label>
          <label className="hd-field" style={{ justifyContent: 'flex-end' }}><span><input type="checkbox" checked={d.sundaysOff} onChange={(e) => set({ sundaysOff: e.target.checked })} /> Sundays off</span></label>
        </div>
        <div className="fm-lab" style={{ marginTop: 10 }}>Days off (whole crew)</div>
        <div className="fm-chips">
          {d.daysOff.map((x) => <span key={x} className="yields-chip">{fmtDate(x, true)} <button className="csp-x" onClick={() => set({ daysOff: d.daysOff.filter((y) => y !== x) })}>×</button></span>)}
          <input type="date" value={newOff} onChange={(e) => setNewOff(e.target.value)} />
          <button disabled={!newOff || d.daysOff.includes(newOff)} onClick={() => { set({ daysOff: [...d.daysOff, newOff] }); setNewOff('') }}>Add</button>
        </div>
      </div>

      <div className="yields-card">
        <div className="yields-card-title">Equipment</div>
        <div className="contracts-sub">Each kind of equipment, its target acres per day per machine, and when its pace starts counting (blank = the schedule start — later passes usually start a few days in). A machine can have its own acres/day.</div>
        <div className="gw-cats">
          {d.categories.map((c, i) => (
            <div key={c.id} className="gw-cat" style={{ '--c': c.color }}>
              <div className="gw-cat-head">
                <input type="color" value={c.color} onChange={(e) => setCat(i, { color: e.target.value })} title="Colour" />
                <input className="gw-cat-name" value={c.name} onChange={(e) => setCat(i, { name: e.target.value })} />
                <button className="csp-x" title="Remove this equipment" onClick={() => { if (window.confirm(`Remove ${c.name}? Its passes stay but won’t show until it’s added back.`)) set({ categories: d.categories.filter((_, j) => j !== i) }) }}>×</button>
              </div>
              <div className="hd-grid">
                <label className="hd-field"><span>Target ac/day per machine</span><input inputMode="decimal" value={c.rate} onChange={(e) => setCat(i, { rate: e.target.value })} /></label>
                <label className="hd-field"><span>Pace starts</span><input type="date" value={c.startDate || ''} onChange={(e) => setCat(i, { startDate: e.target.value })} /></label>
              </div>
              <div className="gw-units">
                {c.units.map((u, k) => (
                  <div key={u.id} className="gw-unit">
                    <input value={u.name} onChange={(e) => setUnit(i, k, { name: e.target.value })} />
                    <input className="yields-cell-input" inputMode="decimal" placeholder={String(c.rate || '')} value={u.rate ?? ''} onChange={(e) => setUnit(i, k, { rate: e.target.value })} title="This machine's own ac/day (blank = the equipment's)" />
                    <span className="contracts-sub">ac/day</span>
                    <button className="csp-x" onClick={() => setCat(i, { units: c.units.filter((_, j) => j !== k) })} title="Remove this machine">×</button>
                  </div>
                ))}
                <button className="clear-sort-btn" onClick={() => setCat(i, { units: [...c.units, { id: uid(c.id), name: `${c.name} ${c.units.length + 1}` }] })}>+ Machine</button>
              </div>
            </div>
          ))}
          <button className="gw-cat gw-cat-new" onClick={() => { const name = 'New equipment'; set({ categories: [...d.categories, { id: `${slug(name)}-${Date.now().toString(36)}`, name, color: '#5B5F66', rate: 100, units: [{ id: uid('m'), name: `${name} 1` }] }] }) }}>+ Equipment</button>
        </div>
      </div>

      <div className="yields-card">
        <div className="yields-card-title">Crop recipes</div>
        <div className="contracts-sub">The passes each crop gets, in order. A pass waits for the one before it on the same field. Crops come from this season’s fields in Agworld.</div>
        <table className="contracts-table contracts-table-auto" style={{ marginTop: 8 }}>
          <tbody>
            {crops.map((crop) => {
              const steps = d.recipes[crop] || []
              const setSteps = (s) => set({ recipes: { ...d.recipes, [crop]: s } })
              return (
                <tr key={crop}>
                  <td style={{ whiteSpace: 'nowrap' }}><strong>{cropLabel(crop)}</strong><div className="contracts-sub" style={{ marginTop: 0 }}>{acresByCrop[crop] ? `${fmtAc(acresByCrop[crop])} ac` : 'no fields'}</div></td>
                  <td>
                    <div className="gw-recipe">
                      {steps.map((cid, k) => { const c = d.categories.find((x) => x.id === cid); return (
                        <span key={k} className="gw-step" style={{ '--c': c ? c.color : '#999' }}>
                          <b>{k + 1}</b>{c ? c.name : `(${cid})`}
                          <button disabled={k === 0} onClick={() => { const s = [...steps]; [s[k - 1], s[k]] = [s[k], s[k - 1]]; setSteps(s) }} title="Earlier">‹</button>
                          <button disabled={k === steps.length - 1} onClick={() => { const s = [...steps]; [s[k + 1], s[k]] = [s[k], s[k + 1]]; setSteps(s) }} title="Later">›</button>
                          <button onClick={() => setSteps(steps.filter((_, j) => j !== k))} title="Remove">×</button>
                        </span>
                      ) })}
                      <select value="" onChange={(e) => { if (e.target.value) setSteps([...steps, e.target.value]) }}>
                        <option value="">+ pass…</option>
                        {d.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    </div>
                  </td>
                </tr>
              )
            })}
            {!crops.length && <tr><td className="contracts-sub">No crops on this season’s Agworld fields yet.</td></tr>}
          </tbody>
        </table>
        <div className="agronomy-filter-bar" style={{ marginTop: 10 }}>{dirty && <span className="hb-tag warn">Not saved</span>}<button className="save" disabled={!dirty} onClick={save}>Save setup</button></div>
      </div>
    </>
  )
}
