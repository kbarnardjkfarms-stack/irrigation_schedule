// Starter thresholds only. These target ranges are placeholders and need to
// be replaced with your real agronomic targets (they'll vary by crop, growth
// stage, and possibly variety). Keeping them here rather than hardcoded in
// components means tuning them later never means touching UI code.

export const SAMPLE_TYPE_LABEL = {
  soil: 'Soil',
  petiole: 'Petiole',
  nematode: 'Nematode',
  compost: 'Compost'
}

export const METRICS_BY_TYPE = {
  // Confirmed exact keys via a live SO query (Aug 2026): {"NO3":21,"Salts":1.2}.
  // Case-sensitive - JS object lookups won't match 'no3' against a real
  // key named 'NO3', so this has to be exact, not just readable.
  //
  // NOTE: target here is a flat, crop-agnostic fallback only. For potato,
  // beets, and corn, AgronomyByField now prefers the real week-by-week
  // target from WEEKLY_CURVES_BY_CROP below (Kent's actual agronomic
  // curves) and only falls back to this flat range for other crops or
  // weeks outside the curve's range.
  soil: [
    { key: 'NO3', label: 'NO3', unit: 'ppm', target: [15, 25] },
    { key: 'Salts', label: 'Salts', unit: 'mmhos/cm', target: [0, 2] }
  ],
  // NOT yet confirmed - same placeholder keys as before, still lowercase.
  // These need the same treatment as soil above: run
  // testStukenholtzDateRange with type=PL, type=NEMA, and type=CM to see
  // the real Results shape for each, then fix these keys to match exactly
  // (both spelling and case) before they'll actually populate in the UI.
  petiole: [
    { key: 'no3', label: 'NO3', unit: 'ppm', target: [18000, 28000] },
    { key: 'p', label: '%P', unit: '%', target: [0.25, 0.4] },
    { key: 'k', label: '%K', unit: '%', target: [8, 11] },
    { key: 'sulfur', label: 'Sulfur', unit: '%', target: [0.25, 0.4] }
  ],
  // Confirmed via a live NEMA query (Aug 2026): 19 distinct species counts,
  // not one generic number - COLMB RK/NORTHRK/root-knot species, several
  // free-living plant-parasitic types, and cyst nematode egg/larvae/
  // viability breakdowns for two species (BT = likely Beet cyst nematode,
  // relevant given sugar beet rotation; CER = likely Cereal cyst nematode -
  // both inferred from the abbreviation, not confirmed, so double-check
  // labels if either looks wrong). No target set on any of these - Kent
  // wants the raw counts brought in first and will set his own thresholds
  // for what should be highlighted, rather than guessed-at pest-count
  // targets (which don't fit the deficient/optimal/excess framing used
  // for nutrients anyway - a count has no "too low" concern).
  nematode: [
    { key: 'COLMB RK', label: 'Columbia Root-Knot', unit: '/250g', target: null },
    { key: 'NORTHRK', label: 'Northern Root-Knot', unit: '/250g', target: null },
    { key: 'ROOT LESION', label: 'Root Lesion', unit: '/250g', target: null },
    { key: 'PENROOTLES', label: 'Root Lesion (P. penetrans)', unit: '/250g', target: null },
    { key: 'PIN', label: 'Pin', unit: '/250g', target: null },
    { key: 'RING', label: 'Ring', unit: '/250g', target: null },
    { key: 'DAGGER', label: 'Dagger', unit: '/250g', target: null },
    { key: 'SHEATH', label: 'Sheath', unit: '/250g', target: null },
    { key: 'SPIRAL', label: 'Spiral', unit: '/250g', target: null },
    { key: 'STEM', label: 'Stem', unit: '/250g', target: null },
    { key: 'STUBBY', label: 'Stubby Root', unit: '/250g', target: null },
    { key: 'STUNT', label: 'Stunt', unit: '/250g', target: null },
    { key: 'BTCYSTEGG', label: 'Beet Cyst - Eggs', unit: '/250g', target: null },
    { key: 'BTCYSTEM', label: 'Beet Cyst - Empty Cysts', unit: '/250g', target: null },
    { key: 'BTCYSTLARV', label: 'Beet Cyst - Larvae', unit: '/250g', target: null },
    { key: 'BTCYSTVIAB', label: 'Beet Cyst - Viable', unit: '/250g', target: null },
    { key: 'CERCYSTEGG', label: 'Cereal Cyst - Eggs', unit: '/250g', target: null },
    { key: 'CERCYSTEMPT', label: 'Cereal Cyst - Empty Cysts', unit: '/250g', target: null },
    { key: 'CERCYSTLARV', label: 'Cereal Cyst - Larvae', unit: '/250g', target: null },
    { key: 'CERCYSTVIA', label: 'Cereal Cyst - Viable', unit: '/250g', target: null }
  ],
  compost: [
    { key: 'n', label: 'N', unit: '%', target: [1, 2] }
  ]
}

// Week-by-week nitrogen recommendation and nutrient target curves, by crop
// and week since emergence. Pulled directly from Kent's own
// CROP_NUTRIENT_CURVES.xlsx (Oct 2026) - this is the real agronomic
// reference data the flat ranges in METRICS_BY_TYPE above were always a
// placeholder for.
//
// Shape: WEEKLY_CURVES_BY_CROP[cropName] = array of
//   { week, nRec, soilNO3: [low, high] | null, petioleNO3: [low, high] | null,
//     petioleP: [low, high] | null, petioleK: [low, high] | null,
//     petioleS: [low, high] | null, stage?: string }
// ordered by week ascending.
//
// - nRec is lbs N/acre recommended that week (the "N Rec" KPI/curve).
// - `stage` is an optional growth-stage note carried over from the source
//   sheet (e.g. a vine-kill stage for potato, or a tasseling/end-of-N-window
//   marker for corn/beets) - display-only, not used in any calculation.
// - For potato weeks 13-17, the source sheet has a stage label (DYING /
//   X% DEAD) in the N-use column instead of a number - confirmed with Kent
//   this means 0 lbs N/acre recommended (not missing data), since nitrogen
//   applications stop once vine-kill starts.
// - Only potato's source sheet tracks %P/%K/Sulfur by week - beets and corn
//   only track Soil NO3 + Petiole NO3, so petioleP/petioleK/petioleS are
//   simply absent (undefined) on every beets/corn week.
// - Cropped to the weeks the source sheet actually defines - a week past a
//   crop's range (or a crop not in this table at all, e.g. onions) has no
//   entry, and callers should fall back to METRICS_BY_TYPE's flat target.
// - Keyed by the exact crop name used in the source workbook's tab names
//   (POTATO / BEETS / CORN). Confirm this matches the crop badge actually
//   shown on a beet field in the By Field view - if Agworld's cropName for
//   sugar beets ever comes through as "SUGAR BEET" instead of "BEETS",
//   this lookup will silently miss and just fall back to the flat target
//   rather than crash, but it's worth checking once real beet fields have
//   current-season samples.
export const WEEKLY_CURVES_BY_CROP = {
  POTATO: [
    { week: 1, nRec: 20, soilNO3: [35, 50] },
    { week: 2, nRec: 20, soilNO3: [33, 48] },
    { week: 3, nRec: 40, soilNO3: [32, 47], petioleNO3: [20000, 25000], petioleP: [0.45, 0.5], petioleK: [11.5, 12.5], petioleS: [0.18, 0.2] },
    { week: 4, nRec: 40, soilNO3: [31, 46], petioleNO3: [19200, 24000], petioleP: [0.45, 0.5], petioleK: [11, 12], petioleS: [0.18, 0.2] },
    { week: 5, nRec: 54, soilNO3: [25, 40], petioleNO3: [18400, 23000], petioleP: [0.4, 0.45], petioleK: [10.5, 12], petioleS: [0.18, 0.2] },
    { week: 6, nRec: 54, soilNO3: [20, 35], petioleNO3: [17600, 22000], petioleP: [0.38, 0.4], petioleK: [10.5, 11], petioleS: [0.15, 0.18] },
    { week: 7, nRec: 40, soilNO3: [15, 30], petioleNO3: [15000, 21000], petioleP: [0.38, 0.4], petioleK: [10, 10.5], petioleS: [0.15, 0.18] },
    { week: 8, nRec: 40, soilNO3: [10, 25], petioleNO3: [14500, 20000], petioleP: [0.33, 0.35], petioleK: [9.5, 10], petioleS: [0.15, 0.18] },
    { week: 9, nRec: 20, soilNO3: [10, 20], petioleNO3: [14000, 19000], petioleP: [0.33, 0.35], petioleK: [9.5, 10], petioleS: [0.14, 0.16] },
    { week: 10, nRec: 20, soilNO3: [5, 15], petioleNO3: [13500, 18000], petioleP: [0.28, 0.3], petioleK: [9, 9.5], petioleS: [0.14, 0.16] },
    { week: 11, nRec: 27, soilNO3: [5, 10], petioleNO3: [13000, 17300], petioleP: [0.28, 0.3], petioleK: [9, 9.5], petioleS: [0.12, 0.14] },
    { week: 12, nRec: 27, soilNO3: [5, 10], petioleNO3: [12500, 16600], petioleP: [0.28, 0.3], petioleK: [8.5, 9], petioleS: [0.12, 0.14] },
    { week: 13, nRec: 0, soilNO3: [5, 9], petioleNO3: [12000, 15800], petioleP: [0.28, 0.3], petioleK: [7.5, 8], petioleS: [0.1, 0.12], stage: 'DYING' },
    { week: 14, nRec: 0, soilNO3: [5, 8], petioleNO3: [11500, 15000], petioleP: [0.23, 0.25], petioleK: [6.5, 7], petioleS: [0.08, 0.1], stage: '10% DEAD' },
    { week: 15, nRec: 0, soilNO3: [4, 7], petioleNO3: [10000, 12500], petioleP: [0.2, 0.25], petioleK: [5.5, 6], petioleS: [0.08, 0.1], stage: '20% DEAD' },
    { week: 16, nRec: 0, soilNO3: [4, 5], petioleNO3: [7500, 10000], petioleP: [0.2, 0.25], petioleK: [5.5, 6], petioleS: [0.06, 0.08], stage: '30% DEAD' },
    { week: 17, nRec: 0, stage: '40% DEAD' }
  ],
  BEETS: [
    { week: 1, nRec: 0, soilNO3: [20, 35], petioleNO3: [10000, 15000] },
    { week: 2, nRec: 5, soilNO3: [17, 30], petioleNO3: [10000, 15000] },
    { week: 3, nRec: 15, soilNO3: [15, 25], petioleNO3: [10000, 15000] },
    { week: 4, nRec: 25, soilNO3: [13, 20], petioleNO3: [10000, 15000] },
    { week: 5, nRec: 30, soilNO3: [12, 17], petioleNO3: [10000, 15000] },
    { week: 6, nRec: 35, soilNO3: [10, 15], petioleNO3: [10000, 14000] },
    { week: 7, nRec: 35, soilNO3: [8, 13], petioleNO3: [8750, 13000] },
    { week: 8, nRec: 35, soilNO3: [6, 11], petioleNO3: [7500, 11750] },
    { week: 9, nRec: 35, soilNO3: [5, 9], petioleNO3: [6250, 10500] },
    { week: 10, nRec: 35, soilNO3: [5, 7], petioleNO3: [5000, 9250], stage: 'END N' },
    { week: 11, nRec: 35, soilNO3: [5, 7], petioleNO3: [3750, 8000] },
    { week: 12, nRec: null, soilNO3: [5, 7], petioleNO3: [2500, 6750] },
    { week: 13, nRec: null, soilNO3: [5, 7], petioleNO3: [2500, 5500] }
  ],
  CORN: [
    { week: 1, nRec: 0, soilNO3: [20, 35], petioleNO3: [2000, 3000] },
    { week: 2, nRec: 5, soilNO3: [17, 30], petioleNO3: [1800, 2800] },
    { week: 3, nRec: 10, soilNO3: [15, 25], petioleNO3: [1600, 2600] },
    { week: 4, nRec: 20, soilNO3: [13, 20], petioleNO3: [1400, 2400] },
    { week: 5, nRec: 30, soilNO3: [12, 17], petioleNO3: [1200, 2200] },
    { week: 6, nRec: 50, soilNO3: [10, 15], petioleNO3: [1000, 2000] },
    { week: 7, nRec: 50, soilNO3: [8, 13], petioleNO3: [800, 1800] },
    { week: 8, nRec: 50, soilNO3: [6, 11], petioleNO3: [700, 1600] },
    { week: 9, nRec: 50, soilNO3: [5, 9], petioleNO3: [600, 1400] },
    { week: 10, nRec: 15, soilNO3: [5, 7], petioleNO3: [500, 800], stage: 'VT' },
    { week: 11, nRec: 15, soilNO3: [5, 7], petioleNO3: [400, 600] },
    { week: 12, nRec: 5, soilNO3: [5, 7], petioleNO3: [300, 400] },
    { week: 13, nRec: 0, soilNO3: [5, 7], petioleNO3: [200, 200] },
    { week: 14, nRec: null, soilNO3: [5, 7], petioleNO3: [100, 100] }
  ]
}

// Dark values (fg) are the app's own tokens from styles.css - #3c5a3f is
// the same green as .topbar/button.active, #A32D2D is the same red as
// .mode-bar-actions .apply.danger, #854F0B is the same amber as
// .status.offline. Light values (bg) are new tints in the same hue,
// since styles.css doesn't define pastel backgrounds for these yet.
export const STATUS_COLOR = {
  deficient: { bg: '#F5DCDA', fg: '#A32D2D', dot: '#D32F2F' },
  optimal: { bg: '#DEEAD2', fg: '#3c5a3f', dot: '#2E8B3E' },
  excess: { bg: '#FDE3C4', fg: '#B35A00', dot: '#F08A00' }
}

// Reused verbatim from CROP_COLOR in PublicScheduleView.jsx (mint, alfalfa,
// onions, corn) rather than inventing a new palette for sample types.
export const SAMPLE_TYPE_BADGE_COLOR = {
  soil: { bg: '#9FE1CB', fg: '#04342C' },
  petiole: { bg: '#C0DD97', fg: '#173404' },
  nematode: { bg: '#F4C0D1', fg: '#4B1528' },
  compost: { bg: '#FCE9A8', fg: '#7A5C02' }
}

// Duplicated from CROP_COLOR in App.jsx/PublicScheduleView.jsx so the
// Agronomy module can show the same crop badge colors as the irrigation
// schedule. Kept in sync manually for now - if a crop is ever added or
// recolored in one place, update the other too, or consider extracting
// this to one shared file both import from.
export const CROP_COLOR = {
  POTATO: { bg: '#D6B48C', fg: '#4A2E12' }, POTATOES: { bg: '#D6B48C', fg: '#4A2E12' },
  CORN: { bg: '#FCE9A8', fg: '#7A5C02' }, 'SWEET CORN': { bg: '#FCE9A8', fg: '#7A5C02' },
  ALFALFA: { bg: '#C0DD97', fg: '#173404' }, HAY: { bg: '#C0DD97', fg: '#173404' },
  'SUGAR BEET': { bg: '#E0D6F5', fg: '#3D2B6B' }, BEETS: { bg: '#E0D6F5', fg: '#3D2B6B' },
  FALLOW: { bg: '#E4E1D8', fg: '#5A574C' }, ONIONS: { bg: '#F4C0D1', fg: '#4B1528' },
  MINT: { bg: '#9FE1CB', fg: '#04342C' }, CARROTS: { bg: '#FAD9BB', fg: '#7A3E0A' },
  SQUASH: { bg: '#F5C98A', fg: '#6B3D02' }
}

// Returns 'deficient' | 'optimal' | 'excess' | null (null when there's no
// reading yet, so callers can render a "no data" state rather than a
// misleading status badge).
export function statusFor(value, target) {
  if (value == null || !target) return null
  const [low, high] = target
  if (value < low) return 'deficient'
  if (value > high) return 'excess'
  return 'optimal'
}

// How far outside the target range a value sits, used for ranking fields
// worst-first in the by-criteria view. 0 means within range; fields with no
// reading yet sort to the bottom rather than the top.
export function distanceFromTarget(value, target) {
  if (value == null || !target) return -Infinity
  const [low, high] = target
  if (value < low) return low - value
  if (value > high) return value - high
  return 0
}

// Display order for a soil (or petiole) sample's value columns, per Kent:
// NO3, P, K, pH, Salts, excess lime, CEC, B, Zn, Mn first, then the base-saturation
// keys (anything starting with "BS"), then everything else, with the
// recommendation keys (anything starting with "R") always last. Used by every
// place that lists a sample's values so they all read in the same order.
//
// The first-group keys are matched by name after stripping case, units in
// parentheses, spaces/punctuation and a trailing "ppm", so "P (ppm)", "p_ppm"
// and "P" all count as P. If the lab's real key for one of them is spelled
// differently than any alias below it just falls into the "everything else"
// group - add the real spelling to the matching list.
const FIRST_GROUP_ALIASES = [
  ['no3', 'no3n', 'nitrate', 'nitraten'],
  ['p', 'phosphorus', 'olsenp', 'polsen'],
  ['k', 'potassium'],
  ['ph', 'soilph'],
  ['salts', 'salt', 'solublesalts'],
  ['excesslime', 'lime', 'limeexcess', 'freelime', 'exlime'],
  ['cec'],
  ['b', 'boron'],
  ['zn', 'zinc'],
  ['mn', 'manganese']
]

function simplifyValueKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
    .replace(/[^a-z0-9]/g, '')
    .replace(/ppm$/, '')
}

export function valueKeyRank(key) {
  const simple = simplifyValueKey(key)
  const first = FIRST_GROUP_ALIASES.findIndex((aliases) => aliases.includes(simple))
  if (first !== -1) return first
  const trimmed = String(key).trim().toLowerCase()
  if (trimmed.startsWith('r')) return 1000 // recommendations, always last
  if (trimmed.startsWith('bs')) return 100 // base saturation
  return 500
}

// Soil and petiole only - nematode/compost keep their own order (a nematode
// like "Root-knot" would otherwise be mistaken for a recommendation).
export function sortValueKeys(type, keys) {
  if (type !== 'soil' && type !== 'petiole') return keys
  return keys
    .map((key, i) => ({ key, i }))
    .sort((a, b) => valueKeyRank(a.key) - valueKeyRank(b.key) || a.i - b.i)
    .map((x) => x.key)
}
