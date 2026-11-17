import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import PublicScheduleView from './PublicScheduleView.jsx'
import { SprayCrew } from './Spray.jsx'
import './styles.css'
// (flat layout: no src/ folder — everything lives at the project root)

// A /watch/<farm-slug> URL renders the no-login, view-only irrigator page
// instead of the normal app. Checked once at load time, before any Firebase
// Auth state is touched — this path never sees the Login screen.
const watchMatch = window.location.pathname.match(/^\/watch\/([^/]+)\/?$/)
// A /crew/<code> URL is a spray crew member's no-login link (Spray.jsx SprayCrew, functions/sprayCrewLinks.js).
const crewMatch = window.location.pathname.match(/^\/crew\/([A-Za-z0-9_-]+)\/?$/)

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {watchMatch ? <PublicScheduleView slug={watchMatch[1]} /> : crewMatch ? <SprayCrew code={crewMatch[1]} /> : <App />}
  </React.StrictMode>
)
