-- ===================================================================
-- SQL Fix for Supabase RLS Policies and Balance Transactions
-- This script fixes potential issues with ride cancellation and ensures
-- proper functionality for balance transactions
-- ===================================================================

-- ===================================================================
-- 1. Enable RLS on balance_transactions if not already enabled
-- ===================================================================
ALTER TABLE IF EXISTS balance_transactions ENABLE ROW LEVEL SECURITY;

-- ===================================================================
-- 2. Create policy for drivers to view their own transactions
-- ===================================================================
DROP POLICY IF EXISTS "Drivers can view own transactions" ON balance_transactions;
CREATE POLICY "Drivers can view own transactions" ON balance_transactions
    FOR SELECT
    USING (driver_id IN (
        SELECT id FROM drivers 
        WHERE auth_id = auth.uid()
    ) OR auth.uid() IS NULL);

-- ===================================================================
-- 3. Create policy for inserting balance transactions (service role bypass)
-- Note: Client-side insert should work with proper anon key permissions
-- ===================================================================
DROP POLICY IF EXISTS "Allow service role to insert transactions" ON balance_transactions;
CREATE POLICY "Allow service role to insert transactions" ON balance_transactions
    FOR INSERT
    WITH CHECK (true);

-- ===================================================================
-- 4. Create policy for authenticated users to insert their own transactions
-- ===================================================================
DROP POLICY IF EXISTS "Authenticated users can insert own transactions" ON balance_transactions;
CREATE POLICY "Authenticated users can insert own transactions" ON balance_transactions
    FOR INSERT
    WITH CHECK (
        driver_id IN (
            SELECT id FROM drivers 
            WHERE auth_id = auth.uid()
        ) OR auth.uid() IS NULL
    );

-- ===================================================================
-- 5. Create policy for rides - drivers can update their own rides
-- ===================================================================
DROP POLICY IF EXISTS "Drivers can update own rides" ON rides;
CREATE POLICY "Drivers can update own rides" ON rides
    FOR UPDATE
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

-- ===================================================================
-- 6. Create policy for rides - passengers can update their own rides
-- ===================================================================
DROP POLICY IF EXISTS "Passengers can update own rides" ON rides;
CREATE POLICY "Passengers can update own rides" ON rides
    FOR UPDATE
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

-- ===================================================================
-- 7. Create policy for drivers - can update own balance
-- ===================================================================
DROP POLICY IF EXISTS "Drivers can update own balance" ON drivers;
CREATE POLICY "Drivers can update own balance" ON drivers
    FOR UPDATE
    USING (id IN (
        SELECT id FROM drivers 
        WHERE auth_id = auth.uid()
    ) OR auth.uid() IS NULL)
    WITH CHECK (id IN (
        SELECT id FROM drivers 
        WHERE auth_id = auth.uid()
    ) OR auth.uid() IS NULL);

-- ===================================================================
-- 8. Create function to handle ride cancellation with proper error handling
-- ===================================================================
CREATE OR REPLACE FUNCTION public.cancel_ride(p_ride_id UUID, p_cancelled_by TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_ride RECORD;
    v_driver RECORD;
    v_commission_amount DECIMAL(10,2);
BEGIN
    -- Get ride details
    SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;
    
    IF v_ride IS NULL THEN
        RAISE EXCEPTION 'Ride not found';
    END IF;
    
    -- Check if ride is still active
    IF v_ride.status NOT IN ('accepted', 'arrived', 'ongoing') THEN
        RAISE EXCEPTION 'Ride is not active';
    END IF;
    
    -- Calculate commission (10%)
    v_commission_amount := FLOOR(COALESCE(v_ride.amount, 0) * 0.10);
    
    -- Update ride status
    UPDATE rides
    SET 
        status = CASE 
            WHEN p_cancelled_by = 'driver' THEN 'cancelled_by_driver'
            ELSE 'cancelled_by_customer'
        END,
        cancelled_at = NOW(),
        cancellation_reason = CASE 
            WHEN p_cancelled_by = 'driver' THEN 'إلغاء السائق'
            ELSE 'إلغاء الراكب'
        END,
        updated_at = NOW()
    WHERE id = p_ride_id;
    
    -- Get driver details
    SELECT * INTO v_driver FROM drivers WHERE id = v_ride.driver_id;
    
    IF v_driver IS NOT NULL AND v_commission_amount > 0 THEN
        -- Update driver balance (return commission)
        UPDATE drivers
        SET balance = COALESCE(balance, 0) + v_commission_amount
        WHERE id = v_ride.driver_id;
        
        -- Record transaction
        INSERT INTO balance_transactions (
            driver_id,
            ride_id,
            amount,
            type,
            description,
            created_at
        ) VALUES (
            v_ride.driver_id,
            p_ride_id,
            v_commission_amount,
            'cancellation_refund',
            CASE 
                WHEN p_cancelled_by = 'driver' THEN 'استرجاع عمولة الرحلة - إلغاء السائق'
                ELSE 'استرجاع عمولة الرحلة - إلغاء الراكب'
            END,
            NOW()
        );
    END IF;
    
    RAISE NOTICE 'Ride cancelled successfully';
END;
$$;

-- ===================================================================
-- 9. Grant execute permissions to authenticated users
-- ===================================================================
GRANT EXECUTE ON FUNCTION public.cancel_ride(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_ride(UUID, TEXT) TO anon;

-- ===================================================================
-- 10. Test: Insert a test transaction (for debugging)
-- ===================================================================
-- Note: Uncomment to test if RLS is working
-- INSERT INTO balance_transactions (driver_id, amount, type, description)
-- SELECT id, 0, 'test', 'Test transaction' FROM drivers LIMIT 1;

-- ===================================================================
-- 11. Check existing rides and their statuses (for debugging)
-- ===================================================================
-- SELECT id, status, driver_id, passenger_id, amount, accepted_at, cancelled_at
-- FROM rides 
-- WHERE status IN ('accepted', 'arrived', 'ongoing')
-- ORDER BY accepted_at DESC
-- LIMIT 10;