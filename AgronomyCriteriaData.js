import { useEffect, useState } from 'react'
import { collection, doc, onSnapshot } from 'firebase/firestore'
import { db } from './firebase.js'

// Live Firestore-backed version of the criteria that used to be hardcoded
// in AgronomyConfig.js (WEEKLY_CURVES_BY_CROP and METRICS_BY_TYPE's target
// ranges), so Admin/Owner can tune them from the Targets tab without a
// GitHub deploy. AgronomyConfig.js's METRICS_BY_TYPE is still the source
// of truth for structural fields that aren't meant to be edited here -
// metric keys, labels, units - only `target` gets overridden by what's
// live in Firestore.
//
// agronomyCurves/{cropKey} documents are keyed by crop name alone
// (e.g. "POTATO") for a crop-wide curve, or "CROPNAME::VARIETYNAME" for a
// variety-specific override (e.g. "POTATO::RUSSET NORKOTAH TX 278").
// getCurveRows() below implements the fallback a field actually needs: its
// own variety's curve first, then its crop's general curve, then null
// (callers fall back further to flatTargets/METRICS_BY_TYPE themselves).
//
// Run the one-time seedAgronomyCriteriaOnce Cloud Function before this has
// anything to read - until then, flatTargets/curvesByKey come back empty
// and every caller's own fallback to the hardcoded AgronomyConfig.js
// values takes over, so nothing breaks in the meantime.
export function useLiveAgronomyCriteria() {
  const [flatTargets, setFlatTargets] = useState(null)
  const [curvesByKey, setCurvesByKey] = useState({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    const unsubFlat = onSnapshot(
      doc(db, 'agronomyCriteria', 'flatTargets'),
      (snap) => {
        setFlatTargets(snap.exists() ? snap.data() : {})
        setLoading(false)
      },
      (err) => {
        console.error('agronomyCriteria/flatTargets query failed:', err)
        setError(err.message)
        setLoading(false)
      }
    )
    const unsubCurves = onSnapshot(
      collection(db, 'agronomyCurves'),
      (snap) => {
        const next = {}
        snap.forEach((d) => { next[d.id] = d.data() })
        setCurvesByKey(next)
      },
      (err) => {
        console.error('agronomyCurves query failed:', err)
        setError(err.message)
      }
    )
    return () => { unsubFlat(); unsubCurves() }
  }, [])

  return { flatTargets, curvesByKey, loading, error }
}

// cropName/varietyName are both already uppercase, matching how fields
// flow through Agronomy.jsx's `fields` memo. Returns the weeks[] array, or
// null if neither a variety-specific nor a crop-level curve exists.
export function getCurveRows(curvesByKey, cropName, varietyName) {
  if (!cropName || !curvesByKey) return null
  if (varietyName) {
    const varietyKey = `${cropName}::${varietyName}`
    if (curvesByKey[varietyKey]) return curvesByKey[varietyKey].weeks || null
  }
  if (curvesByKey[cropName]) return curvesByKey[cropName].weeks || null
  return null
}

// Merges live flat-target overrides onto METRICS_BY_TYPE's structural
// definitions. Falls back to METRICS_BY_TYPE's own hardcoded target when
// the live doc has nothing for that metric yet (covers both "not seeded
// yet" and "a metric added to METRICS_BY_TYPE after the last seed").
export function mergeFlatTargets(metricsByType, flatTargets) {
  if (!flatTargets) return metricsByType
  const merged = {}
  Object.entries(metricsByType).forEach(([type, metrics]) => {
    merged[type] = metrics.map((m) => ({
      ...m,
      target: flatTargets[type]?.[m.key] !== undefined ? flatTargets[type][m.key] : m.target
    }))
  })
  return merged
}
