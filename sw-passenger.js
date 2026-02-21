// sw-passenger.js - Service Worker for Passenger App (v3.1)
const CACHE_NAME = 'tarhal-passenger-v3.1';
const ASSETS = [
    '/',
    '/passenger_app/index.html',
    '/passenger_app/manifest.json',
    '/shared/supabase-config.js',
    '/shared/notification-utils.js',
    '/icons/icon-192x192.png',
    '/icons/icon-72x72.png'
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

// Network First with strict Cache Fallback
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
        fetch(event.request)
            .then((networkResponse) => {
                if (!networkResponse || networkResponse.status !== 200 || networkResponse.type !== 'basic') {
                    return networkResponse;
                }

                const responseClone = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseClone);
                    limitCacheSize(CACHE_NAME, MAX_CACHE_ITEMS);
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
    if (!event.data) return;

    let data = {};
    try {
        data = event.data.json();
    } catch (e) {
        data = { title: 'تحديث لرحلتك 🚘', body: event.data.text() };
    }

    const title = data.title || 'تحديث لرحلتك 🚘';
    const options = {
        body: data.body || 'هناك تحديث جديد بخصوص طلب رحلتك.',
        icon: '/icons/icon-192x192.png',
        badge: '/icons/icon-72x72.png',
        vibrate: [200, 100, 200],
        data: {
            url: data.url || '/passenger_app/index.html'
        },
        tag: 'ride-update',
        renotify: true
    };

    event.waitUntil(
        self.registration.showNotification(title, options)
    );
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data.url;
    event.waitUntil(
        clients.openWindow(url)
    );
});
