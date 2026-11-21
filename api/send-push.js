import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { verifyToken } from './_token-utils.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    } catch (error) { 
        console.error('Firebase Error:', error); 
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { driverId, rideId } = req.body;
        let session;
        try {
            session = verifyToken(req);
        } catch (tokenError) {
            return res.status(401).json({ success: false, error: tokenError.message });
        }

        if (session.role !== 'passenger') {
            return res.status(403).json({ success: false, error: 'هذه العملية متاحة للراكب فقط' });
        }
        if (!driverId || !rideId) {
            return res.status(400).json({ success: false, error: 'driverId and rideId are required' });
        }

        // لا نعتمد على بيانات الراكب أو السائق القادمة من المتصفح؛ نتحقق من ملكية الرحلة وتعيين السائق من قاعدة البيانات.
        const { data: ride, error: rideError } = await tarhalDB
            .from('rides')
            .select('passenger_id, driver_id, status, passenger_name, amount, vehicle_category')
            .eq('id', rideId)
            .maybeSingle();

        if (rideError || !ride) {
            return res.status(404).json({ success: false, error: 'Ride not found' });
        }
        if (String(ride.passenger_id) !== session.id) {
            return res.status(403).json({ success: false, error: 'لا تملك صلاحية إرسال إشعار لهذه الرحلة' });
        }
        if (String(ride.driver_id) !== String(driverId)) {
            return res.status(403).json({ success: false, error: 'السائق المحدد غير مرتبط بهذه الرحلة' });
        }

        // --- صمام الأمان لمنع تكرار الإشعار (Ghosting Fix) ---
        const allowedStatuses = ['searching', 'pending', 'awaiting_driver_acceptance'];
        if (!allowedStatuses.includes(ride.status)) {
            console.log(` تم منع التكرار: الرحلة في حالة ${ride.status}`);
            return res.status(200).json({
                success: false,
                message: 'تم التعامل مع هذه الرحلة مسبقاً، لن يتم إرسال إشعار مكرر.'
            });
        }

        const customerName = ride.passenger_name || 'عميل';
        const vehicleType = ride.vehicle_category || '';
        const amount = ride.amount || '0';

        // جلب توكن وحالة حظر السائق
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('fcm_token, is_banned, ban_until')
            .eq('id', driverId)
            .single();

        if (dbError || !driver) {
            return res.status(404).json({ error: 'Driver not found' });
        }

        const isBanned = driver.is_banned && driver.ban_until && new Date(driver.ban_until) > new Date();
        if (isBanned) {
            console.log(` Driver ${driverId} is banned until ${driver.ban_until}. Preventing push notification.`);
            return res.status(403).json({ success: false, error: 'حساب السائق معلق ومحظور حالياً من العمل.' });
        }

        if (!driver.fcm_token) {
            return res.status(404).json({ error: 'Token missing' });
        }

        // ✅ بناء الرسالة المحسّنة
        const message = {
            token: driver.fcm_token,
            notification: {
                title: ' طلب رحلة جديد - تراكا',
                body: `عميل: ${customerName || 'عميل'}\nالأجرة: ${amount || '0'} SDG`,
            },
            data: {
                ride_id: String(rideId || ''),
                type: 'RIDE_REQUEST',
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
                customer_name: customerName || 'عميل',
                amount: String(amount || '0'),
                vehicle_type: vehicleType || '',
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'emergency_channel_default',
                    sound: 'default',
                    priority: 'max',
                    defaultVibrateTimings: true,
                    visibility: 'public',
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                }
            },
            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                        'mutable-content': 1,
                        category: 'RIDE_REQUEST_CATEGORY',
                        'interruption-level': 'critical',
                        'relevance-score': 1.0,
                    }
                }
            }
        };

        // ✅ إرسال الإشعار مع محاولة إعادة المحاولة عند الفشل
        let response;
        let retries = 3;
        while (retries > 0) {
            try {
                response = await admin.messaging().send(message);
                console.log('✅ تم إرسال الإشعار:', response);
                break;
            } catch (error) {
                retries--;
                console.log(`⚠️ محاولة إعادة الإرسال (${3 - retries}/3):`, error.message);
                if (retries === 0) throw error;
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
        
        return res.status(200).json({ 
            success: true, 
            message: 'تم الإرسال بنجاح',
            response: response
        });

    } catch (error) {
        console.error('❌ خطأ في إرسال الإشعار:', error);
        return res.status(500).json({ error: error.message });
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
    return types[type] || 'سيارة';
}