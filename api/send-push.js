// /api/send-push.js - النسخة الجديدة باستخدام Web Push API + VAPID
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

const VAPID_PUBLIC_KEY = 'BH1s1aKlXXTf3TDHjB549HeCOupdhx10DIWrqjfKK7FE9OIXnleoQaW-su_xaCuMAKSHS0B-f1jattX4zYxVd-Y';
const VAPID_PRIVATE_KEY = 'yL2RoZAOWYf9Ig3JVpMO-vkJSms1j36XUHL2sUMbYJY';
const SUPABASE_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

webpush.setVapidDetails(
    'mailto:admin@zoonasd.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
);

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
        if (!req.body) {
            return res.status(400).json({ success: false, error: 'Missing request body' });
        }

        const { 
            driverId, 
            rideId, 
            requestId, 
            customerName, 
            vehicleType, 
            amount, 
            distance 
        } = req.body;

        console.log('🔔 طلب إرسال إشعار Web Push:', { driverId, rideId, customerName });

        if (!driverId) {
            return res.status(400).json({ success: false, error: 'يجب تحديد driverId' });
        }

        // 1. جلب بيانات الاشتراك من قاعدة البيانات
        const { data: driver, error: dbError } = await supabase
            .from('drivers')
            .select('push_subscription, full_name')
            .eq('id', driverId)
            .single();

        if (dbError || !driver || !driver.push_subscription) {
            console.error('❌ فشل العثور على اشتراك للسائق:', driverId, dbError);
            return res.status(404).json({
                success: false, 
                error: 'subscription_not_found',
                message: 'لم يتم العثور على اشتراك إشعارات لهذا السائق'
            });
        }

        const subscription = JSON.parse(driver.push_subscription);

        // 2. إعداد حمولة الإشعار
        const payload = JSON.stringify({
            title: '🚖 طلب رحلة جديدة - زونا',
            body: `عميل: ${customerName || 'عميل'}\nالنوع: ${getVehicleTypeArabic(vehicleType) || 'سيارة'}\nالمبلغ: ${amount || '0'} SDG`,
            ride_id: rideId,
            request_id: requestId,
            customer_name: customerName,
            amount: amount,
            distance: distance,
            vehicle_type: vehicleType,
            type: 'RIDE_REQUEST'
        });

        // 3. إرسال الإشعار
        await webpush.sendNotification(subscription, payload);

        console.log('✅ تم إرسال إشعار Web Push بنجاح للسائق:', driver.full_name);

        // 4. تسجيل العملية في Supabase
        await supabase.from('push_notification_logs').insert({
            driver_id: driverId,
            success: true,
            notification_type: 'ride_request',
            sent_at: new Date().toISOString()
        });

        return res.status(200).json({
            success: true,
            message: 'تم إرسال الإشعار بنجاح'
        });

    } catch (error) {
        console.error('❌ خطأ في إرسال Web Push:', error);

        // إذا كان الاشتراك غير صالح، يمكننا حذفه أو تحديثه
        if (error.statusCode === 410 || error.statusCode === 404) {
            console.log('⚠️ الاشتراك لم يعد صالحاً، جاري التحديث...');
            // هنا يمكن إضافة كود لمسح الاشتراك غير الصالح من قاعدة البيانات
        }

        return res.status(500).json({
            success: false,
            error: error.message,
            message: 'حدث خطأ أثناء إرسال الإشعار'
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