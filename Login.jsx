import { useState } from 'react'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { auth } from './firebase.js'
import aioLogoFull from './aio-logo-full.png'
export default function Login() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  async function handleSubmit(e) {
    e.preventDefault()
    setError(null)
    setLoading(true)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
      // onAuthStateChanged in App.jsx picks this up automatically — nothing
      // else to do here once sign-in succeeds.
    } catch (err) {
      // Deliberately vague — doesn't confirm whether the email exists,
      // just that the combination didn't work.
      setError('Incorrect email or password.')
    } finally {
      setLoading(false)
    }
  }
  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: '#f4f2ec'
    }}>
      <form
        onSubmit={handleSubmit}
        style={{
          background: '#fff',
          padding: '2rem',
          borderRadius: '12px',
          width: '100%',
          maxWidth: '320px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
          boxShadow: '0 1px 3px rgba(0,0,0,0.1)'
        }}
      >
        <img
          src={aioLogoFull}
          alt="AIO — All In One"
          style={{ width: '100%', maxWidth: '220px', margin: '0 auto 8px', display: 'block' }}
        />
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
          required
          style={{ padding: '10px', fontSize: '15px', borderRadius: '8px', border: '1px solid #ccc' }}
        />
        <input
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
          style={{ padding: '10px', fontSize: '15px', borderRadius: '8px', border: '1px solid #ccc' }}
        />
        {error && <p style={{ color: '#A32D2D', fontSize: '13px', margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={loading}
          style={{ padding: '10px', fontSize: '15px', borderRadius: '8px', border: 'none', background: '#185FA5', color: '#fff' }}
        >
          {loading ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  )
}
