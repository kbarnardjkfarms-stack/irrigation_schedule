import { useEffect, useMemo, useState } from 'react'
import { collection, onSnapshot, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import { SAMPLE_TYPE_LABEL, SAMPLE_TYPE_BADGE_COLOR } from './AgronomyConfig.js'

// Assumes firebase.js exports `functions` the same way it already
// exports `db` and `auth` - Users.jsx must already be doing this
// somewhere, since createUser/setUserDisabled/generateSetupLink are
// callable functions too. If firebase.js doesn't export `functions` yet,
// add: `export const functions = getFunctions(app)` there, matching
// however `auth`/`db` are set up.
const reassignSampleField = httpsCallable(functions, 'reassignSampleField')

function fmtDate(ts) {
  if (!ts) return ''
  return ts.toDate().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

export default function AgronomyCleanup({ fields }) {
  const [unmapped, setUnmapped] = useState([])
  const [fuzzy, setFuzzy] = useState([])
  const [savingId, setSavingId] = useState(null)

  useEffect(() => {
    const q = query(collection(db, 'samples'), where('fieldId', '==', null))
    const unsub = onSnapshot(q, (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setUnmapped(list)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const q = query(collection(db, 'samples'), where('fieldMatchType', '==', 'fuzzy'))
    const unsub = onSnapshot(q, (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setFuzzy(list)
    })
    return () => unsub()
  }, [])

  const fieldNameById = useMemo(() => {
    const map = {}
    fields.forEach((f) => { map[f.id] = f.name })
    return map
  }, [fields])

  async function handleAssign(sampleId, fieldId) {
    setSavingId(sampleId)
    try {
      await reassignSampleField({ sampleId, fieldId: fieldId || null })
    } catch (err) {
      console.error('reassignSampleField failed:', err)
      window.alert('Could not save that change - try again.')
    } finally {
      setSavingId(null)
    }
  }

  function TypeBadge({ type }) {
    const color = SAMPLE_TYPE_BADGE_COLOR[type]
    return (
      <span
        className="agronomy-type-badge"
        style={color ? { background: color.bg, color: color.fg } : undefined}
      >
        {SAMPLE_TYPE_LABEL[type] || type || '\u2014'}
      </span>
    )
  }

  return (
    <div className="agronomy-cleanup">
      {fuzzy.length > 0 && (
        <>
          <p className="agronomy-section-label">Suggested matches to confirm ({fuzzy.length})</p>
          <table className="agronomy-cleanup-table">
            <thead>
              <tr><th>Date</th><th>Type</th><th>Label</th><th>Suggested field</th><th></th></tr>
            </thead>
            <tbody>
              {fuzzy.map((s) => (
                <tr key={s.id}>
                  <td>{fmtDate(s.receivedDt)}</td>
                  <td><TypeBadge type={s.type} /></td>
                  <td>{s.rawFieldLabel || '\u2014'}</td>
                  <td>{fieldNameById[s.fieldId] || s.fieldId}</td>
                  <td>
                    <div className="agronomy-cleanup-actions">
                      <button disabled={savingId === s.id} onClick={() => handleAssign(s.id, s.fieldId)}>
                        Confirm
                      </button>
                      <select
                        disabled={savingId === s.id}
                        value=""
                        onChange={(e) => e.target.value && handleAssign(s.id, e.target.value)}
                      >
                        <option value="">Change to...</option>
                        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <p className="agronomy-section-label">Unmapped samples ({unmapped.length})</p>
      <table className="agronomy-cleanup-table">
        <thead>
          <tr><th>Date</th><th>Type</th><th>Label</th><th>Assign to field</th></tr>
        </thead>
        <tbody>
          {unmapped.length === 0 && (
            <tr><td colSpan={4} className="agronomy-table-empty">Nothing to clean up.</td></tr>
          )}
          {unmapped.map((s) => (
            <tr key={s.id}>
              <td>{fmtDate(s.receivedDt)}</td>
              <td><TypeBadge type={s.type} /></td>
              <td>{s.rawFieldLabel || '\u2014'}</td>
              <td>
                <select
                  disabled={savingId === s.id}
                  value=""
                  onChange={(e) => e.target.value && handleAssign(s.id, e.target.value)}
                >
                  <option value="">Select field...</option>
                  {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
