import { useEffect, useRef, useState } from 'react'
import { doc, onSnapshot, setDoc } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import { loadLeaflet } from './FarmMap.jsx'

// Farm Map > Public feed (Admin/Owner). Turns on a live KML link of the
// Agworld fields — outlines coloured by crop, with acres — that Google Earth
// and other map programs re-read on a timer. The link itself is served by the
// publicFieldsKml function (functions/publicMapFeed.js); this screen only
// writes publicMapFeed/settings and previews what the link returns.

const FEED_BASE = 'https://us-central1-irrigation-schedule-f8b69.cloudfunctions.net/publicFieldsKml'
const DEFAULTS = {
  enabled: false, key: '', year: 'auto', groupBy: 'crop', labelAcres: false,
  includeHidden: false, refreshMinutes: 60, title: 'JK Farms fields',
  show: { farm: true, crop: true, variety: false, acres: true }
}
const newKey = () => {
  const a = new Uint8Array(15)
  crypto.getRandomValues(a)
  return Array.from(a, (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('')
}
const titleCase = (s) => String(s || '').toLowerCase().replace(/\b[a-z]/g, (m) => m.toUpperCase())
const fmt = (n) => Math.round(n || 0).toLocaleString('en-US')

export default function FarmMapFeed({ years }) {
  const [saved, setSaved] = useState(null)
  const [form, setForm] = useState(null)
  const [msg, setMsg] = useState(null)
  const [preview, setPreview] = useState(null) // { summary, kml } | { error }
  const [confirmReplace, setConfirmReplace] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => onSnapshot(doc(db, 'publicMapFeed', 'settings'), (d) => {
    const v = { ...DEFAULTS, ...(d.exists() ? d.data() : {}) }
    v.show = { ...DEFAULTS.show, ...((d.exists() && d.data().show) || {}) }
    setSaved(v)
    setForm((f) => f || v)
  }, (e) => setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin or Owner can set up the public feed.' : e.message })), [])

  const feedUrl = saved && saved.key ? `${FEED_BASE}?k=${saved.key}` : null
  const dirty = form && saved && JSON.stringify(form) !== JSON.stringify(saved)

  // Preview whatever the live link returns (after each save).
  useEffect(() => {
    if (!saved || !saved.enabled || !feedUrl) { setPreview(null); return }
    let gone = false
    setPreview({ loading: true })
    Promise.all([
      fetch(`${feedUrl}&format=json&t=${Date.now()}`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`The link answered ${r.status}.`)))),
      fetch(`${feedUrl}&t=${Date.now()}`).then((r) => r.text())
    ]).then(([summary, kml]) => { if (!gone) setPreview({ summary, kml }) })
      .catch((e) => { if (!gone) setPreview({ error: /fetch/i.test(e.message) ? 'Couldn’t reach the feed. If it was just uploaded, give the functions deploy a few minutes.' : e.message }) })
    return () => { gone = true }
  }, [saved, feedUrl])

  if (!form) return <div className="yields-card"><div className="contracts-sub">{msg ? msg.text : 'Loading…'}</div></div>

  const set = (patch) => setForm((f) => ({ ...f, ...patch }))
  const setShow = (patch) => setForm((f) => ({ ...f, show: { ...f.show, ...patch } }))
  async function save(next = form, text = 'Saved. Map programs pick it up on their next refresh.') {
    setMsg(null)
    const data = { ...next, key: next.key || newKey(), updatedBy: auth.currentUser ? auth.currentUser.email || auth.currentUser.uid : null, updatedAt: Date.now() }
    try {
      await setDoc(doc(db, 'publicMapFeed', 'settings'), data)
      setForm(data)
      setMsg({ ok: true, text })
    } catch (e) { setMsg({ ok: false, text: e.code === 'permission-denied' ? 'Only Admin or Owner can change the public feed.' : e.message }) }
  }
  function copy() {
    navigator.clipboard.writeText(feedUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }).catch(() => {})
  }

  const s = preview && preview.summary
  return (
    <div className="fmf">
      {msg && <div className={msg.ok ? 'yields-ok harvest-msg' : 'agronomy-error-banner'} onClick={() => setMsg(null)}>{msg.text}</div>}
      <div className="harvest-two">
        <div className="yields-card">
          <div className="yields-card-head">
            <div>
              <div className="yields-card-title">Public map feed</div>
              <div className="contracts-sub">A live link of the Agworld fields — outlines in crop colours, with acres — for Google Earth and other map programs. It follows Agworld: change a crop or a boundary there and the link shows it after the next sync (every morning at 5, or Sync now).</div>
            </div>
          </div>

          <label className="fmf-switch">
            <input type="checkbox" checked={!!form.enabled} onChange={(e) => save({ ...form, enabled: e.target.checked }, e.target.checked ? 'Feed is on.' : 'Feed is off — the link now answers “not found”.')} />
            <span><b>{form.enabled ? 'On' : 'Off'}</b> — {form.enabled ? 'anyone with the link can see the fields.' : 'the link doesn’t work.'}</span>
          </label>

          <div className="fmf-grid">
            <label>Map name<input value={form.title} onChange={(e) => set({ title: e.target.value })} /></label>
            <label>Crop year
              <select value={String(form.year)} onChange={(e) => set({ year: e.target.value === 'auto' ? 'auto' : +e.target.value })}>
                <option value="auto">This year (rolls over Jan 1)</option>
                {years.map((y) => <option key={y} value={y}>{y}</option>)}
              </select>
            </label>
            <label>Folders in Google Earth
              <select value={form.groupBy} onChange={(e) => set({ groupBy: e.target.value })}>
                <option value="crop">By crop</option><option value="farm">By farm</option>
              </select>
            </label>
            <label>Refresh every
              <select value={form.refreshMinutes} onChange={(e) => set({ refreshMinutes: +e.target.value })}>
                {[15, 30, 60, 180, 720, 1440].map((m) => <option key={m} value={m}>{m < 60 ? `${m} minutes` : m === 60 ? '1 hour' : m === 1440 ? '1 day' : `${m / 60} hours`}</option>)}
              </select>
            </label>
          </div>

          <div className="fm-lab" style={{ marginTop: 12 }}>Shown when someone clicks a field</div>
          <div className="fmf-checks">
            <label><input type="checkbox" checked disabled /> Field name</label>
            <label><input type="checkbox" checked={form.show.farm} onChange={(e) => setShow({ farm: e.target.checked })} /> Farm</label>
            <label><input type="checkbox" checked={form.show.crop} onChange={(e) => setShow({ crop: e.target.checked })} /> Crop</label>
            <label><input type="checkbox" checked={form.show.variety} onChange={(e) => setShow({ variety: e.target.checked })} /> Variety</label>
            <label><input type="checkbox" checked={form.show.acres} onChange={(e) => setShow({ acres: e.target.checked })} /> Acres</label>
          </div>
          <div className="fmf-checks">
            <label><input type="checkbox" checked={form.labelAcres} disabled={!form.show.acres} onChange={(e) => set({ labelAcres: e.target.checked })} /> Acres in the map label too (“27A · 125 ac”)</label>
            <label><input type="checkbox" checked={form.includeHidden} onChange={(e) => set({ includeHidden: e.target.checked })} /> Include subleased / archive farms</label>
          </div>
          <div className="contracts-sub">Outline colour is always the crop. Nothing else goes out — no yields, contracts, applications or notes.</div>

          <div className="fm-row" style={{ marginTop: 12 }}>
            <button className="save" disabled={!dirty} onClick={() => save()}>Save</button>
            {dirty && <button onClick={() => setForm(saved)}>Undo changes</button>}
          </div>
        </div>

        <div className="yields-card">
          <div className="yields-card-title">The link</div>
          {!feedUrl ? <div className="contracts-sub">Turn the feed on to make a link.</div> : (
            <>
              <div className="fmf-url"><code>{feedUrl}</code><button onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></div>
              <div className="fm-row" style={{ marginTop: 8 }}>
                <button className="save" onClick={() => { window.location.href = `${feedUrl}&link=1` }}>Download Google Earth file</button>
                {!confirmReplace
                  ? <button onClick={() => setConfirmReplace(true)}>Replace link…</button>
                  : <><button className="fmf-danger" onClick={() => { setConfirmReplace(false); save({ ...form, key: newKey() }, 'New link made. The old one has stopped working.') }}>Stop the old link and make a new one</button><button onClick={() => setConfirmReplace(false)}>Cancel</button></>}
              </div>
              {!form.enabled && <div className="fm-note">The feed is off, so this link answers “not found” right now.</div>}
              <ol className="fmf-how">
                <li><b>Google Earth Pro (desktop):</b> open the downloaded file. It sits under Places and re-reads the link on the timer above. Share the same small file with anyone who should have it.</li>
                <li><b>Google Earth on the web:</b> Projects → New project → Import KML file → pick the downloaded file. It loads the fields; reopen the project to be sure you’re seeing the latest.</li>
                <li><b>QGIS, ArcGIS, CalTopo and similar:</b> add a layer “from URL” and paste the link.</li>
                <li><b>Google My Maps</b> can’t follow a link — it only takes a one-time copy, so it won’t update itself.</li>
              </ol>
              <div className="contracts-sub">Anyone holding the link can see what’s shown here. Replacing the link cuts off every copy handed out before.</div>
            </>
          )}
        </div>
      </div>

      {form.enabled && feedUrl && (
        <div className="yields-card">
          <div className="yields-card-head">
            <div>
              <div className="yields-card-title">What the link shows right now{s ? ` — ${s.year}` : ''}</div>
              <div className="contracts-sub">{s ? `${s.fields} fields · ${fmt(s.acres)} ac${s.seasonNames.length ? ` · Agworld season ${s.seasonNames.join(', ')}` : ' · no Agworld season for that year yet'}` : preview && preview.loading ? 'Reading the link…' : ''}</div>
            </div>
            {dirty && <span className="hb-tag warn">Save to see your changes here</span>}
          </div>
          {preview && preview.error && <div className="agronomy-error-banner">{preview.error}</div>}
          {s && (
            <div className="fmf-preview">
              <FeedMap kml={preview.kml} />
              <table className="contracts-table">
                <thead><tr><th>Crop</th><th className="num">Fields</th><th className="num">Acres</th></tr></thead>
                <tbody>
                  {s.crops.map((c) => (
                    <tr key={c.crop}><td><span className="fm-sw" style={{ background: c.color, display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />{c.crop === 'NO CROP ENTERED' ? 'No crop entered' : titleCase(c.crop)}</td><td className="num">{c.fields}</td><td className="num">{fmt(c.acres)}</td></tr>
                  ))}
                  {!s.crops.length && <tr><td colSpan={3} className="contracts-sub">No fields with an outline in Agworld for {s.year}.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// The KML drawn the way a map program will draw it.
function FeedMap({ kml }) {
  const el = useRef(null)
  useEffect(() => {
    let map = null, gone = false
    loadLeaflet().then((L) => {
      if (gone || !el.current) return
      const x = new DOMParser().parseFromString(kml, 'application/xml')
      const colors = {}
      Array.from(x.getElementsByTagNameNS('*', 'Style')).forEach((st) => {
        const c = st.getElementsByTagNameNS('*', 'LineStyle')[0]
        const v = c && c.getElementsByTagNameNS('*', 'color')[0]
        if (v) { const t = v.textContent.trim(); colors['#' + st.getAttribute('id')] = '#' + t.slice(6, 8) + t.slice(4, 6) + t.slice(2, 4) }
      })
      map = L.map(el.current, { zoomControl: true, attributionControl: false })
      L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 19 }).addTo(map)
      const group = L.featureGroup().addTo(map)
      Array.from(x.getElementsByTagNameNS('*', 'Placemark')).forEach((p) => {
        const ring = p.getElementsByTagNameNS('*', 'LinearRing')[0]
        if (!ring) return
        const pts = ring.textContent.trim().split(/\s+/).map((t) => t.split(',').map(Number)).map(([lng, lat]) => [lat, lng])
        const su = p.getElementsByTagNameNS('*', 'styleUrl')[0]
        const color = (su && colors[su.textContent.trim()]) || '#8D8A7E'
        const name = (p.getElementsByTagNameNS('*', 'name')[0] || {}).textContent || ''
        const desc = (p.getElementsByTagNameNS('*', 'description')[0] || {}).textContent || ''
        L.polygon(pts, { color, weight: 2, fillColor: color, fillOpacity: 0.35 })
          .bindTooltip(name, { sticky: true }).bindPopup(`<b>${name.replace(/</g, '&lt;')}</b>${desc}`).addTo(group)
      })
      if (group.getLayers().length) map.fitBounds(group.getBounds(), { padding: [10, 10] })
      else map.setView([42.6, -113.6], 10)
    })
    return () => { gone = true; if (map) map.remove() }
  }, [kml])
  return <div className="fmf-map" ref={el} />
}
