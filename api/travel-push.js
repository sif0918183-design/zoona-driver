// travel-push.js - النسخة المحسنة بالكامل

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
    } catch (e) { 
        console.error('Firebase init error:', e.message); 
    }
}

// ============================================
// بيانات إحداثيات المدن السودانية
// ============================================
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

// ============================================
// دوال مساعدة محسنة
// ============================================

// ============================================
// قاموس مرادفات وأسماء المدن السودانية
// ============================================
const CITY_ALIASES = {
    // الخرطوم ومدنها
    'امدرمان': 'ام درمان',
    'ام درمان': 'ام درمان',
    'أم درمان': 'ام درمان',
    'أمدرمان': 'ام درمان',
    'الخرطوم': 'الخرطوم',
    'خرطوم': 'الخرطوم',
    'بحري': 'خرطوم بحري',
    'الخرطوم بحري': 'خرطوم بحري',
    'خرطوم بحري': 'خرطوم بحري',

    // ولاية الجزيرة
    'مدني': 'ود مدني',
    'ود مدني': 'ود مدني',
    'ودمدني': 'ود مدني',
    'الجزيرة': 'ود مدني',

    // ولاية البحر الأحمر
    'بورتسودان': 'بورتسودان',
    'بور سودان': 'بورتسودان',
    'بورت سودان': 'بورتسودان',
    'برتسودان': 'بورتسودان',

    // كردفان
    'الابيض': 'الابيض',
    'الأبيض': 'الابيض',
    'ابيض': 'الابيض',
    'أم روابة': 'ام روابة',
    'ام روابة': 'ام روابة',
    'امروابة': 'ام روابة',

    // دارفور
    'الفاشر': 'الفاشر',
    'فاشر': 'الفاشر',
    'الجنينة': 'الجنينة',
    'جنينة': 'الجنينة',
    'نيالا': 'نيالا',

    // الشمالية ونهر النيل
    'دنقلا': 'دنقلا',
    'عطبرة': 'عطبرة',
    'عطبره': 'عطبرة',
    'شندي': 'شندي',
    'شندي ': 'شندي',
    'ابوحمد': 'ابو حمد',
    'أبو حمد': 'ابو حمد',
    'ابو حمد': 'ابو حمد',
    'وادي حلفا': 'وادي حلفا',
    'حلفا': 'وادي حلفا',

    // القناة والشرق
    'القضارف': 'القضارف',
    'قضارف': 'القضارف',
    'كسلا': 'كسلا'
};

/**
 * دالة محسنة لتطبيع أسماء المدن
 * تقوم بتنظيف علامات التشكيل والهمزات والمسافات الزائدة
 */
function normalizeCityName(cityName) {
    if (!cityName) return '';
    return cityName
        .trim()
        .replace(/[\u064B-\u065F]/g, '') // إزالة التشكيل
        .replace(/[أإآآ]/g, 'ا') // توحيد الهمزات
        .replace(/ة/g, 'ه')     // توحيد التاء المربوطة
        .replace(/ى/g, 'ي')     // توحيد الألف المقصورة
        .replace(/\s+/g, ' ')   // توحيد المسافات
        .trim();
}

/**
 * الحصول على الاسم المعياري للمدينة عبر قاموس المرادفات
 */
function getCanonicalCityName(cityName) {
    if (!cityName) return '';
    const norm = normalizeCityName(cityName);
    if (CITY_ALIASES[norm]) return CITY_ALIASES[norm];

    // جرب بدون "ال" التعريف
    const noAl = norm.replace(/^ال/, '');
    if (CITY_ALIASES[noAl]) return CITY_ALIASES[noAl];

    return norm;
}

/**
 * دالة دقيقة للتحقق من تطابق المدن
 * تدعم القاموس التراكمي، التطابق التام، والتطابق المعياري
 */
function matchesCityName(cityA, cityB) {
    if (!cityA || !cityB) return false;
    
    const canonA = getCanonicalCityName(cityA);
    const canonB = getCanonicalCityName(cityB);

    if (canonA && canonB && canonA === canonB) {
        return true;
    }

    const normA = normalizeCityName(cityA);
    const normB = normalizeCityName(cityB);
    
    if (normA === normB) return true;
    
    // جرب مقارنة النصوص بدون "ال" التعريف
    const strippedA = normA.replace(/^ال/, '');
    const strippedB = normB.replace(/^ال/, '');
    
    if (strippedA && strippedB && strippedA === strippedB) return true;
    
    return false;
}

/**
 * حساب المسافة بين نقطتين باستخدام صيغة هافرسين
 */
function getHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; // نصف قطر الأرض بالكيلومتر
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * جلب معلومات السائق مع التحقق من الحظر
 */
async function getDriverFcm(driverId) {
    const { data } = await db.from('drivers')
        .select('fcm_token, full_name, is_banned, ban_until')
        .eq('id', driverId)
        .single();
    
    if (data) {
        const isBanned = data.is_banned && data.ban_until && new Date(data.ban_until) > new Date();
        if (isBanned) {
            console.log(`🚫 Driver ${driverId} is banned until ${data.ban_until}. Preventing travel push notification.`);
            return null;
        }
    }
    return data;
}

/**
 * جلب معلومات الراكب
 */
async function getPassengerFcm(customerId) {
    const { data } = await db.from('customers')
        .select('fcm_token, full_name')
        .eq('id', customerId)
        .single();
    return data;
}

/**
 * إرسال إشعار عبر FCM مع التحقق من صحة التوكن
 */
async function sendQuietPush(token, title, body, data = {}) {
    if (!token) return { skipped: true, reason: 'no_token' };
    
    // التحقق من أن التوكن ليس قيمة خاطئة
    if (token === 'false' || token === 'null' || token === 'undefined' || token === '') {
        return { skipped: true, reason: 'invalid_token' };
    }
    
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
    
    try {
        await admin.messaging().send(message);
        return { sent: true };
    } catch (error) {
        console.error('Error sending push:', error);
        return { sent: false, error: error.message };
    }
}

// ============================================
// دالة المعالج الرئيسية
// ============================================
export default async function handler(req, res) {
    // إعدادات CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const { 
            type, 
            rideId, 
            driverId, 
            senderType, 
            senderName, 
            messagePreview, 
            fromCity, 
            toCity, 
            vehicleCategory 
        } = req.body;

        if (!type) {
            return res.status(400).json({ error: 'type is required' });
        }

        if (!admin.apps.length) {
            return res.status(200).json({ 
                success: false, 
                reason: 'firebase_not_initialized' 
            });
        }

        // ============================================
        // 1. DRIVER_OFFER → سائق قبل الرحلة → إشعار للراكب
        // ============================================
        if (type === 'DRIVER_OFFER') {
            if (!rideId) {
                return res.status(400).json({ error: 'rideId required' });
            }

            const { data: ride } = await db.from('ride_requests')
                .select('customer_id, from_city, to_city')
                .eq('id', rideId)
                .single();

            if (!ride?.customer_id) {
                return res.status(404).json({ error: 'ride or customer not found' });
            }

            const passenger = await getPassengerFcm(ride.customer_id);
            if (!passenger?.fcm_token) {
                return res.status(200).json({ 
                    success: false, 
                    reason: 'no_passenger_token' 
                });
            }

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

        // ============================================
        // 2. DRIVER_SELECTED → راكب اختار سائق → إشعار للسائق
        // ============================================
        if (type === 'DRIVER_SELECTED') {
            if (!driverId) {
                return res.status(400).json({ error: 'driverId required' });
            }

            const driver = await getDriverFcm(driverId);
            if (!driver?.fcm_token) {
                return res.status(200).json({ 
                    success: false, 
                    reason: 'no_driver_token' 
                });
            }

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

        // ============================================
        // 3. NEW_CHAT_MESSAGE → إشعار للطرف الآخر
        // ============================================
        if (type === 'NEW_CHAT_MESSAGE') {
            if (!rideId || !senderType) {
                return res.status(400).json({ 
                    error: 'rideId and senderType required' 
                });
            }

            const preview = messagePreview 
                ? messagePreview.substring(0, 60) 
                : 'رسالة جديدة';

            // 3.1 السائق أرسل رسالة → إشعار للراكب
            if (senderType === 'driver') {
                const { data: ride } = await db.from('ride_requests')
                    .select('customer_id')
                    .eq('id', rideId)
                    .single();

                if (!ride?.customer_id) {
                    return res.status(200).json({ 
                        success: false, 
                        reason: 'no_customer_id' 
                    });
                }

                const passenger = await getPassengerFcm(ride.customer_id);
                if (!passenger?.fcm_token) {
                    return res.status(200).json({ 
                        success: false, 
                        reason: 'no_passenger_token' 
                    });
                }

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
            }

            // 3.2 راكب أرسل رسالة → إشعار للسائق
            if (senderType === 'passenger') {
                const { data: ride } = await db.from('ride_requests')
                    .select('driver_id')
                    .eq('id', rideId)
                    .single();

                let recipientDriverId = ride?.driver_id;

                // إذا لم يتم اختيار سائق بعد، جلب آخر سائق قبل الرحلة
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

                if (!recipientDriverId) {
                    return res.status(200).json({ 
                        success: false, 
                        reason: 'no_driver_id' 
                    });
                }

                const driver = await getDriverFcm(recipientDriverId);
                if (!driver?.fcm_token) {
                    return res.status(200).json({ 
                        success: false, 
                        reason: 'no_driver_token' 
                    });
                }

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

            return res.status(400).json({ 
                error: `invalid senderType: ${senderType}` 
            });
        }

        // ============================================
        // 4. NEW_TRAVEL_REQUEST → إشعار للسائقين في نفس المدينة
        //    (الجزء المُحسَّن)
        // ============================================
        if (type === 'NEW_TRAVEL_REQUEST') {
            if (!fromCity) {
                return res.status(400).json({ error: 'fromCity is required' });
            }

            console.log(`📢 NEW_TRAVEL_REQUEST: fromCity="${fromCity}", toCity="${toCity}", rideId="${rideId}"`);

            // 4.1 جلب جميع السائقين المؤهلين مباشرة من جدول drivers (استخدام select('*') لتفادي الأخطاء إذا كانت بعض الأعمدة اختيارية في schema)
            const { data: drivers, error: driversErr } = await db
                .from('drivers')
                .select('*')
                .not('fcm_token', 'is', null)
                .neq('fcm_token', 'false')
                .neq('fcm_token', '');

            if (driversErr) {
                console.error('❌ Error fetching drivers:', driversErr);
                return res.status(200).json({ 
                    success: false, 
                    error: driversErr.message 
                });
            }

            if (!drivers || drivers.length === 0) {
                console.log('ℹ️ No drivers with FCM tokens found');
                return res.status(200).json({ 
                    success: false, 
                    reason: 'no_drivers_found' 
                });
            }

            console.log(`🔍 [TravelPush] Ride #${rideId || 'N/A'}: Fetched ${drivers.length} drivers with tokens from DB`);
            console.log(`📍 Origin City Raw: "${fromCity}" (Normalized: "${normalizeCityName(fromCity)}", Canonical: "${getCanonicalCityName(fromCity)}")`);

            // 4.2 جلب المواقع الجغرافية الحديثة فقط للسائقين (خلال آخر 48 ساعة)
            const fortyEightHoursAgo = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
            const { data: locationsData } = await db
                .from('driver_locations')
                .select('driver_id, lat, lng, updated_at')
                .gte('updated_at', fortyEightHoursAgo)
                .order('updated_at', { ascending: false });

            // تنظيم أحدث موقع لكل سائق
            const driverLocationMap = {};
            if (locationsData && locationsData.length > 0) {
                for (const loc of locationsData) {
                    if (!driverLocationMap[loc.driver_id]) {
                        driverLocationMap[loc.driver_id] = loc;
                    }
                }
            }

            const cityCoords = CITY_COORDINATES[fromCity] || CITY_COORDINATES[normalizeCityName(fromCity)] || null;

            // 4.3 تصفية السائقين المؤهلين مع إحصائيات الاستبعاد والتتبع
            let matchedDrivers = [];
            let exclusionStats = {
                banned: 0,
                notificationsDisabled: 0,
                invalidToken: 0
            };
            let matchStats = {
                textCityMatch: 0,
                gpsDistanceMatch: 0
            };

            for (const driver of drivers) {
                // التحقق من الحظر
                const isBanned = driver.is_banned && 
                                 driver.ban_until && 
                                 new Date(driver.ban_until) > new Date();
                if (isBanned) {
                    exclusionStats.banned++;
                    console.log(`🚫 Excluded driver ${driver.id}: Banned until ${driver.ban_until}`);
                    continue;
                }

                // التحقق من تفعيل الإشعارات
                if (driver.travel_notifications_enabled === false) {
                    exclusionStats.notificationsDisabled++;
                    console.log(`🔕 Excluded driver ${driver.id}: Travel notifications disabled`);
                    continue;
                }

                // التحقق من صحة التوكن
                if (!driver.fcm_token || 
                    driver.fcm_token === 'false' || 
                    driver.fcm_token === 'null' || 
                    driver.fcm_token === '') {
                    exclusionStats.invalidToken++;
                    console.log(`⚠️ Excluded driver ${driver.id}: Invalid FCM token`);
                    continue;
                }

                let matchesCity = false;
                let matchReason = '';

                // الحصول على أي حقل نصي يمثل المدينة في السائق
                const driverCityVal = driver.city || driver.current_city || driver.working_city || driver.address || null;

                // ====== طريقة المطابقة 1: مطابقة اسم المدينة بالنص والقواميس ======
                if (driverCityVal && matchesCityName(driverCityVal, fromCity)) {
                    matchesCity = true;
                    matchReason = `Matched by normalized city name: "${driverCityVal}" ↔ "${fromCity}"`;
                    matchStats.textCityMatch++;
                    console.log(`✅ Driver ${driver.id}: ${matchReason}`);
                }

                // ====== طريقة المطابقة 2: مطابقة الموقع الجغرافي (توسيع الحساب حتى 200 كم لضمان تغطية ولايات السودان والمدن المجاورة) ======
                const loc = driverLocationMap[driver.id];
                if (!matchesCity && cityCoords && loc && loc.lat && loc.lng) {
                    const dLat = parseFloat(loc.lat);
                    const dLng = parseFloat(loc.lng);
                    if (!isNaN(dLat) && !isNaN(dLng) && dLat !== 0 && dLng !== 0) {
                        const dist = getHaversineDistance(cityCoords.lat, cityCoords.lng, dLat, dLng);
                        // نطاق 200 كم يشمل بورتسودان والمدن المحيطة بها في البحر الأحمر
                        if (dist <= 200) {
                            matchesCity = true;
                            matchReason = `Matched by GPS location (${dist.toFixed(1)} km from ${fromCity})`;
                            matchStats.gpsDistanceMatch++;
                            console.log(`📍 Driver ${driver.id}: ${matchReason}`);
                        } else {
                            console.log(`📍 Driver ${driver.id}: GPS distance is ${dist.toFixed(1)} km (> 200km limit)`);
                        }
                    }
                }

                // ====== طريقة المطابقة 3: إذا لم يكن هناك عمود مدينة مسجل في قاعدة البيانات لجميع السائقين وليس لديهم GPS محدث، شمل جميع السائقين أصحاب الحسابات النشطة بفرض أنهم بانتظار الرحلات ======
                if (!matchesCity && !driverCityVal && !loc) {
                    matchesCity = true;
                    matchReason = `Matched as fallback active driver (no registered city column & no GPS lock)`;
                    matchStats.textCityMatch++;
                    console.log(`ℹ️ Driver ${driver.id}: ${matchReason}`);
                }

                if (matchesCity) {
                    matchedDrivers.push({
                        id: driver.id,
                        fcm_token: driver.fcm_token,
                        city: driver.city,
                        match_reason: matchReason
                    });
                } else {
                    console.log(`❌ Driver ${driver.id} excluded: Registered city "${driver.city || 'N/A'}" does not match "${fromCity}" and no nearby GPS location`);
                }
            }

            console.log(`📊 [Matching Summary] Total drivers: ${drivers.length} | Excluded (Banned: ${exclusionStats.banned}, Notifications Off: ${exclusionStats.notificationsDisabled}, Bad Token: ${exclusionStats.invalidToken}) | Matched: ${matchedDrivers.length} (Text Match: ${matchStats.textCityMatch}, GPS Match: ${matchStats.gpsDistanceMatch})`);

            // 4.4 إرسال الإشعارات بشكل مستقل وآمن لكل سائق
            let sentCount = 0;
            let failedCount = 0;
            let errorTypeCounts = {};

            for (const driver of matchedDrivers) {
                try {
                    const result = await sendQuietPush(
                        driver.fcm_token,
                        '🚗 رحلة سفرية جديدة - تراكا',
                        `طلب رحلة سفرية جديدة من ${fromCity} إلى ${toCity || ''}`,
                        {
                            type: 'NEW_TRAVEL_REQUEST',
                            ride_id: String(rideId || ''),
                            from_city: fromCity,
                            to_city: toCity || '',
                            url: '/driver_app/travel-platform.html'
                        }
                    );
                    
                    if (result.sent) {
                        sentCount++;
                        console.log(`✅ FCM push delivered to driver ${driver.id}`);
                    } else {
                        failedCount++;
                        const errReason = result.error || result.reason || 'Unknown error';
                        errorTypeCounts[errReason] = (errorTypeCounts[errReason] || 0) + 1;
                        console.log(`❌ FCM push failed for driver ${driver.id}: ${errReason}`);
                    }
                } catch (pushErr) {
                    failedCount++;
                    const errMsg = pushErr.message || 'Exception thrown';
                    errorTypeCounts[errMsg] = (errorTypeCounts[errMsg] || 0) + 1;
                    console.error(`❌ FCM push exception for driver ${driver.id}:`, errMsg);
                }
            }

            console.log(`📊 [FCM Dispatch Summary] Matched: ${matchedDrivers.length} | Sent successfully: ${sentCount} | Failed: ${failedCount} | Errors breakdown:`, JSON.stringify(errorTypeCounts));

            return res.status(200).json({ 
                success: true, 
                sentCount, 
                failedCount,
                matchedCount: matchedDrivers.length,
                totalDrivers: drivers.length,
                exclusionStats,
                matchStats,
                errorTypeCounts,
                matchedDriverIds: matchedDrivers.map(d => d.id)
            });
        }

        // ============================================
        // 5. COMMISSION_WARNING → تحذير نقص الرصيد قبل 10 ساعات
        // ============================================
        if (type === 'COMMISSION_WARNING') {
            if (!driverId) return res.status(400).json({ error: 'driverId required' });
            const driver = await getDriverFcm(driverId);
            if (!driver?.fcm_token) return res.status(200).json({ success: false, reason: 'no_driver_token' });

            const result = await sendQuietPush(
                driver.fcm_token,
                '⚠️ تنبيه رصيد غير كافٍ - تراكا',
                `دخلت الرحلة في آخر 10 ساعات ورصيدك غير كافٍ لخصم العمولة. لديك 30 دقيقة لشحن الرصيد حتى لا تُسحب الرحلة.`,
                {
                    type: 'COMMISSION_WARNING',
                    ride_id: String(rideId || ''),
                    url: '/driver_app/travel-platform.html'
                }
            );
            return res.status(200).json({ success: true, ...result });
        }

        // ============================================
        // 6. DRIVER_STRIPPED → إشعار للراكب بسحب السائق واختيار بديل
        // ============================================
        if (type === 'DRIVER_STRIPPED') {
            const { passengerId } = req.body;
            if (!passengerId) return res.status(400).json({ error: 'passengerId required' });
            const passenger = await getPassengerFcm(passengerId);
            if (!passenger?.fcm_token) return res.status(200).json({ success: false, reason: 'no_passenger_token' });

            const result = await sendQuietPush(
                passenger.fcm_token,
                'ℹ️ السائق غير متاح حالياً - تراكا',
                'السائق الذي اخترته لرحلتك السفرية غير متاح حالياً. يرجى الدخول واختيار سائق بديل.',
                {
                    type: 'DRIVER_STRIPPED',
                    ride_id: String(rideId || ''),
                    url: '/passenger_app/travel-platform.html#my-rides'
                }
            );
            return res.status(200).json({ success: true, ...result });
        }

        // ============================================
        // 7. 3H_REMINDER → تذكير السائق بالاستعداد قبل 3 ساعات
        // ============================================
        if (type === '3H_REMINDER') {
            if (!driverId) return res.status(400).json({ error: 'driverId required' });
            const driver = await getDriverFcm(driverId);
            if (!driver?.fcm_token) return res.status(200).json({ success: false, reason: 'no_driver_token' });

            const routeText = (fromCity && toCity) ? `من ${fromCity} إلى ${toCity}` : 'السفرية';
            const result = await sendQuietPush(
                driver.fcm_token,
                '⏰ تذكير موعد الرحلة السفرية - تراكا',
                `تبقى 3 ساعات على موعد رحلتك السفرية ${routeText}. عليك الاستعداد والتواجد في مدينة الانطلاق.`,
                {
                    type: '3H_REMINDER',
                    ride_id: String(rideId || ''),
                    url: '/driver_app/travel-platform.html'
                }
            );
            return res.status(200).json({ success: true, ...result });
        }

        // ============================================
        // 8. TRIP_CANCELLED / RIDE_CANCELLED → إشعار للسائق
        // ============================================
        if (type === 'TRIP_CANCELLED' || type === 'RIDE_CANCELLED') {
            let targetDriverId = driverId;

            if (!targetDriverId && rideId) {
                const { data: ride } = await db.from('ride_requests')
                    .select('driver_id')
                    .eq('id', rideId)
                    .single();

                targetDriverId = ride?.driver_id;

                // إذا لم يتم اختيار سائق بعد، جلب آخر سائق قبل الرحلة
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

            if (!targetDriverId) {
                return res.status(200).json({ 
                    success: false, 
                    reason: 'no_driver_id' 
                });
            }

            const driver = await getDriverFcm(targetDriverId);
            if (!driver?.fcm_token) {
                return res.status(200).json({ 
                    success: false, 
                    reason: 'no_driver_token' 
                });
            }

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

        // ============================================
        // نوع غير معروف
        // ============================================
        return res.status(400).json({ 
            error: `unknown type: ${type}` 
        });

    } catch (err) {
        console.error('travel-push error:', err);
        return res.status(500).json({ error: err.message });
    }
}