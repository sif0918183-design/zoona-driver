import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const COMMISSION_RATE = 5; // 5% commission rate
const STOP_BALANCE_THRESHOLD = 1000;

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

        // --- 1. CREATE TRIP ---
        if (action === 'create_trip') {
            const { rideRequestId, driverId, passengerId, fromCity, toCity, price, carType, carModel, date } = req.body;

            if (!rideRequestId || !driverId || !passengerId || !price) {
                return res.status(400).json({ success: false, error: 'بيانات غير كافية لإنشاء الرحلة' });
            }

            const { data, error } = await supabase
                .from('travel_trips')
                .insert([{
                    ride_request_id: rideRequestId,
                    driver_id: driverId,
                    passenger_id: passengerId,
                    from_city: fromCity,
                    to_city: toCity,
                    final_price: price,
                    status: 'driver_selected',
                    car_type: carType,
                    car_model: carModel,
                    trip_date: date,
                    created_at: new Date().toISOString()
                }])
                .select()
                .single();

            if (error) throw error;

            return res.status(200).json({ success: true, trip: data });
        }

        // --- 2. UPDATE TRIP STATUS ---
        if (action === 'update_status') {
            const { tripId, status } = req.body;

            if (!tripId || !status) {
                return res.status(400).json({ success: false, error: 'tripId and status are required' });
            }

            const { data, error } = await supabase
                .from('travel_trips')
                .update({
                    status,
                    updated_at: new Date().toISOString()
                })
                .eq('id', tripId)
                .select()
                .single();

            if (error) throw error;

            return res.status(200).json({ success: true, trip: data });
        }

        // --- 3. COMPLETE TRIP (WITH BALANCE DEDUCTION) ---
        if (action === 'complete_trip') {
            const { tripId, driverId, finalPrice } = req.body;

            if (!tripId || !driverId || !finalPrice) {
                return res.status(400).json({ success: false, error: 'tripId, driverId, and finalPrice are required' });
            }

            // Get current driver balance
            const { data: driver, error: dErr } = await supabase
                .from('drivers')
                .select('balance')
                .eq('id', driverId)
                .single();

            if (dErr || !driver) {
                return res.status(400).json({ success: false, error: 'السائق غير مسجل في النظام' });
            }

            const commission = Math.round(finalPrice * COMMISSION_RATE / 100);
            const newBalance = (driver.balance || 0) - commission;

            if (newBalance < STOP_BALANCE_THRESHOLD) {
                return res.status(400).json({
                    success: false,
                    error: `رصيدك غير كافٍ لخصم العمولة (${commission.toLocaleString()} ج). الحد الأدنى المطلوب للرصيد هو ${STOP_BALANCE_THRESHOLD} ج`
                });
            }

            // Deduct commission from driver balance
            const { error: balanceErr } = await supabase
                .from('drivers')
                .update({ balance: newBalance })
                .eq('id', driverId);

            if (balanceErr) throw balanceErr;

            // Log balance transaction
            await supabase
                .from('balance_transactions')
                .insert([{
                    driver_id: driverId,
                    amount: -commission,
                    type: 'commission',
                    description: `خصم عمولة منصة السفر لرحلة: ${tripId}`
                }]);

            // Update travel trip
            const { data: trip, error: tripErr } = await supabase
                .from('travel_trips')
                .update({
                    status: 'completed',
                    trip_completed_at: new Date().toISOString(),
                    commission_deducted: true,
                    commission_amount: commission,
                    updated_at: new Date().toISOString()
                })
                .eq('id', tripId)
                .select()
                .single();

            if (tripErr) throw tripErr;

            // Update ride requests (if matches)
            if (trip.ride_request_id) {
                await supabase
                    .from('ride_requests')
                    .update({ status: 'completed' })
                    .eq('id', trip.ride_request_id);
            }

            return res.status(200).json({ success: true, trip, commission });
        }

        // --- 4. PASSENGER CANCEL TRIP ---
        if (action === 'passenger_cancel') {
            const { tripId, reason } = req.body;

            if (!tripId) {
                return res.status(400).json({ success: false, error: 'tripId is required' });
            }

            const { data: trip, error: tripErr } = await supabase
                .from('travel_trips')
                .update({
                    status: 'cancelled',
                    cancelled_by: 'passenger',
                    cancelled_at: new Date().toISOString(),
                    cancellation_reason: reason || 'إلغاء من الراكب',
                    updated_at: new Date().toISOString()
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

            return res.status(200).json({ success: true });
        }

        // --- 5. DRIVER CANCEL TRIP (WITH PENALTY) ---
        if (action === 'driver_cancel') {
            const { tripId, driverId, finalPrice, reason } = req.body;

            if (!tripId || !driverId || !finalPrice) {
                return res.status(400).json({ success: false, error: 'tripId, driverId, and finalPrice are required' });
            }

            const penalty = Math.round(finalPrice * COMMISSION_RATE / 100);

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
                    cancelled_at: new Date().toISOString(),
                    cancellation_reason: reason || 'إلغاء من السائق',
                    commission_deducted: true,
                    commission_amount: penalty,
                    updated_at: new Date().toISOString()
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

        return res.status(400).json({ success: false, error: 'Unknown action' });

    } catch (error) {
        console.error('Error in secure travel-platform handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في تنفيذ عملية السفر: ' + error.message });
    }
}
