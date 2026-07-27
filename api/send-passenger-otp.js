import crypto from 'crypto';
import https from 'https';
import http from 'http';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const WHATSAPP_RENDER_URL = process.env.WHATSAPP_RENDER_URL;
const WHATSAPP_RENDER_SECRET = process.env.WHATSAPP_RENDER_SECRET;

// Helper to delay execution
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Native HTTPS request helper for Supabase REST (Postgrest API) to bypass @supabase/supabase-js package size
function supabaseRestRequest(path, method, body = null, additionalHeaders = {}) {
    return new Promise((resolve, reject) => {
        try {
            const baseUrl = SUPABASE_URL.replace(/\/$/, '');
            const url = `${baseUrl}/rest/v1/${path}`;
            const parsedUrl = new URL(url);
            const postData = body ? JSON.stringify(body) : null;

            const headers = {
                'apikey': SUPABASE_SERVICE_ROLE_KEY,
                'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
                'Content-Type': 'application/json',
                ...additionalHeaders
            };

            if (postData) {
                headers['Content-Length'] = Buffer.byteLength(postData);
            }

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || 443,
                path: parsedUrl.pathname + parsedUrl.search,
                method: method,
                headers: headers,
                timeout: 5000
            };

            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : []);
                        } catch (e) {
                            resolve(data);
                        }
                    } else {
                        reject(new Error(`Supabase REST Error: HTTP ${res.statusCode} - ${data}`));
                    }
                });
            });

            req.on('error', (err) => {
                reject(err);
            });

            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Supabase request timed out'));
            });

            if (postData) {
                req.write(postData);
            }
            req.end();
        } catch (err) {
            reject(err);
        }
    });
}

// Native HTTP/HTTPS client to send messages to the WhatsApp Gateway
function sendOtpViaGateway(url, secret, phone, otp) {
    return new Promise((resolve) => {
        try {
            const parsedUrl = new URL(url);
            const postData = JSON.stringify({ phone, otp });

            const options = {
                hostname: parsedUrl.hostname,
                port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
                path: parsedUrl.pathname + parsedUrl.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Secret-Key': secret,
                    'Content-Length': Buffer.byteLength(postData)
                },
                timeout: 3500 // 3.5 seconds individual timeout
            };

            const client = parsedUrl.protocol === 'https:' ? https : http;

            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ ok: true, data });
                    } else {
                        let errMsg = '';
                        try {
                            const parsed = JSON.parse(data);
                            errMsg = parsed.error;
                        } catch (e) {}
                        resolve({ ok: false, error: errMsg || `HTTP ${res.statusCode}` });
                    }
                });
            });

            req.on('error', (err) => {
                resolve({ ok: false, error: err.message || 'Connection error' });
            });

            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, error: 'Connection timed out' });
            });

            req.write(postData);
            req.end();
        } catch (err) {
            resolve({ ok: false, error: err.message || 'URL parsing failed' });
        }
    });
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
    } else if (cleanPhone.length === 9 && (cleanPhone.startsWith('9') || cleanPhone.startsWith('1'))) {
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
        // GET /rest/v1/passenger_otps?phone_number=eq.cleanPhone&created_at=gt.oneMinuteAgo&select=created_at
        const recentOtps = await supabaseRestRequest(
            `passenger_otps?phone_number=eq.${cleanPhone}&created_at=gt.${oneMinuteAgo}&select=created_at`,
            'GET'
        );

        if (recentOtps && recentOtps.length > 0) {
            return res.status(429).json({
                success: false,
                error: 'تم إرسال رمز تحقق بالفعل. يرجى الانتظار دقيقة قبل طلب رمز جديد.'
            });
        }

        // Check B: Phone limit (Max 5 OTPs per hour)
        // GET /rest/v1/otp_logs?phone=eq.cleanPhone&status=eq.success&sent_at=gt.oneHourAgo&select=id
        const hourlyLogsForPhone = await supabaseRestRequest(
            `otp_logs?phone=eq.${cleanPhone}&status=eq.success&sent_at=gt.${oneHourAgo}&select=id`,
            'GET'
        );

        if (hourlyLogsForPhone && hourlyLogsForPhone.length >= 5) {
            return res.status(429).json({
                success: false,
                error: 'لقد تجاوزت الحد الأقصى لطلب رموز التحقق (5 رموز في الساعة). يرجى المحاولة لاحقاً.'
            });
        }

        // Check C: IP limit (Max 30 requests per hour)
        // GET /rest/v1/otp_logs?ip_address=eq.ip&sent_at=gt.oneHourAgo&select=id
        const hourlyLogsForIp = await supabaseRestRequest(
            `otp_logs?ip_address=eq.${ip}&sent_at=gt.${oneHourAgo}&select=id`,
            'GET'
        );

        if (hourlyLogsForIp && hourlyLogsForIp.length >= 30) {
            return res.status(429).json({
                success: false,
                error: 'لقد تم حظر الطلبات مؤقتاً من عنوانك لمجاوزة الحد المسموح به (30 طلباً في الساعة).'
            });
        }

        // --- 2. GENERATE OTP ---
        const otpCode = crypto.randomInt(100000, 999999).toString();
        const expiresAt = new Date(now.getTime() + 5 * 60 * 1000).toISOString(); // 5 minutes expiration

        // Store OTP in database using native upsert POST
        // In Postgrest, to upsert on unique constraint, we use Prefer: resolution=merge-duplicates
        await supabaseRestRequest(
            'passenger_otps',
            'POST',
            {
                phone_number: cleanPhone,
                otp_code: otpCode,
                created_at: now.toISOString(),
                expires_at: expiresAt,
                is_verified: false
            },
            {
                'Prefer': 'resolution=merge-duplicates, return=representation'
            }
        );

        // --- 3. DELIVER VIA RENDER GATEWAY WITH ASYNC FIRE-AND-FORGET STRATEGY ---
        // We trigger the gateway delivery asynchronously in the background so that Vercel returns
        // a 200 OK success response to the client immediately (within 50ms), preventing any 504 Timeout errors!
        const targetUrl = `${WHATSAPP_RENDER_URL.replace(/\/$/, '')}/send-otp`;
        const backoffDelays = [400, 800, 1200, 1600];

        // Background delivery handler
        const runBackgroundDelivery = async () => {
            let deliverySuccess = false;
            let lastErrorMsg = '';

            for (let attempt = 0; attempt <= backoffDelays.length; attempt++) {
                const sendResult = await sendOtpViaGateway(targetUrl, WHATSAPP_RENDER_SECRET, cleanPhone, otpCode);

                if (sendResult.ok) {
                    deliverySuccess = true;
                    break;
                } else {
                    lastErrorMsg = sendResult.error;
                    console.warn(`Gateway response error (attempt ${attempt + 1}):`, lastErrorMsg);
                }

                if (attempt < backoffDelays.length) {
                    await delay(backoffDelays[attempt]);
                }
            }

            const latency = Date.now() - startTime;

            // Background Logger
            try {
                await supabaseRestRequest(
                    'otp_logs',
                    'POST',
                    {
                        phone: cleanPhone,
                        sent_at: now.toISOString(),
                        status: deliverySuccess ? 'success' : 'failed',
                        latency: latency,
                        provider: 'whatsapp_render',
                        error: deliverySuccess ? null : lastErrorMsg,
                        ip_address: ip
                    }
                );
                console.log(`Background delivery complete. Success: ${deliverySuccess}`);
            } catch (logErr) {
                console.error('Failed to log background delivery outcome:', logErr);
            }
        };

        // Fire and forget!
        runBackgroundDelivery().catch(err => console.error('Unhandled background delivery error:', err));

        // Return immediate success to the client
        return res.status(200).json({
            success: true,
            message: 'تم إرسال رمز التحقق بنجاح إلى حساب الواتساب الخاص بك.'
        });

    } catch (error) {
        console.error('Unexpected error in sendPassengerOtp:', error);
        return res.status(500).json({
            success: false,
            error: 'حدث خطأ غير متوقع أثناء معالجة طلب رمز التحقق.'
        });
    }
}
