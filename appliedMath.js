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

import { gpmForWeek } from './gpmHistory.js'

export const GALLONS_PER_ACRE_INCH = 27154

// The Monday of the week the weekly log started counting (Nov 9, 2026).
// Earlier weeks show a dash, not 0.00, because nothing was tracked.
export const WET_LOG_START_WEEK = '2026-11-09'

// Show "+?" when at least this many hours of the week had no signal.
export const UNKNOWN_MARK_HOURS = 0.5

// Degrees the pivot travels between its two stop angles (reverse stop to
// forward stop, the same sweep the pivot icon draws). Equal or missing angles
// (usually 0 and 0) mean no stops are set: a full circle, 360.
export function travelDegrees(pivot) {
  const rev = Number(pivot && pivot.reverseAngle) || 0
  const fwd = Number(pivot && pivot.forwardAngle) || 0
  let arc = 360
  if (rev !== fwd) { arc = fwd - rev; if (arc < 0) arc += 360 }
  return arc
}

export function circleAcres(pivot, profile) {
  const len = profile && profile.machineLengthFt != null ? Number(profile.machineLengthFt) : null
  if (!(len > 0)) return null
  return (Math.PI * len * len / 43560) * (travelDegrees(pivot) / 360)
}

// The acres the water actually falls on ("acres under steel"), and where that
// number came from. A pivot with a corner machine uses the AgWorld acres (they
// include the corner machine's ground; the length only covers the main
// pivot). Any other pivot uses the circle it sweeps when its length is known,
// farmed or not. No length: AgWorld acres. Used by Applied inches and by the
// Pivot Profiles spreadsheet so both always agree.
export function acresUnderSteel({ pivot, profile, agworldAcres }) {
  const ag = agworldAcres ? agworldAcres : null
  if (profile && profile.hasCornerMachine) return { acres: ag, source: 'agworld-corner' }
  const circle = circleAcres(pivot, profile)
  if (circle) return { acres: circle, source: 'circle' }
  return { acres: ag, source: 'agworld' }
}

// currentWeekId: the Monday (YYYY-MM-DD) of the week that contains today.
export function computeApplied({ pivotGuid, pivot, profile, field, wetLog, weekId, currentWeekId }) {
  const blank = (reason) => ({ ok: false, reason })
  if (!pivotGuid) return blank('no-pivot')
  if (weekId < WET_LOG_START_WEEK) return blank('not-tracked')
  if (weekId > currentWeekId) return blank('future')
  // The GPM the pivot had that week (a pivot's GPM can change when its package does).
  const gpm = gpmForWeek(profile, weekId)
  if (!gpm) return blank('no-gpm')

  const hasCorner = !!(profile && profile.hasCornerMachine)
  const { acres, source: acresSource } = acresUnderSteel({ pivot, profile, agworldAcres: field && field.acres })
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
