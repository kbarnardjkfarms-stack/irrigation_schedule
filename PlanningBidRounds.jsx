import { useEffect, useMemo, useState } from 'react'
import { deleteDoc, doc, setDoc, updateDoc } from 'firebase/firestore'
import { httpsCallable } from 'firebase/functions'
import { db, functions } from './firebase.js'
import { docKey, fmt$, quoteMath, toOrder, unitLabel } from './priceMath.js'

// Bids › Send for bids: a bid round for the season (which products, due date,
// a message), one no-login link per vendor (functions/bidLinks.js), who has
// opened / submitted, closing the round, and publishing awards so each
// vendor's link shows what we'll buy from them (plus an email for each).
//
// bidRounds/{season}__{id}: season, title, due, message, productKeys[],
//   status 'open' | 'closed', awardsPublished, publishedAt
// Links live in bidLinks (functions only); prices come back into priceQuotes
// as that vendor's quotes, source "Bid link".

const linkAdmin = httpsCallable(functions, 'bidLinkAdmin')
const linkUrl = (code) => `${window.location.origin}/bid/${code}`
const fmtWhen = (ms) => (ms ? new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '')

export default function BidRounds({ season, rounds, lines, byKey, quotesByKey, sellerNames, sellers, writes }) {
  const mine = rounds.filter((r) => r.season === season).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
  const [roundId, setRoundId] = useState(null)
  const round = mine.find((r) => r.id === roundId) || mine[0] || null
  const [editing, setEditing] = useState(null)
  useEffect(() => { if (round && !roundId) setRoundId(round.id) }, [round, roundId])

  function newRound() {
    const id = `${season}__${Date.now().toString(36)}`
    const classes = [...new Set(lines.map((l) => byKey[l.productKey]?.class).filter(Boolean))]
    setEditing({ id, isNew: true, season, title: `${season} chemical & fertilizer bid`, due: '', message: 'Please quote your best price for the products below. Volumes are our forecast for the season.', productKeys: lines.map((l) => l.productKey), classes })
  }
  function saveRound(r) {
    const { isNew, classes, id, ...data } = r
    writes.run(() => setDoc(doc(db, 'bidRounds', id), { ...data, status: data.status || 'open', ...(isNew ? { createdAt: Date.now() } : {}), ...writes.stamp() }, { merge: true }), 'Bid round saved.')
      .then(() => { setRoundId(id); setEditing(null) })
  }

  return (
    <div className="pr-rounds">
      <div className="pr-rounds-head">
        <b>Send for bids</b>
        {mine.length > 1 && <select value={round ? round.id : ''} onChange={(e) => setRoundId(e.target.value)}>{mine.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select>}
        {round && <span className={`hb-tag ${round.status === 'closed' ? '' : 'soon'}`}>{round.status === 'closed' ? 'closed' : 'open'}{round.awardsPublished ? ' · awards sent' : ''}</span>}
        <span style={{ flex: 1 }} />
        {round && <button onClick={() => setEditing({ ...round })}>Edit round</button>}
        <button onClick={newRound} disabled={!lines.length} title={lines.length ? '' : 'Put products on the bid list first'}>{mine.length ? '+ Another round' : 'Start a bid round…'}</button>
      </div>
      {!round && !editing && <div className="contracts-sub" style={{ marginTop: 4 }}>Build the bid list below, then start a round: pick the products, set a due date, and make a private link for each vendor. Their prices come straight into this table.</div>}
      {editing && <RoundForm r={editing} lines={lines} byKey={byKey} onSave={saveRound} onCancel={() => setEditing(null)} onDelete={editing.isNew ? null : () => { if (window.confirm('Delete this bid round? Vendor links stop working; prices already in stay.')) writes.run(() => deleteDoc(doc(db, 'bidRounds', editing.id))).then(() => { setEditing(null); setRoundId(null) }) }} />}
      {round && !editing && <RoundLinks round={round} byKey={byKey} quotesByKey={quotesByKey} lines={lines} sellerNames={sellerNames} sellers={sellers} writes={writes} />}
    </div>
  )
}

function RoundForm({ r, lines, byKey, onSave, onCancel, onDelete }) {
  const [f, setF] = useState(r)
  const set = (patch) => setF((x) => ({ ...x, ...patch }))
  const keys = new Set(f.productKeys || [])
  const byClass = {}
  lines.forEach((l) => { const p = byKey[l.productKey]; if (p) (byClass[p.class || 'Other'] = byClass[p.class || 'Other'] || []).push(p) })
  const toggle = (k) => { const n = new Set(keys); n.has(k) ? n.delete(k) : n.add(k); set({ productKeys: [...n] }) }
  const toggleClass = (list, on) => { const n = new Set(keys); list.forEach((p) => (on ? n.add(p.key) : n.delete(p.key))); set({ productKeys: [...n] }) }
  return (
    <div className="pr-roundform">
      <div className="hd-grid">
        <label className="hd-field" style={{ gridColumn: 'span 2' }}><span>Title vendors see</span><input value={f.title} onChange={(e) => set({ title: e.target.value })} /></label>
        <label className="hd-field"><span>Prices due</span><input type="date" value={f.due || ''} onChange={(e) => set({ due: e.target.value })} /></label>
        <label className="hd-field"><span>Bidding</span><select value={f.status || 'open'} onChange={(e) => set({ status: e.target.value })}><option value="open">Open</option><option value="closed">Closed</option></select></label>
        <label className="hd-field" style={{ gridColumn: '1 / -1' }}><span>Message to vendors</span><textarea rows={2} value={f.message || ''} onChange={(e) => set({ message: e.target.value })} /></label>
      </div>
      <div className="fm-lab" style={{ marginTop: 8 }}>Products on this round ({keys.size})</div>
      <div className="pr-roundprods">
        {Object.entries(byClass).sort().map(([cls, list]) => {
          const all = list.every((p) => keys.has(p.key))
          return (
            <div key={cls}>
              <label className="hb-check"><input type="checkbox" checked={all} onChange={(e) => toggleClass(list, e.target.checked)} /> <b>{cls}</b></label>
              {list.sort((a, b) => a.name.localeCompare(b.name)).map((p) => <label key={p.key} className="hb-check"><input type="checkbox" checked={keys.has(p.key)} onChange={() => toggle(p.key)} /> {p.name}</label>)}
            </div>
          )
        })}
      </div>
      <div className="fm-row" style={{ marginTop: 10 }}>
        <button className="save" disabled={!f.title.trim() || !keys.size} onClick={() => onSave(f)}>Save round</button>
        <button onClick={onCancel}>Cancel</button>
        {onDelete && <button className="fmf-danger" onClick={onDelete}>Delete round</button>}
      </div>
    </div>
  )
}

function RoundLinks({ round, byKey, quotesByKey, lines, sellerNames, sellers, writes }) {
  const [links, setLinks] = useState(null)
  const [busy, setBusy] = useState(false)
  const [add, setAdd] = useState({ seller: '', email: '', contact: '' })
  const [copied, setCopied] = useState(null)
  const sellerDoc = Object.fromEntries(sellers.map((s) => [s.name, s]))
  function refresh() { linkAdmin({ action: 'list', roundId: round.id }).then((r) => setLinks(r.data.links)).catch((e) => writes.run(() => Promise.reject(e))) }
  // keep Opened / Submitted current while this is open
  useEffect(() => { setLinks(null); refresh(); const t = setInterval(refresh, 30000); return () => clearInterval(t) }, [round.id]) // eslint-disable-line react-hooks/exhaustive-deps

  function create() {
    setBusy(true)
    const seller = add.seller.trim()
    const email = add.email.trim() || (sellerDoc[seller] && sellerDoc[seller].email) || ''
    linkAdmin({ action: 'create', roundId: round.id, seller, email, contact: add.contact.trim() })
      .then(() => { if (email && !(sellerDoc[seller] && sellerDoc[seller].email)) writes.saveSeller(seller, { email }); setAdd({ seller: '', email: '', contact: '' }); refresh() })
      .catch((e) => writes.run(() => Promise.reject(e)))
      .finally(() => setBusy(false))
  }
  function off(l) {
    if (!window.confirm(`Turn off ${l.seller}’s link? It stops working; prices they already sent stay.`)) return
    linkAdmin({ action: 'off', code: l.code }).then(refresh).catch((e) => writes.run(() => Promise.reject(e)))
  }
  function copy(l) { navigator.clipboard.writeText(linkUrl(l.code)).then(() => { setCopied(l.code); setTimeout(() => setCopied(null), 1500) }).catch(() => {}) }

  const due = round.due ? new Date(round.due + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) : null
  const inviteMail = (l) => {
    const subject = `JK Farms — ${round.title}`
    const body = `Hi${l.contact ? ' ' + l.contact.split(' ')[0] : ''},\n\n${round.message || 'Please quote your best price for the products on the link below.'}\n\nYour private bid link (no login needed):\n${linkUrl(l.code)}\n\nIt lists the products with our forecast volumes. Enter a price for each one you can supply and press Submit — you can come back and change your prices${due ? ` until ${due}` : ' until bidding closes'}.\n\nThank you,\nJK Farms`
    return `mailto:${encodeURIComponent(l.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }
  // Each vendor's awards on this round's products, with the volume we commit to.
  const awardsBy = useMemo(() => {
    const out = {}
    ;(round.productKeys || []).forEach((k) => {
      const q = (quotesByKey[k] || []).find((x) => x.season === round.season && x.award)
      if (!q || !q.seller) return
      const p = byKey[k]
      const line = lines.find((l) => l.productKey === k) || {}
      const vol = line.commit != null ? line.commit : toOrder(line)
      const m = quoteMath(q, p && p.family)
      ;(out[q.seller] = out[q.seller] || []).push({ name: p ? p.name : k, vol, unit: line.volUnit || (p && p.family === 'wt' ? 'lb' : 'gal'), q, est: m.net != null ? m.net * vol : null })
    })
    return out
  }, [round, quotesByKey, byKey, lines])
  const commitMail = (l) => {
    const list = awardsBy[l.seller] || []
    const subject = `JK Farms — ${round.title}: awarded products`
    const rows = list.map((a) => `  • ${a.name}: ${Math.round(a.vol).toLocaleString()} ${unitLabel(a.unit)} at ${fmt$(a.q.price)}/${unitLabel(a.q.unit)}${a.q.discount ? ` less ${Math.round(a.q.discount * 1000) / 10}%` : ''}`).join('\n')
    const body = list.length
      ? `Hi${l.contact ? ' ' + l.contact.split(' ')[0] : ''},\n\nThank you for your bid. JK Farms is awarding you the following for ${round.season}, with the volumes we expect to commit to:\n\n${rows}\n\nThe same list is on your bid link: ${linkUrl(l.code)}\n\nThank you,\nJK Farms`
      : `Hi${l.contact ? ' ' + l.contact.split(' ')[0] : ''},\n\nThank you for bidding on ${round.title}. We won’t be awarding you any products on this round.\n\nThank you,\nJK Farms`
    return `mailto:${encodeURIComponent(l.email || '')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
  }
  const priced = (l) => (round.productKeys || []).filter((k) => (quotesByKey[k] || []).some((q) => q.season === round.season && q.seller === l.seller && q.source === 'Bid link')).length
  const awardedCount = Object.values(awardsBy).reduce((s, a) => s + a.length, 0)

  return (
    <div className="pr-links">
      <div className="contracts-sub" style={{ marginTop: 0 }}>
        <button className="clear-sort-btn" style={{ float: 'right' }} onClick={refresh}>Refresh</button>
        {(round.productKeys || []).length} products{round.due ? ` · due ${round.due}` : ''} · each vendor sees only the products, our forecast volume and the unit — never other vendors or prices. Their prices show up in the table below as they submit.
      </div>
      <div className="table-scroll">
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>Vendor</th><th>Email</th><th>Opened</th><th>Submitted</th><th className="num">Priced</th><th /></tr></thead>
          <tbody>
            {(links || []).map((l) => (
              <tr key={l.code}>
                <td><b>{l.seller}</b>{l.contact ? <div className="contracts-sub" style={{ marginTop: 0 }}>{l.contact}</div> : null}</td>
                <td>{l.email || <span className="contracts-sub">—</span>}</td>
                <td>{l.openedAt ? fmtWhen(l.openedAt) : <span className="contracts-sub">not yet</span>}</td>
                <td>{l.submittedAt ? fmtWhen(l.submittedAt) : <span className="contracts-sub">not yet</span>}</td>
                <td className="num">{priced(l)} / {(round.productKeys || []).length}</td>
                <td style={{ whiteSpace: 'nowrap' }}>
                  <a className="fm-linkbtn" href={inviteMail(l)}>Email link</a>
                  <button className="clear-sort-btn" onClick={() => copy(l)}>{copied === l.code ? 'Copied' : 'Copy link'}</button>
                  <a className="clear-sort-btn" href={linkUrl(l.code)} target="_blank" rel="noreferrer">Open</a>
                  {round.awardsPublished && <a className="fm-linkbtn" href={commitMail(l)}>Email awards{awardsBy[l.seller] ? ` (${awardsBy[l.seller].length})` : ''}</a>}
                  <button className="clear-sort-btn" onClick={() => off(l)} title="Turn this link off">✕</button>
                </td>
              </tr>
            ))}
            {links && !links.length && <tr><td colSpan={6} className="contracts-sub">No vendor links yet — add one below.</td></tr>}
            {!links && <tr><td colSpan={6} className="contracts-sub">Loading links…</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="fm-row" style={{ marginTop: 8 }}>
        <input className="yields-cell-input" style={{ width: 160, textAlign: 'left' }} list="pr-round-sellers" placeholder="Vendor (e.g. VWC)" value={add.seller}
          onChange={(e) => { const v = e.target.value; setAdd((a) => ({ ...a, seller: v, email: a.email || (sellerDoc[v] && sellerDoc[v].email) || '', contact: a.contact || (sellerDoc[v] && sellerDoc[v].contact) || '' })) }} />
        <datalist id="pr-round-sellers">{sellerNames.filter((s) => s !== 'Agworld').map((s) => <option key={s} value={s} />)}</datalist>
        <input className="yields-cell-input" style={{ width: 210, textAlign: 'left' }} type="email" placeholder="Email" value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} />
        <input className="yields-cell-input" style={{ width: 150, textAlign: 'left' }} placeholder="Contact name" value={add.contact} onChange={(e) => setAdd({ ...add, contact: e.target.value })} />
        <button className="save" disabled={busy || !add.seller.trim()} onClick={create}>{busy ? 'Making…' : 'Make link'}</button>
      </div>
      <div className="pr-round-actions">
        {round.status !== 'closed'
          ? <button onClick={() => writes.run(() => updateDoc(doc(db, 'bidRounds', round.id), { status: 'closed', closedAt: Date.now(), ...writes.stamp() }), 'Bidding closed — vendors can still see their prices but not change them.')}>Close bidding</button>
          : <button onClick={() => writes.run(() => updateDoc(doc(db, 'bidRounds', round.id), { status: 'open', ...writes.stamp() }), 'Bidding reopened.')}>Reopen bidding</button>}
        {!round.awardsPublished
          ? <button className="save" disabled={!awardedCount} title={awardedCount ? '' : 'Award sellers in the table below first'} onClick={() => { if (window.confirm(`Publish ${awardedCount} awards? Each vendor’s link will show the products and volumes awarded to them (only theirs).`)) writes.run(() => updateDoc(doc(db, 'bidRounds', round.id), { awardsPublished: true, publishedAt: Date.now(), status: 'closed', ...writes.stamp() }), 'Awards published — use “Email awards” to send each vendor theirs.') }}>Publish awards ({awardedCount})</button>
          : <button onClick={() => writes.run(() => updateDoc(doc(db, 'bidRounds', round.id), { publishedAt: Date.now(), ...writes.stamp() }), 'Awards updated on the vendor links.')}>Update published awards</button>}
        {round.awardsPublished && <button onClick={() => writes.run(() => updateDoc(doc(db, 'bidRounds', round.id), { awardsPublished: false, ...writes.stamp() }), 'Awards taken off the vendor links.')}>Unpublish</button>}
        <span className="contracts-sub" style={{ marginTop: 0 }}>Committed volume = the line’s Commit number, or (need − on hand) × 95%.</span>
      </div>
    </div>
  )
}

export { docKey }
