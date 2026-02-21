// /api/send-push.js - النسخة المصححة والمؤمنة
import webpush from 'web-push';
import { createClient } from '@supabase/supabase-js';

// المفاتيح المضمنة (يفضل مستقبلاً نقلها لـ Environment Variables في Vercel)
const VAPID_PUBLIC_KEY = 'BELQSpfJpLROkcLYhHa1TeEsxdiUrz96HfocRfUCRiZ2cMX8LPt1wwF_a85SruFlX3sdKsAwQzpgyKTIuEhr2FA';
const VAPID_PRIVATE_KEY = 'iBQkcRI2JjXR9LOR_GLuJMH3lfrHJMg18fgcXkgJB4A'; 

const SUPABASE_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

webpush.setVapidDetails(
    'mailto:mosabkry@gmail.com',
    VAPID_PUBLIC_KEY,
    VAPID_PRIVATE_KEY
);

export default async function handler(req, res) {
    // تمكين CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS, GET');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
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

        console.log('🔔 طلب إرسال إشعار Web Push للسائق:', driverId);

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
            console.error('❌ فشل العثور على اشتراك للسائق:', driverId, dbError);
            return res.status(404).json({ success: false, error: 'subscription_not_found' });
        }

        // --- التعديل الجوهري هنا (السطر 76 وما بعده) ---
        let subscription;
        try {
            // التحقق مما إذا كانت البيانات نصاً يحتاج لمعالجة أو كائناً جاهزاً
            subscription = typeof driver.push_subscription === 'string' 
                ? JSON.parse(driver.push_subscription) 
                : driver.push_subscription;
            
            // تأكد من أن الكائن يحتوي على الحقول المطلوبة (endpoint)
            if (!subscription || !subscription.endpoint) {
                throw new Error("Invalid subscription format");
            }
        } catch (parseError) {
            console.error('❌ خطأ في تنسيق بيانات الاشتراك:', parseError);
            return res.status(400).json({ success: false, error: 'invalid_subscription_format' });
        }
        // ----------------------------------------------

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
        await tarhalDB.from('push_notification_logs').insert({
            driver_id: driverId,
            success: true,
            notification_type: 'ride_request',
            sent_at: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: 'تم إرسال الإشعار بنجاح' });

    } catch (error) {
        console.error('❌ خطأ في إرسال Web Push:', error);
        
        // التعامل مع الاشتراكات التي انتهت صلاحيتها
        if (error.statusCode === 410 || error.statusCode === 404) {
            console.log('⚠️ الاشتراك منتهي الصلاحية، يجب تحديثه من طرف السائق.');
        }

        return res.status(500).json({
            success: false,
            error: error.message,
            message: 'حدث خطأ أثناء إرسال الإشعار'
        });
    }
}

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
