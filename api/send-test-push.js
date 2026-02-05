// /api/send-test-push.js - النسخة الجديدة باستخدام Web Push API + VAPID
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

// المفاتيح المضمنة في الكود مباشرة
const VAPID_PUBLIC_KEY = 'BELQSpfJpLROkcLYhHa1TeEsxdiUrz96HfocRfUCRiZ2cMX8LPt1wwF_a85SruFlX3sdKsAwQzpgyKTIuEhr2FA';
const VAPID_PRIVATE_KEY = 'iBQkcRI2JjXR9LOR_GLuJMH3lfrHJMg18fgcXkgJB4A'; // استبدل بالمفتاح الخاص الفعلي

const SUPABASE_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

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

        const { driverId, customerName, amount, distance, vehicleType } = req.body;

        console.log('🔔 طلب إرسال إشعار تجريبي Web Push:', { driverId });

        if (!driverId) {
            return res.status(400).json({ success: false, error: 'يجب تحديد driverId' });
        }

        // 1. جلب بيانات الاشتراك من قاعدة البيانات
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('push_subscription, full_name')
            .eq('id', driverId)
            .single();

        if (dbError || !driver || !driver.push_subscription) {
            return res.status(404).json({
                success: false, 
                error: 'subscription_not_found',
                message: 'لم يتم العثور على اشتراك إشعارات لهذا السائق'
            });
        }

        const subscription = JSON.parse(driver.push_subscription);

        // 2. إعداد حمولة الإشعار
        const payload = JSON.stringify({
            title: '🔔 اختبار إشعار - زونا',
            body: `هذا إشعار تجريبي\nالعميل: ${customerName || 'تجريبي'}\nالنوع: ${getVehicleTypeArabic(vehicleType || 'economy')}\nالأجرة: ${amount || '0'} SDG`,
            ride_id: 'test-' + Date.now(),
            request_id: 'test-' + Date.now(),
            customer_name: customerName || 'عميل تجريبي',
            amount: amount || '0',
            distance: distance || '0 كم',
            vehicle_type: vehicleType || 'economy',
            type: 'RIDE_REQUEST' // تحديث النوع ليطابق طلبات الرحلة الحقيقية
        });

        // 3. إرسال الإشعار
        await webpush.sendNotification(subscription, payload);

        console.log('✅ تم إرسال إشعار تجريبي Web Push بنجاح للسائق:', driver.full_name);

        // 4. تسجيل العملية في Supabase
        await tarhalDB.from('push_notification_logs').insert({
            driver_id: driverId,
            success: true,
            notification_type: 'test',
            sent_at: new Date().toISOString()
        });

        return res.status(200).json({
            success: true,
            message: 'تم إرسال الإشعار التجريبي بنجاح'
        });

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