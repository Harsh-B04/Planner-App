// Keeps the app opening when offline. Always tries the network first so updates show up,
// and falls back to the saved copy. API calls are never cached.
const CACHE = 'planner-shell-v36';
const SHELL = ['/', '/index.html', '/app.css', '/app.js', '/planner-core.js', '/plan.js', '/notify.js', '/calendar.js', '/vault.js', '/extras.js', '/more.js', '/demo.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('/index.html')))
  );
});

// Notifications from the server (reminders, check-ins).
self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Planner', {
    body: m.body || '',
    tag: m.tag,
    renotify: !!m.tag,
    icon: '/icon-192.png',
    actions: Array.isArray(m.actions) ? m.actions.slice(0, 2) : [],
    data: { url: m.url || '/', startUrl: m.startUrl || null, actionUrls: m.actionUrls || null },
  }));
});

// Tapping a notification (or its "Start timer" button) opens the app on the right screen.
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const d = e.notification.data || {};
  const url = (e.action && d.actionUrls && d.actionUrls[e.action]) || (e.action === 'start' && d.startUrl) || d.url || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'open', url });
    } else {
      await self.clients.openWindow(url);
    }
  })());
});
