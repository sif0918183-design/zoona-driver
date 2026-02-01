// /api/send-test-push.js - النسخة المعدلة
const ONESIGNAL_APP_ID = "c05c5d16-4e72-4d4a-b1a2-6e7e06232d98";
const ONESIGNAL_REST_KEY = "os_v2_app_ybof2fsoojguvmncnz7amizntdepv6wooi3uqkvflqjitcramig6h757icims4fdyxand4d6aquovcvesbammphw5d3rfjtpz736s2q";
const SUPABASE_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

export default async function handler(req, res) {
    // تمكين CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    // التعامل مع طلبات OPTIONS
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // التحقق من أن الطريقة POST
    if (req.method !== 'POST') {
        return res.status(405).json({ 
            success: false, 
            error: 'Method not allowed. Use POST.' 
        });
    }

    try {
        // التحقق من وجود body
        if (!req.body) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing request body' 
            });
        }

        const { driverId, customerName, amount, distance } = req.body;

        console.log('🔔 Request body:', req.body);

        if (!driverId) {
            return res.status(400).json({ 
                success: false, 
                error: 'Missing driverId parameter' 
            });
        }

        console.log('🔔 Sending test notification to driver:', driverId);

        // إعداد بيانات الإشعار
        const notification = {
            app_id: ONESIGNAL_APP_ID,
            include_external_user_ids: [String(driverId)],
            android_channel_id: "ride_requests",
            priority: 10,
            headings: { 
                "ar": "🔔 اختبار إشعار - زونا",
                "en": "🔔 Test Notification - Zoona"
            },
            contents: {
                "ar": `هذا إشعار تجريبي\nالعميل: ${customerName || 'تجريبي'}\nالمسافة: ${distance || '0 كم'}\nالأجرة: ${amount || '0'} جنيه`,
                "en": `Test notification\nCustomer: ${customerName || 'Test'}\nDistance: ${distance || '0 km'}\nFare: ${amount || '0'} SDG`
            },
            data: {
                rideId: 'test-' + Date.now(),
                requestId: 'test-' + Date.now(),
                customerName: customerName || 'عميل تجريبي',
                amount: amount || '0',
                distance: distance || '0 كم',
                type: "test_notification",
                timestamp: new Date().toISOString(),
                test: true
            },
            buttons: [
                { 
                    id: "accept_test", 
                    text: { 
                        "ar": "✅ تم الاستلام", 
                        "en": "✅ Received" 
                    },
                    icon: "ic_accept"
                }
            ],
            ttl: 60,
            url: `https://driver.zoonasd.com/accept-ride.html?rideId=test-${Date.now()}`,
            web_url: `https://driver.zoonasd.com/accept-ride.html?rideId=test-${Date.now()}`
        };

        console.log('📤 Sending to OneSignal:', JSON.stringify(notification, null, 2));

        // إرسال الإشعار إلى OneSignal
        const response = await fetch("https://onesignal.com/api/v1/notifications", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${ONESIGNAL_REST_KEY}`,
                "Accept": "application/json"
            },
            body: JSON.stringify(notification)
        });

        const result = await response.json();
        
        console.log('📥 OneSignal response:', {
            status: response.status,
            ok: response.ok,
            result: result
        });

        // تسجيل النتيجة في Supabase
        try {
            const logResponse = await fetch(`${SUPABASE_URL}/rest/v1/push_notification_logs`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'apikey': SUPABASE_KEY,
                    'Authorization': `Bearer ${SUPABASE_KEY}`,
                    'Prefer': 'return=minimal'
                },
                body: JSON.stringify({
                    driver_id: driverId,
                    success: response.ok,
                    notification_type: 'test',
                    error_message: response.ok ? null : (result.errors ? JSON.stringify(result.errors) : 'Unknown error'),
                    details: result,
                    sent_at: new Date().toISOString(),
                    created_at: new Date().toISOString()
                })
            });
            
            if (!logResponse.ok) {
                console.error('❌ Failed to log to Supabase:', await logResponse.text());
            }
        } catch (logError) {
            console.error('❌ Logging error:', logError);
        }

        if (response.ok) {
            console.log('✅ Test notification sent successfully:', result.id);
            return res.status(200).json({
                success: true,
                notification_id: result.id,
                recipient_count: result.recipients,
                external_id: driverId,
                message: 'تم إرسال الإشعار التجريبي بنجاح'
            });
        } else {
            console.error('❌ Test notification failed:', result.errors || result);
            return res.status(500).json({
                success: false,
                error: 'push_failed',
                details: result.errors || result,
                message: 'فشل إرسال الإشعار'
            });
        }

    } catch (error) {
        console.error('❌ Server error:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
            stack: error.stack,
            message: 'حدث خطأ في الخادم'
        });
    }
}