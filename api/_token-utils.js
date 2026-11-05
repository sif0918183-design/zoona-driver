import crypto from 'crypto';

/**
 * وحدة إدارة ومصادقة التوكنات المركزية في تراكا (Tracka Token Security)
 * تعتمد على التوقيع التشفيري HMAC-SHA256 باستخدام مفتاح بيئة الخادم SESSION_TOKEN_SECRET
 */

const ALLOWED_ROLES = ['passenger', 'driver', 'admin'];

/**
 * استرجاع المفتاح السري المخصص من البيئة.
 * وفق الشرط الأمني الصارم: لا يتم استخدام قيمة افتراضية أو مفتاح ثابت في الكود إطلاقاً.
 */
function getSecretKey() {
    const secret = process.env.SESSION_TOKEN_SECRET;
    if (!secret || typeof secret !== 'string' || secret.trim() === '') {
        throw new Error('متغير البيئة SESSION_TOKEN_SECRET غير مهيأ على الخادم. يرجى إضافته في إعدادات البيئة لتمكين المصادقة المشفرة.');
    }
    return secret;
}

/**
 * إصدار توكن موقع تشفيرياً باستخدام HMAC-SHA256
 * @param {Object} payload يحتوي على id و role والخصائص الإضافية
 * @param {number} expiresInMs مدة الصلاحية بالمللي ثانية (افتراضياً 7 أيام)
 * @returns {string} التوكن الموقع بصيغة <payload_base64url>.<signature_base64url>
 */
export function generateToken(payload, expiresInMs = 7 * 24 * 60 * 60 * 1000) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('بيانات الجلسة (payload) غير صالحة');
    }

    if (!payload.id || typeof payload.id !== 'string' || payload.id.trim() === '') {
        throw new Error('معرف المستخدم (id) مطلوب ويجب أن يكون نصاً صالحاً');
    }

    if (!payload.role || !ALLOWED_ROLES.includes(payload.role)) {
        throw new Error(`دور المستخدم (role) غير صالح: ${payload.role}`);
    }

    const secret = getSecretKey();
    const exp = Date.now() + expiresInMs;

    const sessionData = {
        id: payload.id.trim(),
        role: payload.role,
        exp
    };

    const payloadStr = JSON.stringify(sessionData);
    const payloadB64 = Buffer.from(payloadStr, 'utf-8').toString('base64url');

    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payloadB64);
    const signatureB64 = hmac.digest('base64url');

    return `${payloadB64}.${signatureB64}`;
}

/**
 * التحقق الأمني التام من التوكن واستخراج بيانات الجلسة الموثقة
 * @param {string|Object} reqOrToken كائن الطلب req أو نص التوكن مباشرة
 * @returns {Object} كائن الجلسة { id, role, exp }
 */
export function verifyToken(reqOrToken) {
    let token = null;

    if (typeof reqOrToken === 'string') {
        token = reqOrToken;
    } else if (reqOrToken && reqOrToken.headers) {
        const authHeader = reqOrToken.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            throw new Error('المصادقة مطلوبة: رمز الجلسة مفقود أو غير صالح');
        }
        token = authHeader.split(' ')[1];
    }

    if (!token || typeof token !== 'string') {
        throw new Error('المصادقة مطلوبة: رمز الجلسة مفقود أو غير صالح');
    }

    const parts = token.split('.');
    if (parts.length !== 2) {
        // رفض التوكنات القديمة غير الموقعة (Base64 العادي) أو غير المكتملة
        throw new Error('رمز الجلسة غير صالح أو غير موقع تشفيرياً، يرجى تسجيل الدخول مجدداً');
    }

    const [payloadB64, signatureB64] = parts;
    if (!payloadB64 || !signatureB64) {
        throw new Error('رمز الجلسة غير مكتمل أو غير صالح');
    }

    const secret = getSecretKey();

    // التحقق من صحة التوقيع التشفيري باستخدام timingSafeEqual
    const hmac = crypto.createHmac('sha256', secret);
    hmac.update(payloadB64);
    const expectedSigB64 = hmac.digest('base64url');

    const sigBuf = Buffer.from(signatureB64, 'utf-8');
    const expectedBuf = Buffer.from(expectedSigB64, 'utf-8');

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
        throw new Error('رمز الجلسة تم التلاعب به أو غير صالح');
    }

    // فك وتدقيق الـ Payload
    let decoded;
    try {
        decoded = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
    } catch (e) {
        throw new Error('محتوى رمز الجلسة تالف أو غير صالح');
    }

    if (!decoded || typeof decoded !== 'object') {
        throw new Error('بيانات الجلسة غير صالحة');
    }

    const { id, role, exp } = decoded;

    if (!id || typeof id !== 'string' || id.trim() === '') {
        throw new Error('معرف المستخدم مفقود أو غير صالح في الجلسة');
    }

    if (!role || !ALLOWED_ROLES.includes(role)) {
        throw new Error('دور المستخدم غير صالح في الجلسة');
    }

    if (!exp || typeof exp !== 'number') {
        throw new Error('بيانات انتهاء صلاحية الجلسة مفقودة أو غير صالحة');
    }

    if (exp < Date.now()) {
        throw new Error('انتهت صلاحية رمز الجلسة الخاصة بك، يرجى تسجيل الدخول مرة أخرى');
    }

    return {
        id: id.trim(),
        role,
        exp
    };
}
