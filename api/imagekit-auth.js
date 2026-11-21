import ImageKit from 'imagekit';
import { verifyToken } from './_token-utils.js';

export default async function handler(req, res) {
    // Enable CORS with relaxed headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
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
