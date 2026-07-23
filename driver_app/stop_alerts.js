// stop_alerts.js
// ============================================
// ✅ دالة إيقاف الصوت والاهتزاز في Flutter
// ============================================

function stopFlutterAlerts() {
    console.log('🛑 محاولة إيقاف التنبيهات...');
    
    try {
        // ✅ الطريقة 1: عبر WebView Handler (الأفضل)
        if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
            console.log('📤 إرسال طلب إيقاف عبر Handler...');
            window.flutter_inappwebview.callHandler('stopAlertsFromPWA')
                .then((result) => {
                    console.log('✅ تم إيقاف التنبيهات في Flutter (via Handler):', result);
                })
                .catch((err) => {
                    console.log('⚠️ Handler failed:', err);
                    // محاولة الطريقة البديلة
                    stopFlutterAlertsFallback();
                });
        } else {
            console.log('⚠️ WebView Handler غير متوفر، استخدام الطرق البديلة');
            stopFlutterAlertsFallback();
        }
        
        // ✅ الطريقة 2: عبر localStorage
        localStorage.setItem('stop_alerts', Date.now().toString());
        
        // ✅ الطريقة 3: عبر postMessage
        if (window.parent !== window) {
            window.parent.postMessage({
                type: 'STOP_ALERTS',
                action: 'stop',
                timestamp: Date.now()
            }, '*');
        }
        
        // ✅ الطريقة 4: عبر URL parameter
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('stop_alerts', Date.now().toString());
            window.history.replaceState({}, '', url.toString());
        } catch (_) {}
        
        console.log('✅ تم إرسال طلب إيقاف التنبيهات');
    } catch (e) {
        console.log('⚠️ خطأ في إيقاف التنبيهات:', e);
        stopFlutterAlertsFallback();
    }
}

// ============================================
// ✅ الطريقة البديلة لإيقاف التنبيهات
// ============================================
function stopFlutterAlertsFallback() {
    try {
        // محاولة إيقاف عبر window.parent
        if (window.parent && window.parent !== window) {
            window.parent.postMessage({
                type: 'STOP_ALERTS',
                action: 'stop',
                timestamp: Date.now()
            }, '*');
        }
        
        // محاولة إيقاف عبر localStorage (للتطبيقات الأخرى)
        localStorage.setItem('stop_alerts', Date.now().toString());
        
        // محاولة إيقاف عبر تغيير URL
        const url = new URL(window.location.href);
        url.searchParams.set('stop_alerts', Date.now().toString());
        window.history.replaceState({}, '', url.toString());
        
        console.log('✅ تم إيقاف التنبيهات عبر الطريقة البديلة');
    } catch (e) {
        console.log('⚠️ فشلت الطريقة البديلة:', e);
    }
}

// ============================================
// ✅ مراقبة طلبات الإيقاف
// ============================================
if (typeof window !== 'undefined') {
    // عند تحميل الصفحة
    document.addEventListener('DOMContentLoaded', function() {
        console.log('📄 DOM loaded, checking for stop requests...');
        
        // التحقق من وجود طلب إيقاف في URL
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('stop_alerts')) {
            console.log('🔍 Found stop_alerts in URL');
            stopFlutterAlerts();
        }
        
        // التحقق من localStorage
        const stopTime = localStorage.getItem('stop_alerts');
        if (stopTime) {
            const elapsed = Date.now() - parseInt(stopTime);
            if (elapsed < 5000) {
                console.log('🔍 Found recent stop_alerts in localStorage');
                stopFlutterAlerts();
            }
            localStorage.removeItem('stop_alerts');
        }
    });
    
    // عند مغادرة الصفحة
    window.addEventListener('beforeunload', function() {
        console.log('🚪 Page unloading, stopping alerts...');
        stopFlutterAlerts();
    });
    
    // مراقبة تغييرات localStorage
    window.addEventListener('storage', function(event) {
        if (event.key === 'stop_alerts') {
            console.log('🔍 Detected stop_alerts change in localStorage');
            stopFlutterAlerts();
        }
    });
}

console.log('✅ stop_alerts.js loaded');