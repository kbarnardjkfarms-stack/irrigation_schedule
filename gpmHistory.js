// GPM history for a pivot. A pivot keeps its sprinkler package for years, but when the package does change
// (new nozzles, a new package) the old seasons must still be worked out with the GPM it had back then.
//
// pivotProfiles/{guid}.currentGpm   the GPM in use today (unchanged; everything that only needs "now" still reads it)
// pivotProfiles/{guid}.gpmHistory   [{ gpm, from, setAt, setBy, source }] oldest first
//     from = 'YYYY-MM-DD' the GPM applies from, or null = "always" (the first number ever entered, which is also
//     used for any week before the earliest dated entry).
//
// A week is worked out with the GPM in effect on the LAST day of that week, so a change made during a week applies
// to that week and the weeks after it.

export function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function liveGpm(profile) {
  const n = Number(profile && profile.currentGpm)
  return n > 0 ? n : null
}

// The saved history cleaned up and in order (undated first, then by date). Entries with no usable number are dropped.
export function historyOf(profile) {
  const raw = profile && Array.isArray(profile.gpmHistory) ? profile.gpmHistory : []
  const list = raw
    .filter((e) => e && Number(e.gpm) > 0)
    .map((e) => ({ ...e, gpm: Number(e.gpm), from: e.from ? String(e.from).slice(0, 10) : null }))
  return list.sort((a, b) => (a.from || '').localeCompare(b.from || ''))
}

// The history only counts while it agrees with currentGpm (anything that changed currentGpm without recording it,
// or a cleared GPM, makes the history untrustworthy, so the live number wins).
function trustedHistory(profile) {
  const h = historyOf(profile)
  const live = liveGpm(profile)
  if (!h.length || live == null || h[h.length - 1].gpm !== live) return []
  return h
}

// The GPM that applied on a given day ('YYYY-MM-DD'), or null if the pivot has none.
export function gpmOnDate(profile, iso) {
  const live = liveGpm(profile)
  if (live == null) return null
  const h = trustedHistory(profile)
  if (!h.length || !iso) return live
  let pick = null
  for (const e of h) if (e.from == null || e.from <= iso) pick = e
  return (pick || h[0]).gpm
}

// The GPM for a week, given its Monday ('YYYY-MM-DD').
export function gpmForWeek(profile, weekId) {
  return gpmOnDate(profile, weekId ? addDaysIso(weekId, 6) : null)
}

// What to save when a pivot's package is deleted: with no package there is no GPM until a manager ticks
// "No printout" and types one, or uploads a new package and confirms it. The number that was in use (and its history)
// is kept in gpmCleared for the record. Returns {} when there is no GPM to clear.
export function clearedGpmFields(profile, info) {
  const live = liveGpm(profile)
  if (live == null) return {}
  const keep = JSON.parse(JSON.stringify(historyOf(profile)))
  return {
    currentGpm: null, gpmSource: null, gpmConfirmedPath: null, gpmConfirmedBy: null, gpmConfirmedAt: null,
    gpmCleared: { gpm: live, source: (profile && profile.gpmSource) || null, at: (info && info.now) || new Date().toISOString(), by: (info && info.by) || null, history: keep }
  }
}

// What to save when the GPM changes. Returns { currentGpm, gpmHistory } to merge into the profile.
//   no GPM yet                 -> first entry, applies to all time
//   mode 'correction'          -> the latest entry was a mistake: its number is replaced, its date stays
//   mode 'new' with a date     -> a real change: new entry from that date; earlier weeks keep the old GPM
// `info` = { by, source, now (ISO), from ('YYYY-MM-DD') }
export function nextGpm(profile, newGpm, mode, info) {
  const n = Number(newGpm)
  const old = liveGpm(profile)
  const now = (info && info.now) || new Date().toISOString()
  const make = (gpm, from) => ({ gpm, from: from || null, setAt: now, setBy: (info && info.by) || null, source: (info && info.source) || null })
  const seeded = () => {
    const h = trustedHistory(profile)
    return h.length ? h : (old != null ? [{ gpm: old, from: null, setAt: null, setBy: null, source: 'earlier' }] : [])
  }
  let history
  if (old == null) {
    history = [make(n, null)]
  } else if (n === old) {
    history = seeded()
  } else if (mode === 'correction') {
    history = seeded()
    history[history.length - 1] = { ...history[history.length - 1], ...make(n, history[history.length - 1].from), corrected: true }
  } else {
    history = seeded()
    const last = history[history.length - 1]
    let from = (info && info.from) || now.slice(0, 10)
    if (last.from && from < last.from) from = last.from
    if (last.from && from === last.from) history[history.length - 1] = make(n, from)
    else history.push(make(n, from))
  }
  return { currentGpm: n, gpmHistory: history }
}

// Plain-words lines for the profile page, newest first: "900 GPM from Mar 1, 2027", "640 GPM until then".
export function describeHistory(profile) {
  const h = trustedHistory(profile)
  if (h.length < 2) return []
  const fmt = (iso) => new Date(iso + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  const rows = []
  for (let i = h.length - 1; i >= 0; i--) {
    const e = h[i]
    const next = h[i + 1]
    rows.push(e.from
      ? `${e.gpm} GPM from ${fmt(e.from)}${next ? ` until ${fmt(next.from)}` : ''}`
      : `${e.gpm} GPM ${next ? `until ${fmt(next.from)}` : ''}`.trim())
  }
  return rows
}
