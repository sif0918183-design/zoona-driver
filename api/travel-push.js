import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

const CITY_COORDINATES = {
    'الخرطوم': { lat: 15.5007, lng: 32.5599 },
    'مدني': { lat: 14.4013, lng: 33.5186 },
    'القضارف': { lat: 14.0345, lng: 35.3901 },
    'كسلا': { lat: 15.4510, lng: 36.3996 },
    'شندي': { lat: 16.6946, lng: 33.4243 },
    'الدامر': { lat: 17.5925, lng: 33.9749 },
    'عطبرة': { lat: 17.6976, lng: 33.9882 },
    'الدبة': { lat: 18.0538, lng: 30.9504 },
    'دنقلا': { lat: 19.1706, lng: 30.4725 },
    'بورتسودان': { lat: 19.6175, lng: 37.2158 },
    'سنار': { lat: 13.5684, lng: 33.5672 },
    'سنجة': { lat: 13.1517, lng: 33.9314 },
    'الدمازين': { lat: 11.7699, lng: 34.3312 },
    'كوستي': { lat: 13.1629, lng: 32.6635 },
    'ابوحمد': { lat: 19.5310, lng: 33.3197 },
    'سنكات': { lat: 18.8354, lng: 36.8373 },
    'الحصاحيصا': { lat: 14.7431, lng: 33.2929 },
    'الأبيض': { lat: 13.1789, lng: 30.2172 }
};

function getDistanceKm(lat1, lon1, lat2, lon2) {
    const R = 6371; // Radius of the earth in km
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat/2) * Math.sin(dLat/2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const d = R * c; // Distance in km
    return d;
}

function matchCarType(reqCategory, driverCarType) {
    if (!reqCategory || !driverCarType) return true; // fallback to sending if not specified
    const rc = reqCategory.toLowerCase();
    const dc = driverCarType.toLowerCase();
    if (rc.includes('اقتصادي') || rc.includes('economy')) {
        return dc.includes('economy') || dc.includes('economic') || dc.includes('اقتصادي');
    }
    if (rc.includes('مريح') || rc.includes('سيدان') || rc.includes('صالون') || rc.includes('comfortable') || rc.includes('sedan')) {
        return dc.includes('sedan') || dc.includes('comfortable') || dc.includes('مريح') || dc.includes('صالون');
    }
    if (rc.includes('عالي') || rc.includes('suv') || rc.includes('عائلي') || rc.includes('van') || rc.includes('family')) {
        return dc.includes('family') || dc.includes('suv') || dc.includes('van') || dc.includes('عالي') || dc.includes('عائلي');
    }
    return true; // default fallback to match
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
                {
                    type: 'NEW_CHAT_MESSAGE',
                    ride_id: String(rideId),
                    url: `/passenger_app/travel-platform.html#chat-${rideId}`
                }
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
                {
                    type: 'NEW_CHAT_MESSAGE',
                    ride_id: String(rideId),
                    url: `/driver_app/travel-platform.html#chat-${rideId}`
                }
                );
                return res.status(200).json({ success: true, ...result });
            }
        }

        // ─────────────────────────────────────────────
        // 4. NEW_TRAVEL_REQUEST → notify all matching drivers in fromCity range
        // ─────────────────────────────────────────────
        if (type === 'NEW_TRAVEL_REQUEST') {
            const { fromCity, toCity, vehicleCategory, rideId } = req.body;

            if (!fromCity) return res.status(400).json({ error: 'fromCity is required' });

            const cityCoords = CITY_COORDINATES[fromCity];
            if (!cityCoords) {
                return res.status(200).json({ success: false, reason: `City ${fromCity} coordinates not mapped` });
            }

            // Get all driver locations
            const { data: locations, error: locError } = await db
                .from('driver_locations')
                .select('driver_id, lat, lng, car_type');

            if (locError) throw locError;
            if (!locations || locations.length === 0) {
                return res.status(200).json({ success: true, count: 0, reason: 'No driver locations found' });
            }

            // Filter drivers whose last known location is within 50 km of cityCoords
            const targetDrivers = [];
            for (const loc of locations) {
                if (loc.lat && loc.lng) {
                    const dist = getDistanceKm(cityCoords.lat, cityCoords.lng, parseFloat(loc.lat), parseFloat(loc.lng));
                    if (dist <= 50) { // 50 km radius range
                        if (matchCarType(vehicleCategory, loc.car_type)) {
                            targetDrivers.push(loc.driver_id);
                        }
                    }
                }
            }

            if (targetDrivers.length === 0) {
                return res.status(200).json({ success: true, count: 0, reason: 'No matching drivers in city range' });
            }

            // Fetch FCM tokens of those matching drivers
            const { data: drivers, error: driverError } = await db
                .from('drivers')
                .select('fcm_token, full_name')
                .in('id', targetDrivers);

            if (driverError) throw driverError;

            // Send push to each matching driver
            let sentCount = 0;
            for (const driver of drivers) {
                if (driver.fcm_token) {
                    try {
                        await sendQuietPush(
                            driver.fcm_token,
                            `🚨 طلب سفر جديد - من ${fromCity}`,
                            `أحد الركاب نشر طلب رحلة سفرية من ${fromCity} إلى ${toCity || 'وجهته'}. اضغط للتفاصيل.`,
                            {
                                type: 'DRIVER_OFFER', // recognized travel platform type in native app
                                ride_id: String(rideId || ''),
                                url: '/driver_app/travel-platform.html'
                            }
                        );
                        sentCount++;
                    } catch (err) {
                        console.warn(`Failed to send push to driver token ${driver.fcm_token}:`, err.message);
                    }
                }
            }

            return res.status(200).json({ success: true, count: sentCount });
        }

        return res.status(400).json({ error: `unknown type: ${type}` });

    } catch (err) {
        console.error('travel-push error:', err);
        return res.status(500).json({ error: err.message });
    }
}
