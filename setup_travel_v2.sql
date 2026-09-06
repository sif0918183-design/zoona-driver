-- ============================================
-- TRACKA TRAVEL PLATFORM V2 MIGRATION SCRIPT
-- ============================================

-- 1. Add departure and commission tracking columns to ride_requests
ALTER TABLE IF EXISTS public.ride_requests ADD COLUMN IF NOT EXISTS departure_time TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.ride_requests ADD COLUMN IF NOT EXISTS commission_status TEXT DEFAULT 'pending';
ALTER TABLE IF EXISTS public.ride_requests ADD COLUMN IF NOT EXISTS commission_grace_until TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.ride_requests ADD COLUMN IF NOT EXISTS contact_revealed BOOLEAN DEFAULT false;

-- 2. Add departure and commission tracking columns to travel_trips
ALTER TABLE IF EXISTS public.travel_trips ADD COLUMN IF NOT EXISTS departure_time TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.travel_trips ADD COLUMN IF NOT EXISTS commission_status TEXT DEFAULT 'pending';
ALTER TABLE IF EXISTS public.travel_trips ADD COLUMN IF NOT EXISTS commission_grace_until TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.travel_trips ADD COLUMN IF NOT EXISTS contact_revealed BOOLEAN DEFAULT false;

-- 3. Add rider reliability and restriction tracking columns to customers
ALTER TABLE IF EXISTS public.customers ADD COLUMN IF NOT EXISTS travel_restriction_type TEXT DEFAULT 'none';
ALTER TABLE IF EXISTS public.customers ADD COLUMN IF NOT EXISTS travel_restriction_until TIMESTAMPTZ;
ALTER TABLE IF EXISTS public.customers ADD COLUMN IF NOT EXISTS travel_restriction_reason TEXT;
ALTER TABLE IF EXISTS public.customers ADD COLUMN IF NOT EXISTS reliability_score NUMERIC DEFAULT 100;

-- 4. Create rider_reliability_logs table
CREATE TABLE IF NOT EXISTS public.rider_reliability_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    passenger_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    ride_id TEXT,
    cancelled_at TIMESTAMPTZ DEFAULT NOW(),
    departure_time TIMESTAMPTZ,
    hours_before_departure NUMERIC,
    status_at_cancellation TEXT,
    driver_selected BOOLEAN DEFAULT false,
    contact_revealed BOOLEAN DEFAULT false,
    commission_held BOOLEAN DEFAULT false,
    cancellation_reason TEXT,
    cancelled_by TEXT DEFAULT 'passenger',
    impact_level TEXT DEFAULT 'low',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on rider_reliability_logs
ALTER TABLE IF EXISTS public.rider_reliability_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public Read Reliability Logs" ON public.rider_reliability_logs;
CREATE POLICY "Public Read Reliability Logs" ON public.rider_reliability_logs
    FOR SELECT TO anon, authenticated
    USING (true);

DROP POLICY IF EXISTS "Admin Manage Reliability Logs" ON public.rider_reliability_logs;
CREATE POLICY "Admin Manage Reliability Logs" ON public.rider_reliability_logs
    FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

GRANT SELECT ON public.rider_reliability_logs TO anon, authenticated;
GRANT ALL ON public.rider_reliability_logs TO service_role;

-- 5. Seed default travel settings in system_settings
INSERT INTO public.system_settings (key, value)
VALUES
    ('max_advance_creation_days', '7'),
    ('max_drivers_accepting', '10'),
    ('commission_hold_hours', '10'),
    ('driver_lock_hours', '3'),
    ('high_impact_cancel_limit', '3'),
    ('restriction_duration_days', '3'),
    ('travel_commission_rate', '5')
ON CONFLICT (key) DO NOTHING;

-- 6. Indexes for fast travel lookups
CREATE INDEX IF NOT EXISTS idx_ride_requests_customer_status ON public.ride_requests(customer_id, status);
CREATE INDEX IF NOT EXISTS idx_ride_requests_departure_time ON public.ride_requests(departure_time);
CREATE INDEX IF NOT EXISTS idx_travel_trips_driver_status ON public.travel_trips(driver_id, status);
CREATE INDEX IF NOT EXISTS idx_travel_trips_passenger_status ON public.travel_trips(passenger_id, status);
CREATE INDEX IF NOT EXISTS idx_reliability_logs_passenger ON public.rider_reliability_logs(passenger_id, impact_level, cancelled_at);
