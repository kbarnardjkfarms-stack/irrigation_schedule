import { useState, useEffect, useMemo, Fragment } from 'react'
import { useRegisterSW } from 'virtual:pwa-register/react'
import { signInAnonymously } from 'firebase/auth'
import { collection, collectionGroup, onSnapshot, query, where } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import PivotIcon from './PivotIcon.jsx'
import PivotDetailPanel from './PivotDetailPanel.jsx'
import aioLogoIcon from './aio-logo-icon.png'

// This page reuses the real table markup and the real styles.css classes
// (sticky-col, day-head, shift-head, cell-btn, legend, etc.) so it looks
// identical to the logged-in schedule — just frozen to 2 days and read-only.
// It duplicates a handful of small pure helpers from App.jsx (BLOCKS,
// CROP_COLOR, cellState, etc.) rather than importing them, so editing the
// main schedule editor can never accidentally break this page or vice versa.
// If that duplication ever becomes annoying, the fix is pulling these into a
// shared scheduleHelpers.js that both files import from.

const BLOCKS = { am: { start: 0, end: 12, len: 12 }, pm: { start: 12, end: 24, len: 12 } }
const DAY_TINTS = ['#C8CCD0', '#B9CCDF']
function dayTint(dayIdx) { return DAY_TINTS[dayIdx % 2] }

const CROP_COLOR = {
  POTATO: { bg: '#D6B48C', fg: '#4A2E12' }, POTATOES: { bg: '#D6B48C', fg: '#4A2E12' },
  CORN: { bg: '#FCE9A8', fg: '#7A5C02' }, 'SWEET CORN': { bg: '#FCE9A8', fg: '#7A5C02' },
  ALFALFA: { bg: '#C0DD97', fg: '#173404' }, HAY: { bg: '#C0DD97', fg: '#173404' },
  'SUGAR BEET': { bg: '#E0D6F5', fg: '#3D2B6B' }, BEETS: { bg: '#E0D6F5', fg: '#3D2B6B' },
  FALLOW: { bg: '#E4E1D8', fg: '#5A574C' }, ONIONS: { bg: '#F4C0D1', fg: '#4B1528' },
  MINT: { bg: '#9FE1CB', fg: '#04342C' }, CARROTS: { bg: '#FAD9BB', fg: '#7A3E0A' },
  SQUASH: { bg: '#F5C98A', fg: '#6B3D02' }
}

function slugifyFarmName(name) {
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function mondayOf(d) {
  const date = new Date(d)
  const day = date.getDay()
  date.setDate(date.getDate() + (day === 0 ? -6 : 1 - day))
  date.setHours(0, 0, 0, 0)
  return date
}

function addDays(d, n) { const nd = new Date(d); nd.setDate(nd.getDate() + n); return nd }
function isoDate(d) { return d.toISOString().slice(0, 10) }
function dayIdxOf(d) { return (d.getDay() + 6) % 7 }

function fmtHour(h) {
  const hr24 = ((h % 24) + 24) % 24
  const period = hr24 >= 12 ? 'pm' : 'am'
  let hr12 = Math.floor(hr24) % 12; if (hr12 === 0) hr12 = 12
  const mins = Math.round((hr24 % 1) * 60)
  return hr12 + (mins ? ':' + String(mins).padStart(2, '0') : '') + period
}

function fmtShort(d) { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) }

function onIntervals(events) {
  const evs = [...events].sort((a, b) => a.ts - b.ts)
  const intervals = []
  let state = false, cursor = 0, source = null
  evs.forEach((e) => {
    if (state) intervals.push({ start: cursor, end: e.ts, source })
    cursor = e.ts
    state = e.type === 'on'
    if (state) source = e
  })
  if (state) intervals.push({ start: cursor, end: 168, source })
  return intervals
}

function overlapHours(intervals, start, end) {
  let t = 0
  intervals.forEach((iv) => { t += Math.max(0, Math.min(iv.end, end) - Math.max(iv.start, start)) })
  return t
}

function findEventInBlock(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  const s = dayIdx * 24 + b.start, e = dayIdx * 24 + b.end
  return events.find((ev) => ev.ts >= s && ev.ts < e)
}

function cellHours(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  return overlapHours(onIntervals(events), dayIdx * 24 + b.start, dayIdx * 24 + b.end)
}

function cellAdditive(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  const s = dayIdx * 24 + b.start, e = dayIdx * 24 + b.end
  const iv = onIntervals(events).find((iv) => iv.start < e && iv.end > s)
  return iv && iv.source ? iv.source.additive : null
}

function cellState(events, dayIdx, shift) {
  const b = BLOCKS[shift]
  const hrs = cellHours(events, dayIdx, shift)
  if (hrs <= 0) return 'off'
  if (hrs >= b.len - 0.01) return 'full'
  const ev = findEventInBlock(events, dayIdx, shift)
  if (ev && ev.type === 'on') return 'coming-on'
  if (ev && ev.type === 'off') return 'coming-off'
  return 'full'
}

function styleForState(state, additive) {
  let base
  if (state === 'coming-on') base = '#3B6D11'
  else if (state === 'full') base = '#185FA5'
  else if (state === 'coming-off') base = '#A32D2D'
  else return { background: '#f4f2ec', color: '#888' }
  if (additive === 'fert') return { background: `linear-gradient(135deg, ${base} 50%, #EF9F27 50%)`, color: '#fff' }
  if (additive === 'chem') return { background: `linear-gradient(135deg, ${base} 50%, #D85A30 50%)`, color: '#fff' }
  return { background: base, color: '#fff' }
}

const STRINGS = {
  en: {
    waterOrder: 'Water order', viewOnly: 'View only', today: 'Today', tomorrow: 'Tomorrow',
    fieldCrop: 'Field / crop', comingOn: 'Coming on', onWhole: 'On whole block', comingOff: 'Coming off',
    fert: '+ Fert', chem: '+ Chem', stop: 'STOP', off: 'OFF AT', on: 'ON',
    none: '\u2013', loading: 'Loading\u2026',
    notFound: 'Farm not found. Check the link with your farm manager.',
    authError: "This page isn't working right now \u2014 ask your farm manager to check the setup.",
    connecting: 'Connecting\u2026'
  },
  es: {
    waterOrder: 'Horario de agua', viewOnly: 'Solo lectura', today: 'Hoy', tomorrow: 'Ma\u00f1ana',
    fieldCrop: 'Campo / cultivo', comingOn: 'Encendiendo', onWhole: 'Corriendo todo', comingOff: 'Apagando',
    fert: '+ Fert', chem: '+ Qu\u00edm', stop: 'PARAR', off: 'APAGA A LAS', on: 'ENCIENDE',
    none: '\u2013', loading: 'Cargando\u2026',
    notFound: 'Granja no encontrada. Consulte el enlace con su gerente.',
    authError: 'Esta p\u00e1gina no funciona en este momento. Avise a su gerente.',
    connecting: 'Conectando\u2026'
  }
}

export default function PublicScheduleView({ slug }) {
  const {
    needRefresh: [needRefresh],
    updateServiceWorker
  } = useRegisterSW()
  useEffect(() => {
    if (needRefresh) updateServiceWorker(true)
  }, [needRefresh, updateServiceWorker])

  const [lang, setLang] = useState(() => {
    const saved = localStorage.getItem('aio-watch-lang')
    if (saved) return saved
    return navigator.language && navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en'
  })
  useEffect(() => { localStorage.setItem('aio-watch-lang', lang) }, [lang])
  const t = STRINGS[lang]

  const [authReady, setAuthReady] = useState(false)
  const [authError, setAuthError] = useState(null)
  const [now, setNow] = useState(() => new Date())
  const [farms, setFarms] = useState([])
  const [baseFieldsById, setBaseFieldsById] = useState({})
  const [seasonDataByField, setSeasonDataByField] = useState({})
  const [pivotGuidByFieldId, setPivotGuidByFieldId] = useState({})
  const [pivotsByGuid, setPivotsByGuid] = useState({})
  const [pivotProfilesByGuid, setPivotProfilesByGuid] = useState({})
  const [seasons, setSeasons] = useState([])
  const [eventsToday, setEventsToday] = useState({})
  const [eventsTomorrow, setEventsTomorrow] = useState({})
  const [expandedFieldId, setExpandedFieldId] = useState(null)

  useEffect(() => {
    if (auth.currentUser) { setAuthReady(true); return }
    signInAnonymously(auth)
      .then(() => setAuthReady(true))
      .catch((err) => setAuthError(err.code || 'unknown-error'))
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 5 * 60 * 1000)
    return () => clearInterval(id)
  }, [])

  useEffect(() => {
    if (!authReady) return
    const unsub = onSnapshot(collection(db, 'farms'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setFarms(list)
    })
    return () => unsub()
  }, [authReady])

  useEffect(() => {
    if (!authReady) return
    const unsub = onSnapshot(collection(db, 'fields'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data() })
      setBaseFieldsById(next)
    })
    return () => unsub()
  }, [authReady])

  useEffect(() => {
    if (!authReady) return
    const unsub = onSnapshot(collection(db, 'pivotFieldMapping'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.data().fieldId] = d.data().pivotGuid })
      setPivotGuidByFieldId(next)
    })
    return () => unsub()
  }, [authReady])

  useEffect(() => {
    if (!authReady) return
    const unsub = onSnapshot(collection(db, 'pivots'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data() })
      setPivotsByGuid(next)
    })
    return () => unsub()
  }, [authReady])

  // Read-only here on purpose — this page has no login, so there's no
  // "Clear error" action, just the same red badge the logged-in app shows.
  useEffect(() => {
    if (!authReady) return
    const unsub = onSnapshot(collection(db, 'pivotProfiles'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data() })
      setPivotProfilesByGuid(next)
    })
    return () => unsub()
  }, [authReady])

  useEffect(() => {
    if (!authReady) return
    const unsub = onSnapshot(collection(db, 'seasons'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      setSeasons(list)
    })
    return () => unsub()
  }, [authReady])

  const selectedSeasonId = useMemo(() => {
    const currentYear = String(new Date().getFullYear())
    const currentSeason = seasons.find((s) => String(s.name) === currentYear)
    return currentSeason ? currentSeason.id : (seasons[0] ? seasons[0].id : null)
  }, [seasons])

  useEffect(() => {
    if (!authReady || !selectedSeasonId) return
    const q = query(collectionGroup(db, 'seasons'), where('seasonId', '==', selectedSeasonId))
    const unsub = onSnapshot(q, (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.ref.parent.parent.id] = d.data() })
      setSeasonDataByField(next)
    })
    return () => unsub()
  }, [authReady, selectedSeasonId])

  const tomorrowDate = useMemo(() => addDays(now, 1), [now])
  const weekIdToday = useMemo(() => isoDate(mondayOf(now)), [now])
  const weekIdTomorrow = useMemo(() => isoDate(mondayOf(tomorrowDate)), [tomorrowDate])
  const dayIdxToday = useMemo(() => dayIdxOf(now), [now])
  const dayIdxTomorrow = useMemo(() => dayIdxOf(tomorrowDate), [tomorrowDate])

  useEffect(() => {
    if (!authReady) return
    const unsub = onSnapshot(collection(db, 'weeks', weekIdToday, 'events'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data().events || [] })
      setEventsToday(next)
    })
    return () => unsub()
  }, [authReady, weekIdToday])

  useEffect(() => {
    if (!authReady) return
    if (weekIdTomorrow === weekIdToday) { setEventsTomorrow(eventsToday); return }
    const unsub = onSnapshot(collection(db, 'weeks', weekIdTomorrow, 'events'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data().events || [] })
      setEventsTomorrow(next)
    })
    return () => unsub()
  }, [authReady, weekIdTomorrow, weekIdToday, eventsToday])

  const farm = useMemo(() => farms.find((f) => slugifyFarmName(f.name) === slug), [farms, slug])

  const fields = useMemo(() => {
    if (!farm) return []
    return Object.entries(baseFieldsById)
      .filter(([id, base]) => String(base.farmId) === String(farm.id) && seasonDataByField[id])
      .map(([id, base]) => {
        const seasonData = seasonDataByField[id] || {}
        const pivotGuid = pivotGuidByFieldId[id]
        const pivot = pivotGuid ? pivotsByGuid[pivotGuid] : null
        const stuckAlert = pivotGuid ? !!pivotProfilesByGuid[pivotGuid]?.stuckAlertActive : false
        return {
          id,
          fieldName: base.name,
          crop: (seasonData.cropName || '').toUpperCase(),
          acres: seasonData.acres || null,
          pivot,
          stuckAlert
        }
      })
      .sort((a, b) => (a.fieldName || '').localeCompare(b.fieldName || ''))
  }, [farm, baseFieldsById, seasonDataByField, pivotGuidByFieldId, pivotsByGuid, pivotProfilesByGuid])

  if (authError) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '2rem', textAlign: 'center', background: '#f4f2ec' }}>
        <p style={{ color: '#A32D2D', maxWidth: '320px' }}>{t.authError}</p>
      </div>
    )
  }

  if (!authReady || farms.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', background: '#f4f2ec', color: '#888' }}>
        {t.connecting}
      </div>
    )
  }

  if (!farm) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '2rem', textAlign: 'center', background: '#f4f2ec' }}>
        <p style={{ color: '#A32D2D', maxWidth: '320px' }}>{t.notFound}</p>
      </div>
    )
  }

  function label(state, ev) {
    if (state === 'coming-off') {
      const disp = ev?.display || 'time'
      return disp === 'stop' ? (<><div className="tiny">{t.off}</div><div>{t.stop}</div></>)
        : disp === 'sis' ? (<><div className="tiny">{t.off} SIS</div><div>{ev.sisDegrees != null ? ev.sisDegrees + '\u00b0' : ''}</div></>)
        : (<><div className="tiny">{t.off}</div><div>{fmtHour(ev.ts % 24)}</div></>)
    }
    if (state === 'coming-on') return (<><div className="tiny">{t.on}</div><div>{fmtHour(ev.ts % 24)}</div></>)
    if (state === 'full') return ''
    return t.none
  }

  return (
    <div className="app">
      <header className="topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px' }}>
          <img src={aioLogoIcon} alt="AIO" style={{ height: '40px' }} />
          <div>
            <div style={{ fontWeight: 600 }}>{farm.name} &middot; {t.waterOrder}</div>
            <span className="status">{t.viewOnly}</span>
          </div>
        </div>
        <div style={{ display: 'flex', gap: '4px' }}>
          <button className={lang === 'en' ? 'active' : ''} onClick={() => setLang('en')}>EN</button>
          <button className={lang === 'es' ? 'active' : ''} onClick={() => setLang('es')}>ES</button>
        </div>
      </header>

      <div className="table-scroll">
        <table className="watch-table">
          <colgroup>
            <col className="watch-col-sticky" />
            <col className="watch-col-shift" />
            <col className="watch-col-shift" />
            <col className="watch-col-shift" />
            <col className="watch-col-shift" />
          </colgroup>
          <thead>
            <tr>
              <th className="sticky-col" rowSpan={2}>{t.fieldCrop}</th>
              <th colSpan={2} className="day-head" style={{ background: dayTint(dayIdxToday) }}>{t.today}<br /><span className="tiny">{fmtShort(now)}</span></th>
              <th colSpan={2} className="day-head" style={{ background: dayTint(dayIdxTomorrow) }}>{t.tomorrow}<br /><span className="tiny">{fmtShort(tomorrowDate)}</span></th>
            </tr>
            <tr>
              <th className="shift-head" style={{ background: dayTint(dayIdxToday) }}>AM</th>
              <th className="shift-head" style={{ background: dayTint(dayIdxToday) }}>PM</th>
              <th className="shift-head" style={{ background: dayTint(dayIdxTomorrow) }}>AM</th>
              <th className="shift-head" style={{ background: dayTint(dayIdxTomorrow) }}>PM</th>
            </tr>
          </thead>
          <tbody>
            {fields.map((field) => {
              const todayEvents = eventsToday[field.id] || []
              const tomorrowEvents = eventsTomorrow[field.id] || []
              const color = CROP_COLOR[field.crop] || { bg: '#D3D1C7', fg: '#2C2C2A' }
              const isExpanded = expandedFieldId === field.id
              const cells = [
                { events: todayEvents, dayIdx: dayIdxToday, shift: 'am' },
                { events: todayEvents, dayIdx: dayIdxToday, shift: 'pm' },
                { events: tomorrowEvents, dayIdx: dayIdxTomorrow, shift: 'am' },
                { events: tomorrowEvents, dayIdx: dayIdxTomorrow, shift: 'pm' }
              ]
              return (
                <Fragment key={field.id}>
                  <tr>
                    <td
                      className="sticky-col field-cell"
                      onClick={() => field.pivot && setExpandedFieldId(isExpanded ? null : field.id)}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <PivotIcon pivot={field.pivot} size={55} stuckAlert={field.stuckAlert} />
                        <div>
                          <div><strong>{field.fieldName}</strong></div>
                          <div style={{ marginTop: '4px' }}>
                            {field.crop && <span className="crop-badge" style={{ background: color.bg, color: color.fg }}>{field.crop}</span>}
                            {field.acres && <span className="acres-tag"> &middot; {field.acres.toFixed(1)} ac</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    {cells.map((c, i) => {
                      const state = cellState(c.events, c.dayIdx, c.shift)
                      const additive = cellAdditive(c.events, c.dayIdx, c.shift)
                      const ev = findEventInBlock(c.events, c.dayIdx, c.shift)
                      return (
                        <td key={i} className="cell-td" style={{ background: dayTint(c.dayIdx) }}>
                          <button className="cell-btn" disabled style={styleForState(state, additive)}>
                            {label(state, ev)}
                          </button>
                        </td>
                      )
                    })}
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={5} style={{ padding: 0 }}>
                        <PivotDetailPanel pivot={field.pivot} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              )
            })}
            {fields.length === 0 && (
              <tr><td colSpan={5} style={{ textAlign: 'center', color: '#888', padding: '2rem' }}>{t.loading}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="legend">
        <span><i className="swatch" style={{ background: '#3B6D11' }} />{t.comingOn}</span>
        <span><i className="swatch" style={{ background: '#185FA5' }} />{t.onWhole}</span>
        <span><i className="swatch" style={{ background: '#A32D2D' }} />{t.comingOff}</span>
        <span><i className="swatch" style={{ background: 'linear-gradient(135deg,#185FA5 50%,#EF9F27 50%)' }} />{t.fert}</span>
        <span><i className="swatch" style={{ background: 'linear-gradient(135deg,#185FA5 50%,#D85A30 50%)' }} />{t.chem}</span>
      </div>
    </div>
  )
}
