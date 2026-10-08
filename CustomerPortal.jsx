import { useEffect, useMemo, useState } from 'react'
import { doc, onSnapshot } from 'firebase/firestore'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { db } from './firebase.js'

// Read-only view for a customer login. It only ever reads
// customerViews/{key} for the keys on the person's own profile — a filtered
// copy that Potato Storage publishes (see publishCustomerViews there). It
// never touches the real storage data, which a customer login can't read.

const num = (n) => (n == null ? '\u2014' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 }))

function daysBetween(fromIso, toIso) {
  if (!fromIso) return null
  const from = new Date(fromIso + 'T00:00:00')
  const to = toIso ? new Date(toIso + 'T00:00:00') : new Date()
  const days = Math.round((to - from) / 86400000)
  return Number.isFinite(days) && days >= 0 ? days : null
}

const card = { background: '#fff', border: '1px solid #ddd', borderRadius: '12px', padding: '16px', marginBottom: '16px' }
const th = { padding: '6px 8px', textAlign: 'left', color: '#888', fontSize: '11px', fontWeight: 600 }
const td = { padding: '7px 8px', borderTop: '1px solid #eee', fontSize: '13px' }

function Tile({ label, value, sub }) {
  return (
    <div style={{ flex: '1 1 180px', background: '#f4f2ec', borderRadius: '10px', padding: '12px 14px' }}>
      <div style={{ fontSize: '11px', color: '#888', textTransform: 'uppercase', letterSpacing: '0.05em' }}>{label}</div>
      <div style={{ fontSize: '22px', fontWeight: 700 }}>{value}</div>
      {sub && <div style={{ fontSize: '11px', color: '#888' }}>{sub}</div>}
    </div>
  )
}

function ViewSection({ view }) {
  const fields = view.fields || []
  const shipments = view.shipments || []
  const applications = view.applications || []
  const temps = view.temps || []
  const totalStorage = fields.reduce((s, f) => s + (f.inStorageCwt || 0), 0)
  const totalShipped = fields.reduce((s, f) => s + (f.shippedCwt || 0), 0)

  const tempFieldKeys = useMemo(() => {
    const seen = new Map()
    temps.forEach((t) => { const k = `${t.bay} \u2014 ${t.field}`; if (!seen.has(k)) seen.set(k, { bay: t.bay, field: t.field }) })
    return Array.from(seen.keys())
  }, [temps])
  const [tempField, setTempField] = useState('')
  useEffect(() => { if (!tempField || !tempFieldKeys.includes(tempField)) setTempField(tempFieldKeys[0] || '') }, [tempFieldKeys, tempField])
  const tempSeries = useMemo(
    () => temps.filter((t) => `${t.bay} \u2014 ${t.field}` === tempField).map((t) => ({ date: t.date, Top: t.top, Bottom: t.bottom })),
    [temps, tempField]
  )

  return (
    <div style={{ marginBottom: '32px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '12px' }}>
        <h2 style={{ margin: 0 }}>{view.customer}</h2>
        {view.publishedAt && (
          <span style={{ fontSize: '12px', color: '#888' }}>Latest changes published {new Date(view.publishedAt).toLocaleString()}</span>
        )}
      </div>

      <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '16px' }}>
        <Tile label="In storage" value={`${num(totalStorage)} cwt`} sub={`${fields.length} field${fields.length === 1 ? '' : 's'}`} />
        <Tile label="Shipped" value={`${num(totalShipped)} cwt`} sub={`${shipments.length} load${shipments.length === 1 ? '' : 's'}`} />
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: '8px' }}>Your fields</div>
        {fields.length === 0 ? (
          <div style={{ color: '#888', fontSize: '13px' }}>Nothing is in storage under your name right now.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Field</th><th style={th}>Variety</th><th style={th}>Location</th><th style={th}>Bay</th>
                  <th style={{ ...th, textAlign: 'right' }}>Pipes</th>
                  <th style={{ ...th, textAlign: 'right' }}>In storage (cwt)</th>
                  <th style={{ ...th, textAlign: 'right' }}>Shipped (cwt)</th>
                  <th style={th}>Filled</th><th style={th}>Emptied</th>
                  <th style={{ ...th, textAlign: 'right' }}>Days in storage</th>
                </tr>
              </thead>
              <tbody>
                {fields.map((f, i) => (
                  <tr key={i}>
                    <td style={td}>{f.field}</td><td style={td}>{f.variety || '\u2014'}</td><td style={td}>{f.location}</td><td style={td}>{f.bay}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{num(f.pipes)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{num(f.inStorageCwt)}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{num(f.shippedCwt)}</td>
                    <td style={td}>{f.fillDate || '\u2014'}</td><td style={td}>{f.emptyDate || '\u2014'}</td>
                    <td style={{ ...td, textAlign: 'right' }}>{num(daysBetween(f.fillDate, f.emptyDate))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: '8px' }}>Loads shipped from your fields</div>
        {shipments.length === 0 ? (
          <div style={{ color: '#888', fontSize: '13px' }}>No loads shipped yet.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Field</th><th style={th}>Bay</th><th style={th}>Variety</th><th style={{ ...th, textAlign: 'right' }}>cwt</th></tr></thead>
              <tbody>
                {shipments.map((s, i) => (
                  <tr key={i}><td style={td}>{s.date || '\u2014'}</td><td style={td}>{s.field}</td><td style={td}>{s.bay}</td><td style={td}>{s.variety || '\u2014'}</td><td style={{ ...td, textAlign: 'right' }}>{num(s.cwt)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ fontWeight: 600, marginBottom: '8px' }}>Sprout Nip applications</div>
        {applications.length === 0 ? (
          <div style={{ color: '#888', fontSize: '13px' }}>No applications recorded.</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead><tr><th style={th}>Date</th><th style={th}>Product</th><th style={th}>Rate</th><th style={th}>Field</th><th style={th}>Bay</th><th style={th}>Applicator</th><th style={{ ...th, textAlign: 'right' }}>cwt treated</th></tr></thead>
              <tbody>
                {applications.map((a, i) => (
                  <tr key={i}>
                    <td style={td}>{a.date || '\u2014'}</td><td style={td}>{a.product}</td><td style={td}>{a.rate ? `${a.rate} ${a.rateUnit || ''}` : '\u2014'}</td>
                    <td style={td}>{a.field}</td><td style={td}>{a.bay}</td><td style={td}>{a.applicator || '\u2014'}</td><td style={{ ...td, textAlign: 'right' }}>{num(a.cwtApplied)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '8px' }}>
          <div style={{ fontWeight: 600 }}>Pile temperatures</div>
          {tempFieldKeys.length > 1 && (
            <select value={tempField} onChange={(e) => setTempField(e.target.value)} style={{ padding: '6px', borderRadius: '8px', border: '1px solid #ccc' }}>
              {tempFieldKeys.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          )}
        </div>
        {tempSeries.length === 0 ? (
          <div style={{ color: '#888', fontSize: '13px' }}>No pile temperature readings recorded for your fields yet.</div>
        ) : (
          <>
            <div style={{ fontSize: '11px', color: '#888', marginBottom: '6px' }}>Daily averages (°F) from readings taken at your pipes.</div>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <LineChart data={tempSeries} margin={{ top: 5, right: 12, bottom: 5, left: 0 }}>
                  <CartesianGrid stroke="#eee" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="Top" stroke="#D85A30" dot={false} connectNulls />
                  <Line type="monotone" dataKey="Bottom" stroke="#185FA5" dot={false} connectNulls />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function CustomerPortal({ profile }) {
  const keys = useMemo(() => (Array.isArray(profile?.customerKeys) ? profile.customerKeys : []), [profile])
  // undefined = still loading, null = doc doesn't exist (nothing published yet)
  const [views, setViews] = useState({})
  useEffect(() => {
    setViews({})
    const unsubs = keys.map((key) =>
      onSnapshot(
        doc(db, 'customerViews', key),
        (snap) => setViews((prev) => ({ ...prev, [key]: snap.exists() ? snap.data() : null })),
        () => setViews((prev) => ({ ...prev, [key]: null }))
      )
    )
    return () => unsubs.forEach((u) => u())
  }, [keys])

  if (keys.length === 0) {
    return <div style={{ padding: '24px' }}>Your login isn't linked to a customer yet. Please contact Jentzsch-Kearl Farms.</div>
  }
  return (
    <div style={{ padding: '24px', maxWidth: '1000px', margin: '0 auto' }}>
      {keys.map((key) => {
        const v = views[key]
        if (v === undefined) return <div key={key} style={{ color: '#888' }}>Loading…</div>
        if (v === null) {
          const name = (profile.customers || [])[keys.indexOf(key)] || key
          return <div key={key} style={{ ...card, color: '#666' }}>Nothing has been published for {name} yet. Check back soon.</div>
        }
        return <ViewSection key={key} view={v} />
      })}
    </div>
  )
}
