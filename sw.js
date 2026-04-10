if (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1') {
  self.addEventListener('fetch', e => e.respondWith(fetch(e.request)));
} else {
const CACHE = 'mp-v40';
const SHELL = [
  '/profile.html', '/treasury.html', '/vote.html', '/convert.html',
  '/styles.css', '/config.js',
  '/images/discord.png', '/images/reddit.png',
  '/images/icon-192.png', '/images/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: 'Mushroom Planet', body: 'Farm update!', url: '/profile.html' };
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/images/icon-192.png',
      badge: '/images/icon-96.png',
      data: { url: data.url }
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data.url || '/profile.html'));
});

self.addEventListener('fetch', e => {
  // Always fetch API calls live, cache everything else
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
}