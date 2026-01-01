// ============================================
// OneSignal Manager for Tarhal Driver App
// ============================================

class OneSignalManager {
    constructor() {
        this.appId = null; // Will be loaded from environment
        this.isInitialized = false;
    }

    /**
     * Initializes the OneSignal SDK.
     * This function should be called once the application starts.
     */
    async initialize() {
        // Prevent re-initialization
        if (this.isInitialized || !window.OneSignal) {
            console.log('OneSignal is already initialized or not available.');
            return;
        }

        console.log('OneSignal Manager: Initializing...');

        // It's recommended to fetch the App ID from a secure backend endpoint
        // For this example, we'll simulate fetching it.
        // In a real app, replace this with an actual API call.
        this.appId = await this.fetchOneSignalAppId();

        if (!this.appId) {
            console.error('OneSignal App ID is missing. Cannot initialize.');
            return;
        }

        window.OneSignal = window.OneSignal || [];
        await window.OneSignal.push(() => {
            OneSignal.init({
                appId: this.appId,
                allowLocalhostAsSecureOrigin: true, // For development
                autoRegister: false, // We will register manually
                notifyButton: {
                    enable: false, // We will use a custom button
                },
            });
        });

        this.isInitialized = true;
        console.log('OneSignal SDK Initialized.');

        this.registerEventListeners();
    }

    /**
     * Simulates fetching the OneSignal App ID from the backend.
     * In a production environment, this should make a call to a secure endpoint
     * that returns the ONESIGNAL_APP_ID environment variable.
     */
    async fetchOneSignalAppId() {
        try {
            const response = await fetch('/api/get-onesignal-id');
            if (!response.ok) {
                throw new Error(`Failed to fetch OneSignal App ID: ${response.statusText}`);
            }
            const data = await response.json();
            return data.appId;
        } catch (error) {
            console.error('Error fetching OneSignal App ID:', error);
            return null;
        }
    }


    /**
     * Registers event listeners for OneSignal events.
     */
    registerEventListeners() {
        OneSignal.on('subscriptionChange', (isSubscribed) => {
            console.log('OneSignal: Subscription status changed:', isSubscribed);
            if (isSubscribed) {
                this.updatePlayerIdForDriver();
            }
        });

        OneSignal.on('notificationDisplay', (event) => {
            console.log('OneSignal: Notification displayed:', event);
            // You can add custom logic here when a notification is shown
        });
    }

    /**
     * Prompts the user to subscribe to notifications and registers the device.
     */
    async promptForNotifications() {
        if (!this.isInitialized) {
            console.error('OneSignal not initialized. Cannot prompt for notifications.');
            return;
        }

        await OneSignal.showSlidedownPrompt();
        // After the user interacts with the prompt, the 'subscriptionChange' event will handle the rest.
    }

    /**
     * Associates the OneSignal Player ID with the current driver in the database.
     */
    async updatePlayerIdForDriver() {
        if (!currentDriver || !currentDriver.id) {
            console.log('No active driver to associate with OneSignal Player ID.');
            return;
        }

        const playerId = await OneSignal.getUserId();
        if (!playerId) {
            console.error('Could not get OneSignal Player ID.');
            return;
        }

        console.log(`Associating OneSignal Player ID: ${playerId} with Driver ID: ${currentDriver.id}`);

        try {
            const { data, error } = await tarhalDB
                .from('driver_notifications') // Using the same table for simplicity
                .upsert({
                    driver_id: currentDriver.id,
                    onesignal_player_id: playerId, // New column for OneSignal
                    notification_enabled: true,
                    updated_at: new Date().toISOString(),
                }, { onConflict: 'driver_id' });

            if (error) {
                throw error;
            }

            console.log('Successfully updated driver with OneSignal Player ID.');
            showNotification('تم تفعيل إشعارات OneSignal بنجاح!', 'success');

        } catch (error) {
            console.error('Error updating driver with OneSignal Player ID:', error);
            showNotification('فشل تحديث معرف الإشعارات.', 'error');
        }
    }
}

// Instantiate the manager and attach it to the window object for global access
window.oneSignalManager = new OneSignalManager();

// Initialize OneSignal when the document is ready
document.addEventListener('DOMContentLoaded', () => {
    // We will initialize it manually after driver login
    // window.oneSignalManager.initialize();
});
