import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { METRICS_BY_TYPE, CROP_COLOR } from './AgronomyConfig.js'

// Nematodes: pick a crop and see how many of its fields have a nematode
// detection - beet cyst nematode on beets; stubby root, Columbia root-knot and
// northern root-knot on potatoes. Uses each field's latest nematode lab sample
// (or the latest within a chosen year), counts a species as "found" at or above
// a threshold you set (default: any count at all), and lists every field so the
// ones that were never tested stand out too.

// Species worth counting for each crop. Keys are Stukenholtz's own NEMA result
// names (see METRICS_BY_TYPE.nematode in AgronomyConfig.js).
const FOCUS = [
  {
    test: /BEET/i,
    title: 'Beet cyst nematode',
    anyLabel: 'Any beet cyst nematode (eggs, larvae, viable or empty cysts)',
    keys: ['BTCYSTEGG', 'BTCYSTLARV', 'BTCYSTVIAB', 'BTCYSTEM']
  },
  {
    test: /POTATO/i,
    title: 'Potato nematodes',
    anyLabel: 'Any of stubby root, Columbia or northern root-knot',
    keys: ['STUBBY', 'COLMB RK', 'NORTHRK']
  }
]
const focusFor = (crop) => FOCUS.find((f) => f.test.test(crop || '')) || null

const LABELS = {}
METRICS_BY_TYPE.nematode.forEach((m) => { LABELS[m.key] = m.label })
const ALL_KEYS = METRICS_BY_TYPE.nematode.map((m) => m.key)

const fmtDay = (ms) => (ms == null ? '' : new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
const num = (v) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''))
  return Number.isFinite(n) ? n : 0
}
const acresOf = (f) => Number(f && f.acres) || 0
const sumAcres = (list) => list.reduce((t, f) => t + acresOf(f), 0)
const fmtAc = (n) => Math.round(n).toLocaleString()
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '—')

const box = { border: '1px solid #ddd8cc', borderRadius: 8, background: '#fff', padding: 10, marginBottom: 12 }
const th = { textAlign: 'left', padding: '4px 8px', background: '#f4f2ec', position: 'sticky', top: 0, whiteSpace: 'nowrap', fontSize: 12 }
const td = { padding: '3px 8px', borderTop: '1px solid #eee', fontSize: 12 }
const smallBtn = { padding: '3px 9px', borderRadius: 5, border: '1px solid #bdb8a8', background: '#fff', cursor: 'pointer', fontSize: 12 }

export default function AgronomyNematodes({ fields }) {
  const [samples, setSamples] = useState([])
  const [error, setError] = useState(null)
  const [crop, setCrop] = useState('all')
  const [year, setYear] = useState('all')
  const [threshold, setThreshold] = useState('1')
  const [show, setShow] = useState('all') // all | found | clean | untested
  const [sortBy, setSortBy] = useState('name')
  const [allSpecies, setAllSpecies] = useState(false)

  useEffect(() => {
    const q = query(collection(db, 'samples'), where('type', '==', 'nematode'))
    return onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => {
          const v = d.data()
          if (!v.fieldId || !v.receivedDt) return
          list.push({ id: d.id, fieldId: v.fieldId, ms: v.receivedDt.toMillis ? v.receivedDt.toMillis() : +v.receivedDt.toDate(), values: v.values || {} })
        })
        setSamples(list)
        setError(null)
      },
      (err) => { console.error('AgronomyNematodes samples query failed:', err); setError(err.message) }
    )
  }, [])

  const cropOptions = useMemo(() => [...new Set(fields.map((f) => f.cropName).filter(Boolean))].sort(), [fields])
  useEffect(() => { if (crop !== 'all' && !cropOptions.includes(crop)) setCrop('all') }, [cropOptions, crop])

  const fieldIds = useMemo(() => new Set(fields.map((f) => f.id)), [fields])
  const yearOptions = useMemo(
    () => [...new Set(samples.filter((s) => fieldIds.has(s.fieldId)).map((s) => new Date(s.ms).getFullYear()))].sort((a, b) => b - a),
    [samples, fieldIds]
  )

  // Latest nematode sample per field (within the chosen year, if any).
  const latestByField = useMemo(() => {
    const m = {}
    samples.forEach((s) => {
      if (year !== 'all' && new Date(s.ms).getFullYear() !== Number(year)) return
      if (!m[s.fieldId] || s.ms > m[s.fieldId].ms) m[s.fieldId] = s
    })
    return m
  }, [samples, year])

  const thr = Math.max(0, parseFloat(threshold) || 0) || 1e-9 // 0/blank means "any count above zero"
  const found = (v) => v >= thr

  // Per-crop summaries.
  const crops = crop === 'all' ? cropOptions : [crop]
  const summaries = useMemo(() => crops.map((c) => {
    const cropFields = fields.filter((f) => f.cropName === c)
    const focus = focusFor(c)
    const tested = cropFields.filter((f) => latestByField[f.id])
    // Species rows: the crop's focus species; for other crops, whichever species turn up.
    let keys = focus ? focus.keys : []
    if (!focus || allSpecies) {
      const seen = ALL_KEYS.filter((k) => tested.some((f) => found(num(latestByField[f.id].values[k]))))
      keys = allSpecies ? ALL_KEYS : seen
    }
    const rows = keys.map((k) => {
      const counts = tested.map((f) => num(latestByField[f.id].values[k]))
      const hits = counts.filter(found)
      const hitAcres = sumAcres(tested.filter((f) => found(num(latestByField[f.id].values[k]))))
      return { key: k, label: LABELS[k] || k, tested: tested.length, found: hits.length, acres: hitAcres, max: counts.length ? Math.max(...counts) : 0, avg: hits.length ? Math.round(hits.reduce((a, b) => a + b, 0) / hits.length) : 0 }
    })
    const anyKeys = focus ? focus.keys : keys
    const foundFields = tested.filter((f) => anyKeys.some((k) => found(num(latestByField[f.id].values[k]))))
    const anyFound = foundFields.length
    return {
      crop: c, focus, total: cropFields.length, tested: tested.length, untested: cropFields.length - tested.length, anyFound, rows, anyKeys, cropFields,
      acresTotal: sumAcres(cropFields), acresTested: sumAcres(tested), acresFound: sumAcres(foundFields),
      noAcres: cropFields.filter((f) => !acresOf(f)).length
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [crops.join('|'), fields, latestByField, thr, allSpecies])

  const detail = crop !== 'all' ? summaries[0] : null

  // Field table for the chosen crop.
  const columns = detail ? detail.rows.map((r) => r.key) : []
  const tableRows = useMemo(() => {
    if (!detail) return []
    let list = detail.cropFields.map((f) => {
      const s = latestByField[f.id] || null
      const counts = s ? columns.map((k) => num(s.values[k])) : null
      const isFound = !!s && detail.anyKeys.some((k) => found(num(s.values[k])))
      return { f, s, counts, isFound, total: counts ? counts.reduce((a, b) => a + b, 0) : -1 }
    })
    if (show === 'found') list = list.filter((r) => r.isFound)
    else if (show === 'clean') list = list.filter((r) => r.s && !r.isFound)
    else if (show === 'untested') list = list.filter((r) => !r.s)
    const byName = (a, b) => (a.f.name || '').localeCompare(b.f.name || '')
    list.sort(sortBy === 'count' ? (a, b) => b.total - a.total || byName(a, b) : sortBy === 'date' ? (a, b) => (b.s ? b.s.ms : 0) - (a.s ? a.s.ms : 0) || byName(a, b) : byName)
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail, latestByField, show, sortBy, thr, columns.join('|')])

  function downloadCsv() {
    if (!detail) return
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`
    const head = ['Field', 'Acres', 'Crop', 'Variety', 'Farm', 'Sample date', 'Found', ...columns.map((k) => LABELS[k] || k)]
    const lines = [head.map(esc).join(',')]
    tableRows.forEach((r) => lines.push([
      r.f.name, acresOf(r.f) || '', r.f.cropName, r.f.varietyName, r.f.farmName, r.s ? fmtDay(r.s.ms) : 'not tested',
      r.s ? (r.isFound ? 'yes' : 'no') : '', ...(r.counts || columns.map(() => ''))
    ].map(esc).join(',')))
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `nematodes-${crop}-${year}.csv`
    a.click()
    URL.revokeObjectURL(a.href)
  }

  const cellStyle = (n) => (found(n)
    ? { background: `rgba(240,138,0,${0.2 + 0.55 * Math.min(1, Math.log10(1 + n) / 3)})`, color: '#4a2a00', fontWeight: 700 }
    : { background: '#f4f2ec', color: '#999' })

  return (
    <div className="agronomy-nematodes">
      {error && <p className="agronomy-error-banner">Couldn't load nematode samples: {error}</p>}

      <div className="agronomy-field-picker" style={{ flexWrap: 'wrap', gap: 8 }}>
        <select value={crop} onChange={(e) => { setCrop(e.target.value); setShow('all') }}>
          <option value="all">All crops (summary)</option>
          {cropOptions.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label style={{ fontSize: 12 }}>Sample year{' '}
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="all">Latest sample, any year</option>
            {yearOptions.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <label style={{ fontSize: 12 }}>Found means at least{' '}
          <input type="number" min="0" value={threshold} onChange={(e) => setThreshold(e.target.value)} style={{ width: 64 }} /> per 250 g
        </label>
        <label style={{ fontSize: 12 }}>
          <input type="checkbox" checked={allSpecies} onChange={(e) => setAllSpecies(e.target.checked)} /> all 20 species
        </label>
      </div>
      <p style={{ fontSize: 11, color: '#666', margin: '6px 0 10px' }}>
        Uses each field's {year === 'all' ? 'most recent' : `${year}`} nematode sample. "Tested" = the field has one. Fields come from the
        season and farm chosen above.
      </p>

      {summaries.length === 0 && <p className="agronomy-chart-empty">No fields with a crop for this season.</p>}

      {summaries.map((s) => (
        <div key={s.crop} style={box}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap', marginBottom: 6 }}>
            {(() => {
              const c = CROP_COLOR[s.crop]
              return <span style={{ padding: '1px 8px', borderRadius: 4, fontWeight: 700, fontSize: 12, background: c ? c.bg : '#D3D1C7', color: c ? c.fg : '#2C2C2A' }}>{s.crop}</span>
            })()}
            <strong style={{ fontSize: 15 }}>
              {s.tested ? `${s.anyFound} of ${s.tested} tested fields` : 'No tested fields'}
              {s.tested ? ` (${pct(s.anyFound, s.tested)})` : ''}
            </strong>
            {s.tested > 0 && (
              <strong style={{ fontSize: 15, color: '#a85a00' }}>
                {'\u00b7'} {fmtAc(s.acresFound)} of {fmtAc(s.acresTested)} tested acres ({pct(s.acresFound, s.acresTested)})
              </strong>
            )}
            <span style={{ fontSize: 12, color: '#555' }}>
              {s.focus ? s.focus.anyLabel : 'with any nematode found'}
            </span>
          </div>
          <p style={{ fontSize: 11, color: '#777', margin: '0 0 8px' }}>
            {s.total} {s.crop.toLowerCase()} fields / {fmtAc(s.acresTotal)} acres this season - {s.tested} fields ({fmtAc(s.acresTested)} acres) tested,
            {' '}{s.untested} ({fmtAc(s.acresTotal - s.acresTested)} acres) with no nematode sample
            {s.noAcres > 0 ? ` - ${s.noAcres} field${s.noAcres === 1 ? ' has' : 's have'} no acres in Agworld, counted as 0` : ''}
          </p>
          {s.rows.length > 0 ? (
            <table style={{ borderCollapse: 'collapse', minWidth: 420 }}>
              <thead><tr><th style={th}>Species</th><th style={th}>Fields found</th><th style={th}>Acres found</th><th style={th}>% of tested</th><th style={th}>Highest count</th><th style={th}>Avg where found</th></tr></thead>
              <tbody>
                {s.rows.map((r) => (
                  <tr key={r.key}>
                    <td style={td}>{r.label}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{r.found} <span style={{ color: '#888', fontWeight: 400 }}>of {r.tested}</span></td>
                    <td style={{ ...td, fontWeight: 700 }}>{fmtAc(r.acres)}</td>
                    <td style={td}>{pct(r.found, r.tested)}</td>
                    <td style={td}>{r.max || '—'}</td>
                    <td style={td}>{r.avg || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ fontSize: 12, color: '#888', margin: 0 }}>No nematodes found in the tested fields{s.tested ? '.' : ' - nothing to show yet.'}</p>
          )}
          {crop === 'all' && (
            <button style={{ ...smallBtn, marginTop: 8 }} onClick={() => setCrop(s.crop)}>See the {s.crop.toLowerCase()} fields</button>
          )}
        </div>
      ))}

      {detail && (
        <>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '4px 0 6px' }}>
            <p className="agronomy-section-label" style={{ margin: 0 }}>Fields</p>
            {[['all', `All (${detail.total})`], ['found', `Found (${detail.anyFound} \u00b7 ${fmtAc(detail.acresFound)} ac)`], ['clean', `Tested, none found (${detail.tested - detail.anyFound})`], ['untested', `Not tested (${detail.untested})`]].map(([id, label]) => (
              <button key={id} onClick={() => setShow(id)}
                style={{ ...smallBtn, ...(show === id ? { background: '#3c5a3f', color: '#fff', border: '1px solid #3c5a3f' } : {}) }}>
                {label}
              </button>
            ))}
            <select value={sortBy} onChange={(e) => setSortBy(e.target.value)}>
              <option value="name">sort: name</option>
              <option value="count">sort: highest counts first</option>
              <option value="date">sort: newest sample</option>
            </select>
            <button style={smallBtn} onClick={downloadCsv}>Download as spreadsheet (CSV)</button>
          </div>
          <div style={{ overflow: 'auto', maxHeight: 560, border: '1px solid #ddd8cc', borderRadius: 6, background: '#fff' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%' }}>
              <thead>
                <tr>
                  <th style={th}>Field</th><th style={th}>Acres</th><th style={th}>Variety</th><th style={th}>Sampled</th>
                  {columns.map((k) => <th key={k} style={th}>{LABELS[k] || k}</th>)}
                </tr>
              </thead>
              <tbody>
                {tableRows.length === 0 && <tr><td colSpan={columns.length + 4} style={{ ...td, color: '#888', padding: 12 }}>No fields match.</td></tr>}
                {tableRows.map((r) => (
                  <tr key={r.f.id}>
                    <td style={{ ...td, fontWeight: 600, whiteSpace: 'nowrap' }}>{r.f.name}{r.f.farmName ? <span style={{ fontWeight: 400, color: '#999', fontSize: 11 }}> {'·'} {r.f.farmName}</span> : null}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{acresOf(r.f) ? fmtAc(acresOf(r.f)) : ''}</td>
                    <td style={{ ...td, color: '#666' }}>{r.f.varietyName || ''}</td>
                    <td style={{ ...td, whiteSpace: 'nowrap', color: r.s ? 'inherit' : '#a0651a' }}>{r.s ? fmtDay(r.s.ms) : 'not tested'}</td>
                    {columns.map((k, i) => (
                      <td key={k} style={{ ...td, textAlign: 'center', ...(r.counts ? cellStyle(r.counts[i]) : {}) }}>{r.counts ? r.counts[i] : ''}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
