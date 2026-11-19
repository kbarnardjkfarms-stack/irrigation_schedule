import { useEffect, useMemo, useRef, useState } from 'react'
import { doc, setDoc } from 'firebase/firestore'
import { ref as storageRef, uploadBytes, getDownloadURL, deleteObject } from 'firebase/storage'
import { auth, db, storage } from './firebase.js'
import GpmChangeDialog from './GpmChangeDialog.jsx'
import PackageScanner from './PackageScanner.jsx'
import { nextGpm } from './gpmHistory.js'
import { acresUnderSteel, travelDegrees } from './appliedMath.js'

// "Pivot Profiles" spreadsheet view (Irrigation views dropdown): every pivot on one farm in a grid, with the
// profile settings editable in place. Saves go to the same pivotProfiles/{guid} document the single profile page
// writes, in the same shapes, so the Firestore rules apply exactly as they do there. In particular a GPM can only be
// set by: confirming the number read from the package, typing it while "No package printout" is ticked (no package on
// file), or typing it from the package when the reader couldn't find one. A package PDF can be uploaded, replaced or deleted here
// (same steps as the profile page); a photo turned into a PDF is done on the profile page.

const INK = '#2b2b26'
const MUTED = '#6b6a62'
const LINE = '#e4e1d8'
const GOOD = '#2F6B2F'
const WARN = '#854F0B'
const BAD = '#A32D2D'

// Fixed column widths (px) so every column has the same breathing room and nothing stretches with the window.
// Groups: pivot info | package and flow | alerts and machine.
const COLS = { pivot: 236, acres: 98, steel: 114, src: 104, len: 90, wiper: 124, travel: 96, pkg: 200, gpm: 220, gpmAc: 112, noPrint: 96, stuck: 110, corner: 104, cornerLen: 120, lap: 100 }
const TABLE_W = Object.values(COLS).reduce((a, b) => a + b, 0)
const GROUP_EDGE = `1px solid ${LINE}`
const th = { textAlign: 'center', padding: '8px 12px', fontSize: 11.5, color: MUTED, fontWeight: 600, borderBottom: `1px solid ${LINE}`, background: '#f4f2ec', position: 'sticky', top: 30, zIndex: 3, lineHeight: 1.25 }
const thGroup = { textAlign: 'left', padding: '7px 12px', fontSize: 10.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: '#8a8979', fontWeight: 600, background: '#ece9df', position: 'sticky', top: 0, zIndex: 3, height: 30, boxSizing: 'border-box' }
const td = { padding: '8px 12px', height: 62, boxSizing: 'border-box', fontSize: 13, borderBottom: '0.5px solid #eee', verticalAlign: 'middle', textAlign: 'center', fontVariantNumeric: 'tabular-nums' }
const inputStyle = { width: 84, padding: '5px 6px', fontSize: 13, border: `1px solid #ccc`, borderRadius: 5, background: '#fff', textAlign: 'center' }
const small = { fontSize: 11, color: MUTED }

const EDIT_ROLES = ['admin', 'owner', 'farm_manager', 'irrigation_manager']

function whoAmI() { return (auth.currentUser && auth.currentUser.email) || 'unknown' }

// A number box that saves when you leave it or press Enter, and shows saved / error beside it.
function NumberCell({ cellKey, value, disabled, min, max, integer, onSave, status, setStatus, colKey, width }) {
  const [draft, setDraft] = useState(null)
  const shown = draft != null ? draft : value == null ? '' : String(value)
  async function commit() {
    if (draft == null) return
    const text = draft.trim()
    const original = value == null ? '' : String(value)
    if (text === original) { setDraft(null); return }
    const n = integer ? parseInt(text, 10) : parseFloat(text)
    if (!text || isNaN(n) || (min != null && n < min) || (max != null && n > max)) {
      setStatus(cellKey, { error: `Enter ${integer ? 'a whole number' : 'a number'}${min != null && max != null ? ` between ${min} and ${max}` : min != null ? ` above ${min}` : ''}.` })
      return
    }
    setStatus(cellKey, { saving: true })
    try {
      const res = await onSave(n)
      if (res === 'ask') { setStatus(cellKey, null); return } // waiting for the "mistake or real change?" question
      setDraft(null); setStatus(cellKey, { saved: true })
    } catch (e) { setStatus(cellKey, { error: e.message || 'Could not save.' }) }
  }
  const st = status[cellKey] || {}
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <input
        type="number" inputMode="decimal" data-col={colKey} disabled={disabled}
        value={shown}
        onChange={(e) => { setDraft(e.target.value); if (st.error || st.saved) setStatus(cellKey, null) }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); const next = e.currentTarget.closest('tr') && e.currentTarget.closest('tr').nextElementSibling; const target = next && next.querySelector(`input[data-col="${colKey}"]:not(:disabled)`); if (target) target.focus() }
          if (e.key === 'Escape') { setDraft(null); setStatus(cellKey, null); e.currentTarget.blur() }
        }}
        aria-label={cellKey}
        style={{ ...inputStyle, width: width || inputStyle.width, borderColor: st.error ? BAD : '#ccc', background: disabled ? '#f4f2ec' : '#fff' }}
      />
      <span style={{ width: 14, fontSize: 12, color: st.error ? BAD : GOOD }} title={st.error || ''}>{st.saving ? '…' : st.error ? '!' : st.saved ? '✓' : ''}</span>
    </span>
  )
}

// Which system a pivot is read from (same rule as the profile page).
function brandOf(pivot) {
  if (pivot.statusSource === 'fieldnet' || pivot.deviceKind === 'FieldNET') return 'FieldNET'
  if (pivot.statusSource === 'farmList' || pivot.deviceKind === 'ICON Link' || pivot.deviceKind === 'CommanderVP') return 'AgSense'
  return 'BaseStation'
}

// Start / stop angles from the controller. Equal or missing angles (usually
// 0 and 0) mean no stops are set, i.e. a full circle.
function wiperText(pivot) {
  const rev = pivot.reverseAngle, fwd = pivot.forwardAngle
  const ok = (v) => v != null && v !== '' && !isNaN(Number(v))
  if (!ok(rev) || !ok(fwd) || Number(rev) === Number(fwd)) return null
  const d = (v) => `${Math.round(Number(v) * 10) / 10}\u00b0`
  return `${d(rev)} \u2192 ${d(fwd)}`
}

export default function PivotProfilesSheet({ farms, pivotsByGuid, pivotProfilesByGuid, pivotGuidByFieldId, baseFieldsById, seasonDataByField, userRole, userProfile, selectedFarmId, onOpenProfile }) {
  const canEdit = EDIT_ROLES.includes(userRole)
  const isFarmManager = userRole === 'farm_manager'
  const canDelete = ['admin', 'owner', 'farm_manager'].includes(userRole) // same as the profile page
  const availableFarms = useMemo(() => {
    if (!isFarmManager) return farms
    const mine = (userProfile && Array.isArray(userProfile.farmIds) ? userProfile.farmIds : []).map(String)
    return farms.filter((f) => mine.includes(String(f.id)))
  }, [farms, isFarmManager, userProfile])
  const sortedFarms = useMemo(() => [...availableFarms].sort((a, b) => String(a.name).localeCompare(String(b.name))), [availableFarms])

  const [farmId, setFarmId] = useState(null)
  const [filter, setFilter] = useState('all') // all | noGpm | noPkg | confirm
  const [status, setStatusMap] = useState({})
  const [busy, setBusy] = useState({})
  const [deleteTarget, setDeleteTarget] = useState(null) // { guid, name, pkg }
  const [deleting, setDeleting] = useState(false)
  const [pending, setPending] = useState(null) // { r, n, source, extra, key }: a GPM change waiting for "mistake or real change?"
  const [pendingBusy, setPendingBusy] = useState(false)
  const [gpmEpoch, setGpmEpoch] = useState(0) // bumps to clear a typed number that was not saved
  const [pkgError, setPkgError] = useState({}) // guid -> message
  const timers = useRef({})
  const setStatus = (key, val) => {
    setStatusMap((s) => { const n = { ...s }; if (val) n[key] = val; else delete n[key]; return n })
    if (val && val.saved) { clearTimeout(timers.current[key]); timers.current[key] = setTimeout(() => setStatusMap((s) => { const n = { ...s }; if (n[key] && n[key].saved) delete n[key]; return n }), 2500) }
  }

  // Start on the farm picked on the schedule page, otherwise the first farm.
  useEffect(() => {
    if (farmId && sortedFarms.some((f) => String(f.id) === String(farmId))) return
    const preferred = selectedFarmId && selectedFarmId !== 'all' && sortedFarms.find((f) => String(f.id) === String(selectedFarmId))
    const pick = preferred || sortedFarms[0]
    setFarmId(pick ? String(pick.id) : null)
  }, [sortedFarms, selectedFarmId, farmId])

  const fieldIdsByGuid = useMemo(() => {
    const map = {}
    Object.entries(pivotGuidByFieldId || {}).forEach(([fid, guid]) => { if (guid) (map[guid] = map[guid] || []).push(fid) })
    return map
  }, [pivotGuidByFieldId])

  const rows = useMemo(() => {
    if (!farmId) return []
    const list = []
    Object.entries(pivotsByGuid || {}).forEach(([guid, pivot]) => {
      const fieldIds = fieldIdsByGuid[guid] || []
      const inFarm = fieldIds.some((fid) => baseFieldsById[fid] && String(baseFieldsById[fid].farmId) === String(farmId))
      if (!inFarm) return
      const names = fieldIds.map((fid) => baseFieldsById[fid] && baseFieldsById[fid].name).filter(Boolean)
      const acres = fieldIds.reduce((sum, fid) => sum + ((seasonDataByField && seasonDataByField[fid] && seasonDataByField[fid].acres) || 0), 0)
      const hasAcres = fieldIds.some((fid) => seasonDataByField && seasonDataByField[fid] && seasonDataByField[fid].acres)
      const profile = (pivotProfilesByGuid && pivotProfilesByGuid[guid]) || {}
      const pkg = profile.sprinklerPackage || null
      const scanRaw = profile.packageScan || null
      const scan = pkg && scanRaw && scanRaw.storagePath === pkg.storagePath ? scanRaw : null
      const gpm = profile.currentGpm != null ? profile.currentGpm : null
      const confirmedForPkg = !!(pkg && gpm != null && (profile.gpmSource === 'package' || profile.gpmSource === 'typedFromPackage') && profile.gpmConfirmedPath === pkg.storagePath)
      // What the GPM cell can do right now (same cases as the profile page)
      let gpmMode
      if (confirmedForPkg) gpmMode = 'confirmed'
      else if (pkg && scan == null) gpmMode = 'reading'
      else if (pkg && scan.status === 'read') gpmMode = 'confirm'
      else if (pkg) gpmMode = 'typeFromPackage'
      else if (profile.noPackagePrintout) gpmMode = 'manual'
      else gpmMode = 'locked'
      const steelInfo = acresUnderSteel({ pivot, profile, agworldAcres: hasAcres ? acres : null })
      list.push({
        guid, profile, pkg, scan, gpm, gpmMode,
        name: names.length ? names.join(' + ') : (pivot.name || guid),
        baseName: pivot.name && names.length && !names.includes(pivot.name) ? pivot.name : '',
        acres: hasAcres ? acres : null,
        // Acres under steel: the ground the water falls on (the circle the pivot
        // sweeps, farmed or not). Same rule Applied inches uses: AgWorld acres
        // stand in for a corner machine pivot or a pivot with no length yet.
        steel: steelInfo.acres,
        steelSource: steelInfo.source,
        travel: travelDegrees(pivot),
        // GPM per acre (under steel): the GPM AIO is using for this pivot (from
        // a confirmed package or typed by hand) spread over the acres under
        // steel. Blank when there is no GPM yet or no acres to divide by.
        gpmPerAcre: gpm > 0 && steelInfo.acres > 0 ? gpm / steelInfo.acres : null,
        brand: brandOf(pivot),
        lengthFt: profile.machineLengthFt != null && Number(profile.machineLengthFt) > 0 ? Number(profile.machineLengthFt) : null,
        wiper: wiperText(pivot),
        threshold: profile.stuckAlertThresholdMinutes != null ? profile.stuckAlertThresholdMinutes : 60,
        hasCorner: !!profile.hasCornerMachine,
        cornerLen: profile.cornerMachineLengthFt != null ? profile.cornerMachineLengthFt : null,
        lap: profile.currentLapTimeHours != null ? profile.currentLapTimeHours : null,
        lapDrift: !!profile.lapTimeDriftFlagged
      })
    })
    list.sort((a, b) => a.name.localeCompare(b.name))
    return list
  }, [farmId, pivotsByGuid, pivotProfilesByGuid, fieldIdsByGuid, baseFieldsById, seasonDataByField])

  const counts = useMemo(() => ({
    noGpm: rows.filter((r) => r.gpm == null).length,
    noPkg: rows.filter((r) => !r.pkg).length,
    confirm: rows.filter((r) => r.gpmMode === 'confirm').length
  }), [rows])
  const shown = rows.filter((r) => filter === 'all' || (filter === 'noGpm' && r.gpm == null) || (filter === 'noPkg' && !r.pkg) || (filter === 'confirm' && r.gpmMode === 'confirm'))

  async function save(guid, data) {
    await setDoc(doc(db, 'pivotProfiles', guid), data, { merge: true })
  }
  async function run(key, fn) {
    setBusy((b) => ({ ...b, [key]: true })); setStatus(key, { saving: true })
    try { await fn(); setStatus(key, { saved: true }) } catch (e) { setStatus(key, { error: e.message || 'Could not save.' }) } finally { setBusy((b) => { const n = { ...b }; delete n[key]; return n }) }
  }
  // Every GPM change keeps a history so past seasons use the GPM the pivot had at the time. A first GPM, or the same
  // number again, saves straight away; a different number than the one in use asks "fixing a mistake, or did the
  // pivot change?" first.
  const gpmDiffers = (r, n) => Number(r.profile.currentGpm) > 0 && Number(r.profile.currentGpm) !== n
  const writeGpm = (r, n, source, extra, choice) => save(r.guid, {
    ...extra,
    ...nextGpm(r.profile, n, choice.mode, { by: whoAmI(), source, from: choice.from, now: new Date().toISOString() })
  })
  const typedExtra = (r, source) => ({
    gpmSource: source,
    gpmConfirmedPath: source === 'typedFromPackage' && r.pkg ? r.pkg.storagePath : null,
    gpmConfirmedBy: whoAmI(), gpmConfirmedAt: new Date().toISOString()
  })
  const saveGpm = async (r, source, n) => {
    if (gpmDiffers(r, n)) { setPending({ r, n, source, extra: typedExtra(r, source), key: `GPM ${r.name}` }); return 'ask' }
    await writeGpm(r, n, source, typedExtra(r, source), { mode: 'new', from: null })
  }
  const confirmExtra = (r) => ({
    gpmSource: 'package', gpmConfirmedPath: r.pkg.storagePath,
    gpmConfirmedBy: whoAmI(), gpmConfirmedAt: new Date().toISOString(), noPackagePrintout: false
  })
  const confirmGpm = (r) => {
    if (gpmDiffers(r, r.scan.gpm)) { setPending({ r, n: r.scan.gpm, source: 'package', extra: confirmExtra(r), key: `GPM ${r.name}` }); return }
    return run(`GPM ${r.name}`, () => writeGpm(r, r.scan.gpm, 'package', confirmExtra(r), { mode: 'new', from: null }))
  }
  async function chooseGpmChange(choice) {
    if (!pending) return
    const { r, n, source, extra, key } = pending
    setPendingBusy(true); setStatus(key, { saving: true })
    try {
      await writeGpm(r, n, source, extra, choice)
      setStatus(key, { saved: true })
    } catch (e) {
      setStatus(key, { error: e.message || 'Could not save.' })
    } finally {
      setPendingBusy(false); setPending(null); setGpmEpoch((x) => x + 1)
    }
  }

  // Replace: upload a new PDF as the pivot's package. The old one is filed in the package history, the GPM already
  // in use stays until the new package's number is confirmed (same as the profile page).
  async function replacePackage(r, file) {
    if (!file) return
    const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '')
    if (!isPdf) { setPkgError((m) => ({ ...m, [r.guid]: 'AIO needs a PDF.' })); return false }
    setPkgError((m) => { const n = { ...m }; delete n[r.guid]; return n })
    const key = `Package ${r.name}`
    setBusy((b) => ({ ...b, [key]: true }))
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `pivotProfiles/${r.guid}/${Date.now()}_${safeName}`
      const fileRef = storageRef(storage, path)
      await uploadBytes(fileRef, file)
      const downloadUrl = await getDownloadURL(fileRef)
      const newEntry = { fileName: file.name, uploadedAt: new Date().toISOString(), downloadUrl, storagePath: path }
      const existingHistory = (r.profile && r.profile.sprinklerPackageHistory) || []
      const history = r.profile && r.profile.sprinklerPackage
        ? [{ ...r.profile.sprinklerPackage, replacedAt: new Date().toISOString() }, ...existingHistory]
        : existingHistory
      await save(r.guid, { sprinklerPackage: newEntry, sprinklerPackageHistory: history, noPackagePrintout: false })
      return true
    } catch (e) {
      setPkgError((m) => ({ ...m, [r.guid]: e.message || 'Upload failed.' }))
      return false
    } finally {
      setBusy((b) => { const n = { ...b }; delete n[key]; return n })
    }
  }

  // Delete: removes the PDF itself, then its entry on the profile. The GPM already confirmed stays in use.
  async function confirmDelete() {
    if (!deleteTarget) return
    const { guid, pkg } = deleteTarget
    setDeleting(true)
    setPkgError((m) => { const n = { ...m }; delete n[guid]; return n })
    try {
      if (pkg.storagePath) {
        try { await deleteObject(storageRef(storage, pkg.storagePath)) } catch (err) { if (!(err && err.code === 'storage/object-not-found')) throw err }
      }
      await save(guid, { sprinklerPackage: null })
    } catch (e) {
      setPkgError((m) => ({ ...m, [guid]: e.message || 'Could not delete the package.' }))
    } finally {
      setDeleting(false); setDeleteTarget(null)
    }
  }

  const chip = (id, label, n) => (
    <button key={id} type="button" onClick={() => setFilter(id)} aria-pressed={filter === id}
      style={{ padding: '5px 12px', borderRadius: 999, fontSize: 12.5, border: `1px solid ${filter === id ? INK : '#ccc'}`, background: filter === id ? INK : '#fff', color: filter === id ? '#fff' : INK }}>
      {label}{n != null ? ` (${n})` : ''}
    </button>
  )

  return (
    <div style={{ padding: '12px 12px 40px', color: INK }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <h1 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Pivot Profiles</h1>
        <select aria-label="Farm" value={farmId || ''} onChange={(e) => setFarmId(e.target.value)} style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}>
          {sortedFarms.map((f) => <option key={f.id} value={String(f.id)}>{f.name}</option>)}
        </select>
        <span style={small}>{rows.length} pivots</span>
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        {chip('all', 'All', rows.length)}
        {chip('noGpm', 'No GPM yet', counts.noGpm)}
        {chip('noPkg', 'No package', counts.noPkg)}
        {chip('confirm', 'GPM to confirm', counts.confirm)}
      </div>
      {!canEdit && <p style={{ ...small, color: WARN }}>You can look at these but not change them.</p>}
      <p style={{ ...small, margin: '0 0 8px', maxWidth: '90ch' }}>
        Click a box and type. It saves when you leave the box or press Enter. You can upload, replace or delete a package PDF here, or tap the camera icon to scan the printout with your phone. The pivot&rsquo;s own profile page (click the pivot name) also has a Scan with camera button. A GPM can only be typed when &ldquo;No printout&rdquo; is ticked, or when the package couldn&rsquo;t be read; otherwise confirm the number read from the package.
      </p>

      <div style={{ width: 'fit-content', maxWidth: '100%', overflowX: 'auto', border: `0.5px solid ${LINE}`, borderRadius: 10, background: '#fff', maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
        <table style={{ width: TABLE_W, tableLayout: 'fixed', borderCollapse: 'separate', borderSpacing: 0 }}>
          <colgroup>
            {Object.values(COLS).map((w, i) => <col key={i} style={{ width: w }} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...thGroup, left: 0, zIndex: 5 }}>Pivot</th>
              <th colSpan={2} style={{ ...thGroup, borderLeft: GROUP_EDGE }}>Acres</th>
              <th colSpan={4} style={{ ...thGroup, borderLeft: GROUP_EDGE }}>From controller (read-only)</th>
              <th colSpan={4} style={{ ...thGroup, borderLeft: GROUP_EDGE }}>Package and flow</th>
              <th colSpan={4} style={{ ...thGroup, borderLeft: GROUP_EDGE }}>Alerts and corner machine</th>
            </tr>
            <tr>
              <th style={{ ...th, textAlign: 'left', left: 0, zIndex: 4 }}>Pivot</th>
              <th style={{ ...th, borderLeft: GROUP_EDGE }}>Farmed<br />acres</th>
              <th style={th}>Acres under<br />steel</th>
              <th style={{ ...th, textAlign: 'left', borderLeft: GROUP_EDGE }}>Source</th>
              <th style={th}>Length<br />(feet)</th>
              <th style={th}>Wiper range</th>
              <th style={th}>Degrees of<br />travel</th>
              <th style={{ ...th, textAlign: 'left', borderLeft: GROUP_EDGE }}>Package</th>
              <th style={{ ...th, textAlign: 'left' }}>GPM</th>
              <th style={th}>GPM per acre<br />(under steel)</th>
              <th style={th}>No printout</th>
              <th style={{ ...th, borderLeft: GROUP_EDGE }}>Stuck alert<br />(minutes)</th>
              <th style={th}>Corner<br />machine</th>
              <th style={th}>Corner length<br />(feet)</th>
              <th style={th}>Min lap time<br />(hours)</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r, rowIdx) => {
              const zebra = rowIdx % 2 === 1 ? '#fbfaf6' : '#fff'
              const k = (c) => `${c} ${r.name}`
              const lockEdit = !canEdit
              return (
                <tr key={r.guid}>
                  <td style={{ ...td, background: zebra, textAlign: 'left', position: 'sticky', left: 0, zIndex: 2 }}>
                    <button type="button" onClick={() => onOpenProfile(r.guid)} title="Open this pivot's full profile" style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', color: INK, fontWeight: 600, fontSize: 13 }}>{r.name}</button>
                    {r.baseName && <div style={small}>{r.baseName}</div>}
                  </td>
                  <td style={{ ...td, background: zebra, borderLeft: GROUP_EDGE }}>{r.acres != null ? r.acres.toFixed(1) : '—'}</td>
                  <td data-testid="steel-acres" style={{ ...td, background: zebra, color: r.steel > 0 ? INK : MUTED }}>
                    {r.steel > 0 ? r.steel.toFixed(1) : '\u2014'}
                    {r.steel > 0 && r.steelSource === 'agworld-corner' && <div style={small}>AgWorld, corner</div>}
                    {r.steel > 0 && r.steelSource === 'agworld' && <div style={small}>AgWorld, no length</div>}
                  </td>
                  <td style={{ ...td, background: zebra, textAlign: 'left', borderLeft: GROUP_EDGE, color: MUTED }}>{r.brand}</td>
                  <td style={{ ...td, background: zebra, color: r.lengthFt != null ? INK : MUTED }}>{r.lengthFt != null ? Math.round(r.lengthFt).toLocaleString() : '—'}</td>
                  <td style={{ ...td, background: zebra, color: r.wiper ? INK : MUTED }}>{r.wiper || 'Full circle'}</td>
                  <td data-testid="travel" style={{ ...td, background: zebra }}>{`${Math.round(r.travel * 10) / 10}\u00b0`}</td>
                  <td style={{ ...td, background: zebra, textAlign: 'left', borderLeft: GROUP_EDGE, overflow: 'hidden' }}>
                    {r.pkg ? (
                      <>
                        <a href={r.pkg.downloadUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.pkg.fileName}</a>
                        <span style={small}>{r.scan == null ? 'Reading…' : r.scan.status === 'read' ? `Reads ${r.scan.gpm} GPM` : r.scan.status === 'failed' ? "Couldn't read it" : 'No GPM found on it'}</span>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
                          <label style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #ccc', borderRadius: 5, background: lockEdit ? '#f4f2ec' : '#fff', cursor: lockEdit || busy[k('Package')] ? 'default' : 'pointer', color: lockEdit ? MUTED : INK }}>
                            {busy[k('Package')] ? 'Uploading…' : 'Replace'}
                            <input type="file" accept="application/pdf" aria-label={k('Replace package')} disabled={lockEdit || !!busy[k('Package')]} style={{ display: 'none' }}
                              onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; replacePackage(r, f) }} />
                          </label>
                          <PackageScanner iconOnly onPdf={(f) => replacePackage(r, f)} disabled={lockEdit || !!busy[k('Package')]} onError={(msg) => setPkgError((m) => { const n = { ...m }; if (msg) n[r.guid] = msg; else delete n[r.guid]; return n })} />
                          {canDelete && (
                            <button type="button" aria-label={k('Delete package')} disabled={!!busy[k('Package')]} onClick={() => setDeleteTarget({ guid: r.guid, name: r.name, pkg: r.pkg })}
                              style={{ fontSize: 11, padding: '2px 8px', background: '#FBEAEA', border: '1px solid #E8B4B4', color: BAD, borderRadius: 5 }}>Delete</button>
                          )}
                        </div>
                        {pkgError[r.guid] && <div style={{ fontSize: 11, color: BAD }}>{pkgError[r.guid]}</div>}
                      </>
                    ) : (
                      <div>
                        <span style={{ color: MUTED }}>None</span>
                        <div style={{ display: 'flex', gap: 6, marginTop: 3 }}>
                          <label style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #ccc', borderRadius: 5, background: lockEdit ? '#f4f2ec' : '#fff', cursor: lockEdit || busy[k('Package')] ? 'default' : 'pointer', color: lockEdit ? MUTED : INK }}>
                            {busy[k('Package')] ? 'Uploading\u2026' : 'Upload PDF'}
                            <input type="file" accept="application/pdf" aria-label={k('Upload package')} disabled={lockEdit || !!busy[k('Package')]} style={{ display: 'none' }}
                              onChange={(e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; replacePackage(r, f) }} />
                          </label>
                          <PackageScanner iconOnly onPdf={(f) => replacePackage(r, f)} disabled={lockEdit || !!busy[k('Package')]} onError={(msg) => setPkgError((m) => { const n = { ...m }; if (msg) n[r.guid] = msg; else delete n[r.guid]; return n })} />
                        </div>
                        {pkgError[r.guid] && <div style={{ fontSize: 11, color: BAD }}>{pkgError[r.guid]}</div>}
                      </div>
                    )}
                  </td>
                  <td style={{ ...td, background: zebra, textAlign: 'left' }}>
                    {r.gpmMode === 'confirmed' && (
                      <div><b>{r.gpm}</b> <span style={{ fontSize: 11, color: GOOD }}>{r.profile.gpmSource === 'typedFromPackage' ? '✓ typed from package' : '✓ from package'}</span></div>
                    )}
                    {r.gpmMode === 'reading' && <span style={small}>{r.gpm != null ? `${r.gpm} in use. ` : ''}Reading the package&hellip;</span>}
                    {r.gpmMode === 'confirm' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {r.gpm != null && (() => {
                          // Typed (or earlier) number vs what the package says: flag a big gap before confirming.
                          const diff = r.gpm > 0 ? (r.scan.gpm - r.gpm) / r.gpm : 0
                          const far = Math.abs(diff) > 0.1
                          const text = r.scan.gpm === r.gpm ? `${r.gpm} in use, same as package` : `${r.gpm} in use, package says ${r.scan.gpm} (${Math.round(Math.abs(diff) * 100)}% ${diff > 0 ? 'higher' : 'lower'})`
                          return <span data-testid="gpm-compare" style={{ ...small, color: far ? BAD : MUTED, fontWeight: far ? 600 : 400 }}>{text}</span>
                        })()}
                        <button type="button" disabled={lockEdit || !!busy[k('GPM')]} onClick={() => confirmGpm(r)} style={{ fontSize: 12, padding: '4px 10px', background: INK, color: '#fff', border: 'none', borderRadius: 5 }}>{busy[k('GPM')] ? 'Confirming…' : `Confirm ${r.scan.gpm}`}</button>
                        <span style={{ width: 14, fontSize: 12, color: status[k('GPM')] && status[k('GPM')].error ? BAD : GOOD }} title={(status[k('GPM')] && status[k('GPM')].error) || ''}>{status[k('GPM')] && status[k('GPM')].error ? '!' : status[k('GPM')] && status[k('GPM')].saved ? '✓' : ''}</span>
                      </div>
                    )}
                    {(r.gpmMode === 'typeFromPackage' || r.gpmMode === 'manual') && (
                      <div>
                        <NumberCell key={`gpm-${r.guid}-${gpmEpoch}`} cellKey={k('GPM')} colKey="gpm" value={r.gpm} min={5} max={5000} disabled={lockEdit} status={status} setStatus={setStatus}
                          onSave={(n) => saveGpm(r, r.gpmMode === 'manual' ? 'manual' : 'typedFromPackage', n)} />
                        <div style={small}>{r.gpmMode === 'manual' ? 'entered by hand' : 'typed from the package'}</div>
                      </div>
                    )}
                    {r.gpmMode === 'locked' && (
                      <div>
                        {r.gpm != null ? <span><b>{r.gpm}</b> <span style={small}>in use, not from a package</span></span> : <span style={{ color: MUTED }}>{'—'}</span>}
                        <div style={small}>Tick No printout to type a GPM</div>
                      </div>
                    )}
                  </td>
                  <td data-testid="gpm-per-acre" title="The GPM in use divided by the acres under steel" style={{ ...td, background: zebra, color: r.gpmPerAcre != null ? INK : MUTED }}>{r.gpmPerAcre != null ? r.gpmPerAcre.toFixed(1) : ''}</td>
                  <td style={{ ...td, background: zebra }}>
                    <input type="checkbox" aria-label={k('No printout')} checked={!!r.profile.noPackagePrintout && !r.pkg} disabled={lockEdit || !!r.pkg}
                      title={r.pkg ? 'A package is on file' : ''}
                      onChange={(e) => run(k('No printout'), () => save(r.guid, { noPackagePrintout: e.target.checked }))} />
                    {status[k('No printout')] && status[k('No printout')].error && <div style={{ fontSize: 11, color: BAD }}>{status[k('No printout')].error}</div>}
                  </td>
                  <td style={{ ...td, background: zebra, borderLeft: GROUP_EDGE }}>
                    <NumberCell cellKey={k('Stuck alert')} colKey="threshold" value={r.threshold} integer min={45} max={120} disabled={lockEdit} status={status} setStatus={setStatus}
                      onSave={(n) => save(r.guid, { stuckAlertThresholdMinutes: n })} />
                  </td>
                  <td style={{ ...td, background: zebra }}>
                    <input type="checkbox" aria-label={k('Corner machine')} checked={r.hasCorner} disabled={lockEdit}
                      onChange={(e) => run(k('Corner machine'), () => save(r.guid, { hasCornerMachine: e.target.checked }))} />
                  </td>
                  <td style={{ ...td, background: zebra }}>
                    {r.hasCorner
                      ? <NumberCell cellKey={k('Corner length')} colKey="corner" value={r.cornerLen} min={1} disabled={lockEdit} status={status} setStatus={setStatus} onSave={(n) => save(r.guid, { cornerMachineLengthFt: n })} />
                      : <span style={{ color: '#bbb' }}>{'—'}</span>}
                  </td>
                  <td style={{ ...td, background: zebra, color: r.lapDrift ? BAD : MUTED }}>{r.lap != null ? `${Number(r.lap).toFixed(1)}${r.lapDrift ? ' ⚠' : ''}` : '—'}</td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr><td colSpan={15} style={{ ...td, height: 'auto', color: MUTED, padding: 24 }}>{rows.length ? 'No pivots match this filter.' : 'No pivots are linked to fields on this farm yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {pending && (
        <GpmChangeDialog profile={pending.r.profile} newGpm={pending.n} busy={pendingBusy} onCancel={() => { setPending(null); setGpmEpoch((x) => x + 1) }} onChoose={chooseGpmChange} />
      )}

      {deleteTarget && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div role="dialog" aria-label="Delete package" style={{ background: '#fff', borderRadius: 10, padding: 20, width: 320, maxWidth: '92vw', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Delete this package?</div>
            <div style={{ fontSize: 13, fontWeight: 600, wordBreak: 'break-all' }}>{deleteTarget.pkg.fileName}</div>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 10 }}>{deleteTarget.name}{deleteTarget.pkg.uploadedAt ? ` \u00b7 uploaded ${new Date(deleteTarget.pkg.uploadedAt).toLocaleDateString()}` : ''}</div>
            <div style={{ fontSize: 13, color: '#555', lineHeight: 1.5, marginBottom: 8 }}>This deletes the PDF for good. You won&rsquo;t be able to get it back.</div>
            <div style={{ fontSize: 12, color: '#555', lineHeight: 1.5, marginBottom: 16 }}>The GPM already confirmed stays in use until a new package is uploaded and confirmed.</div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setDeleteTarget(null)} disabled={deleting} style={{ fontSize: 13 }}>Cancel</button>
              <button type="button" onClick={confirmDelete} disabled={deleting} style={{ fontSize: 13, background: '#FBEAEA', border: '1px solid #E8B4B4', color: BAD }}>{deleting ? 'Deleting\u2026' : 'Delete package'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
