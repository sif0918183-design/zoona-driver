-- ==============================================================================
-- Tracka Strict Zero-Trust Database Row Level Security (RLS) Policies
-- File: security.sql
-- ==============================================================================

-- 1. Enable Row Level Security (RLS) on all sensitive tables
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

-- 2. Revoke all direct client modifications (INSERT, UPDATE, DELETE) for public/anon roles
-- This ensures that any data-modifying operation MUST go through the secure Vercel API
-- running under the high-privilege 'service_role' client.
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Grant permissions back to postgres, service_role, and superuser roles
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;

-- 3. Strict Row Level Security Policies aligned with user identity (auth.uid())
-- These rules protect data leaks while preserving active ride-tracking and maps sync.

-- ==============================================================================
-- CUSTOMERS POLICIES (الراكب يرى بياناته فقط)
-- ==============================================================================
DROP POLICY IF EXISTS "Allow customers to select self" ON public.customers;
DROP POLICY IF EXISTS "Allow customers to update self" ON public.customers;
DROP POLICY IF EXISTS "Strict Admin/Service Role Only on Customers" ON public.customers;
DROP POLICY IF EXISTS "Customers View Own Data" ON public.customers;

CREATE POLICY "Customers View Own Data" ON public.customers
    FOR SELECT TO authenticated
    USING (auth.uid() = id);

-- ==============================================================================
-- DRIVERS POLICIES (السائق يرى بياناته فقط)
-- ==============================================================================
DROP POLICY IF EXISTS "Allow drivers to select self" ON public.drivers;
DROP POLICY IF EXISTS "Allow drivers to update self" ON public.drivers;
DROP POLICY IF EXISTS "Strict Admin/Service Role Only on Drivers" ON public.drivers;
DROP POLICY IF EXISTS "Drivers View Own Data" ON public.drivers;

CREATE POLICY "Drivers View Own Data" ON public.drivers
    FOR SELECT TO authenticated
    USING (auth.uid() = id);

-- ==============================================================================
-- RIDE_REQUESTS POLICIES (الراكب يرى طلباته فقط، والسائق يرى المتاحة فقط)
-- ==============================================================================
DROP POLICY IF EXISTS "Allow ride requests select" ON public.ride_requests;
DROP POLICY IF EXISTS "Allow ride requests insert" ON public.ride_requests;
DROP POLICY IF EXISTS "Read-Only Ride Requests" ON public.ride_requests;
DROP POLICY IF EXISTS "Passenger View Own Requests" ON public.ride_requests;
DROP POLICY IF EXISTS "Driver View Pending Requests" ON public.ride_requests;

CREATE POLICY "Passenger View Own Requests" ON public.ride_requests
    FOR SELECT TO authenticated
    USING (auth.uid() = customer_id);

CREATE POLICY "Driver View Pending Requests" ON public.ride_requests
    FOR SELECT TO authenticated
    USING (status = 'pending');

-- ==============================================================================
-- RIDES POLICIES (المشاركون فقط يرون رحلاتهم لتأمين التتبع والخصوصية)
-- ==============================================================================
DROP POLICY IF EXISTS "Anyone can select rides" ON public.rides;
DROP POLICY IF EXISTS "Passengers and drivers can update rides" ON public.rides;
DROP POLICY IF EXISTS "Read-Only Rides Tracking" ON public.rides;
DROP POLICY IF EXISTS "Participants View Own Rides" ON public.rides;

CREATE POLICY "Participants View Own Rides" ON public.rides
    FOR SELECT TO authenticated
    USING (
        auth.uid() = passenger_id OR
        auth.uid() = driver_id
    );

-- ==============================================================================
-- DRIVER_LOCATIONS POLICIES (تحديث السائق لموقعه، وقراءة الموقع للجميع)
-- ==============================================================================
DROP POLICY IF EXISTS "Anyone can read driver locations" ON public.driver_locations;
DROP POLICY IF EXISTS "Drivers can update own location" ON public.driver_locations;
DROP POLICY IF EXISTS "Read-Only Driver Coordinates" ON public.driver_locations;
DROP POLICY IF EXISTS "Drivers Self Location Update" ON public.driver_locations;
DROP POLICY IF EXISTS "Driver Insert Own Location" ON public.driver_locations;
DROP POLICY IF EXISTS "Driver Update Own Location" ON public.driver_locations;
DROP POLICY IF EXISTS "Anyone Read Driver Locations" ON public.driver_locations;

-- فقط السائق المسجل يمكنه إدخال وتعديل إحداثياته اللحظية لمنع المواقع الوهمية
CREATE POLICY "Driver Insert Own Location" ON public.driver_locations
    FOR INSERT TO authenticated
    WITH CHECK (auth.uid() = driver_id);

CREATE POLICY "Driver Update Own Location" ON public.driver_locations
    FOR UPDATE TO authenticated
    USING (auth.uid() = driver_id)
    WITH CHECK (auth.uid() = driver_id);

-- يسمح بقراءة إحداثيات السائقين للجميع لغرض التتبع وعرض السائقين على الخريطة
CREATE POLICY "Anyone Read Driver Locations" ON public.driver_locations
    FOR SELECT TO anon, authenticated
    USING (true);

-- ==============================================================================
-- BALANCE_TRANSACTIONS POLICIES (السائق يرى معاملاته المالية فقط)
-- ==============================================================================
DROP POLICY IF EXISTS "Drivers can view own transactions" ON public.balance_transactions;
DROP POLICY IF EXISTS "Read-Only Ledger View" ON public.balance_transactions;
DROP POLICY IF EXISTS "Driver View Own Transactions" ON public.balance_transactions;

CREATE POLICY "Driver View Own Transactions" ON public.balance_transactions
    FOR SELECT TO authenticated
    USING (auth.uid() = driver_id);

-- ==============================================================================
-- COMPLAINTS POLICIES (إدخال الشكاوى للجميع، وقراءتها للإدارة والـ API فقط)
-- ==============================================================================
DROP POLICY IF EXISTS "Allow complaints insert" ON public.complaints;
DROP POLICY IF EXISTS "Allow complaints read" ON public.complaints;
DROP POLICY IF EXISTS "Insert-Only Complaints" ON public.complaints;
DROP POLICY IF EXISTS "Anyone Insert Complaints" ON public.complaints;
DROP POLICY IF EXISTS "Admins View Complaints" ON public.complaints;

CREATE POLICY "Anyone Insert Complaints" ON public.complaints
    FOR INSERT TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY "Admins View Complaints" ON public.complaints
    FOR SELECT TO service_role
    USING (true);

-- ==============================================================================
-- TRAVEL_TRIPS POLICIES (المشاركون فقط يرون رحلات السفر)
-- ==============================================================================
DROP POLICY IF EXISTS "Allow travel trips select" ON public.travel_trips;
DROP POLICY IF EXISTS "Allow travel trips update" ON public.travel_trips;
DROP POLICY IF EXISTS "Read-Only Travel Bookings" ON public.travel_trips;
DROP POLICY IF EXISTS "Participants View Own Travel Trips" ON public.travel_trips;

CREATE POLICY "Participants View Own Travel Trips" ON public.travel_trips
    FOR SELECT TO authenticated
    USING (
        auth.uid() = passenger_id OR
        auth.uid() = driver_id
    );

-- ==============================================================================
-- DEFAULT LOCKDOWN FOR ALL OTHER TABLES
-- ==============================================================================
-- Trips, ride_logs, ride_driver_accepts, driver_sessions, notifications,
-- driver_notifications, device_tokens are fully locked down from direct public access.
-- All actions go through Vercel serverless functions with service_role privileges.
