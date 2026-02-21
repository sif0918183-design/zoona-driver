/**
 * Notification Utilities Shared File
 * Handles Push API registration and subscription syncing with Supabase
 */

const NotificationUtils = {
    // VAPID Public Key
    vapidPublicKey: 'BELQSpfJpLROkcLYhHa1TeEsxdiUrz96HfocRfUCRiZ2cMX8LPt1wwF_a85SruFlX3sdKsAwQzpgyKTIuEhr2FA',

    /**
     * Registers the Service Worker and Subscribes to Push Notifications
     * @param {string} userId - The Supabase UUID of the user
     * @param {string} appType - 'passenger' or 'driver'
     * @param {string} swPath - Path to the Service Worker file
     */
    async subscribeUserToPush(userId, appType, swPath) {
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
            console.warn('Push notifications are not supported in this browser.');
            return null;
        }

        try {
            // Register Service Worker
            const registration = await navigator.serviceWorker.register(swPath);
            await navigator.serviceWorker.ready;

            // Request Permission
            const permission = await Notification.requestPermission();
            if (permission !== 'granted') {
                console.warn('Notification permission denied.');
                return null;
            }

            // Convert VAPID key to Uint8Array before subscribing
            const applicationServerKey = this.urlBase64ToUint8Array(this.vapidPublicKey);

            // Subscribe to Push
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: applicationServerKey
            });

            // Sync with Supabase
            await this.syncSubscriptionWithSupabase(userId, appType, subscription);

            return subscription;
        } catch (error) {
            console.error('Error subscribing to push notifications:', error);
            return null;
        }
    },

    /**
     * Syncs the push subscription with Supabase
     * Uses REST API as primary and Supabase Client as fallback
     */
    async syncSubscriptionWithSupabase(userId, appType, subscription) {
        const sbUrl = window.SB_URL;
        const sbKey = window.SB_KEY;

        if (!sbUrl || !sbKey) {
            console.error('Supabase configuration missing (SB_URL/SB_KEY) on window');
            return;
        }

        // Only update if it's a driver (as per requirements)
        if (appType === 'driver') {
            console.log('🔄 Syncing push_subscription for driver:', userId);
            const subscriptionData = subscription.toJSON();

            // Method 1: Direct Fetch to Supabase REST API (100% Reliability in WebViews)
            try {
                const response = await fetch(`${sbUrl}/rest/v1/drivers?id=eq.${userId}`, {
                    method: 'PATCH',
                    headers: {
                        'apikey': sbKey,
                        'Authorization': `Bearer ${sbKey}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify({
                        push_subscription: subscriptionData
                    })
                });

                if (response.ok) {
                    console.log('✅ push_subscription updated successfully via REST API');
                    return; // Success, exit
                } else {
                    const errorText = await response.text();
                    console.warn('⚠️ REST API update failed, trying fallback:', errorText);
                }
            } catch (fetchError) {
                console.warn('⚠️ REST API fetch error, trying fallback:', fetchError);
            }

            // Method 2: Supabase Client Fallback (Explicitly initialized)
            try {
                const sbLib = window.supabase;
                if (!sbLib) throw new Error('Supabase library not found on window');

                // Explicitly create client using window variables as requested
                const client = (typeof sbLib.createClient === 'function')
                    ? sbLib.createClient(sbUrl, sbKey)
                    : sbLib;

                if (typeof client.from !== 'function') {
                    throw new Error('Supabase client initialization failed (no .from method)');
                }

                const { error: updateError } = await client
                    .from('drivers')
                    .update({ push_subscription: subscriptionData })
                    .eq('id', userId);

                if (updateError) {
                    console.error('❌ Error updating via client fallback:', updateError);
                } else {
                    console.log('✅ push_subscription updated successfully via client fallback');
                }
            } catch (clientError) {
                console.error('❌ All synchronization methods failed:', clientError);
            }
        }
    },

    /**
     * Helper to convert VAPID key from base64url to Uint8Array
     */
    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/-/g, '+')
            .replace(/_/g, '/');

        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);

        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }
};

window.NotificationUtils = NotificationUtils;
