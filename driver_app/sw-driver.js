// sw-driver.js - Optimized Service Worker for Driver App (v3)
const CACHE_NAME = 'tarhal-driver-v3';
const ASSETS = [
    './',
    './index.html',
    './manifest.json',
    '../shared/supabase-config.js',
    '../shared/notification-utils.js'
];

// Domains to NEVER cache
const EXCLUDED_DOMAINS = [
    'maps.googleapis.com',
    'maps.gstatic.com',
    'cdn.onesignal.com',
    'unpkg.com',
    'cdnjs.cloudflare.com',
    'fonts.googleapis.com',
    'fonts.gstatic.com'
];

const MAX_CACHE_ITEMS = 50;

// Helper to limit cache size
async function limitCacheSize(name, size) {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.length > size) {
        await cache.delete(keys[0]);
        await limitCacheSize(name, size);
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
    );
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) => {
            return Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            );
        })
    );
    self.clients.claim();
});

// Cache First for Assets, Network First for others
self.addEventListener('fetch', (event) => {
    if (event.request.method !== 'GET') return;

    const url = new URL(event.request.url);

    // Skip caching for excluded domains or Supabase API
    if (EXCLUDED_DOMAINS.some(domain => url.hostname.includes(domain)) ||
        url.hostname.includes('supabase.co')) {
        event.respondWith(fetch(event.request));
        return;
    }

    event.respondWith(
        caches.match(event.request).then((cachedResponse) => {
            if (cachedResponse) {
                return cachedResponse;
            }

            return fetch(event.request).then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseClone);
                    limitCacheSize(CACHE_NAME, MAX_CACHE_ITEMS);
                });
                return networkResponse;
            });
        })
    );
});

// Push Notification Handling
self.addEventListener('push', (event) => {
    let data = {};
    try {
        if (event.data) {
            data = event.data.json();
        }
    } catch (e) {
        data = { title: 'طلب رحلة جديد 🚗', body: event.data.text() };
    }

    const title = data.title || 'طلب رحلة جديد 🚗';

    // Extract ride_id from payload (FCM structure usually puts it in data)
    const rideId = data.ride_id || (data.data && data.data.ride_id);
    const redirectUrl = rideId ? `./accept-ride.html?id=${rideId}` : './index.html';

    const options = {
        body: data.body || 'لديك طلب رحلة جديد في منطقتك',
        icon: '../icons/icon-192x192.png',
        badge: '../icons/icon-72x72.png',
        vibrate: [500, 110, 500, 110, 800, 110, 800, 110],
        data: redirectUrl,
        actions: [
            { action: 'accept', title: '✅ قبول الرحلة', icon: '../icons/check-icon.png' },
            { action: 'decline', title: '❌ رفض', icon: '../icons/close-icon.png' }
        ],
        tag: 'urgent-ride-request',
        renotify: true,
        requireInteraction: true,
        silent: false,
        priority: 2 // High priority
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    // If 'decline' was clicked, just close (notification is already closed)
    if (event.action === 'decline') return;

    let targetUrl = event.notification.data;

    // Add action parameter if accepted via button
    if (event.action === 'accept') {
        targetUrl += (targetUrl.includes('?') ? '&' : '?') + 'action=accept';
    }

    event.waitUntil(
        clients.matchAll({ type: 'window' }).then((windowClients) => {
            // Check if there is already a window open with this URL
            for (let i = 0; i < windowClients.length; i++) {
                const client = windowClients[i];
                if (client.url === targetUrl && 'focus' in client) {
                    return client.focus();
                }
            }
            // If no window found, open a new one
            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
