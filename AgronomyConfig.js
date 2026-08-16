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

// Dark values (fg) are the app's own tokens from styles.css - #3c5a3f is
// the same green as .topbar/button.active, #A32D2D is the same red as
// .mode-bar-actions .apply.danger, #854F0B is the same amber as
// .status.offline. Light values (bg) are new tints in the same hue,
// since styles.css doesn't define pastel backgrounds for these yet.
export const STATUS_COLOR = {
  deficient: { bg: '#F5DCDA', fg: '#A32D2D' },
  optimal: { bg: '#DEEAD2', fg: '#3c5a3f' },
  excess: { bg: '#F7E8D2', fg: '#854F0B' }
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
