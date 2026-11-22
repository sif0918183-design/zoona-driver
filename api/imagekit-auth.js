import ImageKit from 'imagekit';
import { verifyToken } from './_token-utils.js';

export default async function handler(req, res) {
    // Enable CORS with relaxed headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    if (req.method === 'POST') {
        try {
            const { turnstileToken } = req.body || {};
            if (!turnstileToken) {
                return res.status(400).json({ success: false, error: 'يرجى إكمال التحقق المخصص لرفع المستندات أولاً' });
            }

            const turnstileSecret = process.env.TURNSTILE_SECRET_KEY;
            if (!turnstileSecret) {
                console.error('[ImageKit Auth] TURNSTILE_SECRET_KEY is missing');
                return res.status(503).json({ success: false, error: 'خدمة التحقق غير مهيأة على الخادم' });
            }

            const verifyResponse = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ secret: turnstileSecret, response: turnstileToken })
            });
            const verification = await verifyResponse.json();
            const allowedHosts = new Set(['tracka.zoonasd.com']);
            for (const value of [process.env.VERCEL_PROJECT_PRODUCTION_URL, process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]) {
                if (value) allowedHosts.add(String(value).replace(/^https?:\/\//i, '').split('/')[0].toLowerCase());
            }
            const verifiedHost = String(verification.hostname || '').toLowerCase();
            if (!verification.success || verification.action !== 'driver_upload' || !verifiedHost || !allowedHosts.has(verifiedHost)) {
                console.warn('[ImageKit Auth] Driver upload Turnstile rejected', {
                    success: verification.success,
                    action: verification.action,
                    hostname: verifiedHost,
                    errors: verification['error-codes']
                });
                return res.status(403).json({ success: false, error: 'فشل التحقق الأمني لرفع المستندات. أعد التحقق وحاول مجدداً.' });
            }

            const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
            if (!privateKey || !privateKey.trim()) {
                return res.status(503).json({ success: false, error: 'ImageKit private key is not configured on the server' });
            }
            const imagekit = new ImageKit({
                publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "public_SnxtM9/xheLA8u65v643QBMQcMo=",
                privateKey,
                urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "https://ik.imagekit.io/vurkt9qyk"
            });
            const authParams = Array.from({ length: 4 }, () => imagekit.getAuthenticationParameters());
            return res.status(200).json({ authParams });
        } catch (error) {
            console.error('ImageKit driver upload auth error:', error);
            return res.status(500).json({ success: false, error: 'تعذر تجهيز رفع المستندات. يرجى المحاولة مرة أخرى.' });
        }
    }

    if (req.method !== 'GET') {
        return res.status(405).json({ success: false, error: 'Method not allowed' });
    }

    try {
        let session;
        try {
            session = verifyToken(req);
        } catch (tokenError) {
            return res.status(401).json({ success: false, error: tokenError.message });
        }
        if (!['driver', 'admin'].includes(session.role)) {
            return res.status(403).json({ success: false, error: 'غير مصرح لك برفع الملفات' });
        }

        const privateKey = process.env.IMAGEKIT_PRIVATE_KEY;
        if (!privateKey || !privateKey.trim()) {
            return res.status(503).json({ success: false, error: 'ImageKit private key is not configured on the server' });
        }

        const imagekit = new ImageKit({
            publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "public_SnxtM9/xheLA8u65v643QBMQcMo=",
            privateKey,
            urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "https://ik.imagekit.io/vurkt9qyk"
        });

        const authParams = imagekit.getAuthenticationParameters();
        return res.status(200).json(authParams);
    } catch (error) {
        console.error('ImageKit auth error:', error);
        return res.status(500).json({ success: false, error: 'Failed to generate ImageKit authentication parameters: ' + error.message });
    }
}
