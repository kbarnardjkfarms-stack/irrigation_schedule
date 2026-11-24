import { useState } from 'react'

// Shared "Export to Excel" for every Agronomy tab.
//
//   <ExportExcelButton build={() => ({ filename, sheets })} />
//
// build() runs when the button is pressed (it may be async - the All samples
// tab fetches every matching sample first) and returns:
//   { filename: 'Agronomy - By field - 2026-11-23.xlsx',
//     sheets: [{ name: 'Soil NO3', header: ['Date', ...], rows: [[...], ...] }] }
// Cell values can be numbers, text or JS Dates (shown as real Excel dates);
// null / undefined / '' leave the cell blank. The xlsx library is only loaded
// when someone actually exports, so it adds nothing to the normal page load.

const pad = (n) => String(n).padStart(2, '0')
export const stampToday = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
export const exportFileName = (label) => `Agronomy - ${label} - ${stampToday()}.xlsx`

// Firestore Timestamp / Date / millis -> Date (or null).
export function toDateValue(v) {
  if (v == null || v === '') return null
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v
  if (typeof v.toDate === 'function') return v.toDate()
  if (typeof v === 'number') return new Date(v)
  return null
}

// Lab values often arrive as numeric text ("12.5"): turn those into numbers so
// Excel can sort and add them; anything else stays as it is.
export function cellValue(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim()
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : v
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No'
  if (v instanceof Date) return v
  if (typeof v.toDate === 'function') return v.toDate()
  return String(v)
}

const cleanSheetName = (s) => String(s || 'Sheet').replace(/[\[\]:*?/\\]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 31) || 'Sheet'

export async function downloadWorkbook(filename, sheets) {
  const XLSX = await import('xlsx')
  const wb = XLSX.utils.book_new()
  const used = new Set()
  sheets.forEach((sheet) => {
    const header = sheet.header || null
    const body = (sheet.rows || []).map((r) => r.map(cellValue))
    const aoa = header ? [header, ...body] : body
    const ws = XLSX.utils.aoa_to_sheet(aoa, { cellDates: true })

    const cols = aoa.reduce((n, r) => Math.max(n, r.length), 0)
    const widths = Array.from({ length: cols }, (_, c) => {
      let w = 8
      aoa.slice(0, 300).forEach((r) => {
        const v = r[c]
        const len = v instanceof Date ? 12 : v == null ? 0 : String(v).length
        if (len > w) w = len
      })
      return { wch: Math.min(w + 2, 46) }
    })
    ws['!cols'] = widths

    Object.keys(ws).forEach((addr) => {
      if (addr[0] === '!') return
      const cell = ws[addr]
      if (cell && cell.t === 'd') cell.z = 'mmm d, yyyy'
    })
    if (header && body.length) {
      ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: body.length, c: Math.max(0, cols - 1) } }) }
    }

    let name = cleanSheetName(sheet.name)
    let i = 2
    while (used.has(name.toLowerCase())) name = `${cleanSheetName(sheet.name).slice(0, 28)} ${i++}`
    used.add(name.toLowerCase())
    XLSX.utils.book_append_sheet(wb, ws, name)
  })
  XLSX.writeFile(wb, filename, { cellDates: true })
}

const buttonStyle = {
  padding: '3px 11px',
  borderRadius: 5,
  border: '1px solid #3c5a3f',
  background: '#fff',
  color: '#3c5a3f',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600
}

export default function ExportExcelButton({ build, label = 'Export to Excel', disabled = false, style }) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)

  async function go() {
    setBusy(true)
    setMsg(null)
    try {
      const out = await build((text) => setMsg({ ok: true, text }))
      if (!out || !out.sheets || !out.sheets.length) {
        setMsg({ ok: false, text: 'Nothing to export yet.' })
        return
      }
      await downloadWorkbook(out.filename, out.sheets)
      setMsg(null)
    } catch (err) {
      console.error('Excel export failed:', err)
      setMsg({ ok: false, text: err.message || 'Export failed.' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
      <button type="button" style={{ ...buttonStyle, ...(busy || disabled ? { opacity: 0.55 } : {}), ...style }} disabled={busy || disabled} onClick={go}>
        {busy ? 'Preparing…' : label}
      </button>
      {msg && <span style={{ fontSize: 11, color: msg.ok ? '#555' : '#b3261e' }}>{msg.text}</span>}
    </span>
  )
}
