import { useState, useEffect, useRef, useMemo } from 'react'

const FARM_SCOPED_MANAGER_ROLES = ['farm_manager']
const STATUS_RANK = { wet: 0, dry: 1, stopped: 2 }

function statusInfo(pivot) {
  if (!pivot) return { label: '\u2014', key: null }
  const isRunning = pivot.systemStatus === 'Running'
  if (!isRunning) return { label: 'Stopped', key: 'stopped' }
  return pivot.waterMode === 'Dry' ? { label: 'Running, dry', key: 'dry' } : { label: 'Running, wet', key: 'wet' }
}

const DEFAULT_SORT_BY = 'pivot'
const DEFAULT_SORT_DIR = 'asc'

export default function PivotProfilesList({
  farms,
  pivotsByGuid,
  pivotProfilesByGuid,
  pivotGuidByFieldId,
  baseFieldsById,
  userRole,
  userProfile,
  onOpenProfile,
  onBack
}) {
  const [sortBy, setSortBy] = useState(DEFAULT_SORT_BY)
  const [sortDir, setSortDir] = useState(DEFAULT_SORT_DIR)
  const [openMenu, setOpenMenu] = useState(null)
  const [farmFilter, setFarmFilter] = useState(new Set())
  const [gpmFilter, setGpmFilter] = useState(new Set())
  const [packageFilter, setPackageFilter] = useState(new Set())
  const [statusFilter, setStatusFilter] = useState(new Set())
  const [lapTimeFilter, setLapTimeFilter] = useState(new Set())
  const menuRef = useRef(null)

  const isFarmManager = FARM_SCOPED_MANAGER_ROLES.includes(userRole)
  const isAdminOrOwner = userRole === 'admin' || userRole === 'owner'

  useEffect(() => {
    if (!openMenu) return
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpenMenu(null)
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [openMenu])

  function toggle(setFn, value) {
    setFn((prev) => {
      const next = new Set(prev)
      next.has(value) ? next.delete(value) : next.add(value)
      return next
    })
  }

  const noFiltersActive = farmFilter.size === 0 && gpmFilter.size === 0 && packageFilter.size === 0 && statusFilter.size === 0 && lapTimeFilter.size === 0
  const isDefaultView = sortBy === DEFAULT_SORT_BY && sortDir === DEFAULT_SORT_DIR && noFiltersActive

  function clearAll() {
    setSortBy(DEFAULT_SORT_BY)
    setSortDir(DEFAULT_SORT_DIR)
    setFarmFilter(new Set())
    setGpmFilter(new Set())
    setPackageFilter(new Set())
    setStatusFilter(new Set())
    setLapTimeFilter(new Set())
  }

  const fieldIdsByPivotGuid = useMemo(() => {
    const map = {}
    Object.entries(pivotGuidByFieldId).forEach(([fieldId, guid]) => {
      if (!guid) return
      if (!map[guid]) map[guid] = []
      map[guid].push(fieldId)
    })
    return map
  }, [pivotGuidByFieldId])

  const farmNameById = useMemo(() => {
    const map = {}
    farms.forEach((f) => { map[String(f.id)] = f.name })
    return map
  }, [farms])

  // Farm Manager only ever sees their own assigned farm(s) in this list —
  // and in the Farm column's own filter checklist, they only see those
  // same farms to narrow between, not the whole company's.
  const availableFarms = useMemo(() => {
    if (!isFarmManager) return farms
    const mine = (userProfile && Array.isArray(userProfile.farmIds) ? userProfile.farmIds : []).map(String)
    return farms.filter((f) => mine.includes(String(f.id)))
  }, [farms, isFarmManager, userProfile])

  const rows = useMemo(() => {
    const hardScopeFarmIds = isFarmManager ? availableFarms.map((f) => String(f.id)) : null

    let list = Object.entries(pivotsByGuid).map(([guid, pivot]) => {
      const fieldIds = fieldIdsByPivotGuid[guid] || []
      const farmIds = [...new Set(fieldIds.map((fid) => baseFieldsById[fid] && baseFieldsById[fid].farmId).filter((f) => f != null).map(String))]
      const profile = pivotProfilesByGuid[guid] || {}
      const status = statusInfo(pivot)
      return {
        guid,
        name: pivot.name || guid,
        farmIds,
        farmNames: farmIds.map((fid) => farmNameById[fid] || fid).join(', ') || '\u2014',
        gpm: profile.currentGpm != null ? profile.currentGpm : null,
        packageName: profile.sprinklerPackage ? profile.sprinklerPackage.fileName : null,
        threshold: profile.stuckAlertThresholdMinutes || 60,
        flagged: !!profile.stuckAlertActive || !!profile.lapTimeDriftFlagged,
        lapTimeHours: profile.currentLapTimeHours != null ? profile.currentLapTimeHours : null,
        lapTimeIsLive: !!profile.currentLapTimeIsLive,
        lapTimeDrift: !!profile.lapTimeDriftFlagged,
        statusLabel: status.label,
        statusKey: status.key
      }
    })

    if (hardScopeFarmIds) {
      list = list.filter((row) => row.farmIds.some((fid) => hardScopeFarmIds.includes(fid)))
    }

    list = list
      .filter((row) => farmFilter.size === 0 || row.farmIds.some((fid) => farmFilter.has(fid)))
      .filter((row) => gpmFilter.size === 0 || gpmFilter.has(row.gpm != null ? 'set' : 'not_set'))
      .filter((row) => packageFilter.size === 0 || packageFilter.has(row.packageName ? 'uploaded' : 'not_uploaded'))
      .filter((row) => {
        if (statusFilter.size === 0) return true
        if (statusFilter.has('flagged') && row.flagged) return true
        return row.statusKey && statusFilter.has(row.statusKey)
      })
      .filter((row) => {
        if (lapTimeFilter.size === 0) return true
        if (lapTimeFilter.has('drifted') && row.lapTimeDrift) return true
        if (lapTimeFilter.has('no_result') && row.lapTimeHours == null) return true
        return false
      })

    list.sort((a, b) => {
      let cmp
      if (sortBy === 'farm') cmp = a.farmNames.localeCompare(b.farmNames)
      else if (sortBy === 'gpm') {
        if (a.gpm == null && b.gpm == null) cmp = 0
        else if (a.gpm == null) cmp = 1
        else if (b.gpm == null) cmp = -1
        else cmp = a.gpm - b.gpm
      } else if (sortBy === 'package') {
        if (!a.packageName && !b.packageName) cmp = 0
        else if (!a.packageName) cmp = 1
        else if (!b.packageName) cmp = -1
        else cmp = a.packageName.localeCompare(b.packageName)
      } else if (sortBy === 'threshold') cmp = a.threshold - b.threshold
      else if (sortBy === 'lapTime') {
        if (a.lapTimeHours == null && b.lapTimeHours == null) cmp = 0
        else if (a.lapTimeHours == null) cmp = 1
        else if (b.lapTimeHours == null) cmp = -1
        else cmp = a.lapTimeHours - b.lapTimeHours
      }
      else if (sortBy === 'status') cmp = (STATUS_RANK[a.statusKey] ?? 3) - (STATUS_RANK[b.statusKey] ?? 3)
      else cmp = a.name.localeCompare(b.name)
      return sortDir === 'desc' ? -cmp : cmp
    })

    return list
  }, [pivotsByGuid, pivotProfilesByGuid, fieldIdsByPivotGuid, baseFieldsById, farmNameById, isFarmManager, availableFarms, farmFilter, gpmFilter, packageFilter, statusFilter, lapTimeFilter, sortBy, sortDir])

  function Header({ label, sortKey, children }) {
    return (
      <th style={{ padding: '6px 8px', position: 'relative' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px', whiteSpace: 'nowrap' }}>
          <span>{label}</span>
          <button
            aria-label={`Sort and filter ${label}`}
            onClick={(e) => { e.stopPropagation(); setOpenMenu(openMenu === sortKey ? null : sortKey) }}
            style={{ width: '18px', height: '18px', padding: 0, borderRadius: '4px', fontSize: '9px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >&#9662;</button>
        </div>
        {openMenu === sortKey && (
          <div
            ref={menuRef}
            className="sort-menu"
            style={{ position: 'absolute', top: '100%', left: 0, marginTop: '4px', zIndex: 20, textTransform: 'none', fontWeight: 400 }}
          >
            {children}
          </div>
        )}
      </th>
    )
  }

  return (
    <div style={{ padding: '16px 24px', maxWidth: '960px' }}>
      <button onClick={onBack} style={{ marginBottom: '16px' }}>&larr; Back</button>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '18px' }}>Pivot profiles</h2>
        {!isDefaultView && <button className="clear-sort-btn" onClick={clearAll}>Clear all</button>}
      </div>

      <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.02em', borderBottom: '1px solid #ddd8cc' }}>
            <Header label="Pivot" sortKey="pivot">
              <div className="sort-menu-label">Sort by pivot name</div>
              <div className="sort-menu-group row">
                <button className={sortDir === 'asc' ? 'active' : ''} onClick={() => { setSortBy('pivot'); setSortDir('asc') }}>A-Z</button>
                <button className={sortDir === 'desc' ? 'active' : ''} onClick={() => { setSortBy('pivot'); setSortDir('desc') }}>Z-A</button>
              </div>
            </Header>
            <Header label="Farm" sortKey="farm">
              <div className="sort-menu-label">Sort by farm</div>
              <div className="sort-menu-group row">
                <button className={sortBy === 'farm' && sortDir === 'asc' ? 'active' : ''} onClick={() => { setSortBy('farm'); setSortDir('asc') }}>A-Z</button>
                <button className={sortBy === 'farm' && sortDir === 'desc' ? 'active' : ''} onClick={() => { setSortBy('farm'); setSortDir('desc') }}>Z-A</button>
              </div>
              {(isAdminOrOwner || availableFarms.length > 1) && (
                <>
                  <div className="sort-menu-divider" />
                  <div className="sort-menu-label">Filter by farm</div>
                  <div className="sort-menu-checklist">
                    {availableFarms.map((farm) => (
                      <label key={farm.id}>
                        <input type="checkbox" checked={farmFilter.has(String(farm.id))} onChange={() => toggle(setFarmFilter, String(farm.id))} />
                        {farm.name}
                      </label>
                    ))}
                  </div>
                </>
              )}
            </Header>
            <Header label="GPM" sortKey="gpm">
              <div className="sort-menu-label">Sort by GPM</div>
              <div className="sort-menu-group row">
                <button className={sortBy === 'gpm' && sortDir === 'asc' ? 'active' : ''} onClick={() => { setSortBy('gpm'); setSortDir('asc') }}>Low-high</button>
                <button className={sortBy === 'gpm' && sortDir === 'desc' ? 'active' : ''} onClick={() => { setSortBy('gpm'); setSortDir('desc') }}>High-low</button>
              </div>
              <div className="sort-menu-divider" />
              <div className="sort-menu-label">Filter</div>
              <div className="sort-menu-checklist">
                <label><input type="checkbox" checked={gpmFilter.has('set')} onChange={() => toggle(setGpmFilter, 'set')} />GPM set</label>
                <label><input type="checkbox" checked={gpmFilter.has('not_set')} onChange={() => toggle(setGpmFilter, 'not_set')} />Not set</label>
              </div>
            </Header>
            <Header label="Sprinkler package" sortKey="package">
              <div className="sort-menu-label">Sort by file name</div>
              <div className="sort-menu-group row">
                <button className={sortBy === 'package' && sortDir === 'asc' ? 'active' : ''} onClick={() => { setSortBy('package'); setSortDir('asc') }}>A-Z</button>
                <button className={sortBy === 'package' && sortDir === 'desc' ? 'active' : ''} onClick={() => { setSortBy('package'); setSortDir('desc') }}>Z-A</button>
              </div>
              <div className="sort-menu-divider" />
              <div className="sort-menu-label">Filter</div>
              <div className="sort-menu-checklist">
                <label><input type="checkbox" checked={packageFilter.has('uploaded')} onChange={() => toggle(setPackageFilter, 'uploaded')} />Uploaded</label>
                <label><input type="checkbox" checked={packageFilter.has('not_uploaded')} onChange={() => toggle(setPackageFilter, 'not_uploaded')} />Not uploaded</label>
              </div>
            </Header>
            <Header label="Alert threshold" sortKey="threshold">
              <div className="sort-menu-label">Sort by threshold</div>
              <div className="sort-menu-group row">
                <button className={sortBy === 'threshold' && sortDir === 'asc' ? 'active' : ''} onClick={() => { setSortBy('threshold'); setSortDir('asc') }}>Low-high</button>
                <button className={sortBy === 'threshold' && sortDir === 'desc' ? 'active' : ''} onClick={() => { setSortBy('threshold'); setSortDir('desc') }}>High-low</button>
              </div>
            </Header>
            <Header label="Min lap time" sortKey="lapTime">
              <div className="sort-menu-label">Sort by lap time</div>
              <div className="sort-menu-group row">
                <button className={sortBy === 'lapTime' && sortDir === 'asc' ? 'active' : ''} onClick={() => { setSortBy('lapTime'); setSortDir('asc') }}>Low-high</button>
                <button className={sortBy === 'lapTime' && sortDir === 'desc' ? 'active' : ''} onClick={() => { setSortBy('lapTime'); setSortDir('desc') }}>High-low</button>
              </div>
              <div className="sort-menu-divider" />
              <div className="sort-menu-label">Filter</div>
              <div className="sort-menu-checklist">
                <label><input type="checkbox" checked={lapTimeFilter.has('drifted')} onChange={() => toggle(setLapTimeFilter, 'drifted')} />Drifted from baseline</label>
                <label><input type="checkbox" checked={lapTimeFilter.has('no_result')} onChange={() => toggle(setLapTimeFilter, 'no_result')} />No result yet</label>
              </div>
            </Header>
            <Header label="Status" sortKey="status">
              <div className="sort-menu-label">Sort by status</div>
              <div className="sort-menu-group row">
                <button className={sortBy === 'status' && sortDir === 'asc' ? 'active' : ''} onClick={() => { setSortBy('status'); setSortDir('asc') }}>Running first</button>
                <button className={sortBy === 'status' && sortDir === 'desc' ? 'active' : ''} onClick={() => { setSortBy('status'); setSortDir('desc') }}>Stopped first</button>
              </div>
              <div className="sort-menu-divider" />
              <div className="sort-menu-label">Filter</div>
              <div className="sort-menu-checklist">
                <label><input type="checkbox" checked={statusFilter.has('wet')} onChange={() => toggle(setStatusFilter, 'wet')} />Running, wet</label>
                <label><input type="checkbox" checked={statusFilter.has('dry')} onChange={() => toggle(setStatusFilter, 'dry')} />Running, dry</label>
                <label><input type="checkbox" checked={statusFilter.has('stopped')} onChange={() => toggle(setStatusFilter, 'stopped')} />Stopped</label>
                <label><input type="checkbox" checked={statusFilter.has('flagged')} onChange={() => toggle(setStatusFilter, 'flagged')} />Flagged only</label>
              </div>
            </Header>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.guid}
              onClick={() => onOpenProfile(row.guid)}
              style={{ cursor: 'pointer', borderBottom: '1px solid #eee', background: row.flagged ? '#fbeaea' : undefined }}
            >
              <td style={{ padding: '7px 8px', fontWeight: 600 }}>
                {row.flagged && <span style={{ color: '#A32D2D', fontWeight: 700, marginRight: '4px' }}>!</span>}
                {row.name}
              </td>
              <td style={{ padding: '7px 8px', color: '#666' }}>{row.farmNames}</td>
              <td style={{ padding: '7px 8px', color: row.gpm == null ? '#A32D2D' : undefined }}>{row.gpm != null ? row.gpm : 'Not set'}</td>
              <td style={{ padding: '7px 8px', color: row.packageName ? '#185FA5' : '#888' }}>{row.packageName || 'Not uploaded'}</td>
              <td style={{ padding: '7px 8px' }}>{row.threshold} min</td>
              <td style={{ padding: '7px 8px', color: row.lapTimeDrift ? '#854F0B' : row.lapTimeHours == null ? '#888' : undefined }}>
                {row.lapTimeHours != null ? `${row.lapTimeHours} hr${row.lapTimeIsLive ? ' (live)' : ''}` : '\u2014'}
              </td>
              <td style={{ padding: '7px 8px', color: row.statusKey === 'stopped' ? '#888' : undefined }}>{row.statusLabel}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p style={{ color: '#888', padding: '1rem 0' }}>No pivots match the current filters.</p>}
    </div>
  )
}
