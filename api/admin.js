import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Helper to authenticate admin passcode from token or body
async function checkAdminAuth(req) {
    const authHeader = req.headers.authorization;
    let token = null;

    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.substring(7);
    } else if (req.body && req.body.token) {
        token = req.body.token;
    }

    if (!token) return false;

    try {
        const decoded = Buffer.from(token, 'base64').toString('utf-8');
        const parts = decoded.split(':');
        if (parts.length < 2) return false;

        const passcode = parts.slice(1).join(':'); // handles any colons inside passcode

        const { data, error } = await supabase
            .from('system_settings')
            .select('value')
            .eq('key', 'staff_passcode')
            .single();

        if (error || !data) return false;
        return data.value === passcode;
    } catch (e) {
        return false;
    }
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

            if (data.value === password) {
                const token = Buffer.from(Date.now() + ':' + password).toString('base64');
                return res.status(200).json({ success: true, token });
            } else {
                return res.status(400).json({ success: false, error: 'كلمة المرور غير صحيحة' });
            }
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
                .select('id, full_name, phone, phone2, is_verified, created_at')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, customers: data });
        }

        // --- LIST DRIVERS ---
        if (action === 'list_drivers') {
            const { data, error } = await supabase
                .from('drivers')
                .select('id, full_name, whatsapp_number, car_model, car_type, car_plate, car_color, balance, is_active, is_banned, ban_until, ban_reason, created_at')
                .order('created_at', { ascending: false });

            if (error) throw error;
            return res.status(200).json({ success: true, drivers: data });
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
            if (!newPasscode || newPasscode.length < 4) {
                return res.status(400).json({ success: false, error: 'الرجاء إدخال كلمة مرور قوية (4 أحرف على الأقل)' });
            }

            const { error } = await supabase
                .from('system_settings')
                .update({ value: newPasscode })
                .eq('key', 'staff_passcode');

            if (error) {
                // If it fails (key does not exist), insert
                await supabase
                    .from('system_settings')
                    .insert([{ key: 'staff_passcode', value: newPasscode }]);
            }

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
                { id: "tuktuk", name: "ركشة", icon: "🛺", base: 5000, perKm: 2000 },
                { id: "economy", name: "توفير", icon: "🚗", base: 6000, perKm: 3000 },
                { id: "comfort", name: "مريح", icon: "🚙", base: 7000, perKm: 3500 },
                { id: "vip", name: "VIP", icon: "🚘", base: 10000, perKm: 5000 }
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

        return res.status(400).json({ success: false, error: 'Unknown action' });

    } catch (error) {
        console.error('Error in secure admin handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في تنفيذ العملية الإدارية: ' + error.message });
    }
}
