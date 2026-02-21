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
     * Only focuses on the drivers table as requested
     */
    async syncSubscriptionWithSupabase(userId, appType, subscription) {
        if (!window.supabase || !window.SB_URL || !window.SB_KEY) {
            console.error('Supabase configuration missing for push sync');
            return;
        }

        // Only update if it's a driver
        if (appType === 'driver') {
            const client = window.supabase.createClient(window.SB_URL, window.SB_KEY);
            const subscriptionJSON = JSON.stringify(subscription.toJSON());

            console.log('Updating drivers table with push_subscription for:', userId);
            const { error: updateError } = await client
                .from('drivers')
                .update({ push_subscription: subscriptionJSON })
                .eq('id', userId);

            if (updateError) {
                console.error('❌ Error updating push_subscription in drivers table:', updateError);
            } else {
                console.log('✅ push_subscription updated successfully in drivers table');
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
