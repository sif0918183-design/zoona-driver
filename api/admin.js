import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { generateToken, verifyToken } from './_token-utils.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    : null;

// Admin sessions are signed and expire after 8 hours. Legacy unsigned tokens are rejected.
async function checkAdminAuth(req) {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : (req.body && req.body.token);

    if (!token || !supabase) return false;

    try {
        const session = verifyToken(token);
        return session.role === 'admin' && session.id === 'tracka-admin';
    } catch (error) {
        return false;
    }
}

function passcodeMatches(storedValue, suppliedValue) {
    if (typeof storedValue !== 'string' || typeof suppliedValue !== 'string') return false;
    if (/^\$2[aby]\$/.test(storedValue)) return bcrypt.compare(suppliedValue, storedValue);
    const stored = Buffer.from(storedValue, 'utf8');
    const supplied = Buffer.from(suppliedValue, 'utf8');
    return stored.length === supplied.length && crypto.timingSafeEqual(stored, supplied);
}

// Validate and normalize a popup message payload coming from the admin panel.
// Rejects unsafe button URLs and invalid enum values before touching the database.
function buildPopupPayload(raw) {
    const input = raw || {};

    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const body = typeof input.body === 'string' ? input.body.trim() : '';
    if (!title) return { error: 'عنوان الرسالة مطلوب' };
    if (!body) return { error: 'نص الرسالة مطلوب' };

    const targetApp = input.target_app;
    if (targetApp !== 'driver' && targetApp !== 'passenger') {
        return { error: 'مكان الظهور مطلوب (واجهة السائق أو واجهة الراكب)' };
    }

    const allowedRepeat = ['once', 'session', 'every_visit', 'interval'];
    const repeatPolicy = allowedRepeat.includes(input.repeat_policy) ? input.repeat_policy : 'once';

    // Only allow safe http(s) links, or empty. Blocks javascript:, data:, etc.
    const sanitizeUrl = (value) => {
        if (value === undefined || value === null) return null;
        const url = String(value).trim();
        if (!url) return null;
        if (!/^https?:\/\//i.test(url)) return undefined; // invalid marker
        return url;
    };

    const primaryUrl = sanitizeUrl(input.primary_button_url);
    const secondaryUrl = sanitizeUrl(input.secondary_button_url);
    if (primaryUrl === undefined || secondaryUrl === undefined) {
        return { error: 'روابط الأزرار يجب أن تبدأ بـ http:// أو https://' };
    }

    const imageUrl = sanitizeUrl(input.image_url);
    if (imageUrl === undefined) {
        return { error: 'رابط الصورة غير صالح' };
    }

    const toInt = (value, fallback) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : fallback;
    };

    const delaySeconds = Math.max(0, toInt(input.delay_seconds, 0));
    const priority = toInt(input.priority, 0);

    let repeatIntervalMinutes = null;
    if (repeatPolicy === 'interval') {
        repeatIntervalMinutes = Math.max(1, toInt(input.repeat_interval_minutes, 60));
    }

    const parseDate = (value) => {
        if (value === undefined || value === null || value === '') return null;
        const d = new Date(value);
        return isNaN(d.getTime()) ? null : d.toISOString();
    };

    return {
        record: {
            title,
            body,
            image_url: imageUrl,
            primary_button_text: input.primary_button_text ? String(input.primary_button_text).trim() || null : null,
            primary_button_url: primaryUrl,
            secondary_button_text: input.secondary_button_text ? String(input.secondary_button_text).trim() || null : null,
            secondary_button_url: secondaryUrl,
            delay_seconds: delaySeconds,
            priority,
            target_app: targetApp,
            repeat_policy: repeatPolicy,
            repeat_interval_minutes: repeatIntervalMinutes,
            start_at: parseDate(input.start_at),
            end_at: parseDate(input.end_at),
            is_active: input.is_active === undefined ? true : !!input.is_active
        }
    };
}

export default async function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    if (!supabase) {
        return res.status(503).json({ success: false, error: 'إعدادات قاعدة البيانات غير مكتملة على الخادم' });
    }

    try {
        const { action } = req.body;

        if (!action) {
            return res.status(400).json({ success: false, error: 'Action is required' });
        }

        // --- PUBLIC: ADMIN LOGIN ---
        if (action === 'login') {
            const { password } = req.body;
            if (!password) {
                return res.status(400).json({ success: false, error: 'الرجاء إدخال كلمة المرور' });
            }

            const { data, error } = await supabase
                .from('system_settings')
                .select('value')
                .eq('key', 'staff_passcode')
                .single();

            if (error || !data) {
                return res.status(500).json({ success: false, error: 'خطأ في التحقق من كلمة المرور' });
            }

            if (await passcodeMatches(data.value, password)) {
                // Upgrade legacy plaintext passcodes to bcrypt after a successful login.
                if (!/^\$2[aby]\$/.test(data.value)) {
                    const hashedPasscode = await bcrypt.hash(password, 12);
                    const { error: upgradeError } = await supabase
                        .from('system_settings')
                        .update({ value: hashedPasscode })
                        .eq('key', 'staff_passcode');
                    if (upgradeError) {
                        console.error('Failed to upgrade admin passcode hash:', upgradeError);
                        return res.status(503).json({ success: false, error: 'تعذر تحديث حماية كلمة المرور. حاول مرة أخرى.' });
                    }
                }

                const token = generateToken({ id: 'tracka-admin', role: 'admin' }, 8 * 60 * 60 * 1000);
                return res.status(200).json({ success: true, token });
            }

            return res.status(401).json({ success: false, error: 'كلمة المرور غير صحيحة' });
        }

        // --- SECURE AREA: MUST BE AUTHENTICATED ---
        const isAuth = await checkAdminAuth(req);
        if (!isAuth) {
            return res.status(401).json({ success: false, error: 'غير مصرح للقيام بهذه العملية' });
        }

        // --- GET DASHBOARD STATS ---
        if (action === 'get_stats') {
            const { count: customerCount } = await supabase
                .from('customers')
                .select('*', { count: 'exact', head: true });

            const { count: driverCount } = await supabase
                .from('drivers')
                .select('*', { count: 'exact', head: true });

            const { count: activeRidesCount } = await supabase
                .from('rides')
                .select('*', { count: 'exact', head: true })
                .eq('status', 'driver_accepted');

            const { data: allRides } = await supabase
                .from('rides')
                .select('amount')
                .eq('status', 'completed');

            const totalEarnings = allRides ? allRides.reduce((sum, ride) => sum + (ride.amount || 0), 0) : 0;

            const { data: adminWhatsappData } = await supabase
                .from('system_settings')
                .select('value')
                .eq('key', 'admin_whatsapp')
                .maybeSingle();

            return res.status(200).json({
                success: true,
                stats: {
                    customers: customerCount || 0,
                    drivers: driverCount || 0,
                    activeRides: activeRidesCount || 0,
                    earnings: totalEarnings
                },
                adminWhatsapp: adminWhatsappData ? adminWhatsappData.value : '249100979529'
            });
        }

        // --- LIST CUSTOMERS ---
        if (action === 'list_customers') {
            const { data, error } = await supabase
                .from('customers')
                .select('id, full_name, phone, phone2, is_verified, travel_restriction_type, travel_restriction_until, travel_restriction_reason, reliability_score, created_at')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, customers: data });
        }

        // --- LIST RIDER RELIABILITY LOGS ---
        if (action === 'list_rider_reliability_logs') {
            const { data, error } = await supabase
                .from('rider_reliability_logs')
                .select(`
                    id,
                    passenger_id,
                    ride_id,
                    cancelled_at,
                    departure_time,
                    hours_before_departure,
                    status_at_cancellation,
                    driver_selected,
                    contact_revealed,
                    commission_held,
                    cancellation_reason,
                    cancelled_by,
                    impact_level,
                    customers (
                        full_name,
                        phone
                    )
                `)
                .order('cancelled_at', { ascending: false })
                .limit(100);

            if (error) throw error;
            return res.status(200).json({ success: true, logs: data || [] });
        }

        // --- UPDATE PASSENGER RESTRICTION ---
        if (action === 'update_passenger_restriction') {
            const { passengerId, customerId, restrictionType, restrictionDays, restrictionUntil: reqUntil, reason } = req.body;
            const targetId = passengerId || customerId;

            if (!targetId) {
                return res.status(400).json({ success: false, error: 'passengerId or customerId is required' });
            }

            let restrictionUntil = reqUntil || null;
            if (!restrictionUntil && restrictionType === 'restricted_3days') {
                const days = parseInt(restrictionDays) || 3;
                restrictionUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
            }

            const { error } = await supabase
                .from('customers')
                .update({
                    travel_restriction_type: restrictionType || 'none',
                    travel_restriction_until: restrictionUntil,
                    travel_restriction_reason: reason || null
                })
                .eq('id', targetId);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- GET TRAVEL SETTINGS ---
        if (action === 'get_travel_settings') {
            const allowedTravelSettings = [
                'max_advance_creation_days',
                'max_drivers_accepting',
                'commission_hold_hours',
                'driver_lock_hours',
                'high_impact_cancel_limit',
                'restriction_duration_days',
                'travel_commission_rate'
            ];
            const { data, error } = await supabase
                .from('system_settings')
                .select('key, value')
                .in('key', allowedTravelSettings);

            if (error) throw error;

            const settingsMap = {
                max_advance_creation_days: '7',
                max_drivers_accepting: '10',
                commission_hold_hours: '10',
                driver_lock_hours: '3',
                high_impact_cancel_limit: '3',
                restriction_duration_days: '3',
                travel_commission_rate: '5'
            };

            (data || []).forEach(item => {
                if (allowedTravelSettings.includes(item.key)) settingsMap[item.key] = item.value;
            });

            return res.status(200).json({ success: true, settings: settingsMap });
        }

        // --- LIST DRIVERS ---
        if (action === 'list_drivers') {
            const { data, error } = await supabase
                .from('drivers')
                .select('id, full_name, whatsapp_number, phone, car_model, car_type, car_plate, plate_number, car_color, balance, is_active, is_approved, is_banned, ban_until, ban_reason, created_at, license_image_url, vehicle_registration_url, car_photo_url, plate_photo_url')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, drivers: data });
        }

        // --- LIST PENDING DRIVERS ---
        if (action === 'list_pending_drivers') {
            const { data, error } = await supabase
                .from('drivers')
                .select('id, full_name, whatsapp_number, phone, car_model, car_type, car_plate, plate_number, car_color, balance, is_active, is_approved, created_at, license_image_url, vehicle_registration_url, car_photo_url, plate_photo_url')
                .eq('is_approved', false)
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, drivers: data });
        }

        // --- APPROVE DRIVER ---
        if (action === 'approve_driver') {
            const { id, car_type, balance } = req.body;
            if (!id || !car_type) {
                return res.status(400).json({ success: false, error: 'بيانات غير مكتملة للموافقة' });
            }

            const initialBalance = parseInt(balance) || 10000;

            const { data: driver, error: fErr } = await supabase
                .from('drivers')
                .select('*')
                .eq('id', id)
                .single();

            if (fErr) throw fErr;

            const { error: uErr } = await supabase
                .from('drivers')
                .update({
                    car_type: car_type,
                    balance: initialBalance,
                    is_approved: true,
                    is_active: true
                })
                .eq('id', id);

            if (uErr) throw uErr;

            // Log balance transaction if balance is set
            if (initialBalance > 0) {
                await supabase
                    .from('balance_transactions')
                    .insert([{
                        driver_id: id,
                        amount: initialBalance,
                        type: 'admin_add',
                        description: `تفعيل الحساب ورصيد ابتدائي بقيمة ${initialBalance} جنيه`
                    }]);
            }

            return res.status(200).json({ success: true });
        }

        // --- UPDATE DRIVER DETAILS ---
        if (action === 'update_driver_details') {
            const {
                id,
                full_name,
                whatsapp_number,
                phone,
                car_model,
                plate_number,
                car_color,
                license_image_url,
                vehicle_registration_url,
                car_photo_url,
                plate_photo_url,
                car_type,
                balance,
                is_approved,
                is_active
            } = req.body;

            if (!id) {
                return res.status(400).json({ success: false, error: 'id is required' });
            }

            const updates = {
                full_name: full_name,
                whatsapp_number: whatsapp_number,
                phone: phone,
                car_model: car_model,
                plate_number: plate_number,
                car_plate: plate_number, // Sync both fields
                car_color: car_color,
                license_image_url: license_image_url,
                vehicle_registration_url: vehicle_registration_url,
                car_photo_url: car_photo_url,
                plate_photo_url: plate_photo_url,
                car_type: car_type,
                balance: balance !== undefined ? parseInt(balance) : undefined,
                is_approved: is_approved,
                is_active: is_active
            };

            // Clean any undefined properties
            Object.keys(updates).forEach(key => updates[key] === undefined && delete updates[key]);

            const { error } = await supabase
                .from('drivers')
                .update(updates)
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- GET CUSTOMER DETAILS ---
        if (action === 'get_customer') {
            const { id } = req.body;
            const { data, error } = await supabase
                .from('customers')
                .select('id, full_name, phone, phone2, is_verified, created_at')
                .eq('id', id)
                .single();

            if (error) throw error;
            return res.status(200).json({ success: true, customer: data });
        }

        // --- GET DRIVER DETAILS & RECENT RIDES ---
        if (action === 'get_driver') {
            const { id } = req.body;
            const { data: driver, error: dErr } = await supabase
                .from('drivers')
                .select('id, full_name, whatsapp_number, car_model, car_type, car_plate, car_color, balance, is_active, created_at')
                .eq('id', id)
                .single();

            if (dErr) throw dErr;

            const { data: rides } = await supabase
                .from('rides')
                .select('*')
                .eq('driver_id', id)
                .order('created_at', { ascending: false })
                .limit(5);

            return res.status(200).json({ success: true, driver, rides });
        }

        // --- TOGGLE CUSTOMER STATUS / VERIFY ---
        if (action === 'toggle_customer') {
            const { id, is_verified } = req.body;
            const { error } = await supabase
                .from('customers')
                .update({ is_verified })
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- UNBAN DRIVER ---
        if (action === 'unban_driver') {
            const { driverId } = req.body;
            if (!driverId) {
                return res.status(400).json({ success: false, error: 'driverId is required' });
            }

            const { error } = await supabase
                .from('drivers')
                .update({
                    is_banned: false,
                    ban_until: null,
                    ban_reason: null
                })
                .eq('id', driverId);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- BAN DRIVER ADMIN ---
        if (action === 'ban_driver') {
            const { driverId, reason, hours } = req.body;
            if (!driverId) {
                return res.status(400).json({ success: false, error: 'driverId is required' });
            }

            const banUntil = new Date(Date.now() + (hours || 24) * 60 * 60 * 1000).toISOString();

            const { error } = await supabase
                .from('drivers')
                .update({
                    is_banned: true,
                    ban_reason: reason || 'مخالفة شروط الخدمة',
                    ban_until: banUntil
                })
                .eq('id', driverId);

            if (error) throw error;
            return res.status(200).json({ success: true, banUntil });
        }

        // --- TOGGLE DRIVER STATUS ---
        if (action === 'toggle_driver') {
            const { id, is_active } = req.body;
            const { error } = await supabase
                .from('drivers')
                .update({ is_active })
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ADD DRIVER BALANCE (SUPPORT ADD & SUBTRACT) ---
        if (action === 'add_balance') {
            const { driverId, amount, note, balanceAction } = req.body;
            if (!driverId || !amount) {
                return res.status(400).json({ success: false, error: 'بيانات غير صالحة' });
            }

            const { data: driver, error: fErr } = await supabase
                .from('drivers')
                .select('balance, full_name')
                .eq('id', driverId)
                .single();

            if (fErr) throw fErr;

            let changeAmount = parseInt(amount);
            if (balanceAction === 'subtract') {
                changeAmount = -Math.abs(changeAmount);
            }

            const newBalance = (driver.balance || 0) + changeAmount;

            const { error: uErr } = await supabase
                .from('drivers')
                .update({ balance: newBalance })
                .eq('id', driverId);

            if (uErr) throw uErr;

            // Log transaction
            await supabase
                .from('balance_transactions')
                .insert([{
                    driver_id: driverId,
                    amount: changeAmount,
                    type: balanceAction === 'subtract' ? 'admin_subtract' : 'admin_add',
                    description: note || `عملية إدارية: ${balanceAction === 'subtract' ? 'خصم' : 'إضافة'} ${amount} جنيـه`
                }]);

            return res.status(200).json({ success: true, newBalance, driverName: driver.full_name });
        }

        // --- SAVE SYSTEM SETTINGS ---
        if (action === 'save_settings') {
            const { settings } = req.body;
            if (!settings || !Array.isArray(settings)) {
                return res.status(400).json({ success: false, error: 'Settings array is required' });
            }

            // Never allow the generic settings endpoint to write the admin passcode.
            if (settings.some((setting) => setting && setting.key === 'staff_passcode')) {
                return res.status(400).json({ success: false, error: 'استخدم مسار تغيير كلمة مرور الإدارة المخصص' });
            }

            const promises = settings.map(async (setting) => {
                const { error } = await supabase
                    .from('system_settings')
                    .upsert({ key: setting.key, value: setting.value }, {
                        onConflict: 'key',
                        ignoreDuplicates: false
                    });

                if (error) throw error;
                return true;
            });

            await Promise.all(promises);
            return res.status(200).json({ success: true });
        }

        // --- DELETE RIDE OR REQUEST ---
        if (action === 'delete_ride') {
            const { rideId } = req.body;
            if (!rideId) {
                return res.status(400).json({ success: false, error: 'rideId is required' });
            }

            if (typeof rideId === 'string' && rideId.startsWith('req_')) {
                const realId = rideId.replace('req_', '');
                const { error } = await supabase
                    .from('ride_requests')
                    .delete()
                    .eq('id', realId);
                if (error) throw error;
            } else {
                const { error } = await supabase
                    .from('rides')
                    .delete()
                    .eq('id', rideId);
                if (error) throw error;
            }

            return res.status(200).json({ success: true });
        }

        // --- ADD VEHICLE CATEGORY ---
        if (action === 'add_category') {
            const { name, description, multiplier, sort_order } = req.body;
            if (!name || !multiplier) {
                return res.status(400).json({ success: false, error: 'Name and multiplier are required' });
            }

            const { data, error } = await supabase
                .from('vehicle_categories')
                .insert([{
                    name_ar: name,
                    description_ar: description || '',
                    price_multiplier: parseFloat(multiplier),
                    is_active: true,
                    sort_order: sort_order || 1
                }])
                .select()
                .single();

            if (error) throw error;
            return res.status(200).json({ success: true, category: data });
        }

        // --- UPDATE VEHICLE CATEGORY ---
        if (action === 'update_category') {
            const { id, updates } = req.body;
            if (!id || !updates) {
                return res.status(400).json({ success: false, error: 'Category ID and updates are required' });
            }

            const { data, error } = await supabase
                .from('vehicle_categories')
                .update(updates)
                .eq('id', id)
                .select()
                .single();

            if (error) throw error;
            return res.status(200).json({ success: true, category: data });
        }

        // --- ADD TRAVEL ROUTE ---
        if (action === 'add_travel_route') {
            const { fromCity, toCity, distanceKm, isActive } = req.body;
            if (!fromCity || !toCity || distanceKm === undefined) {
                return res.status(400).json({ success: false, error: 'الرجاء إدخال المدن والمسافة' });
            }

            const { data, error } = await supabase
                .from('travel_routes')
                .insert([{
                    from_city: fromCity.trim(),
                    to_city: toCity.trim(),
                    distance_km: parseFloat(distanceKm),
                    is_active: isActive !== false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }])
                .select()
                .single();

            if (error) throw error;
            return res.status(200).json({ success: true, route: data });
        }

        // --- UPDATE TRAVEL ROUTE ---
        if (action === 'update_travel_route') {
            const { id, updates } = req.body;
            if (!id || !updates) {
                return res.status(400).json({ success: false, error: 'Route ID and updates are required' });
            }

            // Convert distance_km if specified
            const formattedUpdates = { ...updates, updated_at: new Date().toISOString() };
            if (updates.distance_km !== undefined) {
                formattedUpdates.distance_km = parseFloat(updates.distance_km);
            }

            const { data, error } = await supabase
                .from('travel_routes')
                .update(formattedUpdates)
                .eq('id', id)
                .select()
                .single();

            if (error) throw error;
            return res.status(200).json({ success: true, route: data });
        }

        // --- DELETE TRAVEL ROUTE ---
        if (action === 'delete_travel_route') {
            const { id } = req.body;
            if (!id) {
                return res.status(400).json({ success: false, error: 'Route ID is required' });
            }

            const { error } = await supabase
                .from('travel_routes')
                .delete()
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- ADD NEW DRIVER (SECURE BCRYPT) ---
        if (action === 'add_driver') {
            const { name, phone, password, carModel, carType, carPlate, carColor, initialBalance } = req.body;

            if (!name || !phone || !password || !carModel || !carType || !carPlate || !carColor) {
                return res.status(400).json({ success: false, error: 'الرجاء ملء جميع الحقول المطلوبة' });
            }

            // Check plate duplicate
            const { data: dupPlate } = await supabase
                .from('drivers')
                .select('id')
                .eq('car_plate', carPlate.toUpperCase())
                .maybeSingle();

            if (dupPlate) {
                return res.status(400).json({ success: false, error: 'رقم اللوحة مسجل بالفعل لسائق آخر' });
            }

            // Check phone duplicate
            const { data: dupPhone } = await supabase
                .from('drivers')
                .select('id')
                .eq('whatsapp_number', phone)
                .maybeSingle();

            if (dupPhone) {
                return res.status(400).json({ success: false, error: 'رقم الواتساب مسجل بالفعل لسائق آخر' });
            }

            // Hash with bcryptjs
            const passwordHash = bcrypt.hashSync(password, 10);

            const { error: insertErr } = await supabase
                .from('drivers')
                .insert([{
                    full_name: name.trim(),
                    whatsapp_number: phone.trim(),
                    password: passwordHash,
                    car_model: carModel.trim(),
                    car_type: carType,
                    car_plate: carPlate.toUpperCase().trim(),
                    car_color: carColor.trim(),
                    balance: parseInt(initialBalance) || 15000,
                    status: 'OFFLINE',
                    is_active: true,
                    created_at: new Date().toISOString()
                }]);

            if (insertErr) throw insertErr;

            return res.status(200).json({ success: true });
        }

        // --- UPDATE STAFF PASSCODE ---
        if (action === 'update_passcode') {
            const { newPasscode } = req.body;
            if (typeof newPasscode !== 'string' || newPasscode.length < 4) {
                return res.status(400).json({ success: false, error: 'الرجاء إدخال كلمة مرور قوية (4 أحرف على الأقل)' });
            }

            // Always store admin passcodes as bcrypt hashes; never persist plaintext.
            const hashedPasscode = await bcrypt.hash(newPasscode, 12);
            const { error } = await supabase
                .from('system_settings')
                .upsert({ key: 'staff_passcode', value: hashedPasscode }, {
                    onConflict: 'key',
                    ignoreDuplicates: false
                });

            if (error) throw error;

            return res.status(200).json({ success: true });
        }

        // --- UPDATE ADMIN WHATSAPP ---
        if (action === 'update_whatsapp') {
            const { whatsapp } = req.body;
            if (!whatsapp) {
                return res.status(400).json({ success: false, error: 'الرجاء إدخال رقم واتساب صحيح' });
            }

            const { error } = await supabase
                .from('system_settings')
                .update({ value: whatsapp })
                .eq('key', 'admin_whatsapp');

            if (error) {
                await supabase
                    .from('system_settings')
                    .insert([{ key: 'admin_whatsapp', value: whatsapp }]);
            }

            return res.status(200).json({ success: true });
        }

        // --- GET INSTANT VEHICLE PRICES ---
        if (action === 'get_instant_vehicles') {
            const { data, error } = await supabase
                .from('system_settings')
                .select('value')
                .eq('key', 'instant_vehicle_prices')
                .maybeSingle();

            const defaultVehicles = [
                { id: "tuktuk", name: "ركشة", icon: "🛺", base: 5000, perKm: 2000, travelMultiplier: 1.0 },
                { id: "economy", name: "توفير", icon: "🚗", base: 6000, perKm: 3000, travelMultiplier: 1.0 },
                { id: "comfort", name: "مريح", icon: "🚙", base: 7000, perKm: 3500, travelMultiplier: 1.3 },
                { id: "vip", name: "VIP", icon: "🚘", base: 10000, perKm: 5000, travelMultiplier: 1.6 }
            ];

            if (error) {
                return res.status(200).json({ success: true, vehicles: defaultVehicles });
            }

            if (!data) {
                return res.status(200).json({ success: true, vehicles: defaultVehicles });
            }

            try {
                const vehicles = JSON.parse(data.value);
                return res.status(200).json({ success: true, vehicles });
            } catch (e) {
                return res.status(200).json({ success: true, vehicles: defaultVehicles });
            }
        }

        // --- SAVE INSTANT VEHICLE PRICES ---
        if (action === 'save_instant_vehicles') {
            const { vehicles } = req.body;
            if (!vehicles || !Array.isArray(vehicles)) {
                return res.status(400).json({ success: false, error: 'الرجاء إرسال مصفوفة المركبات بشكل صحيح' });
            }

            const valueStr = JSON.stringify(vehicles);

            // Upsert or Update
            const { error: selectError, data: existingData } = await supabase
                .from('system_settings')
                .select('key')
                .eq('key', 'instant_vehicle_prices')
                .maybeSingle();

            let saveErr;
            if (existingData) {
                const { error } = await supabase
                    .from('system_settings')
                    .update({ value: valueStr })
                    .eq('key', 'instant_vehicle_prices');
                saveErr = error;
            } else {
                const { error } = await supabase
                    .from('system_settings')
                    .insert([{ key: 'instant_vehicle_prices', value: valueStr }]);
                saveErr = error;
            }

            if (saveErr) throw saveErr;

            return res.status(200).json({ success: true });
        }

        // --- DELETE CUSTOMER ---
        if (action === 'delete_customer') {
            const { id } = req.body;
            if (!id) {
                return res.status(400).json({ success: false, error: 'معرف الراكب مطلوب' });
            }

            const { error } = await supabase
                .from('customers')
                .delete()
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true, message: 'تم حذف حساب الراكب بنجاح' });
        }

        // --- DELETE DRIVER ---
        if (action === 'delete_driver') {
            const { id } = req.body;
            if (!id) {
                return res.status(400).json({ success: false, error: 'معرف السائق مطلوب' });
            }

            const { error } = await supabase
                .from('drivers')
                .delete()
                .eq('id', id);

            if (error) throw error;
            return res.status(200).json({ success: true, message: 'تم حذف حساب السائق بنجاح' });
        }

        // --- LIST COMPLAINTS ---
        if (action === 'list_complaints') {
            const { status, user_type, limit = 100 } = req.body;
            let query = supabase
                .from('complaints')
                .select('*')
                .order('created_at', { ascending: false })
                .limit(Math.min(parseInt(limit, 10) || 100, 200));

            if (status && status !== 'all') {
                query = query.eq('status', status);
            }
            if (user_type && user_type !== 'all') {
                query = query.eq('user_type', user_type);
            }

            const { data: complaints, error: complaintsErr } = await query;
            if (complaintsErr) throw complaintsErr;

            return res.status(200).json({ success: true, complaints: complaints || [] });
        }

        // --- UPDATE COMPLAINT STATUS ---
        if (action === 'update_complaint_status') {
            const { complaint_id, status } = req.body;
            if (!complaint_id || !status) {
                return res.status(400).json({ success: false, error: 'معرف الشكوى والحالة مطلوبان' });
            }

            const allowedStatuses = ['new', 'read', 'in_progress', 'replied', 'resolved'];
            if (!allowedStatuses.includes(status)) {
                return res.status(400).json({ success: false, error: 'حالة غير صالحة' });
            }

            const { data, error } = await supabase
                .from('complaints')
                .update({ status: status, updated_at: new Date().toISOString() })
                .eq('id', complaint_id)
                .select()
                .single();

            if (error) throw error;
            return res.status(200).json({ success: true, complaint: data });
        }

        // --- DELETE COMPLAINT ---
        if (action === 'delete_complaint') {
            const { complaint_id } = req.body;
            if (!complaint_id) {
                return res.status(400).json({ success: false, error: 'معرف الشكوى مطلوب' });
            }

            const { error } = await supabase
                .from('complaints')
                .delete()
                .eq('id', complaint_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        // --- POPUP MESSAGES: LIST ---
        if (action === 'list_popup_messages') {
            const { data, error } = await supabase
                .from('popup_messages')
                .select('*')
                .order('priority', { ascending: false })
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, messages: data || [] });
        }

        // --- POPUP MESSAGES: SAVE (create or update) ---
        if (action === 'save_popup_message') {
            const payload = buildPopupPayload(req.body.message || req.body);
            if (payload.error) {
                return res.status(400).json({ success: false, error: payload.error });
            }

            const record = payload.record;
            const messageId = req.body.message && req.body.message.id ? req.body.message.id : req.body.id;

            let result;
            if (messageId) {
                const { data, error } = await supabase
                    .from('popup_messages')
                    .update(record)
                    .eq('id', messageId)
                    .select()
                    .single();
                if (error) throw error;
                result = data;
            } else {
                const { data, error } = await supabase
                    .from('popup_messages')
                    .insert([record])
                    .select()
                    .single();
                if (error) throw error;
                result = data;
            }

            return res.status(200).json({ success: true, message: result });
        }

        // --- POPUP MESSAGES: TOGGLE ACTIVE ---
        if (action === 'toggle_popup_message') {
            const { message_id, is_active } = req.body;
            if (!message_id) {
                return res.status(400).json({ success: false, error: 'معرف الرسالة مطلوب' });
            }
            if (typeof is_active !== 'boolean') {
                return res.status(400).json({ success: false, error: 'قيمة الحالة غير صالحة' });
            }

            const { data, error } = await supabase
                .from('popup_messages')
                .update({ is_active })
                .eq('id', message_id)
                .select()
                .single();

            if (error) throw error;
            return res.status(200).json({ success: true, message: data });
        }

        // --- POPUP MESSAGES: DELETE ---
        if (action === 'delete_popup_message') {
            const { message_id } = req.body;
            if (!message_id) {
                return res.status(400).json({ success: false, error: 'معرف الرسالة مطلوب' });
            }

            const { error } = await supabase
                .from('popup_messages')
                .delete()
                .eq('id', message_id);

            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        return res.status(400).json({ success: false, error: 'Unknown action' });

    } catch (error) {
        console.error('Error in secure admin handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في تنفيذ العملية الإدارية: ' + error.message });
    }
}
