-- ==============================================================================
-- Migration SQL: FCM Token Support for Passengers & Driver Travel Notification Settings
-- ==============================================================================

-- 1. Add fcm_token and last_fcm_sync to customers table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'fcm_token'
    ) THEN
        ALTER TABLE customers ADD COLUMN fcm_token TEXT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name = 'last_fcm_sync'
    ) THEN
        ALTER TABLE customers ADD COLUMN last_fcm_sync TIMESTAMP WITH TIME ZONE;
    END IF;
END $$;

-- 2. Add travel_notifications_enabled to drivers table
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'drivers' AND column_name = 'travel_notifications_enabled'
    ) THEN
        ALTER TABLE drivers ADD COLUMN travel_notifications_enabled BOOLEAN DEFAULT TRUE;
    END IF;
END $$;

-- Index for fast lookup of active tokens
CREATE INDEX IF NOT EXISTS idx_customers_fcm_token ON customers(fcm_token) WHERE fcm_token IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_drivers_travel_notifs ON drivers(travel_notifications_enabled) WHERE travel_notifications_enabled = TRUE;
