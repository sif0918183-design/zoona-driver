import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

// --- وضع المفاتيح يدوياً لضمان العمل الفوري ---
const SUPABASE_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
// هذا المفتاح الذي كان مفقوداً وتسبب في توقف النظام
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

// تهيئة Firebase Admin
if (!admin.apps.length) {
    try {
        // إذا كان لديك مفتاح Firebase في البيئة استخدمه، وإلا سيظهر تنبيه في السجلات
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
        }
    } catch (error) {
        console.error('❌ Firebase Init Error:', error);
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

    try {
        const { driverId, rideId, customerName, amount } = req.body;

        // 1. فحص الحالة (تم إضافة searching لضمان عمل النظام)
        if (rideId) {
            const { data: ride } = await tarhalDB
                .from('rides')
                .select('status')
                .eq('id', rideId)
                .single();

            if (ride) {
                const allowed = ['searching', 'pending', 'awaiting_driver_acceptance'];
                if (!allowed.includes(ride.status)) {
                    return res.status(200).json({ success: false, message: 'Ride status invalid' });
                }
            }
        }

        // 2. جلب التوكن
        const { data: driver } = await tarhalDB
            .from('drivers')
            .select('fcm_token')
            .eq('id', driverId)
            .single();

        if (!driver?.fcm_token) {
            return res.status(404).json({ success: false, error: 'No token found' });
        }

        // 3. الإرسال
        const message = {
            token: driver.fcm_token,
            notification: {
                title: '🚖 طلب رحلة جديد - زونا',
                body: `عميل: ${customerName || 'طلب جديد'}\nالمبلغ: ${amount || '0'} SDG`
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
                    channelId: 'urgent_alerts_v5'
                }
            }
        };

        await admin.messaging().send(message);
        return res.status(200).json({ success: true });

    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
