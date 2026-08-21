import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error('❌ Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
}

const db = createClient(SUPABASE_URL, SUPABASE_KEY);

// ============================================================
// Firebase Admin initialization
// ============================================================

if (!admin.apps.length) {
    try {
        const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;

        if (serviceAccount) {
            admin.initializeApp({
                credential: admin.credential.cert(
                    JSON.parse(serviceAccount)
                )
            });

            console.log('✅ Firebase Admin initialized');
        } else {
            console.error('❌ FIREBASE_SERVICE_ACCOUNT is missing');
        }
    } catch (e) {
        console.error('❌ Firebase initialization error:', e.message);
    }
}

// ============================================================
// Helpers
// ============================================================

function cleanData(data = {}) {
    const result = {};

    for (const [key, value] of Object.entries(data)) {
        if (value === undefined || value === null) {
            continue;
        }

        result[key] = String(value);
    }

    return result;
}

function isValidToken(token) {
    return typeof token === 'string' && token.trim().length > 0;
}

// ============================================================
// Driver
// ============================================================

async function getDriverFcm(driverId) {
    if (!driverId) {
        return null;
    }

    const { data, error } = await db
        .from('drivers')
        .select(
            'fcm_token,full_name,is_banned,ban_until'
        )
        .eq('id', driverId)
        .single();

    if (error) {
        console.error(
            `❌ Failed to get driver ${driverId}:`,
            error.message
        );
        return null;
    }

    if (!data) {
        return null;
    }

    // Do not send travel/ride notifications to currently banned drivers.
    const isBanned =
        data.is_banned === true &&
        data.ban_until &&
        new Date(data.ban_until) > new Date();

    if (isBanned) {
        console.log(
            `🚫 Driver ${driverId} is banned until ${data.ban_until}. Notification blocked.`
        );

        return null;
    }

    return data;
}

// ============================================================
// Passenger
// ============================================================

async function getPassengerFcm(customerId) {
    if (!customerId) {
        return null;
    }

    const { data, error } = await db
        .from('customers')
        .select('fcm_token,full_name')
        .eq('id', customerId)
        .single();

    if (error) {
        console.error(
            `❌ Failed to get passenger ${customerId}:`,
            error.message
        );
        return null;
    }

    return data || null;
}

// ============================================================
// RIDE_REQUEST
//
// IMPORTANT:
// This is intentionally DATA-ONLY.
//
// Do NOT include:
//   notification: {...}
//
// The Flutter app's background handler must receive this
// message and create the local notification itself.
//
// This prevents Android/FCM from creating an automatic
// notification which can conflict with FlutterLocalNotifications.
// ============================================================

async function sendRideRequestPush(
    token,
    {
        rideId,
        driverId,
        customerName,
        amount,
        fromCity,
        toCity
    }
) {
    if (!isValidToken(token)) {
        return {
            skipped: true,
            reason: 'no_token'
        };
    }

    const data = cleanData({
        type: 'RIDE_REQUEST',

        // Keep both forms for compatibility.
        ride_id: rideId,
        rideId: rideId,

        driver_id: driverId,

        customer_name: customerName || 'عميل',

        amount:
            amount !== undefined && amount !== null
                ? amount
                : '0',

        from_city: fromCity || '',
        to_city: toCity || '',

        // Used by Flutter notification click handling.
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
    });

    const message = {
        token,

        // ====================================================
        // NO notification payload here.
        // This MUST remain data-only for RIDE_REQUEST.
        // ====================================================

        data,

        android: {
            priority: 'high',

            // Prevent FCM/Android from collapsing multiple
            // ride requests into one notification.
            collapseKey: `ride_request_${rideId || Date.now()}`,

            ttl: 60 * 1000,

            directBootOk: true
        }
    };

    try {
        const response = await admin.messaging().send(message);

        console.log(
            `✅ RIDE_REQUEST push sent to driver ${driverId}`,
            response
        );

        return {
            sent: true,
            messageId: response,
            notification_type: 'RIDE_REQUEST',
            delivery_mode: 'data_only'
        };
    } catch (error) {
        console.error(
            `❌ RIDE_REQUEST push failed for driver ${driverId}:`,
            error.message
        );

        // Remove invalid/unregistered FCM tokens automatically.
        const code = error?.code || '';

        if (
            code === 'messaging/registration-token-not-registered' ||
            code === 'messaging/invalid-registration-token'
        ) {
            try {
                await db
                    .from('drivers')
                    .update({ fcm_token: null })
                    .eq('id', driverId);

                console.log(
                    `🧹 Invalid FCM token removed for driver ${driverId}`
                );
            } catch (cleanupError) {
                console.error(
                    '⚠️ Failed to remove invalid FCM token:',
                    cleanupError.message
                );
            }
        }

        return {
            sent: false,
            error: error.message,
            code
        };
    }
}

// ============================================================
// Normal / quiet travel notification
//
// These notifications may contain a notification payload
// because they are NOT emergency ride requests.
// ============================================================

async function sendTravelPush(
    token,
    title,
    body,
    data = {}
) {
    if (!isValidToken(token)) {
        return {
            skipped: true,
            reason: 'no_token'
        };
    }

    const safeData = cleanData({
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
    });

    const message = {
        token,

        notification: {
            title,
            body
        },

        data: safeData,

        android: {
            priority: 'high',

            notification: {
                channelId: 'travel_notifications',
                sound: 'default',
                clickAction: 'FLUTTER_NOTIFICATION_CLICK'
            }
        },

        apns: {
            payload: {
                aps: {
                    sound: 'default',
                    badge: 1
                }
            }
        }
    };

    try {
        const response = await admin.messaging().send(message);

        return {
            sent: true,
            messageId: response
        };
    } catch (error) {
        console.error(
            '❌ Travel push failed:',
            error.message
        );

        return {
            sent: false,
            error: error.message,
            code: error?.code || ''
        };
    }
}

// ============================================================
// HTTP Handler
// ============================================================

export default async function handler(req, res) {
    res.setHeader(
        'Access-Control-Allow-Origin',
        '*'
    );

    res.setHeader(
        'Access-Control-Allow-Methods',
        'POST, OPTIONS'
    );

    res.setHeader(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization'
    );

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({
            success: false,
            error: 'Method not allowed'
        });
    }

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
            customerName,
            amount
        } = req.body || {};

        if (!type) {
            return res.status(400).json({
                success: false,
                error: 'type is required'
            });
        }

        if (!admin.apps.length) {
            return res.status(200).json({
                success: false,
                reason: 'firebase_not_initialized'
            });
        }

        // ====================================================
        // 0. RIDE_REQUEST
        //
        // New ride request -> driver
        // ====================================================

        if (type === 'RIDE_REQUEST') {
            if (!rideId) {
                return res.status(400).json({
                    success: false,
                    error: 'rideId required'
                });
            }

            if (!driverId) {
                return res.status(400).json({
                    success: false,
                    error: 'driverId required'
                });
            }

            const driver = await getDriverFcm(driverId);

            if (!driver) {
                return res.status(200).json({
                    success: false,
                    reason: 'driver_not_found_or_banned'
                });
            }

            if (!isValidToken(driver.fcm_token)) {
                return res.status(200).json({
                    success: false,
                    reason: 'no_driver_token'
                });
            }

            const result = await sendRideRequestPush(
                driver.fcm_token,
                {
                    rideId,
                    driverId,
                    customerName:
                        customerName ||
                        req.body.customer_name ||
                        'عميل',
                    amount:
                        amount !== undefined
                            ? amount
                            : req.body.amount || '0',
                    fromCity:
                        fromCity ||
                        req.body.from_city ||
                        '',
                    toCity:
                        toCity ||
                        req.body.to_city ||
                        ''
                }
            );

            return res.status(200).json({
                success: result.sent === true,
                ...result
            });
        }

        // ====================================================
        // 1. DRIVER_OFFER
        //
        // Driver accepted ride -> passenger
        // ====================================================

        if (type === 'DRIVER_OFFER') {
            if (!rideId) {
                return res.status(400).json({
                    success: false,
                    error: 'rideId required'
                });
            }

            const { data: ride, error } = await db
                .from('ride_requests')
                .select(
                    'customer_id,from_city,to_city'
                )
                .eq('id', rideId)
                .single();

            if (error) {
                console.error(
                    '❌ DRIVER_OFFER ride lookup:',
                    error.message
                );
            }

            if (!ride?.customer_id) {
                return res.status(404).json({
                    success: false,
                    error: 'ride or customer not found'
                });
            }

            const passenger =
                await getPassengerFcm(
                    ride.customer_id
                );

            if (
                !passenger ||
                !isValidToken(passenger.fcm_token)
            ) {
                return res.status(200).json({
                    success: false,
                    reason: 'no_passenger_token'
                });
            }

            const result = await sendTravelPush(
                passenger.fcm_token,

                '🚗 سائق قَبِل رحلتك - تراكا',

                `رحلة: ${ride.from_city || ''} → ${ride.to_city || ''}\nاضغط لاختيار السائق}`,

                {
                    type: 'DRIVER_OFFER',
                    ride_id: String(rideId)
                }
            );

            return res.status(200).json({
                success: result.sent === true,
                ...result
            });
        }

        // ====================================================
        // 2. DRIVER_SELECTED
        //
        // Passenger selected driver -> driver
        // ====================================================

        if (type === 'DRIVER_SELECTED') {
            if (!driverId) {
                return res.status(400).json({
                    success: false,
                    error: 'driverId required'
                });
            }

            const driver =
                await getDriverFcm(driverId);

            if (!driver) {
                return res.status(200).json({
                    success: false,
                    reason: 'driver_not_found_or_banned'
                });
            }

            if (!isValidToken(driver.fcm_token)) {
                return res.status(200).json({
                    success: false,
                    reason: 'no_driver_token'
                });
            }

            const routeText =
                fromCity && toCity
                    ? `${fromCity} → ${toCity}`
                    : 'الرحلة';

            const result = await sendTravelPush(
                driver.fcm_token,

                '✅ تم اختيارك للرحلة - تراكا',

                `الراكب اختارك لرحلة ${routeText}\nاضغط لفتح تفاصيل الرحلة`,

                {
                    type: 'DRIVER_SELECTED',
                    ride_id: String(rideId || '')
                }
            );

            return res.status(200).json({
                success: result.sent === true,
                ...result
            });
        }

        // ====================================================
        // 3. NEW_CHAT_MESSAGE
        // ====================================================

        if (type === 'NEW_CHAT_MESSAGE') {
            if (!rideId || !senderType) {
                return res.status(400).json({
                    success: false,
                    error:
                        'rideId and senderType required'
                });
            }

            const preview =
                messagePreview
                    ? String(messagePreview).substring(
                          0,
                          60
                      )
                    : 'رسالة جديدة';

            const sender =
                senderName ||
                (
                    senderType === 'driver'
                        ? 'السائق'
                        : 'الراكب'
                );

            // ------------------------------------------------
            // Driver -> Passenger
            // ------------------------------------------------

            if (senderType === 'driver') {
                const { data: ride } = await db
                    .from('ride_requests')
                    .select('customer_id')
                    .eq('id', rideId)
                    .single();

                if (!ride?.customer_id) {
                    return res.status(200).json({
                        success: false,
                        reason: 'no_customer_id'
                    });
                }

                const passenger =
                    await getPassengerFcm(
                        ride.customer_id
                    );

                if (
                    !passenger ||
                    !isValidToken(
                        passenger.fcm_token
                    )
                ) {
                    return res.status(200).json({
                        success: false,
                        reason:
                            'no_passenger_token'
                    });
                }

                const result =
                    await sendTravelPush(
                        passenger.fcm_token,

                        `💬 رسالة من ${sender} - تراكا`,

                        preview,

                        {
                            type:
                                'NEW_CHAT_MESSAGE',

                            ride_id:
                                String(rideId),

                            url:
                                `/passenger_app/travel-platform.html#chat-${rideId}`
                        }
                    );

                return res.status(200).json({
                    success:
                        result.sent === true,
                    ...result
                });
            }

            // ------------------------------------------------
            // Passenger -> Driver
            // ------------------------------------------------

            const { data: ride } = await db
                .from('ride_requests')
                .select('driver_id')
                .eq('id', rideId)
                .single();

            let recipientDriverId =
                ride?.driver_id;

            // Fallback: latest accepted driver.
            if (!recipientDriverId) {
                const { data: acc } =
                    await db
                        .from(
                            'ride_driver_acceptances'
                        )
                        .select('driver_id')
                        .eq(
                            'ride_id',
                            rideId
                        )
                        .eq(
                            'status',
                            'accepted'
                        )
                        .order(
                            'accepted_at',
                            {
                                ascending: false
                            }
                        )
                        .limit(1)
                        .single();

                recipientDriverId =
                    acc?.driver_id;
            }

            if (!recipientDriverId) {
                return res.status(200).json({
                    success: false,
                    reason: 'no_driver_id'
                });
            }

            const driver =
                await getDriverFcm(
                    recipientDriverId
                );

            if (
                !driver ||
                !isValidToken(driver.fcm_token)
            ) {
                return res.status(200).json({
                    success: false,
                    reason: 'no_driver_token'
                });
            }

            const result =
                await sendTravelPush(
                    driver.fcm_token,

                    `💬 رسالة من ${sender} - تراكا`,

                    preview,

                    {
                        type:
                            'NEW_CHAT_MESSAGE',

                        ride_id:
                            String(rideId),

                        url:
                            `/driver_app/travel-platform.html#chat-${rideId}`
                    }
                );

            return res.status(200).json({
                success:
                    result.sent === true,
                ...result
            });
        }

        // ====================================================
        // Unknown type
        // ====================================================

        return res.status(400).json({
            success: false,
            error: `unknown type: ${type}`
        });

    } catch (err) {
        console.error(
            '❌ travel-push error:',
            err
        );

        return res.status(500).json({
            success: false,
            error: err.message
        });
    }
}