-- Update Commission and Penalty Rate Settings in system_settings to 5%
INSERT INTO system_settings (key, value)
VALUES
    ('service_fee_percentage', '5'),
    ('travel_commission_rate', '5')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- Re-create / update functions with 5% commission rate
CREATE OR REPLACE FUNCTION accept_immediate_ride(p_ride_id UUID, p_driver_id UUID)
RETURNS JSON AS $$
DECLARE
    v_amount DECIMAL;
    v_commission DECIMAL;
    v_driver_balance DECIMAL;
    v_status TEXT;
    v_service_fee_str TEXT;
    v_fee_rate DECIMAL := 0.05;
BEGIN
    -- Get setting rate if available
    SELECT value INTO v_service_fee_str FROM system_settings WHERE key = 'service_fee_percentage';
    IF v_service_fee_str IS NOT NULL AND v_service_fee_str != '' THEN
        v_fee_rate := (v_service_fee_str::DECIMAL) / 100.0;
    END IF;

    -- Check ride status and amount
    SELECT status, amount INTO v_status, v_amount
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_status IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'الرحلة غير موجودة');
    END IF;

    IF v_status != 'searching' AND v_status != 'pending' AND v_status != 'awaiting_driver_acceptance' THEN
        RETURN json_build_object('success', false, 'message', 'عذراً، تم قبول هذه الرحلة بالفعل من قبل سائق آخر');
    END IF;

    -- Check driver balance
    SELECT balance INTO v_driver_balance
    FROM public.drivers
    WHERE id = p_driver_id;

    IF v_driver_balance IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'بيانات السائق غير موجودة');
    END IF;

    -- Calculate 5% commission (or rate from settings)
    v_commission := FLOOR(COALESCE(v_amount, 0) * v_fee_rate);

    IF v_driver_balance < v_commission THEN
        RETURN json_build_object('success', false, 'message', 'رصيدك غير كافٍ لخصم عمولة الرحلة');
    END IF;

    -- Update ride status and set commission_held
    UPDATE public.rides
    SET status = 'accepted',
        driver_id = p_driver_id,
        driver_accepted = true,
        commission_held = v_commission,
        commission_held_at = NOW(),
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- Deduct balance
    UPDATE public.drivers
    SET balance = balance - v_commission
    WHERE id = p_driver_id;

    -- Record transaction
    INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
    VALUES (p_driver_id, p_ride_id, -v_commission, 'commission_held', 'تجميد عمولة الرحلة (سيتم خصمها نهائياً عند الإكمال)', NOW());

    RETURN json_build_object(
        'success', true,
        'message', 'تم قبول الرحلة بنجاح وخصم العمولة',
        'commission_held', v_commission
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION complete_ride(p_ride_id UUID)
RETURNS VOID AS $$
DECLARE
    v_driver_id UUID;
    v_amount DECIMAL;
    v_commission DECIMAL;
    v_commission_held DECIMAL;
    v_service_fee_str TEXT;
    v_fee_rate DECIMAL := 0.05;
BEGIN
    SELECT value INTO v_service_fee_str FROM system_settings WHERE key = 'service_fee_percentage';
    IF v_service_fee_str IS NOT NULL AND v_service_fee_str != '' THEN
        v_fee_rate := (v_service_fee_str::DECIMAL) / 100.0;
    END IF;

    SELECT driver_id, amount, COALESCE(commission_held, 0) INTO v_driver_id, v_amount, v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'Ride not found or no driver assigned';
    END IF;

    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        v_commission := FLOOR(COALESCE(v_amount, 0) * v_fee_rate);
    END IF;

    UPDATE public.rides
    SET status = 'completed',
        completed_at = NOW(),
        commission_amount = v_commission,
        updated_at = NOW()
    WHERE id = p_ride_id;

    IF v_commission_held = 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_commission
        WHERE id = v_driver_id;

        INSERT INTO balance_transactions (driver_id, amount, type, ride_id, description, created_at)
        VALUES (v_driver_id, -v_commission, 'commission_deduction', p_ride_id, 'خصم عمولة الرحلة', NOW());
    ELSE
        UPDATE balance_transactions
        SET type = 'commission_deduction',
            description = 'خصم عمولة الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id AND driver_id = v_driver_id AND type = 'commission_held';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION handle_cancellation_penalty(p_ride_id UUID, p_driver_id UUID, p_amount DECIMAL)
RETURNS VOID AS $$
DECLARE
    v_commission DECIMAL;
    v_commission_held DECIMAL;
    v_service_fee_str TEXT;
    v_fee_rate DECIMAL := 0.05;
BEGIN
    SELECT value INTO v_service_fee_str FROM system_settings WHERE key = 'service_fee_percentage';
    IF v_service_fee_str IS NOT NULL AND v_service_fee_str != '' THEN
        v_fee_rate := (v_service_fee_str::DECIMAL) / 100.0;
    END IF;

    SELECT COALESCE(commission_held, 0) INTO v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        v_commission := FLOOR(COALESCE(p_amount, 0) * v_fee_rate);
    END IF;

    UPDATE public.rides
    SET status = 'cancelled_by_driver',
        cancelled_at = NOW(),
        cancellation_reason = 'إلغاء السائق',
        updated_at = NOW()
    WHERE id = p_ride_id;

    IF v_commission_held = 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_commission
        WHERE id = p_driver_id;

        INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
        VALUES (p_driver_id, p_ride_id, -v_commission, 'cancellation_penalty', 'خصم رسوم إلغاء الرحلة', NOW());
    ELSE
        UPDATE balance_transactions
        SET type = 'cancellation_penalty',
            description = 'خصم رسوم إلغاء الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id AND driver_id = p_driver_id AND type = 'commission_held';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
