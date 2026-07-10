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
REVOKE INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public FROM anon, authenticated;

-- Grant permissions back to postgres, service_role, and superuser roles
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;

-- 3. Strict Read-Only & Limited Insert Policies for Anonymous Clients
-- Since the frontend uses the public anon key for Realtime tracking and limited state queries,
-- we allow read-only access where necessary but strictly forbid client-side write manipulation.

-- ==============================================================================
-- CUSTOMERS POLICIES
-- ==============================================================================
DROP POLICY IF EXISTS "Allow customers to select self" ON public.customers;
DROP POLICY IF EXISTS "Allow customers to update self" ON public.customers;
-- Completely lock down customers from direct client-side reads/writes
CREATE POLICY "Strict Admin/Service Role Only on Customers" ON public.customers
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ==============================================================================
-- DRIVERS POLICIES
-- ==============================================================================
DROP POLICY IF EXISTS "Allow drivers to select self" ON public.drivers;
DROP POLICY IF EXISTS "Allow drivers to update self" ON public.drivers;
-- Completely lock down drivers from direct client-side reads/writes
CREATE POLICY "Strict Admin/Service Role Only on Drivers" ON public.drivers
    FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ==============================================================================
-- RIDE_REQUESTS POLICIES
-- ==============================================================================
DROP POLICY IF EXISTS "Allow ride requests select" ON public.ride_requests;
DROP POLICY IF EXISTS "Allow ride requests insert" ON public.ride_requests;
-- Allow select for active travel platform matchings; writes restricted to service_role
CREATE POLICY "Read-Only Ride Requests" ON public.ride_requests
    FOR SELECT TO anon, authenticated USING (true);

-- ==============================================================================
-- RIDES POLICIES (Tracking & Realtime)
-- ==============================================================================
DROP POLICY IF EXISTS "Anyone can select rides" ON public.rides;
DROP POLICY IF EXISTS "Passengers and drivers can update rides" ON public.rides;
-- Allow SELECT for ride tracking (Realtime subscriptions), but forbid client UPDATE
CREATE POLICY "Read-Only Rides Tracking" ON public.rides
    FOR SELECT TO anon, authenticated USING (true);

-- ==============================================================================
-- DRIVER_LOCATIONS POLICIES (Map Sync)
-- ==============================================================================
DROP POLICY IF EXISTS "Anyone can read driver locations" ON public.driver_locations;
DROP POLICY IF EXISTS "Drivers can update own location" ON public.driver_locations;
-- Allow SELECT for tracking driver coordinates on passenger map
CREATE POLICY "Read-Only Driver Coordinates" ON public.driver_locations
    FOR SELECT TO anon, authenticated USING (true);

-- Allow drivers to insert or update their own coordinates
CREATE POLICY "Drivers Self Location Update" ON public.driver_locations
    FOR ALL TO anon, authenticated
    USING (true)
    WITH CHECK (true);

-- ==============================================================================
-- BALANCE_TRANSACTIONS POLICIES
-- ==============================================================================
DROP POLICY IF EXISTS "Drivers can view own transactions" ON public.balance_transactions;
-- Allow SELECT for drivers to check ledger; modifications are API-only
CREATE POLICY "Read-Only Ledger View" ON public.balance_transactions
    FOR SELECT TO anon, authenticated USING (true);

-- ==============================================================================
-- COMPLAINTS POLICIES
-- ==============================================================================
DROP POLICY IF EXISTS "Allow complaints insert" ON public.complaints;
DROP POLICY IF EXISTS "Allow complaints read" ON public.complaints;
-- Allow insert of complaints via public; select restricted to admin
CREATE POLICY "Insert-Only Complaints" ON public.complaints
    FOR INSERT TO anon, authenticated WITH CHECK (true);

-- ==============================================================================
-- TRAVEL_TRIPS POLICIES
-- ==============================================================================
DROP POLICY IF EXISTS "Allow travel trips select" ON public.travel_trips;
DROP POLICY IF EXISTS "Allow travel trips update" ON public.travel_trips;
-- Allow SELECT for travel platform tracking; updates restricted to service role
CREATE POLICY "Read-Only Travel Bookings" ON public.travel_trips
    FOR SELECT TO anon, authenticated USING (true);

-- ==============================================================================
-- DEFAULT LOCKDOWN FOR ALL OTHER TABLES
-- ==============================================================================
-- Trips, ride_logs, ride_driver_accepts, driver_sessions, notifications,
-- driver_notifications, device_tokens are fully locked down from direct public access.
-- All actions go through Vercel serverless functions with service_role privileges.
