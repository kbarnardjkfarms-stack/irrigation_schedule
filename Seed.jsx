import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, doc, onSnapshot, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import { canonCrop } from './yieldMath.js'
import { computeSeed, fmtAge, fmtCwt, fmtWhen, lotLabel } from './seedMath.js'
import SeedPortals from './SeedPortals.jsx'
import { SeedContracts, SeedLots, SeedReport, SeedSettings, SeedTickets } from './SeedManage.jsx'

// Potato Seed module — contracted seed, pickups from each grower, the cutter,
// cut-seed trucks and what got planted where, with supplier / lot / variety
// carried the whole way.
//
// Data (see firestore.rules; everything tagged with seasonId):
//   seedContracts/{id}   supplier, variety, contractedCwt, lots[]
//   seedTickets/{id}     type pickup | cut | plant | writeoff (see seedMath.js)
//   seedPhotos/{ticketId} the ticket photo, compressed JPEG data
//   seedTrucks/{TRUCKKEY} truck number + light (empty) weight, entered once
//   seedLotClose/{id}    a lot closed out at the cutter, with its shrink
//   seedSettings/{seasonId} cutting-zone capacity, truck-age warnings
// Plant tickets carry the Agworld field id so the planting schedule module
// can read seed planted per field.

export default function Seed({ userRole }) {
  const canManage = userRole === 'admin' || userRole === 'owner' || userRole === 'farm_manager'
  const [view, setView] = useState(canManage ? 'overview' : 'portals')
  const [seasons, setSeasons] = useState([])
  const [seasonId, setSeasonId] = useState(null)
  const [contracts, setContracts] = useState([])
  const [tickets, setTickets] = useState([])
  const [closes, setCloses] = useState([])
  const [trucks, setTrucks] = useState({})
  const [settingsDoc, setSettingsDoc] = useState(null)
  const [baseFields, setBaseFields] = useState({})
  const [seasonData, setSeasonData] = useState({})
  const [error, setError] = useState(null)
  const [pending, setPending] = useState(0)
  const [online, setOnline] = useState(() => navigator.onLine !== false)
  useEffect(() => {
    const on = () => setOnline(true), off = () => setOnline(false)
    window.addEventListener('online', on); window.addEventListener('offline', off)
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off) }
  }, [])
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60000); return () => clearInterval(t) }, [])

  useEffect(() => onSnapshot(collection(db, 'seasons'), (snap) => {
    const list = []
    snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
    list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
    setSeasons(list)
    setSeasonId((prev) => {
      if (prev) return prev
      // Seed is bought and planted in spring — after harvest, look ahead to next year's season.
      const y = new Date().getFullYear()
      const pick = list.find((s) => String(s.name) === String(new Date().getMonth() >= 9 ? y + 1 : y)) || list.find((s) => String(s.name) === String(y))
      return pick ? pick.id : (list[0] ? list[0].id : null)
    })
  }), [])
  useEffect(() => onSnapshot(collection(db, 'fields'), (snap) => {
    const next = {}
    snap.forEach((d) => { next[d.id] = d.data() })
    setBaseFields(next)
  }), [])
  useEffect(() => onSnapshot(collection(db, 'seedTrucks'), (snap) => {
    const next = {}
    snap.forEach((d) => { next[d.id] = { id: d.id, ...d.data() } })
    setTrucks(next)
  }, () => {}), [])

  useEffect(() => {
    if (!seasonId) return undefined
    const sid = String(seasonId)
    const onErr = (e) => setError(e.code === 'permission-denied'
      ? 'No permission to read seed data. If this is the first time the module has been opened, the new firestore.rules may not be deployed yet.'
      : e.message)
    const list = (setter) => (snap) => { const out = []; snap.forEach((d) => out.push({ id: d.id, ...d.data() })); setter(out); setError(null) }
    const unsubs = [
      onSnapshot(query(collection(db, 'seedContracts'), where('seasonId', '==', sid)), list(setContracts), onErr),
      // includeMetadataChanges: so we hear when queued (offline) tickets reach the server
      onSnapshot(query(collection(db, 'seedTickets'), where('seasonId', '==', sid)), { includeMetadataChanges: true }, (snap) => {
        const out = []
        let pending = 0
        snap.forEach((d) => { out.push({ id: d.id, ...d.data() }); if (d.metadata && d.metadata.hasPendingWrites) pending++ })
        setTickets(out); setPending(pending); setError(null)
      }, onErr),
      onSnapshot(query(collection(db, 'seedLotClose'), where('seasonId', '==', sid)), list(setCloses), onErr),
      onSnapshot(doc(db, 'seedSettings', sid), (d) => setSettingsDoc(d.exists() ? d.data() : null), onErr),
      onSnapshot(query(collectionGroup(db, 'seasons'), where('seasonId', '==', seasonId)), (snap) => {
        const next = {}
        snap.forEach((d) => { next[d.ref.parent.parent.id] = d.data() })
        setSeasonData(next)
      }, () => {})
    ]
    return () => unsubs.forEach((u) => u())
  }, [seasonId])

  const settings = { zoneCapacity: 2500, ageWarnHours: 24, ageAlarmHours: 48, ...(settingsDoc || {}) }
  const seed = useMemo(() => computeSeed({ contracts, tickets, closes, now }), [contracts, tickets, closes, now])
  // Agworld fields for the season, potatoes first (for the field-unload search)
  const fieldList = useMemo(() => Object.entries(seasonData).map(([id, sd]) => {
    const b = baseFields[id] || {}
    return { id, name: b.name || id, farmName: b.farmName || null, crop: canonCrop(sd.cropName) || '', variety: sd.varietyName || null, acres: Number(sd.acres) || 0 }
  }).filter((f) => f.name).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })), [seasonData, baseFields])

  const season = seasons.find((s) => String(s.id) === String(seasonId))
  const ctx = { seasonId: String(seasonId), seasonName: season && season.name, contracts, tickets, closes, trucks, settings, seed, fieldList, canManage, now, userRole }
  const tabs = canManage
    ? [['overview', 'Overview'], ['portals', 'Ticket portals'], ['contracts', 'Contracts'], ['tickets', 'Tickets'], ['lots', 'Lots & shrink'], ['report', 'Planted by field'], ['settings', 'Settings']]
    : [['portals', 'Ticket portals'], ['inventory', 'Inventory']]

  return (
    <div className="agronomy seed">
      <div className="agronomy-filter-bar">
        {seasons.length > 0 && (
          <select value={seasonId || ''} onChange={(e) => setSeasonId(e.target.value)} title="Crop year">
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <span className="contracts-sub" style={{ marginTop: 0 }}>Potato seed · crop year {season ? season.name : '—'}</span>
      </div>
      {error && <div className="agronomy-error-banner">{error}</div>}
      {(!online || pending > 0) && (
        <div className={`seed-sync ${online ? 'sending' : 'offline'}`}>
          {online
            ? `Sending ${pending} ticket${pending === 1 ? '' : 's'} saved while offline…`
            : `Offline — keep going. ${pending ? `${pending} ticket${pending === 1 ? '' : 's'} saved on this device` : 'Tickets save on this device'} and send automatically when signal is back.`}
        </div>
      )}
      {seed.overUnloaded.length > 0 && canManage && (
        <div className="agronomy-error-banner">
          {seed.overUnloaded.map((t) => `Truck ${t.truckNo} (loaded ${fmtWhen(t.at)}) has ${fmtCwt(t.unloadedCwt - t.cwt, 1)} cwt more unloaded than it carried`).join(' · ')} — usually two phones logged the same load while offline. Fix or delete the extra field unload on the Tickets tab.
        </div>
      )}

      <SeedBanner seed={seed} settings={settings} />

      <div className="agronomy-view-toggle harvest-tabs">
        {tabs.map(([k, l]) => <button key={k} className={view === k ? 'active' : ''} onClick={() => setView(k)}>{l}</button>)}
      </div>

      {view === 'overview' && <SeedOverview ctx={ctx} />}
      {view === 'portals' && <SeedPortals ctx={ctx} />}
      {view === 'inventory' && <><CuttingZone ctx={ctx} /><LoadedTrucks ctx={ctx} /></>}
      {view === 'contracts' && <SeedContracts ctx={ctx} />}
      {view === 'tickets' && <SeedTickets ctx={ctx} />}
      {view === 'lots' && <SeedLots ctx={ctx} />}
      {view === 'report' && <SeedReport ctx={ctx} />}
      {view === 'settings' && <SeedSettings ctx={ctx} />}
    </div>
  )
}

function SeedBanner({ seed, settings }) {
  const t = seed.totals
  const zonePct = settings.zoneCapacity > 0 ? seed.zoneCwt / settings.zoneCapacity : 0
  const transit = seed.transit.reduce((s, x) => s + (x.cwt || 0), 0)
  const cards = [
    ['Picked up', t.contracted ? `${Math.round((t.picked / t.contracted) * 100)}%` : fmtCwt(t.picked), t.contracted ? `${fmtCwt(t.picked)} of ${fmtCwt(t.contracted)} cwt` : 'cwt'],
    ['In transit', fmtCwt(transit), `cwt · ${seed.transit.length} truck${seed.transit.length === 1 ? '' : 's'}`],
    ['At the cutter', fmtCwt(seed.zoneCwt), `of ${fmtCwt(settings.zoneCapacity)} cwt`, zonePct > 1 ? 'alarm' : zonePct > 0.85 ? 'warn' : ''],
    ['Cut seed loaded', fmtCwt(seed.loadedCwt), `cwt · ${seed.loadedTrucks.length} truck${seed.loadedTrucks.length === 1 ? '' : 's'}`],
    ['Planted', fmtCwt(t.planted), `cwt · ${seed.fields.length} field${seed.fields.length === 1 ? '' : 's'}`]
  ]
  return (
    <div className="seed-banner">
      {cards.map(([l, v, s, cls]) => (
        <div key={l} className={`seed-stat ${cls || ''}`}><span>{l}</span><strong>{v}</strong><small>{s}</small></div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared live panels
// ---------------------------------------------------------------------------
export function CuttingZone({ ctx, compact }) {
  const { seed, settings } = ctx
  const cap = settings.zoneCapacity || 2500
  const pct = Math.min(1.2, seed.zoneCwt / cap)
  const lots = seed.lots.filter((L) => L.zone > 0.05 || L.overCut)
  return (
    <div className="yields-card">
      <div className="yields-card-head" style={{ marginBottom: 4 }}>
        <div>
          <div className="yields-card-title">Cutting zone</div>
          <div className="contracts-sub">Whole seed tipped at the cutter, less cut seed weighed out.</div>
        </div>
        <div className={`seed-zone-num${pct > 1 ? ' alarm' : pct > 0.85 ? ' warn' : ''}`}>{fmtCwt(seed.zoneCwt)}<small> / {fmtCwt(cap)} cwt</small></div>
      </div>
      <div className="seed-gauge"><div className={pct > 1 ? 'alarm' : pct > 0.85 ? 'warn' : ''} style={{ width: `${Math.min(100, pct * 100)}%` }} /></div>
      {!compact && (
        <table className="contracts-table contracts-table-auto" style={{ marginTop: 8 }}>
          <thead><tr><th>Variety</th><th>Supplier</th><th>Lot</th><th className="num">In zone (cwt)</th><th className="num">Tipped</th><th className="num">Cut out</th></tr></thead>
          <tbody>
            {lots.map((L) => (
              <tr key={L.key}>
                <td><strong>{L.variety}</strong></td><td>{L.supplier}</td><td>{L.lot}</td>
                <td className="num"><strong>{fmtCwt(L.zone)}</strong>{L.overCut && <span className="hb-tag warn" title="More cut seed weighed out on this lot than came in — check the cut tickets">over-cut</span>}</td>
                <td className="num">{fmtCwt(L.unloaded)}</td><td className="num">{fmtCwt(L.cut)}</td>
              </tr>
            ))}
            {!lots.length && <tr><td colSpan={6} className="contracts-sub">Nothing at the cutter.</td></tr>}
          </tbody>
        </table>
      )}
    </div>
  )
}

export function LoadedTrucks({ ctx, onPick, pickedId }) {
  const { seed, settings } = ctx
  return (
    <div className="yields-card">
      <div className="yields-card-title">Loaded cut-seed trucks</div>
      <div className="contracts-sub">Every truck weighed out of the cutter that still has seed on it, oldest first.{onPick ? ' Tap one to unload it.' : ''}</div>
      <div className="seed-trucks">
        {seed.loadedTrucks.map((t) => {
          const age = t.ageHours >= settings.ageAlarmHours ? 'alarm' : t.ageHours >= settings.ageWarnHours ? 'warn' : ''
          return (
            <button key={t.id} type="button" className={`seed-truck ${age}${pickedId === t.id ? ' picked' : ''}`} onClick={onPick ? () => onPick(t) : undefined} disabled={!onPick}>
              <div className="seed-truck-head"><strong>Truck {t.truckNo}</strong><span className={`seed-age ${age}`}>{fmtAge(t.ageHours)}</span></div>
              <div className="seed-truck-cwt">{fmtCwt(t.remaining, 1)} <small>cwt{t.unloadedCwt > 0.05 ? ` left of ${fmtCwt(t.cwt, 1)}` : ''}</small></div>
              {t.parts.filter((p) => p.remaining > 0.05).map((p) => (
                <div key={p.key} className="seed-truck-lot">{p.variety} · {p.supplier} · lot {p.lot}{t.parts.length > 1 ? ` — ${fmtCwt(p.remaining, 1)}` : ''}</div>
              ))}
              <div className="seed-truck-when">Loaded {fmtWhen(t.at)}</div>
            </button>
          )
        })}
        {!seed.loadedTrucks.length && <div className="contracts-sub" style={{ padding: 8 }}>No cut seed on trucks right now.</div>}
      </div>
    </div>
  )
}

function SeedOverview({ ctx }) {
  const { seed } = ctx
  const bySupplier = {}
  seed.contractRows.forEach((c) => { (bySupplier[c.supplier] = bySupplier[c.supplier] || []).push(c) })
  return (
    <>
      <div className="harvest-two">
        <div className="yields-card">
          <div className="yields-card-title">Picked up by variety</div>
          <table className="contracts-table contracts-table-auto" style={{ marginTop: 8 }}>
            <thead><tr><th>Variety</th><th className="num">Contracted</th><th className="num">Picked up</th><th style={{ width: '32%' }} /><th className="num">Planted</th></tr></thead>
            <tbody>
              {seed.byVariety.map((v) => {
                const pct = v.contracted > 0 ? v.picked / v.contracted : null
                return (
                  <tr key={v.variety}>
                    <td><strong>{v.variety}</strong></td><td className="num">{fmtCwt(v.contracted)}</td><td className="num">{fmtCwt(v.picked)}</td>
                    <td>{pct != null && <div className="seed-bar"><div style={{ width: `${Math.min(100, pct * 100)}%` }} className={pct > 1.02 ? 'over' : ''} /><span>{Math.round(pct * 100)}%</span></div>}</td>
                    <td className="num">{fmtCwt(v.planted)}</td>
                  </tr>
                )
              })}
              {!seed.byVariety.length && <tr><td colSpan={5} className="contracts-sub">Add your seed contracts on the Contracts tab.</td></tr>}
            </tbody>
          </table>
        </div>
        <CuttingZone ctx={ctx} />
      </div>
      <div className="yields-card">
        <div className="yields-card-title">Contracts — picked up from each grower</div>
        <div className="contracts-sub">Live from pickup tickets. In transit = picked up but not yet tipped at the cutter.</div>
        <div className="table-scroll" style={{ marginTop: 8 }}>
          <table className="contracts-table contracts-table-auto">
            <thead><tr><th>Supplier</th><th>Variety</th><th>Lots</th><th className="num">Contracted</th><th className="num">Picked up</th><th style={{ width: '22%' }} /><th className="num">Remaining</th><th className="num">In transit</th><th className="num">Loads</th></tr></thead>
            <tbody>
              {Object.entries(bySupplier).sort(([a], [b]) => a.localeCompare(b)).map(([sup, rows]) => rows.map((c, i) => (
                <tr key={c.id}>
                  <td>{i === 0 ? <strong>{sup}</strong> : ''}</td><td>{c.variety}</td><td className="contracts-sub">{(c.lots || []).join(', ')}</td>
                  <td className="num">{fmtCwt(c.contractedCwt)}</td><td className="num">{fmtCwt(c.picked)}</td>
                  <td>{c.pct != null && <div className="seed-bar"><div style={{ width: `${Math.min(100, c.pct * 100)}%` }} className={c.pct > 1.02 ? 'over' : ''} /><span>{Math.round(c.pct * 100)}%</span></div>}</td>
                  <td className="num" style={{ color: c.remaining < -1 ? '#A32D2D' : undefined }}>{fmtCwt(c.remaining)}</td>
                  <td className="num">{c.transit ? fmtCwt(c.transit) : ''}</td><td className="num">{c.loads}</td>
                </tr>
              )))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="harvest-two">
        <LoadedTrucks ctx={ctx} />
        <div className="yields-card">
          <div className="yields-card-title">Recent tickets</div>
          <table className="contracts-table contracts-table-auto" style={{ marginTop: 8 }}>
            <tbody>
              {[...ctx.tickets].filter((t) => !t.deleted).sort((a, b) => b.at - a.at).slice(0, 12).map((t) => (
                <tr key={t.id}>
                  <td style={{ whiteSpace: 'nowrap' }}>{fmtWhen(t.at)}</td>
                  <td><span className={`seed-type ${t.type}`}>{TYPE_LABEL[t.type]}</span></td>
                  <td>Truck {t.truckNo || '—'}</td>
                  <td>{t.type === 'cut' ? (t.parts || []).map(lotLabel).join(' + ') : t.type === 'plant' || t.type === 'writeoff' ? `${t.fieldName || 'written off'} — ${(t.parts || []).map((p) => p.variety).join('/')}` : lotLabel(t)}</td>
                  <td className="num">{fmtCwt(t.cwt, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  )
}

export const TYPE_LABEL = { pickup: 'Pickup', cut: 'Cut seed', plant: 'Planted', writeoff: 'Written off' }
