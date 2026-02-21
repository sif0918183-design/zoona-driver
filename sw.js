// sw.js - Service Worker for Driver App (v3.1)
const CACHE_NAME = 'tarhal-driver-v3.1';
const ASSETS = [
    '/',
    '/driver_app/index.html',
    '/driver_app/manifest.json',
    '/shared/supabase-config.js',
    '/shared/notification-utils.js',
    '/icons/icon-192x192.png',
    '/icons/icon-72x72.png',
    '/res/raw/ride_request_sound.wav'
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
    if (!event.data) return;

    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = { title: 'طلب رحلة جديد 🚗', body: event.data.text() };
    }

    const title = data.title || 'طلب رحلة جديد 🚗';

    // Construct URL if not provided
    const targetUrl = data.url || (data.ride_id ? `/driver_app/accept-ride.html?rideId=${data.ride_id}&requestId=${data.request_id}` : '/driver_app/index.html');

    const options = {
        body: data.body || 'لديك طلب رحلة جديد في منطقتك',
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-72x72.png',
        vibrate: [200, 100, 200, 100, 200, 100, 400],
        sound: '/res/raw/ride_request_sound.wav',
        data: {
            url: targetUrl
        },
        actions: [
            { action: 'accept', title: '✅ قبول الرحلة', icon: '/icons/icon-72x72.png' },
            { action: 'decline', title: '❌ رفض', icon: '/icons/icon-72x72.png' }
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
    const url = event.notification.data.url;

    if (event.action === 'accept') {
        const acceptUrl = url + (url.includes('?') ? '&' : '?') + 'action=accept';
        event.waitUntil(
            clients.openWindow(acceptUrl)
        );
    } else if (event.action === 'decline') {
        // Just close the notification
    } else {
        event.waitUntil(
            clients.openWindow(url)
        );
    }
});
