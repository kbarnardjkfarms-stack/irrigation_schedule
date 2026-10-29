import { useState } from 'react'
import { doc, serverTimestamp, writeBatch } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { parseYieldRows, fmt } from './yieldMath.js'

// Admin/Owner-only importer for "THE Yield Database.xlsx" (sheet "Database").
// Parses in the browser, shows what it found, then writes one
// yieldHistory/{FIELDKEY}__{YEAR} doc per row. Re-importing the same
// workbook later just updates those docs in place (same ids), and never
// touches the `agworld` part of a doc that the nightly Agworld sync writes.
export default function YieldImport({ existingById }) {
  const [parsed, setParsed] = useState(null)
  const [fileName, setFileName] = useState('')
  const [error, setError] = useState(null)
  const [progress, setProgress] = useState(null) // { done, total }
  const [result, setResult] = useState(null)

  async function onFile(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    setError(null); setParsed(null); setResult(null); setFileName(file.name)
    try {
      // Loaded on demand so the spreadsheet library never weighs down the
      // app for people who don't import.
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { cellDates: true })
      const sheetName = wb.SheetNames.find((n) => n.trim().toLowerCase() === 'database') || wb.SheetNames[0]
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: null })
      const out = parseYieldRows(rows)
      setParsed({ ...out, sheetName })
    } catch (err) {
      setError(err.message || String(err))
    }
  }

  async function runImport() {
    if (!parsed) return
    const recs = parsed.records
    setProgress({ done: 0, total: recs.length }); setError(null)
    const who = auth.currentUser ? (auth.currentUser.email || auth.currentUser.uid) : null
    try {
      for (let i = 0; i < recs.length; i += 400) {
        const batch = writeBatch(db)
        recs.slice(i, i + 400).forEach((r) => {
          const { id, ...data } = r
          batch.set(doc(db, 'yieldHistory', id), {
            ...data, source: 'spreadsheet', importedAt: serverTimestamp(), importedBy: who, importFile: fileName
          }, { merge: true })
        })
        await batch.commit()
        setProgress({ done: Math.min(i + 400, recs.length), total: recs.length })
      }
      setResult(`Imported ${fmt(recs.length)} field-years.`)
    } catch (err) {
      setError(err.code === 'permission-denied'
        ? 'No permission to write yield history. Only Admin/Owner can import, and the new firestore.rules must be deployed.'
        : (err.message || String(err)))
    } finally {
      setProgress(null)
    }
  }

  const summary = parsed && (() => {
    const crops = {}, years = new Set()
    let withYield = 0, isNew = 0
    parsed.records.forEach((r) => {
      crops[r.crop || '(none)'] = (crops[r.crop || '(none)'] || 0) + 1
      years.add(r.year)
      if (r.yieldPerAcre > 0) withYield++
      if (!existingById[r.id]) isNew++
    })
    const ys = [...years].sort()
    return { crops: Object.entries(crops).sort((a, b) => b[1] - a[1]), from: ys[0], to: ys[ys.length - 1], withYield, isNew, fields: new Set(parsed.records.map((r) => r.fieldKey)).size }
  })()

  return (
    <div className="editor-panel yields-import">
      <div className="editor-field-name">Import yield history from a spreadsheet</div>
      <p className="contracts-sub">
        Use “THE Yield Database.xlsx” (or a newer copy). The <strong>Database</strong> sheet is read; columns are matched by
        header name. Re-importing updates the same field-year records, so it’s safe to run again after the workbook is edited.
      </p>
      <input type="file" accept=".xlsx,.xlsm,.xls" onChange={onFile} disabled={!!progress} />
      {error && <div className="agronomy-error-banner" style={{ marginTop: 10 }}>{error}</div>}
      {summary && (
        <>
          <div className="agronomy-kpi-grid" style={{ marginTop: 12 }}>
            <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Field-years found</p><p className="agronomy-kpi-value">{fmt(parsed.records.length)}</p></div>
            <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">With a yield</p><p className="agronomy-kpi-value">{fmt(summary.withYield)}</p></div>
            <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">Fields · years</p><p className="agronomy-kpi-value">{fmt(summary.fields)} <span className="agronomy-kpi-unit">{summary.from}–{summary.to}</span></p></div>
            <div className="agronomy-kpi-card"><p className="agronomy-kpi-label">New vs. update</p><p className="agronomy-kpi-value">{fmt(summary.isNew)} <span className="agronomy-kpi-unit">new · {fmt(parsed.records.length - summary.isNew)} update</span></p></div>
          </div>
          <div className="contracts-sub">By crop: {summary.crops.map(([c, n]) => `${c} ${n}`).join(' · ')}</div>
          {parsed.warnings.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="contracts-sub">{parsed.warnings.length} row{parsed.warnings.length === 1 ? '' : 's'} skipped</summary>
              <ul className="contracts-sub">{parsed.warnings.slice(0, 50).map((w) => <li key={w}>{w}</li>)}</ul>
            </details>
          )}
          <div className="editor-row" style={{ marginTop: 12 }}>
            <button className="save" disabled={!!progress} onClick={runImport}>
              {progress ? `Importing… ${fmt(progress.done)} / ${fmt(progress.total)}` : `Import ${fmt(parsed.records.length)} field-years`}
            </button>
          </div>
        </>
      )}
      {result && <div className="yields-ok">{result}</div>}
    </div>
  )
}
