import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;

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
    // إعدادات CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

    try {
        const { 
            driverId, 
            rideId, 
            requestId, 
            customerName, 
            vehicleType, 
            amount, 
            distance 
        } = req.body;

        if (!driverId) return res.status(400).json({ success: false, error: 'driverId is required' });

        // 1. التحقق من حالة الرحلة (التصحيح الحرج هنا)
        if (rideId) {
            const { data: ride, error: rideError } = await tarhalDB
                .from('rides')
                .select('status')
                .eq('id', rideId)
                .single();

            if (!rideError && ride) {
                /** * ✅ تم إضافة 'searching' للقائمة المسموحة لأن النظام 
                 * يبدأ البحث بهذه الحالة قبل تحويلها لـ pending.
                 **/
                const allowedStatuses = ['searching', 'pending', 'awaiting_driver_acceptance'];
                
                if (!allowedStatuses.includes(ride.status)) {
                    console.log(`⚠️ إيقاف الإشعار: الرحلة في حالة [${ride.status}] ولا تحتاج لتنبيه السائق.`);
                    return res.status(200).json({
                        success: false,
                        message: `Notification skipped: Ride status is ${ride.status}`,
                        status: ride.status
                    });
                }
            }
        }

        // 2. جلب بيانات السائق
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('fcm_token, full_name')
            .eq('id', driverId)
            .single();

        if (dbError || !driver || !driver.fcm_token) {
            return res.status(404).json({ success: false, error: 'fcm_token_not_found' });
        }

        // 3. بناء رسالة FCM الاحترافية
        const message = {
            token: driver.fcm_token,
            notification: {
                title: '🚖 طلب رحلة جديد - زونا',
                body: `عميل: ${customerName || 'عميل جديد'}\nالنوع: ${getVehicleTypeArabic(vehicleType)}\nالأجرة: ${amount || '0'} SDG`,
            },
            data: {
                ride_id: String(rideId || ''),
                customer_name: String(customerName || ''),
                amount: String(amount || '0'),
                distance: String(distance || ''),
                type: 'RIDE_REQUEST',
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            android: {
                priority: 'high',
                ttl: 45 * 1000, // تنتهي صلاحية الإشعار بعد 45 ثانية (عمر الطلب)
                notification: {
                    sound: 'ride_request_sound',
                    channelId: 'urgent_alerts_v5',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                    sticky: true,
                    visibility: 'public'
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'ride_request_sound.wav',
                        contentAvailable: true,
                        badge: 1
                    }
                }
            }
        };

        // 4. الإرسال الفعلي
        const response = await admin.messaging().send(message);
        console.log(`✅ تم الإرسال للسائق [${driver.full_name}]:`, response);

        // 5. تسجيل العملية
        await tarhalDB.from('push_notification_logs').insert({
            driver_id: driverId,
            ride_id: rideId,
            success: true,
            sent_at: new Date().toISOString()
        });

        return res.status(200).json({ success: true, message: 'FCM Sent Successfully' });

    } catch (error) {
        console.error('❌ FCM Error:', error);
        return res.status(500).json({ success: false, error: error.message });
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
    return types[type] || 'مركبة زونا';
}
