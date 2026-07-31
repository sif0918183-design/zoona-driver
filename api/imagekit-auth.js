import ImageKit from 'imagekit';

export default async function handler(req, res) {
    // Enable CORS with relaxed headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    try {
        const imagekit = new ImageKit({
            publicKey: process.env.IMAGEKIT_PUBLIC_KEY || "public_SnxtM9/xheLA8u65v643QBMQcMo=",
            privateKey: process.env.IMAGEKIT_PRIVATE_KEY || "private_o/lKTz8k3C2jWMhV+g6UFLLXnoU=",
            urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT || "https://ik.imagekit.io/vurkt9qyk"
        });

        const authParams = imagekit.getAuthenticationParameters();
        return res.status(200).json(authParams);
    } catch (error) {
        console.error('ImageKit auth error:', error);
        return res.status(500).json({ success: false, error: 'Failed to generate ImageKit authentication parameters: ' + error.message });
    }
}
