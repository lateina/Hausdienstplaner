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
    console.log('[firebase-messaging-sw.js] Received background message ', payload);
    const notificationTitle = payload.notification.title;
    const notificationOptions = {
        body: payload.notification.body,
        icon: '/icon_tight_192.png'
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});
