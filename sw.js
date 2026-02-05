// ============================================
// sw.js - Service Worker للسائق
// Push API + VAPID
// ============================================

const STATIC_CACHE_NAME = 'tarhal-driver-static-v3';
const DYNAMIC_CACHE_NAME = 'tarhal-driver-dynamic-v3';
const HEARTBEAT_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co/rest/v1/driver_locations';

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

// =================== Install & Activate ===================
self.addEventListener('install', (event) => {
  console.log('SW: Installing...');
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME).then(cache => cache.addAll(STATIC_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  console.log('SW: Activating...');
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (![STATIC_CACHE_NAME, DYNAMIC_CACHE_NAME].includes(key)) return caches.delete(key);
      })
    )).then(() => self.clients.claim())
  );
});

// =================== Fetch ===================
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('supabase.co')) return event.respondWith(fetch(event.request));
  
  event.respondWith(
    caches.match(event.request)
      .then(res => res || fetch(event.request).then(fetchRes => {
        if (fetchRes.ok && event.request.method === 'GET') {
          caches.open(DYNAMIC_CACHE_NAME).then(cache => cache.put(event.request.url, fetchRes.clone()));
        }
        return fetchRes;
      }).catch(() => caches.match('/404.html')))
  );
});

// =================== Heartbeat ===================
self.addEventListener('message', (event) => {
  if (event.data.type === 'DRIVER_HEARTBEAT') handleDriverHeartbeat(event.data.driverId);
  if (event.data.type === 'DRIVER_OFFLINE') handleDriverOffline(event.data.driverId);
});

async function handleDriverHeartbeat(driverId) {
  try {
    await fetch(`${HEARTBEAT_URL}?driver_id=eq.${driverId}`, {
      method: 'PATCH',
      headers: {
        'apikey': 'YOUR_SUPABASE_KEY',
        'Authorization': 'Bearer YOUR_SUPABASE_KEY',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ last_seen: new Date().toISOString(), updated_at: new Date().toISOString() })
    });
    console.log('✅ Heartbeat sent');
  } catch (err) { console.error('❌ Heartbeat error', err); }
}

async function handleDriverOffline(driverId) {
  try {
    await fetch(`${HEARTBEAT_URL}?driver_id=eq.${driverId}`, {
      method: 'PATCH',
      headers: {
        'apikey': 'YOUR_SUPABASE_KEY',
        'Authorization': 'Bearer YOUR_SUPABASE_KEY',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ is_online: false, last_seen: new Date().toISOString(), updated_at: new Date().toISOString() })
    });
    console.log('✅ Driver set offline');
  } catch (err) { console.error('❌ Offline error', err); }
}

// =================== Push Notifications ===================
self.addEventListener('push', function(event) {
  let data = {};
  if (event.data) data = event.data.json();

  const title = data.headings?.ar || 'رحلة جديدة';
  const body = data.contents?.ar || 'لديك طلب رحلة جديد';
  const options = {
    body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    data,
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  const rideId = event.notification.data?.ride_id;
  const requestId = event.notification.data?.request_id;
  event.waitUntil(
    clients.openWindow(`https://driver.zoonasd.com/accept-ride.html?rideId=${rideId}&requestId=${requestId}`)
  );
});

console.log('✅ Service Worker loaded - Push API Ready');