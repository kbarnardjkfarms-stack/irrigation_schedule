import { useState, useEffect, useMemo } from 'react'
import { collection, doc, getDoc, getDocs, onSnapshot, query, setDoc, where } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase.js'
import PivotIcon from './PivotIcon.jsx'

// Layout helpers for the profile page: each data section sits in its own
// white card with a title, and cards are grouped under small headings so
// the sections don't run together on the cream page background.
function Group({ title }) {
  return (
    <div style={{ fontSize: '11px', fontWeight: 600, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#8a8780', margin: '26px 0 8px 2px' }}>
      {title}
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #e4e1d8', borderRadius: '10px', padding: '14px 16px', marginBottom: '12px' }}>
      <div style={{ fontSize: '13px', fontWeight: 600, color: '#2b2b26', marginBottom: '10px' }}>{title}</div>
      {children}
    </div>
  )
}

export default function PivotProfile({ pivotGuid, onBack }) {
  const [pivot, setPivot] = useState(null)
  const [profile, setProfile] = useState(null)
  const [gpmInput, setGpmInput] = useState('')
  const [thresholdInput, setThresholdInput] = useState('60')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [gpmSaved, setGpmSaved] = useState(false)
  const [thresholdSaved, setThresholdSaved] = useState(false)
  const [currentSeasonId, setCurrentSeasonId] = useState(null)
  const [currentSeasonName, setCurrentSeasonName] = useState(null)
  const [acres, setAcres] = useState(null)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [cornerLengthInput, setCornerLengthInput] = useState('')
  const [cornerSaved, setCornerSaved] = useState(false)

  // One-time lookup, not a live listener — this pivot's combined acreage
  // (across every field it maps to) and which season is "current" don't
  // change minute to minute the way status/profile data does.
  useEffect(() => {
    if (!pivotGuid) return
    let cancelled = false
    async function loadSeasonAndAcres() {
      const seasonsSnap = await getDocs(collection(db, 'seasons'))
      const seasonsList = []
      seasonsSnap.forEach((d) => seasonsList.push({ id: d.id, ...d.data() }))
      seasonsList.sort((a, b) => (b.startDate || '').localeCompare(a.startDate || ''))
      const currentYear = String(new Date().getFullYear())
      const match = seasonsList.find((s) => String(s.name) === currentYear)
      const seasonId = match ? match.id : (seasonsList[0] ? seasonsList[0].id : null)
      const seasonName = match ? match.name : (seasonsList[0] ? seasonsList[0].name : null)
      if (cancelled) return
      setCurrentSeasonId(seasonId)
      setCurrentSeasonName(seasonName)

      const mappingSnap = await getDocs(query(collection(db, 'pivotFieldMapping'), where('pivotGuid', '==', pivotGuid)))
      // A Set here, not an array — a leftover mapping doc from before the
      // pivotFieldMapping rekey (fieldId-keyed docs replaced the old
      // pivotGuid-keyed ones, but old ones weren't always cleaned up) can
      // otherwise list the same field twice and silently double the
      // acreage total below.
      const fieldIds = new Set()
      mappingSnap.forEach((d) => { if (d.data().fieldId) fieldIds.add(d.data().fieldId) })

      if (!seasonId || fieldIds.size === 0) { if (!cancelled) setAcres(0); return }
      const seasonDocs = await Promise.all([...fieldIds].map((fid) => getDoc(doc(db, 'fields', fid, 'seasons', seasonId))))
      const total = seasonDocs.reduce((sum, snap) => sum + (snap.exists() ? (snap.data().acres || 0) : 0), 0)
      if (!cancelled) setAcres(total)
    }
    loadSeasonAndAcres()
    return () => { cancelled = true }
  }, [pivotGuid])

  useEffect(() => {
    if (!pivotGuid) return
    const unsub = onSnapshot(doc(db, 'pivots', pivotGuid), (snap) => setPivot(snap.exists() ? snap.data() : null))
    return () => unsub()
  }, [pivotGuid])

  useEffect(() => {
    if (!pivotGuid) return
    const unsub = onSnapshot(doc(db, 'pivotProfiles', pivotGuid), (snap) => {
      const data = snap.exists() ? snap.data() : null
      setProfile(data)
      setGpmInput(data && data.currentGpm != null ? String(data.currentGpm) : '')
      setThresholdInput(data && data.stuckAlertThresholdMinutes != null ? String(data.stuckAlertThresholdMinutes) : '60')
      setCornerLengthInput(data && data.cornerMachineLengthFt != null ? String(data.cornerMachineLengthFt) : '')
    })
    return () => unsub()
  }, [pivotGuid])

  async function handleUpload(e) {
    const file = e.target.files && e.target.files[0]
    if (!file) return
    setUploading(true)
    setError(null)
    try {
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
      const path = `pivotProfiles/${pivotGuid}/${Date.now()}_${safeName}`
      const fileRef = ref(storage, path)
      await uploadBytes(fileRef, file)
      const downloadUrl = await getDownloadURL(fileRef)
      const newEntry = { fileName: file.name, uploadedAt: new Date().toISOString(), downloadUrl, storagePath: path }
      const existingHistory = (profile && profile.sprinklerPackageHistory) || []
      const history = profile && profile.sprinklerPackage ? [profile.sprinklerPackage, ...existingHistory] : existingHistory
      await setDoc(doc(db, 'pivotProfiles', pivotGuid), {
        sprinklerPackage: newEntry,
        sprinklerPackageHistory: history
      }, { merge: true })
    } catch (err) {
      setError(err.message || 'Upload failed.')
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  async function handleSaveGpm() {
    const n = parseFloat(gpmInput)
    if (!gpmInput || isNaN(n) || n <= 0) { setError('Enter a valid GPM.'); return }
    setError(null)
    await setDoc(doc(db, 'pivotProfiles', pivotGuid), { currentGpm: n }, { merge: true })
    setGpmSaved(true)
    setTimeout(() => setGpmSaved(false), 1500)
  }

  async function handleSaveThreshold() {
    const n = parseInt(thresholdInput, 10)
    if (!thresholdInput || isNaN(n) || n < 45 || n > 120) {
      setError('Enter a number between 45 and 120.')
      return
    }
    setError(null)
    await setDoc(doc(db, 'pivotProfiles', pivotGuid), { stuckAlertThresholdMinutes: n }, { merge: true })
    setThresholdSaved(true)
    setTimeout(() => setThresholdSaved(false), 1500)
  }

  async function handleSetCornerMachine(hasIt) {
    setError(null)
    try {
      await setDoc(doc(db, 'pivotProfiles', pivotGuid), { hasCornerMachine: hasIt }, { merge: true })
    } catch (err) {
      setError(err.message || 'Could not save.')
    }
  }

  async function handleSaveCornerLength() {
    const n = parseFloat(cornerLengthInput)
    if (!cornerLengthInput || isNaN(n) || n <= 0) { setError('Enter the corner machine length in feet.'); return }
    setError(null)
    await setDoc(doc(db, 'pivotProfiles', pivotGuid), { cornerMachineLengthFt: n }, { merge: true })
    setCornerSaved(true)
    setTimeout(() => setCornerSaved(false), 1500)
  }

  async function handleResetWetDry() {
    setError(null)
    try {
      await setDoc(doc(db, 'pivotProfiles', pivotGuid), {
        wetHours: 0,
        dryHours: 0,
        wetDryTrackingSince: new Date().toISOString()
      }, { merge: true })
    } catch (err) {
      setError(err.message || 'Reset failed.')
    } finally {
      setShowResetConfirm(false)
    }
  }

  if (!pivotGuid) return null

  const pkg = profile && profile.sprinklerPackage
  const historyCount = (profile && profile.sprinklerPackageHistory && profile.sprinklerPackageHistory.length) || 0

  const episode = profile && profile.auditEpisode
  const episodeElapsedHours = episode ? (Date.now() - new Date(episode.startedAt).getTime()) / 3600000 : null
  const baseline = profile && profile.seasonBaselines && currentSeasonId ? profile.seasonBaselines[currentSeasonId] : null
  const requiredHours = acres != null ? (acres > 30 ? 24 : 12) : null
  const baselineProgressPct = (!baseline && episode && requiredHours)
    ? Math.min(100, Math.round((episodeElapsedHours / requiredHours) * 100))
    : null
  const hasDrift = !!(profile && profile.lapTimeDriftFlagged)

  // Corner machine acres. BaseStation's pivot length does NOT include the
  // corner machine, so the circle the pivot sweeps on its own is
  // pi * length^2, scaled by how much of the circle it travels (same
  // reverse-to-forward arc the pivot icon and watcher use). Whatever the
  // linked AgWorld fields add up to beyond that is the corner machine's.
  const hasCorner = !!(profile && profile.hasCornerMachine)
  const pivotLengthFt = profile && profile.machineLengthFt != null ? Number(profile.machineLengthFt) : null
  let pivotAcres = null
  if (pivotLengthFt && pivotLengthFt > 0) {
    const rev = Number(pivot && pivot.reverseAngle) || 0
    const fwd = Number(pivot && pivot.forwardAngle) || 0
    let arc = 360
    if (rev !== fwd) { arc = fwd - rev; if (arc < 0) arc += 360 }
    pivotAcres = (Math.PI * pivotLengthFt * pivotLengthFt / 43560) * (arc / 360)
  }
  const cornerAcres = (acres != null && pivotAcres != null) ? acres - pivotAcres : null
  const cornerLengthSaved = profile && profile.cornerMachineLengthFt != null ? profile.cornerMachineLengthFt : null

  const wetHours = profile && profile.wetHours != null ? profile.wetHours : 0
  const dryHours = profile && profile.dryHours != null ? profile.dryHours : 0
  const wetDryTrackingSince = profile && profile.wetDryTrackingSince

  return (
    <div style={{ padding: '16px 24px 40px', maxWidth: '480px' }}>
      <button onClick={onBack} style={{ marginBottom: '16px' }}>&larr; Back</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '4px', paddingBottom: '14px', borderBottom: '1px solid #e4e1d8' }}>
        <PivotIcon pivot={pivot} size={44} />
        <div>
          <div style={{ fontSize: '16px', fontWeight: 600 }}>{(pivot && pivot.name) || 'Pivot'}</div>
          <div style={{ fontSize: '11px', color: '#888' }}>Pivot profile</div>
        </div>
      </div>

      <Group title="Setup" />

      <Section title="Sprinkler package">
        {pkg ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px', background: '#f4f2ec', borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ flex: 1 }}>
              <a href={pkg.downloadUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: '13px' }}>{pkg.fileName}</a>
              <div style={{ fontSize: '10px', color: '#888', marginTop: '2px' }}>Uploaded {new Date(pkg.uploadedAt).toLocaleDateString()}</div>
            </div>
            <label style={{ fontSize: '12px', padding: '6px 10px', border: '1px solid #ccc', borderRadius: '6px', cursor: uploading ? 'default' : 'pointer', background: '#fff' }}>
              {uploading ? 'Uploading\u2026' : 'Replace'}
              <input type="file" accept="application/pdf" onChange={handleUpload} disabled={uploading} style={{ display: 'none' }} />
            </label>
          </div>
        ) : (
          <label style={{ display: 'inline-block', fontSize: '13px', padding: '8px 14px', border: '1px dashed #ccc', borderRadius: '8px', cursor: uploading ? 'default' : 'pointer' }}>
            {uploading ? 'Uploading\u2026' : 'Upload PDF'}
            <input type="file" accept="application/pdf" onChange={handleUpload} disabled={uploading} style={{ display: 'none' }} />
          </label>
        )}
        {historyCount > 0 && (
          <div style={{ fontSize: '10px', color: '#888', marginTop: '6px' }}>{historyCount} older version{historyCount > 1 ? 's' : ''} kept for reference</div>
        )}
      </Section>

      <Section title="Current GPM">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input type="number" value={gpmInput} onChange={(e) => setGpmInput(e.target.value)} style={{ width: '100px' }} />
          <span style={{ fontSize: '13px', color: '#555' }}>GPM</span>
          <button onClick={handleSaveGpm}>{gpmSaved ? 'Saved!' : 'Save'}</button>
        </div>
        <div style={{ fontSize: '10px', color: '#888', marginTop: '6px' }}>Used for this pivot's scheduled-inches calculation</div>
      </Section>

      <Section title="Corner machine">
        <div style={{ fontSize: '12px', color: '#555', marginBottom: '6px' }}>Has corner machine?</div>
        <div style={{ display: 'flex', gap: '8px', marginBottom: '10px' }}>
          <button
            onClick={() => handleSetCornerMachine(false)}
            style={{ fontSize: '13px', padding: '6px 16px', borderRadius: '6px', border: '1px solid #ccc', background: !hasCorner ? '#2b2b26' : '#fff', color: !hasCorner ? '#fff' : '#2b2b26', cursor: 'pointer' }}
          >No</button>
          <button
            onClick={() => handleSetCornerMachine(true)}
            style={{ fontSize: '13px', padding: '6px 16px', borderRadius: '6px', border: '1px solid #ccc', background: hasCorner ? '#2b2b26' : '#fff', color: hasCorner ? '#fff' : '#2b2b26', cursor: 'pointer' }}
          >Yes</button>
        </div>
        {hasCorner && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
            <input type="number" value={cornerLengthInput} onChange={(e) => setCornerLengthInput(e.target.value)} style={{ width: '100px' }} />
            <span style={{ fontSize: '13px', color: '#555' }}>ft corner machine</span>
            <button onClick={handleSaveCornerLength}>{cornerSaved ? 'Saved!' : 'Save'}</button>
          </div>
        )}
        <div style={{ background: '#f4f2ec', borderRadius: '8px', padding: '10px 12px' }}>
          {pivotAcres == null ? (
            <div style={{ fontSize: '11px', color: '#888' }}>
              The pivot length from BaseStation hasn't been loaded for this pivot yet, so the acres breakdown isn't available.
            </div>
          ) : acres == null ? (
            <div style={{ fontSize: '11px', color: '#888' }}>Loading acres&hellip;</div>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#555', marginBottom: '4px' }}>
                <span>Under the pivot ({Math.round(pivotLengthFt)} ft)</span>
                <span>{pivotAcres.toFixed(1)} ac</span>
              </div>
              {hasCorner && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', color: '#555', marginBottom: '4px' }}>
                  <span>Under the corner machine</span>
                  <span>{cornerAcres.toFixed(1)} ac</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px', fontWeight: 600, color: '#2b2b26', borderTop: '1px solid #ddd', paddingTop: '6px', marginTop: '6px' }}>
                <span>Total (AgWorld{currentSeasonName ? ', ' + currentSeasonName : ''})</span>
                <span>{acres.toFixed(1)} ac</span>
              </div>
              {hasCorner && cornerAcres < 0 && (
                <div style={{ fontSize: '11px', color: '#A32D2D', marginTop: '8px' }}>
                  The pivot alone covers more than the AgWorld total. Check the pivot length in BaseStation and the field acres in AgWorld.
                </div>
              )}
              {hasCorner && cornerAcres >= 0 && cornerLengthSaved == null && (
                <div style={{ fontSize: '11px', color: '#888', marginTop: '8px' }}>Enter the corner machine length above to finish setting this up.</div>
              )}
              {!hasCorner && cornerAcres > Math.max(3, acres * 0.12) && (
                <div style={{ fontSize: '11px', color: '#854F0B', marginTop: '8px' }}>
                  AgWorld shows {cornerAcres.toFixed(1)} ac more than the pivot circle covers. If this pivot has a corner machine, select Yes.
                </div>
              )}
              {!hasCorner && cornerAcres < -Math.max(3, acres * 0.12) && (
                <div style={{ fontSize: '11px', color: '#854F0B', marginTop: '8px' }}>
                  The pivot circle covers {(-cornerAcres).toFixed(1)} ac more than AgWorld shows. Check the pivot length in BaseStation.
                </div>
              )}
            </>
          )}
        </div>
        <div style={{ fontSize: '10px', color: '#888', marginTop: '6px' }}>
          BaseStation's pivot length does not include a corner machine. Corner acres are the AgWorld total minus the acres under the pivot.
        </div>
      </Section>

      <Group title="Alerts" />

      <Section title="Stuck-pivot alert">
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input type="number" value={thresholdInput} onChange={(e) => setThresholdInput(e.target.value)} style={{ width: '100px' }} />
          <span style={{ fontSize: '13px', color: '#555' }}>min</span>
          <button onClick={handleSaveThreshold}>{thresholdSaved ? 'Saved!' : 'Save'}</button>
        </div>
        <div style={{ fontSize: '10px', color: '#888', marginTop: '6px' }}>Alert if running wet with no movement for this long (45&ndash;120 min)</div>
      </Section>

      <Group title="Audits" />

      <Section title={`Full audit \u2014 ${currentSeasonName || '\u2014'}`}>
        {baseline ? (
          <div style={{ background: '#f4f2ec', borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ fontSize: '13px', fontWeight: 600, color: '#2b2b26' }}>{baseline.lapTimeHours} hr baseline set</div>
            <div style={{ fontSize: '10px', color: '#888', marginTop: '2px' }}>
              Completed {new Date(baseline.completedAt).toLocaleDateString()} &middot; {baseline.acres.toFixed(1)} ac &middot; {baseline.requiredHours}-hr run
            </div>
          </div>
        ) : (
          <div style={{ background: '#FBEAEA', border: '1px solid #E8B4B4', borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, color: '#A32D2D' }}>Not completed this season</div>
            <div style={{ fontSize: '11px', color: '#8A3636', marginTop: '4px' }}>
              {acres != null
                ? `This pivot covers ${acres.toFixed(1)} ac, so it needs a ${requiredHours}-hr run at constant speed and direction to set this year's baseline.`
                : "Needs a long constant-speed run to set this year's baseline."}
            </div>
            {episode && baselineProgressPct != null && (
              <>
                <div style={{ fontSize: '11px', color: '#8A3636', marginTop: '8px' }}>In progress: {episodeElapsedHours.toFixed(1)} of {requiredHours} hrs so far</div>
                <div style={{ height: '6px', background: '#F0C4C4', borderRadius: '3px', marginTop: '6px', overflow: 'hidden' }}>
                  <div style={{ width: `${baselineProgressPct}%`, height: '100%', background: '#A32D2D' }} />
                </div>
              </>
            )}
          </div>
        )}
      </Section>

      <Section title="Live lap-time audit">
        <div style={{ background: hasDrift ? '#FBF3E2' : '#f4f2ec', border: hasDrift ? '1px solid #F0D9A8' : 'none', borderRadius: '8px', padding: '10px 12px' }}>
          {profile && profile.currentLapTimeHours != null ? (
            <>
              <div style={{ fontSize: '18px', fontWeight: 600, color: hasDrift ? '#854F0B' : '#2b2b26' }}>
                {profile.currentLapTimeHours} hr <span style={{ fontSize: '11px', fontWeight: 400, color: '#888' }}>at 100% timer</span>
              </div>
              <div style={{ fontSize: '11px', color: hasDrift ? '#6B4108' : '#888', marginTop: '4px' }}>
                {profile.currentLapTimeIsLive
                  ? 'Live \u2014 still measuring, same run continuing'
                  : `Last measured ${profile.currentLapTimeUpdatedAt ? new Date(profile.currentLapTimeUpdatedAt).toLocaleDateString() : ''}`}
                {hasDrift && baseline && ` \u2014 more than 10% off this season's ${baseline.lapTimeHours} hr baseline`}
              </div>
            </>
          ) : (
            <div style={{ fontSize: '12px', color: '#888' }}>No audit result yet &mdash; needs 3 hrs at a constant speed and direction.</div>
          )}
          {episode && episodeElapsedHours != null && episodeElapsedHours < 3 && (
            <div style={{ fontSize: '11px', color: '#888', marginTop: '8px' }}>Auditing now: {episodeElapsedHours.toFixed(1)} of 3 hrs so far</div>
          )}
        </div>
      </Section>

      <Group title="Water use" />

      <Section title="Wet / dry hours">
        <div style={{ display: 'flex', gap: '10px', marginBottom: '8px' }}>
          <div style={{ flex: 1, background: '#f4f2ec', borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ fontSize: '10px', color: '#888', marginBottom: '2px' }}>Wet hours</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: '#2b2b26' }}>{wetHours.toFixed(1)} hr</div>
          </div>
          <div style={{ flex: 1, background: '#f4f2ec', borderRadius: '8px', padding: '10px 12px' }}>
            <div style={{ fontSize: '10px', color: '#888', marginBottom: '2px' }}>Dry hours</div>
            <div style={{ fontSize: '18px', fontWeight: 600, color: '#2b2b26' }}>{dryHours.toFixed(1)} hr</div>
          </div>
        </div>
        {wetDryTrackingSince && (
          <div style={{ fontSize: '10px', color: '#888', marginBottom: '8px' }}>Tracking since {new Date(wetDryTrackingSince).toLocaleDateString()}</div>
        )}
        <button onClick={() => setShowResetConfirm(true)} style={{ fontSize: '12px' }}>Reset wet/dry hours</button>
        <div style={{ fontSize: '10px', color: '#888', marginTop: '6px' }}>
          Counts hours the pivot is running with water on (wet) or running with water off (dry). Time stopped doesn't count toward either.
        </div>
      </Section>

      {error && <p style={{ color: '#A32D2D', fontSize: '13px', marginTop: '16px' }}>{error}</p>}

      {showResetConfirm && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div style={{ background: '#fff', borderRadius: '10px', padding: '20px', width: '300px', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px', color: '#2b2b26' }}>Reset wet/dry hours?</div>
            <div style={{ fontSize: '13px', color: '#555', lineHeight: 1.5, marginBottom: '16px' }}>
              This sets {(pivot && pivot.name) || 'this pivot'}'s wet hours ({wetHours.toFixed(1)}) and dry hours ({dryHours.toFixed(1)}) back to zero. This can't be undone.
            </div>
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => setShowResetConfirm(false)} style={{ fontSize: '13px' }}>Cancel</button>
              <button onClick={handleResetWetDry} style={{ fontSize: '13px', background: '#FBEAEA', border: '1px solid #E8B4B4', color: '#A32D2D' }}>Reset</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
