// Pure helpers for the Contracts module — no React or Firebase here, so the
// math can be checked on its own.
//
// Every contract converts to and from acres through one "units per acre"
// factor:
//   cwt / tons → expected yield per acre (e.g. 450 cwt/ac, 38 tons/ac)
//   shares     → 1 / acres-per-share   (e.g. beet shares at 1.0 ac/share)
//   acres      → 1

export const UNITS = {
  cwt: { name: 'Cwt (hundredweight)', label: 'cwt', kind: 'yield' },
  tons: { name: 'Tons', label: 'tons', kind: 'yield' },
  shares: { name: 'Shares', label: 'shares', kind: 'share' },
  acres: { name: 'Acres', label: 'ac', kind: 'acres' }
}

// Within this many percent of the contracted amount counts as "filled",
// since whole-field allocation rarely lands exactly on the number.
export const FILL_TOLERANCE_PCT = 2

export function unitsPerAcre(contract) {
  const u = UNITS[contract && contract.unit]
  if (!u) return null
  if (u.kind === 'acres') return 1
  if (u.kind === 'yield') return contract.yieldPerAcre > 0 ? Number(contract.yieldPerAcre) : null
  if (u.kind === 'share') return contract.acresPerShare > 0 ? 1 / Number(contract.acresPerShare) : null
  return null
}

export function acresToUnits(contract, acres) {
  const f = unitsPerAcre(contract)
  return f == null ? null : acres * f
}

export function unitsToAcres(contract, units) {
  const f = unitsPerAcre(contract)
  return f == null ? null : units / f
}

export function contractProgress(contract, allocatedAcres) {
  const amount = Number(contract.amount) || 0
  const f = unitsPerAcre(contract)
  if (f == null || !(amount > 0)) {
    return { allocatedAcres, allocatedUnits: null, targetAcres: null, remainingUnits: null, remainingAcres: null, pct: null, status: 'incomplete' }
  }
  const allocatedUnits = allocatedAcres * f
  const targetAcres = amount / f
  const pct = (allocatedUnits / amount) * 100
  const status = pct > 100 + FILL_TOLERANCE_PCT ? 'over' : pct >= 100 - FILL_TOLERANCE_PCT ? 'filled' : 'open'
  return {
    allocatedAcres,
    allocatedUnits,
    targetAcres,
    remainingUnits: amount - allocatedUnits,
    remainingAcres: targetAcres - allocatedAcres,
    pct,
    status
  }
}

const norm = (s) => String(s || '').trim().toUpperCase()

// A field can go on a contract when the crop matches and, if the contract
// lists varieties, the field's variety is one of them.
export function fieldMatchesContract(field, contract) {
  if (!field || !contract) return false
  if (norm(field.crop) !== norm(contract.crop)) return false
  const vs = (contract.varieties || []).map(norm)
  return vs.length === 0 || vs.includes(norm(field.variety))
}

export function fmtNum(n, digits = 1) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
