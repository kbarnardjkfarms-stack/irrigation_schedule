import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import PublicScheduleView from './PublicScheduleView.jsx'
import './styles.css'
// (flat layout: no src/ folder — everything lives at the project root)

// A /watch/<farm-slug> URL renders the no-login, view-only irrigator page
// instead of the normal app. Checked once at load time, before any Firebase
// Auth state is touched — this path never sees the Login screen.
const watchMatch = window.location.pathname.match(/^\/watch\/([^/]+)\/?$/)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {watchMatch ? <PublicScheduleView slug={watchMatch[1]} /> : <App />}
  </React.StrictMode>
)
