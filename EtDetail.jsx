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

export default function EtDetail({ field, info, weekStart, todayIso, onClose }) {
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
          {et && (
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

        <p className="et-foot">
          These are estimates. The weather comes from AgriMet, which labels its data preliminary, and the crop curves are drafts being checked.
          Over-scheduling is only a flag: extra water is sometimes on purpose.
        </p>
      </div>
    </div>
  )
}
