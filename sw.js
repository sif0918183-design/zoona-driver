// ============================================
// sw.js - Service Worker للسائق (النسخة المبسطة)
// نظام احتياطي فقط - الإشعارات الأساسية تدار بواسطة Flutter
// ============================================

const STATIC_CACHE_NAME = 'tarhal-driver-static-v4';
const DYNAMIC_CACHE_NAME = 'tarhal-driver-dynamic-v4';

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
  console.log('SW: Installing simplified version...');
  event.waitUntil(
    caches.open(STATIC_CACHE_NAME)
      .then(cache => cache.addAll(STATIC_FILES))
      .then(() => {
        console.log('✅ Static files cached');
        return self.skipWaiting();
      })
  );
});

self.addEventListener('activate', (event) => {
  console.log('SW: Activating...');
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.map(key => {
        if (![STATIC_CACHE_NAME, DYNAMIC_CACHE_NAME].includes(key)) {
          console.log(`🗑️ Deleting old cache: ${key}`);
          return caches.delete(key);
        }
      })
    )).then(() => {
      console.log('✅ Cache cleanup completed');
      return self.clients.claim();
    })
  );
});

// =================== Fetch Handler ===================
self.addEventListener('fetch', (event) => {
  // تجاهل طلبات Service Worker نفسها
  if (event.request.url.includes('sw.js')) {
    return;
  }
  
  // تجاهل طلبات غير HTTP/HTTPS
  if (!event.request.url.startsWith('http')) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request)
      .then(cachedResponse => {
        // إذا كان الملف مخزناً في الكاش، استخدمه
        if (cachedResponse) {
          return cachedResponse;
        }
        
        // إذا لم يكن في الكاش، حمله من الشبكة
        return fetch(event.request)
          .then(networkResponse => {
            // التخزين المؤقت للطلبات الناجحة فقط
            if (networkResponse.ok && 
                event.request.method === 'GET' &&
                networkResponse.status === 200) {
              
              const responseClone = networkResponse.clone();
              caches.open(DYNAMIC_CACHE_NAME)
                .then(cache => {
                  cache.put(event.request, responseClone);
                });
            }
            return networkResponse;
          })
          .catch(() => {
            // صفحة 404 للطلبات الفاشلة
            return caches.match('/404.html');
          });
      })
  );
});

// =================== Message Handler ===================
// استقبال رسائل من الصفحة الرئيسية
self.addEventListener('message', (event) => {
  console.log('SW: Message received:', event.data);
  
  const { type } = event.data;
  
  switch (type) {
    case 'SKIP_WAITING':
      self.skipWaiting();
      console.log('✅ Skipping waiting phase');
      break;
      
    case 'CLEAR_CACHE':
      caches.delete(DYNAMIC_CACHE_NAME)
        .then(() => {
          console.log('✅ Dynamic cache cleared');
          if (event.source) {
            event.source.postMessage({ type: 'CACHE_CLEARED' });
          }
        });
      break;
      
    case 'GET_CACHE_INFO':
      caches.keys().then(cacheNames => {
        if (event.source) {
          event.source.postMessage({ 
            type: 'CACHE_INFO', 
            data: { 
              cacheNames,
              staticCache: STATIC_CACHE_NAME,
              dynamicCache: DYNAMIC_CACHE_NAME
            } 
          });
        }
      });
      break;
  }
});

// =================== Push Notification Handler ===================
// نعطله تماماً لأن Flutter هو من يدير الإشعارات
self.addEventListener('push', function(event) {
  console.log('SW: Push received but ignored (handled by Flutter)');
  // لا نفعل أي شيء - Flutter يتولى الإشعارات
});

self.addEventListener('notificationclick', function(event) {
  console.log('SW: Notification click ignored (handled by Flutter)');
  event.notification.close();
  // لا نفعل أي شيء - Flutter يتولى النقر على الإشعارات
});

// =================== Background Sync (احتياطي) ===================
self.addEventListener('sync', function(event) {
  console.log('SW: Background sync:', event.tag);
  
  if (event.tag === 'heartbeat-sync') {
    event.waitUntil(
      // يمكن إضافة منطق مزامنة بسيط هنا إذا لزم الأمر
      Promise.resolve()
    );
  }
});

// =================== Periodic Background Sync ===================
if ('periodicSync' in self.registration) {
  self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'driver-status-update') {
      console.log('SW: Periodic sync for driver status');
      // لا نفعل أي شيء - Flutter يتولى تحديث الحالة
    }
  });
}

console.log('✅ Service Worker loaded (Simplified Version)');
console.log('📱 Push notifications handled by Flutter');
console.log('💾 Caching only - No VAPID, No Push API');