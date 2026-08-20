import { useState, useEffect } from 'react'
import { doc, onSnapshot, setDoc } from 'firebase/firestore'
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage'
import { db, storage } from './firebase.js'
import PivotIcon from './PivotIcon.jsx'

export default function PivotProfile({ pivotGuid, onBack }) {
  const [pivot, setPivot] = useState(null)
  const [profile, setProfile] = useState(null)
  const [gpmInput, setGpmInput] = useState('')
  const [threshold, setThreshold] = useState(30)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState(null)
  const [gpmSaved, setGpmSaved] = useState(false)

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
      setThreshold(data && data.stuckAlertThresholdMinutes != null ? data.stuckAlertThresholdMinutes : 30)
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

  async function handleThresholdChange(minutes) {
    setThreshold(minutes)
    await setDoc(doc(db, 'pivotProfiles', pivotGuid), { stuckAlertThresholdMinutes: minutes }, { merge: true })
  }

  if (!pivotGuid) return null

  const pkg = profile && profile.sprinklerPackage
  const historyCount = (profile && profile.sprinklerPackageHistory && profile.sprinklerPackageHistory.length) || 0

  return (
    <div style={{ padding: '16px 24px', maxWidth: '480px' }}>
      <button onClick={onBack} style={{ marginBottom: '16px' }}>&larr; Back</button>

      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px', paddingBottom: '14px', borderBottom: '1px solid #eee' }}>
        <PivotIcon pivot={pivot} size={44} />
        <div>
          <div style={{ fontSize: '16px', fontWeight: 600 }}>{(pivot && pivot.name) || 'Pivot'}</div>
          <div style={{ fontSize: '11px', color: '#888' }}>Pivot profile</div>
        </div>
      </div>

      <div style={{ marginBottom: '24px' }}>
        <div className="editor-label" style={{ marginBottom: '8px' }}>Sprinkler package</div>
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
      </div>

      <div style={{ marginBottom: '24px' }}>
        <div className="editor-label" style={{ marginBottom: '8px' }}>Current GPM</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input type="number" value={gpmInput} onChange={(e) => setGpmInput(e.target.value)} style={{ width: '100px' }} />
          <span style={{ fontSize: '13px', color: '#555' }}>GPM</span>
          <button onClick={handleSaveGpm}>{gpmSaved ? 'Saved!' : 'Save'}</button>
        </div>
        <div style={{ fontSize: '10px', color: '#888', marginTop: '6px' }}>Used for this pivot's scheduled-inches calculation</div>
      </div>

      <div>
        <div className="editor-label" style={{ marginBottom: '8px' }}>Stuck-pivot alert</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <input
            type="range"
            min="30"
            max="120"
            step="5"
            value={threshold}
            onChange={(e) => handleThresholdChange(Number(e.target.value))}
            style={{ flex: 1 }}
          />
          <span style={{ fontSize: '13px', fontWeight: 500, minWidth: '70px' }}>{threshold} min</span>
        </div>
        <div style={{ fontSize: '10px', color: '#888', marginTop: '6px' }}>Alert if running wet with no movement for this long</div>
      </div>

      {error && <p style={{ color: '#A32D2D', fontSize: '13px', marginTop: '16px' }}>{error}</p>}
    </div>
  )
}
