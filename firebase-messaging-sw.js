importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAL3ItV7orEMajCU94CoH6fnbp8Gh3dqno",
  authDomain: "dienste-chat-5a359.firebaseapp.com",
  projectId: "dienste-chat-5a359",
  storageBucket: "dienste-chat-5a359.firebasestorage.app",
  messagingSenderId: "611813592302",
  appId: "1:611813592302:web:23455d71cfd7fa46c377ff"
});

const messaging = firebase.messaging();

// ─── Background Messaging ────────────────────────────────────────────────────
messaging.onBackgroundMessage((payload) => {
  console.log('[SW] Background message received:', payload);

  // Extract data for the notification
  const data = payload.data || {};
  const notification = payload.notification || {};

  const notificationTitle = notification.title || 'Dienste-Chat';
  const notificationOptions = {
    body: notification.body || data.body || 'Neuer Beitrag',
    icon: notification.icon || notification.image || data.icon || './icon_tight_192.png',
    badge: './icon_tight_192.png',
    data: data,
    tag: notification.tag || data.tag || data.postId || 'dienste-chat-notif'
  };

  // Skip showing if title/body are empty (might be a silent data sync)
  if (!notificationTitle && !notificationOptions.body) return;

  return self.registration.showNotification(notificationTitle, notificationOptions);
});

// ─── Notification Click Handler ──────────────────────────────────────────────
self.addEventListener('notificationclick', (event) => {
  console.log('[SW] Notification click received.', event.notification.data);
  event.notification.close();

  const postId = event.notification.data ? event.notification.data.postId : null;
  const baseUrl = 'https://lateina.github.io/Hausdienstplaner/index.html';
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
const CACHE_NAME = 'dienste-chat-v14';
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
