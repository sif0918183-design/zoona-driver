import https from 'https';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

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

    const { phone, otp } = req.body;

    if (!phone || !otp) {
        return res.status(400).json({ success: false, error: 'رقم الهاتف ورمز التحقق مطلوبان' });
    }

    // Clean input data
    let cleanPhone = phone.trim().replace(/\D/g, '');
    if (cleanPhone.startsWith('0') && cleanPhone.length === 10) {
        cleanPhone = '249' + cleanPhone.substring(1);
    } else if (cleanPhone.length === 9 && (cleanPhone.startsWith('9') || cleanPhone.startsWith('1'))) {
        cleanPhone = '249' + cleanPhone;
    }

    const cleanOtp = otp.trim();

    try {
        // Find the active OTP row
        // Conditions: phone_number matched, code matched, is_verified = false
        // GET /rest/v1/passenger_otps?phone_number=eq.cleanPhone&otp_code=eq.cleanOtp&is_verified=eq.false
        const otpRecords = await supabaseRestRequest(
            `passenger_otps?phone_number=eq.${cleanPhone}&otp_code=eq.${cleanOtp}&is_verified=eq.false`,
            'GET'
        );

        const otpRecord = (otpRecords && otpRecords.length > 0) ? otpRecords[0] : null;

        if (!otpRecord) {
            return res.status(400).json({
                success: false,
                error: 'رمز التحقق غير صحيح، أو تم استخدامه مسبقاً.'
            });
        }

        // Check if expired
        const now = new Date();
        const expiresAt = new Date(otpRecord.expires_at);

        if (now > expiresAt) {
            return res.status(400).json({
                success: false,
                error: 'لقد انتهت صلاحية هذا الرمز (صلاحية الرمز 5 دقائق فقط). يرجى طلب رمز جديد.'
            });
        }

        // --- VALID OTP! Let's activate and clean ---

        const nowIso = now.toISOString();

        // 1. Mark this OTP as verified to prevent double-use
        // PATCH /rest/v1/passenger_otps?id=eq.otpRecord.id
        await supabaseRestRequest(
            `passenger_otps?id=eq.${otpRecord.id}`,
            'PATCH',
            {
                is_verified: true,
                verified_at: nowIso
            }
        );

        // 2. Activate the customer account in 'customers' table
        // PATCH /rest/v1/customers?phone=eq.cleanPhone
        await supabaseRestRequest(
            `customers?phone=eq.${cleanPhone}`,
            'PATCH',
            {
                is_verified: true
            }
        );

        // 3. Delete older OTP codes for this phone number to keep DB tidy
        // DELETE /rest/v1/passenger_otps?phone_number=eq.cleanPhone&id=neq.otpRecord.id
        try {
            await supabaseRestRequest(
                `passenger_otps?phone_number=eq.${cleanPhone}&id=neq.${otpRecord.id}`,
                'DELETE'
            );
        } catch (deleteOldErr) {
            console.warn('Minor error deleting old OTP records:', deleteOldErr);
        }

        return res.status(200).json({
            success: true,
            message: 'تم تفعيل وتوثيق حسابك بنجاح! يمكنك الآن تسجيل الدخول واستخدم التطبيق.'
        });

    } catch (error) {
        console.error('Unexpected error in verifyPassengerOtp:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ غير متوقع أثناء عملية التحقق.'
        });
    }
}
