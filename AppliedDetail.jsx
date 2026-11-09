import { useEffect } from 'react'

// The panel that opens when someone taps an Applied cell on the irrigation
// schedule: what the week's applied inches are made of, or why the cell is
// blank. Same sheet as the ET detail (it reuses its styles).

const BLANK_TEXT = {
  'no-pivot': 'No pivot is linked to this field, so AIO has no run time to count.',
  'no-gpm': 'This pivot has no flow rate (GPM) yet. Upload the sprinkler package PDF on the pivot profile, or type the GPM in by hand.',
  'no-acres': 'AIO has no acres for this field or pivot yet.',
  'not-tracked': 'AIO did not track pivot run time this week. Counting started the week of Nov 9, 2026.',
  'future': 'This week has not started yet.'
}

const ACRES_TEXT = {
  circle: 'The area the pivot waters (circle from its length and wiper angles)',
  'agworld-corner': 'AgWorld acres, which include the corner machine',
  agworld: 'AgWorld acres (the pivot length is not known yet)'
}

const hoursText = (h) => `${(Math.round(h * 10) / 10).toFixed(1)} h`

export default function AppliedDetail({ field, applied, scheduled, weekStart, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const weekEnd = new Date(weekStart); weekEnd.setDate(weekEnd.getDate() + 6)
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const a = applied

  return (
    <div className="et-backdrop" onClick={onClose}>
      <div className="et-sheet" role="dialog" aria-label={`${field.fieldName} applied water`} onClick={(e) => e.stopPropagation()}>
        <div className="et-sheet-head">
          <div>
            <strong>{field.fieldName}</strong>
            <div className="et-sub">Applied water · week of {fmt(weekStart)} – {fmt(weekEnd)}</div>
          </div>
          <button className="et-close" onClick={onClose} aria-label="Close">×</button>
        </div>

        <div className="et-rows">
          {!a.ok && (
            <>
              <div className="et-row"><span>Applied</span><strong>Blank</strong></div>
              <p className="et-note">{BLANK_TEXT[a.reason] || 'Applied water cannot be worked out yet.'}</p>
            </>
          )}
          {a.ok && (
            <>
              <div className="et-row">
                <span>Applied</span>
                <strong>{a.inches.toFixed(2)} in{a.estimate ? ' (estimate)' : ''}</strong>
              </div>
              {scheduled != null && (
                <div className="et-row"><span>Scheduled</span><strong>{scheduled.toFixed(2)} in</strong></div>
              )}
              <div className="et-row"><span>Wet hours</span><strong>{hoursText(a.wetHours)}</strong></div>
              <div className="et-row"><span>Dry hours (running, water off)</span><strong>{hoursText(a.dryHours)}</strong></div>
              <div className="et-row"><span>No-signal hours</span><strong>{hoursText(a.unknownHours)}</strong></div>
              {a.unknownMark && (
                <p className="et-note">
                  For {hoursText(a.unknownHours)} of this week AIO could not tell what the pivot was doing. That time is not counted, so the real number could be up to {a.maxExtra.toFixed(2)} in higher.
                </p>
              )}
              <div className="et-row"><span>GPM</span><strong>{Math.round(a.gpm).toLocaleString()}</strong></div>
              {a.estimate && (
                <p className="et-note">A corner machine changes the flow as it folds out, so this GPM is an average and the inches are an estimate.</p>
              )}
              <div className="et-row"><span>Acres used</span><strong>{a.acres.toFixed(1)}</strong></div>
              <p className="et-note">{ACRES_TEXT[a.acresSource]}.</p>
            </>
          )}
        </div>

        {a.ok && (
          <div className="et-facts">
            <div><span>How it is worked out</span>wet hours x GPM x 60 ÷ (27,154 x acres)</div>
            {a.partialWeek && <div><span>This week</span>Counting started Nov 9, 2026, so this week is partial.</div>}
          </div>
        )}

        <p className="et-foot">
          Run time is checked every 10 minutes for every pivot brand. The flow rate is the pivot's rated GPM, not a measured one.
        </p>
      </div>
    </div>
  )
}
