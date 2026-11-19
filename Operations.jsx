import { useState } from 'react'
import Harvest from './Harvest.jsx'
import GroundWork from './GroundWork.jsx'
import Spray from './Spray.jsx'

// Operations module: the season's field operations in one place —
//   Planting     planting crews on the Harvest screens (Harvest.jsx with
//                mode="planting": plantPlans/plantFields/plantLogs); each
//                field waits for its ground work
//   Ground work  Dominators, Karats, the Wilcox, Roller Harrows… (GroundWork.jsx)
//   Spray        the spray schedule (Spray.jsx, unchanged; was its own tile)
//   Harvest      the harvest teams (Harvest.jsx)
// The section last used is remembered on this device;
// the first time, it opens on what's in season (ground work early spring,
// planting late spring, harvest otherwise).

const SECTIONS = [
  { id: 'planting', label: 'Planting', sub: 'Planting crews' },
  { id: 'ground', label: 'Ground work', sub: 'Tillage passes by machine' },
  { id: 'spray', label: 'Spray', sub: 'Drone crew & Ag Rows' },
  { id: 'harvest', label: 'Harvest', sub: 'Harvest teams' }
]
const KEY = 'aio.operations.section'
function inSeason() {
  const m = new Date().getMonth() // 0 = Jan
  if (m <= 3) return 'ground'
  if (m <= 5) return 'planting'
  return 'harvest'
}

export default function Operations({ userRole, canHarvest = true, canField = true, canSpray = false, sprayAdmin = false, userProfile = null, initial = null }) {
  const allowed = SECTIONS.filter((s) => (s.id === 'harvest' ? canHarvest : s.id === 'spray' ? canSpray : canField))
  const [section, setSection] = useState(() => {
    let saved = null
    try { saved = window.localStorage.getItem(KEY) } catch { saved = null }
    const want = initial || saved || inSeason()
    return allowed.some((s) => s.id === want) ? want : (allowed[0] ? allowed[0].id : null)
  })
  const pick = (id) => {
    setSection(id)
    try { window.localStorage.setItem(KEY, id) } catch { /* private window: just don't remember */ }
  }
  if (!allowed.length) return null
  return (
    <div className="ops-hub">
      {allowed.length > 1 && (
        <div className="ops-nav" role="tablist">
          {allowed.map((s) => (
            <button key={s.id} role="tab" aria-selected={section === s.id} className={section === s.id ? 'on' : ''} onClick={() => pick(s.id)}>
              <b>{s.label}</b><small>{s.sub}</small>
            </button>
          ))}
        </div>
      )}
      {section === 'planting' && <Harvest key="planting" mode="planting" userRole={userRole} />}
      {section === 'ground' && <GroundWork key="ground" kind="ground" userRole={userRole} />}
      {section === 'spray' && <Spray userRole={userRole} sprayAdmin={sprayAdmin} userProfile={userProfile} />}
      {section === 'harvest' && <Harvest key="harvest" userRole={userRole} />}
    </div>
  )
}
