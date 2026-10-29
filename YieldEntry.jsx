import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, doc, onSnapshot, query, where, writeBatch, deleteField } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { canonCrop, dayOfYear, fieldKey, fmt, unitFor } from './yieldMath.js'

// "Enter yields" tab (Admin/Owner). Same pattern as Potato Storage's
// AgworldFieldPicker: pick the season, tick one field or several, and
// several ticked fields are COMBINED into one entry — e.g. "Power Plant Main
// + Power Plant Mini" delivered to the same pile. The combined total is
// split back onto each field by acres (same yield/ac for all of them), or
// typed per field, and saved as one yieldHistory/{FIELDKEY}__{YEAR} doc per
// field so every chart and field history still works field by field.
//
// An entry that replaces an existing yield (from the workbook, say) keeps
// the old numbers under `replacedYield`, so removing the entry restores them.

// Local date (not UTC), so an evening entry doesn't default to tomorrow.
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function seasonYear(s) {
  if (!s) return null
  const m = String(s.name || '').match(/\b(19|20)\d{2}\b/)
  if (m) return Number(m[0])
  const d = s.startDate || s.endDate
  return d ? Number(String(d).slice(0, 4)) : null
}

function pct(v) { return v === '' || v == null || isNaN(Number(v)) ? null : Number(v) / 100 }
function num(v) { return v === '' || v == null || isNaN(Number(v)) ? null : Number(v) }

export default function YieldEntry({ docsById }) {
  const [seasons, setSeasons] = useState([])
  const [seasonId, setSeasonId] = useState(null)
  const [baseFields, setBaseFields] = useState({})
  const [seasonData, setSeasonData] = useState({})
  const [cropFilter, setCropFilter] = useState('POTATO')
  const [search, setSearch] = useState('')
  const [hideDone, setHideDone] = useState(false)
  const [selected, setSelected] = useState([]) // field ids, in click order
  const [entry, setEntry] = useState(null) // the open form, built from the selection
  const [msg, setMsg] = useState(null)

  useEffect(() => onSnapshot(collection(db, 'seasons'), (snap) => {
    const list = []
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
    list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
    setSeasons(list)
    setSeasonId((prev) => {
      if (prev) return prev
      const cur = list.find((s) => seasonYear(s) === new Date().getFullYear())
      return cur ? cur.id : (list[0] ? list[0].id : null)
    })
  }), [])

  useEffect(() => onSnapshot(collection(db, 'fields'), (snap) => {
    const m = {}
    snap.forEach((d) => { m[d.id] = d.data() })
    setBaseFields(m)
  }), [])

  useEffect(() => {
    if (!seasonId) return undefined
    setSelected([]); setEntry(null)
    return onSnapshot(query(collectionGroup(db, 'seasons'), where('seasonId', '==', seasonId)), (snap) => {
      const m = {}
      snap.forEach((d) => { m[d.ref.parent.parent.id] = d.data() })
      setSeasonData(m)
    })
  }, [seasonId])

  const season = seasons.find((s) => String(s.id) === String(seasonId))
  const year = seasonYear(season)

  const fields = useMemo(() => Object.entries(baseFields)
    .filter(([id]) => seasonData[id])
    .map(([id, b]) => {
      const sd = seasonData[id]
      const key = fieldKey(b.name)
      const existing = docsById[`${key}__${year}`] || null
      return {
        id, key, name: b.name, farmName: b.farmName || null,
        crop: canonCrop(sd.cropName), variety: sd.varietyName || null,
        acres: Number(sd.acres) || 0, harvestDate: sd.harvestDate || null,
        existing,
        existingYield: existing && existing.yieldPerAcre > 0 ? existing.yieldPerAcre : null,
        existingSource: existing ? (existing.yieldSource === 'manual' ? 'entered' : existing.yieldPerAcre > 0 ? 'workbook' : null) : null
      }
    })
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { numeric: true })),
  [baseFields, seasonData, docsById, year])

  const cropOptions = useMemo(() => {
    const m = {}
    fields.forEach((f) => { if (f.crop) m[f.crop] = (m[f.crop] || 0) + 1 })
    return Object.entries(m).sort((a, b) => b[1] - a[1])
  }, [fields])

  const shown = fields.filter((f) => (cropFilter === 'all' || f.crop === cropFilter)
    && (!hideDone || !f.existingYield)
    && (!search || `${f.name} ${f.farmName || ''} ${f.variety || ''}`.toLowerCase().includes(search.toLowerCase())))

  const selFields = selected.map((id) => fields.find((f) => f.id === id)).filter(Boolean)
  const mixedCrops = new Set(selFields.map((f) => f.crop)).size > 1
  const toggle = (id) => setSelected((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]))

  function openEntry() {
    if (!selFields.length || mixedCrops) return
    const harvest = selFields.map((f) => f.harvestDate).filter(Boolean).sort().pop()
    setEntry({
      crop: selFields[0].crop,
      rows: selFields.map((f) => ({ ...f, acresInput: f.acres ? String(Math.round(f.acres * 100) / 100) : '', totalInput: '' })),
      split: 'acres', // 'acres' = one total split by acres; 'each' = a total per field
      mode: 'total', // 'total' = total delivered; 'perAcre' = yield per acre
      amount: '', unadjusted: '', tare: '', dryMatter: '',
      harvestDate: harvest ? String(harvest).slice(0, 10) : today(),
      notes: ''
    })
    setMsg(null)
  }

  // Works out each field's share from whatever's been typed so far.
  const calc = useMemo(() => {
    if (!entry) return null
    const rows = entry.rows.map((r) => ({ ...r, acresN: num(r.acresInput) || 0 }))
    const totalAcres = rows.reduce((s, r) => s + r.acresN, 0)
    const amount = num(entry.amount)
    const unadj = num(entry.unadjusted)
    let out
    if (entry.split === 'each' && rows.length > 1) {
      out = rows.map((r) => {
        const v = num(r.totalInput)
        const total = v == null ? null : entry.mode === 'perAcre' ? v * r.acresN : v
        return { ...r, total, perAcre: total != null && r.acresN > 0 ? total / r.acresN : null, unadjShare: null }
      })
    } else {
      const groupTotal = amount == null ? null : entry.mode === 'perAcre' ? amount * totalAcres : amount
      const perAcre = groupTotal != null && totalAcres > 0 ? groupTotal / totalAcres : null
      out = rows.map((r) => ({
        ...r,
        total: perAcre != null ? perAcre * r.acresN : null,
        perAcre,
        unadjShare: unadj != null && totalAcres > 0 ? (unadj * r.acresN) / totalAcres : null
      }))
    }
    const groupTotal = out.reduce((s, r) => s + (r.total || 0), 0)
    const ready = out.every((r) => r.acresN > 0 && r.total > 0)
    return { rows: out, totalAcres, groupTotal, groupPerAcre: totalAcres > 0 ? groupTotal / totalAcres : null, ready }
  }, [entry])

  async function save() {
    if (!calc || !calc.ready || !year) return
    const who = auth.currentUser ? (auth.currentUser.email || auth.currentUser.uid) : null
    const groupId = `${year}-${Date.now().toString(36)}`
    const names = calc.rows.map((r) => r.name)
    const batch = writeBatch(db)
    calc.rows.forEach((r) => {
      const ex = r.existing
      const data = {
        fieldKey: r.key, fieldName: ex && ex.fieldName ? ex.fieldName : r.name, year,
        acres: r.acresN,
        adjustedYield: r.total,
        yieldPerAcre: r.perAcre,
        unadjustedYield: r.unadjShare,
        tareFactor: pct(entry.tare),
        dryMatterSugar: pct(entry.dryMatter),
        harvestDate: entry.harvestDate || null,
        harvestDoy: dayOfYear(entry.harvestDate),
        yieldSource: 'manual',
        // Entering a yield for a field-year that was deleted brings it back.
        deleted: deleteField(), deletedAt: deleteField(), deletedBy: deleteField(),
        entryNotes: entry.notes.trim() || null,
        agworldFieldId: r.id,
        entryGroup: {
          id: groupId, fields: names, combined: names.length > 1,
          totalYield: calc.groupTotal, totalAcres: calc.totalAcres, split: calc.rows.length > 1 ? entry.split : 'single',
          enteredBy: who, enteredAtMs: Date.now()
        }
      }
      // Fill descriptive fields only where the record doesn't already have
      // them (the workbook's own variety/area/crop spelling wins).
      if (!ex || !ex.crop) data.crop = entry.crop
      if (!ex || !ex.variety) data.variety = r.variety
      if (!ex || !ex.area) data.area = r.farmName
      if (!ex || !ex.unit) data.unit = unitFor(entry.crop)
      if (!ex) data.source = 'manual'
      // Keep what this entry replaces so removing it can put it back.
      if (ex && ex.yieldPerAcre > 0 && ex.yieldSource !== 'manual') {
        data.replacedYield = {
          yieldPerAcre: ex.yieldPerAcre, adjustedYield: ex.adjustedYield ?? null, unadjustedYield: ex.unadjustedYield ?? null,
          acres: ex.acres ?? null, harvestDate: ex.harvestDate ?? null, tareFactor: ex.tareFactor ?? null, dryMatterSugar: ex.dryMatterSugar ?? null
        }
      }
      batch.set(doc(db, 'yieldHistory', `${r.key}__${year}`), data, { merge: true })
    })
    try {
      await batch.commit()
      setMsg({ ok: true, text: `Saved ${names.length > 1 ? `${names.join(' + ')} (combined)` : names[0]}: ${fmt(calc.groupPerAcre)} ${unitFor(entry.crop)}/ac on ${fmt(calc.totalAcres, 1)} ac.` })
      setEntry(null); setSelected([])
    } catch (e) {
      setMsg({ ok: false, text: e.code === 'permission-denied' ? 'No permission to save yields (Admin/Owner only).' : e.message })
    }
  }

  // Recent entries, one row per entry group.
  const recent = useMemo(() => {
    const groups = new Map()
    Object.entries(docsById).forEach(([id, d]) => {
      if (d.yieldSource !== 'manual' || !d.entryGroup) return
      const g = groups.get(d.entryGroup.id) || { ...d.entryGroup, year: d.year, crop: d.crop, unit: d.unit, docs: [] }
      g.docs.push({ id, ...d })
      groups.set(d.entryGroup.id, g)
    })
    return [...groups.values()].sort((a, b) => (b.enteredAtMs || 0) - (a.enteredAtMs || 0)).slice(0, 25)
  }, [docsById])

  async function removeGroup(g) {
    if (!window.confirm(`Remove the yield entered for ${g.fields.join(' + ')} (${g.year})?`)) return
    const batch = writeBatch(db)
    const clear = {
      yieldSource: deleteField(), entryGroup: deleteField(), entryNotes: deleteField(), replacedYield: deleteField(), agworldFieldId: deleteField()
    }
    g.docs.forEach((d) => {
      const ref = doc(db, 'yieldHistory', d.id)
      if (d.replacedYield) {
        batch.set(ref, { ...clear, ...d.replacedYield }, { merge: true })
      } else if (d.source === 'manual' && !d.agworld) {
        batch.delete(ref)
      } else {
        batch.set(ref, { ...clear, yieldPerAcre: null, adjustedYield: null, unadjustedYield: null }, { merge: true })
      }
    })
    await batch.commit()
  }

  const unit = unitFor(entry ? entry.crop : cropFilter)

  return (
    <>
      <div className="yields-entry-layout">
        <div className="yields-card">
          <div className="yields-card-title">1 · Pick the field(s)</div>
          <p className="contracts-sub" style={{ marginTop: 2 }}>Tick more than one field to combine them — e.g. fields that went to the same pile or were weighed together.</p>
          <div className="yields-filters" style={{ marginTop: 8 }}>
            <select value={seasonId || ''} onChange={(e) => setSeasonId(e.target.value)}>
              {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={cropFilter} onChange={(e) => { setCropFilter(e.target.value); setSelected([]) }}>
              {cropOptions.map(([c, n]) => <option key={c} value={c}>{c} ({n})</option>)}
              <option value="all">All crops</option>
            </select>
            <input className="agronomy-search-input" placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
            <label className="yields-check"><input type="checkbox" checked={hideDone} onChange={(e) => setHideDone(e.target.checked)} /> Hide fields with a yield</label>
          </div>
          <div className="yields-pick-list">
            {shown.length === 0 && <div className="contracts-empty">No fields match.</div>}
            {shown.map((f) => {
              const on = selected.includes(f.id)
              return (
                <label key={f.id} className={`yields-pick ${on ? 'on' : ''}`}>
                  <input type="checkbox" checked={on} onChange={() => toggle(f.id)} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="yields-pick-name">{f.name}</div>
                    <div className="contracts-sub" style={{ marginTop: 1 }}>{f.farmName || '—'} · {f.variety || 'variety unknown'} · {f.acres ? `${fmt(f.acres, 1)} ac` : '—'}</div>
                  </div>
                  {f.existingYield && (
                    <span className={`yields-done ${f.existingSource}`} title={f.existingSource === 'entered' ? 'Yield already entered' : 'Yield from the workbook'}>
                      {fmt(f.existingYield)} {unitFor(f.crop)}/ac
                    </span>
                  )}
                </label>
              )
            })}
          </div>
          {selected.length > 0 && (
            <div className="yields-pick-bar">
              <span className="contracts-sub" style={{ marginTop: 0 }}>{selected.length} selected · {fmt(selFields.reduce((s, f) => s + f.acres, 0), 1)} ac</span>
              {mixedCrops
                ? <span className="contracts-sub" style={{ color: '#A32D2D', marginTop: 0 }}>Pick fields of one crop to combine.</span>
                : <button className="save" onClick={openEntry}>{selected.length > 1 ? `Combine ${selected.length} fields` : 'Enter yield'}</button>}
              <button className="clear-sort-btn" onClick={() => setSelected([])}>Clear</button>
            </div>
          )}
        </div>

        <div className="yields-card">
          <div className="yields-card-title">2 · Enter the yield</div>
          {!entry && <p className="contracts-empty">Pick one or more fields on the left, then “Enter yield” or “Combine”.</p>}
          {entry && calc && (
            <div className="contracts-form" style={{ maxWidth: 'none' }}>
              <div className="yields-entry-title">
                {entry.rows.map((r) => r.name).join(' + ')} <span className="contracts-sub">· {entry.crop} · {year}</span>
              </div>
              <div className="contracts-form-grid">
                <label>Harvest date<input type="date" value={entry.harvestDate} onChange={(e) => setEntry({ ...entry, harvestDate: e.target.value })} /></label>
                <label>I’m entering
                  <select value={entry.mode} onChange={(e) => setEntry({ ...entry, mode: e.target.value })}>
                    <option value="total">Total delivered ({unit})</option>
                    <option value="perAcre">Yield per acre ({unit}/ac)</option>
                  </select>
                </label>
                {entry.rows.length > 1 && (
                  <label>Combined fields
                    <select value={entry.split} onChange={(e) => setEntry({ ...entry, split: e.target.value })}>
                      <option value="acres">One number, split by acres</option>
                      <option value="each">A number for each field</option>
                    </select>
                  </label>
                )}
                {(entry.split === 'acres' || entry.rows.length === 1) && (
                  <label>{entry.mode === 'total' ? `Adjusted yield, total (${unit})` : `Adjusted yield (${unit}/ac)`}
                    <input type="number" inputMode="decimal" value={entry.amount} autoFocus onChange={(e) => setEntry({ ...entry, amount: e.target.value })} />
                  </label>
                )}
                {(entry.split === 'acres' || entry.rows.length === 1) && entry.mode === 'total' && (
                  <label>Unadjusted total ({unit}, optional)<input type="number" inputMode="decimal" value={entry.unadjusted} onChange={(e) => setEntry({ ...entry, unadjusted: e.target.value })} /></label>
                )}
                <label>Tare % (optional)<input type="number" inputMode="decimal" value={entry.tare} onChange={(e) => setEntry({ ...entry, tare: e.target.value })} placeholder="e.g. 6.7" /></label>
                <label>{entry.crop === 'BEETS' ? 'Sugar %' : 'Dry matter %'} (optional)<input type="number" inputMode="decimal" value={entry.dryMatter} onChange={(e) => setEntry({ ...entry, dryMatter: e.target.value })} placeholder={entry.crop === 'BEETS' ? 'e.g. 17.3' : 'e.g. 21.5'} /></label>
              </div>

              <div className="table-scroll" style={{ maxHeight: 'none', margin: '10px 0' }}>
                <table className="contracts-table contracts-table-auto">
                  <thead>
                    <tr>
                      <th>Field</th><th className="num">Acres</th>
                      {entry.split === 'each' && entry.rows.length > 1 && <th className="num">{entry.mode === 'total' ? `Total ${unit}` : `${unit}/ac`}</th>}
                      <th className="num">Total</th><th className="num">{unit}/ac</th><th className="hide-sm">Replaces</th>
                    </tr>
                  </thead>
                  <tbody>
                    {calc.rows.map((r, i) => (
                      <tr key={r.id}>
                        <td><strong>{r.name}</strong></td>
                        <td className="num">
                          <input className="yields-cell-input" type="number" inputMode="decimal" value={entry.rows[i].acresInput}
                            onChange={(e) => setEntry({ ...entry, rows: entry.rows.map((x, j) => (j === i ? { ...x, acresInput: e.target.value } : x)) })} />
                        </td>
                        {entry.split === 'each' && entry.rows.length > 1 && (
                          <td className="num">
                            <input className="yields-cell-input" type="number" inputMode="decimal" value={entry.rows[i].totalInput}
                              onChange={(e) => setEntry({ ...entry, rows: entry.rows.map((x, j) => (j === i ? { ...x, totalInput: e.target.value } : x)) })} />
                          </td>
                        )}
                        <td className="num">{fmt(r.total)}</td>
                        <td className="num"><strong>{fmt(r.perAcre)}</strong></td>
                        <td className="hide-sm contracts-sub">{r.existingYield ? `${fmt(r.existingYield)} ${unit}/ac (${r.existingSource})` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                  {calc.rows.length > 1 && (
                    <tfoot>
                      <tr>
                        <td><strong>Combined</strong></td><td className="num">{fmt(calc.totalAcres, 1)}</td>
                        {entry.split === 'each' && <td />}
                        <td className="num"><strong>{fmt(calc.groupTotal)}</strong></td><td className="num"><strong>{fmt(calc.groupPerAcre)}</strong></td><td className="hide-sm" />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              <label className="contracts-notes">Notes<textarea rows={2} value={entry.notes} onChange={(e) => setEntry({ ...entry, notes: e.target.value })} placeholder="Where it was delivered, storage, settlement #…" /></label>
              {calc.rows.some((r) => r.existingYield) && <p className="contracts-hint">Fields that already have a yield will be overwritten. Removing this entry later puts the old yield back.</p>}
              <div className="editor-row">
                <button className="save" disabled={!calc.ready} onClick={save}>Save {calc.rows.length > 1 ? `${calc.rows.length} fields` : 'yield'}</button>
                <button onClick={() => setEntry(null)}>Cancel</button>
              </div>
            </div>
          )}
          {msg && <div className={msg.ok ? 'yields-ok' : 'agronomy-error-banner'}>{msg.text}</div>}
        </div>
      </div>

      <div className="yields-card">
        <div className="yields-card-title">Recently entered</div>
        {recent.length === 0 ? <p className="contracts-empty">Nothing entered yet.</p> : (
          <div className="table-scroll" style={{ maxHeight: 'none', marginTop: 8 }}>
            <table className="contracts-table contracts-table-auto">
              <thead><tr><th>Field(s)</th><th>Year</th><th className="num">Acres</th><th className="num">Total</th><th className="num">Per acre</th><th className="hide-sm">Entered</th><th /></tr></thead>
              <tbody>
                {recent.map((g) => (
                  <tr key={g.id}>
                    <td><strong>{g.fields.join(' + ')}</strong>{g.combined && <span className="yields-combined">combined</span>}</td>
                    <td>{g.year}</td>
                    <td className="num">{fmt(g.totalAcres, 1)}</td>
                    <td className="num">{fmt(g.totalYield)} <span className="contracts-sub">{g.unit}</span></td>
                    <td className="num"><strong>{fmt(g.totalAcres ? g.totalYield / g.totalAcres : null)}</strong></td>
                    <td className="hide-sm contracts-sub">{g.enteredBy || '—'}{g.enteredAtMs ? ` · ${new Date(g.enteredAtMs).toLocaleDateString()}` : ''}</td>
                    <td><button className="clear-sort-btn" onClick={() => removeGroup(g)}>Remove</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  )
}
