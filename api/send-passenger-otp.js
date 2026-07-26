import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const WHATSAPP_RENDER_URL = process.env.WHATSAPP_RENDER_URL;
const WHATSAPP_RENDER_SECRET = process.env.WHATSAPP_RENDER_SECRET;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// Helper to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    const startTime = Date.now();
    const { phone } = req.body;

    if (!phone) {
        return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب' });
    }

    // Ensure environment variables are present
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error('Missing Supabase credentials in environment.');
        return res.status(500).json({ success: false, error: 'تكوينات قاعدة البيانات غير مكتملة في الخادم.' });
    }

    if (!WHATSAPP_RENDER_URL || !WHATSAPP_RENDER_SECRET) {
        console.error('Missing WHATSAPP_RENDER_URL or WHATSAPP_RENDER_SECRET in environment.');
        return res.status(500).json({ success: false, error: 'رابط بوابة واتساب أو المفتاح السري غير مبرمج في الخادم.' });
    }

    // Clean phone number
    let cleanPhone = phone.trim().replace(/\D/g, '');
    if (cleanPhone.startsWith('0') && cleanPhone.length === 10) {
        cleanPhone = '249' + cleanPhone.substring(1);
    } else if (cleanPhone.length === 9 && cleanPhone.startsWith('9')) {
        cleanPhone = '249' + cleanPhone;
    }

    // Get client IP address
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';

    try {
        // --- 1. RATE LIMITING CHECKS ---

        const now = new Date();
        const oneMinuteAgo = new Date(now.getTime() - 60 * 1000).toISOString();
        const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();

        // Check A: Same phone, requested within 1 minute
        const { data: recentOtps, error: errA } = await supabase
            .from('passenger_otps')
            .select('created_at')
            .eq('phone_number', cleanPhone)
            .gt('created_at', oneMinuteAgo)
            .limit(1);

        if (recentOtps && recentOtps.length > 0) {
            return res.status(429).json({
                success: false,
                error: 'تم إرسال رمز تحقق بالفعل. يرجى الانتظار دقيقة قبل طلب رمز جديد.'
            });
        }

        // Check B: Phone limit (Max 5 OTPs per hour)
        const { data: hourlyLogsForPhone, error: errB } = await supabase
            .from('otp_logs')
            .select('id')
            .eq('phone', cleanPhone)
            .eq('status', 'success')
            .gt('sent_at', oneHourAgo);

        if (hourlyLogsForPhone && hourlyLogsForPhone.length >= 5) {
            return res.status(429).json({
                success: false,
                error: 'لقد تجاوزت الحد الأقصى لطلب رموز التحقق (5 رموز في الساعة). يرجى المحاولة لاحقاً.'
            });
        }

        // Check C: IP limit (Max 30 requests per hour)
        const { data: hourlyLogsForIp, error: errC } = await supabase
            .from('otp_logs')
            .select('id')
            .eq('ip_address', ip)
            .gt('sent_at', oneHourAgo);

        if (hourlyLogsForIp && hourlyLogsForIp.length >= 30) {
            return res.status(429).json({
                success: false,
                error: 'لقد تم حظر الطلبات مؤقتاً من عنوانك لمجاوزة الحد المسموح به (30 طلباً في الساعة).'
            });
        }

        // --- 2. GENERATE OTP ---
        // 6 digit code using crypto.randomInt
        const otpCode = crypto.randomInt(100000, 999999).toString();
        const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString(); // 5 minutes expiration

        // Store OTP in database
        const { error: otpInsertError } = await supabase
            .from('passenger_otps')
            .upsert({
                phone_number: cleanPhone,
                otp_code: otpCode,
                created_at: now.toISOString(),
                expires_at: expiresAt,
                is_verified: false
            }, { onConflict: 'phone_number, otp_code' });

        if (otpInsertError) {
            console.error('Error inserting OTP into Supabase:', otpInsertError);
            return res.status(500).json({ success: false, error: 'فشل في توليد رمز التحقق في النظام' });
        }

        // --- 3. DELIVER VIA RENDER GATEWAY WITH OPTIMIZED RETRY STRATEGY ---
        // Delays are optimized to run within 10 seconds Vercel Hobby limits
        const targetUrl = `${WHATSAPP_RENDER_URL.replace(/\/$/, '')}/send-otp`;
        const backoffDelays = [400, 800, 1200, 1600];
        let deliverySuccess = false;
        let lastErrorMsg = '';

        for (let attempt = 0; attempt <= backoffDelays.length; attempt++) {
            try {
                const controller = new AbortController();
                // 3.5s timeout is enough to capture response or wait for Render start
                const timeoutId = setTimeout(() => controller.abort(), 3500);

                const gatewayResponse = await fetch(targetUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'X-Secret-Key': WHATSAPP_RENDER_SECRET
                    },
                    body: JSON.stringify({
                        phone: cleanPhone,
                        otp: otpCode
                    }),
                    signal: controller.signal
                });

                clearTimeout(timeoutId);

                if (gatewayResponse.ok) {
                    deliverySuccess = true;
                    break;
                } else {
                    const resJson = await gatewayResponse.json().catch(() => ({}));
                    lastErrorMsg = resJson.error || `خطأ من الخادم الخارجي ${gatewayResponse.status}`;
                    console.warn(`Gateway response error (attempt ${attempt + 1}):`, lastErrorMsg);
                }
            } catch (fetchErr) {
                lastErrorMsg = fetchErr.message || 'فشل الاتصال بخادم الإرسال';
                console.warn(`Gateway connection failed (attempt ${attempt + 1}):`, lastErrorMsg);
            }

            // Sleep if not the last attempt and total execution is safe
            if (attempt < backoffDelays.length) {
                console.log(`Sleeping for ${backoffDelays[attempt]}ms before next retry...`);
                await delay(backoffDelays[attempt]);
            }
        }

        const latency = Date.now() - startTime;

        // --- 4. RECORD LOGS ---
        const { error: logError } = await supabase
            .from('otp_logs')
            .insert({
                phone: cleanPhone,
                sent_at: now.toISOString(),
                status: deliverySuccess ? 'success' : 'failed',
                latency: latency,
                provider: 'whatsapp_render',
                error: deliverySuccess ? null : lastErrorMsg,
                ip_address: ip
            });

        if (logError) {
            console.error('Error saving OTP log:', logError);
        }

        if (deliverySuccess) {
            return res.status(200).json({
                success: true,
                message: 'تم إرسال رمز التحقق بنجاح إلى حساب الواتساب الخاص بك.'
            });
        } else {
            return res.status(504).json({
                success: false,
                error: `عذراً، فشل إرسال رمز التحقق إلى واتساب الخاص بك بعد محاولات متعددة. السبب: ${lastErrorMsg}. الرجاء التأكد من أن الهاتف مسجل في واتساب والمحاولة مجدداً.`
            });
        }

    } catch (error) {
        console.error('Unexpected error in sendPassengerOtp:', error);
        return res.status(500).json({
            success: false,
            error: 'حدث خطأ غير متوقع أثناء معالجة طلب رمز التحقق.'
        });
    }
}
