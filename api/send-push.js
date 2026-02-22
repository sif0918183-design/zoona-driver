import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

// تهيئة Firebase Admin
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            console.log('✅ Firebase Admin initialized');
        } else {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT environment variable is missing');
        }
    } catch (error) {
        console.error('❌ Firebase initialization error:', error);
    }
}

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

        console.log('🔔 طلب إرسال إشعار FCM للسائق:', driverId);

        if (!driverId) {
            return res.status(400).json({ success: false, error: 'يجب تحديد driverId' });
        }

        // 1. جلب توكن FCM من قاعدة البيانات
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('fcm_token, full_name')
            .eq('id', driverId)
            .single();

        if (dbError || !driver || !driver.fcm_token) {
            console.error('❌ فشل العثور على FCM Token للسائق:', driverId, dbError);
            return res.status(404).json({ success: false, error: 'fcm_token_not_found' });
        }

        // 2. إعداد رسالة FCM
        const message = {
            token: driver.fcm_token,
            notification: {
                title: '🚖 طلب رحلة جديدة - زونا',
                body: `عميل: ${customerName || 'عميل'}\nالنوع: ${getVehicleTypeArabic(vehicleType) || 'سيارة'}\nالمبلغ: ${amount || '0'} SDG`,
            },
            data: {
                ride_id: String(rideId || ''),
                request_id: String(requestId || ''),
                customer_name: String(customerName || ''),
                amount: String(amount || '0'),
                distance: String(distance || ''),
                vehicle_type: String(vehicleType || ''),
                type: 'RIDE_REQUEST'
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'ride_request_sound',
                    channelId: 'ride_requests',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK'
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'ride_request_sound.wav',
                        contentAvailable: true
                    }
                }
            }
        };

        // 3. إرسال الإشعار عبر Firebase
        const response = await admin.messaging().send(message);
        console.log('✅ تم إرسال إشعار FCM بنجاح:', response);

        // 4. تسجيل العملية في Supabase
        await tarhalDB.from('push_notification_logs').insert({
            driver_id: driverId,
            success: true,
            notification_type: 'ride_request_fcm',
            sent_at: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: 'تم إرسال الإشعار بنجاح عبر FCM' });

    } catch (error) {
        console.error('❌ خطأ في إرسال FCM:', error);
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
