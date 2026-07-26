import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

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
    } else if (cleanPhone.length === 9 && cleanPhone.startsWith('9')) {
        cleanPhone = '249' + cleanPhone;
    }

    const cleanOtp = otp.trim();

    try {
        // Find the active OTP row
        // Conditions: phone_number matched, code matched, is_verified = false
        const { data: otpRecord, error: otpError } = await supabase
            .from('passenger_otps')
            .select('*')
            .eq('phone_number', cleanPhone)
            .eq('otp_code', cleanOtp)
            .eq('is_verified', false)
            .maybeSingle();

        if (otpError) {
            console.error('Database query error finding OTP:', otpError);
            return res.status(500).json({ success: false, error: 'حدث خطأ في النظام أثناء التحقق من الرمز' });
        }

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
        const { error: updateOtpErr } = await supabase
            .from('passenger_otps')
            .update({
                is_verified: true,
                verified_at: nowIso
            })
            .eq('id', otpRecord.id);

        if (updateOtpErr) {
            console.error('Error updating OTP record:', updateOtpErr);
            throw new Error('فشل تحديث حالة الرمز');
        }

        // 2. Activate the customer account in 'customers' table
        const { error: updateCustomerErr } = await supabase
            .from('customers')
            .update({
                is_verified: true
            })
            .eq('phone', cleanPhone);

        if (updateCustomerErr) {
            console.error('Error updating customer verified status:', updateCustomerErr);
            throw new Error('فشل تفعيل حساب الراكب في النظام');
        }

        // 3. Delete older OTP codes for this phone number to keep DB tidy
        const { error: deleteOldErr } = await supabase
            .from('passenger_otps')
            .delete()
            .eq('phone_number', cleanPhone)
            .neq('id', otpRecord.id);

        if (deleteOldErr) {
            console.warn('Minor error deleting old OTP records:', deleteOldErr);
        }

        return res.status(200).json({
            success: true,
            message: 'تم تفعيل وتوثيق حسابك بنجاح! يمكنك الآن تسجيل الدخول واستخدام التطبيق.'
        });

    } catch (error) {
        console.error('Unexpected error in verifyPassengerOtp:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'حدث خطأ غير متوقع أثناء عملية التحقق.'
        });
    }
}
