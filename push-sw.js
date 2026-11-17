// Phone alerts (spray schedule "field done" and future AIO alerts). Loaded into the app's
// service worker (vite.config.js workbox.importScripts). Firebase Cloud Messaging delivers a
// web push with { data: { title, body, url, tag } }; this shows it and opens AIO when tapped.
self.addEventListener('push', (event) => {
  let p = {}
  try { p = event.data ? event.data.json() : {} } catch (e) { p = {} }
  const d = Object.assign({}, p.notification || {}, p.data || {})
  const title = d.title || 'AIO'
  event.waitUntil(self.registration.showNotification(title, {
    body: d.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: d.tag || undefined,
    data: { url: d.url || '/' }
  }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || '/'
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) { if ('focus' in c) return c.focus() }
    return self.clients.openWindow(url)
  }))
})
