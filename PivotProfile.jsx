import { useState, useEffect, useMemo } from 'react'

const FARM_SCOPED_MANAGER_ROLES = ['farm_manager']

function statusLabel(pivot) {
  if (!pivot) return '\u2014'
  const isRunning = pivot.systemStatus === 'Running'
  if (!isRunning) return 'Stopped'
  return pivot.waterMode === 'Dry' ? 'Running, dry' : 'Running, wet'
}

export default function PivotProfilesList({
  farms,
  pivotsByGuid,
  pivotProfilesByGuid,
  pivotGuidByFieldId,
  baseFieldsById,
  userRole,
  userProfile,
  selectedFarmId,
  onOpenProfile,
  onBack
}) {
  const [checkedFarmIds, setCheckedFarmIds] = useState([])
  const [defaultApplied, setDefaultApplied] = useState(false)

  const isFarmManager = FARM_SCOPED_MANAGER_ROLES.includes(userRole)
  const isAdminOrOwner = userRole === 'admin' || userRole === 'owner'

  // Default the admin/owner checklist to whatever farm was already selected
  // on the schedule ("all" pre-checks every farm) — just a sensible
  // starting point, not a restriction; they can still change it.
  useEffect(() => {
    if (defaultApplied || farms.length === 0) return
    if (selectedFarmId && selectedFarmId !== 'all') {
      setCheckedFarmIds([String(selectedFarmId)])
    } else {
      setCheckedFarmIds(farms.map((f) => String(f.id)))
    }
    setDefaultApplied(true)
  }, [defaultApplied, farms, selectedFarmId])

  function toggleFarm(farmId) {
    setCheckedFarmIds((prev) => {
      const id = String(farmId)
      return prev.includes(id) ? prev.filter((f) => f !== id) : [...prev, id]
    })
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

  const rows = useMemo(() => {
    const scopeFarmIds = isFarmManager
      ? (userProfile && Array.isArray(userProfile.farmIds) ? userProfile.farmIds.map(String) : [])
      : checkedFarmIds

    return Object.entries(pivotsByGuid)
      .map(([guid, pivot]) => {
        const fieldIds = fieldIdsByPivotGuid[guid] || []
        const farmIds = [...new Set(fieldIds.map((fid) => baseFieldsById[fid] && baseFieldsById[fid].farmId).filter((f) => f != null).map(String))]
        const profile = pivotProfilesByGuid[guid] || {}
        return {
          guid,
          name: pivot.name || guid,
          farmIds,
          farmNames: farmIds.map((fid) => farmNameById[fid] || fid).join(', ') || '\u2014',
          gpm: profile.currentGpm != null ? profile.currentGpm : null,
          packageName: profile.sprinklerPackage ? profile.sprinklerPackage.fileName : null,
          threshold: profile.stuckAlertThresholdMinutes || 30,
          stuck: !!profile.stuckAlertActive,
          status: statusLabel(pivot)
        }
      })
      .filter((row) => row.farmIds.some((fid) => scopeFarmIds.includes(fid)))
      .sort((a, b) => a.name.localeCompare(b.name))
  }, [pivotsByGuid, pivotProfilesByGuid, fieldIdsByPivotGuid, baseFieldsById, farmNameById, isFarmManager, userProfile, checkedFarmIds])

  return (
    <div style={{ padding: '16px 24px', maxWidth: '900px' }}>
      <button onClick={onBack} style={{ marginBottom: '16px' }}>&larr; Back</button>
      <h2 style={{ margin: '0 0 16px', fontSize: '18px' }}>Pivot profiles</h2>

      {isAdminOrOwner && (
        <div style={{ marginBottom: '16px' }}>
          <div className="editor-label" style={{ marginBottom: '6px' }}>Farms</div>
          <div style={{ display: 'flex', gap: '14px', flexWrap: 'wrap' }}>
            {farms.map((farm) => (
              <label key={farm.id} style={{ display: 'flex', alignItems: 'center', gap: '5px', fontSize: '13px' }}>
                <input
                  type="checkbox"
                  checked={checkedFarmIds.includes(String(farm.id))}
                  onChange={() => toggleFarm(farm.id)}
                  style={{ margin: 0 }}
                />
                {farm.name}
              </label>
            ))}
          </div>
        </div>
      )}

      <table style={{ width: '100%', fontSize: '12px', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#555', fontSize: '10px', textTransform: 'uppercase', letterSpacing: '0.02em', borderBottom: '1px solid #ddd8cc' }}>
            <th style={{ padding: '6px 8px' }}>Pivot</th>
            <th style={{ padding: '6px 8px' }}>Farm</th>
            <th style={{ padding: '6px 8px' }}>GPM</th>
            <th style={{ padding: '6px 8px' }}>Sprinkler package</th>
            <th style={{ padding: '6px 8px' }}>Alert threshold</th>
            <th style={{ padding: '6px 8px' }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.guid}
              onClick={() => onOpenProfile(row.guid)}
              style={{ cursor: 'pointer', borderBottom: '1px solid #eee', background: row.stuck ? '#fbeaea' : undefined }}
            >
              <td style={{ padding: '7px 8px', fontWeight: 600 }}>
                {row.stuck && <span style={{ color: '#A32D2D', fontWeight: 700, marginRight: '4px' }}>!</span>}
                {row.name}
              </td>
              <td style={{ padding: '7px 8px', color: '#666' }}>{row.farmNames}</td>
              <td style={{ padding: '7px 8px', color: row.gpm == null ? '#A32D2D' : undefined }}>{row.gpm != null ? row.gpm : 'Not set'}</td>
              <td style={{ padding: '7px 8px', color: row.packageName ? '#185FA5' : '#888' }}>{row.packageName || 'Not uploaded'}</td>
              <td style={{ padding: '7px 8px' }}>{row.threshold} min</td>
              <td style={{ padding: '7px 8px', color: row.status === 'Stopped' ? '#888' : undefined }}>{row.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p style={{ color: '#888', padding: '1rem 0' }}>No pivots for the selected farm(s).</p>}
    </div>
  )
}
