-- SQL function to complete a ride and deduct commission
CREATE OR REPLACE FUNCTION complete_ride(p_ride_id UUID)
RETURNS VOID AS $$
DECLARE
    v_driver_id UUID;
    v_amount DECIMAL;
    v_commission DECIMAL;
BEGIN
    -- 1. Get ride details
    SELECT driver_id, amount INTO v_driver_id, v_amount
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'Ride not found or no driver assigned';
    END IF;

    -- 2. Calculate commission (5% as per travel-platform.html)
    v_commission := COALESCE(v_amount, 0) * 0.05;

    -- 3. Update ride status and commission
    UPDATE public.rides
    SET status = 'completed',
        completed_at = NOW(),
        commission_amount = v_commission,
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- 4. Deduct commission from driver's balance in drivers table
    UPDATE public.drivers
    SET balance = COALESCE(balance, 0) - v_commission
    WHERE id = v_driver_id;

    -- 5. Record the transaction (optional but recommended if table exists)
    -- INSERT INTO balance_transactions (driver_id, amount, type, ride_id, created_at)
    -- VALUES (v_driver_id, -v_commission, 'commission_deduction', p_ride_id, NOW());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
