export default function handler(req, res) {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const siteKey = process.env.TURNSTILE_SITE_KEY || '1x00000000000000000000AA'; // Standard Cloudflare testing site key

    return res.status(200).json({
        success: true,
        siteKey: siteKey
    });
}
