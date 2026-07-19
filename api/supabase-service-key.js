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

  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';

  const response = {
    serviceRoleKey,
    data: {
      serviceRoleKey
    }
  };

  res.status(200).json(response);
}
