-- ==============================================================================
-- Fix: Passenger Ride Cancellation Issue
-- This script fixes the "Ride not found" error when passenger tries to cancel 
-- their ride from ride-accepted.html page
-- ==============================================================================
-- This file is compatible with existing SQL files:
-- - schema.sql (adds columns)
-- - fix_cancel_ride_rls.sql (RLS policies for rides)
-- - grant_passenger_access.sql (driver_locations policies)
-- - fix_commission_deduction.sql (commission functions)
-- ==============================================================================

-- ==============================================================================
-- 1. Fix rides RLS policies - Allow passengers to SELECT their own rides
-- The app uses anonymous auth (localStorage), so we need policies that allow
-- anon users to read their rides based on passenger_id directly
-- ==============================================================================

-- Enable RLS on rides table (if not already enabled)
ALTER TABLE rides ENABLE ROW LEVEL SECURITY;

-- Policy: Anyone can SELECT rides (needed for the app since no auth)
-- This is critical for the cancellation to work - passenger needs to read the ride first
DROP POLICY IF EXISTS "Anyone can select rides" ON rides;
CREATE POLICY "Anyone can select rides" ON rides
    FOR SELECT
    TO anon
    USING (true);

-- Policy: Passengers can UPDATE their own rides (for cancellation)
-- This policy is already defined in fix_cancel_ride_rls.sql but we ensure it's correct
-- Note: We use OR auth.uid() IS NULL to allow anon users (the app doesn't use auth)
DROP POLICY IF EXISTS "Passengers can update own rides" ON rides;
CREATE POLICY "Passengers can update own rides" ON rides
    FOR UPDATE
    TO anon
    USING (
        passenger_id IN (
            SELECT id FROM passengers 
            WHERE auth_id = auth.uid()
        ) OR auth.uid() IS NULL
    )
    WITH CHECK (
        passenger_id IN (
            SELECT id FROM passengers 
            WHERE auth_id = auth.uid()
        ) OR auth.uid() IS NULL
    );

-- Policy: Drivers can UPDATE their own rides
DROP POLICY IF EXISTS "Drivers can update own rides" ON rides;
CREATE POLICY "Drivers can update own rides" ON rides
    FOR UPDATE
    TO anon
    USING (
        driver_id IN (
            SELECT id FROM drivers 
            WHERE auth_id = auth.uid()
        ) OR auth.uid() IS NULL
    )
    WITH CHECK (
        driver_id IN (
            SELECT id FROM drivers 
            WHERE auth_id = auth.uid()
        ) OR auth.uid() IS NULL
    );

-- ==============================================================================
-- 2. Grant necessary permissions for rides table
-- ==============================================================================

GRANT SELECT ON rides TO anon, authenticated;
GRANT UPDATE ON rides TO anon, authenticated;

-- ==============================================================================
-- 3. Ensure driver_locations is accessible for passengers to read driver location
-- The existing policy in grant_passenger_access.sql requires auth.uid()
-- We need to add a fallback for anon users
-- ==============================================================================

-- Add policy to allow anyone to read driver locations (needed for tracking)
DROP POLICY IF EXISTS "Anyone can read driver locations" ON driver_locations;
CREATE POLICY "Anyone can read driver locations" ON driver_locations
    FOR SELECT
    TO anon
    USING (true);

-- ==============================================================================
-- 4. Ensure balance_transactions is accessible
-- ==============================================================================

-- Grant permissions for balance_transactions
GRANT SELECT, INSERT ON balance_transactions TO anon, authenticated;

-- Policy: Anyone can insert balance transactions (for cancellation refund)
DROP POLICY IF EXISTS "Anyone can insert balance transactions" ON balance_transactions;
CREATE POLICY "Anyone can insert balance transactions" ON balance_transactions
    FOR INSERT
    TO anon
    WITH CHECK (true);

-- Policy: Anyone can select balance transactions
DROP POLICY IF EXISTS "Anyone can select balance transactions" ON balance_transactions;
CREATE POLICY "Anyone can select balance transactions" ON balance_transactions
    FOR SELECT
    TO anon
    USING (true);

-- ==============================================================================
-- 5. Ensure drivers table is accessible for balance updates
-- ==============================================================================

GRANT SELECT, UPDATE ON drivers TO anon, authenticated;

-- Policy: Anyone can update drivers (needed for balance changes)
DROP POLICY IF EXISTS "Anyone can update driver balance" ON drivers;
CREATE POLICY "Anyone can update driver balance" ON drivers
    FOR UPDATE
    TO anon
    USING (true)
    WITH CHECK (true);

-- ==============================================================================
-- 6. Verify/Add auth_id column to passengers table
-- (This might be missing and causing issues)
-- ==============================================================================

ALTER TABLE passengers ADD COLUMN IF NOT EXISTS auth_id UUID;
ALTER TABLE passengers ADD COLUMN IF NOT EXISTS phone VARCHAR(20);

-- ==============================================================================
-- 7. Debug: Check current rides and their statuses
-- Uncomment to debug:
-- ==============================================================================

-- SELECT id, status, driver_id, passenger_id, amount, accepted_at, cancelled_at
-- FROM rides 
-- WHERE status IN ('accepted', 'arrived', 'ongoing')
-- ORDER BY accepted_at DESC
-- LIMIT 10;

-- ==============================================================================
-- Note: Run this SQL in Supabase SQL Editor to fix the ride cancellation issue
-- This file adds anon (unauthenticated) policies which are required since
-- the app doesn't use Supabase authentication - it uses localStorage instead
-- ==============================================================================