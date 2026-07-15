import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function verifyToken(req) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        throw new Error('المصادقة مطلوبة: رمز الجلسة مفقود أو غير صالح');
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf-8'));
        if (decoded.exp && decoded.exp < Date.now()) {
            throw new Error('انتهت صلاحية رمز الجلسة الخاصة بك، يرجى تسجيل الدخول مرة أخرى');
        }
        return decoded;
    } catch (e) {
        throw new Error('رمز الجلسة غير صالح');
    }
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

    try {
        // التحقق من التوكن في كل الطلبات الواردة إلى Complaints API
        let session;
        try {
            session = verifyToken(req);
        } catch (tokenErr) {
            return res.status(401).json({ success: false, error: tokenErr.message });
        }

        const { userId, userType, userName, accountType, whatsapp, phone, complaintType, message, rating } = req.body;

        if (!userId || !userType || !userName || !phone || !message) {
            return res.status(400).json({ success: false, error: 'الرجاء ملء كافة الحقول المطلوبة' });
        }

        // Simple validation of fields
        if (userType !== 'driver' && userType !== 'passenger') {
            return res.status(400).json({ success: false, error: 'نوع المستخدم غير صالح' });
        }

        // Sanitization
        const sanitizedUserName = userName.trim().substring(0, 100);
        const sanitizedPhone = phone.trim().substring(0, 30);
        const sanitizedWhatsapp = whatsapp ? whatsapp.trim().substring(0, 30) : null;
        const sanitizedMessage = message.trim().substring(0, 2000);
        const sanitizedComplaintType = complaintType ? complaintType.trim().substring(0, 100) : 'general';
        const sanitizedAccountType = accountType ? accountType.trim().substring(0, 50) : null;
        const validRating = rating ? Math.max(0, Math.min(5, parseInt(rating))) : 0;

        // Secure insert
        const { data, error } = await supabase
            .from('complaints')
            .insert([{
                user_id: userId,
                user_type: userType,
                user_name: sanitizedUserName,
                account_type: sanitizedAccountType,
                whatsapp: sanitizedWhatsapp,
                phone: sanitizedPhone,
                complaint_type: sanitizedComplaintType,
                message: sanitizedMessage,
                rating: validRating,
                status: 'new',
                created_at: new Date().toISOString()
            }])
            .select()
            .single();

        if (error) throw error;

        return res.status(200).json({ success: true, complaint: data });

    } catch (error) {
        console.error('Error in complaints secure handler:', error);
        return res.status(500).json({ success: false, error: 'حدث خطأ أثناء إرسال الشكوى: ' + error.message });
    }
}
