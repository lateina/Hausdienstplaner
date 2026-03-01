const CACHE_NAME = 'dienste-chat-v3';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon_tight_192.png',
  './icon_tight_512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // Erzwingt das sofortige Aktivieren des neuen Service Workers
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName); // Löscht alte Caches
          }
        })
      );
    }).then(() => {
      return self.clients.claim(); // Übernimmt sofort die Kontrolle über alle offenen Fenster
    })
  );
});

// Network First Strategy mit Fallback
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Falls Netzwerk erfolgreich war, sichere eine Kopie im Cache (nur für GET-Anfragen)
        if (event.request.method === 'GET') {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Bei Netzwerkfehler (Offline) hole Daten aus dem Cache
        return caches.match(event.request);
      })
  );
});
