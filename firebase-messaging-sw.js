// ============================================================
// firebase-messaging-sw.js
// Service Worker for Dienste-Chat PWA
//
// IMPORTANT: We do NOT import the Firebase Messaging SDK here.
// The Firebase JS SDK intercepts the raw 'push' event and HOLDS
// messages unless onBackgroundMessage() is defined. On iOS, this
// prevents notifications from being shown in the background.
//
// Instead, we handle the 'push' event directly using the raw
// Web Push API which is what iOS Safari/PWA natively supports.
// ============================================================

// ─── Background Push Handler (Raw Web Push API) ─────────────
self.addEventListener('push', (event) => {
  if (!event.data) {
    console.log('[SW] Push received but no data.');
    return;
  }

  let payload;
  try {
    payload = event.data.json();
  } catch (e) {
    payload = { notification: { title: 'Dienste-Chat', body: event.data.text() } };
  }

  // FCM sends the notification under the top-level 'notification' key
  const notification = payload.notification || {};
  const data = payload.data || {};

  const title = notification.title || 'Dienste-Chat';
  const options = {
    body: notification.body || 'Neuer Beitrag',
    icon: 'https://lateina.github.io/Hausdienstchat/icon_tight_192.png',
    badge: 'https://lateina.github.io/Hausdienstchat/icon_tight_192.png',
    data: data,
    tag: data.postId || 'default', // Prevents duplicate notifications
    renotify: true,
  };

  console.log('[SW] Showing notification:', title, options);
  event.waitUntil(self.registration.showNotification(title, options));
});

// ─── Notification Click Handler ──────────────────────────────
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification click received.', event.notification.data);
  event.notification.close();

  const postId = event.notification.data ? event.notification.data.postId : null;
  const baseUrl = 'https://lateina.github.io/Hausdienstchat/index.html';
  const urlToOpen = postId ? `${baseUrl}?post=${postId}` : baseUrl;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (let i = 0; i < windowClients.length; i++) {
        const client = windowClients[i];
        if (client.url.startsWith(baseUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(urlToOpen);
      }
    })
  );
});

// ─── PWA Caching (Cache-First with Network Fallback) ─────────
const CACHE_NAME = 'dienste-chat-v7';
const ASSETS = [
  './index.html',
  './manifest.json',
  './icon_tight_192.png',
  './icon_tight_512.png'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
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
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (event.request.method === 'GET') {
          return caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, networkResponse.clone());
            return networkResponse;
          });
        }
        return networkResponse;
      })
      .catch(() => {
        return caches.match(event.request);
      })
  );
});
