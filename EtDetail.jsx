import { useEffect } from 'react'
import { CURVES, STATION_NAMES, curveKeyForCrop } from './etMath.js'

// The panel that opens when someone taps a Scheduled or ET cell on the
// irrigation schedule: what the week's ET number is made of, which weather
// station it came from, and why a cell is blank or gray. Slides up from the
// bottom on a phone.

const BAND_TEXT = {
  red: 'Far short of what the crop will use.',
  yellow: 'Somewhat short of what the crop will use.',
  green: 'On target.',
  split: 'The crop\'s need is covered, but more water is scheduled than it will use.',
  gray: 'Can\'t tell yet.'
}

function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}` }

function stationText(stationInfo) {
  if (!stationInfo) return null
  const names = stationInfo.codes.map((c) => STATION_NAMES[c] || c)
  const how = stationInfo.source === 'field' ? 'set for this field' : 'this farm\'s usual station'
  if (names.length > 1) return `Between ${names.join(' and ')} (average of the two), ${how}`
  return `${names[0]} (${stationInfo.codes[0]}), ${how}`
}

// Why the ET cell is blank, in plain words.
function blankReason(field, info) {
  const key = curveKeyForCrop(field.crop)
  if (!field.crop) return 'No crop is set for this field.'
  if (!key) return `There is no crop curve for ${field.crop.toLowerCase()} yet.`
  if (CURVES[key].mode === 'planting' && !field.plantDate) return 'This field has no plant date in AgWorld yet, so AIO can\'t place the crop on its growth curve.'
  if (!info.stationInfo) return 'No weather station is chosen for this farm yet.'
  return 'AIO has not saved any AgriMet weather for this station yet.'
}

// ---- Open-Meteo check (testing) -------------------------------------------
// A side-by-side of today's AgriMet-based daily numbers and Open-Meteo's
// forecast scaled to alfalfa by the station's bump-up ratio. It is for
// comparison only; the ET number above does not use it. Styles are inline so
// this section needs no CSS changes.
const OM_S = {
  box: { borderTop: '0.5px solid #ddd8cc', marginTop: 10, paddingTop: 8, fontSize: 12 },
  title: { fontWeight: 600, fontSize: 12 },
  small: { fontSize: 11, color: '#777', lineHeight: 1.4, margin: '2px 0 6px' },
  // The schedule's global table rules (min-width, fixed layout, max-content) must not apply here.
  table: { width: '100%', minWidth: 0, tableLayout: 'auto', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' },
  th: { textAlign: 'right', fontWeight: 500, color: '#888', padding: '2px 0 2px 8px', fontSize: 11 },
  thL: { textAlign: 'left', fontWeight: 500, color: '#888', padding: '2px 0', fontSize: 11 },
  tdL: { textAlign: 'left', padding: '2px 0' },
  td: { textAlign: 'right', padding: '2px 0 2px 8px', whiteSpace: 'nowrap' },
  tag: { color: '#888', fontSize: 10, marginLeft: 4 },
  total: { borderTop: '0.5px solid #ddd8cc', fontWeight: 600 }
}
const OM_LABELS = { measured: 'measured', forecast: 'forecast', average: 'avg', real: 'real' }

function dayLabel(iso) {
  const d = new Date(`${iso}T12:00:00`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function omStationText(s) {
  const name = STATION_NAMES[s.code] || s.code
  const miles = typeof s.miles === 'number' ? `, ${s.miles} mi away` : ''
  let bump
  if (typeof s.ratio !== 'number') bump = 'no bump-up number yet'
  else if (s.ratioSource === 'rolling') bump = `bump-up ×${s.ratio.toFixed(2)} (measured over the last 30 days${s.ratioAsOf ? `, as of ${s.ratioAsOf}` : ''})`
  else bump = `bump-up ×${s.ratio.toFixed(2)} (backup table)`
  return `${name}${miles} · ${bump}`
}

function OpenMeteoCheck({ omInfo }) {
  if (!omInfo) return null
  const week = omInfo.week
  const cell = (v, src) => (v == null ? <span style={{ color: '#aaa' }}>—</span> : (
    <>{v.toFixed(2)}{src && OM_LABELS[src] && <span style={OM_S.tag}>{OM_LABELS[src]}</span>}</>
  ))
  const diff = week && week.agrimetInches > 0 && week.omInches != null
    ? Math.round(((week.omInches - week.agrimetInches) / week.agrimetInches) * 100) : null
  return (
    <div style={OM_S.box}>
      <div style={OM_S.title}>Open-Meteo check (testing)</div>
      <p style={OM_S.small}>For comparison only. The ET number above does not use this yet.</p>
      {omInfo.failed && <p style={OM_S.small}>Not available right now.</p>}
      {!omInfo.failed && !omInfo.stations.length && <p style={OM_S.small}>No weather station is chosen for this field yet.</p>}
      {omInfo.stations.map((s) => <div key={s.code} style={OM_S.small}>{omStationText(s)}</div>)}
      {omInfo.note && /low confidence/.test(omInfo.note) && (
        <p style={OM_S.small}>This field is more than 25 miles from any station, so treat both numbers as rough.</p>
      )}
      {!omInfo.failed && omInfo.stations.length > 0 && !week && (
        <p style={OM_S.small}>Nothing to compare: this field has no crop curve or plant date yet.</p>
      )}
      {week && (
        <>
          <table style={OM_S.table}>
            <thead>
              <tr><th style={OM_S.thL}>Day (weather ET, inches)</th><th style={OM_S.th}>AgriMet</th><th style={OM_S.th}>Open-Meteo</th></tr>
            </thead>
            <tbody>
              {week.days.map((d) => (
                <tr key={d.date} style={d.kc == null ? { opacity: 0.5 } : undefined}>
                  <td style={OM_S.tdL}>{dayLabel(d.date)}</td>
                  <td style={OM_S.td}>{cell(d.agrimet.value, d.agrimet.source)}</td>
                  <td style={OM_S.td}>{cell(d.om.value, d.om.source)}</td>
                </tr>
              ))}
              <tr style={OM_S.total}>
                <td style={OM_S.tdL}>Week, this crop</td>
                <td style={OM_S.td}>{week.agrimetInches != null ? `${week.agrimetInches.toFixed(2)} in` : '—'}</td>
                <td style={OM_S.td}>{week.omInches != null ? `${week.omInches.toFixed(2)} in` : '—'}</td>
              </tr>
            </tbody>
          </table>
          <p style={OM_S.small}>
            {diff != null ? `Open-Meteo is ${Math.abs(diff)}% ${diff >= 0 ? 'above' : 'below'} the AgriMet-based number this week. ` : ''}
            {week.comparedDays < week.growingDays
              ? `Totals only count the ${week.comparedDays} of ${week.growingDays} growing days where both have a number. `
              : ''}
            "Real" is Open-Meteo's own look at a finished day. No forecast rain is used.
          </p>
        </>
      )}
      <p style={OM_S.small}>
        Weather forecast: <a href="https://open-meteo.com/" target="_blank" rel="noopener noreferrer">Open-Meteo.com</a>
      </p>
    </div>
  )
}

export default function EtDetail({ field, info, omInfo, weekStart, todayIso, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const { et, scheduled, hours, band, share, stationInfo } = info
  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6)
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const curve = et ? CURVES[et.curveKey] : null

  return (
    <div className="et-backdrop" onClick={onClose}>
      <div className="et-sheet" role="dialog" aria-label={`${field.fieldName} water use`} onClick={(e) => e.stopPropagation()}>
        <div className="et-sheet-head">
          <div>
            <strong>{field.fieldName}</strong>
            <div className="et-sub">{field.crop || 'No crop'} · week of {fmt(weekStart)} – {fmt(weekEnd)}</div>
          </div>
          <button className="et-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="et-rows">
          <div className="et-row">
            <span>Scheduled</span>
            <strong>
              {scheduled != null ? `${scheduled.toFixed(2)} in` : (hours > 0 ? `${Math.round(hours)} hours` : 'Nothing scheduled')}
            </strong>
          </div>
          {scheduled == null && hours > 0 && (
            <p className="et-note">Inches need this pivot's flow rate (GPM) and the field's acres. Until they are filled in, AIO shows hours.</p>
          )}
          <div className="et-row">
            <span>ET this week</span>
            <strong>{et ? `${et.inches.toFixed(2)} in` : 'Blank'}</strong>
          </div>
          {!et && <p className="et-note">{blankReason(field, info)}</p>}
          {et && et.demo && (
            <p className="et-note">Demo number: an example forecast for presentations, not real AgriMet weather.</p>
          )}
          {et && !et.demo && (
            <p className="et-note">
              Made of {plural(et.measuredDays, 'measured day')}, {plural(et.forecastDays, 'forecast day')} and {plural(et.averageDays, 'day')} estimated from the recent average
              {et.growingDays < 7 ? `. The crop is only growing ${plural(et.growingDays, 'day')} of this week.` : '.'}
            </p>
          )}
          {share != null && (
            <>
              <div className="et-row">
                <span>Scheduled vs ET</span>
                <strong>{Math.round(share * 100)}%</strong>
              </div>
              <div className="et-verdict"><i className={`swatch sched-${band}`} />{BAND_TEXT[band]}</div>
            </>
          )}
        </div>

        <div className="et-facts">
          {stationInfo && <div><span>Weather station</span>{stationText(stationInfo)}</div>}
          {curve && <div><span>Crop curve</span>{curve.label}{curve.approximate ? ' (approximate)' : ''}</div>}
          {field.plantDate && <div><span>Plant date</span>{field.plantDate}</div>}
          <div><span>As of</span>{todayIso}</div>
        </div>

        <OpenMeteoCheck omInfo={omInfo} />

        <p className="et-foot">
          These are estimates. The weather comes from AgriMet, which labels its data preliminary, and the crop curves are drafts being checked.
          Over-scheduling is only a flag: extra water is sometimes on purpose.
        </p>
      </div>
    </div>
  )
}
