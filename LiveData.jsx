import { useEffect, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from './firebase.js'

// Sensor "kind" is inferred from the device naming convention already in
// use (PC- = pulse counter, TL- = tank level). Anything else falls back
// to a generic "Other" group rather than being hidden.
function kindForDeviceName(name) {
  if (name.startsWith('PC-')) return 'Pulse counters'
  if (name.startsWith('TL-')) return 'Tank level'
  if (name.startsWith('RG-')) return 'Rain gauges'
  return 'Other'
}

function fmtTimeAgo(date) {
  if (!date) return 'never'
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return seconds + 's ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return minutes + 'm ago'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours + 'h ' + (minutes % 60) + 'm ago'
  const days = Math.floor(hours / 24)
  return days + 'd ago'
}

// A reading is "stale" once it's more than twice as old as it should be,
// given how often that sensor type is expected to report. This just flags
// it visually — it doesn't hide anything.
function isStale(lastSeen) {
  if (!lastSeen) return true
  const ageMinutes = (Date.now() - lastSeen.getTime()) / 60000
  return ageMinutes > 30
}

export default function LiveData() {
  const [devices, setDevices] = useState([])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'devices'), (snap) => {
      const list = []
      snap.forEach((d) => {
        const data = d.data()
        list.push({
          id: d.id,
          devEui: data.devEui || null,
          lastSeen: data.lastSeen ? data.lastSeen.toDate() : null,
          latest: data.latest || {}
        })
      })
      list.sort((a, b) => a.id.localeCompare(b.id))
      setDevices(list)
    })
    return () => unsub()
  }, [])

  const groups = devices.reduce((acc, dev) => {
    const kind = kindForDeviceName(dev.id)
    if (!acc[kind]) acc[kind] = []
    acc[kind].push(dev)
    return acc
  }, {})

  const groupOrder = ['Pulse counters', 'Tank level', 'Rain gauges', 'Other']

  if (devices.length === 0) {
    return (
      <div className="live-data-empty">
        No sensor data yet. Once a device sends its first uplink, it'll show up here automatically.
      </div>
    )
  }

  return (
    <div className="live-data">
      {groupOrder
        .filter((kind) => groups[kind] && groups[kind].length > 0)
        .map((kind) => (
          <div key={kind} className="live-data-group">
            <h2 className="live-data-group-title">{kind}</h2>
            <div className="live-data-cards">
              {groups[kind].map((dev) => {
                const stale = isStale(dev.lastSeen)
                const decoded = dev.latest.decoded || {}
                return (
                  <div key={dev.id} className={`live-data-card ${stale ? 'stale' : ''}`}>
                    <div className="live-data-card-header">
                      <strong>{dev.id}</strong>
                      <span className={`live-data-dot ${stale ? 'stale' : 'ok'}`} />
                    </div>
                    <div className="live-data-last-seen">
                      Last seen: {fmtTimeAgo(dev.lastSeen)}
                    </div>
                    <div className="live-data-fields">
                      {Object.entries(decoded).map(([key, val]) => (
                        <div key={key} className="live-data-field">
                          <span className="live-data-field-key">{key}</span>
                          <span className="live-data-field-val">{String(val)}</span>
                        </div>
                      ))}
                    </div>
                    <div className="live-data-radio">
                      RSSI {dev.latest.rssi ?? '—'} · SNR {dev.latest.snr ?? '—'}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
    </div>
  )
}
