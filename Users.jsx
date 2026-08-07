import { useState, useEffect, useMemo, Fragment } from 'react'
import { httpsCallable } from 'firebase/functions'
import { collection, onSnapshot, doc, updateDoc, deleteField } from 'firebase/firestore'
import { sendPasswordResetEmail } from 'firebase/auth'
import { auth, db, functions } from './firebase.js'

const ROLE_LABELS = {
  admin: 'Admin',
  owner: 'Owner',
  farm_manager: 'Farm manager',
  irrigation_manager: 'Irrigation manager',
  irrigator: 'Irrigator'
}
const FARM_SCOPED_ROLES = ['farm_manager', 'irrigation_manager', 'irrigator']

const EMPTY_FORM = { name: '', email: '', role: 'irrigator', farmIds: [], canEditSchedule: false }

function ProfileForm({ initial, farms, emailEditable, submitLabel, onCancel, onSubmit }) {
  const [form, setForm] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const farmScoped = FARM_SCOPED_ROLES.includes(form.role)

  function toggleFarm(farmId) {
    setForm((f) => {
      const has = f.farmIds.includes(farmId)
      return { ...f, farmIds: has ? f.farmIds.filter((id) => id !== farmId) : [...f.farmIds, farmId] }
    })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    if (farmScoped && form.farmIds.length === 0) {
      setError('Pick at least one farm for this role.')
      return
    }
    setBusy(true)
    try {
      await onSubmit(form)
    } catch (err) {
      setError(err.message || 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="editor-panel" style={{ maxWidth: '420px' }}>
      <div className="editor-label">Name</div>
      <input
        type="text"
        value={form.name}
        onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        required
        style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #ccc', marginBottom: '10px' }}
      />
      <div className="editor-label">Email</div>
      <input
        type="email"
        value={form.email}
        onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
        required
        disabled={!emailEditable}
        style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #ccc', marginBottom: '10px', background: emailEditable ? '#fff' : '#f4f2ec', color: emailEditable ? '#000' : '#888' }}
      />
      <div className="editor-label">Role</div>
      <select
        value={form.role}
        onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))}
        style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #ccc', marginBottom: '10px' }}
      >
        {Object.entries(ROLE_LABELS).map(([val, label]) => (
          <option key={val} value={val}>{label}</option>
        ))}
      </select>
      {farmScoped && (
        <>
          <div className="editor-label">Assigned farms</div>
          <div style={{ maxHeight: '180px', overflowY: 'auto', border: '1px solid #ddd8cc', borderRadius: '8px', padding: '8px 10px', marginBottom: '4px' }}>
            {farms.map((farm) => (
              <label key={farm.id} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', padding: '4px 0' }}>
                <input type="checkbox" checked={form.farmIds.includes(farm.id)} onChange={() => toggleFarm(farm.id)} style={{ margin: 0 }} />
                {farm.name}
              </label>
            ))}
          </div>
          <p style={{ fontSize: '11px', color: '#888', margin: '0 0 12px' }}>
            {form.role === 'irrigator'
              ? 'They can only see these farms. First one checked is their default view.'
              : "They can edit these farms; they can still view every other farm, just can't edit it. First one checked is their default view."}
          </p>
        </>
      )}
      {form.role === 'irrigator' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '10px 12px', background: '#f4f2ec', borderRadius: '8px', marginBottom: '14px' }}>
          <input
            type="checkbox"
            id="canEditSchedule"
            checked={form.canEditSchedule}
            onChange={(e) => setForm((f) => ({ ...f, canEditSchedule: e.target.checked }))}
            style={{ margin: 0 }}
          />
          <label htmlFor="canEditSchedule" style={{ fontSize: '12px' }}>Allow this person to edit the irrigation schedule</label>
        </div>
      )}
      {error && <p style={{ color: '#A32D2D', fontSize: '13px', margin: '0 0 10px' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '8px' }}>
        <button type="submit" className="save" disabled={busy} style={{ flex: 1 }}>{busy ? 'Saving\u2026' : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>}
      </div>
    </form>
  )
}

export default function Users() {
  const [farms, setFarms] = useState([])
  const [users, setUsers] = useState([])
  const [adding, setAdding] = useState(false)
  const [editingUid, setEditingUid] = useState(null)
  const [notice, setNotice] = useState(null)
  const [lastLink, setLastLink] = useState(null)
  const [copiedKey, setCopiedKey] = useState(null)
  const [busyUid, setBusyUid] = useState(null)

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'farms'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setFarms(list)
    })
    return () => unsub()
  }, [])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'users'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ uid: d.id, ...d.data() }))
      list.sort((a, b) => (a.name || a.email || '').localeCompare(b.name || b.email || ''))
      setUsers(list)
    })
    return () => unsub()
  }, [])

  const farmNameById = useMemo(() => {
    const map = {}
    farms.forEach((f) => { map[f.id] = f.name })
    return map
  }, [farms])

  async function handleCreate(form) {
    const createUser = httpsCallable(functions, 'createUser')
    const result = await createUser({
      name: form.name,
      email: form.email.trim(),
      role: form.role,
      farmIds: form.farmIds,
      canEditSchedule: form.canEditSchedule
    })
    let emailSent = true
    try {
      await sendPasswordResetEmail(auth, form.email.trim())
    } catch {
      emailSent = false
    }
    setAdding(false)
    setLastLink({ name: form.name, email: form.email.trim(), link: result.data && result.data.link, emailSent })
  }

  async function handleSaveEdit(uid, form) {
    const update = { name: form.name, role: form.role }
    if (FARM_SCOPED_ROLES.includes(form.role)) {
      update.farmIds = form.farmIds
    } else {
      update.farmIds = deleteField()
    }
    if (form.role === 'irrigator') {
      update.canEditSchedule = form.canEditSchedule
    } else {
      update.canEditSchedule = deleteField()
    }
    await updateDoc(doc(db, 'users', uid), update)
    setEditingUid(null)
  }

  async function copyToClipboard(text, key) {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      window.prompt('Copy this link:', text)
    }
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(null), 2000)
  }

  async function handleGetLink(user) {
    setBusyUid(user.uid)
    try {
      const generateSetupLink = httpsCallable(functions, 'generateSetupLink')
      const result = await generateSetupLink({ email: user.email })
      await copyToClipboard(result.data.link, user.uid)
    } catch (err) {
      setNotice(err.message || 'Could not generate a link for that account.')
    } finally {
      setBusyUid(null)
    }
  }

  async function handleToggleDisabled(user) {
    setBusyUid(user.uid)
    try {
      const setUserDisabled = httpsCallable(functions, 'setUserDisabled')
      await setUserDisabled({ uid: user.uid, disabled: !user.disabled })
    } catch (err) {
      setNotice(err.message || 'Could not update that account.')
    } finally {
      setBusyUid(null)
    }
  }

  async function handleResend(user) {
    setBusyUid(user.uid)
    try {
      await sendPasswordResetEmail(auth, user.email)
      setNotice(`Setup email re-sent to ${user.email}.`)
    } catch (err) {
      setNotice(err.message || 'Could not send that email.')
    } finally {
      setBusyUid(null)
    }
  }

  function farmSummary(user) {
    if (!FARM_SCOPED_ROLES.includes(user.role)) return 'All farms'
    if (!user.farmIds || user.farmIds.length === 0) return '\u2014'
    return user.farmIds.map((id) => farmNameById[id] || id).join(', ')
  }

  function scheduleAccessSummary(user) {
    if (!FARM_SCOPED_ROLES.includes(user.role)) return 'Edit'
    if (user.role === 'farm_manager' || user.role === 'irrigation_manager') return 'Edit (own), view (rest)'
    return user.canEditSchedule ? 'Edit' : 'View only'
  }

  return (
    <div style={{ padding: '16px 24px', maxWidth: '900px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '18px' }}>Team</h2>
        {!adding && <button className="save" onClick={() => setAdding(true)}>Add team member</button>}
      </div>

      {notice && (
        <div className="mode-bar" style={{ background: '#3c5a3f' }}>
          {notice}
          <div className="mode-bar-actions"><button className="cancel" onClick={() => setNotice(null)}>Dismiss</button></div>
        </div>
      )}

      {lastLink && (
        <div className="mode-bar" style={{ background: '#3c5a3f' }}>
          <div>
            {lastLink.name}'s account is ready.{' '}
            {lastLink.emailSent
              ? `An email was sent to ${lastLink.email} \u2014 if it doesn't show up, it may have landed in junk.`
              : "The automatic email didn't go out."}
            {' '}Safer bet: copy the link below and send it yourself (text, WhatsApp, or an email from your own address).
          </div>
          <div className="mode-bar-actions">
            {lastLink.link && (
              <button className="apply" onClick={() => copyToClipboard(lastLink.link, 'last')}>
                {copiedKey === 'last' ? 'Copied!' : 'Copy setup link'}
              </button>
            )}
            <button className="cancel" onClick={() => setLastLink(null)}>Dismiss</button>
          </div>
        </div>
      )}

      {adding && (
        <div style={{ marginBottom: '20px' }}>
          <ProfileForm
            initial={EMPTY_FORM}
            farms={farms}
            emailEditable
            submitLabel="Create account"
            onCancel={() => setAdding(false)}
            onSubmit={handleCreate}
          />
        </div>
      )}

      <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#888', fontSize: '11px' }}>
            <th style={{ padding: '6px 8px' }}>Name</th>
            <th style={{ padding: '6px 8px' }}>Role</th>
            <th style={{ padding: '6px 8px' }}>Farms</th>
            <th style={{ padding: '6px 8px' }}>Schedule access</th>
            <th style={{ padding: '6px 8px' }}></th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <Fragment key={user.uid}>
              <tr style={{ borderTop: '1px solid #eee', opacity: user.disabled ? 0.5 : 1 }}>
                <td style={{ padding: '8px' }}>
                  <div style={{ fontWeight: 600 }}>{user.name || '\u2014'}</div>
                  <div style={{ fontSize: '11px', color: '#888' }}>{user.email}{user.disabled ? ' \u00b7 disabled' : ''}</div>
                </td>
                <td style={{ padding: '8px' }}>{ROLE_LABELS[user.role] || user.role}</td>
                <td style={{ padding: '8px', color: '#666' }}>{farmSummary(user)}</td>
                <td style={{ padding: '8px', color: '#666' }}>{scheduleAccessSummary(user)}</td>
                <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button onClick={() => setEditingUid(editingUid === user.uid ? null : user.uid)} style={{ marginRight: '6px' }}>
                    {editingUid === user.uid ? 'Close' : 'Edit'}
                  </button>
                  <button onClick={() => handleResend(user)} disabled={busyUid === user.uid} style={{ marginRight: '6px' }}>Resend setup email</button>
                  <button onClick={() => handleGetLink(user)} disabled={busyUid === user.uid} style={{ marginRight: '6px' }}>
                    {copiedKey === user.uid ? 'Copied!' : 'Copy setup link'}
                  </button>
                  <button onClick={() => handleToggleDisabled(user)} disabled={busyUid === user.uid}>
                    {user.disabled ? 'Enable' : 'Disable'}
                  </button>
                </td>
              </tr>
              {editingUid === user.uid && (
                <tr>
                  <td colSpan={5} style={{ padding: '12px 8px' }}>
                    <ProfileForm
                      initial={{
                        name: user.name || '',
                        email: user.email || '',
                        role: user.role || 'irrigator',
                        farmIds: user.farmIds || [],
                        canEditSchedule: !!user.canEditSchedule
                      }}
                      farms={farms}
                      emailEditable={false}
                      submitLabel="Save changes"
                      onCancel={() => setEditingUid(null)}
                      onSubmit={(form) => handleSaveEdit(user.uid, form)}
                    />
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {users.length === 0 && <p style={{ color: '#888', padding: '1rem 0' }}>No team members yet.</p>}
    </div>
  )
}
