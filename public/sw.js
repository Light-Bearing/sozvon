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
        void caches.open(CACHE)
          .then(cache => cache.put(event.request, copy))
          .catch(() => {});
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        if (cached) return cached;
        // При двойном промахе (нет сети, кэш пуст) вернём осмысленный ответ.
        // Для навигации — страница с сообщением. Для ресурсов — просто 503.
        if (event.request.mode === 'navigate') {
          return new Response(
            `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Нет соединения</title>
  <style>
    body { font-family: sans-serif; margin: 40px; text-align: center; color: #333; }
    h1 { font-size: 24px; margin: 20px 0; }
    p { font-size: 16px; line-height: 1.6; }
  </style>
</head>
<body>
  <h1>Нет соединения с интернетом</h1>
  <p>Откройте эту страницу снова, когда вернётся сеть.</p>
</body>
</html>`,
            {status: 503, headers: {'Content-Type': 'text/html; charset=utf-8'}}
          );
        }
        return new Response(null, {status: 503});
      }),
  );
});
