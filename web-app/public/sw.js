// Service Worker para LoL Remote PWA
const CACHE_NAME = 'lol-remote-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Network-first con fallback a caché para garantizar tiempo real de Supabase y LoL
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  
  // Ignorar WebSocket y peticiones a Supabase / DataDragon de tiempo real
  const url = new URL(event.request.url);
  if (url.protocol === 'ws:' || url.protocol === 'wss:' || url.pathname.includes('/realtime/')) {
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
