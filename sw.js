// Define cache names for PWA assets
const STATIC_CACHE_NAME = 'tarhal-driver-static-v1';
const DYNAMIC_CACHE_NAME = 'tarhal-driver-dynamic-v1';

// List of static assets to cache
const STATIC_FILES = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-72x72.png',
  '/icons/icon-96x96.png',
  '/icons/icon-128x128.png',
  '/icons/icon-144x144.png',
  '/icons/icon-152x152.png',
  '/icons/icon-192x192.png',
  '/icons/icon-384x384.png',
  '/icons/icon-512x512.png',
  '/404.html'
];

/**
 * Service Worker Install Event
 * Caches all the static assets needed for the PWA to work offline.
 */
self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching static assets...');
        return cache.addAll(STATIC_FILES);
      })
      .then(() => self.skipWaiting())
      .catch(err => console.error('Service Worker: Static asset caching failed:', err))
  );
});

/**
 * Service Worker Activate Event
 * Cleans up old caches to ensure the latest version of the app is served.
 */
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.map(cache => {
          if (cache !== STATIC_CACHE_NAME && cache !== DYNAMIC_CACHE_NAME) {
            console.log('Service Worker: Deleting old cache:', cache);
            return caches.delete(cache);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

/**
 * Service Worker Fetch Event
 * Handles network requests, serving cached assets when available (Cache-first strategy).
 */
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // If the asset is in the cache, return it
        if (response) {
          return response;
        }
        // Otherwise, fetch from the network
        return fetch(event.request)
          .then(res => {
            // If the request is valid, cache it dynamically
            if (res.ok) {
              return caches.open(DYNAMIC_CACHE_NAME)
                .then(cache => {
                  cache.put(event.request.url, res.clone());
                  return res;
                });
            }
            return res;
          })
          .catch(() => caches.match('/404.html')); // Fallback for network errors
      })
  );
});

// OneSignal SDK will be imported here later
// self.importScripts("https://cdn.onesignal.com/sdks/OneSignalSDKWorker.js");

console.log('Service Worker: Loaded successfully (FCM Removed).');
