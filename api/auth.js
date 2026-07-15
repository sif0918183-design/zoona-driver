import { createClient } from '@supabase/supabase-js';
import bcrypt from 'bcryptjs';

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

    try {
        const { action, role, phone, password, fullName, phone2 } = req.body;

        if (!action) {
            return res.status(400).json({ success: false, error: 'Action is required' });
        }

        // --- REGISTER PASSENGER ---
        if (action === 'register') {
            if (role !== 'passenger') {
                return res.status(400).json({ success: false, error: 'Only passengers can register directly' });
            }
            if (!fullName || !phone || !password) {
                return res.status(400).json({ success: false, error: 'All fields are required' });
            }

            // Sanitize input
            const sanitizedPhone = phone.trim();
            const sanitizedFullName = fullName.trim();
            const sanitizedPhone2 = phone2 ? phone2.trim() : null;

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
                message: 'تم إنشاء الحساب بنجاح! يرجى التفعيل عبر واتساب',
                user: safeUser
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
                    return res.status(403).json({
                        success: false,
                        verified: false,
                        error: 'حسابك غير مفعل. يرجى تفعيل الحساب عبر واتساب الإدارة',
                        phone: customer.phone
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
