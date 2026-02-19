/**
 * Notification Utilities Shared File
 * Handles Push API registration and subscription syncing with Supabase
 */

const NotificationUtils = {
    // VAPID Public Key (if applicable, can be loaded from config)
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

            // Subscribe to Push
            const subscription = await registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: this.urlBase64ToUint8Array(this.vapidPublicKey)
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
     * Syncs the push subscription with the Supabase push_subscriptions table
     */
    async syncSubscriptionWithSupabase(userId, appType, subscription) {
        if (!window.supabase) return;

        const client = window.supabase.createClient(window.SB_URL, window.SB_KEY);

        const { endpoint, keys } = subscription.toJSON();

        const subscriptionData = {
            endpoint: endpoint,
            keys: keys,
            user_id: userId,
            app_type: appType,
            user_agent: navigator.userAgent,
            updated_at: new Date().toISOString()
        };

        const { error } = await client
            .from('push_subscriptions')
            .upsert(subscriptionData, { onConflict: 'endpoint' });

        if (error) {
            console.error('Error syncing push subscription with Supabase:', error);
        } else {
            console.log('Push subscription synced successfully with Supabase.');
        }
    },

    /**
     * Helper to convert VAPID key
     */
    urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding)
            .replace(/\-/g, '+')
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
