// sw-passenger.js - Service Worker for Passenger App
const CACHE_NAME = 'tarhal-passenger-v1';
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

// Network First with Cache Fallback
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    event.respondWith(
        fetch(event.request)
            .then((networkResponse) => {
                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseClone);
                });
                return networkResponse;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});

// Ride Update Notifications
self.addEventListener('push', (event) => {
    let data = {};
    if (event.data) {
        data = event.data.json();
    }

    const title = data.title || 'تحديث لرحلتك 🚘';
    const options = {
        body: data.body || 'هناك تحديث جديد بخصوص طلب رحلتك.',
        icon: '../icons/icon-192x192.png',
        badge: '../icons/icon-72x72.png',
        data: data.url || './index.html',
        tag: 'ride-update'
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data)
    );
});

// Background Sync for pending requests
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-ride-requests') {
        // Logic to retry failed ride requests
    }
});
