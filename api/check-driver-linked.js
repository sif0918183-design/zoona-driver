import admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ✅ تهيئة Firebase Admin للتحقق من صحة التوكن
if (!admin.apps.length) {
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT) {
            admin.initializeApp({
                credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
            });
            console.log('✅ Firebase Admin initialized');
        } else {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT not found');
        }
    } catch (error) { 
        console.error('❌ Firebase initialization error:', error); 
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        const { driverId } = req.body;

        if (!driverId) {
            return res.status(400).json({ success: false, error: 'driverId is required' });
        }

        console.log(`[check-driver-linked] Checking FCM token for driver: ${driverId}`);

        // ✅ جلب بيانات السائق
        const { data, error } = await supabase
            .from('drivers')
            .select('fcm_token, is_banned, ban_until')
            .eq('id', driverId)
            .single();

        if (error || !data) {
            console.warn(`[check-driver-linked] Driver not found: ${driverId}`, error);
            return res.status(200).json({ 
                linked: false, 
                error: 'Driver not found' 
            });
        }

        // ✅ التحقق من الحظر
        const isBanned = data.is_banned && data.ban_until && new Date(data.ban_until) > new Date();
        if (isBanned) {
            console.log(`[check-driver-linked] Driver ${driverId} is banned.`);
            return res.status(200).json({ 
                linked: false, 
                is_banned: true,
                ban_until: data.ban_until
            });
        }

        const fcmToken = data.fcm_token;

        // ✅ إذا لم يكن هناك توكن
        if (!fcmToken || fcmToken === 'false' || fcmToken === 'null' || fcmToken === '') {
            console.log(`[check-driver-linked] No valid token for driver ${driverId}`);
            return res.status(200).json({ 
                linked: false,
                fcm_token: null,
                token_valid: false,
                reason: 'no_token'
            });
        }

        // ✅ ✅ ✅ التحقق الفعلي من صحة التوكن مع Firebase
        let isValidToken = false;
        let tokenValidated = false;
        
        if (admin.apps.length > 0) {
            try {
                // ✅ إرسال رسالة اختبار (ping)
                const testMessage = {
                    token: fcmToken,
                    data: { 
                        type: 'TEST', 
                        action: 'ping',
                        timestamp: Date.now().toString()
                    },
                    android: { 
                        priority: 'high' 
                    }
                };
                
                await admin.messaging().send(testMessage);
                isValidToken = true;
                tokenValidated = true;
                console.log(`✅ التوكن صالح للسائق ${driverId}`);
                
            } catch (tokenError) {
                // ✅ إذا كان التوكن غير صالح
                if (tokenError.code === 'messaging/registration-token-not-registered' || 
                    tokenError.code === 'messaging/invalid-registration-token') {
                    
                    console.log(`⚠️ التوكن غير صالح للسائق ${driverId}، جاري حذفه...`);
                    isValidToken = false;
                    tokenValidated = true;
                    
                    // ✅ ✅ ✅ حذف التوكن من قاعدة البيانات
                    const { error: updateError } = await supabase
                        .from('drivers')
                        .update({ 
                            fcm_token: null,
                            last_fcm_sync: new Date().toISOString()
                        })
                        .eq('id', driverId);
                    
                    if (updateError) {
                        console.error(`❌ فشل حذف التوكن: ${updateError.message}`);
                    } else {
                        console.log(`🗑️ تم حذف التوكن غير الصالح للسائق ${driverId}`);
                    }
                    
                    return res.status(200).json({
                        linked: false,
                        fcm_token: null,
                        token_valid: false,
                        token_deleted: true,
                        reason: 'token_invalid',
                        message: 'تم حذف التوكن غير الصالح. يرجى فتح تطبيق السائق لتحديثه.'
                    });
                }
                
                // خطأ آخر (مشكلة في الاتصال)
                console.log(`⚠️ فشل التحقق من التوكن: ${tokenError.message}`);
                isValidToken = false;
                tokenValidated = false;
            }
        } else {
            // ✅ إذا لم يكن Firebase Admin مهيئاً، نعتمد على وجود التوكن فقط
            console.warn('⚠️ Firebase Admin not initialized, skipping token validation');
            isValidToken = true;
            tokenValidated = false;
        }

        console.log(`[check-driver-linked] Driver ${driverId} - Token valid: ${isValidToken}`);

        return res.status(200).json({
            linked: isValidToken,
            fcm_token: isValidToken ? fcmToken : null,
            token_valid: isValidToken,
            token_validated: tokenValidated,
            token_deleted: false,
            is_banned: false
        });

    } catch (error) {
        console.error('❌ Error in check-driver-linked:', error);
        return res.status(500).json({ 
            success: false, 
            error: error.message || 'Internal server error' 
        });
    }
}