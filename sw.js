// sw.js - Service Worker المحدث
const STATIC_CACHE_NAME = 'tarhal-driver-static-v2';
const DYNAMIC_CACHE_NAME = 'tarhal-driver-dynamic-v2';
const HEARTBEAT_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co/rest/v1/driver_locations';

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

// Install Event
self.addEventListener('install', (event) => {
  console.log('Service Worker: Installing v2...');
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => {
        console.log('Service Worker: Caching static assets...');
        return cache.addAll(STATIC_FILES);
      })
      .then(() => self.skipWaiting())
  );
});

// Activate Event
self.addEventListener('activate', (event) => {
  console.log('Service Worker: Activating v2...');
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
    }).then(() => {
      console.log('Service Worker: Claiming clients...');
      return self.clients.claim();
    })
  );
});

// Fetch Event
self.addEventListener('fetch', (event) => {
  // استثناء طلبات Supabase من التخزين المؤقت
  if (event.request.url.includes('supabase.co')) {
    event.respondWith(fetch(event.request));
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        if (response) {
          return response;
        }
        return fetch(event.request)
          .then(res => {
            if (res.ok && event.request.method === 'GET') {
              return caches.open(DYNAMIC_CACHE_NAME)
                .then(cache => {
                  cache.put(event.request.url, res.clone());
                  return res;
                });
            }
            return res;
          })
          .catch(() => caches.match('/404.html'));
      })
  );
});

// استقبال رسائل من الصفحة الرئيسية
self.addEventListener('message', (event) => {
  console.log('Service Worker: Message received:', event.data);
  
  if (event.data.type === 'DRIVER_HEARTBEAT') {
    handleDriverHeartbeat(event.data.driverId);
  }
  
  if (event.data.type === 'DRIVER_OFFLINE') {
    handleDriverOffline(event.data.driverId);
  }
});

// معالجة Heartbeat من Service Worker
async function handleDriverHeartbeat(driverId) {
  try {
    console.log('💓 Service Worker: Sending heartbeat for driver:', driverId);
    
    const response = await fetch(HEARTBEAT_URL + '?driver_id=eq.' + driverId, {
      method: 'PATCH',
      headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        last_seen: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    if (response.ok) {
      console.log('✅ Service Worker: Heartbeat sent successfully');
    } else {
      console.error('❌ Service Worker: Heartbeat failed:', response.status);
    }
  } catch (error) {
    console.error('❌ Service Worker: Heartbeat error:', error);
  }
}

// معالجة وضع Offline
async function handleDriverOffline(driverId) {
  try {
    console.log('🔒 Service Worker: Setting driver offline:', driverId);
    
    const response = await fetch(HEARTBEAT_URL + '?driver_id=eq.' + driverId, {
      method: 'PATCH',
      headers: {
        'apikey': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps',
        'Authorization': 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps',
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        is_online: false,
        last_seen: new Date().toISOString(),
        updated_at: new Date().toISOString()
      })
    });

    if (response.ok) {
      console.log('✅ Service Worker: Driver set offline successfully');
    } else {
      console.error('❌ Service Worker: Offline setting failed:', response.status);
    }
  } catch (error) {
    console.error('❌ Service Worker: Offline error:', error);
  }
}

// Background sync للاتصال المستمر
self.addEventListener('sync', (event) => {
  if (event.tag === 'driver-heartbeat') {
    console.log('🔄 Service Worker: Background sync triggered');
    event.waitUntil(syncHeartbeat());
  }
});

async function syncHeartbeat() {
  // الحصول على driverId من التخزين
  const clients = await self.clients.matchAll();
  for (const client of clients) {
    client.postMessage({
      type: 'REQUEST_DRIVER_ID'
    });
  }
}

console.log('✅ Service Worker: Loaded successfully v2 (Forever Online Ready)');