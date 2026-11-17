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
// lists varieties, the field's variety is one of them. A field with no
// variety yet (next season, before Agworld has one) fits any contract for its
// crop — its variety is then picked from the contract's list.
export function fieldMatchesContract(field, contract) {
  if (!field || !contract) return false
  if (norm(field.crop) !== norm(contract.crop)) return false
  return !field.variety || contractAllowsVariety(contract, field.variety)
}
export function contractAllowsVariety(contract, variety) {
  const vs = ((contract && contract.varieties) || []).map(norm)
  return vs.length === 0 || vs.includes(norm(variety))
}
export const sameCrop = (field, contract) => !!field && !!contract && norm(field.crop) === norm(contract.crop)
// The variety a field gets when it's put on a contract: none to set when the
// field's own (Agworld) variety is allowed, the contract's only variety when
// it lists just one, otherwise left for the user to pick.
export function defaultPlannedVariety(agworldVariety, contract) {
  const vs = (contract && contract.varieties) || []
  if (!vs.length) return null
  if (agworldVariety && contractAllowsVariety(contract, agworldVariety)) return null
  return vs.length === 1 ? vs[0] : null
}

export function fmtNum(n, digits = 1) {
  if (n == null || isNaN(n)) return '—'
  return Number(n).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
