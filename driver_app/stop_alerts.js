// stop_alerts.js
// ============================================
// ✅ دالة إيقاف الصوت والاهتزاز في Flutter
// ============================================

function stopFlutterAlerts() {
    try {
        // الطريقة 1: عبر WebView Handler
        if (window.flutter_inappwebview && window.flutter_inappwebview.callHandler) {
            window.flutter_inappwebview.callHandler('stopAlertsFromPWA')
                .then(() => {
                    console.log('✅ تم إيقاف التنبيهات في Flutter (via Handler)');
                })
                .catch((err) => {
                    console.log('⚠️ Handler failed:', err);
                });
        }
        
        // الطريقة 2: عبر localStorage (للتطبيقات الأخرى)
        localStorage.setItem('stop_alerts', Date.now().toString());
        
        // الطريقة 3: عبر postMessage
        if (window.parent !== window) {
            window.parent.postMessage({
                type: 'STOP_ALERTS',
                action: 'stop',
                timestamp: Date.now()
            }, '*');
        }
        
        // الطريقة 4: عبر URL parameter
        try {
            const url = new URL(window.location.href);
            url.searchParams.set('stop_alerts', Date.now().toString());
            window.history.replaceState({}, '', url.toString());
        } catch (_) {}
        
        console.log('✅ تم إرسال طلب إيقاف التنبيهات');
    } catch (e) {
        console.log('⚠️ خطأ في إيقاف التنبيهات:', e);
    }
}

// ============================================
// ✅ مراقبة طلبات الإيقاف
// ============================================
if (typeof window !== 'undefined') {
    // عند تحميل الصفحة
    document.addEventListener('DOMContentLoaded', function() {
        // التحقق من وجود طلب إيقاف في URL
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.has('stop_alerts')) {
            stopFlutterAlerts();
        }
        
        // التحقق من localStorage
        const stopTime = localStorage.getItem('stop_alerts');
        if (stopTime) {
            if (Date.now() - parseInt(stopTime) < 5000) {
                stopFlutterAlerts();
            }
            localStorage.removeItem('stop_alerts');
        }
    });
    
    // عند مغادرة الصفحة
    window.addEventListener('beforeunload', function() {
        stopFlutterAlerts();
    });
}

console.log('✅ stop_alerts.js loaded');