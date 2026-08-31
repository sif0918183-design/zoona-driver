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

const CITY_COORDINATES = {
    'الخرطوم': { lat: 15.5007, lng: 32.5599 },
    'أم درمان': { lat: 15.6500, lng: 32.4833 },
    'بحري': { lat: 15.6500, lng: 32.5333 },
    'الخرطوم بحري': { lat: 15.6500, lng: 32.5333 },
    'مدني': { lat: 14.4012, lng: 33.5199 },
    'ود مدني': { lat: 14.4012, lng: 33.5199 },
    'القضارف': { lat: 14.0349, lng: 35.3834 },
    'كسلا': { lat: 15.4556, lng: 36.4000 },
    'شندي': { lat: 16.6919, lng: 33.4342 },
    'الدامر': { lat: 17.5922, lng: 33.9592 },
    'عطبرة': { lat: 17.6950, lng: 33.9820 },
    'الدبة': { lat: 18.0500, lng: 30.9500 },
    'دنقلا': { lat: 19.1667, lng: 30.4833 },
    'بورتسودان': { lat: 19.6158, lng: 37.2164 },
    'كوستي': { lat: 13.1629, lng: 32.6635 },
    'ابوحمد': { lat: 19.5333, lng: 33.3167 },
    'سنكات': { lat: 18.8333, lng: 36.8333 },
    'الحصاحيصا': { lat: 14.7431, lng: 33.2981 },
    'الأبيض': { lat: 13.1842, lng: 30.2167 },
    'الدمازين': { lat: 11.7667, lng: 34.3500 },
    'سنار': { lat: 13.5500, lng: 33.5667 },
    'ربك': { lat: 13.1808, lng: 32.7438 }
};

function getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

async function getDriverFcm(driverId) {
    const { data } = await db.from('drivers').select('fcm_token,full_name,is_banned,ban_until').eq('id', driverId).single();
    if (data) {
        const isBanned = data.is_banned && data.ban_until && new Date(data.ban_until) > new Date();
        if (isBanned) {
            console.log(`🚫 Driver ${driverId} is banned until ${data.ban_until}. Preventing travel push notification.`);
            return null;
        }
    }
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
        const { type, rideId, driverId, senderType, senderName, messagePreview, fromCity, toCity, vehicleCategory } = req.body;

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
                `رحلة: ${ride.from_city || ''} → ${ride.to_city || ''}\nاضغط لمراجعة السائقين والقبول`,
                {
                    type: 'DRIVER_OFFER',
                    ride_id: String(rideId),
                    url: '/passenger_app/travel-platform.html#my-rides'
                }
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
                {
                    type: 'DRIVER_SELECTED',
                    ride_id: String(rideId || ''),
                    url: '/driver_app/travel-platform.html'
                }
            );
            return res.status(200).json({ success: true, ...result });
        }

        // ─────────────────────────────────────────────
        // 3. NEW_CHAT_MESSAGE → notify the other party
        // ─────────────────────────────────────────────
        if (type === 'NEW_CHAT_MESSAGE') {
            if (!rideId || !senderType) return res.status(400).json({ error: 'rideId and senderType required' });

            const preview = messagePreview ? messagePreview.substring(0, 60) : 'رسالة جديدة';

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
                const { data: ride } = await db.from('ride_requests')
                    .select('driver_id').eq('id', rideId).single();

                let recipientDriverId = ride?.driver_id;

                if (!recipientDriverId) {
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
        // 4. NEW_TRAVEL_REQUEST → notify drivers in city scope
        // ─────────────────────────────────────────────
        if (type === 'NEW_TRAVEL_REQUEST') {
            if (!fromCity) return res.status(400).json({ error: 'fromCity is required' });

            // Fetch drivers who have enabled travel notifications and have fcm_token
            const { data: drivers, error: driversErr } = await db
                .from('drivers')
                .select('id, fcm_token, current_lat, current_lon, city, is_banned, ban_until, travel_notifications_enabled')
                .not('fcm_token', 'is', null)
                .neq('fcm_token', 'false');

            if (driversErr || !drivers || drivers.length === 0) {
                return res.status(200).json({ success: false, reason: 'no_drivers_found' });
            }

            const cityCoords = CITY_COORDINATES[fromCity] || null;
            let sentCount = 0;

            for (const driver of drivers) {
                // Skip if banned
                const isBanned = driver.is_banned && driver.ban_until && new Date(driver.ban_until) > new Date();
                if (isBanned) continue;

                // Skip if driver disabled travel notifications
                if (driver.travel_notifications_enabled === false) continue;

                // City scope matching logic
                let matchesCity = false;

                if (driver.city && (driver.city.includes(fromCity) || fromCity.includes(driver.city))) {
                    matchesCity = true;
                } else if (cityCoords && driver.current_lat && driver.current_lon) {
                    const dist = getHaversineDistance(
                        cityCoords.lat,
                        cityCoords.lng,
                        parseFloat(driver.current_lat),
                        parseFloat(driver.current_lon)
                    );
                    if (dist <= 60) { // within 60 km
                        matchesCity = true;
                    }
                } else {
                    // Fallback: notify if city not specified or unmapped
                    matchesCity = true;
                }

                if (matchesCity && driver.fcm_token) {
                    try {
                        await sendQuietPush(
                            driver.fcm_token,
                            '🚗 رحلة سفرية جديدة - تراكا',
                            `طلب رحلة سفرية جديد من ${fromCity} إلى ${toCity || ''}`,
                            {
                                type: 'NEW_TRAVEL_REQUEST',
                                ride_id: String(rideId || ''),
                                url: '/driver_app/travel-platform.html'
                            }
                        );
                        sentCount++;
                    } catch (pushErr) {
                        console.error(`Push failed for driver ${driver.id}:`, pushErr.message);
                    }
                }
            }

            return res.status(200).json({ success: true, sentCount });
        }

        // ─────────────────────────────────────────────
        // 5. TRIP_CANCELLED / RIDE_CANCELLED → notify driver
        // ─────────────────────────────────────────────
        if (type === 'TRIP_CANCELLED' || type === 'RIDE_CANCELLED') {
            let targetDriverId = driverId;

            if (!targetDriverId && rideId) {
                const { data: ride } = await db.from('ride_requests')
                    .select('driver_id')
                    .eq('id', rideId)
                    .single();

                targetDriverId = ride?.driver_id;

                if (!targetDriverId) {
                    const { data: acc } = await db.from('ride_driver_acceptances')
                        .select('driver_id')
                        .eq('ride_id', rideId)
                        .eq('status', 'accepted')
                        .order('accepted_at', { ascending: false })
                        .limit(1)
                        .single();
                    targetDriverId = acc?.driver_id;
                }
            }

            if (!targetDriverId) return res.status(200).json({ success: false, reason: 'no_driver_id' });

            const driver = await getDriverFcm(targetDriverId);
            if (!driver?.fcm_token) return res.status(200).json({ success: false, reason: 'no_driver_token' });

            const routeText = (fromCity && toCity) ? `(${fromCity} → ${toCity})` : '';
            const result = await sendQuietPush(
                driver.fcm_token,
                '❌ إلغاء رحلة سفرية - تراكا',
                `قام الراكب بإلغاء الرحلة السفرية ${routeText}`,
                {
                    type: 'TRIP_CANCELLED',
                    ride_id: String(rideId || ''),
                    url: '/driver_app/travel-platform.html#my-trips'
                }
            );
            return res.status(200).json({ success: true, ...result });
        }

        return res.status(400).json({ error: `unknown type: ${type}` });

    } catch (err) {
        console.error('travel-push error:', err);
        return res.status(500).json({ error: err.message });
    }
}
