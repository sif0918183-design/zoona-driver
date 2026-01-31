// ==================================================================
// Vercel Serverless Function: /api/send-push.js
// Refactored to use OneSignal REST API instead of Firebase Cloud Messaging
// ==================================================================

// Helper function for structured logging
const log = (level, message, data = {}) => {
    console.log(JSON.stringify({
        level,
        message,
        ...data,
        timestamp: new Date().toISOString()
    }));
};

/**
 * Handles incoming requests to send a push notification via OneSignal.
 * @param {VercelRequest} req The request object.
 * @param {VercelResponse} res The response object.
 */
export default async function handler(req, res) {
    // Set CORS headers for preflight requests and cross-origin responses
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle OPTIONS preflight request
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Ensure the request method is POST
    if (req.method !== 'POST') {
        log('warn', 'Method not allowed', { method: req.method });
        return res.status(405).json({ success: false, error: 'method_not_allowed' });
    }

    // Destructure and validate required parameters from the request body
    const {
        playerId, // Changed from 'token' to 'playerId' for OneSignal
        rideId,
        driverId,
        requestId,
        customerName,
        vehicleType,
        amount,
        distance
    } = req.body;

    // Validate the OneSignal Player ID
    if (!playerId || !playerId.includes('-')) {
        log('warn', 'Invalid OneSignal Player ID format', { playerId });
        return res.status(400).json({ success: false, error: 'invalid_player_id_format' });
    }

    // Validate essential ride information
    if (!rideId || !requestId) {
        log('warn', 'Missing rideId or requestId', { rideId, requestId });
        return res.status(400).json({ success: false, error: 'missing_parameters' });
    }

    log('info', 'Received send-push request for OneSignal', {
        driverId,
        rideId,
        playerIdPreview: playerId.substring(0, 20)
    });

    // Retrieve OneSignal credentials from environment variables
    const ONE_SIGNAL_APP_ID = process.env.ONESIGNAL_APP_ID;
    const ONE_SIGNAL_REST_API_KEY = process.env.ONESIGNAL_REST_API_KEY;

    if (!ONE_SIGNAL_APP_ID || !ONE_SIGNAL_REST_API_KEY) {
        log('error', 'OneSignal environment variables are not set');
        return res.status(500).json({ success: false, error: 'server_configuration_error' });
    }

    // Construct the notification payload for the OneSignal API
    const notificationPayload = {
        app_id: ONE_SIGNAL_APP_ID,
        include_player_ids: [playerId],
        headings: {
            en: '🚖 New Ride Request!',
            ar: '🚖 طلب رحلة جديد!'
        },
        contents: {
            en: `Customer ${customerName || 'is'} requesting a ${vehicleType || 'ride'}.`,
            ar: `العميل ${customerName || ''} يطلب رحلة ${vehicleType ? `- ${vehicleType}` : ''}`
        },
        data: {
            rideId: String(rideId),
            requestId: String(requestId),
            driverId: String(driverId || ''),
            customerName: String(customerName || ''),
            vehicleType: String(vehicleType || ''),
            amount: String(amount || '0'),
            distance: String(distance || '0'),
            notificationType: 'ride_request'
        },
        // URL to open when the notification is clicked
        web_url: `/accept-ride.html?rideId=${rideId}&requestId=${requestId}`,

        // --- High Priority & Sound Settings ---
        priority: 10, // Max priority
        ttl: 60, // Time to live in seconds

        // For Android: Ensure sound plays by specifying a channel ID
        // This channel must be created in your OneSignal dashboard with a custom sound
        android_channel_id: process.env.ONESIGNAL_ANDROID_CHANNEL_ID_WITH_SOUND,

        // For iOS:
        ios_badgeType: 'Increase',
        ios_badgeCount: 1,
        sound: 'ride_request_sound.wav', // Custom sound file in your app bundle

        // --- Action Buttons ---
        web_buttons: [
            { id: 'accept-ride', text: 'Accept' },
            { id: 'decline-ride', text: 'Decline' }
        ]
    };

    try {
        log('info', 'Sending notification to OneSignal API', { driverId, rideId });

        // Make the API call to OneSignal
        const response = await fetch('https://onesignal.com/api/v1/notifications', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json; charset=utf-8',
                'Authorization': `Basic ${ONE_SIGNAL_REST_API_KEY}`
            },
            body: JSON.stringify(notificationPayload)
        });

        const result = await response.json();

        // Check if the request was successful
        if (response.ok && !result.errors) {
            log('info', 'OneSignal notification sent successfully', {
                notificationId: result.id,
                driverId,
                rideId
            });
            return res.status(200).json({ success: true, messageId: result.id });
        }

        // Handle errors from OneSignal
        log('error', 'OneSignal API error', {
            driverId,
            rideId,
            statusCode: response.status,
            errors: result.errors,
            warnings: result.warnings
        });

        // If the player ID is invalid, inform the client to take action
        const isPlayerIdInvalid = result.errors?.some(e => e.includes('does not exist'));
        if (isPlayerIdInvalid) {
            return res.status(410).json({
                success: false,
                error: 'player_id_unregistered',
                shouldInvalidate: true,
                details: result.errors
            });
        }

        return res.status(response.status).json({
            success: false,
            error: 'onesignal_api_error',
            details: result.errors || result.warnings || 'Unknown OneSignal error'
        });

    } catch (error) {
        log('error', 'Internal server error while sending notification', {
            error: error.message,
            stack: error.stack,
            driverId,
            rideId
        });
        return res.status(500).json({ success: false, error: 'internal_server_error' });
    }
}
