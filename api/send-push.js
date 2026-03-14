import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

// استرجاع المفاتيح مع التأكد من وجود قيم بديلة (Fallback) لمنع انهيار السيرفر
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

// التحقق من وجود المفتاح قبل محاولة إنشاء العميل
if (!SUPABASE_KEY) {
    console.error('❌ CRITICAL ERROR: Supabase Key is missing in environment variables');
}

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
        }
    } catch (error) {
        console.error('❌ Firebase initialization error:', error);
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

    try {
        const { driverId, rideId, customerName, vehicleType, amount } = req.body;

        // 1. التحقق من حالة الرحلة (إصلاح مشكلة الـ searching والـ ghosting)
        if (rideId) {
            const { data: ride, error: rideError } = await tarhalDB
                .from('rides')
                .select('status')
                .eq('id', rideId)
                .single();

            if (!rideError && ride) {
                // سمحنا بـ searching و pending لضمان وصول الإشعارات فور الطلب
                const allowedStatuses = ['searching', 'pending', 'awaiting_driver_acceptance'];
                if (!allowedStatuses.includes(ride.status)) {
                    console.log(`⚠️ تجاهل الإشعار: حالة الرحلة حالياً [${ride.status}]`);
                    return res.status(200).json({ success: false, message: 'Ride already handled' });
                }
            }
        }

        // 2. جلب توكن السائق
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('fcm_token')
            .eq('id', driverId)
            .single();

        if (dbError || !driver?.fcm_token) {
            return res.status(404).json({ success: false, error: 'FCM token not found' });
        }

        // 3. بناء وإرسال الرسالة
        const message = {
            token: driver.fcm_token,
            notification: {
                title: '🚖 طلب رحلة جديد - زونا',
                body: `عميل: ${customerName || 'طلب جديد'}\nالسعر: ${amount || '0'} SDG`
            },
            data: {
                ride_id: String(rideId || ''),
                type: 'RIDE_REQUEST',
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            android: {
                priority: 'high',
                notification: {
                    sound: 'ride_request_sound',
                    channelId: 'urgent_alerts_v5',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK'
                }
            }
        };

        const response = await admin.messaging().send(message);
        console.log('✅ تم إرسال الإشعار بنجاح');
        
        return res.status(200).json({ success: true, response });

    } catch (error) {
        console.error('❌ خطأ في التنفيذ:', error);
        return res.status(500).json({ success: false, error: error.message });
    }
}
