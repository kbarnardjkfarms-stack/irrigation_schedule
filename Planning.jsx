import { useState } from 'react'
import Contracts from './Contracts.jsx'
import Seed from './Seed.jsx'

// Planning module (was the Contracts tile): the season's planning in one place —
//   Contracts     contracts, acres and allocations, storage plan (Contracts.jsx)
//   Potato seed   seed tickets, needs, contracted seed and sales (Seed.jsx)
// Both modules keep their own permissions ('contracts' and 'seed'), so a
// login only sees the tabs it has. Potato planting staff still go straight
// to their seed ticket screen and never see this page. The tab last used is
// remembered on this device. Uses the Operations tab bar styles (ops-nav).

const SECTIONS = [
  { id: 'contracts', label: 'Contracts', sub: 'Contracts, acres & storage' },
  { id: 'seed', label: 'Potato Seed', sub: 'Tickets, needs & sales' }
]
const KEY = 'aio.planning.section'

export default function Planning({ userRole, canContracts = true, canSeed = true, initial = null }) {
  const allowed = SECTIONS.filter((s) => (s.id === 'contracts' ? canContracts : canSeed))
  const [section, setSection] = useState(() => {
    let saved = null
    try { saved = window.localStorage.getItem(KEY) } catch { saved = null }
    const want = initial || saved || 'contracts'
    return allowed.some((s) => s.id === want) ? want : (allowed[0] ? allowed[0].id : null)
  })
  const pick = (id) => {
    setSection(id)
    try { window.localStorage.setItem(KEY, id) } catch { /* private window: just don't remember */ }
  }
  if (!allowed.length) return null
  return (
    <div className="ops-hub planning-hub">
      {allowed.length > 1 && (
        <div className="ops-nav" role="tablist">
          {allowed.map((s) => (
            <button key={s.id} role="tab" aria-selected={section === s.id} className={section === s.id ? 'on' : ''} onClick={() => pick(s.id)}>
              <b>{s.label}</b><small>{s.sub}</small>
            </button>
          ))}
        </div>
      )}
      {section === 'contracts' && <Contracts userRole={userRole} />}
      {section === 'seed' && <Seed userRole={userRole} />}
    </div>
  )
}
