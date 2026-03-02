importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyCKOZlEu5QaQ8ISjFmNFFp5AXqypjJ9VCc",
  authDomain: "dienste-chat.firebaseapp.com",
  projectId: "dienste-chat",
  storageBucket: "dienste-chat.firebasestorage.app",
  messagingSenderId: "25445990011",
  appId: "1:25445990011:web:993bfdd9b93502653a6cde"
});

const messaging = firebase.messaging();

// ─── IMPORTANT: No onBackgroundMessage() registered ──────────────────────────
// When the FCM payload contains a top-level 'notification' object AND
// onBackgroundMessage is NOT registered, the Firebase SDK shows the
// notification automatically (native browser/OS handling).
// This is the most reliable path for iOS PWA background notifications.
// Registering onBackgroundMessage() — even with an empty body — would
// intercept and suppress the automatic display on many iOS versions.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Notification Click Handler ──────────────────────────────────────────────
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

// ─── PWA Caching ─────────────────────────────────────────────────────────────
const CACHE_NAME = 'dienste-chat-v8';
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
