import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    // Enable CORS with relaxed headers for tracka.zoonasd.com, webviews, and general PWA clients
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    const origin = req.headers.origin;
    if (origin && (origin === 'https://tracka.zoonasd.com' || origin.startsWith('http://localhost') || origin.startsWith('tracka://') || origin.startsWith('zoona://'))) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    } else {
        res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
    );

    // التعامل مع طلبات Preflight (OPTIONS) بإرجاع 200 OK فوراً
    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // تسجيل تفاصيل الطلب لسهولة تصحيح الأخطاء وحل مشاكل الـ CORS والـ 403
    console.log(`[Auth API] Incoming Request - Method: ${req.method}, Origin: ${origin || 'None'}, Referer: ${req.headers.referer || 'None'}`);

    if (req.method !== 'POST') {
        console.warn(`[Auth API] Rejected: Method ${req.method} is not allowed.`);
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    // استخراج الـ Bearer Token من ترويسة الطلب Authorization
    let bearerToken = null;
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
        bearerToken = authHeader.split(' ')[1];
    }

    // محاولة فك تشفير توكن Supabase JWT لاستخراج المعطيات للتحقق الآمن للراكب الجديد
    let decodedSupabaseUser = null;
    if (bearerToken) {
        try {
            const parts = bearerToken.split('.');
            if (parts.length === 3) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf-8'));
                decodedSupabaseUser = {
                    id: payload.sub,
                    email: payload.email
                };
                console.log('Decoded Supabase User from Bearer Token:', decodedSupabaseUser);
            }
        } catch (err) {
            console.error('Error decoding Bearer Token:', err);
        }
    }

    try {
        // فحص مفاتيح Supabase المتغيرة في Vercel Environment Variables للتأكد من جاهزية الخدمة
        if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
            console.error('Supabase Configuration Missing in Vercel Environment Variables');
            return res.status(500).json({ success: false, error: 'تكوين الخادم (Supabase Configuration) غير مكتمل' });
        }

        const { action, role, phone, password, fullName, phone2, turnstileToken, customerId, googleId, googleEmail, google_id, google_email } = req.body;

        if (!action) {
            console.warn('[Auth API] Rejected request: missing action parameter', req.body);
            return res.status(400).json({ success: false, error: 'Action is required' });
        }

        // --- REGISTER PASSENGER ---
        if (action === 'register') {
            if (role !== 'passenger') {
                return res.status(400).json({ success: false, error: 'Only passengers can register directly' });
            }
            if (!fullName || !phone || !password || !phone2) {
                return res.status(400).json({ success: false, error: 'الرجاء إكمال جميع الحقول الإلزامية' });
            }

            // Sanitize input
            const sanitizedPhone = phone.trim();
            const sanitizedFullName = fullName.trim();
            const sanitizedPhone2 = phone2.trim();

            // Validate Full Name is exactly 4 Arabic names
            const cleanName = sanitizedFullName.replace(/\s+/g, ' ');
            const parts = cleanName.split(' ');
            const arabicRegex = /^[\u0600-\u06FF]+$/;
            if (parts.length !== 4 || !parts.every(part => arabicRegex.test(part))) {
                return res.status(400).json({ success: false, error: 'الاسم الرباعي الكامل باللغة العربية مطلوب ومحدد بأربعة أسماء فقط' });
            }

            // Verify Turnstile Token
            if (!turnstileToken) {
                return res.status(400).json({ success: false, error: 'الرجاء إكمال التحقق البشري (Turnstile) أولاً' });
            }
            const turnstileSecret = process.env.TURNSTILE_SECRET_KEY || '1x0000000000000000000000000000000AA';
            try {
                const tsRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `secret=${encodeURIComponent(turnstileSecret)}&response=${encodeURIComponent(turnstileToken)}`
                });
                const tsData = await tsRes.json();
                if (!tsData.success) {
                    return res.status(400).json({ success: false, error: 'فشل التحقق البشري (Turnstile)، يرجى المحاولة مرة أخرى' });
                }
            } catch (e) {
                console.error('Turnstile verification error:', e);
                return res.status(500).json({ success: false, error: 'حدث خطأ أثناء التحقق البشري' });
            }

            // Check if phone already exists
            const { data: existingUser, error: checkError } = await supabase
                .from('customers')
                .select('id')
                .eq('phone', sanitizedPhone)
                .maybeSingle();

            if (existingUser) {
                return res.status(400).json({ success: false, error: 'هذا الرقم مسجل مسبقاً، يمكنك تسجيل الدخول' });
            }

            // Hash password
            const passwordHash = bcrypt.hashSync(password, 10);

            // Insert new customer
            const { data: newCustomer, error: insertError } = await supabase
                .from('customers')
                .insert([{
                    full_name: sanitizedFullName,
                    phone: sanitizedPhone,
                    phone2: sanitizedPhone2,
                    password: passwordHash,
                    is_verified: false,
                    created_at: new Date().toISOString()
                }])
                .select()
                .single();

            if (insertError) {
                throw insertError;
            }

            // Safe payload (do not return password)
            const safeUser = { ...newCustomer };
            delete safeUser.password;

            return res.status(200).json({
                success: true,
                message: 'تم تسجيل البيانات بنجاح! يرجى الربط مع Google لتفعيل الحساب',
                user: safeUser
            });
        }

        // --- VERIFY PHONE ---
        if (action === 'verify_phone') {
            const { phone } = req.body;
            if (!phone) {
                console.warn('[Auth API] Rejected verify_phone action: Missing phone parameter');
                return res.status(400).json({ success: false, error: 'رقم الهاتف مطلوب لإكمال التفعيل' });
            }

            // Clean and sanitize the phone number
            let cleanedPhone = phone.toString().replace(/\D/g, '');
            if (cleanedPhone.startsWith('249') && cleanedPhone.length === 12) {
                cleanedPhone = '0' + cleanedPhone.substring(3);
            } else if (cleanedPhone.length === 9 && (cleanedPhone.startsWith('9') || cleanedPhone.startsWith('1'))) {
                cleanedPhone = '0' + cleanedPhone;
            }

            const sanitizedPhone = cleanedPhone.trim();

            // Search in customers table by phone number
            const { data: customer, error: fetchError } = await supabase
                .from('customers')
                .select('*')
                .eq('phone', sanitizedPhone)
                .maybeSingle();

            if (fetchError || !customer) {
                return res.status(404).json({ success: false, error: 'رقم الهاتف غير مسجل، يرجى إنشاء حساب أولاً' });
            }

            // Update immediately to verified
            const { data: updatedCustomer, error: updateError } = await supabase
                .from('customers')
                .update({
                    is_verified: true,
                    updated_at: new Date().toISOString()
                })
                .eq('phone', sanitizedPhone)
                .select()
                .single();

            if (updateError) {
                console.error('[Auth API] Database Error during verify_phone:', updateError);
                return res.status(400).json({ success: false, error: 'فشل تفعيل وتحديث الحساب: ' + updateError.message });
            }

            // Generate secure session token and return status 200 with customer data
            const sessionToken = Buffer.from(JSON.stringify({
                id: updatedCustomer.id,
                role: 'passenger',
                exp: Date.now() + 7 * 24 * 60 * 60 * 1000
            })).toString('base64');

            // Safe payload
            const safeUser = {
                ...updatedCustomer,
                id: updatedCustomer.id,
                name: updatedCustomer.full_name,
                phone: updatedCustomer.phone,
                type: 'passenger',
                is_verified: true
            };
            delete safeUser.password;

            res.setHeader('Set-Cookie', 'pending_verify_phone=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; SameSite=Lax; Secure');

            return res.status(200).json({
                success: true,
                message: 'تم تفعيل حسابك بنجاح عن طريق رقم الهاتف!',
                user: safeUser,
                token: sessionToken
            });
        }

        // --- LOGIN PASSENGER / DRIVER ---
        if (action === 'login') {
            if (!phone || !password) {
                return res.status(400).json({ success: false, error: 'الرجاء إدخال رقم الهاتف وكلمة المرور' });
            }

            const sanitizedPhone = phone.trim();

            if (role === 'passenger') {
                // Fetch customer
                const { data: customer, error: fetchError } = await supabase
                    .from('customers')
                    .select('*')
                    .eq('phone', sanitizedPhone)
                    .maybeSingle();

                if (fetchError || !customer) {
                    return res.status(400).json({ success: false, error: 'رقم الموبايل غير مسجل' });
                }

                // Verify password
                const isMatch = customer.password.startsWith('$2a$') || customer.password.startsWith('$2b$')
                    ? bcrypt.compareSync(password, customer.password)
                    : password === customer.password;

                if (!isMatch) {
                    return res.status(400).json({ success: false, error: 'كلمة المرور غير صحيحة' });
                }

                // Migrate password to bcrypt if stored as plain text
                if (!customer.password.startsWith('$2a$') && !customer.password.startsWith('$2b$')) {
                    const hashed = bcrypt.hashSync(password, 10);
                    await supabase
                        .from('customers')
                        .update({ password: hashed })
                        .eq('id', customer.id);
                }

                // Check verification
                if (!customer.is_verified) {
                    console.log(`[Auth API] Login blocked: Passenger phone ${sanitizedPhone} is not verified.`);
                    return res.status(403).json({
                        success: false,
                        verified: false,
                        error: 'حسابك غير مفعل. يرجى إكمال التحقق من رقم الهاتف لتفعيل الحساب.',
                        customerId: customer.id
                    });
                }

                // Generate secure session token
                const sessionToken = Buffer.from(JSON.stringify({
                    id: customer.id,
                    role: 'passenger',
                    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
                })).toString('base64');

                // Safe payload compatible with database columns and user requests
                const safeUser = {
                    ...customer,
                    id: customer.id,
                    name: customer.full_name,
                    phone: customer.phone,
                    type: 'passenger',
                    is_verified: customer.is_verified
                };
                delete safeUser.password;

                return res.status(200).json({
                    success: true,
                    user: safeUser,
                    token: sessionToken
                });

            } else if (role === 'driver') {
                // Fetch driver
                const { data: driver, error: fetchError } = await supabase
                    .from('drivers')
                    .select('*')
                    .eq('whatsapp_number', sanitizedPhone)
                    .maybeSingle();

                if (fetchError || !driver) {
                    return res.status(400).json({ success: false, error: 'رقم الواتساب غير مسجل' });
                }

                if (!driver.is_active) {
                    return res.status(403).json({ success: false, error: 'الحساب غير مفعل من قبل الإدارة' });
                }

                // Verify password
                const isMatch = driver.password.startsWith('$2a$') || driver.password.startsWith('$2b$')
                    ? bcrypt.compareSync(password, driver.password)
                    : password === driver.password;

                if (!isMatch) {
                    return res.status(400).json({ success: false, error: 'كلمة المرور غير صحيحة' });
                }

                // Migrate password to bcrypt if stored as plain text
                if (!driver.password.startsWith('$2a$') && !driver.password.startsWith('$2b$')) {
                    const hashed = bcrypt.hashSync(password, 10);
                    await supabase
                        .from('drivers')
                        .update({ password: hashed })
                        .eq('id', driver.id);
                }

                // Check ban
                if (driver.is_banned && driver.ban_until) {
                    const banEndTime = new Date(driver.ban_until);
                    const now = new Date();

                    if (banEndTime > now) {
                        return res.status(403).json({
                            success: false,
                            error: `🚫 حسابك محظور حتى ${banEndTime.toLocaleDateString('ar-SA')}`
                        });
                    } else {
                        // Ban period expired, lift ban
                        await supabase
                            .from('drivers')
                            .update({
                                is_banned: false,
                                ban_reason: null,
                                ban_until: null
                            })
                            .eq('id', driver.id);
                        driver.is_banned = false;
                    }
                }

                // Generate secure session token
                const sessionToken = Buffer.from(JSON.stringify({
                    id: driver.id,
                    role: 'driver',
                    exp: Date.now() + 7 * 24 * 60 * 60 * 1000
                })).toString('base64');

                // Safe payload compatible with database columns and user requests
                const safeUser = {
                    ...driver,
                    id: driver.id,
                    name: driver.full_name,
                    phone: driver.whatsapp_number,
                    type: 'driver',
                    is_verified: driver.is_active,
                    is_active: driver.is_active
                };
                delete safeUser.password;

                return res.status(200).json({
                    success: true,
                    user: safeUser,
                    token: sessionToken
                });
            } else {
                return res.status(400).json({ success: false, error: 'Invalid role specified' });
            }
        }

        return res.status(400).json({ success: false, error: 'Unknown action' });

    } catch (error) {
        console.error('Error in secure auth handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ في عملية التحقق من الهوية' });
    }
}
