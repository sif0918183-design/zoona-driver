import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(
                    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
                )
            });
        }
    } catch (error) {
        console.error('Firebase Error:', error);
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).end();

    try {
        const {
            driverId,
            rideId,
            customerName,
            vehicleType,
            amount
        } = req.body;

        // =========================================================
        // منع إرسال إشعار مكرر للرحلة التي تم التعامل معها
        // =========================================================
        if (rideId) {
            const { data: ride } = await tarhalDB
                .from('rides')
                .select('status')
                .eq('id', rideId)
                .single();

            const allowedStatuses = [
                'searching',
                'pending',
                'awaiting_driver_acceptance'
            ];

            if (ride && !allowedStatuses.includes(ride.status)) {
                console.log(
                    `تم منع التكرار: الرحلة في حالة ${ride.status}`
                );

                return res.status(200).json({
                    success: false,
                    message:
                        'تم التعامل مع هذه الرحلة مسبقاً، لن يتم إرسال إشعار مكرر.'
                });
            }
        }

        // =========================================================
        // جلب بيانات السائق
        // =========================================================
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('fcm_token, is_banned, ban_until')
            .eq('id', driverId)
            .single();

        if (dbError || !driver) {
            return res.status(404).json({
                error: 'Driver not found'
            });
        }

        // =========================================================
        // التحقق من الحظر
        // =========================================================
        const isBanned =
            driver.is_banned &&
            driver.ban_until &&
            new Date(driver.ban_until) > new Date();

        if (isBanned) {
            console.log(
                `Driver ${driverId} is banned until ${driver.ban_until}.`
            );

            return res.status(403).json({
                success: false,
                error: 'حساب السائق معلق ومحظور حالياً من العمل.'
            });
        }

        if (!driver.fcm_token) {
            return res.status(404).json({
                error: 'Token missing'
            });
        }

        // =========================================================
        // RIDE_REQUEST
        //
        // مهم جداً:
        // هذا الإشعار DATA-ONLY.
        //
        // لا يوجد notification block.
        //
        // الهدف:
        // FCM
        // -> Flutter background handler
        // -> flutter_local_notifications
        // -> emergency_channel_v25
        // =========================================================

        const title = 'طلب رحلة جديد - تراكا';

        const body =
            `عميل: ${customerName || 'عميل'}\n` +
            `الأجرة: ${amount || '0'} SDG`;

        const message = {
            token: driver.fcm_token,

            // =====================================================
            // لا تضف notification هنا.
            // RIDE_REQUEST يجب أن يكون DATA-ONLY.
            // =====================================================

            data: {
                type: 'RIDE_REQUEST',

                ride_id: String(rideId || ''),

                customer_name: String(
                    customerName || 'عميل'
                ),

                amount: String(
                    amount || '0'
                ),

                vehicle_type: String(
                    vehicleType || ''
                ),

                title: title,

                body: body,

                click_action:
                    'FLUTTER_NOTIFICATION_CLICK'
            },

            android: {
                priority: 'high'
            },

            apns: {
                payload: {
                    aps: {
                        sound: 'default',
                        badge: 1,
                        'mutable-content': 1,
                        category: 'RIDE_REQUEST_CATEGORY',
                        'interruption-level': 'critical',
                        'relevance-score': 1.0
                    }
                }
            }
        };

        console.log(
            '[RIDE_REQUEST] Sending DATA-ONLY FCM message'
        );

        console.log(
            '[RIDE_REQUEST] Channel is controlled by Flutter:',
            'emergency_channel_v25'
        );

        // =========================================================
        // إرسال مع إعادة المحاولة
        // =========================================================

        let response;
        let retries = 3;

        while (retries > 0) {
            try {
                response = await admin
                    .messaging()
                    .send(message);

                console.log(
                    '✅ تم إرسال RIDE_REQUEST:',
                    response
                );

                break;
            } catch (error) {
                retries--;

                console.log(
                    `⚠️ محاولة إعادة الإرسال (${3 - retries}/3):`,
                    error.message
                );

                if (retries === 0) {
                    throw error;
                }

                await new Promise(resolve =>
                    setTimeout(resolve, 1000)
                );
            }
        }

        return res.status(200).json({
            success: true,
            message: 'تم إرسال RIDE_REQUEST بنجاح',
            response: response
        });

    } catch (error) {
        console.error(
            '❌ خطأ في إرسال الإشعار:',
            error
        );

        return res.status(500).json({
            error: error.message
        });
    }
}