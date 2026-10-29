import { useEffect, useMemo, useState } from 'react'
import { collection, limit, onSnapshot, query, where } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import { parseScoutingReport } from './scoutingCsv.js'

const importScoutingReport = httpsCallable(functions, 'importScoutingReport', { timeout: 300000 })
const assignScoutingLocation = httpsCallable(functions, 'assignScoutingLocation', { timeout: 120000 })

const CHUNK = 500

function fmtDay(iso) {
  return iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
}

// Upload tab for Agworld scouting reports (the "Weekly Dig" export from the
// scout app / scouting report feature). Parses the CSV in the browser, sends
// it to the importScoutingReport function in chunks, and lists any Location
// names that didn't match a field so they can be assigned once (the choice
// is remembered for every future upload).
export default function AgronomyScouting({ fields }) {
  const [fileName, setFileName] = useState('')
  const [parsed, setParsed] = useState(null)
  const [importing, setImporting] = useState(false)
  const [progress, setProgress] = useState(null)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [assigningLabel, setAssigningLabel] = useState(null)

  // Observations that still have no field - the persistent "to assign" list.
  const [unassigned, setUnassigned] = useState([])
  useEffect(() => {
    const q = query(collection(db, 'scoutingObservations'), where('fieldId', '==', null), limit(2000))
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list = []
        snap.forEach((d) => list.push(d.data()))
        setUnassigned(list)
      },
      (err) => {
        console.error('scoutingObservations (unassigned) query failed:', err)
        setError(err.message)
      }
    )
    return () => unsub()
  }, [])

  const unassignedGroups = useMemo(() => {
    const byLabel = {}
    unassigned.forEach((o) => {
      const key = o.rawLocation || '(blank)'
      byLabel[key] = (byLabel[key] || 0) + 1
    })
    return Object.entries(byLabel)
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count)
  }, [unassigned])

  async function handleFile(e) {
    const file = e.target.files && e.target.files[0]
    setResult(null)
    setError(null)
    setParsed(null)
    if (!file) return
    setFileName(file.name)
    try {
      const text = await file.text()
      setParsed(parseScoutingReport(text))
    } catch (err) {
      console.error('Could not read scouting file:', err)
      setError('Could not read that file.')
    }
  }

  async function runImport() {
    if (!parsed || !parsed.rows.length) return
    setImporting(true)
    setError(null)
    setResult(null)
    const total = { saved: 0, newRows: 0, updatedRows: 0, matchedRows: 0, unmatchedRows: 0, skippedRows: 0 }
    try {
      for (let i = 0; i < parsed.rows.length; i += CHUNK) {
        setProgress(`Uploading ${Math.min(i + CHUNK, parsed.rows.length)} of ${parsed.rows.length}...`)
        const res = await importScoutingReport({ rows: parsed.rows.slice(i, i + CHUNK) })
        Object.keys(total).forEach((k) => { total[k] += res.data[k] || 0 })
      }
      setResult(total)
      setParsed(null)
      setFileName('')
    } catch (err) {
      console.error('importScoutingReport failed:', err)
      setError(err.message || 'Import failed.')
    } finally {
      setImporting(false)
      setProgress(null)
    }
  }

  async function assign(label, fieldId) {
    if (!fieldId) return
    setAssigningLabel(label)
    try {
      await assignScoutingLocation({ location: label, fieldId })
    } catch (err) {
      console.error('assignScoutingLocation failed:', err)
      window.alert('Could not save that - try again.')
    } finally {
      setAssigningLabel(null)
    }
  }

  const summary = parsed && parsed.summary

  return (
    <div className="agronomy-scouting">
      {error && <p className="agronomy-error-banner">{error}</p>}

      <p className="agronomy-section-label">Upload an Agworld scouting report</p>
      <div className="agronomy-automatch">
        <p className="agronomy-targets-hint">
          In Agworld, open the scouting report (Scout) and export it as a CSV, then pick that file here. Re-uploading a
          bigger or newer report is safe - rows already here are updated, not duplicated. Field Moisture % shows on
          the By field tab; the other columns (variety, stems per seed piece, tuber set, tuber weight, comments) are
          kept too.
        </p>
        <div className="agronomy-automatch-controls">
          <input type="file" accept=".csv,text/csv" onChange={handleFile} disabled={importing} />
          {parsed && parsed.rows.length > 0 && (
            <button disabled={importing} onClick={runImport}>
              {importing ? progress || 'Importing...' : `Import ${parsed.rows.length} rows`}
            </button>
          )}
        </div>
        {parsed && parsed.problems.map((p, i) => <p key={i} className="agronomy-error-banner">{p}</p>)}
        {summary && (
          <p className="agronomy-automatch-summary">
            {fileName}: {summary.rowCount} rows across {summary.locations} locations, {fmtDay(summary.firstDate)} to{' '}
            {fmtDay(summary.lastDate)}; {summary.withMoisture} have a Field Moisture %
            {summary.skipped ? `; ${summary.skipped} skipped (no location or date)` : ''}.
          </p>
        )}
        {result && (
          <p className="agronomy-automatch-summary">
            Done: {result.saved} rows saved ({result.newRows} new, {result.updatedRows} already there).{' '}
            {result.matchedRows} matched a field; {result.unmatchedRows} still need a field (below).
          </p>
        )}
      </div>

      {unassignedGroups.length > 0 && (
        <>
          <p className="agronomy-section-label">
            Locations that didn't match a field ({unassigned.length}{unassigned.length >= 2000 ? '+' : ''} rows)
          </p>
          <div className="agronomy-automatch-table-wrap">
            <table className="agronomy-cleanup-table">
              <thead>
                <tr><th>Location in Agworld report</th><th>Rows</th><th>Assign to field</th></tr>
              </thead>
              <tbody>
                {unassignedGroups.map((g) => (
                  <tr key={g.label}>
                    <td>{g.label}</td>
                    <td>{g.count}</td>
                    <td>
                      <select
                        disabled={assigningLabel === g.label}
                        value=""
                        onChange={(e) => assign(g.label, e.target.value)}
                      >
                        <option value="">{assigningLabel === g.label ? 'Saving...' : 'Select field...'}</option>
                        {fields.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </td>
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
