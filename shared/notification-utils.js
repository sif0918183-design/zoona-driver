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
        if (!window.supabase || !window.SB_URL || !window.SB_KEY) {
            console.error('Supabase configuration missing for push sync');
            return;
        }

        const client = window.supabase.createClient(window.SB_URL, window.SB_KEY);
        const subscriptionData = subscription.toJSON();
        const subscriptionJSON = JSON.stringify(subscriptionData);

        // 1. Always sync with the central push_subscriptions table
        const { endpoint, keys } = subscriptionData;
        const pushSubscriptionRecord = {
            endpoint: endpoint,
            keys: keys,
            user_id: userId,
            app_type: appType,
            user_agent: navigator.userAgent,
            updated_at: new Date().toISOString()
        };

        const { error: upsertError } = await client
            .from('push_subscriptions')
            .upsert(pushSubscriptionRecord, { onConflict: 'endpoint' });

        if (upsertError) {
            console.error('❌ Error syncing with push_subscriptions table:', upsertError);
        }

        // 2. If it's a driver, update the push_subscription column in the drivers table
        if (appType === 'driver') {
            console.log('Updating drivers table with push_subscription for:', userId);
            const { error: updateError } = await client
                .from('drivers')
                .update({ push_subscription: subscriptionJSON })
                .eq('id', userId);

            if (updateError) {
                console.error('❌ CRITICAL: Error updating push_subscription in drivers table:', updateError);
                console.error('This may be due to RLS policies or missing column.');
            } else {
                console.log('✅ push_subscription updated successfully in drivers table');
            }
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
