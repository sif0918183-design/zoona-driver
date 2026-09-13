-- Add missing timestamp columns to the rides table
ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Add commission hold columns
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_held DECIMAL(10,2) DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_held_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Add ban columns to drivers table
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ban_until TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS cancel_report_count INT DEFAULT 0;

-- Create balance_transactions table if not exists
CREATE TABLE IF NOT EXISTS balance_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID,
    ride_id UUID,
    amount DECIMAL(10,2) NOT NULL,
    type VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency Unique Index for Travel Platform Financial Transactions
CREATE UNIQUE INDEX IF NOT EXISTS idx_balance_tx_travel_idempotency
ON balance_transactions (driver_id, ride_id, type)
WHERE ride_id IS NOT NULL;

-- Atomic Travel Platform Financial Transaction RPC Function
CREATE OR REPLACE FUNCTION process_travel_financial_transaction(
    p_action TEXT,
    p_ride_id UUID,
    p_driver_id UUID,
    p_trip_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ride_req RECORD;
    v_trip RECORD;
    v_driver RECORD;
    v_comm_rate NUMERIC := 5.0;
    v_setting_val TEXT;
    v_commission_amount NUMERIC := 0;
    v_penalty_amount NUMERIC := 0;
    v_already_tx RECORD;
    v_grace_until TIMESTAMPTZ;
BEGIN
    -- 1. Lock Row 1: ride_requests
    SELECT * INTO v_ride_req
    FROM ride_requests
    WHERE id = p_ride_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'طلب الرحلة غير موجود');
    END IF;

    -- 2. Lock Row 2: travel_trips (if present or lookup by ride_request_id)
    IF p_trip_id IS NOT NULL THEN
        SELECT * INTO v_trip
        FROM travel_trips
        WHERE id = p_trip_id
        FOR UPDATE;
    ELSE
        SELECT * INTO v_trip
        FROM travel_trips
        WHERE ride_request_id = p_ride_id
        FOR UPDATE;
    END IF;

    -- 3. Lock Row 3: drivers
    SELECT * INTO v_driver
    FROM drivers
    WHERE id = p_driver_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('success', false, 'error', 'السائق غير موجود');
    END IF;

    -- Retrieve travel commission rate from system_settings if exists
    SELECT value INTO v_setting_val FROM system_settings WHERE key = 'travel_commission_rate';
    IF v_setting_val IS NOT NULL THEN
        v_comm_rate := COALESCE(v_setting_val::NUMERIC, 5.0);
    END IF;

    -- Calculate DB-sourced amounts safely
    IF v_trip.id IS NOT NULL AND v_trip.commission_amount IS NOT NULL AND v_trip.commission_amount > 0 THEN
        v_commission_amount := v_trip.commission_amount;
    ELSE
        v_commission_amount := ROUND(COALESCE(v_ride_req.estimated_price, 0) * v_comm_rate / 100.0);
    END IF;

    ---------------------------------------------------------------------------
    -- ACTION: HOLD_COMMISSION
    ---------------------------------------------------------------------------
    IF p_action = 'HOLD_COMMISSION' THEN
        -- Verify driver assignment guard
        IF COALESCE(v_ride_req.driver_id, CASE WHEN v_trip.id IS NOT NULL THEN v_trip.driver_id ELSE NULL END) <> p_driver_id THEN
            RETURN jsonb_build_object('success', false, 'error', 'السائق لم يعد مخصصاً لهذه الرحلة');
        END IF;

        -- Verify trip status guard
        IF v_ride_req.status = 'cancelled' OR (v_trip.id IS NOT NULL AND v_trip.status = 'cancelled') THEN
            RETURN jsonb_build_object('success', false, 'error', 'الرحلة ملغاة مسبقاً');
        END IF;

        -- Idempotency Check
        IF v_ride_req.commission_status = 'held' OR (v_trip.id IS NOT NULL AND v_trip.commission_status = 'held') THEN
            RETURN jsonb_build_object('success', true, 'idempotent', true, 'result', 'commission_held', 'contactsRevealed', true);
        END IF;

        SELECT id INTO v_already_tx
        FROM balance_transactions
        WHERE driver_id = p_driver_id AND ride_id = p_ride_id AND type = 'commission_hold';

        IF v_already_tx IS NOT NULL THEN
            UPDATE ride_requests SET commission_status = 'held', contact_revealed = true, commission_grace_until = NULL WHERE id = p_ride_id;
            IF v_trip.id IS NOT NULL THEN
                UPDATE travel_trips SET commission_status = 'held', contact_revealed = true, commission_grace_until = NULL WHERE id = v_trip.id;
            END IF;
            RETURN jsonb_build_object('success', true, 'idempotent', true, 'result', 'commission_held', 'contactsRevealed', true);
        END IF;

        -- Sufficient Balance Check
        IF v_driver.balance >= v_commission_amount THEN
            -- Deduct balance
            UPDATE drivers SET balance = balance - v_commission_amount WHERE id = p_driver_id;

            -- Log transaction
            INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
            VALUES (p_driver_id, p_ride_id, -v_commission_amount, 'commission_hold', 'حجز عمولة منصة السفر للرحلة رقم ' || p_ride_id::text, NOW());

            -- Update states
            UPDATE ride_requests SET commission_status = 'held', contact_revealed = true, commission_grace_until = NULL WHERE id = p_ride_id;
            IF v_trip.id IS NOT NULL THEN
                UPDATE travel_trips SET commission_status = 'held', contact_revealed = true, commission_grace_until = NULL WHERE id = v_trip.id;
            END IF;

            RETURN jsonb_build_object('success', true, 'result', 'commission_held', 'contactsRevealed', true, 'amount', v_commission_amount);
        ELSE
            -- Insufficient balance -> Start/maintain Grace Period (Do NOT reset if driver already assigned and grace running)
            IF v_ride_req.driver_id = p_driver_id AND v_ride_req.commission_status = 'grace_period' AND v_ride_req.commission_grace_until IS NOT NULL THEN
                v_grace_until := v_ride_req.commission_grace_until;
            ELSE
                v_grace_until := NOW() + INTERVAL '30 minutes';
            END IF;

            UPDATE ride_requests SET commission_status = 'grace_period', commission_grace_until = v_grace_until, contact_revealed = false WHERE id = p_ride_id;
            IF v_trip.id IS NOT NULL THEN
                UPDATE travel_trips SET commission_status = 'grace_period', commission_grace_until = v_grace_until, contact_revealed = false WHERE id = v_trip.id;
            END IF;

            RETURN jsonb_build_object('success', true, 'result', 'grace_period_started', 'graceUntil', v_grace_until, 'contactsRevealed', false);
        END IF;

    ---------------------------------------------------------------------------
    -- ACTION: REFUND_COMMISSION
    ---------------------------------------------------------------------------
    ELSIF p_action = 'REFUND_COMMISSION' THEN
        -- Check if refund transaction already logged
        SELECT id INTO v_already_tx
        FROM balance_transactions
        WHERE driver_id = p_driver_id AND ride_id = p_ride_id AND type = 'commission_refund';

        IF v_already_tx IS NOT NULL OR v_ride_req.commission_status = 'refunded' THEN
            RETURN jsonb_build_object('success', true, 'idempotent', true, 'result', 'already_refunded');
        END IF;

        -- Only refund if commission was actually held
        IF v_ride_req.commission_status = 'held' OR (v_trip.id IS NOT NULL AND v_trip.commission_status = 'held') THEN
            UPDATE drivers SET balance = balance + v_commission_amount WHERE id = p_driver_id;

            INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
            VALUES (p_driver_id, p_ride_id, v_commission_amount, 'commission_refund', 'إرجاع عمولة منصة السفر بسبب إلغاء الراكب للرحلة رقم ' || p_ride_id::text, NOW());

            UPDATE ride_requests SET commission_status = 'refunded' WHERE id = p_ride_id;
            IF v_trip.id IS NOT NULL THEN
                UPDATE travel_trips SET commission_status = 'refunded' WHERE id = v_trip.id;
            END IF;

            RETURN jsonb_build_object('success', true, 'result', 'commission_refunded', 'amount', v_commission_amount);
        ELSE
            RETURN jsonb_build_object('success', true, 'result', 'no_hold_to_refund');
        END IF;

    ---------------------------------------------------------------------------
    -- ACTION: CHARGE_PENALTY
    ---------------------------------------------------------------------------
    ELSIF p_action = 'CHARGE_PENALTY' THEN
        v_penalty_amount := v_commission_amount;

        -- Check if penalty already charged
        SELECT id INTO v_already_tx
        FROM balance_transactions
        WHERE driver_id = p_driver_id AND ride_id = p_ride_id AND type = 'cancellation_penalty';

        IF v_already_tx IS NOT NULL THEN
            RETURN jsonb_build_object('success', true, 'idempotent', true, 'result', 'already_penalized');
        END IF;

        IF v_ride_req.commission_status = 'held' OR (v_trip.id IS NOT NULL AND v_trip.commission_status = 'held') THEN
            -- Treat held commission as forfeited penalty (no additional deduction)
            UPDATE ride_requests SET commission_status = 'forfeited' WHERE id = p_ride_id;
            IF v_trip.id IS NOT NULL THEN
                UPDATE travel_trips SET commission_status = 'forfeited' WHERE id = v_trip.id;
            END IF;
            RETURN jsonb_build_object('success', true, 'result', 'commission_forfeited', 'amount', v_penalty_amount);
        ELSE
            -- Deduct penalty now
            UPDATE drivers SET balance = balance - v_penalty_amount WHERE id = p_driver_id;

            INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
            VALUES (p_driver_id, p_ride_id, -v_penalty_amount, 'cancellation_penalty', 'خصم غرامة إلغاء رحلة سفر رقم ' || p_ride_id::text, NOW());

            UPDATE ride_requests SET commission_status = 'forfeited' WHERE id = p_ride_id;
            IF v_trip.id IS NOT NULL THEN
                UPDATE travel_trips SET commission_status = 'forfeited' WHERE id = v_trip.id;
            END IF;

            RETURN jsonb_build_object('success', true, 'result', 'penalty_charged', 'amount', v_penalty_amount);
        END IF;

    ELSE
        RETURN jsonb_build_object('success', false, 'error', 'عملية غير معروفة');
    END IF;
END;
$$;

-- Security Settings on RPC Function
REVOKE EXECUTE ON FUNCTION process_travel_financial_transaction(TEXT, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION process_travel_financial_transaction(TEXT, UUID, UUID, UUID) TO service_role;
