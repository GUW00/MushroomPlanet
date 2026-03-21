const CACHE = 'mp-v1';
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

self.addEventListener('fetch', e => {
  // Always fetch API calls live, cache everything else
  if (e.request.url.includes('/api/')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});