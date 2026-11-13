import { useEffect, useMemo, useRef, useState } from 'react'
import { doc, setDoc } from 'firebase/firestore'
import { auth, db } from './firebase.js'

// "Pivot Profiles" spreadsheet view (Irrigation views dropdown): every pivot on one farm in a grid, with the
// profile settings editable in place. Saves go to the same pivotProfiles/{guid} document the single profile page
// writes, in the same shapes, so the Firestore rules apply exactly as they do there. In particular a GPM can only be
// set by: confirming the number read from the package, typing it while "No package printout" is ticked (no package on
// file), or typing it from the package when the reader couldn't find one. Package PDFs are uploaded on the profile page.

const INK = '#2b2b26'
const MUTED = '#6b6a62'
const LINE = '#e4e1d8'
const GOOD = '#2F6B2F'
const WARN = '#854F0B'
const BAD = '#A32D2D'

const th = { textAlign: 'left', padding: '8px 8px', fontSize: 11.5, color: MUTED, fontWeight: 600, borderBottom: `1px solid ${LINE}`, background: '#f4f2ec', position: 'sticky', top: 0, zIndex: 3, whiteSpace: 'nowrap' }
const td = { padding: '5px 8px', fontSize: 13, borderBottom: '0.5px solid #eee', verticalAlign: 'middle', background: '#fff' }
const inputStyle = { width: 76, padding: '4px 6px', fontSize: 13, border: `1px solid #ccc`, borderRadius: 5, background: '#fff', textAlign: 'right' }
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
    try { await onSave(n); setDraft(null); setStatus(cellKey, { saved: true }) } catch (e) { setStatus(cellKey, { error: e.message || 'Could not save.' }) }
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

export default function PivotProfilesSheet({ farms, pivotsByGuid, pivotProfilesByGuid, pivotGuidByFieldId, baseFieldsById, seasonDataByField, userRole, userProfile, selectedFarmId, onOpenProfile }) {
  const canEdit = EDIT_ROLES.includes(userRole)
  const isFarmManager = userRole === 'farm_manager'
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
      list.push({
        guid, profile, pkg, scan, gpm, gpmMode,
        name: names.length ? names.join(' + ') : (pivot.name || guid),
        baseName: pivot.name && names.length && !names.includes(pivot.name) ? pivot.name : '',
        acres: hasAcres ? acres : null,
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
  const saveGpm = (r, source, n) => save(r.guid, {
    currentGpm: n, gpmSource: source,
    gpmConfirmedPath: source === 'typedFromPackage' && r.pkg ? r.pkg.storagePath : null,
    gpmConfirmedBy: whoAmI(), gpmConfirmedAt: new Date().toISOString()
  })
  const confirmGpm = (r) => run(`GPM ${r.name}`, () => save(r.guid, {
    currentGpm: r.scan.gpm, gpmSource: 'package', gpmConfirmedPath: r.pkg.storagePath,
    gpmConfirmedBy: whoAmI(), gpmConfirmedAt: new Date().toISOString(), noPackagePrintout: false
  }))

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
        Click a box and type. It saves when you leave the box or press Enter. Package PDFs are uploaded on each pivot&rsquo;s own profile (click the pivot name). A GPM can only be typed when &ldquo;No printout&rdquo; is ticked, or when the package couldn&rsquo;t be read; otherwise confirm the number read from the package.
      </p>

      <div style={{ overflowX: 'auto', border: `0.5px solid ${LINE}`, borderRadius: 10, background: '#fff', maxHeight: 'calc(100vh - 230px)', overflowY: 'auto' }}>
        <table style={{ width: '100%', minWidth: 1020, borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th style={{ ...th, left: 0, zIndex: 4, minWidth: 170 }}>Pivot</th>
              <th style={{ ...th, textAlign: 'right' }}>Acres</th>
              <th style={th}>Package</th>
              <th style={th}>GPM</th>
              <th style={th}>No printout</th>
              <th style={{ ...th, textAlign: 'right' }}>Stuck alert (min)</th>
              <th style={th}>Corner machine</th>
              <th style={{ ...th, textAlign: 'right' }}>Corner length (ft)</th>
              <th style={{ ...th, textAlign: 'right' }}>Min lap time (h)</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const k = (c) => `${c} ${r.name}`
              const lockEdit = !canEdit
              return (
                <tr key={r.guid}>
                  <td style={{ ...td, position: 'sticky', left: 0, zIndex: 2, minWidth: 170 }}>
                    <button type="button" onClick={() => onOpenProfile(r.guid)} title="Open this pivot's full profile" style={{ border: 'none', background: 'none', padding: 0, textAlign: 'left', cursor: 'pointer', color: INK, fontWeight: 600, fontSize: 13 }}>{r.name}</button>
                    {r.baseName && <div style={small}>{r.baseName}</div>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>{r.acres != null ? r.acres.toFixed(1) : '—'}</td>
                  <td style={{ ...td, maxWidth: 220 }}>
                    {r.pkg ? (
                      <>
                        <a href={r.pkg.downloadUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.pkg.fileName}</a>
                        <span style={small}>{r.scan == null ? 'Reading…' : r.scan.status === 'read' ? `Reads ${r.scan.gpm} GPM` : r.scan.status === 'failed' ? "Couldn't read it" : 'No GPM found on it'}</span>
                      </>
                    ) : <span style={{ color: MUTED }}>None</span>}
                  </td>
                  <td style={{ ...td, minWidth: 190 }}>
                    {r.gpmMode === 'confirmed' && (
                      <div><b>{r.gpm}</b> <span style={{ fontSize: 11, color: GOOD }}>{r.profile.gpmSource === 'typedFromPackage' ? '✓ typed from package' : '✓ from package'}</span></div>
                    )}
                    {r.gpmMode === 'reading' && <span style={small}>{r.gpm != null ? `${r.gpm} in use. ` : ''}Reading the package&hellip;</span>}
                    {r.gpmMode === 'confirm' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        {r.gpm != null && <span style={small}>{r.gpm} in use</span>}
                        <button type="button" disabled={lockEdit || !!busy[k('GPM')]} onClick={() => confirmGpm(r)} style={{ fontSize: 12, padding: '4px 10px', background: INK, color: '#fff', border: 'none', borderRadius: 5 }}>{busy[k('GPM')] ? 'Confirming…' : `Confirm ${r.scan.gpm}`}</button>
                        <span style={{ width: 14, fontSize: 12, color: status[k('GPM')] && status[k('GPM')].error ? BAD : GOOD }} title={(status[k('GPM')] && status[k('GPM')].error) || ''}>{status[k('GPM')] && status[k('GPM')].error ? '!' : status[k('GPM')] && status[k('GPM')].saved ? '✓' : ''}</span>
                      </div>
                    )}
                    {(r.gpmMode === 'typeFromPackage' || r.gpmMode === 'manual') && (
                      <div>
                        <NumberCell cellKey={k('GPM')} colKey="gpm" value={r.gpm} min={5} max={5000} disabled={lockEdit} status={status} setStatus={setStatus}
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
                  <td style={{ ...td, textAlign: 'center' }}>
                    <input type="checkbox" aria-label={k('No printout')} checked={!!r.profile.noPackagePrintout && !r.pkg} disabled={lockEdit || !!r.pkg}
                      title={r.pkg ? 'A package is on file' : ''}
                      onChange={(e) => run(k('No printout'), () => save(r.guid, { noPackagePrintout: e.target.checked }))} />
                    {status[k('No printout')] && status[k('No printout')].error && <div style={{ fontSize: 11, color: BAD }}>{status[k('No printout')].error}</div>}
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    <NumberCell cellKey={k('Stuck alert')} colKey="threshold" value={r.threshold} integer min={45} max={120} disabled={lockEdit} status={status} setStatus={setStatus}
                      onSave={(n) => save(r.guid, { stuckAlertThresholdMinutes: n })} />
                  </td>
                  <td style={{ ...td, textAlign: 'center' }}>
                    <input type="checkbox" aria-label={k('Corner machine')} checked={r.hasCorner} disabled={lockEdit}
                      onChange={(e) => run(k('Corner machine'), () => save(r.guid, { hasCornerMachine: e.target.checked }))} />
                  </td>
                  <td style={{ ...td, textAlign: 'right' }}>
                    {r.hasCorner
                      ? <NumberCell cellKey={k('Corner length')} colKey="corner" value={r.cornerLen} min={1} disabled={lockEdit} status={status} setStatus={setStatus} onSave={(n) => save(r.guid, { cornerMachineLengthFt: n })} />
                      : <span style={{ color: '#bbb' }}>{'—'}</span>}
                  </td>
                  <td style={{ ...td, textAlign: 'right', color: r.lapDrift ? BAD : MUTED }}>{r.lap != null ? `${Number(r.lap).toFixed(1)}${r.lapDrift ? ' ⚠' : ''}` : '—'}</td>
                </tr>
              )
            })}
            {shown.length === 0 && (
              <tr><td colSpan={9} style={{ ...td, textAlign: 'center', color: MUTED, padding: 24 }}>{rows.length ? 'No pivots match this filter.' : 'No pivots are linked to fields on this farm yet.'}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}
