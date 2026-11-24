import { Fragment, useEffect, useMemo, useState } from 'react'
import { collection, deleteDoc, doc, onSnapshot, setDoc, updateDoc, writeBatch } from 'firebase/firestore'
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { auth, db } from './firebase.js'
import BidRounds from './PlanningBidRounds.jsx'
import {
  CLASSES, buildProducts, changePct, compareQuotes, docKey, familyOf, fmt$, matchKey, money, normSeller, normUnit, parseAgworld,
  parseComparison, pct, productKey, quoteMath, quoteSig, seasonSeries, toOrder, unitLabel, unitSlips
} from './priceMath.js'

// Planning › Prices & bids — the AIO version of the yearly
// "Price Comparison Chemical & Fertilizer" workbooks, plus Agworld's price list.
//
//   Bids            one season's bid list: what we need (volume, on hand, what
//                   to order at 95%), every seller's quote side by side after
//                   discount, cheapest highlighted, award a seller, totals by
//                   seller and what the awards cost over the cheapest bids
//   Price history   every product's prices by season and seller back to 2020,
//                   chart + table; product details (AI, MOA, PHI, chemigation,
//                   rates, plantbacks); merge two names that are one product
//   Sellers         discount programs and terms per seller
//   Accountability  awarded price vs what was invoiced
//   Import          the 2020–2026 history (bundled), another comparison
//                   workbook, or an Agworld price list export
//
// Data (firestore.rules — Admin/Owner edit, Farm manager with Contracts views):
//   priceProducts/{key}     one product: name, aliases, class, kind (product |
//                           operation | seed), family (vol | wt), ai, moa, phi…
//   priceQuotes/{id}        one price: productKey, season, seller, price, unit,
//                           rate, rateUnit, discount, award, invoicePrice, source
//   priceSellers/{key}      discount %, programs / terms, contact, notes
//   priceBids/{season}__{productKey}  bid line: volume, onHand, commit, notes
//   bidRounds/{id}          a round sent to vendors through no-login links
//                           (PlanningBidRounds.jsx, functions/bidLinks.js)

const who = () => (auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null)
const SEASON_NOW = new Date().getFullYear() + (new Date().getMonth() >= 7 ? 1 : 0)
function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(36) }
export const quoteId = (q) => `q_${hash(quoteSig(q) + '|' + (q.source || ''))}`
const SELLER_COLORS = ['#2A6FD6', '#E8801A', '#2E9B4F', '#7B4FC9', '#D23B3B', '#0F8C8C', '#B5487A', '#8C6D1F', '#5B5F66']
const pctStr = (p) => (p == null ? '—' : `${p > 0 ? '+' : ''}${Math.round(p * 1000) / 10}%`)

export default function PlanningPrices({ userRole }) {
  const canEdit = userRole === 'admin' || userRole === 'owner'
  const [view, setView] = useState('bids')
  const [products, setProducts] = useState(null)
  const [quotes, setQuotes] = useState([])
  const [sellers, setSellers] = useState([])
  const [bids, setBids] = useState([])
  const [rounds, setRounds] = useState([])
  const [error, setError] = useState(null)
  const [msg, setMsg] = useState(null)
  const [openKey, setOpenKey] = useState(null)

  useEffect(() => {
    const onErr = (e) => setError(e.code === 'permission-denied' ? 'No permission to read prices. If the tab was just added, the new firestore.rules may not be deployed yet.' : e.message)
    const list = (set) => (snap) => { const o = []; snap.forEach((d) => o.push({ id: d.id, ...d.data() })); set(o); setError(null) }
    const u = [
      onSnapshot(collection(db, 'priceProducts'), list(setProducts), onErr),
      onSnapshot(collection(db, 'priceQuotes'), list(setQuotes), onErr),
      onSnapshot(collection(db, 'priceSellers'), list(setSellers), onErr),
      onSnapshot(collection(db, 'priceBids'), list(setBids), onErr),
      onSnapshot(collection(db, 'bidRounds'), list(setRounds), () => setRounds([]))
    ]
    return () => u.forEach((x) => x())
  }, [])

  const byKey = useMemo(() => Object.fromEntries((products || []).map((p) => [p.key, p])), [products])
  const quotesByKey = useMemo(() => {
    const m = {}
    quotes.forEach((q) => { (m[q.productKey] = m[q.productKey] || []).push(q) })
    return m
  }, [quotes])
  const sellerNames = useMemo(() => {
    const s = new Set(sellers.map((x) => x.name))
    quotes.forEach((q) => { if (q.seller) s.add(q.seller) })
    return [...s].sort()
  }, [quotes, sellers])

  function run(fn, ok) {
    setMsg(null)
    return Promise.resolve().then(fn).then(() => ok && setMsg({ ok: true, text: ok }))
      .catch((e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin or Owner can change prices.' : (e.message || String(e)) }))
  }
  async function commitAll(ops) {
    for (let i = 0; i < ops.length; i += 400) {
      const b = writeBatch(db)
      ops.slice(i, i + 400).forEach(([kind, ref, data]) => (kind === 'del' ? b.delete(ref) : b.set(ref, data, { merge: true })))
      await b.commit()
    }
  }
  const stamp = () => ({ updatedBy: who(), updatedAt: Date.now() })
  const writes = {
    run, commitAll, stamp,
    saveQuote: (q) => {
      const id = q.id || quoteId({ ...q, key: q.productKey })
      const { id: _drop, ...data } = q
      return run(() => setDoc(doc(db, 'priceQuotes', id), { ...data, ...stamp() }, { merge: true }), 'Saved.')
    },
    patchQuote: (id, patch) => run(() => updateDoc(doc(db, 'priceQuotes', id), { ...patch, ...stamp() })),
    deleteQuote: (id) => run(() => deleteDoc(doc(db, 'priceQuotes', id)), 'Price deleted.'),
    saveProduct: (key, patch) => run(() => setDoc(doc(db, 'priceProducts', docKey(key)), { key, ...patch, ...stamp() }, { merge: true }), 'Saved.'),
    saveSeller: (name, patch) => run(() => setDoc(doc(db, 'priceSellers', docKey(name.toLowerCase())), { name, ...patch, ...stamp() }, { merge: true }), 'Saved.'),
    saveBid: (season, key, patch) => run(() => setDoc(doc(db, 'priceBids', `${season}__${docKey(key)}`), { season, productKey: key, ...patch, ...stamp() }, { merge: true })),
    dropBid: (season, key) => run(() => deleteDoc(doc(db, 'priceBids', `${season}__${docKey(key)}`))),
    // Two names that are one product: move every price to `into` and keep the old name as an alias.
    merge: (fromKey, intoKey) => run(async () => {
      const from = byKey[fromKey], into = byKey[intoKey]
      const ops = (quotesByKey[fromKey] || []).map((q) => ['set', doc(db, 'priceQuotes', q.id), { productKey: intoKey, mergedFrom: fromKey }])
      bids.filter((b) => b.productKey === fromKey).forEach(({ id, ...b }) => {
        ops.push(['set', doc(db, 'priceBids', `${b.season}__${docKey(intoKey)}`), { ...b, productKey: intoKey }])
        ops.push(['del', doc(db, 'priceBids', id)])
      })
      const aliases = [...new Set([...(into.aliases || []), from.name, ...(from.aliases || [])])].filter((n) => n !== into.name)
      ops.push(['set', doc(db, 'priceProducts', docKey(intoKey)), { aliases, ...(into.agworldId || !from.agworldId ? {} : { agworldId: from.agworldId, agworldName: from.agworldName || from.name }), ...stamp() }])
      ops.push(['del', doc(db, 'priceProducts', docKey(fromKey))])
      await commitAll(ops)
      setOpenKey(intoKey)
    }, `Merged “${byKey[fromKey]?.name}” into “${byKey[intoKey]?.name}”.`)
  }

  const ctx = { products: products || [], byKey, quotes, quotesByKey, sellers, sellerNames, bids, rounds, canEdit, writes, setOpenKey, setView }
  const tabs = [['bids', 'Bids'], ['history', 'Price history'], ['sellers', 'Sellers & discounts'], ['account', 'Supplier accountability'], ...(canEdit ? [['import', 'Import']] : [])]
  const open = openKey ? byKey[openKey] : null

  return (
    <div className="agronomy prices">
      {error && <div className="agronomy-error-banner">{error}</div>}
      <div className="agronomy-view-toggle harvest-tabs">
        {tabs.map(([k, l]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>)}
        <span className="contracts-sub" style={{ marginTop: 0, alignSelf: 'center' }}>
          {products == null ? 'Loading…' : `${products.length} products · ${quotes.length} prices`}
          {!canEdit && ' · view only'}
        </span>
      </div>
      {msg && <div className={msg.ok ? 'yields-ok harvest-msg' : 'agronomy-error-banner'} onClick={() => setMsg(null)}>{msg.text}</div>}
      {products && !products.length && view !== 'import' && (
        <div className="yields-card">
          <div className="yields-card-title">No prices yet</div>
          <div className="contracts-sub">{canEdit ? <>Go to <button className="link-btn" onClick={() => setView('import')}>Import</button> and load the 2020–2026 price history from the comparison workbooks and Agworld.</> : 'An Admin or Owner needs to load the price history first.'}</div>
        </div>
      )}
      {products && products.length > 0 && view === 'bids' && <Bids {...ctx} />}
      {products && products.length > 0 && view === 'history' && <History {...ctx} />}
      {products && view === 'sellers' && <Sellers {...ctx} />}
      {products && products.length > 0 && view === 'account' && <Accountability {...ctx} />}
      {products && view === 'import' && canEdit && <Import {...ctx} />}
      {open && <ProductDrawer p={open} {...ctx} onClose={() => setOpenKey(null)} />}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Product search (used by Bids and the merge picker)
// ---------------------------------------------------------------------------
function ProductPicker({ products, onPick, placeholder = 'Find a product…', exclude }) {
  const [q, setQ] = useState('')
  const hits = useMemo(() => {
    const s = q.trim().toLowerCase()
    if (s.length < 2) return []
    return products.filter((p) => p.key !== exclude && `${p.name} ${(p.aliases || []).join(' ')} ${p.ai || ''}`.toLowerCase().includes(s)).slice(0, 12)
  }, [q, products, exclude])
  return (
    <div className="pr-picker">
      <input className="agronomy-search-input" placeholder={placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
      {hits.length > 0 && (
        <div className="pr-picker-list">
          {hits.map((p) => <button key={p.key} onClick={() => { onPick(p); setQ('') }}><b>{p.name}</b><span>{[p.class, p.ai].filter(Boolean).join(' · ')}</span></button>)}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Bids
// ---------------------------------------------------------------------------
function Bids({ products, byKey, quotesByKey, sellerNames, sellers, bids, rounds, canEdit, writes, setOpenKey }) {
  const seasons = useMemo(() => {
    const s = new Set([SEASON_NOW, SEASON_NOW - 1])
    bids.forEach((b) => s.add(b.season))
    Object.values(quotesByKey).flat().forEach((q) => s.add(q.season))
    return [...s].filter((y) => y >= 2020).sort((a, b) => b - a)
  }, [bids, quotesByKey])
  const [season, setSeason] = useState(SEASON_NOW)
  const [cls, setCls] = useState('all')
  const [adding, setAdding] = useState(null) // productKey for the quote form
  const lines = bids.filter((b) => b.season === season && byKey[b.productKey])
  const sellersIn = useMemo(() => {
    const s = new Set()
    lines.forEach((l) => (quotesByKey[l.productKey] || []).forEach((q) => { if (q.season === season && q.seller && q.seller !== 'Agworld') s.add(q.seller) }))
    return [...s].sort()
  }, [lines, quotesByKey, season])

  const rows = lines.map((l) => {
    const p = byKey[l.productKey]
    const all = quotesByKey[l.productKey] || []
    const now = compareQuotes(all.filter((q) => q.season === season && q.seller !== 'Agworld'), p)
    const bySeller = {}
    now.forEach((q) => { if (q.net != null && (!bySeller[q.seller] || q.net < bySeller[q.seller].net)) bySeller[q.seller] = q })
    const best = now.find((q) => q.net != null) || null
    const awarded = now.find((q) => q.award) || null
    const series = seasonSeries(all.filter((q) => q.season < season && q.seller !== 'Agworld'), p)
    const last = series.length ? series[series.length - 1] : null
    const order = l.commit != null ? Number(l.commit) : toOrder(l)
    return { l, p, bySeller, best, awarded, last, order }
  }).filter((r) => cls === 'all' || r.p.class === cls)
    .sort((a, b) => (a.p.class || '').localeCompare(b.p.class || '') || a.p.name.localeCompare(b.p.name))

  const totals = {}
  let cheapest = 0, awardedTotal = 0, awardedCheapest = 0
  rows.forEach((r) => {
    if (r.best && r.order) cheapest += r.order * r.best.net
    if (r.awarded && r.order && r.awarded.net != null) {
      totals[r.awarded.seller] = (totals[r.awarded.seller] || 0) + r.order * r.awarded.net
      awardedTotal += r.order * r.awarded.net
      if (r.best) awardedCheapest += r.order * r.best.net
    }
  })
  const classes = [...new Set(lines.map((l) => byKey[l.productKey].class).filter(Boolean))].sort()

  function award(r, q) {
    const ops = (quotesByKey[r.l.productKey] || []).filter((x) => x.season === season && (x.award || x.id === q.id))
      .map((x) => ['set', doc(db, 'priceQuotes', x.id), { award: x.id === q.id && !q.award, ...writes.stamp() }])
    writes.run(() => writes.commitAll(ops))
  }
  function startFrom(prev) {
    const prevLines = bids.filter((b) => b.season === prev)
    const keys = prevLines.length ? prevLines.map((b) => b.productKey)
      : [...new Set(Object.values(quotesByKey).flat().filter((q) => q.season === prev && q.seller !== 'Agworld').map((q) => q.productKey))]
    const have = new Set(lines.map((l) => l.productKey))
    const ops = keys.filter((k) => !have.has(k) && byKey[k]).map((k) => {
      const pl = prevLines.find((b) => b.productKey === k)
      return ['set', doc(db, 'priceBids', `${season}__${docKey(k)}`), { season, productKey: k, volume: pl ? pl.volume ?? null : null, volUnit: pl ? pl.volUnit || null : null, ...writes.stamp() }]
    })
    writes.run(() => writes.commitAll(ops), `Added ${ops.length} products from ${prev}.`)
  }

  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Bids for {season}</div>
          <div className="contracts-sub">Prices after each seller’s discount, per gallon or pound so different package sizes line up. Green = cheapest; • = came in through a bid link. Volumes in gal / lb; commit = what we’ll buy, (needed − on hand) × 95% unless you type one.</div>
        </div>
        <div className="agronomy-filter-bar" style={{ margin: 0 }}>
          <select value={season} onChange={(e) => setSeason(+e.target.value)}>{seasons.map((y) => <option key={y} value={y}>{y}</option>)}</select>
          <select value={cls} onChange={(e) => setCls(e.target.value)}><option value="all">All classes</option>{classes.map((c) => <option key={c}>{c}</option>)}</select>
          {canEdit && <button onClick={() => startFrom(season - 1)} title={`Copies ${season - 1}’s bid list (or every product priced in ${season - 1})`}>Start from {season - 1}</button>}
        </div>
      </div>
      {canEdit && <BidRounds season={season} rounds={rounds} lines={lines} byKey={byKey} quotesByKey={quotesByKey} sellerNames={sellerNames} sellers={sellers} writes={writes} />}
      {canEdit && <div className="pr-addline"><ProductPicker products={products} placeholder="Add a product to this bid…" onPick={(p) => writes.saveBid(season, p.key, {})} /></div>}

      {rows.length > 0 && (
        <div className="pr-totals">
          <div><span>Cheapest bids</span><b>{fmt$(cheapest, 0)}</b></div>
          <div><span>Awarded</span><b>{fmt$(awardedTotal, 0)}</b>{awardedTotal > awardedCheapest + 1 && <small>{fmt$(awardedTotal - awardedCheapest, 0)} over cheapest</small>}</div>
          {Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([s, v]) => <div key={s}><span>{s}</span><b>{fmt$(v, 0)}</b></div>)}
        </div>
      )}

      <div className="table-scroll" style={{ maxHeight: 640 }}>
        <table className="contracts-table contracts-table-auto pr-bids">
          <thead>
            <tr>
              <th>Product</th><th className="num">Need</th><th className="num">On hand</th><th className="num" title="What we commit to buy: (need − on hand) × 95%, or type a number">Commit</th>
              <th className="num" title="Cheapest price the season before">Last yr</th>
              {sellersIn.map((s) => <th key={s} className="num">{s}</th>)}
              <th className="num">Change</th><th className="num">Est. $</th>{canEdit && <th />}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const bu = r.p.family === 'wt' ? 'lb' : 'gal'
              const use = r.awarded || r.best
              return (
                <tr key={r.l.id}>
                  <td><button className="link-btn" onClick={() => setOpenKey(r.p.key)}>{r.p.name}</button><div className="contracts-sub" style={{ marginTop: 0 }}>{[r.p.class, r.p.ai].filter(Boolean).join(' · ')}</div></td>
                  <td className="num">{canEdit ? <NumIn v={r.l.volume} on={(v) => writes.saveBid(season, r.p.key, { volume: v })} /> : r.l.volume ?? ''}<small> {bu}</small></td>
                  <td className="num">{canEdit ? <NumIn v={r.l.onHand} on={(v) => writes.saveBid(season, r.p.key, { onHand: v })} /> : r.l.onHand ?? ''}</td>
                  <td className="num">{canEdit ? <NumIn v={r.l.commit} placeholder={toOrder(r.l) ? String(Math.round(toOrder(r.l))) : ''} on={(v) => writes.saveBid(season, r.p.key, { commit: v })} /> : (r.order ? Math.round(r.order).toLocaleString() : '—')}</td>
                  <td className="num">{r.last ? fmt$(r.last.best) : '—'}</td>
                  {sellersIn.map((s) => {
                    const q = r.bySeller[s]
                    if (!q) return <td key={s} className="num pr-none">—</td>
                    const isBest = r.best && q.id === r.best.id
                    return (
                      <td key={s} className={`num pr-quote${isBest ? ' best' : ''}${q.award ? ' award' : ''}`} title={`${fmt$(q.price)}/${unitLabel(q.unit)}${q.discount ? ` less ${Math.round(q.discount * 1000) / 10}%` : ''}${q.perAcre != null ? ` · ${fmt$(q.perAcre)}/ac at ${q.rate} ${unitLabel(q.rateUnit)}` : ''}${q.conflict ? ` · ⚠ also ${q.conflict}` : ''}${q.source === 'Bid link' ? ' · from their bid link' : ''}${q.altProduct ? ` · offers instead: ${q.altProduct}` : ''}${q.note ? ` · ${q.note}` : ''}`}>
                        {q.source === 'Bid link' && <span className="pr-viabid">•</span>}{fmt$(q.net)}{q.award && ' ★'}{(q.altProduct || q.note) && <span className="pr-hasnote" title={[q.altProduct && `Alternative: ${q.altProduct}`, q.note].filter(Boolean).join(' · ')}>ⓘ</span>}
                        {canEdit && <button className="pr-award" onClick={() => award(r, q)} title={q.award ? 'Take the award back' : `Award to ${s}`}>{q.award ? 'awarded' : 'award'}</button>}
                      </td>
                    )
                  })}
                  <td className={`num ${use && r.last ? (use.net > r.last.best ? 'pr-up' : 'pr-down') : ''}`}>{use && r.last ? pctStr((use.net - r.last.best) / r.last.best) : '—'}</td>
                  <td className="num">{use && r.order ? fmt$(use.net * r.order, 0) : '—'}</td>
                  {canEdit && <td style={{ whiteSpace: 'nowrap' }}><button className="clear-sort-btn" onClick={() => setAdding(r.p.key)}>+ quote</button><button className="clear-sort-btn" onClick={() => writes.dropBid(season, r.p.key)} title="Take off this bid list">✕</button></td>}
                </tr>
              )
            })}
            {!rows.length && <tr><td colSpan={8 + sellersIn.length} className="contracts-sub">Nothing on the {season} bid list yet. {canEdit ? `Add products above, or “Start from ${season - 1}”.` : ''}</td></tr>}
          </tbody>
        </table>
      </div>
      {adding && <QuoteForm product={byKey[adding]} season={season} sellerNames={sellerNames} writes={writes} onClose={() => setAdding(null)} />}
    </div>
  )
}

function NumIn({ v, on, w = 80, placeholder = '' }) {
  const [s, setS] = useState(v ?? '')
  useEffect(() => { setS(v ?? '') }, [v])
  return <input className="yields-cell-input" style={{ width: w }} inputMode="decimal" placeholder={placeholder} value={s} onChange={(e) => setS(e.target.value)}
    onBlur={() => { const n = s === '' ? null : Number(s); if ((n ?? null) !== (v ?? null) && (n == null || isFinite(n))) on(n) }} />
}

const UNITS = ['gal', 'qt', 'pt', 'floz', 'lb', 'oz', 'ton', 'each', 'acre']
function QuoteForm({ product, season, sellerNames, writes, onClose, quote }) {
  const [f, setF] = useState(() => quote ? { ...quote, discount: quote.discount != null ? Math.round(quote.discount * 1000) / 10 : '' }
    : { seller: '', price: '', unit: product.family === 'wt' ? 'lb' : 'gal', discount: '', rate: product.defaultRate ?? '', rateUnit: product.rateUnit || (product.family === 'wt' ? 'lb' : 'floz'), note: '' })
  const set = (patch) => setF((x) => ({ ...x, ...patch }))
  const q = { price: money(f.price), unit: f.unit, discount: pct(f.discount === '' ? null : `${f.discount}%`), rate: money(f.rate), rateUnit: f.rateUnit }
  const m = quoteMath(q, product.family || familyOf(f.unit))
  function save() {
    const data = {
      productKey: product.key, season: quote ? quote.season : season, seller: normSeller(f.seller) || f.seller.trim(), price: q.price, unit: f.unit,
      discount: q.discount, rate: q.rate, rateUnit: q.rate != null ? f.rateUnit : null, note: f.note || null, source: quote ? quote.source : 'Entered in AIO'
    }
    writes.saveQuote(quote ? { ...data, id: quote.id } : data).then(onClose)
  }
  return (
    <div className="pr-modal" onClick={onClose}>
      <div className="pr-modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="yields-card-title">{quote ? 'Edit price' : 'New quote'} — {product.name} · {quote ? quote.season : season}</div>
        <div className="hd-grid" style={{ marginTop: 10 }}>
          <label className="hd-field"><span>Seller</span><input list="pr-sellers" value={f.seller} onChange={(e) => set({ seller: e.target.value })} /></label>
          <datalist id="pr-sellers">{sellerNames.map((s) => <option key={s} value={s} />)}</datalist>
          <label className="hd-field"><span>Price</span><input inputMode="decimal" value={f.price} onChange={(e) => set({ price: e.target.value })} /></label>
          <label className="hd-field"><span>Per</span><select value={f.unit} onChange={(e) => set({ unit: e.target.value })}>{UNITS.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}</select></label>
          <label className="hd-field"><span>Discount %</span><input inputMode="decimal" value={f.discount} placeholder="0" onChange={(e) => set({ discount: e.target.value })} /></label>
          <label className="hd-field"><span>Rate / ac</span><input inputMode="decimal" value={f.rate} onChange={(e) => set({ rate: e.target.value })} /></label>
          <label className="hd-field"><span>Rate unit</span><select value={f.rateUnit} onChange={(e) => set({ rateUnit: e.target.value })}>{UNITS.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}</select></label>
          <label className="hd-field" style={{ gridColumn: '1 / -1' }}><span>Note</span><input value={f.note || ''} onChange={(e) => set({ note: e.target.value })} /></label>
        </div>
        <div className="contracts-sub">{m.net != null ? `${fmt$(m.net)} per ${m.baseUnit || unitLabel(f.unit)} after discount${m.perAcre != null ? ` · ${fmt$(m.perAcre)}/ac` : ''}` : 'Enter a price.'}</div>
        <div className="fm-row" style={{ marginTop: 10 }}>
          <button className="save" disabled={q.price == null || !f.seller.trim()} onClick={save}>Save</button>
          <button onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Price history
// ---------------------------------------------------------------------------
function History({ products, quotesByKey, setOpenKey }) {
  const [q, setQ] = useState('')
  const [cls, setCls] = useState('all')
  const [kind, setKind] = useState('product')
  const [sort, setSort] = useState('name')
  const [onlyCheck, setOnlyCheck] = useState(false)
  const rows = useMemo(() => products.filter((p) => (kind === 'all' || (p.kind || 'product') === kind) && (cls === 'all' || p.class === cls))
    .filter((p) => !q || `${p.name} ${(p.aliases || []).join(' ')} ${p.ai || ''}`.toLowerCase().includes(q.toLowerCase()))
    .map((p) => {
      const qs = quotesByKey[p.key] || []
      const series = seasonSeries(qs.filter((x) => x.seller !== 'Agworld'), p)
      const ag = qs.filter((x) => x.seller === 'Agworld').sort((a, b) => b.season - a.season)[0]
      const last = series[series.length - 1]
      const slips = unitSlips(qs, p).size
      return { p, n: qs.length, series, last, change: changePct(series), ag: ag ? quoteMath(ag, p.family) : null, agQ: ag, conflict: qs.some((x) => x.conflict), slips }
    })
    .filter((r) => !onlyCheck || r.conflict || r.slips)
    .sort((a, b) => sort === 'change' ? (Math.abs(b.change || 0) - Math.abs(a.change || 0)) : sort === 'count' ? b.n - a.n : a.p.name.localeCompare(b.p.name)), [products, quotesByKey, q, cls, kind, sort, onlyCheck])
  const classes = [...new Set(products.map((p) => p.class).filter(Boolean))].sort()
  return (
    <>
    {q.trim().length >= 2 && <TrendChart rows={rows} setOpenKey={setOpenKey} />}
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Price history</div>
          <div className="contracts-sub">Cheapest price after discount each season, per gal or lb (seeds and custom work in their own unit). Click a product for every price by seller, a chart and its details.</div>
        </div>
        <div className="agronomy-filter-bar" style={{ margin: 0 }}>
          <input className="agronomy-search-input" placeholder="Product or active ingredient…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select value={kind} onChange={(e) => setKind(e.target.value)}><option value="product">Chemical & fertilizer</option><option value="seed">Seed</option><option value="operation">Custom operations</option><option value="all">Everything</option></select>
          <select value={cls} onChange={(e) => setCls(e.target.value)}><option value="all">All classes</option>{classes.map((c) => <option key={c}>{c}</option>)}</select>
          <select value={sort} onChange={(e) => setSort(e.target.value)}><option value="name">Sort: name</option><option value="change">Sort: biggest change</option><option value="count">Sort: most prices</option></select>
          <label className="hb-check"><input type="checkbox" checked={onlyCheck} onChange={(e) => setOnlyCheck(e.target.checked)} /> Only prices to check</label>
        </div>
      </div>
      <div className="table-scroll" style={{ maxHeight: 640 }}>
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>Product</th><th>Class</th><th>Active ingredient</th><th className="num">Latest</th><th className="num">Season</th><th className="num">Change</th><th className="num">Agworld</th><th className="num">Prices</th></tr></thead>
          <tbody>
            {rows.slice(0, 400).map(({ p, n, last, change, ag, agQ, conflict, slips }) => (
              <tr key={p.key} className="clickable" onClick={() => setOpenKey(p.key)}>
                <td><b>{p.name}</b>{conflict && <span className="hb-tag warn" title="The same product, season and seller has two different prices in the files">2 prices</span>}{slips > 0 && <span className="hb-tag warn" title="A price more than 3× off this product's usual price — probably a per-oz price in a per-gal column (or similar)">unit?</span>}</td>
                <td>{p.class || ''}</td><td className="contracts-sub" style={{ marginTop: 0 }}>{p.ai || ''}</td>
                <td className="num">{last ? `${fmt$(last.best)}/${p.family === 'wt' ? 'lb' : p.family === 'vol' ? 'gal' : '—'}` : '—'}</td>
                <td className="num">{last ? last.season : ''}</td>
                <td className={`num ${change > 0 ? 'pr-up' : change < 0 ? 'pr-down' : ''}`}>{pctStr(change)}</td>
                <td className="num">{agQ ? `${fmt$(ag.net ?? agQ.price)}/${ag.baseUnit || unitLabel(agQ.unit)}` : ''}</td>
                <td className="num">{n}</td>
              </tr>
            ))}
            {rows.length > 400 && <tr><td colSpan={8} className="contracts-sub">{rows.length - 400} more — narrow the search.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
    </>
  )
}

// The price trend for what the search found: one matching product → a line
// per seller plus the cheapest each season; several → the cheapest price of
// each (up to 6, the ones with the longest history). "Indexed" puts every
// line at 100 in its first season so a $5/lb and a $900/gal product can be
// compared on how much they've moved.
function TrendChart({ rows, setOpenKey }) {
  const [mode, setMode] = useState('price')
  const withHist = rows.filter((r) => r.series.length >= 2).sort((a, b) => b.series.length - a.series.length || b.n - a.n)
  if (!withHist.length) {
    return rows.length ? <div className="yields-card pr-trend"><div className="contracts-sub" style={{ marginTop: 0 }}>Not enough seasons of prices to chart {rows.length === 1 ? `“${rows[0].p.name}”` : 'these products'} — it takes at least two.</div></div> : null
  }
  const single = withHist.length === 1
  const shown = withHist.slice(0, 6)
  // Fertilizer is talked about per ton, so dry fert shows $/ton (2000 × $/lb).
  const perTon = (p) => p.family === 'wt' && /fert/i.test(p.class || '')
  const unitOf = (p) => (perTon(p) ? 'ton' : p.family === 'wt' ? 'lb' : p.family === 'vol' ? 'gal' : 'unit')
  const mult = (p) => (perTon(p) ? 2000 : 1)
  const index = (series, k) => { const first = series.find((x) => x[k] != null); return first ? (v) => (v == null ? null : (v / first[k]) * 100) : () => null }
  let lines, data
  if (single) {
    const r = shown[0]
    const sellers = [...new Set(r.series.flatMap((x) => Object.keys(x).filter((k) => k !== 'season' && k !== 'best')))]
    lines = [{ key: 'best', name: 'Cheapest', color: '#1d1d1b', width: 3, dash: '5 3' }, ...sellers.map((sl, i) => ({ key: sl, name: sl, color: SELLER_COLORS[i % SELLER_COLORS.length], width: 2 }))]
    const ix = Object.fromEntries(lines.map((l) => [l.key, index(r.series, l.key)]))
    const m = mult(r.p)
    data = r.series.map((x) => Object.fromEntries([['season', x.season], ...lines.map((l) => [l.key, mode === 'index' ? ix[l.key](x[l.key]) : x[l.key] != null ? x[l.key] * m : null])]))
  } else {
    lines = shown.map((r, i) => ({ key: r.p.key, name: `${r.p.name} ($/${unitOf(r.p)})`, color: SELLER_COLORS[i % SELLER_COLORS.length], width: 2 }))
    const seasons = [...new Set(shown.flatMap((r) => r.series.map((x) => x.season)))].sort()
    data = seasons.map((season) => {
      const o = { season }
      shown.forEach((r) => {
        const x = r.series.find((y) => y.season === season)
        o[r.p.key] = x ? (mode === 'index' ? index(r.series, 'best')(x.best) : x.best * mult(r.p)) : null
      })
      return o
    })
  }
  const first = single ? shown[0].series[0] : null
  const last = single ? shown[0].series[shown[0].series.length - 1] : null
  const fmtV = (v) => (mode === 'index' ? `${Math.round(v)}` : fmt$(v))
  return (
    <div className="yields-card pr-trend">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">
            {single ? <>Price trend — <button className="link-btn" onClick={() => setOpenKey(shown[0].p.key)}>{shown[0].p.name}</button></> : `Price trend — ${shown.length} of ${withHist.length} products`}
          </div>
          <div className="contracts-sub">
            {single
              ? `Per ${unitOf(shown[0].p)} after discount, by seller. ${first.season} → ${last.season}: ${fmt$(first.best * mult(shown[0].p))} → ${fmt$(last.best * mult(shown[0].p))} (${pctStr((last.best - first.best) / first.best)}).`
              : `Cheapest price each season after discount.${withHist.length > 6 ? ' Narrow the search to see others.' : ''} Click a line’s name to open it.`}
          </div>
        </div>
        <div className="agronomy-view-toggle" style={{ margin: 0 }}>
          <button className={mode === 'price' ? 'active' : ''} onClick={() => setMode('price')}>Price</button>
          <button className={mode === 'index' ? 'active' : ''} onClick={() => setMode('index')} title="First season = 100, so products at very different prices can be compared">Indexed</button>
        </div>
      </div>
      <div style={{ height: 260 }}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 8, right: 16, left: 4, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#eee9de" />
            <XAxis dataKey="season" type="number" domain={['dataMin', 'dataMax']} ticks={data.map((d) => d.season)} allowDecimals={false} tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} width={64} tickFormatter={(v) => (mode === 'index' ? v : `$${v >= 100 ? Math.round(v) : v}`)} domain={['auto', 'auto']} />
            <Tooltip formatter={(v, name) => [v == null ? '—' : fmtV(v), name]} labelFormatter={(l) => `Season ${l}`} />
            <Legend wrapperStyle={{ fontSize: 11, cursor: single ? 'default' : 'pointer' }} onClick={(e) => { if (!single && e && e.dataKey) setOpenKey(e.dataKey) }} />
            {lines.map((l) => <Line key={l.key} type="monotone" isAnimationActive={false} dataKey={l.key} name={l.name} stroke={l.color} strokeWidth={l.width} strokeDasharray={l.dash} dot={{ r: 3 }} connectNulls />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  )
}

function ProductDrawer({ p, products, quotesByKey, sellerNames, canEdit, writes, onClose }) {
  const qs = useMemo(() => compareQuotes(quotesByKey[p.key] || [], p).sort((a, b) => b.season - a.season || (a.net ?? 9e9) - (b.net ?? 9e9)), [quotesByKey, p])
  const slips = useMemo(() => unitSlips(quotesByKey[p.key] || [], p), [quotesByKey, p])
  const series = useMemo(() => seasonSeries((quotesByKey[p.key] || []).filter((q) => q.seller !== 'Agworld'), p), [quotesByKey, p])
  const sellersInChart = [...new Set(series.flatMap((s) => Object.keys(s).filter((k) => k !== 'season' && k !== 'best')))]
  const [edit, setEdit] = useState(false)
  const [form, setForm] = useState(null)
  const [merging, setMerging] = useState(false)
  const [quoteEdit, setQuoteEdit] = useState(null)
  const bu = p.family === 'wt' ? 'lb' : p.family === 'vol' ? 'gal' : null
  const F = [['class', 'Class'], ['ai', 'Active ingredient'], ['moa', 'Mode of action'], ['manufacturer', 'Manufacturer'], ['phi', 'PHI (days)'], ['chemigation', 'Chemigation'],
    ['plantbacks', 'Plantbacks'], ['mrl', 'MRL issues'], ['rateLow', 'Low rate'], ['rateHigh', 'High rate'], ['inSeasonMax', 'In-season max'], ['defaultRate', 'Usual rate'], ['rateUnit', 'Rate unit']]
  return (
    <div className="pr-drawer-wrap" onClick={onClose}>
      <aside className="pr-drawer" onClick={(e) => e.stopPropagation()}>
        <button className="fm-x" onClick={onClose} aria-label="Close">×</button>
        <div className="fm-card-name">{p.name}</div>
        <div className="contracts-sub" style={{ marginTop: 0 }}>{[p.class, p.ai, p.kind !== 'product' ? p.kind : null].filter(Boolean).join(' · ')}{p.aliases && p.aliases.length ? ` · also “${p.aliases.slice(0, 4).join('”, “')}”` : ''}{p.agworldId ? ` · Agworld ${p.agworldId}` : ''}</div>
        {series.length > 1 && (
          <div style={{ height: 220, marginTop: 10 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series} margin={{ top: 6, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eee9de" />
                <XAxis dataKey="season" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v}`} width={60} />
                <Tooltip formatter={(v) => `${fmt$(v)}${bu ? '/' + bu : ''}`} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                {sellersInChart.map((s, i) => <Line key={s} type="monotone" dataKey={s} stroke={SELLER_COLORS[i % SELLER_COLORS.length]} strokeWidth={2} dot={{ r: 3 }} connectNulls />)}
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        {!edit ? (
          <dl className="fm-dl">
            {F.map(([k, l]) => (p[k] != null && p[k] !== '' ? <Fragment key={k}><dt>{l}</dt><dd>{String(p[k])}</dd></Fragment> : null))}
          </dl>
        ) : (
          <div className="hd-grid" style={{ marginTop: 10 }}>
            <label className="hd-field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="hd-field"><span>Unit family</span><select value={form.family || ''} onChange={(e) => setForm({ ...form, family: e.target.value || null })}><option value="">—</option><option value="vol">Liquid (gal)</option><option value="wt">Dry (lb)</option></select></label>
            {F.map(([k, l]) => k === 'class'
              ? <label key={k} className="hd-field"><span>{l}</span><select value={form.class || ''} onChange={(e) => setForm({ ...form, class: e.target.value })}><option value="" />{CLASSES.map((c) => <option key={c}>{c}</option>)}</select></label>
              : <label key={k} className="hd-field"><span>{l}</span><input value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} /></label>)}
          </div>
        )}
        {canEdit && (
          <div className="fm-card-actions" style={{ marginTop: 10 }}>
            {!edit ? <button onClick={() => { setForm({ ...p }); setEdit(true) }}>Edit details</button>
              : <><button className="save" onClick={() => { const patch = { name: form.name, family: form.family || null }; F.forEach(([k]) => { patch[k] = form[k] === '' || form[k] == null ? null : (k === 'defaultRate' ? Number(form[k]) : form[k]) }); writes.saveProduct(p.key, patch).then(() => setEdit(false)) }}>Save</button><button onClick={() => setEdit(false)}>Cancel</button></>}
            <button onClick={() => setQuoteEdit({})}>+ Add a price</button>
            <button onClick={() => setMerging((x) => !x)}>Merge into…</button>
          </div>
        )}
        {merging && (
          <div className="pr-merge">
            <div className="contracts-sub" style={{ marginTop: 0 }}>Same product under another name? Pick the one to keep — every price here moves to it and “{p.name}” becomes one of its names.</div>
            <ProductPicker products={products} exclude={p.key} placeholder="Keep which product…" onPick={(t) => { if (window.confirm(`Move all ${qs.length} prices of “${p.name}” to “${t.name}”?`)) writes.merge(p.key, t.key) }} />
          </div>
        )}
        <div className="table-scroll" style={{ marginTop: 12, maxHeight: 420 }}>
          <table className="contracts-table contracts-table-auto pr-qtable">
            <thead><tr><th>Season</th><th>Seller</th><th className="num">Price</th><th className="num">Disc.</th><th className="num">{bu ? `Net/${bu}` : 'Net'}</th><th className="num">Rate</th><th className="num">$/ac</th><th>From</th>{canEdit && <th />}</tr></thead>
            <tbody>
              {qs.map((q) => (
                <tr key={q.id} className={q.award ? 'pr-awardrow' : ''}>
                  <td>{q.season}{q.seasonNote ? ` ${q.seasonNote}` : ''}</td>
                  <td>{q.seller || q.sellerNote || '—'}{q.award ? ' ★' : ''}</td>
                  <td className="num">{fmt$(q.price)}/{unitLabel(q.unit)}</td>
                  <td className="num">{q.discount ? `${Math.round(q.discount * 1000) / 10}%` : ''}</td>
                  <td className={`num${slips.has(q.id) ? ' pr-up' : ''}`} title={slips.has(q.id) ? 'More than 3× off this product’s usual price — check the unit (per oz vs per gal?) and Edit it' : ''}>{fmt$(q.net)}{slips.has(q.id) ? ' ⚠' : ''}</td>
                  <td className="num">{q.rate != null ? `${q.rate} ${unitLabel(q.rateUnit)}` : ''}</td>
                  <td className="num">{fmt$(q.perAcre)}</td>
                  <td className="contracts-sub" style={{ marginTop: 0 }} title={[q.source, ...(q.alsoIn || [])].join(', ')}>{String(q.source || '').replace(' Price Comparison Chemical & Fertilizer.xlsx', ' file')}{q.conflict ? <span className="hb-tag warn" title={`Also ${q.conflict}`}>≠</span> : null}{q.note ? ` · ${q.note}` : ''}</td>
                  {canEdit && <td style={{ whiteSpace: 'nowrap' }}><button className="clear-sort-btn" onClick={() => setQuoteEdit(q)}>Edit</button><button className="clear-sort-btn" onClick={() => { if (window.confirm('Delete this price?')) writes.deleteQuote(q.id) }}>✕</button></td>}
                </tr>
              ))}
              {!qs.length && <tr><td colSpan={9} className="contracts-sub">No prices yet.</td></tr>}
            </tbody>
          </table>
        </div>
        {quoteEdit && <QuoteForm product={p} season={quoteEdit.season || SEASON_NOW} quote={quoteEdit.id ? quoteEdit : null} sellerNames={sellerNames} writes={writes} onClose={() => setQuoteEdit(null)} />}
      </aside>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Sellers & discounts
// ---------------------------------------------------------------------------
function Sellers({ sellers, sellerNames, quotes, canEdit, writes }) {
  const doc_ = Object.fromEntries(sellers.map((s) => [s.name, s]))
  const stats = {}
  quotes.forEach((q) => { if (!q.seller) return; const s = (stats[q.seller] = stats[q.seller] || { n: 0, award: 0, seasons: new Set() }); s.n++; if (q.award) s.award++; s.seasons.add(q.season) })
  const [newName, setNewName] = useState('')
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Sellers & discounts</div>
          <div className="contracts-sub">Each seller’s usual discount and the programs behind it (early pay, patronage, product rebates…). The usual discount fills in on new quotes; a quote’s own discount always wins.</div>
        </div>
        {canEdit && <div className="agronomy-filter-bar" style={{ margin: 0 }}><input className="agronomy-search-input" placeholder="New seller" value={newName} onChange={(e) => setNewName(e.target.value)} /><button disabled={!newName.trim()} onClick={() => { writes.saveSeller(normSeller(newName) || newName.trim(), {}); setNewName('') }}>Add</button></div>}
      </div>
      <div className="pr-sellers">
        {sellerNames.filter((s) => s !== 'Agworld').map((name) => {
          const d = doc_[name] || {}
          const st = stats[name] || { n: 0, award: 0, seasons: new Set() }
          return (
            <div key={name} className="pr-seller">
              <div className="pr-seller-head"><b>{name}</b><span className="contracts-sub" style={{ marginTop: 0 }}>{st.n} prices · {st.award} awarded · {[...st.seasons].sort().join(', ')}</span></div>
              <div className="hd-grid">
                <label className="hd-field"><span>Usual discount %</span>{canEdit ? <NumIn v={d.discount != null ? Math.round(d.discount * 1000) / 10 : null} on={(v) => writes.saveSeller(name, { discount: v == null ? null : v / 100 })} /> : (d.discount != null ? `${d.discount * 100}%` : '—')}</label>
                <label className="hd-field"><span>Contact</span>{canEdit ? <TextIn v={d.contact} on={(v) => writes.saveSeller(name, { contact: v })} /> : d.contact || '—'}</label>
                <label className="hd-field"><span>Bid email</span>{canEdit ? <TextIn v={d.email} on={(v) => writes.saveSeller(name, { email: v })} /> : d.email || '—'}</label>
              </div>
              <label className="hd-field"><span>Programs & terms</span>{canEdit ? <TextIn area v={d.programs} on={(v) => writes.saveSeller(name, { programs: v })} placeholder="e.g. 3% early pay + 3% patronage; Emesto Silver and Admire Pro $75/gal off" /> : <div className="pr-pre">{d.programs || '—'}</div>}</label>
            </div>
          )
        })}
      </div>
    </div>
  )
}
function TextIn({ v, on, area, placeholder }) {
  const [s, setS] = useState(v || '')
  useEffect(() => { setS(v || '') }, [v])
  const P = { value: s, placeholder, onChange: (e) => setS(e.target.value), onBlur: () => { if ((s || null) !== (v || null)) on(s.trim() || null) } }
  return area ? <textarea rows={3} {...P} /> : <input {...P} />
}

// ---------------------------------------------------------------------------
// Supplier accountability: awarded price vs invoiced
// ---------------------------------------------------------------------------
function Accountability({ byKey, quotes, canEdit, writes, setOpenKey }) {
  const seasons = [...new Set(quotes.filter((q) => q.award).map((q) => q.season))].sort((a, b) => b - a)
  const [season, setSeason] = useState(seasons[0] || SEASON_NOW)
  const rows = quotes.filter((q) => q.award && q.season === season && byKey[q.productKey]).map((q) => {
    const p = byKey[q.productKey]
    const m = quoteMath(q, p.family)
    const inv = q.invoicePrice != null ? quoteMath({ price: q.invoicePrice, unit: q.invoiceUnit || q.unit }, p.family).base : null
    const diff = inv != null && m.net != null ? inv - m.net : null
    return { q, p, m, inv, diff, pctDiff: diff != null && m.net ? diff / m.net : null }
  }).sort((a, b) => Math.abs(b.pctDiff || 0) - Math.abs(a.pctDiff || 0) || a.p.name.localeCompare(b.p.name))
  const over = rows.filter((r) => r.pctDiff != null && r.pctDiff > 0.005)
  return (
    <div className="yields-card">
      <div className="yields-card-head">
        <div>
          <div className="yields-card-title">Supplier accountability — {season}</div>
          <div className="contracts-sub">Every awarded price next to what the invoice charged (per gal / lb, after the bid’s discount). Red = invoiced over the bid.</div>
        </div>
        <div className="agronomy-filter-bar" style={{ margin: 0 }}>
          <select value={season} onChange={(e) => setSeason(+e.target.value)}>{(seasons.length ? seasons : [SEASON_NOW]).map((y) => <option key={y}>{y}</option>)}</select>
          {over.length > 0 && <span className="hb-tag warn">{over.length} over bid</span>}
        </div>
      </div>
      <div className="table-scroll" style={{ maxHeight: 640 }}>
        <table className="contracts-table contracts-table-auto">
          <thead><tr><th>Product</th><th>Seller</th><th className="num">Bid</th><th className="num">Bid net</th><th className="num">Invoiced</th><th className="num">Per</th><th className="num">Difference</th><th>Invoice #</th></tr></thead>
          <tbody>
            {rows.map(({ q, p, m, diff, pctDiff }) => (
              <tr key={q.id}>
                <td><button className="link-btn" onClick={() => setOpenKey(p.key)}>{p.name}</button></td>
                <td>{q.seller}</td>
                <td className="num">{fmt$(q.price)}/{unitLabel(q.unit)}</td>
                <td className="num">{fmt$(m.net)}/{m.baseUnit || unitLabel(q.unit)}</td>
                <td className="num">{canEdit ? <NumIn v={q.invoicePrice} on={(v) => writes.patchQuote(q.id, { invoicePrice: v })} /> : fmt$(q.invoicePrice)}</td>
                <td className="num">{canEdit ? <select value={q.invoiceUnit || q.unit} onChange={(e) => writes.patchQuote(q.id, { invoiceUnit: e.target.value })}>{UNITS.map((u) => <option key={u} value={u}>{unitLabel(u)}</option>)}</select> : unitLabel(q.invoiceUnit || q.unit)}</td>
                <td className={`num ${pctDiff > 0.005 ? 'pr-up' : pctDiff < -0.005 ? 'pr-down' : ''}`}>{diff != null ? `${fmt$(diff)} (${pctStr(pctDiff)})` : ''}</td>
                <td>{canEdit ? <TextIn v={q.invoiceNo} on={(v) => writes.patchQuote(q.id, { invoiceNo: v })} /> : q.invoiceNo || ''}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={8} className="contracts-sub">Nothing awarded for {season} yet — award sellers on the Bids tab.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
function Import({ products, byKey, quotes, writes }) {
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState(null) // { label, quotes, products, skipped, conflicts }
  const [agSeason, setAgSeason] = useState(SEASON_NOW - (new Date().getMonth() >= 7 ? 1 : 0))
  const [err, setErr] = useState(null)
  const haveIds = useMemo(() => new Set(quotes.map((q) => q.id)), [quotes])

  // Re-key incoming quotes onto products already on the list.
  function attach(incoming, extraProducts = []) {
    const keys = new Set(products.map((p) => p.key))
    const claimed = new Set([...incoming.map((q) => q.key), ...extraProducts.map((p) => p.key)].filter((k) => keys.has(k)))
    const remap = {}
    ;[...incoming, ...extraProducts].forEach((x) => { if (remap[x.key] != null || keys.has(x.key)) return; const m = matchKey(x.key, keys, claimed); remap[x.key] = m || x.key })
    incoming.forEach((q) => { q.key = remap[q.key] || q.key })
    extraProducts.forEach((p) => { p.key = remap[p.key] || p.key })
    return remap
  }
  function plan(label, incoming, extraProducts = [], skipped = []) {
    const remap = attach(incoming, extraProducts)
    const fresh = incoming.filter((q) => !haveIds.has(quoteId(q)))
    const newProducts = buildProducts(incoming, extraProducts).filter((p) => !byKey[p.key])
    setPreview({ label, quotes: fresh, all: incoming.length, products: newProducts, matched: Object.entries(remap).filter(([a, b]) => a !== b).length, skipped, conflicts: incoming.filter((q) => q.conflict).length })
  }
  async function loadBundle() {
    setErr(null); setBusy(true)
    try {
      const b = (await import('./priceHistory.json')).default
      const qs = b.quotes.map((q) => ({ ...q }))
      setPreview(null)
      const newProducts = b.products.filter((p) => !byKey[p.key])
      const fresh = qs.filter((q) => !haveIds.has(quoteId(q)))
      setPreview({ label: `2020–2026 history (${b.sources.join(', ')})`, quotes: fresh, all: qs.length, products: newProducts, matched: 0, skipped: b.skipped || [], conflicts: qs.filter((q) => q.conflict).length, bundled: true })
    } catch (e) { setErr(e.message) }
    setBusy(false)
  }
  async function onWorkbook(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setErr(null); setBusy(true)
    try {
      const XLSX = await import('xlsx')
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' })
      const name = wb.SheetNames.find((n) => /^database$/i.test(n)) || wb.SheetNames[0]
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' })
      const { quotes: qs, skipped } = parseComparison(rows, file.name)
      plan(file.name, qs, [], skipped)
    } catch (ex) { setErr(ex.message || String(ex)) }
    setBusy(false)
  }
  async function onAgworld(e) {
    const file = e.target.files && e.target.files[0]
    e.target.value = ''
    if (!file) return
    setErr(null)
    try {
      const { quotes: qs, products: ps } = parseAgworld(await file.text(), agSeason, `Agworld price list (${file.name})`)
      plan(`Agworld price list — ${file.name} (season ${agSeason})`, qs, ps)
    } catch (ex) { setErr(ex.message || String(ex)) }
  }
  function commit() {
    const p = preview
    setBusy(true)
    const ops = []
    p.products.forEach((x) => ops.push(['set', doc(db, 'priceProducts', docKey(x.key)), { ...x, ...writes.stamp() }]))
    p.quotes.forEach((q) => {
      const { key, name, ...rest } = q
      const data = { productKey: key, nameAsGiven: name, ...rest, importedAt: Date.now() }
      Object.keys(data).forEach((k) => (data[k] === undefined || data[k] === null || data[k] === '') && delete data[k])
      ops.push(['set', doc(db, 'priceQuotes', quoteId(q)), data])
    })
    writes.run(() => writes.commitAll(ops), `Imported ${p.quotes.length} prices and ${p.products.length} new products.`).then(() => { setBusy(false); setPreview(null) })
  }

  return (
    <div className="harvest-two">
      <div className="yields-card">
        <div className="yields-card-title">1 · Price history 2020–2026</div>
        <div className="contracts-sub">Everything from the 2024, 2025 and 2026 “Price Comparison Chemical & Fertilizer” workbooks (each one runs back to 2020) and Agworld’s price list, merged so every distinct price is kept once. Safe to run again — prices already here are skipped.</div>
        <button className="save" style={{ marginTop: 10 }} disabled={busy} onClick={loadBundle}>Load the 2020–2026 price history…</button>
        <div className="yields-card-title" style={{ marginTop: 18 }}>2 · Another comparison workbook</div>
        <div className="contracts-sub">A Price Comparison workbook (.xlsx) — AIO reads its “database” sheet (Product Name, Year, Class, Seller, Price, Unit, Rate, discount…).</div>
        <input type="file" accept=".xlsx,.xlsm,.xls" onChange={onWorkbook} style={{ marginTop: 8 }} />
        <div className="yields-card-title" style={{ marginTop: 18 }}>3 · Agworld price list</div>
        <div className="contracts-sub">Agworld → Settings → Price list → Export (CSV). Products, custom operations and seeds with Agworld’s current unit cost.</div>
        <div className="fm-row" style={{ marginTop: 8 }}>
          <label className="hb-check">Season <input className="yields-cell-input" style={{ width: 70 }} inputMode="numeric" value={agSeason} onChange={(e) => setAgSeason(+e.target.value || SEASON_NOW)} /></label>
          <input type="file" accept=".csv" onChange={onAgworld} />
        </div>
        {err && <div className="agronomy-error-banner" style={{ marginTop: 10 }}>{err}</div>}
      </div>
      {preview && (
        <div className="yields-card">
          <div className="yields-card-title">Ready to import</div>
          <div className="contracts-sub" style={{ marginTop: 0 }}>{preview.label}</div>
          <div className="pr-totals" style={{ marginTop: 10 }}>
            <div><span>Prices in the file</span><b>{preview.all.toLocaleString()}</b></div>
            <div><span>New prices</span><b>{preview.quotes.length.toLocaleString()}</b></div>
            <div><span>New products</span><b>{preview.products.length.toLocaleString()}</b></div>
            {preview.matched > 0 && <div><span>Names matched to existing products</span><b>{preview.matched}</b></div>}
            {preview.conflicts > 0 && <div><span>Prices to check</span><b>{preview.conflicts}</b><small>same product, season & seller at two prices</small></div>}
          </div>
          {preview.skipped.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary className="contracts-sub">{preview.skipped.length} rows skipped (no year or no price)</summary>
              <ul className="pr-skipped">{preview.skipped.map((s, i) => <li key={i}>{s.src ? `${s.src.slice(0, 4)} file ` : ''}row {s.row}: {s.name} — {s.why}</li>)}</ul>
            </details>
          )}
          <div className="fm-row" style={{ marginTop: 12 }}>
            <button className="save" disabled={busy || (!preview.quotes.length && !preview.products.length)} onClick={commit}>{busy ? 'Importing…' : 'Import'}</button>
            <button onClick={() => setPreview(null)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  )
}

export { productKey, normUnit }
