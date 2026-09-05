// Registered from src/lib/push.ts. Kept deliberately tiny: this only
// exists to receive a push while the app isn't open and turn it into a
// system notification — it does no caching and takes no part in serving
// the app itself.

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
      data: { requestId: data.requestId },
    }),
  )
})

// Clicking the notification should land in the already-open tab if there
// is one, rather than piling up a new one every time.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if ('focus' in client) return client.focus()
      }
      return clients.openWindow ? clients.openWindow('/') : undefined
    }),
  )
})
