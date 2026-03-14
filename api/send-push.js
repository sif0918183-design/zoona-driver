import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InpzbWx5aXlnamFnbWhuZ2xyaG9hIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjU5NDc3NjMsImV4cCI6MjA4MTUyMzc2M30.QviVinAng-ILq0umvI5UZCFEvNpP3nI0kW_hSaXxNps';

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

if (!admin.apps.length && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
        admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    } catch (e) { console.error('Firebase Error'); }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ success: false, error: 'Method not allowed' });

    try {
        const { driverId, rideId, customerName, amount } = req.body;

        // الربط المباشر: التحقق من أن الرحلة ما زالت تبحث عن سائق
        const { data: ride } = await tarhalDB.from('rides').select('status').eq('id', rideId).single();

        // السماح بحالة 'searching' لأنها الحالة التي يبدأ بها تطبيق الراكب
        const validStatuses = ['searching', 'pending', 'awaiting_driver_acceptance'];

        if (!ride || !validStatuses.includes(ride.status)) {
            return res.status(200).json({ success: false, message: 'Ride no longer available' });
        }

        const { data: driver } = await tarhalDB.from('drivers').select('fcm_token').eq('id', driverId).single();
        if (!driver?.fcm_token) return res.status(404).json({ success: false, error: 'No Token' });

        const message = {
            token: driver.fcm_token,
            notification: {
                title: '🚖 طلب رحلة جديد',
                body: `عميل: ${customerName || 'طلب جديد'}\nالأجرة: ${amount || '0'} SDG`
            },
            data: {
                ride_id: String(rideId),
                type: 'RIDE_REQUEST',
                click_action: 'FLUTTER_NOTIFICATION_CLICK'
            },
            android: { priority: 'high', notification: { sound: 'ride_request_sound', channelId: 'urgent_alerts_v5' } }
        };

        await admin.messaging().send(message);
        return res.status(200).json({ success: true });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
}
