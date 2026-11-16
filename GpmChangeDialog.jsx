import { useState } from 'react'
import { historyOf } from './gpmHistory.js'

// Asked whenever a pivot that already has a GPM is given a different one: was the old number a mistake, or did the
// pivot really change (new package / nozzles)? A mistake replaces the number for every season; a real change only
// applies from a date, so earlier seasons keep the GPM the pivot really had.
function todayLocal() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function GpmChangeDialog({ profile, newGpm, busy, onCancel, onChoose }) {
  const oldGpm = Number(profile && profile.currentGpm)
  const hist = historyOf(profile)
  const last = hist.length ? hist[hist.length - 1] : null
  const minDate = last && last.from ? last.from : ''
  // A number set in the last two weeks is most likely being fixed, anything older is most likely a real change.
  const setAt = (last && last.setAt) || (profile && profile.gpmConfirmedAt) || null
  const recent = setAt ? (Date.now() - new Date(setAt).getTime()) < 14 * 24 * 3600 * 1000 : false
  const [mode, setMode] = useState(recent ? 'correction' : 'new')
  const [from, setFrom] = useState(todayLocal())
  const badDate = mode === 'new' && (!from || (minDate && from < minDate))
  const box = { display: 'block', padding: '10px 12px', border: '1px solid #ddd', borderRadius: 8, marginBottom: 8, cursor: 'pointer' }
  const on = { ...box, borderColor: '#2b2b26', background: '#f4f2ec' }
  return (
    <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
      <div role="dialog" aria-label="GPM change" style={{ background: '#fff', borderRadius: 10, padding: 20, width: 360, maxWidth: '92vw', boxShadow: '0 4px 20px rgba(0,0,0,0.2)', color: '#2b2b26' }}>
        <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>Change GPM from {oldGpm} to {newGpm}?</div>
        <div style={{ fontSize: 12, color: '#666', marginBottom: 12 }}>Reports for past seasons use the GPM the pivot had at the time, so tell AIO which kind of change this is.</div>
        <label style={mode === 'correction' ? on : box}>
          <input type="radio" name="gpmmode" checked={mode === 'correction'} onChange={() => setMode('correction')} />{' '}
          <b style={{ fontSize: 13 }}>Fixing a mistake</b>
          <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>{oldGpm} was wrong. {newGpm} replaces it for every season, past and future.</div>
        </label>
        <label style={mode === 'new' ? on : box}>
          <input type="radio" name="gpmmode" checked={mode === 'new'} onChange={() => setMode('new')} />{' '}
          <b style={{ fontSize: 13 }}>The pivot changed</b>
          <div style={{ fontSize: 12, color: '#555', marginTop: 2 }}>New package or nozzles. {newGpm} applies from the date below. Earlier weeks keep {oldGpm}.</div>
          {mode === 'new' && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 12 }}>Changed on </span>
              <input type="date" aria-label="Date the pivot changed" value={from} min={minDate || undefined} onChange={(e) => setFrom(e.target.value)} />
              {badDate && <div style={{ fontSize: 11, color: '#A32D2D', marginTop: 4 }}>{minDate && from && from < minDate ? `Pick ${minDate} or later (the last change was then).` : 'Pick a date.'}</div>}
            </div>
          )}
        </label>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 12 }}>
          <button type="button" onClick={onCancel} disabled={busy} style={{ fontSize: 13 }}>Cancel</button>
          <button type="button" onClick={() => onChoose({ mode, from: mode === 'new' ? from : null })} disabled={busy || badDate} style={{ fontSize: 13, background: '#2b2b26', color: '#fff', border: 'none', borderRadius: 6, padding: '6px 14px' }}>{busy ? 'Saving…' : `Save ${newGpm} GPM`}</button>
        </div>
      </div>
    </div>
  )
}
