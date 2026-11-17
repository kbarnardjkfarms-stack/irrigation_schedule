// Phone alerts for the Spray module: turn this phone's alerts on/off and send a test.
// Uses Firebase Cloud Messaging with the app's own service worker (push-sw.js shows the alert).
// iPhone: works only when AIO was added to the Home Screen and opened from that icon.
import { getApp } from 'firebase/app'
import { getMessaging, getToken, deleteToken, isSupported } from 'firebase/messaging'
import { httpsCallable } from 'firebase/functions'
import { functions } from './firebase.js'

const setup = httpsCallable(functions, 'sprayPushSetup', { timeout: 60000 })
const KEY = 'aio-spray-push-token'
const saved = () => { try { return localStorage.getItem(KEY) || '' } catch (e) { return '' } }
const save = (t) => { try { t ? localStorage.setItem(KEY, t) : localStorage.removeItem(KEY) } catch (e) { /* storage blocked */ } }

const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent || '')
const isHomeScreen = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true

/** 'on' | 'off' | 'blocked' | 'ios-home' (iPhone not opened from the Home Screen) | 'unsupported' */
export async function pushState() {
  if (isIos() && !isHomeScreen()) return 'ios-home'
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !(await isSupported().catch(() => false))) return 'unsupported'
  if (Notification.permission === 'denied') return 'blocked'
  return Notification.permission === 'granted' && saved() ? 'on' : 'off'
}

async function token() {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, no) => setTimeout(() => no(new Error('AIO\'s background helper isn\'t running. Close AIO completely, open it again, and retry.')), 10000))
  ])
  return getToken(getMessaging(getApp()), { serviceWorkerRegistration: reg })
}

/** Ask permission (must be called from a tap) and save this phone. Returns { ok, onSheet, error }. */
export async function turnOn() {
  const perm = await Notification.requestPermission()
  if (perm !== 'granted') return { ok: false, error: perm === 'denied' ? 'blocked' : 'Alerts weren\'t allowed.' }
  const t = await token()
  if (!t) return { ok: false, error: 'This phone didn\'t give a push code. Try again.' }
  const r = (await setup({ token: t, on: true, ua: navigator.userAgent })).data
  save(t)
  return r
}

export async function turnOff() {
  const t = saved()
  if (t) await setup({ token: t, on: false }).catch(() => {})
  await deleteToken(getMessaging(getApp())).catch(() => {})
  save('')
}

/** Re-save this phone (its push code can change); quiet, for when the Spray screen opens. */
export async function refresh() {
  if ((await pushState()) !== 'on') return null
  const t = await token().catch(() => '')
  if (!t) return null
  if (t !== saved()) { await setup({ token: t, on: true, ua: navigator.userAgent }); save(t) }
  return t
}

export async function sendTest() {
  return (await setup({ test: true })).data
}
