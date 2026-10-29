// Reads an Agworld scouting report CSV in the browser and turns it into the
// rows the importScoutingReport function expects. No library - a small
// RFC-4180 parser (quoted fields, "" escapes, commas and line breaks inside
// quotes, CRLF or LF, optional BOM).

export function parseCsv(text) {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field); field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else field += ch
  }
  if (field !== '' || row.length) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

// "2026-03-30 15:49:00 -0600" -> ISO string. A value with no UTC offset
// (the Timestamp column) is read as UTC.
export function parseAgworldDate(value) {
  const s = String(value || '').trim()
  if (!s) return null
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(?:([+-]\d{2}):?(\d{2})|Z)?$/)
  let d
  if (m) {
    const time = m[2].length === 5 ? `${m[2]}:00` : m[2]
    d = new Date(m[3] ? `${m[1]}T${time}${m[3]}:${m[4]}` : `${m[1]}T${time}Z`)
  } else {
    d = new Date(s)
  }
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

const CORE_HEADERS = new Set(['company name', 'timestamp', 'date', 'location', 'author', 'scout template', 'photos'])

function toNumberIfNumeric(v) {
  const t = String(v).trim()
  if (t === '') return null
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t
}

// Returns { rows, problems, summary }. `rows` are ready to send to the
// importScoutingReport callable.
export function parseScoutingReport(text) {
  const table = parseCsv(text)
  if (table.length < 2) return { rows: [], problems: ['The file has no data rows.'], summary: null }

  const headers = table[0].map((h) => h.trim())
  const idx = (name) => headers.findIndex((h) => h.toLowerCase() === name)
  const iLocation = idx('location')
  const iDate = idx('date')
  const iTimestamp = idx('timestamp')
  const iAuthor = idx('author')
  const iTemplate = idx('scout template')
  const iPhotos = idx('photos')
  const iMoisture = headers.findIndex((h) => /moisture/i.test(h))
  const iComments = headers.findIndex((h) => /comment/i.test(h))

  const problems = []
  if (iLocation === -1) problems.push('No "Location" column found - is this an Agworld scouting report export?')
  if (iDate === -1 && iTimestamp === -1) problems.push('No "Date" or "Timestamp" column found.')
  if (iMoisture === -1) problems.push('No "Field Moisture %" column found - rows will import without a moisture value.')
  if (iLocation === -1 || (iDate === -1 && iTimestamp === -1)) return { rows: [], problems, summary: null }

  const rows = []
  let skipped = 0
  for (let r = 1; r < table.length; r++) {
    const cells = table[r]
    const location = (cells[iLocation] || '').trim()
    const observedAt = parseAgworldDate(iDate !== -1 ? cells[iDate] : '') || parseAgworldDate(iTimestamp !== -1 ? cells[iTimestamp] : '')
    if (!location || !observedAt) { skipped++; continue }

    const values = {}
    headers.forEach((h, c) => {
      if (!h || c === iMoisture || c === iComments || CORE_HEADERS.has(h.toLowerCase())) return
      const v = toNumberIfNumeric(cells[c] ?? '')
      if (v !== null) values[h] = v
    })
    const moistureRaw = iMoisture !== -1 ? toNumberIfNumeric(cells[iMoisture] ?? '') : null
    rows.push({
      location,
      observedAt,
      author: iAuthor !== -1 ? (cells[iAuthor] || '').trim() : '',
      template: iTemplate !== -1 ? (cells[iTemplate] || '').trim() : '',
      moisture: typeof moistureRaw === 'number' ? moistureRaw : null,
      values,
      photos: iPhotos !== -1 ? (cells[iPhotos] || '').trim() : '',
      comments: iComments !== -1 ? (cells[iComments] || '').trim() : ''
    })
  }

  const dates = rows.map((r) => r.observedAt).sort()
  return {
    rows,
    problems,
    summary: {
      rowCount: rows.length,
      skipped,
      locations: new Set(rows.map((r) => r.location.toLowerCase())).size,
      withMoisture: rows.filter((r) => r.moisture != null).length,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null
    }
  }
}
