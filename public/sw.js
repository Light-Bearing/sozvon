// Сначала сеть, кэш — только когда сети нет.
// Иначе список адресов каналов однажды устареет и застрянет в кэше
// намертво: приложение будет ломиться в мёртвые адреса и молчать.

const CACHE = 'sozvon-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  event.respondWith(
    fetch(event.request)
      .then(response => {
        const copy = response.clone();
        void caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request)),
  );
});
