import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const DEFAULT_SETTINGS = {
    max_advance_creation_days: 7,
    max_drivers_accepting: 10,
    commission_hold_hours: 10,
    driver_lock_hours: 3,
    high_impact_cancel_limit: 3,
    restriction_duration_days: 3,
    travel_commission_rate: 5
};

function verifyToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('المصادقة مطلوبة: رمز الجلسة مفقود أو غير صالح');
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
        if (decoded.exp && decoded.exp < Date.now()) {
            throw new Error('انتهت صلاحية رمز الجلسة الخاصة بك، يرجى تسجيل الدخول مرة أخرى');
        }
        return decoded;
    } catch (e) {
        throw new Error('رمز الجلسة غير صالح');
    }
}

// Get current server time in Sudan Time (UTC+2)
function getSudanServerTime() {
    return new Date();
}

// Fetch travel configuration settings from system_settings
async function getTravelSettings() {
    try {
        const { data } = await supabase
            .from('system_settings')
            .select('key, value');

        const settings = { ...DEFAULT_SETTINGS };
        if (data && data.length > 0) {
            data.forEach(item => {
                if (item.key === 'max_advance_creation_days') settings.max_advance_creation_days = parseInt(item.value) || 7;
                if (item.key === 'max_drivers_accepting') settings.max_drivers_accepting = parseInt(item.value) || 10;
                if (item.key === 'commission_hold_hours') settings.commission_hold_hours = parseInt(item.value) || 10;
                if (item.key === 'driver_lock_hours') settings.driver_lock_hours = parseInt(item.value) || 3;
                if (item.key === 'high_impact_cancel_limit') settings.high_impact_cancel_limit = parseInt(item.value) || 3;
                if (item.key === 'restriction_duration_days') settings.restriction_duration_days = parseInt(item.value) || 3;
                if (item.key === 'travel_commission_rate') settings.travel_commission_rate = parseFloat(item.value) || 5;
            });
        }
        return settings;
    } catch (e) {
        return DEFAULT_SETTINGS;
    }
}

function parseCategoryRank(categoryName) {
    if (!categoryName) return 1;
    const n = String(categoryName).toLowerCase().trim();
    if (n.includes('tuktuk') || n.includes('ركشة')) return 0;
    if (n.includes('اقتصادي') || n.includes('economy')) return 1;
    if (n.includes('مريح') || n.includes('comfort')) return 2;
    if (n.includes('عالي') || n.includes('suv') || n.includes('vip')) return 3;
    return 1;
}

// Check passenger eligibility and behavioral constraints before creating a ride
async function checkPassengerRestrictions(passengerId, departureTimeISO, fromCity, toCity, settings) {
    const serverTime = getSudanServerTime();

    // 1. Check customer account restrictions
    const { data: customer, error: cErr } = await supabase
        .from('customers')
        .select('id, is_verified, travel_restriction_type, travel_restriction_until, travel_restriction_reason')
        .eq('id', passengerId)
        .single();

    if (cErr || !customer) {
        throw new Error('الراكب غير مسجل في النظام');
    }

    if (customer.travel_restriction_type === 'travel_banned') {
        throw new Error('تم تعليق إمكانية إنشاء الرحلات السفرية لحسابك بسبب تكرار الإلغاءات المسببة لضرر السائقين.');
    }

    if (customer.travel_restriction_type === 'restricted_3days' && customer.travel_restriction_until) {
        const untilDate = new Date(customer.travel_restriction_until);
        if (untilDate > serverTime) {
            const formattedTime = untilDate.toLocaleString('ar-SA', {
                year: 'numeric', month: 'long', day: 'numeric',
                hour: '2-digit', minute: '2-digit'
            });
            throw new Error(`حسابك مقيد مؤقتاً من إنشاء رحلات سفرية جديدة حتى ${formattedTime}. السبب: ${customer.travel_restriction_reason || 'تكرار الإلغاءات الأخيرة'}`);
        }
    }

    // 2. Validate Departure Time
    const departureTime = new Date(departureTimeISO);
    if (isNaN(departureTime.getTime())) {
        throw new Error('موعد انطلاق الرحلة غير صالح');
    }

    if (departureTime <= serverTime) {
        throw new Error('موعد الرحلة يجب أن يكون في المستقبل');
    }

    const maxAdvanceTime = new Date(serverTime.getTime() + settings.max_advance_creation_days * 24 * 60 * 60 * 1000);
    if (departureTime > maxAdvanceTime) {
        throw new Error(`لا يمكنك إنشاء رحلة سفرية قبل أكثر من ${settings.max_advance_creation_days} أيام من موعد انطلاقها.`);
    }

    // 3. Max Active Travel Rides Check (Max 3)
    const activeStatuses = ['pending', 'accepted', 'driver_selected', 'waiting_for_commission', 'commission_reserved', 'final_active', 'in_progress'];

    const { data: activeRequests } = await supabase
        .from('ride_requests')
        .select('id, from_city, to_city, departure_time, created_at')
        .eq('customer_id', passengerId)
        .in('status', activeStatuses);

    const { data: activeTrips } = await supabase
        .from('travel_trips')
        .select('id, ride_request_id, from_city, to_city, departure_time')
        .eq('passenger_id', passengerId)
        .in('status', ['driver_selected', 'in_progress', 'waiting_for_commission', 'commission_reserved', 'final_active']);

    const activeRideIds = new Set();
    (activeRequests || []).forEach(r => activeRideIds.add(String(r.id)));
    (activeTrips || []).forEach(t => t.ride_request_id && activeRideIds.add(String(t.ride_request_id)));

    if (activeRideIds.size >= 3) {
        throw new Error('وصلت إلى الحد الأقصى المسموح به حالياً (3 رحلات نشطة). يرجى إنهاء أو إلغاء إحدى رحلاتك النشطة قبل إنشاء رحلة جديدة.');
    }

    // 4. Duplicate Ride Check
    const allActiveRides = activeRequests || [];
    for (const ride of allActiveRides) {
        const normFromExisting = String(ride.from_city || '').trim().toLowerCase();
        const normToExisting = String(ride.to_city || '').trim().toLowerCase();
        const normFromNew = String(fromCity || '').trim().toLowerCase();
        const normToNew = String(toCity || '').trim().toLowerCase();

        if (normFromExisting === normFromNew && normToExisting === normToNew && ride.departure_time) {
            const existingDepTime = new Date(ride.departure_time).getTime();
            const newDepTime = departureTime.getTime();
            const diffHours = Math.abs(existingDepTime - newDepTime) / (1000 * 60 * 60);

            if (diffHours < 2) {
                throw new Error('لديك بالفعل طلب رحلة مماثل لهذا الموعد. يمكنك تعديل الطلب الحالي أو إلغاؤه قبل إنشاء طلب جديد.');
            }
        }
    }

    // 5. Conflicting Ride Check
    for (const ride of allActiveRides) {
        if (ride.departure_time) {
            const existingDepTime = new Date(ride.departure_time).getTime();
            const newDepTime = departureTime.getTime();
            const diffHours = Math.abs(existingDepTime - newDepTime) / (1000 * 60 * 60);

            // Inter-city travel safety buffer window (e.g., 4 hours between different rides)
            if (diffHours < 4) {
                throw new Error('لديك رحلة سفرية أخرى تتداخل زمنيًا مع موعد هذه الرحلة.');
            }
        }
    }

    return true;
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
        let session;
        try {
            session = verifyToken(req);
        } catch (tokenErr) {
            return res.status(401).json({ success: false, error: tokenErr.message });
        }

        const { action } = req.body;
        if (!action) {
            return res.status(400).json({ success: false, error: 'Action is required' });
        }

        const settings = await getTravelSettings();
        const serverTime = getSudanServerTime();

        // --- 1. CHECK PASSENGER ELIGIBILITY ---
        if (action === 'check_eligibility') {
            const { passengerId, departureTime, fromCity, toCity } = req.body;
            try {
                await checkPassengerRestrictions(passengerId, departureTime, fromCity, toCity, settings);
                return res.status(200).json({ success: true, allowed: true });
            } catch (err) {
                return res.status(400).json({ success: false, allowed: false, error: err.message });
            }
        }

        // --- 2. CREATE TRAVEL REQUEST ---
        if (action === 'create_ride_request') {
            const { passengerId, fromCity, toCity, vehicleCategory, estimatedPrice, notes, departureTime } = req.body;

            if (!passengerId || !fromCity || !toCity || !departureTime || !estimatedPrice) {
                return res.status(400).json({ success: false, error: 'بيانات غير كافية لإنشاء طلب الرحلة السفرية' });
            }

            // Check restrictions
            await checkPassengerRestrictions(passengerId, departureTime, fromCity, toCity, settings);

            // Fetch customer name/phone
            const { data: customer } = await supabase
                .from('customers')
                .select('full_name, phone')
                .eq('id', passengerId)
                .single();

            const { data: ride, error } = await supabase
                .from('ride_requests')
                .insert([{
                    customer_id: passengerId,
                    passenger_name: customer?.full_name || 'راكب',
                    passenger_phone: customer?.phone || '',
                    from_city: fromCity,
                    to_city: toCity,
                    vehicle_category: vehicleCategory,
                    estimated_price: Math.round(estimatedPrice),
                    notes: typeof notes === 'object' ? JSON.stringify(notes) : notes,
                    departure_time: new Date(departureTime).toISOString(),
                    status: 'pending',
                    commission_status: 'pending',
                    contact_revealed: false,
                    created_at: serverTime.toISOString()
                }])
                .select()
                .single();

            if (error) throw error;

            return res.status(200).json({ success: true, ride });
        }

        // --- 3. DRIVER INITIAL ACCEPTANCE (THREAD-SAFE & CATEGORY CHECK) ---
        if (action === 'driver_accept') {
            const { rideId, driverId } = req.body;

            if (!rideId || !driverId) {
                return res.status(400).json({ success: false, error: 'rideId and driverId are required' });
            }

            // Fetch driver details
            const { data: driver, error: dErr } = await supabase
                .from('drivers')
                .select('id, is_active, is_banned, ban_until, balance, car_type')
                .eq('id', driverId)
                .single();

            if (dErr || !driver) {
                return res.status(400).json({ success: false, error: 'السائق غير مسجل في النظام' });
            }

            if (!driver.is_active || (driver.is_banned && driver.ban_until && new Date(driver.ban_until) > serverTime)) {
                return res.status(403).json({ success: false, error: 'حسابك معلق أو محظور حالياً من استقبال الرحلات' });
            }

            // Fetch ride details
            const { data: ride, error: rErr } = await supabase
                .from('ride_requests')
                .select('*')
                .eq('id', rideId)
                .single();

            if (rErr || !ride) {
                return res.status(400).json({ success: false, error: 'الرحلة غير موجودة' });
            }

            if (ride.status !== 'pending') {
                return res.status(400).json({ success: false, error: 'هذه الرحلة لم تعد متاحة للقبول' });
            }

            // Vehicle Category Rank Compatibility Check
            const driverRank = parseCategoryRank(driver.car_type);
            const rideRank = parseCategoryRank(ride.vehicle_category);

            if (driverRank < rideRank) {
                return res.status(403).json({ success: false, error: `فئة سيارتك (${driver.car_type || 'اقتصادي'}) لا تسمح بقبول هذه الرحلة المخصصة لفئة (${ride.vehicle_category}).` });
            }

            // Check 3-Hour Driver Lockout
            const { data: driverActiveTrips } = await supabase
                .from('travel_trips')
                .select('departure_time, status')
                .eq('driver_id', driverId)
                .in('status', ['driver_selected', 'in_progress', 'commission_reserved', 'final_active']);

            for (const activeTrip of (driverActiveTrips || [])) {
                if (activeTrip.departure_time) {
                    const activeDep = new Date(activeTrip.departure_time).getTime();
                    const hoursUntilDep = (activeDep - serverTime.getTime()) / (1000 * 60 * 60);

                    if (hoursUntilDep <= settings.driver_lock_hours && hoursUntilDep >= -12) {
                        return res.status(403).json({ success: false, error: 'أنت ملتزم برحلة سفرية قادمة خلال الأربع ساعات القادمة، لا يمكنك قبول طلب جديد.' });
                    }
                }
            }

            // Atomic Check: Get existing acceptances
            const { data: acceptances, error: accErr } = await supabase
                .from('ride_driver_acceptances')
                .select('id, driver_id')
                .eq('ride_id', rideId)
                .eq('status', 'accepted');

            const already = (acceptances || []).find(a => a.driver_id === driverId);
            if (already) {
                return res.status(200).json({ success: true, message: 'تم قبول الرحلة مسبقاً' });
            }

            if ((acceptances || []).length >= settings.max_drivers_accepting) {
                return res.status(400).json({ success: false, error: `وصل الطلب للحد الأقصى المسموح به من السائقين (${settings.max_drivers_accepting} سائقين).` });
            }

            // Insert acceptance
            const { data: newAcceptance, error: insErr } = await supabase
                .from('ride_driver_acceptances')
                .insert([{
                    ride_id: rideId,
                    driver_id: driverId,
                    status: 'accepted',
                    accepted_at: serverTime.toISOString()
                }])
                .select()
                .single();

            if (insErr) {
                if (insErr.code === '23505') { // Unique constraint violation
                    return res.status(200).json({ success: true, message: 'تم قبول الرحلة مسبقاً' });
                }
                throw insErr;
            }

            return res.status(200).json({ success: true, acceptance: newAcceptance, currentAcceptedCount: (acceptances || []).length + 1 });
        }

        // --- 4. DRIVER WITHDRAW ACCEPTANCE ---
        if (action === 'driver_withdraw') {
            const { rideId, driverId } = req.body;

            if (!rideId || !driverId) {
                return res.status(400).json({ success: false, error: 'rideId and driverId are required' });
            }

            await supabase
                .from('ride_driver_acceptances')
                .update({ status: 'withdrawn', updated_at: serverTime.toISOString() })
                .eq('ride_id', rideId)
                .eq('driver_id', driverId)
                .eq('status', 'accepted');

            return res.status(200).json({ success: true });
        }

        // --- 5. PASSENGER SELECTS FINAL DRIVER ---
        if (action === 'select_driver') {
            const { rideId, driverId, passengerId } = req.body;

            if (!rideId || !driverId || !passengerId) {
                return res.status(400).json({ success: false, error: 'rideId, driverId, and passengerId are required' });
            }

            // Get driver details
            const { data: driver } = await supabase
                .from('drivers')
                .select('full_name, phone, car_type, car_model, balance')
                .eq('id', driverId)
                .single();

            if (!driver) {
                return res.status(400).json({ success: false, error: 'السائق المطلوب غير موجود' });
            }

            // Get ride request details
            const { data: ride } = await supabase
                .from('ride_requests')
                .select('*')
                .eq('id', rideId)
                .single();

            if (!ride) {
                return res.status(400).json({ success: false, error: 'طلب الرحلة غير موجود' });
            }

            // Idempotency / State Guard: Check if a driver is already selected
            if (ride.status === 'driver_selected' && ride.driver_id) {
                if (ride.driver_id !== driverId) {
                    return res.status(400).json({ success: false, error: 'تم اختيار سائق آخر لهذه الرحلة بالفعل.' });
                }
                // Already selected the same driver -> return existing trip
                const { data: existingTrip } = await supabase
                    .from('travel_trips')
                    .select('*')
                    .eq('ride_request_id', rideId)
                    .maybeSingle();

                return res.status(200).json({
                    success: true,
                    trip: existingTrip,
                    commissionStatus: ride.commission_status || 'pending',
                    graceUntil: ride.commission_grace_until || null,
                    contactsRevealed: ride.contact_revealed || false
                });
            }

            // 1. Update ride_requests
            await supabase
                .from('ride_requests')
                .update({
                    status: 'driver_selected',
                    driver_id: driverId,
                    driver_name: driver.full_name,
                    driver_phone: driver.phone,
                    updated_at: serverTime.toISOString()
                })
                .eq('id', rideId);

            // 2. Close acceptances for other candidates
            await supabase
                .from('ride_driver_acceptances')
                .update({ status: 'rejected' })
                .eq('ride_id', rideId)
                .neq('driver_id', driverId);

            await supabase
                .from('ride_driver_acceptances')
                .update({ status: 'selected' })
                .eq('ride_id', rideId)
                .eq('driver_id', driverId);

            // 3. Create or update travel_trips record
            const departureTime = ride.departure_time ? new Date(ride.departure_time) : new Date(serverTime.getTime() + 24 * 3600000);
            const hoursUntilDeparture = (departureTime.getTime() - serverTime.getTime()) / (1000 * 60 * 60);

            let initialCommStatus = 'pending';
            let graceUntil = null;
            let contactsRevealed = false;

            const commissionAmount = Math.round((ride.estimated_price || 0) * settings.travel_commission_rate / 100);

            // Check if already inside last 10 hours
            if (hoursUntilDeparture <= settings.commission_hold_hours) {
                if ((driver.balance || 0) >= commissionAmount) {
                    // Sufficient balance -> deduct/hold commission & reveal contacts immediately
                    const newBal = (driver.balance || 0) - commissionAmount;
                    await supabase.from('drivers').update({ balance: newBal }).eq('id', driverId);
                    await supabase.from('balance_transactions').insert([{
                        driver_id: driverId,
                        amount: -commissionAmount,
                        type: 'commission_hold',
                        description: `حجز عمولة منصة السفر للرحلة رقم ${rideId}`
                    }]);

                    initialCommStatus = 'held';
                    contactsRevealed = true;
                } else {
                    // Insufficient balance -> grant 30-min top-up grace timer
                    initialCommStatus = 'grace_period';
                    graceUntil = new Date(serverTime.getTime() + 30 * 60 * 1000).toISOString();
                    contactsRevealed = false;
                }
            }

            // Create/Upsert travel_trips
            const { data: trip, error: tErr } = await supabase
                .from('travel_trips')
                .insert([{
                    ride_request_id: rideId,
                    driver_id: driverId,
                    passenger_id: passengerId,
                    from_city: ride.from_city,
                    to_city: ride.to_city,
                    final_price: ride.estimated_price,
                    status: 'driver_selected',
                    car_type: driver.car_type,
                    car_model: driver.car_model,
                    departure_time: departureTime.toISOString(),
                    commission_status: initialCommStatus,
                    commission_amount: commissionAmount,
                    commission_grace_until: graceUntil,
                    contact_revealed: contactsRevealed,
                    created_at: serverTime.toISOString()
                }])
                .select()
                .single();

            if (tErr) throw tErr;

            // Update contact_revealed on ride_requests
            await supabase
                .from('ride_requests')
                .update({
                    commission_status: initialCommStatus,
                    commission_grace_until: graceUntil,
                    contact_revealed: contactsRevealed
                })
                .eq('id', rideId);

            return res.status(200).json({
                success: true,
                trip,
                commissionStatus: initialCommStatus,
                graceUntil,
                contactsRevealed
            });
        }

        // --- 6. PROCESS 10-HOUR COMMISSION & GRACE TIMER EVALUATION ---
        if (action === 'process_10h_commission') {
            const { tripId, rideId } = req.body;

            if (!tripId && !rideId) {
                return res.status(400).json({ success: false, error: 'tripId or rideId is required' });
            }

            let trip = null;
            if (tripId) {
                const { data: tData } = await supabase
                    .from('travel_trips')
                    .select('*')
                    .eq('id', tripId)
                    .maybeSingle();
                trip = tData;
            }

            if (!trip && rideId) {
                const { data: tData } = await supabase
                    .from('travel_trips')
                    .select('*')
                    .eq('ride_request_id', rideId)
                    .maybeSingle();
                trip = tData;
            }

            // Fetch ride_request as well for full info/fallback
            let rideReq = null;
            const targetRideId = rideId || trip?.ride_request_id;
            if (targetRideId) {
                const { data: rData } = await supabase
                    .from('ride_requests')
                    .select('*')
                    .eq('id', targetRideId)
                    .maybeSingle();
                rideReq = rData;
            }

            if (!trip && !rideReq) {
                return res.status(400).json({ success: false, error: 'الرحلة غير موجودة' });
            }

            const driverId = trip?.driver_id || rideReq?.driver_id;
            if (!driverId) {
                return res.status(200).json({ success: true, message: 'لم يتم اختيار سائق لهذه الرحلة بعد' });
            }

            if ((trip?.status === 'completed' || trip?.status === 'cancelled') ||
                (rideReq?.status === 'completed' || rideReq?.status === 'cancelled')) {
                return res.status(200).json({ success: true, trip, rideReq });
            }

            // Parse departure time accurately
            let departureTime = null;
            if (trip?.departure_time) departureTime = new Date(trip.departure_time);
            else if (rideReq?.departure_time) departureTime = new Date(rideReq.departure_time);
            else if (rideReq?.notes) {
                try {
                    const parsed = typeof rideReq.notes === 'string' ? JSON.parse(rideReq.notes) : rideReq.notes;
                    if (parsed?.day && parsed?.month) {
                        const year = parsed.year || '2026';
                        let hour = parseInt(parsed.hour) || 0;
                        const minute = parseInt(parsed.minute) || 0;
                        if (parsed.period === 'مساءً' && hour < 12) hour += 12;
                        if (parsed.period === 'صباحاً' && hour === 12) hour = 0;
                        const dateStr = `${year}-${String(parsed.month).padStart(2, '0')}-${String(parsed.day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+02:00`;
                        const dep = new Date(dateStr);
                        if (!isNaN(dep.getTime())) departureTime = dep;
                    }
                } catch(e) {}
            }

            if (!departureTime) {
                departureTime = new Date(serverTime.getTime() + 24 * 3600000);
            }

            const hoursUntilDeparture = (departureTime.getTime() - serverTime.getTime()) / (1000 * 60 * 60);

            // Fetch driver balance
            const { data: driver } = await supabase
                .from('drivers')
                .select('balance, full_name')
                .eq('id', driverId)
                .single();

            const finalPrice = trip?.final_price || rideReq?.estimated_price || 0;
            const commissionAmount = trip?.commission_amount || Math.round(finalPrice * settings.travel_commission_rate / 100);

            const commStatus = trip?.commission_status || rideReq?.commission_status || 'pending';
            const commGraceUntil = trip?.commission_grace_until || rideReq?.commission_grace_until;

            // Case A: Grace Period Expiration Evaluation
            if (commStatus === 'grace_period') {
                const graceUntil = commGraceUntil ? new Date(commGraceUntil) : serverTime;

                if (serverTime >= graceUntil) {
                    // Try deduction once more
                    if ((driver?.balance || 0) >= commissionAmount) {
                        // Success -> Deduct & Reveal Contacts
                        const newBal = (driver.balance || 0) - commissionAmount;
                        await supabase.from('drivers').update({ balance: newBal }).eq('id', driverId);
                        await supabase.from('balance_transactions').insert([{
                            driver_id: driverId,
                            amount: -commissionAmount,
                            type: 'commission_hold',
                            description: `خصم عمولة منصة السفر للرحلة ${targetRideId}`
                        }]);

                        if (trip) {
                            await supabase.from('travel_trips').update({
                                commission_status: 'held',
                                contact_revealed: true,
                                commission_grace_until: null,
                                updated_at: serverTime.toISOString()
                            }).eq('id', trip.id);
                        }

                        if (targetRideId) {
                            await supabase.from('ride_requests').update({
                                commission_status: 'held',
                                contact_revealed: true,
                                commission_grace_until: null
                            }).eq('id', targetRideId);
                        }

                        return res.status(200).json({ success: true, result: 'commission_held', contactsRevealed: true });
                    } else {
                        // Failed Grace Timer -> Strip driver & request replacement
                        if (trip) {
                            await supabase.from('travel_trips').update({
                                status: 'cancelled',
                                cancelled_by: 'system',
                                cancellation_reason: 'انتهاء مهلة الشحن دون توفر رصيد العمولة',
                                commission_status: 'failed',
                                updated_at: serverTime.toISOString()
                            }).eq('id', trip.id);
                        }

                        if (targetRideId) {
                            await supabase.from('ride_requests').update({
                                status: 'pending',
                                driver_id: null,
                                driver_name: null,
                                driver_phone: null,
                                commission_status: 'failed',
                                contact_revealed: false
                            }).eq('id', targetRideId);
                        }

                        return res.status(200).json({
                            success: true,
                            result: 'driver_stripped',
                            message: 'تم سحب الرحلة من السائق لعدم توفر الرصيد بعد انتهاء المهلة.'
                        });
                    }
                } else {
                    // Grace timer still running
                    const remainingSeconds = Math.max(0, Math.round((graceUntil.getTime() - serverTime.getTime()) / 1000));
                    return res.status(200).json({
                        success: true,
                        result: 'in_grace_period',
                        remainingSeconds,
                        contactsRevealed: false
                    });
                }
            }

            // Case B: Entering 10-Hour Window
            if (hoursUntilDeparture <= settings.commission_hold_hours && commStatus === 'pending') {
                if ((driver?.balance || 0) >= commissionAmount) {
                    // Sufficient balance -> Deduct/Hold
                    const newBal = (driver.balance || 0) - commissionAmount;
                    await supabase.from('drivers').update({ balance: newBal }).eq('id', driverId);
                    await supabase.from('balance_transactions').insert([{
                        driver_id: driverId,
                        amount: -commissionAmount,
                        type: 'commission_hold',
                        description: `حجز عمولة منصة السفر للرحلة ${targetRideId}`
                    }]);

                    if (trip) {
                        await supabase.from('travel_trips').update({
                            commission_status: 'held',
                            contact_revealed: true,
                            updated_at: serverTime.toISOString()
                        }).eq('id', trip.id);
                    }

                    if (targetRideId) {
                        await supabase.from('ride_requests').update({
                            commission_status: 'held',
                            contact_revealed: true
                        }).eq('id', targetRideId);
                    }

                    return res.status(200).json({ success: true, result: 'commission_held', contactsRevealed: true });
                } else {
                    // Insufficient balance -> Grant 30 min grace timer
                    const graceUntil = new Date(serverTime.getTime() + 30 * 60 * 1000).toISOString();
                    if (trip) {
                        await supabase.from('travel_trips').update({
                            commission_status: 'grace_period',
                            commission_grace_until: graceUntil,
                            contact_revealed: false,
                            updated_at: serverTime.toISOString()
                        }).eq('id', trip.id);
                    }

                    if (targetRideId) {
                        await supabase.from('ride_requests').update({
                            commission_status: 'grace_period',
                            commission_grace_until: graceUntil,
                            contact_revealed: false
                        }).eq('id', targetRideId);
                    }

                    return res.status(200).json({
                        success: true,
                        result: 'grace_period_started',
                        graceUntil,
                        remainingSeconds: 1800,
                        contactsRevealed: false
                    });
                }
            }

            return res.status(200).json({
                success: true,
                result: commStatus === 'held' ? 'commission_held' : 'waiting_for_10h_window',
                hoursUntilDeparture: Math.round(hoursUntilDeparture * 10) / 10,
                contactsRevealed: (trip?.contact_revealed || rideReq?.contact_revealed) || false
            });
        }

        // --- 7. PASSENGER CANCEL TRIP WITH RELIABILITY LOGGING ---
        if (action === 'passenger_cancel') {
            const { tripId, reason } = req.body;

            if (!tripId) {
                return res.status(400).json({ success: false, error: 'tripId is required' });
            }

            // Fetch trip details
            const { data: trip } = await supabase
                .from('travel_trips')
                .select('*')
                .eq('id', tripId)
                .maybeSingle();

            let passengerId = trip?.passenger_id;
            let departureTime = trip?.departure_time ? new Date(trip.departure_time) : null;
            let isDriverSelected = !!(trip?.driver_id);
            let isContactRevealed = !!(trip?.contact_revealed);
            let isCommissionHeld = trip?.commission_status === 'held';

            let rideReqId = trip?.ride_request_id || tripId;

            if (!passengerId) {
                const { data: reqData } = await supabase
                    .from('ride_requests')
                    .select('*')
                    .eq('id', rideReqId)
                    .single();

                if (reqData) {
                    passengerId = reqData.customer_id;
                    departureTime = reqData.departure_time ? new Date(reqData.departure_time) : null;
                    isDriverSelected = !!(reqData.driver_id);
                    isContactRevealed = !!(reqData.contact_revealed);
                    isCommissionHeld = reqData.commission_status === 'held';
                }
            }

            const hoursBeforeDeparture = departureTime
                ? (departureTime.getTime() - serverTime.getTime()) / (1000 * 60 * 60)
                : 24;

            // Classify Impact Level
            let impactLevel = 'low';
            if (isDriverSelected && hoursBeforeDeparture >= 10) {
                impactLevel = 'medium';
            } else if (isDriverSelected && hoursBeforeDeparture < 10 && (isContactRevealed || isCommissionHeld)) {
                impactLevel = 'high';
            }

            // 1. Update trip & ride request statuses
            if (trip) {
                await supabase
                    .from('travel_trips')
                    .update({
                        status: 'cancelled',
                        cancelled_by: 'passenger',
                        cancelled_at: serverTime.toISOString(),
                        cancellation_reason: reason || 'إلغاء من الراكب',
                        updated_at: serverTime.toISOString()
                    })
                    .eq('id', tripId);
            }

            await supabase
                .from('ride_requests')
                .update({
                    status: 'cancelled',
                    updated_at: serverTime.toISOString()
                })
                .eq('id', rideReqId);

            // 2. Record Rider Reliability Log
            if (passengerId) {
                await supabase.from('rider_reliability_logs').insert([{
                    passenger_id: passengerId,
                    ride_id: String(tripId),
                    cancelled_at: serverTime.toISOString(),
                    departure_time: departureTime ? departureTime.toISOString() : null,
                    hours_before_departure: Math.round(hoursBeforeDeparture * 10) / 10,
                    status_at_cancellation: trip?.status || 'pending',
                    driver_selected: isDriverSelected,
                    contact_revealed: isContactRevealed,
                    commission_held: isCommissionHeld,
                    cancellation_reason: reason || 'إلغاء من الراكب',
                    cancelled_by: 'passenger',
                    impact_level: impactLevel,
                    created_at: serverTime.toISOString()
                }]);

                // 3. Evaluate High-Impact Cancellation Penalties
                if (impactLevel === 'high') {
                    const thirtyDaysAgo = new Date(serverTime.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

                    const { count: highImpactCount } = await supabase
                        .from('rider_reliability_logs')
                        .select('id', { count: 'exact', head: true })
                        .eq('passenger_id', passengerId)
                        .eq('impact_level', 'high')
                        .gte('cancelled_at', thirtyDaysAgo);

                    if (highImpactCount >= settings.high_impact_cancel_limit + 1) { // 4 or more
                        const { data: customer } = await supabase
                            .from('customers')
                            .select('travel_restriction_type')
                            .eq('id', passengerId)
                            .single();

                        if (customer?.travel_restriction_type === 'restricted_3days') {
                            // Escalation to travel_banned
                            await supabase.from('customers').update({
                                travel_restriction_type: 'travel_banned',
                                travel_restriction_reason: 'تعليق حساب إنشاء الرحلات السفرية لتكرار الإلغاء في أوقات متأخرة'
                            }).eq('id', passengerId);
                        } else {
                            // Apply 3-day restriction
                            const restrictUntil = new Date(serverTime.getTime() + settings.restriction_duration_days * 24 * 60 * 60 * 1000).toISOString();
                            await supabase.from('customers').update({
                                travel_restriction_type: 'restricted_3days',
                                travel_restriction_until: restrictUntil,
                                travel_restriction_reason: 'تقييد 3 أيام لتكرار إلغاء الرحلات في آخر 10 ساعات'
                            }).eq('id', passengerId);
                        }
                    }
                }
            }

            return res.status(200).json({ success: true, impactLevel });
        }

        // --- 8. DRIVER CANCEL TRIP WITH PENALTY ---
        if (action === 'driver_cancel') {
            const { tripId, driverId, finalPrice, reason } = req.body;

            if (!tripId || !driverId || !finalPrice) {
                return res.status(400).json({ success: false, error: 'tripId, driverId, and finalPrice are required' });
            }

            // Idempotency check: Don't charge penalty twice
            const { data: existingTrip } = await supabase
                .from('travel_trips')
                .select('status, commission_deducted')
                .eq('id', tripId)
                .single();

            if (existingTrip && existingTrip.status === 'cancelled') {
                return res.status(200).json({ success: true, message: 'الرحلة ملغاة بالفعل' });
            }

            const penalty = Math.round(finalPrice * settings.travel_commission_rate / 100);

            // Deduct penalty from driver balance
            const { data: driver, error: dErr } = await supabase
                .from('drivers')
                .select('balance')
                .eq('id', driverId)
                .single();

            if (dErr || !driver) {
                return res.status(400).json({ success: false, error: 'السائق غير مسجل' });
            }

            const newBalance = (driver.balance || 0) - penalty;

            await supabase
                .from('drivers')
                .update({ balance: newBalance })
                .eq('id', driverId);

            // Log penalty transaction
            await supabase
                .from('balance_transactions')
                .insert([{
                    driver_id: driverId,
                    amount: -penalty,
                    type: 'cancellation_penalty',
                    description: `خصم غرامة إلغاء رحلة سفر: ${tripId}`
                }]);

            // Update travel trip
            const { data: trip, error: tripErr } = await supabase
                .from('travel_trips')
                .update({
                    status: 'cancelled',
                    cancelled_by: 'driver',
                    cancelled_at: serverTime.toISOString(),
                    cancellation_reason: reason || 'إلغاء من السائق',
                    commission_deducted: true,
                    commission_amount: penalty,
                    updated_at: serverTime.toISOString()
                })
                .eq('id', tripId)
                .select()
                .single();

            if (tripErr) throw tripErr;

            if (trip.ride_request_id) {
                await supabase
                    .from('ride_requests')
                    .update({ status: 'cancelled' })
                    .eq('id', trip.ride_request_id);
            }

            // Log driver violation
            await supabase
                .from('driver_violations')
                .insert([{
                    driver_id: driverId,
                    type: 'cancellation',
                    description: `إلغاء رحلة السفر رقم ${tripId} بعد الموافقة عليها`
                }]);

            return res.status(200).json({ success: true, penalty });
        }

        // --- 9. COMPLETE TRIP ---
        if (action === 'complete_trip') {
            const { tripId, rideId, driverId, finalPrice } = req.body;

            if (!tripId && !rideId) {
                return res.status(400).json({ success: false, error: 'tripId or rideId is required' });
            }

            let trip = null;
            if (tripId) {
                const { data: tData } = await supabase
                    .from('travel_trips')
                    .select('*')
                    .eq('id', tripId)
                    .maybeSingle();
                trip = tData;
            }

            const targetRideId = rideId || trip?.ride_request_id;
            if (!trip && targetRideId) {
                const { data: tData } = await supabase
                    .from('travel_trips')
                    .select('*')
                    .eq('ride_request_id', targetRideId)
                    .maybeSingle();
                trip = tData;
            }

            let rideReq = null;
            if (targetRideId) {
                const { data: rData } = await supabase
                    .from('ride_requests')
                    .select('*')
                    .eq('id', targetRideId)
                    .maybeSingle();
                rideReq = rData;
            }

            if (!trip && !rideReq) {
                return res.status(400).json({ success: false, error: 'الرحلة غير موجودة' });
            }

            const activeDriverId = driverId || trip?.driver_id || rideReq?.driver_id;

            // Comprehensively update travel_trips
            if (trip?.id) {
                await supabase
                    .from('travel_trips')
                    .update({
                        status: 'completed',
                        commission_status: 'held',
                        updated_at: serverTime.toISOString()
                    })
                    .eq('id', trip.id);
            }

            if (targetRideId) {
                await supabase
                    .from('travel_trips')
                    .update({
                        status: 'completed',
                        commission_status: 'held',
                        updated_at: serverTime.toISOString()
                    })
                    .eq('ride_request_id', targetRideId);

                await supabase
                    .from('ride_requests')
                    .update({
                        status: 'completed',
                        commission_status: 'held',
                        updated_at: serverTime.toISOString()
                    })
                    .eq('id', targetRideId);
            }

            if (activeDriverId) {
                await supabase
                    .from('travel_trips')
                    .update({
                        status: 'completed',
                        commission_status: 'held',
                        updated_at: serverTime.toISOString()
                    })
                    .eq('driver_id', activeDriverId)
                    .in('status', ['driver_selected', 'in_progress']);

                await supabase
                    .from('ride_requests')
                    .update({
                        status: 'completed',
                        commission_status: 'held'
                    })
                    .eq('driver_id', activeDriverId)
                    .in('status', ['driver_selected', 'in_progress']);
            }

            const price = finalPrice || trip?.final_price || rideReq?.estimated_price || 0;
            const commission = Math.round(price * settings.travel_commission_rate / 100);
            const currentCommStatus = trip?.commission_status || rideReq?.commission_status;

            // Deduct commission ONLY if it was not already held/deducted
            if (currentCommStatus !== 'held' && activeDriverId) {
                const { data: driver } = await supabase
                    .from('drivers')
                    .select('balance')
                    .eq('id', activeDriverId)
                    .single();

                const currentBal = driver?.balance || 0;
                const newBal = currentBal - commission;

                await supabase.from('drivers').update({ balance: newBal }).eq('id', activeDriverId);
                await supabase.from('balance_transactions').insert([{
                    driver_id: activeDriverId,
                    amount: -commission,
                    type: 'commission',
                    description: `خصم عمولة منصة السفر بعد إكمال الرحلة رقم ${targetRideId || tripId}`
                }]);
            }

            return res.status(200).json({ success: true, commission: currentCommStatus === 'held' ? 0 : commission });
        }

        // --- 10. GET TRIP PASSENGER DETAILS (RESTRICTED CONTACT REVEAL) ---
        if (action === 'get_trip_passenger_details') {
            const { tripId } = req.body;

            if (!tripId) {
                return res.status(400).json({ success: false, error: 'tripId is required' });
            }

            const { data: trip, error: tErr } = await supabase
                .from('travel_trips')
                .select('passenger_id, contact_revealed, commission_status')
                .eq('id', tripId)
                .single();

            if (tErr || !trip) {
                return res.status(400).json({ success: false, error: 'الرحلة غير موجودة' });
            }

            if (!trip.contact_revealed && trip.commission_status !== 'held') {
                return res.status(403).json({ success: false, error: 'بيانات التواصل محجوبة حتى خصم/حجز العمولة قبل 10 ساعات من موعد الرحلة.' });
            }

            let passengerInfo = null;
            if (trip.passenger_id) {
                const { data: pData } = await supabase
                    .from('customers')
                    .select('full_name, phone, phone2')
                    .eq('id', trip.passenger_id)
                    .single();
                passengerInfo = pData;
            }

            return res.status(200).json({ success: true, passengerInfo });
        }

        return res.status(400).json({ success: false, error: 'Unknown action' });

    } catch (error) {
        console.error('Error in secure travel-platform handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في تنفيذ عملية السفر: ' + error.message });
    }
}
