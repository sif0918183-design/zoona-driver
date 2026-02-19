// sw-driver.js - Service Worker for Driver App
const CACHE_NAME = 'tarhal-driver-v1';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    '../shared/supabase-config.js',
    '../shared/notification-utils.js'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
});

self.addEventListener('fetch', (event) => {
    event.respondWith(
        caches.match(event.request).then((response) => {
            return response || fetch(event.request);
        })
    );
});

// Push Notification Handling
self.addEventListener('push', (event) => {
    let data = {};
    if (event.data) {
        data = event.data.json();
    }

    const title = data.title || 'طلب رحلة جديد 🚗';
    const options = {
        body: data.body || 'لديك طلب رحلة جديد في منطقتك',
        icon: '../icons/icon-192x192.png',
        badge: '../icons/icon-72x72.png',
        vibrate: [500, 110, 500, 110, 450, 110, 200, 110, 170, 40, 450, 110, 200, 110, 170, 40],
        data: data.url || './index.html',
        actions: [
            { action: 'accept', title: '✅ قبول الرحلة', icon: '../icons/check-icon.png' },
            { action: 'decline', title: '❌ رفض', icon: '../icons/close-icon.png' }
        ],
        tag: 'ride-request',
        renotify: true,
        priority: 2 // High priority
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    if (event.action === 'accept') {
        // Logic to accept ride (e.g., via background sync or opening a specific URL)
        event.waitUntil(
            clients.openWindow(event.notification.data + '?action=accept')
        );
    } else if (event.action === 'decline') {
        // Logic to decline ride
    } else {
        event.waitUntil(
            clients.openWindow(event.notification.data)
        );
    }
});

// Sync Driver Status
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-driver-status') {
        // Logic to sync status with Supabase if offline changes were made
    }
});
