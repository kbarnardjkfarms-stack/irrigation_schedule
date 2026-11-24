import { useEffect, useMemo, useState } from 'react'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase.js'
import aioLogoIcon from './aio-logo-icon.png'

// The vendor's bid page: AIO at /bid/<code>, no sign-in (functions/bidLinks.js).
// Shows only the products JK Farms is asking about, the forecast volume and
// the unit; the vendor types a price for each (their unit, optional discount,
// a note or an alternative product) and submits. They never see other
// vendors or any other pricing. Once awards are published, the same link
// shows what JK Farms is committing to buy from them.

const portal = httpsCallable(functions, 'bidPortal')
const UNIT_LABEL = { gal: 'gal', qt: 'qt', pt: 'pt', floz: 'fl oz', lb: 'lb', oz: 'oz', ton: 'ton', each: 'each', acre: 'acre' }
const fmtDate = (iso) => { if (!iso) return ''; const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) }
const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')
const money = (n) => (n == null || !isFinite(n) ? '—' : `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`)
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[$,\s%]/g, '')); return isFinite(n) ? n : null }

export default function BidPortal({ code }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [form, setForm] = useState({})
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)
  const [openNote, setOpenNote] = useState({})

  function load(d) {
    setData(d)
    const f = {}
    d.lines.forEach((l) => {
      f[l.key] = {
        price: l.mine && l.mine.price != null ? String(l.mine.price) : '',
        unit: (l.mine && l.mine.unit) || l.unit || 'gal',
        discount: l.mine && l.mine.discount != null ? String(Math.round(l.mine.discount * 1000) / 10) : '',
        note: (l.mine && l.mine.note) || '', alt: (l.mine && l.mine.alt) || ''
      }
    })
    setForm(f)
  }
  useEffect(() => {
    document.title = 'JK Farms — bid'
    portal({ code }).then((r) => load(r.data)).catch((e) => setError(e.message || 'Couldn’t open this bid.'))
  }, [code])

  const filled = useMemo(() => Object.values(form).filter((f) => num(f.price) != null).length, [form])
  const set = (k, patch) => setForm((f) => ({ ...f, [k]: { ...f[k], ...patch } }))
  function submit() {
    setSaving(true); setMsg(null)
    const entries = Object.entries(form).map(([key, f]) => ({ key, price: f.price, unit: f.unit, discount: f.discount, note: f.note, alt: f.alt }))
    portal({ code, action: 'submit', entries })
      .then((r) => { load(r.data); setMsg({ ok: true, text: `Thank you — ${r.data.saved} price${r.data.saved === 1 ? '' : 's'} received. You can change them here until bidding closes.` }); window.scrollTo(0, 0) })
      .catch((e) => setMsg({ ok: false, text: e.message || 'Couldn’t save — try again.' }))
      .finally(() => setSaving(false))
  }

  if (error) return <Shell><div className="bp-card"><h2>This link isn’t working</h2><p>{error}</p></div></Shell>
  if (!data) return <Shell><div className="bp-card"><p>Loading…</p></div></Shell>

  const groups = {}
  data.lines.forEach((l) => { (groups[l.class || 'Other'] = groups[l.class || 'Other'] || []).push(l) })
  const awardTotal = (data.awards || []).reduce((s, a) => s + (a.est || 0), 0)
  const tons = (v, u) => (u === 'lb' && v >= 2000 ? ` (${Math.round(v / 2000).toLocaleString()} ton)` : '')

  return (
    <Shell seller={data.seller}>
      <div className="bp-card bp-head">
        <h1>{data.title}</h1>
        <div className="bp-sub">For <b>{data.seller}</b>{data.due ? <> · prices due <b>{fmtDate(data.due)}</b></> : null}</div>
        {data.message && <p className="bp-msg">{data.message}</p>}
        <div className={`bp-status ${data.open ? '' : 'closed'}`}>
          {data.open
            ? (data.submittedAt ? `Your prices were received ${fmtWhen(data.submittedAt)}. You can change them until bidding closes.` : 'Enter a price for each product you can supply, then press Submit. Leave a product blank to skip it.')
            : 'Bidding is closed. Thank you.'}
        </div>
        {msg && <div className={msg.ok ? 'bp-ok' : 'bp-err'}>{msg.text}</div>}
      </div>

      {data.awards && (
        <div className="bp-card bp-awards">
          <h2>Awarded to {data.seller}</h2>
          <p className="bp-sub">The products and volumes JK Farms expects to buy from you this season{data.publishedAt ? ` (as of ${fmtWhen(data.publishedAt)})` : ''}.</p>
          {data.awards.length ? (
            <table className="bp-table">
              <thead><tr><th>Product</th><th className="num">Volume</th><th className="num">Your price</th><th className="num">Est. $</th></tr></thead>
              <tbody>
                {data.awards.map((a, i) => (
                  <tr key={i}><td>{a.name}</td><td className="num">{a.volume != null ? Math.round(a.volume).toLocaleString() : '—'} {UNIT_LABEL[a.unit] || a.unit || ''}{a.volume != null ? tons(a.volume, a.unit) : ''}</td><td className="num">{money(a.price)}/{UNIT_LABEL[a.priceUnit] || a.priceUnit}{a.discount ? ` less ${Math.round(a.discount * 1000) / 10}%` : ''}</td><td className="num">{money(a.est)}</td></tr>
                ))}
              </tbody>
              {awardTotal > 0 && <tfoot><tr><td>Estimated total</td><td /><td /><td className="num"><b>{money(awardTotal)}</b></td></tr></tfoot>}
            </table>
          ) : <p>Nothing was awarded to {data.seller} on this bid. Thank you for bidding.</p>}
        </div>
      )}

      {Object.entries(groups).map(([cls, lines]) => (
        <div key={cls} className="bp-card">
          <h2>{cls}</h2>
          <div className="bp-lines">
            {lines.map((l) => {
              const f = form[l.key] || {}
              return (
                <div key={l.key} className={`bp-line${num(f.price) != null ? ' has' : ''}`}>
                  <div className="bp-prod">
                    <b>{l.name}</b>
                    {l.ai && <span>{l.ai}</span>}
                    <span className="bp-vol">Forecast: <b>{l.forecast != null ? Math.round(l.forecast).toLocaleString() : 'TBD'}</b> {UNIT_LABEL[l.unit] || l.unit}{l.forecast != null ? tons(l.forecast, l.unit) : ''}</span>
                  </div>
                  <div className="bp-inputs">
                    <label><span>Price $</span><input inputMode="decimal" disabled={!data.open} value={f.price || ''} placeholder="—" onChange={(e) => set(l.key, { price: e.target.value })} /></label>
                    <label><span>per</span><select disabled={!data.open} value={f.unit} onChange={(e) => set(l.key, { unit: e.target.value })}>{data.units.map((u) => <option key={u} value={u}>{UNIT_LABEL[u] || u}</option>)}</select></label>
                    <label><span>Discount %</span><input inputMode="decimal" disabled={!data.open} value={f.discount || ''} placeholder="0" onChange={(e) => set(l.key, { discount: e.target.value })} /></label>
                    <button type="button" className="bp-more" onClick={() => setOpenNote((o) => ({ ...o, [l.key]: !o[l.key] }))}>{f.note || f.alt ? 'Note ✓' : '+ Note'}</button>
                  </div>
                  {(openNote[l.key] || f.note || f.alt) && (
                    <div className="bp-notes">
                      <label><span>Alternative product you’d offer (optional)</span><input disabled={!data.open} value={f.alt || ''} onChange={(e) => set(l.key, { alt: e.target.value })} /></label>
                      <label><span>Note (pack size, terms, availability…)</span><input disabled={!data.open} value={f.note || ''} onChange={(e) => set(l.key, { note: e.target.value })} /></label>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      ))}

      {data.open && (
        <div className="bp-submit">
          <span>{filled} of {data.lines.length} priced</span>
          <button disabled={saving} onClick={submit}>{saving ? 'Sending…' : data.submittedAt ? 'Update my prices' : 'Submit prices'}</button>
        </div>
      )}
    </Shell>
  )
}

function Shell({ children, seller }) {
  return (
    <div className="bp">
      <header className="bp-top"><img src={aioLogoIcon} alt="" /><span>JK Farms · request for prices{seller ? ` · ${seller}` : ''}</span></header>
      <main>{children}</main>
      <footer className="bp-foot">This page is private to the company it was sent to. Prices you enter are seen only by JK Farms.</footer>
    </div>
  )
}
