import { useState, useEffect, useMemo, useRef, Fragment } from 'react'
import { httpsCallable } from 'firebase/functions'
import { collection, onSnapshot, doc, updateDoc, deleteField, getDoc, getDocs } from 'firebase/firestore'
import { sendPasswordResetEmail } from 'firebase/auth'
import { auth, db, functions } from './firebase.js'
import { customerKey } from './customerKey.js'

const ROLE_LABELS = {
  admin: 'Admin',
  owner: 'Owner',
  farm_manager: 'Farm manager',
  operations: 'Operations',
  irrigation_manager: 'Irrigation manager',
  irrigator: 'Irrigator',
  trucking: 'Trucking',
  mart_produce: 'Mart Produce',
  planting_staff: 'Potato planting staff',
  customer: 'Customer'
}
// Operations (e.g. Robby) has a Farm manager's access (firestore.rules' myRole()); tick every farm.
const FARM_SCOPED_ROLES = ['farm_manager', 'operations', 'irrigation_manager', 'irrigator']
// Trucking and Mart Produce (fresh pack shed) see only their ticked modules. Their farms are optional:
// they're for alerts and for looking people up by farm (work orders), not for access.
const FARM_OPTIONAL_ROLES = ['trucking', 'mart_produce', 'admin', 'owner']
// A starting module list when one of these roles is picked (changeable with the boxes).
const ROLE_DEFAULT_MODULES = { mart_produce: ['potato-storage'], trucking: ['potato-storage', 'map'] }
// Phone-app alerts (same as the Spray schedule's field-done alerts; not texts). users/{uid}.alerts
const ALERT_CHOICES = {
  spray: [['', 'Off'], ['farms', 'Their farms'], ['all', 'All jobs'], ['spreads', 'Ag Rows spreads']],
  irrigation: [['', 'Off'], ['farms', 'Their farms'], ['all', 'All farms']]
}
const alertsSummary = (a) => {
  const t = (k) => (ALERT_CHOICES[k].find((c) => c[0] === ((a && a[k]) || '')) || ['', 'Off'])[1]
  return a && (a.spray || a.irrigation) ? 'Spray: ' + t('spray') + ' \u00b7 Irrigation: ' + t('irrigation') : ''
}
// Which AIO modules a person can use. Ids must match firestore.rules'
// hasModule() and App.jsx's hasModule(). Admin/Owner always get everything,
// so the checklist is hidden for them. A profile with no `modules` list means
// "everything their role already allows" — so all boxes checked is saved as
// no list at all, not as a list of every module.
const MODULES = [
  { id: 'irrigation', label: 'Irrigation' },
  { id: 'potato-storage', label: 'Potato storage' },
  { id: 'agronomy', label: 'Agronomy', note: 'Only Admin, Owner and Farm manager roles can ever see this one.' },
  { id: 'contracts', label: 'Contracts', note: 'The Contracts tab in Planning. Farm managers can view; only Admin and Owner can edit.' },
  { id: 'yields', label: 'Yield history', note: 'Farm managers can view; only Admin and Owner can import.' },
  { id: 'harvest', label: 'Operations', note: 'Planting, ground work and harvest schedules. Admin, Owner and Farm manager can build them and log progress.' },
  { id: 'seed', label: 'Potato seed', note: 'The Potato Seed tab in Planning (planting staff go straight to tickets). Ticket portals for anyone with it; contracts, edits and reports for Admin, Owner and Farm manager.' },
  { id: 'map', label: 'Farm map', note: 'Anyone with it can view; only Admin and Owner import and edit.' },
  { id: 'spray', label: 'Spray schedule', note: 'Drone + Ag Rows spray and spread jobs from AgWorld, shown as the Spray tab in Operations. Admin, Owner and Farm manager only; crews use their own links.' }
]
const ALL_MODULE_IDS = MODULES.map((m) => m.id)
const FULL_ACCESS_ROLES = ['admin', 'owner']
// Customers are outside staff modules entirely: they get a read-only portal
// limited to the customer names linked to their login (customers/customerKeys).
const CUSTOMER_ROLE = 'customer'
// Potato planting staff (drivers, cutter crew) only ever get the seed portals.
const PLANTING_ROLE = 'planting_staff'
function modulesToSave(role, modules) {
  if (FULL_ACCESS_ROLES.includes(role)) return null
  if (role === PLANTING_ROLE) return ['seed']
  const allChecked = ALL_MODULE_IDS.every((id) => modules.includes(id))
  return allChecked ? null : modules
}

const EMPTY_FORM = { name: '', email: '', phone: '', receiveTextAlerts: false, role: 'irrigator', farmIds: [], canEditSchedule: false, sprayAdmin: false, modules: ALL_MODULE_IDS, customers: [], alerts: { spray: '', irrigation: '' } }

function ProfileForm({ initial, farms, customerRoster, emailEditable, submitLabel, onCancel, onSubmit }) {
  const [form, setForm] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const farmScoped = FARM_SCOPED_ROLES.includes(form.role)
  const farmPick = farmScoped || FARM_OPTIONAL_ROLES.includes(form.role)
  const setAlert = (k, v) => setForm((f) => ({ ...f, alerts: { ...(f.alerts || {}), [k]: v } }))

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
    if (!FULL_ACCESS_ROLES.includes(form.role) && form.role !== CUSTOMER_ROLE && form.role !== PLANTING_ROLE && form.modules.length === 0) {
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
      {/* The text-message agreement is not shown when adding a new user; it stays on the edit form so an existing user's texts can still be turned off. */}
      {!emailEditable && (
        <>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: '8px', marginBottom: '6px' }}>
          <input
            type="checkbox"
            id="receiveTextAlerts"
            checked={!!form.phone && form.receiveTextAlerts === true}
            onChange={(e) => setForm((f) => ({ ...f, receiveTextAlerts: e.target.checked }))}
            disabled={!form.phone}
            style={{ margin: '2px 0 0 0', flexShrink: 0 }}
          />
          <label htmlFor="receiveTextAlerts" style={{ fontSize: '12px', lineHeight: 1.45, color: form.phone ? '#000' : '#888' }}>
            I agree to receive recurring text messages (SMS) from Jentzsch-Kearl Farms, a Tree Source company, at this
            number. The texts are internal irrigation and equipment alerts for farm staff only, for example when a pivot
            has stopped moving while running. Message frequency varies. Msg &amp; data rates may apply. Reply STOP to opt
            out, HELP for help. Agreeing is optional.{!form.phone && ' (Add a phone number first.)'}
          </label>
        </div>
        <div style={{ fontSize: '11px', color: '#888', margin: '0 0 14px 22px' }}>
          <a href="https://treesource.com/terms" target="_blank" rel="noopener noreferrer">Terms</a>
          {' \u00b7 '}
          <a href="https://treesource.com/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
        </div>
        </>
      )}
      <div className="editor-label">Role</div>
      <select
        value={form.role}
        onChange={(e) => { const role = e.target.value; setForm((f) => ({ ...f, role, ...(ROLE_DEFAULT_MODULES[role] ? { modules: ROLE_DEFAULT_MODULES[role] } : {}) })) }}
        style={{ width: '100%', padding: '8px', borderRadius: '8px', border: '1px solid #ccc', marginBottom: '10px' }}
      >
        {Object.entries(ROLE_LABELS).map(([val, label]) => (
          <option key={val} value={val}>{label}</option>
        ))}
      </select>
      {farmPick && (
        <>
          <div className="editor-label" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span>{farmScoped ? 'Assigned farms' : 'Their farms (optional)'}</span>
            <button type="button" onClick={() => setForm((f) => ({ ...f, farmIds: f.farmIds.length === farms.length ? [] : farms.map((x) => x.id) }))} style={{ fontSize: '11px', padding: '2px 8px' }}>{form.farmIds.length === farms.length ? 'Clear' : 'All farms'}</button>
          </div>
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
              : FULL_ACCESS_ROLES.includes(form.role) ? 'Doesn\'t limit anything. Makes them the farm manager on these farms\' spray jobs (name, Call button, shown first) and sets their "Their farms" alerts.'
              : !farmScoped ? 'Doesn\'t limit what they see (that\'s the modules below). Used for "Their farms" alerts and for finding who covers a farm (work orders).'
                : form.role === 'operations' ? 'Operations works like a farm manager on these farms; tick All farms for the whole operation.'
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
      {form.role === PLANTING_ROLE && (
        <p style={{ fontSize: '11px', color: '#888', margin: '0 0 12px' }}>
          Potato planting staff open straight into the seed ticket portals (pickup, unload at cutter, cut seed, field unload) and nothing else in AIO.
        </p>
      )}
      {!FULL_ACCESS_ROLES.includes(form.role) && form.role !== CUSTOMER_ROLE && form.role !== PLANTING_ROLE && (
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
      {form.role !== CUSTOMER_ROLE && form.role !== PLANTING_ROLE && (FULL_ACCESS_ROLES.includes(form.role) || form.modules.includes('spray')) && (
            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', margin: '0 0 12px' }}>
              <input type="checkbox" checked={!!form.sprayAdmin} onChange={(e) => setForm((f) => ({ ...f, sprayAdmin: e.target.checked }))} style={{ margin: 0 }} />
              Spray schedule admin <span style={{ fontSize: '11px', color: '#888' }}>(assign operators, Done, move and remove jobs, crew list). Nobody else can, Admin and Owner included; they can view.</span>
            </label>
          )}
      {form.role !== CUSTOMER_ROLE && form.role !== PLANTING_ROLE && (
        <>
          <div className="editor-label">Phone alerts</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 10px', alignItems: 'center', fontSize: '13px', marginBottom: '4px' }}>
            <span>Spray schedule</span>
            <select value={(form.alerts && form.alerts.spray) || ''} onChange={(e) => setAlert('spray', e.target.value)} style={{ padding: '6px', borderRadius: '8px', border: '1px solid #ccc' }}>
              {ALERT_CHOICES.spray.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <span>Irrigation</span>
            <select value={(form.alerts && form.alerts.irrigation) || ''} onChange={(e) => setAlert('irrigation', e.target.value)} style={{ padding: '6px', borderRadius: '8px', border: '1px solid #ccc' }}>
              {ALERT_CHOICES.irrigation.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <p style={{ fontSize: '11px', color: '#888', margin: '0 0 12px' }}>
            Alerts on their phone through the AIO app (they turn them on once from the account menu). Spray: field done; "All jobs" also gets license, FAA, medical and drone warranty reminders. Irrigation: a pivot parked wet. "Their farms" uses the farms ticked above.
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

// Columns the team table can be sorted by (the filter boxes sit under the same headings).
const COLUMNS = [
  { key: 'name', label: 'Name' },
  { key: 'phone', label: 'Phone' },
  { key: 'role', label: 'Role' },
  { key: 'farms', label: 'Farms' },
  { key: 'sched', label: 'Schedule access' },
  { key: 'modules', label: 'Modules' }
]
const EMPTY_FILTERS = { name: '', phone: '', role: '', farm: '', sched: '', module: '', status: '' }
const CUSTOMER_PORTAL_FILTER = '__customer_portal'
const ALL_FARMS_FILTER = '__all_farms'

// Does this person have access to the module? (Same rule as the Modules column:
// admin/owner, or a profile with no list, get everything; customers get none.)
function userHasModule(user, moduleId) {
  if (user.role === CUSTOMER_ROLE) return false
  if (FULL_ACCESS_ROLES.includes(user.role) || !Array.isArray(user.modules)) return true
  return user.modules.includes(moduleId)
}

// The three-dot menu at the end of each row. Closes on a click anywhere else,
// on Escape, or after a choice.
function RowMenu({ label, items }) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef(null)
  useEffect(() => {
    if (!open) return undefined
    function onDown(e) { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false) }
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])
  return (
    <div ref={boxRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        style={{ padding: '2px 10px', fontSize: '18px', lineHeight: 1, fontWeight: 700 }}
      >{'\u22ef'}</button>
      {open && (
        <div role="menu" style={{ position: 'absolute', right: 0, top: '100%', marginTop: '4px', zIndex: 20, background: '#fff', border: '1px solid #ddd', borderRadius: '8px', boxShadow: '0 4px 14px rgba(0,0,0,0.14)', minWidth: '190px', padding: '4px 0', textAlign: 'left' }}>
          {items.filter(Boolean).map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              disabled={it.disabled}
              onClick={() => { setOpen(false); it.onClick() }}
              style={{ display: 'block', width: '100%', textAlign: 'left', padding: '8px 14px', fontSize: '13px', border: 'none', borderRadius: 0, background: 'transparent', color: it.danger ? '#A32D2D' : '#2b2b26', cursor: it.disabled ? 'default' : 'pointer', opacity: it.disabled ? 0.5 : 1 }}
            >{it.label}</button>
          ))}
        </div>
      )}
    </div>
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
  const [testNote, setTestNote] = useState(null)   // result of "Send test alert": { ok, text }
  const [sort, setSort] = useState({ key: 'name', dir: 'asc' })
  const [filters, setFilters] = useState(EMPTY_FILTERS)
  const [deleteTarget, setDeleteTarget] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)

  useEffect(() => {
    if (!deleteTarget) return undefined
    function onKey(e) { if (e.key === 'Escape' && !deleting) { setDeleteTarget(null); setDeleteError(null) } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [deleteTarget, deleting])

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
      await updateDoc(doc(db, 'users', result.data.uid), form.sprayAdmin ? { modules: newModules, sprayAdmin: true } : { modules: newModules })
    } else if (form.sprayAdmin && result.data && result.data.uid && form.role !== PLANTING_ROLE) {
      await updateDoc(doc(db, 'users', result.data.uid), { sprayAdmin: true })
    }
    // alerts, and farms for roles where farms are optional (createUser only stores farms for scoped roles)
    if (result.data && result.data.uid && form.role !== CUSTOMER_ROLE && form.role !== PLANTING_ROLE) {
      const extra = {}
      if (form.alerts && (form.alerts.spray || form.alerts.irrigation)) extra.alerts = { spray: form.alerts.spray || '', irrigation: form.alerts.irrigation || '' }
      if (FARM_OPTIONAL_ROLES.includes(form.role) && form.farmIds.length) extra.farmIds = form.farmIds.map(String)
      if (Object.keys(extra).length) await updateDoc(doc(db, 'users', result.data.uid), extra)
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
    if (FARM_SCOPED_ROLES.includes(form.role) || (FARM_OPTIONAL_ROLES.includes(form.role) && form.farmIds.length)) {
      update.farmIds = form.farmIds
    } else {
      update.farmIds = deleteField()
    }
    update.alerts = form.role !== CUSTOMER_ROLE && form.role !== PLANTING_ROLE && form.alerts && (form.alerts.spray || form.alerts.irrigation)
      ? { spray: form.alerts.spray || '', irrigation: form.alerts.irrigation || '' } : deleteField()
    if (form.role === 'irrigator') {
      update.canEditSchedule = form.canEditSchedule
    } else {
      update.canEditSchedule = deleteField()
    }
    const savedModules = form.role === CUSTOMER_ROLE ? null : modulesToSave(form.role, form.modules)
    update.modules = savedModules ? savedModules : deleteField()
    update.sprayAdmin = form.sprayAdmin && form.role !== CUSTOMER_ROLE && form.role !== PLANTING_ROLE ? true : deleteField()
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

  async function handleConfirmDelete() {
    if (!deleteTarget) return
    const who = deleteTarget.name || deleteTarget.email || 'That account'
    setDeleting(true)
    setDeleteError(null)
    try {
      const deleteUserAccount = httpsCallable(functions, 'deleteUserAccount')
      await deleteUserAccount({ uid: deleteTarget.uid })
      if (editingUid === deleteTarget.uid) setEditingUid(null)
      setDeleteTarget(null)
      setNotice(`${who} was deleted.`)
    } catch (err) {
      setDeleteError(err.message || 'Could not delete that account.')
    } finally {
      setDeleting(false)
    }
  }

  // One test alert to this person's phones (through the same app alerts the Spray schedule uses).
  async function handleTestAlert(user) {
    setBusyUid(user.uid); setTestNote(null)
    try {
      const r = (await httpsCallable(functions, 'sprayAlertLog', { timeout: 60000 })({ testUser: user.uid })).data
      const who = r.name || user.name || user.email
      setTestNote(r.phones
        ? { ok: true, text: `Test alert sent to ${who}'s ${r.phones === 1 ? 'phone' : r.phones + ' phones'}${r.sent < r.phones ? ` (${r.phones - r.sent} didn't take; that phone may need alerts turned on again)` : ''}. Ask them if it popped up.` }
        : { ok: false, text: `${who} hasn't turned on phone alerts yet. They open AIO on their phone, tap their initials (top right), then Turn on next to Phone alerts${(r.alerts && (r.alerts.spray || r.alerts.irrigation)) ? '' : '. Also switch on their Spray or Irrigation alerts here first'}.` })
    } catch (err) {
      setTestNote({ ok: false, text: 'Test alert failed: ' + (err.message || err) })
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
    if (FARM_OPTIONAL_ROLES.includes(user.role)) return (user.farmIds || []).length ? (FULL_ACCESS_ROLES.includes(user.role) ? 'All farms (manages ' : '') + user.farmIds.map((id) => farmNameById[id] || id).join(', ') + (FULL_ACCESS_ROLES.includes(user.role) ? ')' : '') : 'All farms'
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
    if (FARM_OPTIONAL_ROLES.includes(user.role) && !FULL_ACCESS_ROLES.includes(user.role)) return 'View only'
    if (!FARM_SCOPED_ROLES.includes(user.role)) return 'Edit'
    if (user.role === 'farm_manager' || user.role === 'operations' || user.role === 'irrigation_manager') return 'Edit (own), view (rest)'
    return user.canEditSchedule ? 'Edit' : 'View only'
  }

  function sortValue(user, key) {
    switch (key) {
      case 'name': return user.name || user.email || ''
      case 'phone': return user.phone || ''
      case 'role': return ROLE_LABELS[user.role] || user.role || ''
      case 'farms': return farmSummary(user)
      case 'sched': return scheduleAccessSummary(user)
      case 'modules': return moduleSummary(user)
      default: return ''
    }
  }

  function toggleSort(key) {
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }))
  }
  function setFilter(key, value) { setFilters((f) => ({ ...f, [key]: value })) }

  function matchesFilters(user) {
    const f = filters
    if (f.name) {
      const q = f.name.trim().toLowerCase()
      if (!`${user.name || ''} ${user.email || ''}`.toLowerCase().includes(q)) return false
    }
    if (f.phone) {
      const q = f.phone.trim()
      const digits = q.replace(/\D/g, '')
      const phone = user.phone || ''
      if (digits ? !phone.replace(/\D/g, '').includes(digits) : !phone.toLowerCase().includes(q.toLowerCase())) return false
    }
    if (f.role && user.role !== f.role) return false
    if (f.farm) {
      if (f.farm === ALL_FARMS_FILTER) {
        if (user.role === CUSTOMER_ROLE || FARM_SCOPED_ROLES.includes(user.role)) return false
      } else if (!((FARM_SCOPED_ROLES.includes(user.role) || FARM_OPTIONAL_ROLES.includes(user.role)) && (user.farmIds || []).includes(f.farm))) return false
    }
    if (f.sched && scheduleAccessSummary(user) !== f.sched) return false
    if (f.module) {
      if (f.module === CUSTOMER_PORTAL_FILTER) { if (user.role !== CUSTOMER_ROLE) return false }
      else if (!userHasModule(user, f.module)) return false
    }
    if (f.status === 'active' && user.disabled) return false
    if (f.status === 'disabled' && !user.disabled) return false
    return true
  }

  const anyFilter = Object.values(filters).some((v) => v)
  const shownUsers = users.filter(matchesFilters).sort((a, b) => {
    const av = sortValue(a, sort.key)
    const bv = sortValue(b, sort.key)
    // Blank cells always sink to the bottom, whichever way it's sorted.
    const aBlank = !av || av === '\u2014'
    const bBlank = !bv || bv === '\u2014'
    if (aBlank !== bBlank) return aBlank ? 1 : -1
    const c = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' })
    return sort.dir === 'asc' ? c : -c
  })
  const scheduleOptions = [...new Set(users.map(scheduleAccessSummary))].filter((v) => v !== '\u2014').sort()
  const myUid = auth && auth.currentUser ? auth.currentUser.uid : null
  const filterBox = { width: '100%', boxSizing: 'border-box', padding: '4px 6px', fontSize: '12px', borderRadius: '6px', border: '1px solid #ccc', background: '#fff', fontWeight: 400, color: '#2b2b26' }

  return (
    <div style={{ padding: '16px 24px', maxWidth: '1100px' }}>
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

      {deleteTarget && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '16px' }}
          onClick={(e) => { if (e.target === e.currentTarget && !deleting) { setDeleteTarget(null); setDeleteError(null) } }}
        >
          <div role="dialog" aria-modal="true" aria-label="Delete account" data-testid="delete-dialog" style={{ background: '#fff', borderRadius: '10px', padding: '20px', width: '400px', maxWidth: '100%', boxShadow: '0 4px 20px rgba(0,0,0,0.2)' }}>
            <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: '8px', color: '#2b2b26' }}>Permanently delete this account?</div>
            <div style={{ fontSize: '13px', color: '#2b2b26', fontWeight: 600, wordBreak: 'break-word' }}>{deleteTarget.name || deleteTarget.email}</div>
            {deleteTarget.name && deleteTarget.email && (
              <div style={{ fontSize: '12px', color: '#888', marginBottom: '10px', wordBreak: 'break-word' }}>{deleteTarget.email}</div>
            )}
            <div style={{ fontSize: '13px', color: '#555', lineHeight: 1.5, margin: deleteTarget.name && deleteTarget.email ? '0 0 16px' : '10px 0 16px' }}>
              This removes their login and profile and can&rsquo;t be undone. To bring them back later you would add them again as a new team member.
            </div>
            {deleteError && (
              <div role="alert" style={{ fontSize: '12px', color: '#A32D2D', background: '#FBEAEA', border: '1px solid #E8B4B4', borderRadius: '6px', padding: '8px 10px', marginBottom: '12px' }}>{deleteError}</div>
            )}
            <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
              <button onClick={() => { setDeleteTarget(null); setDeleteError(null) }} disabled={deleting} style={{ fontSize: '13px' }}>Cancel</button>
              <button onClick={handleConfirmDelete} disabled={deleting} style={{ fontSize: '13px', background: '#FBEAEA', border: '1px solid #E8B4B4', color: '#A32D2D' }}>{deleting ? 'Deleting\u2026' : 'Delete permanently'}</button>
            </div>
          </div>
        </div>
      )}

      {testNote && (
        <div className="mode-bar" style={{ background: testNote.ok ? '#3c5a3f' : '#8a5a12' }}>
          <div>{testNote.text}</div>
          <div className="mode-bar-actions"><button className="cancel" onClick={() => setTestNote(null)}>Dismiss</button></div>
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

      <div style={{ fontSize: '12px', color: '#888', margin: '0 0 6px 2px' }}>
        Showing {shownUsers.length} of {users.length}. Click a heading to sort; use the boxes under it to filter.
      </div>
      <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ textAlign: 'left', color: '#888', fontSize: '11px' }}>
            {COLUMNS.map((col) => {
              const active = sort.key === col.key
              return (
                <th key={col.key} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'} style={{ padding: '6px 8px' }}>
                  <button type="button" onClick={() => toggleSort(col.key)} title={`Sort by ${col.label.toLowerCase()}`}
                    style={{ background: 'none', border: 'none', padding: 0, font: 'inherit', color: active ? '#2b2b26' : '#888', fontWeight: active ? 700 : 600, cursor: 'pointer', textAlign: 'left' }}>
                    {col.label}{active ? (sort.dir === 'asc' ? ' \u25b2' : ' \u25bc') : ''}
                  </button>
                </th>
              )
            })}
            <th style={{ padding: '6px 8px' }}></th>
          </tr>
          <tr>
            <th style={{ padding: '0 8px 8px' }}>
              <input aria-label="Filter name" placeholder="Name or email" value={filters.name} onChange={(e) => setFilter('name', e.target.value)} style={filterBox} />
            </th>
            <th style={{ padding: '0 8px 8px' }}>
              <input aria-label="Filter phone" placeholder="Phone" value={filters.phone} onChange={(e) => setFilter('phone', e.target.value)} style={filterBox} />
            </th>
            <th style={{ padding: '0 8px 8px' }}>
              <select aria-label="Filter role" value={filters.role} onChange={(e) => setFilter('role', e.target.value)} style={filterBox}>
                <option value="">All roles</option>
                {Object.entries(ROLE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
              </select>
            </th>
            <th style={{ padding: '0 8px 8px' }}>
              <select aria-label="Filter farms" value={filters.farm} onChange={(e) => setFilter('farm', e.target.value)} style={filterBox}>
                <option value="">All</option>
                <option value={ALL_FARMS_FILTER}>All farms (no limit)</option>
                {farms.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </th>
            <th style={{ padding: '0 8px 8px' }}>
              <select aria-label="Filter schedule access" value={filters.sched} onChange={(e) => setFilter('sched', e.target.value)} style={filterBox}>
                <option value="">All</option>
                {scheduleOptions.map((v) => <option key={v} value={v}>{v}</option>)}
              </select>
            </th>
            <th style={{ padding: '0 8px 8px' }}>
              <select aria-label="Filter modules" value={filters.module} onChange={(e) => setFilter('module', e.target.value)} style={filterBox}>
                <option value="">All</option>
                {MODULES.map((m) => <option key={m.id} value={m.id}>Has {m.label}</option>)}
                <option value={CUSTOMER_PORTAL_FILTER}>Customer portal</option>
              </select>
            </th>
            <th style={{ padding: '0 8px 8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
              <select aria-label="Filter status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} style={{ ...filterBox, width: 'auto' }}>
                <option value="">All accounts</option>
                <option value="active">Active only</option>
                <option value="disabled">Disabled only</option>
              </select>
              {anyFilter && <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} style={{ marginLeft: '6px', fontSize: '12px' }}>Clear</button>}
            </th>
          </tr>
        </thead>
        <tbody>
          {shownUsers.map((user) => (
            <Fragment key={user.uid}>
              <tr style={{ borderTop: '1px solid #eee' }}>
                <td style={{ padding: '8px', ...(user.disabled ? { opacity: 0.5 } : null) }}>
                  <div style={{ fontWeight: 600 }}>{user.name || '\u2014'}</div>
                  <div style={{ fontSize: '11px', color: '#888' }}>{user.email}{user.disabled ? ' \u00b7 disabled' : ''}</div>
                </td>
                <td style={{ padding: '8px', color: '#666', ...(user.disabled ? { opacity: 0.5 } : null) }}>
                  {user.phone || '\u2014'}
                  {user.phone && <div style={{ fontSize: '10px', color: '#888' }}>Texts {user.receiveTextAlerts === true ? 'on' : 'off'}</div>}
                </td>
                <td style={{ padding: '8px', ...(user.disabled ? { opacity: 0.5 } : null) }}>{ROLE_LABELS[user.role] || user.role}
                  {alertsSummary(user.alerts) && <div style={{ fontSize: '10px', color: '#888' }}>{'\ud83d\udd14 ' + alertsSummary(user.alerts)}</div>}</td>
                <td style={{ padding: '8px', color: '#666', ...(user.disabled ? { opacity: 0.5 } : null) }}>{farmSummary(user)}</td>
                <td style={{ padding: '8px', color: '#666', ...(user.disabled ? { opacity: 0.5 } : null) }}>{scheduleAccessSummary(user)}</td>
                <td style={{ padding: '8px', color: '#666', ...(user.disabled ? { opacity: 0.5 } : null) }}>{moduleSummary(user)}</td>
                <td style={{ padding: '8px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <RowMenu
                    label={`Actions for ${user.name || user.email}`}
                    items={[
                      { label: editingUid === user.uid ? 'Close editor' : 'Edit', onClick: () => setEditingUid(editingUid === user.uid ? null : user.uid) },
                      user.role !== CUSTOMER_ROLE && user.role !== PLANTING_ROLE && !user.disabled ? { label: busyUid === user.uid ? 'Sending\u2026' : 'Send test alert', onClick: () => handleTestAlert(user), disabled: busyUid === user.uid } : null,
                      { label: 'Resend setup email', onClick: () => handleResend(user), disabled: busyUid === user.uid },
                      { label: copiedKey === user.uid ? 'Copied!' : 'Copy setup link', onClick: () => handleGetLink(user), disabled: busyUid === user.uid },
                      { label: user.disabled ? 'Enable' : 'Disable', onClick: () => handleToggleDisabled(user), disabled: busyUid === user.uid },
                      user.disabled && user.uid !== myUid ? { label: 'Delete account\u2026', onClick: () => setDeleteTarget(user), danger: true } : null
                    ]}
                  />
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
                        receiveTextAlerts: user.receiveTextAlerts === true,
                        role: user.role || 'irrigator',
                        farmIds: user.farmIds || [],
                        canEditSchedule: !!user.canEditSchedule,
                        sprayAdmin: !!user.sprayAdmin,
                        modules: Array.isArray(user.modules) ? user.modules : ALL_MODULE_IDS,
                        customers: user.customers || [],
                        alerts: { spray: (user.alerts && user.alerts.spray) || '', irrigation: (user.alerts && user.alerts.irrigation) || '' }
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
      {users.length > 0 && shownUsers.length === 0 && <p style={{ color: '#888', padding: '1rem 0' }}>No one matches these filters.</p>}
    </div>
  )
}
