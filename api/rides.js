import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
        // التحقق من التوكن في كل الطلبات الواردة إلى Rides API
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

        // --- 1. CREATE RIDE ---
        if (action === 'create') {
            const {
                passengerId, requestId, fromCity, toCity, basePrice, finalPrice,
                pickupLat, pickupLng, pickupAddress,
                destinationLat, destinationLng, destinationAddress,
                amount, distanceKm, carType
            } = req.body;

            if (!passengerId || !pickupLat || !pickupLng || !amount) {
                return res.status(400).json({ success: false, error: 'بيانات غير كافية لإنشاء الرحلة' });
            }

            // Verify passenger exists and is verified
            const { data: passenger, error: pErr } = await supabase
                .from('customers')
                .select('id, is_verified, full_name, phone')
                .eq('id', passengerId)
                .single();

            if (pErr || !passenger) {
                return res.status(400).json({ success: false, error: 'الراكب غير مسجل في النظام' });
            }

            if (!passenger.is_verified) {
                return res.status(403).json({ success: false, error: 'الحساب غير مفعل' });
            }

            // Generate UUID for request_id if not provided
            let reqId = requestId;
            if (!reqId) {
                try {
                    reqId = crypto.randomUUID();
                } catch (e) {
                    reqId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
                        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
                        return v.toString(16);
                    });
                }
            }

            // Create ride using the exact schema column names
            const { data, error } = await supabase
                .from('rides')
                .insert([{
                    request_id: reqId,
                    passenger_id: passengerId,
                    passenger_name: passenger.full_name,
                    passenger_phone: passenger.phone,
                    from_city: fromCity || 'غير محدد',
                    to_city: toCity || 'غير محدد',
                    vehicle_category: carType,
                    base_price: basePrice || Math.round(amount),
                    final_price: finalPrice || Math.round(amount),
                    amount: amount,
                    pickup_lat: pickupLat,
                    pickup_lng: pickupLng,
                    pickup_address: pickupAddress,
                    destination_lat: destinationLat,
                    destination_lng: destinationLng,
                    destination_address: destinationAddress,
                    distance_km: distanceKm,
                    status: 'searching',
                    search_started_at: new Date().toISOString(),
                    driver_accepted: false,
                    driver_rejected: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString()
                }])
                .select()
                .single();

            if (error) throw error;

            return res.status(200).json({ success: true, ride: data });
        }

        // --- 2. ACCEPT RIDE (RPC WRAPPER) ---
        if (action === 'accept') {
            const { rideId, driverId } = req.body;

            if (!rideId || !driverId) {
                return res.status(400).json({ success: false, error: 'rideId and driverId are required' });
            }

            // Check if driver is active
            const { data: driver } = await supabase
                .from('drivers')
                .select('is_active, balance')
                .eq('id', driverId)
                .single();

            if (!driver || !driver.is_active) {
                return res.status(403).json({ success: false, error: 'حساب السائق غير مفعل' });
            }

            const { data, error } = await supabase.rpc('accept_immediate_ride', {
                p_ride_id: rideId,
                p_driver_id: driverId
            });

            if (error) {
                return res.status(400).json({ success: false, error: error.message });
            }

            return res.status(200).json({ success: true, result: data });
        }

        // --- 3. UPDATE STATUS (FROM DRIVER) ---
        if (action === 'update_status') {
            const { rideId, driverId, status } = req.body;

            if (!rideId || !status) {
                return res.status(400).json({ success: false, error: 'rideId and status are required' });
            }

            const updatePayload = {
                status,
                updated_at: new Date().toISOString()
            };

            if (status === 'ongoing') {
                updatePayload.started_at = new Date().toISOString();
            } else if (status === 'completed') {
                updatePayload.completed_at = new Date().toISOString();
            }

            // Verify if update is authorized
            if (driverId) {
                const { data: ride } = await supabase
                    .from('rides')
                    .select('driver_id')
                    .eq('id', rideId)
                    .single();

                if (ride && ride.driver_id !== driverId) {
                    return res.status(403).json({ success: false, error: 'غير مصرح بتحديث حالة هذه الرحلة' });
                }
            }

            const { data, error } = await supabase
                .from('rides')
                .update(updatePayload)
                .eq('id', rideId)
                .select()
                .single();

            if (error) throw error;

            return res.status(200).json({ success: true, ride: data });
        }

        // --- 4. COMPLETE RIDE (RPC WRAPPER) ---
        if (action === 'complete') {
            const { rideId } = req.body;

            if (!rideId) {
                return res.status(400).json({ success: false, error: 'rideId is required' });
            }

            const { error } = await supabase.rpc('complete_ride', { p_ride_id: rideId });

            if (error) {
                return res.status(400).json({ success: false, error: error.message });
            }

            return res.status(200).json({ success: true });
        }

        // --- 5. CANCEL BY PASSENGER (WITH DETAILED COMMISSION REFUND RULES) ---
        if (action === 'cancel_by_passenger') {
            const { rideId, passengerId, elapsedMinutes, driverLat, driverLng } = req.body;

            if (!rideId) {
                return res.status(400).json({ success: false, error: 'rideId is required' });
            }

            // Get ride details
            const { data: rideData, error: rErr } = await supabase
                .from('rides')
                .select('*')
                .eq('id', rideId)
                .single();

            if (rErr || !rideData) {
                return res.status(400).json({ success: false, error: 'الرحلة غير موجودة' });
            }

            const rideAmount = rideData.amount || 0;
            const commissionAmount = Math.floor(rideAmount * 0.10); // 10% commission hold or cancellation rules

            let driverWithinRange = false;
            if (rideData.driver_id && driverLat && driverLng && rideData.pickup_lat && rideData.pickup_lng) {
                // Calculate distance manually
                const R = 6371e3; // meters
                const φ1 = rideData.pickup_lat * Math.PI/180;
                const φ2 = driverLat * Math.PI/180;
                const Δφ = (driverLat-rideData.pickup_lat) * Math.PI/180;
                const Δλ = (driverLng-rideData.pickup_lng) * Math.PI/180;

                const a = Math.sin(Δφ/2) * Math.sin(Δφ/2) +
                        Math.cos(φ1) * Math.cos(φ2) *
                        Math.sin(Δλ/2) * Math.sin(Δλ/2);
                const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
                const d = R * c; // in meters

                driverWithinRange = d <= 200; // 200 meters
            }

            let finalStatus = 'cancelled_by_customer';
            let cancellationReason = '';

            if (elapsedMinutes <= 2) {
                // Within 2 minutes: Return commission to driver (full refund)
                if (rideData.driver_id && commissionAmount > 0) {
                    const { data: driver } = await supabase
                        .from('drivers')
                        .select('balance')
                        .eq('id', rideData.driver_id)
                        .single();

                    if (driver) {
                        await supabase
                            .from('drivers')
                            .update({ balance: (driver.balance || 0) + commissionAmount })
                            .eq('id', rideData.driver_id);

                        await supabase.from('balance_transactions').insert([{
                            driver_id: rideData.driver_id,
                            ride_id: rideId,
                            amount: commissionAmount,
                            type: 'cancellation_refund',
                            description: 'استرجاع عمولة الرحلة - إلغاء الراكب خلال دقيقتين'
                        }]);
                    }
                }
                cancellationReason = 'تم استرجاع العمولة للسائق (إلغاء خلال دقيقتين)';
            } else if (driverWithinRange) {
                // After 2 minutes + driver is nearby (within 200m): Keep commission, mark as completed
                finalStatus = 'completed';
                cancellationReason = 'السائق كان بالقرب من نقطة الاستلام - تم إبقاء العمولة للشركة';
            } else {
                // After 2 minutes + driver NOT nearby: Return commission to driver
                if (rideData.driver_id && commissionAmount > 0) {
                    const { data: driver } = await supabase
                        .from('drivers')
                        .select('balance')
                        .eq('id', rideData.driver_id)
                        .single();

                    if (driver) {
                        await supabase
                            .from('drivers')
                            .update({ balance: (driver.balance || 0) + commissionAmount })
                            .eq('id', rideData.driver_id);

                        await supabase.from('balance_transactions').insert([{
                            driver_id: rideData.driver_id,
                            ride_id: rideId,
                            amount: commissionAmount,
                            type: 'cancellation_refund',
                            description: 'استرجاع عمولة الرحلة - إلغاء بعد دقيقتين والسائق بعيد'
                        }]);
                    }
                }
                cancellationReason = 'تم استرجاع العمولة للسائق (السائق لم يكن قريباً)';
            }

            // Update ride status
            const updatePayload = {
                status: finalStatus,
                updated_at: new Date().toISOString(),
                cancellation_reason: cancellationReason
            };

            if (finalStatus === 'completed') {
                updatePayload.completed_at = new Date().toISOString();
            } else {
                updatePayload.cancelled_at = new Date().toISOString();
            }

            const { error: updateError } = await supabase
                .from('rides')
                .update(updatePayload)
                .eq('id', rideId);

            if (updateError) throw updateError;

            return res.status(200).json({ success: true, finalStatus, cancellationReason });
        }

        // --- 6. CANCEL BY DRIVER ---
        if (action === 'cancel_by_driver') {
            const { rideId, driverId, amount } = req.body;

            if (!rideId || !driverId) {
                return res.status(400).json({ success: false, error: 'rideId and driverId are required' });
            }

            const { error } = await supabase.rpc('handle_cancellation_penalty', {
                p_ride_id: rideId,
                p_driver_id: driverId,
                p_amount: amount || 0
            });

            if (error) throw error;

            return res.status(200).json({ success: true });
        }

        // --- 7. BAN DRIVER (24 HOURS) ---
        if (action === 'ban_driver') {
            const { driverId, reason } = req.body;

            if (!driverId) {
                return res.status(400).json({ success: false, error: 'driverId is required' });
            }

            const banUntil = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

            const { error } = await supabase
                .from('drivers')
                .update({
                    is_banned: true,
                    ban_reason: reason || 'مخالفة شروط الخدمة - طلب الإلغاء من الراكب',
                    ban_until: banUntil
                })
                .eq('id', driverId);

            if (error) throw error;

            return res.status(200).json({ success: true, banUntil });
        }

        // --- 8. REJECT BY DRIVER ---
        if (action === 'reject') {
            const { rideId, driverId } = req.body;

            if (!rideId || !driverId) {
                return res.status(400).json({ success: false, error: 'rideId and driverId are required' });
            }

            // Verify if the current driver is indeed the one assigned
            const { data: ride } = await supabase
                .from('rides')
                .select('driver_id')
                .eq('id', rideId)
                .single();

            if (ride && ride.driver_id !== driverId) {
                return res.status(403).json({ success: false, error: 'غير مصرح برفض هذه الرحلة' });
            }

            // Update the ride status and driver_rejected
            const { data, error } = await supabase
                .from('rides')
                .update({
                    driver_id: null,
                    driver_name: null,
                    driver_phone: null,
                    status: 'searching',
                    driver_rejected: true, // Mark that driver has rejected, so sequential search continues immediately!
                    updated_at: new Date().toISOString()
                })
                .eq('id', rideId)
                .select()
                .single();

            if (error) throw error;

            return res.status(200).json({ success: true, ride: data });
        }

        return res.status(400).json({ success: false, error: 'Unknown action' });

    } catch (error) {
        console.error('Error in secure rides handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في تنفيذ عملية الرحلة: ' + error.message });
    }
}
