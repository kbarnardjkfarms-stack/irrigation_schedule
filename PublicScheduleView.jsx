import { useState, useEffect, useMemo } from 'react'
import { signInAnonymously } from 'firebase/auth'
import { collection, collectionGroup, onSnapshot, query, where } from 'firebase/firestore'
import { auth, db } from './firebase.js'
import PivotIcon from './PivotIcon.jsx'
import aioLogoIcon from './aio-logo-icon.png'

// This page is intentionally self-contained. It duplicates a handful of small
// pure helpers from App.jsx (BLOCKS, CROP_COLOR, cellState, etc.) rather than
// importing them, so that editing the main schedule editor can never
// accidentally break this read-only page or vice versa. If that duplication
// ever becomes annoying, the fix is to pull these into a shared
// scheduleHelpers.js that both files import from.

const BLOCKS = { am: { start: 0, end: 12, len: 12 }, pm: { start: 12, end: 24, len: 12 } }

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

function fmtDate(d) { return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) }

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
  else return { background: '#efefef', color: '#999' }
  if (additive === 'fert') return { background: `linear-gradient(135deg, ${base} 50%, #EF9F27 50%)`, color: '#fff' }
  if (additive === 'chem') return { background: `linear-gradient(135deg, ${base} 50%, #D85A30 50%)`, color: '#fff' }
  return { background: base, color: '#fff' }
}

const STRINGS = {
  en: {
    waterOrder: 'Water order', viewOnly: 'View only', today: 'Today', tomorrow: 'Tomorrow',
    timer: 'Timer', noPivot: 'No pivot', on: 'ON', running: '', off: 'OFF AT', stop: 'STOP',
    sis: 'OFF AT SIS', none: '\u2014', loading: 'Loading\u2026',
    notFound: 'Farm not found. Check the link with your farm manager.',
    authError: "This page isn't working right now \u2014 ask your farm manager to check the setup.",
    connecting: 'Connecting\u2026'
  },
  es: {
    waterOrder: 'Horario de agua', viewOnly: 'Solo lectura', today: 'Hoy', tomorrow: 'Ma\u00f1ana',
    timer: 'Temporizador', noPivot: 'Sin pivote', on: 'ENCIENDE', running: '', off: 'APAGA A LAS', stop: 'PARAR',
    sis: 'APAGA EN SIS', none: '\u2014', loading: 'Cargando\u2026',
    notFound: 'Granja no encontrada. Consulte el enlace con su gerente.',
    authError: 'Esta p\u00e1gina no funciona en este momento. Avise a su gerente.',
    connecting: 'Conectando\u2026'
  }
}

function Cell({ state, additive, ev, t }) {
  const style = styleForState(state, additive)
  let content = t.none
  if (state === 'coming-off') {
    const disp = ev?.display || 'time'
    content = disp === 'stop' ? t.stop
      : disp === 'sis' ? (ev.sisDegrees != null ? ev.sisDegrees + '\u00b0' : t.sis)
      : fmtHour(ev.ts % 24)
  } else if (state === 'coming-on') {
    content = fmtHour(ev.ts % 24)
  } else if (state === 'full') {
    content = ''
  }
  const showLabel = state === 'coming-off' ? t.off : state === 'coming-on' ? t.on : ''
  return (
    <div style={{ flex: 1, textAlign: 'center' }}>
      <div style={{ ...style, borderRadius: '5px', padding: '6px 2px', fontSize: '10px', fontWeight: 600, lineHeight: 1.25 }}>
        {showLabel && <div style={{ fontSize: '8px', opacity: 0.9 }}>{showLabel}</div>}
        <div>{content}</div>
      </div>
    </div>
  )
}

export default function PublicScheduleView({ slug }) {
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
  const [seasons, setSeasons] = useState([])
  const [eventsToday, setEventsToday] = useState({})
  const [eventsTomorrow, setEventsTomorrow] = useState({})

  // Anonymous sign-in — invisible to the person, no login UI. This is what
  // satisfies "request.auth != null" in firestore.rules without a real
  // account. Requires Anonymous sign-in to be turned on in the Firebase
  // Console (Authentication > Sign-in method) — it's off by default.
  useEffect(() => {
    if (auth.currentUser) { setAuthReady(true); return }
    signInAnonymously(auth)
      .then(() => setAuthReady(true))
      .catch((err) => setAuthError(err.code || 'unknown-error'))
  }, [])

  // Recheck the date every few minutes in case this tab is left open
  // overnight — otherwise "today"/"tomorrow" would silently go stale.
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
        return {
          id,
          fieldName: base.name,
          crop: (seasonData.cropName || '').toUpperCase(),
          pivot
        }
      })
      .sort((a, b) => (a.fieldName || '').localeCompare(b.fieldName || ''))
  }, [farm, baseFieldsById, seasonDataByField, pivotGuidByFieldId, pivotsByGuid])

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

  return (
    <div style={{ minHeight: '100vh', background: '#f4f2ec', paddingBottom: '2rem' }}>
      <div style={{ background: '#DEEAD2', color: '#3c5a3f', padding: '14px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <img src={aioLogoIcon} alt="AIO" style={{ height: '32px' }} />
            <div>
              <div style={{ fontSize: '15px', fontWeight: 600 }}>{farm.name} \u00b7 {t.waterOrder}</div>
              <div style={{ fontSize: '11px', color: '#5c7a5f', marginTop: '2px' }}>
                {t.today} {fmtDate(now)} \u00b7 {t.tomorrow} {fmtDate(tomorrowDate)} \u00b7 {t.viewOnly}
              </div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button
              onClick={() => setLang('en')}
              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '6px', border: '1px solid #3c5a3f', background: lang === 'en' ? '#3c5a3f' : 'transparent', color: lang === 'en' ? '#fff' : '#3c5a3f' }}
            >EN</button>
            <button
              onClick={() => setLang('es')}
              style={{ padding: '4px 8px', fontSize: '11px', borderRadius: '6px', border: '1px solid #3c5a3f', background: lang === 'es' ? '#3c5a3f' : 'transparent', color: lang === 'es' ? '#fff' : '#3c5a3f' }}
            >ES</button>
          </div>
        </div>
      </div>

      <div style={{ maxWidth: '480px', margin: '0 auto' }}>
        {fields.map((field) => {
          const todayEvents = eventsToday[field.id] || []
          const tomorrowEvents = eventsTomorrow[field.id] || []
          const color = CROP_COLOR[field.crop] || { bg: '#D3D1C7', fg: '#2C2C2A' }
          const cells = [
            { events: todayEvents, dayIdx: dayIdxToday, shift: 'am' },
            { events: todayEvents, dayIdx: dayIdxToday, shift: 'pm' },
            { events: tomorrowEvents, dayIdx: dayIdxTomorrow, shift: 'am' },
            { events: tomorrowEvents, dayIdx: dayIdxTomorrow, shift: 'pm' }
          ]
          return (
            <div key={field.id} style={{ background: '#fff', borderBottom: '1px solid #eee', padding: '10px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <PivotIcon pivot={field.pivot} size={36} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{field.fieldName}</div>
                  <div style={{ fontSize: '10px', color: '#666', marginTop: '2px' }}>
                    {field.crop && <span style={{ background: color.bg, color: color.fg, padding: '1px 5px', borderRadius: '4px', fontWeight: 500 }}>{field.crop}</span>}
                    {' \u00b7 '}{t.timer}{': '}{field.pivot ? `${field.pivot.percentTimer}%` : t.noPivot}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '4px', marginTop: '8px', marginLeft: '46px' }}>
                {cells.map((c, i) => {
                  const state = cellState(c.events, c.dayIdx, c.shift)
                  const additive = cellAdditive(c.events, c.dayIdx, c.shift)
                  const ev = findEventInBlock(c.events, c.dayIdx, c.shift)
                  return <Cell key={i} state={state} additive={additive} ev={ev} t={t} />
                })}
              </div>
            </div>
          )
        })}
        {fields.length === 0 && (
          <div style={{ padding: '2rem', textAlign: 'center', color: '#888' }}>{t.loading}</div>
        )}
      </div>
    </div>
  )
}
