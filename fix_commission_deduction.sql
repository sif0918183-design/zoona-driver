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
    v_commission DECIMAL;
BEGIN
    -- 1. Get ride details
    SELECT driver_id, amount INTO v_driver_id, v_amount
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'Ride not found or no driver assigned';
    END IF;

    -- 2. Calculate commission (10% as per the app code)
    v_commission := COALESCE(v_amount, 0) * 0.10;

    -- 3. Update ride status and commission
    UPDATE public.rides
    SET status = 'completed',
        completed_at = NOW(),
        commission_amount = v_commission,
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- 4. Deduct commission from driver's balance in drivers table
    -- استخدام COALESCE للتعامل مع الـ NULL
    UPDATE public.drivers
    SET balance = COALESCE(balance, 0) - v_commission
    WHERE id = v_driver_id;

    -- 5. Record the transaction (مهم للتتبع الصحيح)
    INSERT INTO balance_transactions (driver_id, amount, type, ride_id, created_at)
    VALUES (v_driver_id, -v_commission, 'commission_deduction', p_ride_id, NOW());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- الخطوة 8: إعادة إنشاء دالة handle_cancellation_penalty للتعامل مع إلغاء السائق
-- ============================================================================
CREATE OR REPLACE FUNCTION handle_cancellation_penalty(p_ride_id UUID, p_driver_id UUID, p_amount DECIMAL)
RETURNS VOID AS $$
DECLARE
    v_commission DECIMAL;
BEGIN
    -- Calculate commission (10% of ride amount)
    v_commission := COALESCE(p_amount, 0) * 0.10;

    -- Update ride with cancellation info
    UPDATE public.rides
    SET status = 'cancelled_by_driver',
        cancelled_at = NOW(),
        cancellation_reason = 'إلغاء السائق',
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- Deduct the commission as penalty from driver's balance
    UPDATE public.drivers
    SET balance = COALESCE(balance, 0) - v_commission
    WHERE id = p_driver_id;

    -- Record the cancellation penalty transaction
    INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
    VALUES (p_driver_id, p_ride_id, -v_commission, 'cancellation_penalty', 'خصم رسوم إلغاء الرحلة', NOW());
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;


-- ============================================================================
-- ملاحظة: هذا الملف يجب تشغيله في Supabase SQL Editor
-- ============================================================================