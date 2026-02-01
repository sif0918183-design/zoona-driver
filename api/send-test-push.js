const { createClient } = require('@supabase/supabase-js');

const ONESIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID || "c05c5d16-4e72-4d4a-b1a2-6e7e06232d98";
const ONESIGNAL_REST_KEY = process.env.ONESIGNAL_REST_KEY || "os_v2_app_ybof2fsoojguvmncnz7amizntdepv6wooi3uqkvflqjitcramig6h757icims4fdyxand4d6aquovcvesbammphw5d3rfjtpz736s2q";

const supabase = createClient(
    'https://zsmlyiygjagmhnglrhoa.supabase.co',
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps'
);

async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { driverId, customerName, amount, distance } = req.body;

    if (!driverId) {
        return res.status(400).json({ success: false, error: 'missing_driver_id' });
    }

    try {
        console.log('🔔 Sending test notification to driver:', driverId);

        const notification = {
            app_id: ONESIGNAL_APP_ID,
            include_external_user_ids: [String(driverId)],
            android_channel_id: "ride_requests",
            priority: 10,
            headings: { "ar": "🔔 اختبار إشعار - زونا" },
            contents: {
                "ar": `هذا إشعار تجريبي\nالعميل: ${customerName || 'تجريبي'}\nالمسافة: ${distance || '0 كم'}\nالأجرة: ${amount || '0'}`
            },
            data: {
                rideId: 'test-' + Date.now(),
                requestId: 'test-' + Date.now(),
                customerName: customerName || 'عميل تجريبي',
                type: "test_notification",
                timestamp: new Date().toISOString()
            },
            buttons: [
                { id: "accept", text: { "ar": "✅ تم الاستلام", "en": "✅ Received" } }
            ],
            ttl: 60
        };

        const response = await fetch("https://onesignal.com/api/v1/notifications", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Basic ${ONESIGNAL_REST_KEY}`
            },
            body: JSON.stringify(notification)
        });

        const result = await response.json();

        // تسجيل المحاولة
        await supabase
            .from('push_notification_logs')
            .insert({
                driver_id: driverId,
                success: response.ok,
                error_message: response.ok ? null : JSON.stringify(result.errors),
                details: result,
                sent_at: new Date().toISOString()
            });

        if (response.ok) {
            console.log('✅ Test notification sent successfully:', result.id);
            return res.status(200).json({
                success: true,
                notification_id: result.id,
                message: 'تم إرسال الإشعار التجريبي بنجاح'
            });
        } else {
            console.error('❌ Test notification failed:', result.errors);
            return res.status(500).json({
                success: false,
                error: 'push_failed',
                details: result.errors
            });
        }

    } catch (error) {
        console.error('❌ Server error:', error);
        return res.status(500).json({
            success: false,
            error: error.message
        });
    }
}

module.exports = handler;
