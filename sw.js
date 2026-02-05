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
    const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';
    await fetch(`${HEARTBEAT_URL}?driver_id=eq.${driverId}`, {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
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
    const key = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';
    await fetch(`${HEARTBEAT_URL}?driver_id=eq.${driverId}`, {
      method: 'PATCH',
      headers: {
        'apikey': key,
        'Authorization': `Bearer ${key}`,
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
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch (e) {
    console.error('Error parsing push data:', e);
    return;
  }

  // عرض الإشعار
  const title = data.title || 'رحلة جديدة 🚗';
  const body = data.body || `طلب رحلة جديد من ${data.customer_name || 'عميل'}`;

  const options = {
    body: body,
    icon: '/icons/icon-192x192.png',
    badge: '/icons/icon-96x96.png',
    data: data,
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: true,
    tag: 'ride-request-' + (data.ride_id || 'general'),
    actions: [
      { action: 'accept', title: '✅ قبول' },
      { action: 'decline', title: '❌ رفض' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(title, options).then(() => {
      // إرسال رسالة إلى التطبيق المفتوح (Post Message)
      return self.clients.matchAll({ type: 'window' }).then(clients => {
        clients.forEach(client => {
          client.postMessage({
            type: 'RIDE_REQUEST',
            payload: data
          });
        });
      });
    })
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();

  const data = event.notification.data;
  const rideId = data.ride_id || data.rideId;
  const requestId = data.request_id || data.requestId;

  // إذا ضغط على زر الرفض
  if (event.action === 'decline') {
    return;
  }

  // فتح التطبيق أو الانتقال لصفحة قبول الرحلة
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      // إذا كان التطبيق مفتوحاً، ركز عليه
      for (const client of clients) {
        if (client.url.includes('driver.zoonasd.com') && 'focus' in client) {
          return client.focus();
        }
      }
      // إذا لم يكن مفتوحاً، افتحه
      if (self.clients.openWindow) {
        const url = rideId ?
          `https://driver.zoonasd.com/accept-ride.html?rideId=${rideId}&requestId=${requestId}` :
          'https://driver.zoonasd.com/';
        return self.clients.openWindow(url);
      }
    })
  );
});

console.log('✅ Service Worker loaded - Push API Ready');