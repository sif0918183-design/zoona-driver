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
    // ========== ولاية الخرطوم ==========
    'الخرطوم': { lat: 15.5007, lng: 32.5599 },
    'أم درمان': { lat: 15.6500, lng: 32.4833 },
    'بحري': { lat: 15.6500, lng: 32.5333 },
    'الخرطوم بحري': { lat: 15.6500, lng: 32.5333 },
    'الحلفاية': { lat: 15.6000, lng: 32.5000 },
    'كرري': { lat: 15.6667, lng: 32.5167 },
    'أم بادر': { lat: 15.6000, lng: 32.5000 },
    'الطائف': { lat: 15.4833, lng: 32.6000 },
    
    // ========== ولاية الجزيرة ==========
    'مدني': { lat: 14.4012, lng: 33.5199 },
    'ود مدني': { lat: 14.4012, lng: 33.5199 },
    'الحصاحيصا': { lat: 14.7431, lng: 33.2981 },
    'الكاملين': { lat: 14.8500, lng: 33.3500 },
    'أبو عشر': { lat: 14.5000, lng: 33.3000 },
    
    // ========== ولاية القضارف ==========
    'القضارف': { lat: 14.0349, lng: 35.3834 },
    'فشقة': { lat: 14.5000, lng: 35.5000 },
    'قلع النحل': { lat: 14.0000, lng: 35.2000 },
    
    // ========== ولاية كسلا ==========
    'كسلا': { lat: 15.4556, lng: 36.4000 },
    'خشم القربة': { lat: 15.6333, lng: 36.2500 },
    'حلفا الجديدة': { lat: 15.3000, lng: 35.6000 },
    'أروما': { lat: 15.8000, lng: 36.1000 },
    'تلكوك': { lat: 15.5000, lng: 36.0000 },
    
    // ========== ولاية نهر النيل ==========
    'شندي': { lat: 16.6919, lng: 33.4342 },
    'الدامر': { lat: 17.5922, lng: 33.9592 },
    'عطبرة': { lat: 17.6950, lng: 33.9820 },
    'ابوحمد': { lat: 19.5333, lng: 33.3167 },
    'أبو حمد': { lat: 19.5333, lng: 33.3167 },
    'بربر': { lat: 18.2167, lng: 33.9833 },
    'المتمة': { lat: 16.5167, lng: 33.3500 },
    
    // ========== ولاية الشمالية ==========
    'الدبة': { lat: 18.0500, lng: 30.9500 },
    'دنقلا': { lat: 19.1667, lng: 30.4833 },
    'مروي': { lat: 18.4833, lng: 31.8167 },
    'كرمة': { lat: 19.0000, lng: 30.4167 },
    'أرقو': { lat: 19.5000, lng: 30.4167 },
    'وادي حلفا': { lat: 21.8000, lng: 31.3500 },
    
    // ========== ولاية البحر الأحمر ==========
    'بورتسودان': { lat: 19.6158, lng: 37.2164 },
    'سنكات': { lat: 18.8333, lng: 36.8333 },
    'سواكن': { lat: 19.1000, lng: 37.3167 },
    'حلايب': { lat: 22.2333, lng: 36.6500 },
    
    // ========== ولاية النيل الأبيض ==========
    'كوستي': { lat: 13.1629, lng: 32.6635 },
    'ربك': { lat: 13.1808, lng: 32.7438 },
    'الدويم': { lat: 13.2333, lng: 32.3167 },
    'القويع': { lat: 13.0000, lng: 32.5000 },
    
    // ========== ولاية سنار ==========
    'سنار': { lat: 13.5500, lng: 33.5667 },
    'سنجة': { lat: 13.1500, lng: 33.9333 },
    'الدندر': { lat: 13.2000, lng: 33.7000 },
    'أبو حجار': { lat: 13.0000, lng: 33.8000 },
    
    // ========== ولاية النيل الأزرق ==========
    'الدمازين': { lat: 11.7667, lng: 34.3500 },
    'الروصيرص': { lat: 11.8500, lng: 34.3833 },
    'القيسان': { lat: 11.5000, lng: 34.1000 },
    'باو': { lat: 11.0000, lng: 34.1000 },
    
    // ========== ولاية شمال كردفان ==========
    'الأبيض': { lat: 13.1842, lng: 30.2167 },
    'أم روابة': { lat: 13.3000, lng: 30.6000 },
    'النهود': { lat: 12.7000, lng: 30.3500 },
    'سدرة': { lat: 13.0000, lng: 30.0000 },
    'جبرة الشيخ': { lat: 13.2000, lng: 30.0000 },
    
    // ========== ولاية جنوب كردفان ==========
    'كادقلي': { lat: 11.0167, lng: 29.7167 },
    'الدلنج': { lat: 11.6667, lng: 29.4500 },
    'أبو جبيهة': { lat: 11.4500, lng: 29.6500 },
    'اللقوة': { lat: 11.2000, lng: 29.3000 },
    'تالودي': { lat: 10.6333, lng: 29.4000 },
    
    // ========== ولاية غرب كردفان ==========
    'الفحل': { lat: 12.1000, lng: 29.4000 },
    'المجد': { lat: 12.0000, lng: 29.0000 },
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

            // Fetch drivers with their latest location from driver_locations
            const { data: drivers, error: driversErr } = await db
                .from('drivers')
                .select(`
                    id, 
                    fcm_token, 
                    city, 
                    is_banned, 
                    ban_until, 
                    travel_notifications_enabled,
                    driver_locations (
                        lat,
                        lng,
                        location_point,
                        updated_at
                    )
                `)
                .not('fcm_token', 'is', null)
                .neq('fcm_token', 'false');

            if (driversErr || !drivers || drivers.length === 0) {
                console.error('Error fetching drivers:', driversErr);
                return res.status(200).json({ success: false, reason: 'no_drivers_found' });
            }

            const cityCoords = CITY_COORDINATES[fromCity] || null;
            let sentCount = 0;
            let matchedCount = 0;

            for (const driver of drivers) {
                // Skip if banned
                const isBanned = driver.is_banned && driver.ban_until && new Date(driver.ban_until) > new Date();
                if (isBanned) {
                    console.log(`🚫 Driver ${driver.id} is banned, skipping`);
                    continue;
                }

                // Skip if driver disabled travel notifications
                if (driver.travel_notifications_enabled === false) {
                    console.log(`🔕 Driver ${driver.id} has travel notifications disabled, skipping`);
                    continue;
                }

                // Get the latest location from driver_locations
                let driverLat = null;
                let driverLng = null;
                
                if (driver.driver_locations && driver.driver_locations.length > 0) {
                    // Sort locations by updated_at and get the latest
                    const sortedLocations = driver.driver_locations.sort((a, b) => 
                        new Date(b.updated_at) - new Date(a.updated_at)
                    );
                    const latestLocation = sortedLocations[0];
                    driverLat = parseFloat(latestLocation.lat);
                    driverLng = parseFloat(latestLocation.lng);
                }

                // City matching logic
                let matchesCity = false;

                // 1. Text matching (driver's city)
                if (driver.city && (driver.city.includes(fromCity) || fromCity.includes(driver.city))) {
                    matchesCity = true;
                    console.log(`✅ Driver ${driver.id} matched by city: ${driver.city} ↔ ${fromCity}`);
                } 
                // 2. Location matching (if coordinates available)
                else if (cityCoords && driverLat !== null && driverLng !== null) {
                    const dist = getHaversineDistance(
                        cityCoords.lat,
                        cityCoords.lng,
                        driverLat,
                        driverLng
                    );
                    // Within 60 km radius
                    if (dist <= 60) {
                        matchesCity = true;
                        console.log(`📍 Driver ${driver.id} matched by location (${dist.toFixed(1)} km from ${fromCity})`);
                    }
                } 
                // 3. Fallback: if no city and no location, send anyway
                else if (!driver.city && driverLat === null) {
                    matchesCity = true;
                    console.log(`⚠️ Driver ${driver.id} has no city or location, sending as fallback`);
                }

                if (matchesCity) {
                    matchedCount++;
                    if (driver.fcm_token) {
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
                            console.log(`✅ Push sent to driver ${driver.id}`);
                        } catch (pushErr) {
                            console.error(`❌ Push failed for driver ${driver.id}:`, pushErr.message);
                        }
                    } else {
                        console.log(`⚠️ Driver ${driver.id} matched but has no FCM token`);
                    }
                }
            }

            console.log(`📊 NEW_TRAVEL_REQUEST stats: ${matchedCount} matched, ${sentCount} notifications sent out of ${drivers.length} drivers`);
            return res.status(200).json({ success: true, sentCount, matchedCount, totalDrivers: drivers.length });
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