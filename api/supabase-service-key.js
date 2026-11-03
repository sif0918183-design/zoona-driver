import { verifyToken } from './_token-utils.js';

/**
 * نقطة نهاية آمنة لتهيئة عميل Supabase على المتصفح
 * تم تطهيرها بالكامل لمنع كشف SUPABASE_SERVICE_ROLE_KEY أو أي مفتاح إداري تحت أي ظرف.
 * تعيد فقط المفتاح العام (ANON KEY) المخصص للمتصفحات وتطبيقات الهواتف.
 */
export default function handler(req, res) {
  // Enable CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    verifyToken(req);
  } catch (error) {
    return res.status(401).json({ success: false, error: error.message });
  }

  // استخدام المفتاح العام فقط ومنع كشف مفتاح الخدمة الإداري إطلاقاً
  const clientKey = process.env.SUPABASE_ANON_KEY || '';

  const response = {
    serviceRoleKey: clientKey,
    data: {
      serviceRoleKey: clientKey
    }
  };

  res.status(200).json(response);
}
