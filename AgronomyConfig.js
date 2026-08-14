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
  soil: [
    { key: 'no3', label: 'NO3', unit: 'ppm', target: [15, 25] },
    { key: 'salts', label: 'Salts', unit: 'mmhos/cm', target: [0, 2] }
  ],
  petiole: [
    { key: 'no3', label: 'NO3', unit: 'ppm', target: [18000, 28000] },
    { key: 'p', label: '%P', unit: '%', target: [0.25, 0.4] },
    { key: 'k', label: '%K', unit: '%', target: [8, 11] },
    { key: 'sulfur', label: 'Sulfur', unit: '%', target: [0.25, 0.4] }
  ],
  nematode: [
    { key: 'count', label: 'Count', unit: '/250g', target: [0, 100] }
  ],
  compost: [
    { key: 'n', label: 'N', unit: '%', target: [1, 2] }
  ]
}

export const STATUS_COLOR = {
  deficient: { bg: '#FCEBEB', fg: '#501313' },
  optimal: { bg: '#EAF3DE', fg: '#173404' },
  excess: { bg: '#FAEEDA', fg: '#412402' }
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
