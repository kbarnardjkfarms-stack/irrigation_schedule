import { useEffect, useMemo, useState } from 'react'
import { collection, collectionGroup, onSnapshot, query, where } from 'firebase/firestore'
import { db } from './firebase.js'
import AgronomyByField from './AgronomyByField.jsx'
import AgronomyByCriteria from './AgronomyByCriteria.jsx'
import AgronomySampleDatabase from './AgronomySampleDatabase.jsx'
import AgronomyCleanup from './AgronomyCleanup.jsx'

export default function Agronomy() {
  const [view, setView] = useState('field')
  const [baseFieldsById, setBaseFieldsById] = useState({})
  const [seasonDataByField, setSeasonDataByField] = useState({})
  const [seasons, setSeasons] = useState([])
  const [selectedSeasonId, setSelectedSeasonId] = useState(null)
  const [farms, setFarms] = useState([])
  const [selectedFarmId, setSelectedFarmId] = useState('all')

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'fields'), (snap) => {
      const next = {}
      snap.forEach((d) => { next[d.id] = d.data() })
      setBaseFieldsById(next)
    })
    return () => unsub()
  }, [])

  // Same "default to the season matching the current calendar year"
  // pattern used in App.jsx and PublicScheduleView.jsx.
  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'seasons'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
      setSeasons(list)
      setSelectedSeasonId((prev) => {
        if (prev) return prev
        const currentYear = String(new Date().getFullYear())
        const currentSeason = list.find((s) => String(s.name) === currentYear)
        return currentSeason ? currentSeason.id : (list[0] ? list[0].id : null)
      })
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'farms'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setFarms(list)
    })
    return () => unsub()
  }, [])

  // Same collectionGroup query App.jsx uses to pull every field's
  // per-season crop/acreage data at once for the currently selected season.
  useEffect(() => {
    if (!selectedSeasonId) return
    const q = query(collectionGroup(db, 'seasons'), where('seasonId', '==', selectedSeasonId))
    const unsub = onSnapshot(q, (snap) => {
      const next = {}
      snap.forEach((d) => {
        const fieldId = d.ref.parent.parent.id
        next[fieldId] = d.data()
      })
      setSeasonDataByField(next)
    })
    return () => unsub()
  }, [selectedSeasonId])

  // Unfiltered by farm, on purpose - Cleanup needs every field selectable
  // regardless of whatever farm the person happens to have picked, since
  // an orphaned sample could belong to a field in any farm. Also doesn't
  // depend on season, since matching a sample to a field is about the
  // field's name/id, not which crop is currently planted there.
  const allFields = useMemo(() => {
    return Object.entries(baseFieldsById)
      .map(([id, base]) => ({ id, name: base.name, farmId: base.farmId, farmName: base.farmName }))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [baseFieldsById])

  // Season- and farm-aware field list for the other three tabs - crop,
  // acres, and plant date all come from the selected season's data, and
  // the farm filter narrows the list the same way it does in the
  // irrigation schedule.
  const fields = useMemo(() => {
    return Object.entries(baseFieldsById)
      .filter(([id]) => seasonDataByField[id])
      .map(([id, base]) => {
        const seasonData = seasonDataByField[id] || {}
        return {
          id,
          name: base.name,
          farmId: base.farmId,
          farmName: base.farmName,
          cropName: (seasonData.cropName || '').toUpperCase(),
          varietyName: seasonData.varietyName || null,
          acres: seasonData.acres || null,
          plantDate: seasonData.plantDate || null
        }
      })
      .filter((f) => selectedFarmId === 'all' || String(f.farmId) === String(selectedFarmId))
      .sort((a, b) => (a.name || '').localeCompare(b.name || ''))
  }, [baseFieldsById, seasonDataByField, selectedFarmId])

  return (
    <div className="agronomy">
      <div className="agronomy-filter-bar">
        {seasons.length > 0 && (
          <select value={selectedSeasonId || ''} onChange={(e) => setSelectedSeasonId(e.target.value)}>
            {seasons.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
        <select value={selectedFarmId} onChange={(e) => setSelectedFarmId(e.target.value)}>
          <option value="all">All farms</option>
          {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
        </select>
      </div>

      <div className="agronomy-view-toggle">
        <button className={view === 'field' ? 'active' : ''} onClick={() => setView('field')}>
          By field
        </button>
        <button className={view === 'criteria' ? 'active' : ''} onClick={() => setView('criteria')}>
          By criteria
        </button>
        <button className={view === 'database' ? 'active' : ''} onClick={() => setView('database')}>
          All samples
        </button>
        <button className={view === 'cleanup' ? 'active' : ''} onClick={() => setView('cleanup')}>
          Cleanup
        </button>
      </div>

      {view === 'field' && <AgronomyByField fields={fields} />}
      {view === 'criteria' && <AgronomyByCriteria fields={fields} />}
      {view === 'database' && <AgronomySampleDatabase fields={fields} />}
      {view === 'cleanup' && <AgronomyCleanup fields={allFields} />}
    </div>
  )
}
