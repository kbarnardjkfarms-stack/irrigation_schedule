import { useEffect, useState } from 'react'
import { collection, onSnapshot } from 'firebase/firestore'
import { db } from './firebase.js'
import AgronomyByField from './AgronomyByField.jsx'
import AgronomyByCriteria from './AgronomyByCriteria.jsx'

export default function Agronomy() {
  const [view, setView] = useState('field')
  const [fields, setFields] = useState([])

  useEffect(() => {
    const unsub = onSnapshot(collection(db, 'fields'), (snap) => {
      const list = []
      snap.forEach((d) => list.push({ id: d.id, ...d.data() }))
      list.sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      setFields(list)
    })
    return () => unsub()
  }, [])

  return (
    <div className="agronomy">
      <div className="agronomy-view-toggle">
        <button className={view === 'field' ? 'active' : ''} onClick={() => setView('field')}>
          By field
        </button>
        <button className={view === 'criteria' ? 'active' : ''} onClick={() => setView('criteria')}>
          By criteria
        </button>
      </div>
      {view === 'field'
        ? <AgronomyByField fields={fields} />
        : <AgronomyByCriteria fields={fields} />}
    </div>
  )
}
