// /api/send-push.js - النسخة المعدلة والصحيحة
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

        const { 
            driverId, 
            playerId, 
            rideId, 
            requestId, 
            customerName, 
            vehicleType, 
            amount, 
            distance 
        } = req.body;

        console.log('🔔 استقبال طلب إرسال إشعار:', {
            driverId,
            playerId,
            rideId,
            requestId,
            customerName
        });

        // التحقق من البيانات المطلوبة
        if (!driverId) {
            return res.status(400).json({ 
                success: false, 
                error: 'يجب تحديد driverId' 
            });
        }

        if (!playerId && !driverId) {
            return res.status(400).json({ 
                success: false, 
                error: 'يجب تحديد playerId أو driverId' 
            });
        }

        // تحديد المستلم: استخدام external_user_id (driverId) إذا متاح
        const targetId = driverId || playerId;
        const targetType = driverId ? 'external_user_id' : 'player_id';

        console.log(`🎯 إرسال إشعار إلى ${targetType}:`, targetId);

        // إعداد بيانات الإشعار
        const notification = {
            app_id: ONESIGNAL_APP_ID,
            android_channel_id: "ride_requests",
            priority: 10,
            headings: { 
                "ar": "🚖 طلب رحلة جديدة - زونا",
                "en": "🚖 New Ride Request - Zoona"
            },
            contents: {
                "ar": `عميل: ${customerName || 'عميل'}\nالنوع: ${getVehicleTypeArabic(vehicleType) || 'سيارة'}\nالمسافة: ${distance || '0'} كم\nالمبلغ: ${amount || '0'} جنيه`,
                "en": `Customer: ${customerName || 'Customer'}\nType: ${vehicleType || 'car'}\nDistance: ${distance || '0'} km\nAmount: ${amount || '0'} SDG`
            },
            data: {
                rideId: rideId || 'test-' + Date.now(),
                requestId: requestId || 'test-' + Date.now(),
                customerName: customerName || 'عميل',
                vehicleType: vehicleType || 'economy',
                amount: amount || '0',
                distance: distance || '0',
                type: "ride_request",
                timestamp: new Date().toISOString(),
                test: rideId && rideId.startsWith('test-')
            },
            buttons: [
                { 
                    id: "accept", 
                    text: { 
                        "ar": "✅ قبول الرحلة", 
                        "en": "✅ Accept Ride" 
                    },
                    icon: "ic_accept"
                },
                { 
                    id: "decline", 
                    text: { 
                        "ar": "❌ رفض", 
                        "en": "❌ Decline" 
                    },
                    icon: "ic_decline"
                }
            ],
            ttl: 40, // 40 ثانية كما في التطبيق
            url: rideId ? `https://driver.zoonasd.com/accept-ride.html?rideId=${rideId}&requestId=${requestId}` : null
        };

        // تحديد طريقة الإرسال بناءً على targetType
        if (targetType === 'external_user_id') {
            notification.include_external_user_ids = [String(targetId)];
        } else {
            notification.include_player_ids = [String(targetId)];
        }

        console.log('📤 إرسال إلى OneSignal:', JSON.stringify(notification, null, 2));

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
        
        console.log('📥 استجابة OneSignal:', {
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
                    player_id: playerId,
                    success: response.ok,
                    notification_type: rideId && rideId.startsWith('test-') ? 'test' : 'ride_request',
                    error_message: response.ok ? null : (result.errors ? JSON.stringify(result.errors) : 'Unknown error'),
                    details: result,
                    sent_at: new Date().toISOString(),
                    created_at: new Date().toISOString()
                })
            });
            
            if (!logResponse.ok) {
                console.error('❌ فشل التسجيل في Supabase:', await logResponse.text());
            }
        } catch (logError) {
            console.error('❌ خطأ في التسجيل:', logError);
        }

        if (response.ok) {
            console.log('✅ تم إرسال الإشعار بنجاح:', result.id);
            return res.status(200).json({
                success: true,
                notification_id: result.id,
                recipient_count: result.recipients,
                target_id: targetId,
                target_type: targetType,
                message: 'تم إرسال الإشعار بنجاح'
            });
        } else {
            console.error('❌ فشل إرسال الإشعار:', result.errors || result);
            return res.status(500).json({
                success: false,
                error: 'push_failed',
                details: result.errors || result,
                message: 'فشل إرسال الإشعار'
            });
        }

    } catch (error) {
        console.error('❌ خطأ في الخادم:', error);
        return res.status(500).json({
            success: false,
            error: error.message,
            message: 'حدث خطأ في الخادم'
        });
    }
}

// دالة مساعدة لتحويل نوع المركبة للعربية
function getVehicleTypeArabic(type) {
    const types = {
        'tuktuk': 'توك توك',
        'economy': 'اقتصادية',
        'comfort': 'متوسطة',
        'vip': 'VIP',
        'motorcycle': 'دراجة نارية'
    };
    return types[type] || type;
}