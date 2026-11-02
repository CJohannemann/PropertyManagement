// Registered from src/lib/push.ts. Kept deliberately tiny: this only
// exists to receive a push while the app isn't open and turn it into a
// system notification — it does no caching and takes no part in serving
// the app itself.
//
// The payload comes from deploy/selfhost/send-push-notifications.mjs:
// { title, body, link, tag, urgent }.

// Take over straight away instead of waiting for every open tab to close.
// Push can only subscribe through an active worker, and a worker left
// "waiting" behind an older one made "Turn on alerts" fail on a phone that
// had the app open.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    // A push with no/unparseable payload still deserves *a* notification
    // rather than silently doing nothing.
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Property Management', {
      body: data.body || '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag,
      // An urgent repair stays on screen until it's dealt with, rather
      // than sliding away like a routine one.
      requireInteraction: Boolean(data.urgent),
      data: { link: data.link || '/dashboard' },
    }),
  )
})

// Tapping the notification opens what it's about — the repair list, the
// property, the job — in the already-open app if there is one, rather than
// piling up a new tab every time.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const link = (event.notification.data && event.notification.data.link) || '/dashboard'
  const url = new URL(link, self.location.origin).href
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (new URL(client.url).origin === self.location.origin && 'focus' in client) {
          return client.focus().then((c) => (c && 'navigate' in c ? c.navigate(url) : c))
        }
      }
      return clients.openWindow ? clients.openWindow(url) : undefined
    }),
  )
})
