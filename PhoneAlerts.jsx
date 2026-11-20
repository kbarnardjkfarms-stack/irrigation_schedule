// Account menu > Phone alerts: turn this phone's AIO alerts On/Off (Spray field-done and Irrigation
// "parked wet" alerts, whichever the Users screen switched on for this person) and send yourself a
// test. Same phone setup the Spray screen uses (sprayPush.js).
import { useEffect, useState } from 'react'

async function turnOnHere() {
  const m = await import('./sprayPush.js')
  const r = await m.turnOn()
  const state = await m.pushState()
  const msg = r && r.ok === false ? (r.error === 'blocked' ? 'Alerts are blocked for AIO in this phone\'s settings.' : r.error || 'Couldn\'t turn alerts on.') : ''
  return { state, msg }
}

export function PhoneAlertsSwitch({ alerts }) {
  const [state, setState] = useState('')
  useEffect(() => { import('./sprayPush.js').then((m) => m.pushState()).then(setState).catch(() => setState('unsupported')) }, [])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)   // { ok, text }
  const what = [alerts && alerts.spray && 'Spray', alerts && alerts.irrigation && 'Irrigation'].filter(Boolean).join(' + ')
  const choose = async (v) => {
    if ((v === 'on') === (state === 'on')) return
    setBusy(true); setMsg(null)
    try {
      if (v === 'off') { const m = await import('./sprayPush.js'); await m.turnOff(); setState('off') }
      else { const r = await turnOnHere(); setState(r.state); if (r.msg) setMsg({ ok: false, text: r.msg }) }
    } catch (e) { setMsg({ ok: false, text: e.message || String(e) }) }
    setBusy(false)
  }
  const test = async () => {
    setBusy(true); setMsg(null)
    try {
      const m = await import('./sprayPush.js')
      const r = await m.sendTest()
      setMsg(r && r.tested ? { ok: true, text: 'Sent to this phone' + (r.phones > 1 ? ' and your other ' + (r.phones - 1) : '') + '. It should pop up in a few seconds.' }
        : { ok: false, text: 'Nothing was sent: no phone is set up for you yet. Turn alerts On first.' })
    } catch (e) { setMsg({ ok: false, text: e.message || String(e) }) }
    setBusy(false)
  }
  const can = state === 'on' || state === 'off'
  return (
    <div style={{ fontSize: '12px', color: '#555', marginBottom: '12px', borderTop: '1px solid #eee', paddingTop: '10px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
        <strong>Phone alerts</strong>
        {can
          ? <select value={state} disabled={busy} onChange={(e) => choose(e.target.value)} style={{ fontSize: '12px', padding: '3px 6px', borderRadius: '6px', border: '1px solid #ccc' }}>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
          : <span style={{ color: '#888' }}>{state === 'ios-home' ? 'Open AIO from the Home Screen icon' : state === 'blocked' ? 'Blocked in phone settings' : state ? 'Not on this device' : ''}</span>}
      </div>
      <div style={{ color: '#888', marginTop: '3px' }}>{what ? 'You get: ' + what : 'No alerts are switched on for you (Users screen).'}</div>
      {can && <button disabled={busy || state !== 'on'} onClick={test} style={{ width: '100%', marginTop: '8px', fontSize: '12px' }}>{busy ? 'Working…' : 'Send test alert'}</button>}
      {msg && <div style={{ color: msg.ok ? '#3c5a3f' : '#a3261e', marginTop: '5px' }}>{msg.text}</div>}
    </div>
  )
}
