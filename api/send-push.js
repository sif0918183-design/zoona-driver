import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

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
        const { driverId, rideId, customerName, vehicleType, amount } = req.body;

        // --- صمام الأمان لمنع تكرار الإشعار ---
        if (rideId) {
            const { data: ride } = await tarhalDB
                .from('rides')
                .select('status')
                .eq('id', rideId)
                .single();

            const allowedStatuses = ['searching', 'pending', 'awaiting_driver_acceptance'];
            
            if (ride && !allowedStatuses.includes(ride.status)) {
                console.log(`🚫 تم منع التكرار: الرحلة في حالة ${ride.status}`);
                return res.status(200).json({ 
                    success: false, 
                    message: 'تم التعامل مع هذه الرحلة مسبقاً، لن يتم إرسال إشعار مكرر.' 
                });
            }
        }

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
            console.log(`🚫 Driver ${driverId} is banned until ${driver.ban_until}. Preventing push notification.`);
            return res.status(403).json({ success: false, error: 'حساب السائق معلق ومحظور حالياً من العمل.' });
        }

        if (!driver.fcm_token) {
            return res.status(404).json({ error: 'Token missing' });
        }

        // ✅ بناء البيانات (بدون تغييرات جذرية)
        const message = {
            token: driver.fcm_token,
            notification: {
                title: '🚨 طلب رحلة جديد - تراكا',
                body: `عميل: ${customerName || 'عميل'}\nالأجرة: ${amount || '0'} SDG`,
            },
            data: {
                ride_id: String(rideId || ''),
                type: 'RIDE_REQUEST',
                customer_name: customerName || 'عميل',
                amount: String(amount || '0'),
                vehicle_type: vehicleType || '',
            },
            android: {
                priority: 'high',
                notification: {
                    channelId: 'emergency_channel_v15',
                    sound: 'ride_request_sound',
                    priority: 'max',
                    defaultVibrateTimings: true,
                    visibility: 'public',
                    sticky: true,
                }
            }
        };

        console.log('📤 إرسال إشعار RIDE_REQUEST للسائق:', driverId);
        console.log('📋 ride_id:', rideId);

        // ✅ إرسال الإشعار
        const response = await admin.messaging().send(message);
        console.log('✅ تم إرسال الإشعار:', response);
        
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