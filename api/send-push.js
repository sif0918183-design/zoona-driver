import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

// المفاتيح المباشرة لضمان الربط الفوري
const SUPABASE_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    } catch (error) { console.error('Firebase Error'); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { driverId, rideId, customerName, vehicleType, amount } = req.body;

        // --- صمام الأمان لمنع تكرار الإشعار (Ghosting Fix) ---
        if (rideId) {
            const { data: ride } = await tarhalDB
                .from('rides')
                .select('status')
                .eq('id', rideId)
                .single();

            // القائمة المسموح لها بإرسال إشعارات فقط
            const allowedStatuses = ['searching', 'pending', 'awaiting_driver_acceptance'];
            
            if (ride && !allowedStatuses.includes(ride.status)) {
                console.log(`🚫 تم منع التكرار: الرحلة في حالة ${ride.status}`);
                return res.status(200).json({ 
                    success: false, 
                    message: 'تم التعامل مع هذه الرحلة مسبقاً، لن يتم إرسال إشعار مكرر.' 
                });
            }
        }

        // جلب توكن السائق
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('fcm_token')
            .eq('id', driverId)
            .single();

        if (dbError || !driver?.fcm_token) return res.status(404).json({ error: 'Token missing' });

        // بناء الرسالة بناءً على نسختك المستقرة
        const message = {
            token: driver.fcm_token,
            notification: {
                title: '🚖 طلب رحلة جديد - تراكا',
                body: `عميل: ${customerName || 'عميل'}\nالأجرة: ${amount || '0'} SDG`,
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

        await admin.messaging().send(message);
        
        return res.status(200).json({ success: true, message: 'تم الإرسال بنجاح ومنع التكرار مستقبلاً.' });

    } catch (error) {
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
