import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const tarhalDB = createClient(SUPABASE_URL, SUPABASE_KEY);

if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
            console.log('✅ Firebase Admin initialized successfully');
        } else {
            console.error('❌ FIREBASE_SERVICE_ACCOUNT environment variable is missing');
        }
    } catch (error) { 
        console.error('❌ Firebase initialization error:', error); 
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { driverId, rideId, customerName, vehicleType, amount } = req.body;

        if (!rideId) {
            console.error('❌ rideId is required');
            return res.status(400).json({ error: 'rideId is required' });
        }

        if (!driverId) {
            console.error('❌ driverId is required');
            return res.status(400).json({ error: 'driverId is required' });
        }

        console.log('📤 ==========================================');
        console.log('📤 Sending RIDE_REQUEST notification');
        console.log('📤 Driver ID:', driverId);
        console.log('📤 Ride ID:', rideId);
        console.log('📤 Customer:', customerName || 'غير معروف');
        console.log('📤 Amount:', amount || '0');
        console.log('📤 ==========================================');

        // --- صمام الأمان لمنع تكرار الإشعار ---
        if (rideId) {
            const { data: ride, error: rideError } = await tarhalDB
                .from('rides')
                .select('status')
                .eq('id', rideId)
                .single();

            if (rideError) {
                console.error('❌ Error checking ride status:', rideError);
            }

            if (ride) {
                const allowedStatuses = ['searching', 'pending', 'awaiting_driver_acceptance'];
                
                if (!allowedStatuses.includes(ride.status)) {
                    console.log(`🚫 تم منع التكرار: الرحلة في حالة ${ride.status}`);
                    return res.status(200).json({ 
                        success: false, 
                        message: `تم التعامل مع هذه الرحلة مسبقاً (الحالة: ${ride.status})`,
                        rideStatus: ride.status
                    });
                }
                console.log('✅ Ride status is valid:', ride.status);
            }
        }

        // جلب توكن السائق
        const { data: driver, error: dbError } = await tarhalDB
            .from('drivers')
            .select('fcm_token, is_banned, ban_until')
            .eq('id', driverId)
            .single();

        if (dbError || !driver) {
            console.error('❌ Driver not found:', dbError);
            return res.status(404).json({ error: 'Driver not found' });
        }

        const isBanned = driver.is_banned && driver.ban_until && new Date(driver.ban_until) > new Date();
        if (isBanned) {
            console.log(`🚫 Driver ${driverId} is banned`);
            return res.status(403).json({ 
                success: false, 
                error: 'حساب السائق معلق',
                banned: true,
                banUntil: driver.ban_until
            });
        }

        if (!driver.fcm_token) {
            console.error('❌ FCM Token missing for driver:', driverId);
            return res.status(404).json({ error: 'FCM Token missing' });
        }

        console.log('✅ FCM Token found:', driver.fcm_token.substring(0, 20) + '...');

        // ============================================
        // ✅ DATA-ONLY (بدون notification)
        // ============================================
        const message = {
            token: driver.fcm_token,
            data: {
                ride_id: String(rideId || ''),
                type: 'RIDE_REQUEST',
                customer_name: customerName || 'عميل',
                amount: String(amount || '0'),
                vehicle_type: vehicleType || '',
                timestamp: String(Date.now()),
            },
            android: {
                priority: 'high',
                ttl: 86400,
                notification: {
                    channelId: 'emergency_channel_v15',
                    sound: 'ride_request_sound',
                    priority: 'max',
                    defaultVibrateTimings: true,
                    visibility: 'public',
                    sticky: true,
                    tag: `ride_${rideId}`,
                    clickAction: 'FLUTTER_NOTIFICATION_CLICK',
                },
                fcmOptions: {
                    analyticsLabel: 'ride_request_android',
                },
            },
            apns: {
                payload: {
                    aps: {
                        alert: {
                            title: '🚨 طلب رحلة جديد',
                            body: `${customerName || 'عميل'} - ${amount || '0'} SDG`,
                        },
                        sound: 'default',
                        badge: 1,
                        'mutable-content': 1,
                        category: 'RIDE_REQUEST_CATEGORY',
                        'interruption-level': 'critical',
                        'relevance-score': 1.0,
                    },
                },
                fcmOptions: {
                    analyticsLabel: 'ride_request_ios',
                },
            },
        };

        console.log('📤 Sending Data-only FCM message...');

        let response;
        let retries = 3;
        let lastError = null;

        while (retries > 0) {
            try {
                response = await admin.messaging().send(message);
                console.log('✅ FCM Message sent successfully:', response);
                break;
            } catch (error) {
                lastError = error;
                retries--;
                console.log(`⚠️ Attempt ${3 - retries}/3 failed:`, error.message);
                
                if (error.code === 'messaging/invalid-registration-token' || 
                    error.code === 'messaging/registration-token-not-registered') {
                    console.log('❌ Invalid token, removing from database...');
                    await tarhalDB
                        .from('drivers')
                        .update({ fcm_token: null })
                        .eq('id', driverId);
                    console.log('✅ Token removed from database');
                    break;
                }
                
                if (retries > 0) {
                    await new Promise(resolve => setTimeout(resolve, 2000));
                }
            }
        }

        if (!response && lastError) {
            console.error('❌ All retries failed:', lastError.message);
            return res.status(500).json({ 
                success: false, 
                error: lastError.message,
                retries: 3
            });
        }

        try {
            await tarhalDB
                .from('notification_logs')
                .insert({
                    ride_id: rideId,
                    driver_id: driverId,
                    type: 'RIDE_REQUEST',
                    status: 'sent',
                    fcm_response: response,
                    sent_at: new Date().toISOString()
                })
                .select();
            console.log('✅ Notification logged in database');
        } catch (logError) {
            console.log('⚠️ Could not log notification:', logError.message);
        }

        return res.status(200).json({ 
            success: true, 
            message: 'تم إرسال الإشعار بنجاح',
            response: response,
            data: {
                rideId: rideId,
                driverId: driverId,
                customerName: customerName,
                amount: amount,
            }
        });

    } catch (error) {
        console.error('❌ Error in send-push handler:', error);
        return res.status(500).json({ 
            success: false,
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
}

function getVehicleTypeArabic(type) {
    const types = {
        'tuktuk': 'توك توك',
        'economy': 'اقتصادية',
        'comfort': 'متوسطة',
        'vip': 'VIP',
        'motorcycle': 'دراجة نارية',
        'car': 'سيارة',
        'suv': 'دفع رباعي',
        'van': 'فان',
        'bus': 'حافلة'
    };
    return types[type] || type || 'سيارة';
}