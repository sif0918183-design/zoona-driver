import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zsmlyiygjagmhnglrhoa.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
        }
    } catch (e) { console.error('Firebase init error:', e.message); }
}

async function getDriverFcm(driverId) {
    const { data } = await db.from('drivers').select('fcm_token,full_name').eq('id', driverId).single();
    return data;
}

async function getPassengerFcm(customerId) {
    const { data } = await db.from('customers').select('fcm_token,full_name').eq('id', customerId).single();
    return data;
}

async function sendQuietPush(token, title, body, data = {}) {
    if (!token) return { skipped: true, reason: 'no_token' };
    const message = {
        token,
        notification: { title, body },
        data: { ...data, click_action: 'FLUTTER_NOTIFICATION_CLICK' },
        android: {
            priority: 'high',
            notification: {
                sound: 'default',
                channelId: 'travel_notifications',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK'
            }
        },
        apns: {
            payload: {
                aps: { sound: 'default', badge: 1 }
            }
        }
    };
    await admin.messaging().send(message);
    return { sent: true };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { type, rideId, driverId, senderType, senderName, messagePreview, fromCity, toCity } = req.body;

        if (!type) return res.status(400).json({ error: 'type is required' });

        if (!admin.apps.length) {
            return res.status(200).json({ success: false, reason: 'firebase_not_initialized' });
        }

        // ─────────────────────────────────────────────
        // 1. DRIVER_OFFER → driver accepted ride → notify passenger
        // ─────────────────────────────────────────────
        if (type === 'DRIVER_OFFER') {
            if (!rideId) return res.status(400).json({ error: 'rideId required' });

            const { data: ride } = await db.from('ride_requests')
                .select('customer_id, from_city, to_city')
                .eq('id', rideId).single();

            if (!ride?.customer_id) return res.status(404).json({ error: 'ride or customer not found' });

            const passenger = await getPassengerFcm(ride.customer_id);
            if (!passenger?.fcm_token) return res.status(200).json({ success: false, reason: 'no_passenger_token' });

            const result = await sendQuietPush(
                passenger.fcm_token,
                '🚗 سائق قَبِل رحلتك - تراكا',
                `رحلة: ${ride.from_city || ''} → ${ride.to_city || ''}\nاضغط لاختيار السائق`,
                { type: 'DRIVER_OFFER', ride_id: String(rideId) }
            );
            return res.status(200).json({ success: true, ...result });
        }

        // ─────────────────────────────────────────────
        // 2. DRIVER_SELECTED → passenger chose driver → notify driver
        // ─────────────────────────────────────────────
        if (type === 'DRIVER_SELECTED') {
            if (!driverId) return res.status(400).json({ error: 'driverId required' });

            const driver = await getDriverFcm(driverId);
            if (!driver?.fcm_token) return res.status(200).json({ success: false, reason: 'no_driver_token' });

            const routeText = (fromCity && toCity) ? `${fromCity} → ${toCity}` : 'الرحلة';
            const result = await sendQuietPush(
                driver.fcm_token,
                '✅ تم اختيارك للرحلة - تراكا',
                `الراكب اختارك لرحلة ${routeText}\nاضغط لفتح تفاصيل الرحلة`,
                { type: 'DRIVER_SELECTED', ride_id: String(rideId || '') }
            );
            return res.status(200).json({ success: true, ...result });
        }

        // ─────────────────────────────────────────────
        // 3. NEW_CHAT_MESSAGE → notify the other party
        // ─────────────────────────────────────────────
        if (type === 'NEW_CHAT_MESSAGE') {
            if (!rideId || !senderType) return res.status(400).json({ error: 'rideId and senderType required' });

            const preview = messagePreview ? messagePreview.substring(0, 60) : 'رسالة جديدة';
            const sender = senderName || (senderType === 'driver' ? 'السائق' : 'الراكب');

            if (senderType === 'driver') {
                // Notify passenger
                const { data: ride } = await db.from('ride_requests')
                    .select('customer_id').eq('id', rideId).single();

                if (!ride?.customer_id) return res.status(200).json({ success: false, reason: 'no_customer_id' });

                const passenger = await getPassengerFcm(ride.customer_id);
                if (!passenger?.fcm_token) return res.status(200).json({ success: false, reason: 'no_passenger_token' });

                const result = await sendQuietPush(
                    passenger.fcm_token,
                    `💬 رسالة من السائق - تراكا`,
                    preview,
                    { type: 'NEW_CHAT_MESSAGE', ride_id: String(rideId) }
                );
                return res.status(200).json({ success: true, ...result });

            } else {
                // senderType === 'passenger' → notify driver
                // First try ride_requests.driver_id, then fall back to latest accepted acceptance
                const { data: ride } = await db.from('ride_requests')
                    .select('driver_id').eq('id', rideId).single();

                let recipientDriverId = ride?.driver_id;

                if (!recipientDriverId) {
                    // No driver selected yet — find the most recent driver who accepted
                    const { data: acc } = await db.from('ride_driver_acceptances')
                        .select('driver_id')
                        .eq('ride_id', rideId)
                        .eq('status', 'accepted')
                        .order('accepted_at', { ascending: false })
                        .limit(1)
                        .single();
                    recipientDriverId = acc?.driver_id;
                }

                if (!recipientDriverId) return res.status(200).json({ success: false, reason: 'no_driver_id' });

                const driver = await getDriverFcm(recipientDriverId);
                if (!driver?.fcm_token) return res.status(200).json({ success: false, reason: 'no_driver_token' });

                const result = await sendQuietPush(
                    driver.fcm_token,
                    `💬 رسالة من الراكب - تراكا`,
                    preview,
                    { type: 'NEW_CHAT_MESSAGE', ride_id: String(rideId) }
                );
                return res.status(200).json({ success: true, ...result });
            }
        }

        return res.status(400).json({ error: `unknown type: ${type}` });

    } catch (err) {
        console.error('travel-push error:', err);
        return res.status(500).json({ error: err.message });
    }
}
