import { useState, useEffect, useMemo, Fragment } from 'react'
import { httpsCallable } from 'firebase/functions'
import { collection, onSnapshot, doc, updateDoc, deleteField, getDoc, getDocs } from 'firebase/firestore'
import { sendPasswordResetEmail } from 'firebase/auth'
import { auth, db, functions } from './firebase.js'
import { customerKey } from './customerKey.js'

const ROLE_LABELS = {
  admin: 'Admin',
  owner: 'Owner',
  farm_manager: 'Farm manager',
  irrigation_manager: 'Irrigation manager',
  irrigator: 'Irrigator',
  customer: 'Customer'
}
const FARM_SCOPED_ROLES = ['farm_manager', 'irrigation_manager', 'irrigator']
// Which AIO modules a person can use. Ids must match firestore.rules'
// hasModule() and App.jsx's hasModule(). Admin/Owner always get everything,
// so the checklist is hidden for them. A profile with no `modules` list means
// "everything their role already allows" — so all boxes checked is saved as
// no list at all, not as a list of every module.
const MODULES = [
  { id: 'irrigation', label: 'Irrigation' },
  { id: 'potato-storage', label: 'Potato storage' },
  { id: 'agronomy', label: 'Agronomy', note: 'Only Admin, Owner and Farm manager roles can ever see this one.' }
]
const ALL_MODULE_IDS = MODULES.map((m) => m.id)
const FULL_ACCESS_ROLES = ['admin', 'owner']
// Customers are outside staff modules entirely: they get a read-only portal
// limited to the customer names linked to their login (customers/customerKeys).
const CUSTOMER_ROLE = 'customer'
function modulesToSave(role, modules) {
  if (FULL_ACCESS_ROLES.includes(role)) return null
  const allChecked = ALL_MODULE_IDS.every((id) => modules.includes(id))
  return allChecked ? null : modules
}

const EMPTY_FORM = { name: '', email: '', phone: '', receiveTextAlerts: true, role: 'irrigator', farmIds: [], canEditSchedule: false, modules: ALL_MODULE_IDS, customers: [] }

function ProfileForm({ initial, farms, customerRoster, emailEditable, submitLabel, onCancel, onSubmit }) {
  const [form, setForm] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const farmScoped = FARM_SCOPED_ROLES.includes(form.role)

  function toggleCustomer(name) {
    setForm((f) => ({ ...f, customers: f.customers.includes(name) ? f.customers.filter((c) => c !== name) : [...f.customers, name] }))
  }

  function toggleModule(id) {
    setForm((f) => ({ ...f, modules: f.modules.includes(id) ? f.modules.filter((m) => m !== id) : [...f.modules, id] }))
  }

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
    if (form.role === CUSTOMER_ROLE && form.customers.length === 0) {
      setError('Pick at least one customer for this login to see.')
      return
    }
    if (!FULL_ACCESS_ROLES.includes(form.role) && form.role !== CUSTOMER_ROLE && form.modules.length === 0) {
      setError('Pick at least one module, or this person will have nothing to open.')
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
      <div className="editor-label">Phone (optional)</div>
      <input
        type="tel"
        value={form.phone}
        onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
        placeholder="(208) 555-0123"
        style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #ccc', marginBottom: '10px' }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '14px' }}>
        <input
          type="checkbox"
          id="receiveTextAlerts"
          checked={form.receiveTextAlerts}
          onChange={(e) => setForm((f) => ({ ...f, receiveTextAlerts: e.target.checked }))}
          disabled={!form.phone}
          style={{ margin: 0 }}
        />
        <label htmlFor="receiveTextAlerts" style={{ fontSize: '12px', color: form.phone ? '#000' : '#888' }}>
          Send text alerts to this number{!form.phone && ' (add a phone number first)'}
        </label>
      </div>
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
      {form.role === CUSTOMER_ROLE && (
        <>
          <div className="editor-label">Customers this login can see</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '6px' }}>
            {customerRoster.map((name) => (
              <label key={name} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input type="checkbox" checked={form.customers.includes(name)} onChange={() => toggleCustomer(name)} style={{ margin: 0 }} />
                {name}
              </label>
            ))}
            {customerRoster.length === 0 && <span style={{ fontSize: '12px', color: '#888' }}>No customers found — add them in Potato Storage first.</span>}
          </div>
          <p style={{ fontSize: '11px', color: '#888', margin: '0 0 12px' }}>
            This login sees only these customers' fields, loads shipped from them, Sprout Nip applications, pile temperatures and fill/empty dates — nothing else in AIO. Pick more than one if a buyer has several names (e.g. Mart Fresh and Mart Frozen).
          </p>
        </>
      )}
      {!FULL_ACCESS_ROLES.includes(form.role) && form.role !== CUSTOMER_ROLE && (
        <>
          <div className="editor-label">Modules</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: '6px' }}>
            {MODULES.map((m) => (
              <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
                <input type="checkbox" checked={form.modules.includes(m.id)} onChange={() => toggleModule(m.id)} style={{ margin: 0 }} />
                {m.label}
              </label>
            ))}
          </div>
          <p style={{ fontSize: '11px', color: '#888', margin: '0 0 12px' }}>
            Unchecked modules are hidden and blocked at the database level. All checked means full access, including any module added later.
            {form.modules.includes('agronomy') && form.role !== 'farm_manager' ? ' Agronomy still needs the Farm manager role.' : ''}
          </p>
        </>
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
  const [customerRoster, setCustomerRoster] = useState([])
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

  // Customer names for the Customer role's checklist. The roster lives in
  // Potato Storage's own data (one JSON-encoded doc); if it was never saved
  // (the app is still on its built-in defaults), fall back to the names of any
  // customer views that have already been published.
  useEffect(() => {
    let cancelled = false
    async function loadRoster() {
      let names = []
      try {
        const snap = await getDoc(doc(db, 'potatoStorage', 'norland-customers-v2'))
        if (snap.exists()) {
          const parsed = JSON.parse(snap.data().value)
          if (Array.isArray(parsed)) names = parsed
        }
        if (names.length === 0) {
          const views = await getDocs(collection(db, 'customerViews'))
          views.forEach((d) => { if (d.data().customer) names.push(d.data().customer) })
        }
      } catch {
        // leave empty — the form says to add customers in Potato Storage first
      }
      if (!cancelled) setCustomerRoster(names.slice().sort((a, b) => a.localeCompare(b)))
    }
    loadRoster()
    return () => { cancelled = true }
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
      phone: form.phone.trim(),
      receiveTextAlerts: !!form.phone && !!form.receiveTextAlerts,
      role: form.role,
      farmIds: form.farmIds,
      canEditSchedule: form.canEditSchedule
    })
    // createUser doesn't know about modules, so set them right after — an
    // Admin/Owner session is allowed to write any users doc under the rules.
    const newModules = modulesToSave(form.role, form.modules)
    if (form.role === CUSTOMER_ROLE && result.data && result.data.uid) {
      await updateDoc(doc(db, 'users', result.data.uid), { customers: form.customers, customerKeys: form.customers.map(customerKey) })
    } else if (newModules && result.data && result.data.uid) {
      await updateDoc(doc(db, 'users', result.data.uid), { modules: newModules })
    }
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
    const update = {
      name: form.name,
      role: form.role,
      phone: form.phone.trim(),
      receiveTextAlerts: !!form.phone && !!form.receiveTextAlerts
    }
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
    const savedModules = form.role === CUSTOMER_ROLE ? null : modulesToSave(form.role, form.modules)
    update.modules = savedModules ? savedModules : deleteField()
    if (form.role === CUSTOMER_ROLE) {
      update.customers = form.customers
      update.customerKeys = form.customers.map(customerKey)
    } else {
      update.customers = deleteField()
      update.customerKeys = deleteField()
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
    if (user.role === CUSTOMER_ROLE) return '\u2014'
    if (!FARM_SCOPED_ROLES.includes(user.role)) return 'All farms'
    if (!user.farmIds || user.farmIds.length === 0) return '\u2014'
    return user.farmIds.map((id) => farmNameById[id] || id).join(', ')
  }

  function moduleSummary(user) {
    if (user.role === CUSTOMER_ROLE) return `Customer portal: ${(user.customers || []).join(', ') || '\u2014'}`
    if (FULL_ACCESS_ROLES.includes(user.role) || !Array.isArray(user.modules)) return 'All'
    if (user.modules.length === 0) return 'None'
    return MODULES.filter((m) => user.modules.includes(m.id)).map((m) => m.label).join(', ')
  }

  function scheduleAccessSummary(user) {
    if (user.role === CUSTOMER_ROLE) return '\u2014'
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
            customerRoster={customerRoster}
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
            <th style={{ padding: '6px 8px' }}>Phone</th>
            <th style={{ padding: '6px 8px' }}>Role</th>
            <th style={{ padding: '6px 8px' }}>Farms</th>
            <th style={{ padding: '6px 8px' }}>Schedule access</th>
            <th style={{ padding: '6px 8px' }}>Modules</th>
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
                <td style={{ padding: '8px', color: '#666' }}>
                  {user.phone || '\u2014'}
                  {user.phone && <div style={{ fontSize: '10px', color: '#888' }}>Texts {user.receiveTextAlerts !== false ? 'on' : 'off'}</div>}
                </td>
                <td style={{ padding: '8px' }}>{ROLE_LABELS[user.role] || user.role}</td>
                <td style={{ padding: '8px', color: '#666' }}>{farmSummary(user)}</td>
                <td style={{ padding: '8px', color: '#666' }}>{scheduleAccessSummary(user)}</td>
                <td style={{ padding: '8px', color: '#666' }}>{moduleSummary(user)}</td>
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
                  <td colSpan={7} style={{ padding: '12px 8px' }}>
                    <ProfileForm
                      initial={{
                        name: user.name || '',
                        email: user.email || '',
                        phone: user.phone || '',
                        receiveTextAlerts: user.receiveTextAlerts !== false,
                        role: user.role || 'irrigator',
                        farmIds: user.farmIds || [],
                        canEditSchedule: !!user.canEditSchedule,
                        modules: Array.isArray(user.modules) ? user.modules : ALL_MODULE_IDS,
                        customers: user.customers || []
                      }}
                      farms={farms}
                      customerRoster={customerRoster}
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
