-- ==============================================================================
-- Tracka Strict RLS Policies - CORRECT VERSION
-- ==============================================================================

-- Enable RLS on all tables
ALTER TABLE IF EXISTS public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ride_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rides ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ride_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ride_driver_accepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.driver_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.driver_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.driver_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.balance_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.travel_trips ENABLE ROW LEVEL SECURITY;

-- Revoke all modifications from anon/authenticated
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;

-- Only SELECT for reading, no INSERT/UPDATE/DELETE
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT INSERT ON public.complaints TO anon, authenticated;
GRANT INSERT, UPDATE ON public.driver_locations TO authenticated;

-- ==============================================================================
-- CUSTOMERS - الراكب يرى بياناته فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Customers View Own Data" ON public.customers;
CREATE POLICY "Customers View Own Data" ON public.customers
    FOR SELECT TO authenticated
    USING (auth.uid() = id);

-- ==============================================================================
-- DRIVERS - السائق يرى بياناته فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Drivers View Own Data" ON public.drivers;
CREATE POLICY "Drivers View Own Data" ON public.drivers
    FOR SELECT TO authenticated
    USING (auth.uid() = id);

-- ==============================================================================
-- RIDE_REQUESTS - الراكب يرى طلباته، السائق يرى المتاحة
-- ==============================================================================
DROP POLICY IF EXISTS "Passenger View Own Requests" ON public.ride_requests;
DROP POLICY IF EXISTS "Driver View Pending Requests" ON public.ride_requests;
CREATE POLICY "Passenger View Own Requests" ON public.ride_requests
    FOR SELECT TO authenticated
    USING (auth.uid() = customer_id);

CREATE POLICY "Driver View Pending Requests" ON public.ride_requests
    FOR SELECT TO authenticated
    USING (status = 'pending');

-- ==============================================================================
-- RIDES - المشاركون فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Participants View Own Rides" ON public.rides;
CREATE POLICY "Participants View Own Rides" ON public.rides
    FOR SELECT TO authenticated
    USING (
        auth.uid() = passenger_id OR
        auth.uid() = driver_id
    );

-- ==============================================================================
-- DRIVER_LOCATIONS - السائق يكتب، الكل يقرأ
-- ==============================================================================
DROP POLICY IF EXISTS "Driver Insert Own Location" ON public.driver_locations;
DROP POLICY IF EXISTS "Driver Update Own Location" ON public.driver_locations;
DROP POLICY IF EXISTS "Anyone Read Driver Locations" ON public.driver_locations;

CREATE POLICY "Driver Insert Own Location" ON public.driver_locations
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "Driver Update Own Location" ON public.driver_locations
    FOR UPDATE TO authenticated
    USING (auth.uid() = driver_id)
    WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "Anyone Read Driver Locations" ON public.driver_locations
    FOR SELECT TO anon, authenticated
    USING (true);

-- ==============================================================================
-- BALANCE_TRANSACTIONS - السائق يرى معاملاته فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Driver View Own Transactions" ON public.balance_transactions;
CREATE POLICY "Driver View Own Transactions" ON public.balance_transactions
    FOR SELECT TO authenticated
    USING (auth.uid() = driver_id);

-- ==============================================================================
-- COMPLAINTS - الكل يرسل، الإداري يقرأ
-- ==============================================================================
DROP POLICY IF EXISTS "Anyone Insert Complaints" ON public.complaints;
DROP POLICY IF EXISTS "Admins View Complaints" ON public.complaints;
CREATE POLICY "Anyone Insert Complaints" ON public.complaints
    FOR INSERT TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY "Admins View Complaints" ON public.complaints
    FOR SELECT TO service_role
    USING (true);

-- ==============================================================================
-- TRAVEL_TRIPS - المشاركون فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Participants View Own Travel Trips" ON public.travel_trips;
CREATE POLICY "Participants View Own Travel Trips" ON public.travel_trips
    FOR SELECT TO authenticated
    USING (
        auth.uid() = passenger_id OR
        auth.uid() = driver_id
    );
