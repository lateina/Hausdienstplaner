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

messaging.onBackgroundMessage((payload) => {
  console.log('[sw.js] Received background message ', payload);
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: 'https://lateina.github.io/Hausdienstchat/icon_tight_192.png',
    data: payload.data
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});

const CACHE_NAME = 'dienste-chat-v4';
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
