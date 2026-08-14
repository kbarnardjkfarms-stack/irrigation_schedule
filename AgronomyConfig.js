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
