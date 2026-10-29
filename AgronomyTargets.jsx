import { useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase.js'
import { METRICS_BY_TYPE } from './AgronomyConfig.js'
import { useLiveAgronomyCriteria } from './AgronomyCriteriaData.js'

// Same `functions` export from firebase.js that AgronomyCleanup.jsx already
// uses for its own callable (reassignSampleField) - no new firebase.js
// changes needed here.
const updateAgronomyCriteria = httpsCallable(functions, 'updateAgronomyCriteria')

const CURVE_FIELDS = [
  { key: 'nRec', label: 'N Rec', unit: 'lbs/ac', kind: 'single' },
  { key: 'soilNO3', label: 'Soil NO3', unit: 'ppm', kind: 'range' },
  { key: 'petioleNO3', label: 'Petiole NO3', unit: 'ppm', kind: 'range' },
  { key: 'petioleP', label: 'Petiole %P', unit: '%', kind: 'range' },
  { key: 'petioleK', label: 'Petiole %K', unit: '%', kind: 'range' },
  { key: 'petioleS', label: 'Petiole %S', unit: '%', kind: 'range' },
  { key: 'stage', label: 'Stage note', unit: '', kind: 'text' }
]

function blankWeekRow(week) {
  return { week }
}

function cloneWeeks(weeks) {
  return (weeks || []).map((w) => ({ ...w }))
}

// Flat targets are nested two levels (type -> metric key -> [low, high]).
// This flattens METRICS_BY_TYPE's own list of metrics so the form only ever
// renders rows for metrics that structurally exist, instead of guessing at
// shape from whatever happens to be in Firestore already.
function buildFlatDraft(metricsByType, liveFlatTargets) {
  const draft = {}
  Object.entries(metricsByType).forEach(([type, metrics]) => {
    metrics.forEach((m) => {
      const live = liveFlatTargets?.[type]?.[m.key]
      const fallback = m.target
      const range = live !== undefined ? live : fallback
      if (!draft[type]) draft[type] = {}
      draft[type][m.key] = range ? [range[0], range[1]] : ['', '']
    })
  })
  return draft
}

export default function AgronomyTargets() {
  const { flatTargets, curvesByKey, loading, error } = useLiveAgronomyCriteria()

  const [flatDraft, setFlatDraft] = useState(null)
  const [flatSaving, setFlatSaving] = useState(false)
  const [flatMsg, setFlatMsg] = useState(null)

  // Seed the editable draft once live data first arrives, then leave it
  // alone - re-seeding on every Firestore snapshot would blow away
  // whatever Kent is mid-typing every time another tab's write lands.
  useEffect(() => {
    if (!loading && flatDraft === null) {
      setFlatDraft(buildFlatDraft(METRICS_BY_TYPE, flatTargets))
    }
  }, [loading, flatTargets, flatDraft])

  const cropKeys = useMemo(() => Object.keys(curvesByKey).sort(), [curvesByKey])
  const [selectedKey, setSelectedKey] = useState(null)
  useEffect(() => {
    if (!selectedKey && cropKeys.length) setSelectedKey(cropKeys[0])
  }, [cropKeys, selectedKey])

  const [curveDraft, setCurveDraft] = useState(null)
  const [curveSaving, setCurveSaving] = useState(false)
  const [curveMsg, setCurveMsg] = useState(null)
  const [deleting, setDeleting] = useState(false)

  // Re-seed the curve draft whenever the selected crop/variety changes (not
  // on every snapshot of the SAME crop, for the same reason as above).
  useEffect(() => {
    if (selectedKey && curvesByKey[selectedKey]) {
      const doc = curvesByKey[selectedKey]
      setCurveDraft({
        cropName: doc.cropName || selectedKey.split('::')[0],
        varietyName: doc.varietyName || null,
        weeks: cloneWeeks(doc.weeks)
      })
      setCurveMsg(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedKey])

  const [showNewForm, setShowNewForm] = useState(false)
  const [newCrop, setNewCrop] = useState('')
  const [newVariety, setNewVariety] = useState('')
  const [cloneFrom, setCloneFrom] = useState('')

  function saveFlat() {
    setFlatSaving(true)
    setFlatMsg(null)
    const data = {}
    Object.entries(flatDraft).forEach(([type, metrics]) => {
      data[type] = {}
      Object.entries(metrics).forEach(([key, [low, high]]) => {
        if (low === '' || high === '') return
        data[type][key] = [Number(low), Number(high)]
      })
    })
    updateAgronomyCriteria({ kind: 'flat', data })
      .then(() => setFlatMsg({ ok: true, text: 'Saved.' }))
      .catch((err) => setFlatMsg({ ok: false, text: err.message }))
      .finally(() => setFlatSaving(false))
  }

  function setFlatCell(type, key, idx, value) {
    setFlatDraft((prev) => {
      const next = { ...prev, [type]: { ...prev[type] } }
      const pair = [...next[type][key]]
      pair[idx] = value
      next[type][key] = pair
      return next
    })
  }

  function setCurveCell(weekIdx, field, value) {
    setCurveDraft((prev) => {
      const weeks = [...prev.weeks]
      const row = { ...weeks[weekIdx] }
      row[field] = value
      weeks[weekIdx] = row
      return { ...prev, weeks }
    })
  }

  function setCurveRangeCell(weekIdx, field, pairIdx, value) {
    setCurveDraft((prev) => {
      const weeks = [...prev.weeks]
      const row = { ...weeks[weekIdx] }
      const pair = Array.isArray(row[field]) ? [...row[field]] : ['', '']
      pair[pairIdx] = value
      row[field] = pair
      weeks[weekIdx] = row
      return { ...prev, weeks }
    })
  }

  function addWeekRow() {
    setCurveDraft((prev) => {
      const lastWeek = prev.weeks.length ? prev.weeks[prev.weeks.length - 1].week : 0
      return { ...prev, weeks: [...prev.weeks, blankWeekRow(Number(lastWeek) + 1)] }
    })
  }

  function removeWeekRow(idx) {
    setCurveDraft((prev) => ({ ...prev, weeks: prev.weeks.filter((_, i) => i !== idx) }))
  }

  function saveCurve() {
    setCurveSaving(true)
    setCurveMsg(null)
    // Clean numeric fields: nRec as a number (or null), ranges as [num, num]
    // (or dropped if either side is blank), stage left as free text.
    const weeks = curveDraft.weeks.map((row) => {
      const clean = { week: Number(row.week) }
      CURVE_FIELDS.forEach(({ key, kind }) => {
        const v = row[key]
        if (v == null || v === '') return
        if (kind === 'single') clean[key] = Number(v)
        else if (kind === 'range') {
          const [low, high] = Array.isArray(v) ? v : ['', '']
          if (low !== '' && high !== '') clean[key] = [Number(low), Number(high)]
        } else {
          clean[key] = v
        }
      })
      return clean
    })
    updateAgronomyCriteria({
      kind: 'curve',
      cropKey: selectedKey,
      data: { cropName: curveDraft.cropName, varietyName: curveDraft.varietyName, weeks }
    })
      .then(() => setCurveMsg({ ok: true, text: 'Saved.' }))
      .catch((err) => setCurveMsg({ ok: false, text: err.message }))
      .finally(() => setCurveSaving(false))
  }

  function deleteCurve() {
    if (!window.confirm(`Delete the curve for ${selectedKey}? This can't be undone.`)) return
    setDeleting(true)
    updateAgronomyCriteria({ kind: 'deleteCurve', cropKey: selectedKey })
      .then(() => {
        setSelectedKey(null)
        setCurveDraft(null)
      })
      .catch((err) => setCurveMsg({ ok: false, text: err.message }))
      .finally(() => setDeleting(false))
  }

  function createCrop() {
    const crop = newCrop.trim().toUpperCase()
    if (!crop) return
    const variety = newVariety.trim().toUpperCase() || null
    const cropKey = variety ? `${crop}::${variety}` : crop
    const sourceWeeks = cloneFrom && curvesByKey[cloneFrom] ? cloneWeeks(curvesByKey[cloneFrom].weeks) : [blankWeekRow(1)]
    updateAgronomyCriteria({
      kind: 'curve',
      cropKey,
      data: { cropName: crop, varietyName: variety, weeks: sourceWeeks }
    })
      .then(() => {
        setShowNewForm(false)
        setNewCrop('')
        setNewVariety('')
        setCloneFrom('')
        setSelectedKey(cropKey)
      })
      .catch((err) => setCurveMsg({ ok: false, text: err.message }))
  }

  if (loading || flatDraft === null) {
    return <p className="agronomy-table-empty">Loading targets…</p>
  }

  return (
    <div className="agronomy-targets">
      {error && <p className="agronomy-error-banner">Couldn't load targets: {error}</p>}

      <p className="agronomy-section-label">Flat fallback targets</p>
      <p className="agronomy-targets-hint">
        Used for any sample type/crop that doesn't have a week-by-week curve below.
      </p>
      <table className="agronomy-targets-table">
        <thead>
          <tr><th>Type</th><th>Metric</th><th>Low</th><th>High</th></tr>
        </thead>
        <tbody>
          {Object.entries(METRICS_BY_TYPE).map(([type, metrics]) =>
            metrics.map((m) => (
              <tr key={type + m.key}>
                <td>{type}</td>
                <td>{m.label} {m.unit ? `(${m.unit})` : ''}</td>
                <td>
                  <input
                    type="number"
                    value={flatDraft[type]?.[m.key]?.[0] ?? ''}
                    onChange={(e) => setFlatCell(type, m.key, 0, e.target.value)}
                  />
                </td>
                <td>
                  <input
                    type="number"
                    value={flatDraft[type]?.[m.key]?.[1] ?? ''}
                    onChange={(e) => setFlatCell(type, m.key, 1, e.target.value)}
                  />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      <div className="agronomy-targets-actions">
        <button onClick={saveFlat} disabled={flatSaving}>{flatSaving ? 'Saving…' : 'Save flat targets'}</button>
        {flatMsg && (
          <span className={flatMsg.ok ? 'agronomy-targets-msg-ok' : 'agronomy-targets-msg-error'}>{flatMsg.text}</span>
        )}
      </div>

      <p className="agronomy-section-label">Crop / variety curves</p>
      <div className="agronomy-targets-crop-row">
        <select value={selectedKey || ''} onChange={(e) => setSelectedKey(e.target.value)}>
          {cropKeys.length === 0 && <option value="">No curves yet</option>}
          {cropKeys.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
        <button onClick={() => setShowNewForm((s) => !s)}>+ New crop/variety</button>
      </div>

      {showNewForm && (
        <div className="agronomy-targets-new-form">
          <input placeholder="Crop name (e.g. ONION)" value={newCrop} onChange={(e) => setNewCrop(e.target.value)} />
          <input placeholder="Variety (optional)" value={newVariety} onChange={(e) => setNewVariety(e.target.value)} />
          <select value={cloneFrom} onChange={(e) => setCloneFrom(e.target.value)}>
            <option value="">Start blank</option>
            {cropKeys.map((k) => <option key={k} value={k}>Clone from {k}</option>)}
          </select>
          <button onClick={createCrop} disabled={!newCrop.trim()}>Create</button>
        </div>
      )}

      {curveDraft && (
        <>
          <div className="agronomy-targets-table-wrap">
            <table className="agronomy-targets-table">
              <thead>
                <tr>
                  <th>Week</th>
                  {CURVE_FIELDS.map((f) => (
                    <th key={f.key}>{f.label}{f.unit ? ` (${f.unit})` : ''}</th>
                  ))}
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {curveDraft.weeks.map((row, idx) => (
                  <tr key={idx}>
                    <td>
                      <input
                        type="number"
                        value={row.week ?? ''}
                        onChange={(e) => setCurveCell(idx, 'week', e.target.value)}
                        style={{ width: '3.5em' }}
                      />
                    </td>
                    {CURVE_FIELDS.map((f) => (
                      <td key={f.key}>
                        {f.kind === 'single' && (
                          <input
                            type="number"
                            value={row[f.key] ?? ''}
                            onChange={(e) => setCurveCell(idx, f.key, e.target.value)}
                            style={{ width: '4.5em' }}
                          />
                        )}
                        {f.kind === 'range' && (
                          <span className="agronomy-targets-range-pair">
                            <input
                              type="number"
                              value={row[f.key]?.[0] ?? ''}
                              onChange={(e) => setCurveRangeCell(idx, f.key, 0, e.target.value)}
                              style={{ width: '5em' }}
                            />
                            {' – '}
                            <input
                              type="number"
                              value={row[f.key]?.[1] ?? ''}
                              onChange={(e) => setCurveRangeCell(idx, f.key, 1, e.target.value)}
                              style={{ width: '5em' }}
                            />
                          </span>
                        )}
                        {f.kind === 'text' && (
                          <input
                            type="text"
                            value={row[f.key] ?? ''}
                            onChange={(e) => setCurveCell(idx, f.key, e.target.value)}
                            style={{ width: '7em' }}
                          />
                        )}
                      </td>
                    ))}
                    <td>
                      <button onClick={() => removeWeekRow(idx)} className="agronomy-targets-remove-btn">✕</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="agronomy-targets-actions">
            <button onClick={addWeekRow}>+ Add week</button>
            <button onClick={saveCurve} disabled={curveSaving}>{curveSaving ? 'Saving…' : 'Save curve'}</button>
            <button onClick={deleteCurve} disabled={deleting} className="agronomy-targets-danger-btn">
              {deleting ? 'Deleting…' : 'Delete this one'}
            </button>
            {curveMsg && (
              <span className={curveMsg.ok ? 'agronomy-targets-msg-ok' : 'agronomy-targets-msg-error'}>{curveMsg.text}</span>
            )}
          </div>
        </>
      )}
    </div>
  )
}
