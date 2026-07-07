-- ============================================================================
-- ملف إصلاح خصم العمولة - يرجع النظام للحالة التي كانت تعمل بشكل صحيح
-- ============================================================================

-- ============================================================================
-- الخطوة 1: حذف قيد foreign key إذا كان موجوداً (يسبب مشاكل في التحديث)
-- ============================================================================
ALTER TABLE rides DROP CONSTRAINT IF EXISTS rides_driver_id_fkey;

-- ============================================================================
-- الخطوة 2: التأكد من وجود عمود driver_id في جدول rides (بدون قيد foreign key)
-- ============================================================================
ALTER TABLE rides ADD COLUMN IF NOT EXISTS driver_id UUID;


-- ============================================================================
-- الخطوة 3: إصلاح فهرس driver_id
-- ============================================================================
DROP INDEX IF EXISTS idx_rides_driver_id;
CREATE INDEX IF NOT EXISTS idx_rides_driver_id ON rides(driver_id);


-- ============================================================================
-- الخطوة 4: إصلاح جدول balance_transactions ليتوافق مع الكود الأصلي
-- ============================================================================

-- حذف الجدول إذا كان موجوداً بهيكل خاطئ
DROP TABLE IF EXISTS balance_transactions;

-- إنشاء الجدول بالهيكل الصحيح (استخدام UUID كـ primary key)
CREATE TABLE balance_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID,  -- لا نستخدم REFERENCES لتجنب مشاكل الـ foreign key
    ride_id UUID,   -- لا نستخدم REFERENCES لتجنب مشاكل الـ foreign key
    amount DECIMAL(10,2) NOT NULL,
    type VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- إنشاء الفهارس
CREATE INDEX IF NOT EXISTS idx_balance_transactions_driver_id ON balance_transactions(driver_id);
CREATE INDEX IF NOT EXISTS idx_balance_transactions_ride_id ON balance_transactions(ride_id);


-- ============================================================================
-- الخطوة 5: التأكد من وجود الأعمدة المطلوبة في جدول rides
-- ============================================================================
ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_held DECIMAL(10,2) DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_held_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_amount DECIMAL(10,2) DEFAULT 0;


-- ============================================================================
-- الخطوة 6: التأكد من وجود أعمدة الحظر في جدول drivers
-- ============================================================================
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ban_until TIMESTAMPTZ;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS balance NUMERIC DEFAULT 0;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS whatsapp_number TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS car_plate TEXT;


-- ============================================================================
-- الخطوة 7: إعادة إنشاء دالة complete_ride للعمل بشكل صحيح
-- ملاحظة: استخدام 10% كما في كود التطبيق (وليس 5%)
-- ============================================================================
CREATE OR REPLACE FUNCTION complete_ride(p_ride_id UUID)
RETURNS VOID AS $$
DECLARE
    v_driver_id UUID;
    v_amount DECIMAL;
    v_commission_held DECIMAL;
    v_commission DECIMAL;
BEGIN
    -- 1. Get ride details
    SELECT driver_id, amount, COALESCE(commission_held, 0) INTO v_driver_id, v_amount, v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'Ride not found or no driver assigned';
    END IF;

    -- 2. Calculate commission (10% as per app standard)
    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        v_commission := FLOOR(COALESCE(v_amount, 0) * 0.10);
    END IF;

    -- 3. Update ride status and commission
    UPDATE public.rides
    SET status = 'completed',
        completed_at = NOW(),
        commission_amount = v_commission,
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- 4. Deduct commission from driver's balance if not already held
    IF v_commission_held <= 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_commission
        WHERE id = v_driver_id;

        -- 5. Record the transaction
        INSERT INTO balance_transactions (driver_id, amount, type, ride_id, description, created_at)
        VALUES (v_driver_id, -v_commission, 'commission_deduction', p_ride_id, 'خصم عمولة الرحلة', NOW());
    ELSE
        -- If already held, update the transaction description to reflect completion
        UPDATE public.balance_transactions
        SET type = 'commission_deduction',
            description = 'خصم عمولة الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id AND type = 'commission_held';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- الخطوة 8: إنشاء دالة accept_immediate_ride لضمان ذرية العملية
-- ============================================================================
CREATE OR REPLACE FUNCTION accept_immediate_ride(p_ride_id UUID, p_driver_id UUID)
RETURNS JSON AS $$
DECLARE
    v_amount DECIMAL;
    v_commission DECIMAL;
    v_driver_balance DECIMAL;
    v_status TEXT;
BEGIN
    -- 1. Check ride status and get amount
    SELECT status, amount INTO v_status, v_amount
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_status IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'الرحلة غير موجودة');
    END IF;

    IF v_status != 'searching' AND v_status != 'pending' AND v_status != 'awaiting_driver_acceptance' THEN
        RETURN json_build_object('success', false, 'message', 'عذراً، تم قبول هذه الرحلة بالفعل من قبل سائق آخر');
    END IF;

    -- 2. Check driver balance
    SELECT balance INTO v_driver_balance
    FROM public.drivers
    WHERE id = p_driver_id;

    IF v_driver_balance IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'بيانات السائق غير موجودة');
    END IF;

    -- 3. Calculate 10% commission
    v_commission := FLOOR(COALESCE(v_amount, 0) * 0.10);

    IF v_driver_balance < v_commission THEN
        RETURN json_build_object('success', false, 'message', 'رصيدك غير كافٍ لخصم عمولة الرحلة');
    END IF;

    -- 4. Atomic Updates
    UPDATE public.rides
    SET status = 'accepted',
        driver_id = p_driver_id,
        driver_accepted = true,
        accepted_at = NOW(),
        commission_held = v_commission,
        commission_held_at = NOW(),
        updated_at = NOW()
    WHERE id = p_ride_id;

    UPDATE public.drivers
    SET balance = v_driver_balance - v_commission
    WHERE id = p_driver_id;

    INSERT INTO public.balance_transactions (driver_id, ride_id, amount, type, description, created_at)
    VALUES (p_driver_id, p_ride_id, -v_commission, 'commission_held', 'تجميد عمولة الرحلة (سيتم خصمها عند الإكمال أو الإلغاء)', NOW());

    RETURN json_build_object(
        'success', true,
        'message', 'تم قبول الرحلة بنجاح',
        'commission_deducted', v_commission,
        'new_balance', v_driver_balance - v_commission
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- الخطوة 9: إعادة إنشاء دالة handle_cancellation_penalty للتعامل مع إلغاء السائق
-- ============================================================================
CREATE OR REPLACE FUNCTION handle_cancellation_penalty(p_ride_id UUID, p_driver_id UUID, p_amount DECIMAL)
RETURNS VOID AS $$
DECLARE
    v_commission DECIMAL;
    v_commission_held DECIMAL;
BEGIN
    -- Get held commission
    SELECT COALESCE(commission_held, 0) INTO v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    -- Calculate commission (10% of ride amount) if not held
    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        v_commission := FLOOR(COALESCE(p_amount, 0) * 0.10);
    END IF;

    -- Update ride with cancellation info
    UPDATE public.rides
    SET status = 'cancelled_by_driver',
        cancelled_at = NOW(),
        cancellation_reason = 'إلغاء السائق',
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- Deduct the commission as penalty if not already held
    IF v_commission_held <= 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_commission
        WHERE id = p_driver_id;

        -- Record the cancellation penalty transaction
        INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
        VALUES (p_driver_id, p_ride_id, -v_commission, 'cancellation_penalty', 'خصم رسوم إلغاء الرحلة', NOW());
    ELSE
        -- Update transaction description if already held
        UPDATE balance_transactions
        SET type = 'cancellation_penalty',
            description = 'خصم رسوم إلغاء الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id AND type = 'commission_held';
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- ملاحظة: هذا الملف يجب تشغيله في Supabase SQL Editor
-- ============================================================================