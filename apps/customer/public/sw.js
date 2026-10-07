// Pixel Barber service worker: shows push notifications and opens the right screen on tap
// (Docs/superpowers/specs/2026-10-07-web-push-notifications-design.md).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = {};
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Pixel Barber', {
      body: data.body || '',
      tag: data.tag,
      icon: '/icons/192',
      badge: '/icons/192',
      data: { url: data.url || '/' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const path = (event.notification.data && event.notification.data.url) || '/';
  const url = new URL(path, self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (!('navigate' in client)) continue;
        try {
          await client.focus();
          await client.navigate(url);
          return;
        } catch {
          // try the next window; fall through to openWindow if none works
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
