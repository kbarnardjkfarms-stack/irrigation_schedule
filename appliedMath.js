// Applied inches for one field and one week (Nov 2026).
//
// Applied inches = wet hours x GPM x 60 / (27,154 x acres), the same formula
// the Scheduled column uses, so the two compare directly. Wet hours come from
// the weekly pivot log (pivotWetLog), which every pivot brand feeds the same
// way. No-signal time is kept apart: it is never counted as wet or dry.
//
// Acres: a pivot with a corner machine uses the AgWorld acres (they include the
// corner machine's ground). Any other pivot uses the circle it sweeps
// (pi x length^2, scaled by the wiper arc) when its length is known, because
// the water falls on the whole circle, farmed or not. No length: AgWorld acres.

export const GALLONS_PER_ACRE_INCH = 27154

// The Monday of the week the weekly log started counting (Nov 9, 2026).
// Earlier weeks show a dash, not 0.00, because nothing was tracked.
export const WET_LOG_START_WEEK = '2026-11-09'

// Show "+?" when at least this many hours of the week had no signal.
export const UNKNOWN_MARK_HOURS = 0.5

function circleAcres(pivot, profile) {
  const len = profile && profile.machineLengthFt != null ? Number(profile.machineLengthFt) : null
  if (!(len > 0)) return null
  const rev = Number(pivot && pivot.reverseAngle) || 0
  const fwd = Number(pivot && pivot.forwardAngle) || 0
  let arc = 360
  if (rev !== fwd) { arc = fwd - rev; if (arc < 0) arc += 360 }
  return (Math.PI * len * len / 43560) * (arc / 360)
}

// currentWeekId: the Monday (YYYY-MM-DD) of the week that contains today.
export function computeApplied({ pivotGuid, pivot, profile, field, wetLog, weekId, currentWeekId }) {
  const blank = (reason) => ({ ok: false, reason })
  if (!pivotGuid) return blank('no-pivot')
  if (weekId < WET_LOG_START_WEEK) return blank('not-tracked')
  if (weekId > currentWeekId) return blank('future')
  const gpm = profile && Number(profile.currentGpm) > 0 ? Number(profile.currentGpm) : null
  if (!gpm) return blank('no-gpm')

  const hasCorner = !!(profile && profile.hasCornerMachine)
  const circle = circleAcres(pivot, profile)
  let acres, acresSource
  if (hasCorner) { acres = field && field.acres ? field.acres : null; acresSource = 'agworld-corner' }
  else if (circle) { acres = circle; acresSource = 'circle' }
  else { acres = field && field.acres ? field.acres : null; acresSource = 'agworld' }
  if (!(acres > 0)) return blank('no-acres')

  const rec = (wetLog && wetLog[pivotGuid]) || {}
  const wetHours = Number(rec.wetHours) || 0
  const dryHours = Number(rec.dryHours) || 0
  const unknownHours = Number(rec.unknownHours) || 0
  const perHour = (gpm * 60) / (GALLONS_PER_ACRE_INCH * acres)
  return {
    ok: true,
    inches: wetHours * perHour,
    maxExtra: unknownHours * perHour,
    wetHours, dryHours, unknownHours,
    gpm, acres, acresSource,
    estimate: hasCorner,
    unknownMark: unknownHours >= UNKNOWN_MARK_HOURS,
    partialWeek: weekId === WET_LOG_START_WEEK
  }
}
