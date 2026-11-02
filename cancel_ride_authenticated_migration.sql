-- ==============================================================================
-- Migration: Hardened & Accounting-Safe cancel_ride Function
-- Purpose: Protect passenger cancellation flow, enforce strict ledger audits,
-- prevent duplicate/fraudulent refunds, and verify ownership safely.
-- Note: Do NOT execute on live production database automatically.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.cancel_ride(
    p_ride_id UUID,
    p_cancelled_by TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ride RECORD;
    v_driver RECORD;

    v_total_held DECIMAL(10,2) := 0;
    v_total_refunded DECIMAL(10,2) := 0;
    v_net_unrefunded DECIMAL(10,2) := 0;

    v_settled_count INT := 0;
    v_corrupt_count INT := 0;
    v_held_count INT := 0;
    v_orphan_tx_count INT := 0;
    v_foreign_tx_count INT := 0;

    v_refund_amount DECIMAL(10,2) := 0;
    v_cancelled_by_clean TEXT;

    v_current_role TEXT := COALESCE(
        current_setting('request.jwt.claim.role', true),
        current_setting('role', true)
    );

    v_caller_id UUID := auth.uid();
    v_ride_comm_held DECIMAL(10,2) := 0;

BEGIN
    -- 1. التحقق من الدور المصرح به
    IF v_current_role IS NULL
       OR v_current_role NOT IN ('authenticated', 'service_role') THEN
        RAISE EXCEPTION 'غير مصرح باستدعاء الدالة';
    END IF;

    -- 2. حصر الدالة في إلغاء الراكب
    IF p_cancelled_by IS NULL OR TRIM(p_cancelled_by) = '' THEN
        RAISE EXCEPTION 'جهة الإلغاء مطلوبة';
    END IF;

    v_cancelled_by_clean := LOWER(TRIM(p_cancelled_by));

    IF v_cancelled_by_clean = 'driver' THEN
        RAISE EXCEPTION
        'إلغاء السائق محصور في handle_cancellation_penalty';
    ELSIF v_cancelled_by_clean NOT IN ('customer', 'passenger') THEN
        RAISE EXCEPTION 'جهة الإلغاء غير صالحة';
    END IF;

    -- 3. قفل الرحلة FOR UPDATE لمنع التضارب
    SELECT *
    INTO v_ride
    FROM public.rides
    WHERE id = p_ride_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'الرحلة غير موجودة: %', p_ride_id;
    END IF;

    -- 4. منع إعادة معالجة الرحلات النهائية
    IF v_ride.status IN (
        'completed',
        'cancelled_by_driver',
        'cancelled_by_customer',
        'cancelled'
    ) THEN
        RETURN;
    END IF;

    IF v_ride.status NOT IN ('accepted', 'arrived', 'ongoing', 'searching') THEN
        RETURN;
    END IF;

    -- 5. التحقق من ملكية الرحلة للمستخدم الموثق
    IF v_current_role = 'authenticated' THEN

        IF v_caller_id IS NULL THEN
            RAISE EXCEPTION 'هوية المستدعي غير صالحة';
        END IF;

        IF v_ride.passenger_id IS NULL THEN
            RAISE EXCEPTION 'بيانات مالك الرحلة مفقودة';
        END IF;

        IF v_ride.passenger_id <> v_caller_id THEN
            RAISE EXCEPTION 'لا يمكنك إلغاء رحلة راكب آخر';
        END IF;

    END IF;

    v_ride_comm_held := COALESCE(v_ride.commission_held, 0);

    -- 6. رفض العمولة السالبة
    IF v_ride_comm_held < 0 THEN
        RAISE EXCEPTION
        'قيمة العمولة المحجوزة سالبة: %',
        v_ride_comm_held;
    END IF;

    -- 7. كشف المعاملات المالية اليتيمة
    SELECT COUNT(*)
    INTO v_orphan_tx_count
    FROM public.balance_transactions
    WHERE ride_id = p_ride_id
      AND type IN (
          'commission_held',
          'cancellation_refund',
          'commission_deduction',
          'cancellation_penalty'
      );

    IF v_orphan_tx_count > 0 AND v_ride.driver_id IS NULL THEN
        RAISE EXCEPTION
        'توجد معاملات مالية دون سائق مرتبط بالرحلة';
    END IF;

    IF v_ride_comm_held > 0 AND v_ride.driver_id IS NULL THEN
        RAISE EXCEPTION
        'توجد عمولة محجوزة دون سائق مرتبط بالرحلة';
    END IF;

    -- 8. التدقيق المحاسبي الصارم عند وجود سائق مرتبط
    IF v_ride.driver_id IS NOT NULL THEN

        SELECT COUNT(*)
        INTO v_foreign_tx_count
        FROM public.balance_transactions
        WHERE ride_id = p_ride_id
          AND type IN (
              'commission_held',
              'cancellation_refund',
              'commission_deduction',
              'cancellation_penalty'
          )
          AND (
              driver_id IS NULL
              OR driver_id <> v_ride.driver_id
          );

        IF v_foreign_tx_count > 0 THEN
            RAISE EXCEPTION
            'توجد معاملات مالية منسوبة لسائق آخر أو دون معرف سائق';
        END IF;

        -- منع الاسترداد بعد التسوية النهائية
        SELECT COUNT(*)
        INTO v_settled_count
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND type IN (
              'commission_deduction',
              'cancellation_penalty'
          );

        IF v_settled_count > 0 THEN
            RAISE EXCEPTION
            'الرحلة مسواة مالياً ولا يمكن استرداد عمولتها';
        END IF;

        -- إجمالي الحجز الفعلي المثبت
        SELECT
            COUNT(*),
            COALESCE(SUM(-amount), 0)
        INTO
            v_held_count,
            v_total_held
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND type = 'commission_held'
          AND amount < 0;

        -- كشف الإشارات المالية غير الصحيحة
        SELECT COUNT(*)
        INTO v_corrupt_count
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND (
              (type = 'commission_held' AND amount >= 0)
              OR
              (type = 'cancellation_refund' AND amount <= 0)
          );

        IF v_corrupt_count > 0 THEN
            RAISE EXCEPTION
            'تم اكتشاف معاملات مالية ذات إشارات غير صحيحة';
        END IF;

        -- مطابقة مبلغ الحجز مع دفتر الأستاذ
        IF v_ride_comm_held > 0 OR v_total_held > 0 THEN

            IF v_ride_comm_held <> v_total_held THEN
                RAISE EXCEPTION
                'عدم تطابق العمولة المسجلة بالرحلة مع الحجز الفعلي: الرحلة %, الدفتر %',
                v_ride_comm_held,
                v_total_held;
            END IF;

        END IF;

        -- إجمالي الاستردادات السابقة
        SELECT COALESCE(SUM(amount), 0)
        INTO v_total_refunded
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND type = 'cancellation_refund'
          AND amount > 0;

        IF v_total_refunded > v_total_held THEN
            RAISE EXCEPTION
            'الاستردادات السابقة تتجاوز قيمة الحجز الفعلي';
        END IF;

        -- صافي المبلغ المتبقي للاسترداد
        v_net_unrefunded := v_total_held - v_total_refunded;

        IF v_total_held > 0 AND v_net_unrefunded > 0 THEN

            v_refund_amount := v_net_unrefunded;

            -- قفل صف السائق FOR UPDATE
            SELECT *
            INTO v_driver
            FROM public.drivers
            WHERE id = v_ride.driver_id
            FOR UPDATE;

            IF NOT FOUND THEN
                RAISE EXCEPTION
                'السائق المرتبط بالرحلة غير موجود';
            END IF;

            -- استرداد المبلغ المثبت خصمه فقط دون أي زيادة
            UPDATE public.drivers
            SET balance = COALESCE(balance, 0) + v_refund_amount
            WHERE id = v_ride.driver_id;

            -- تسجيل الاسترداد في دفتر الأستاذ
            INSERT INTO public.balance_transactions (
                driver_id,
                ride_id,
                amount,
                type,
                description,
                created_at
            )
            VALUES (
                v_ride.driver_id,
                p_ride_id,
                v_refund_amount,
                'cancellation_refund',
                'استرجاع عمولة الرحلة - إلغاء الراكب',
                NOW()
            );

        END IF;

    END IF;

    -- 9. تحديث حالة الرحلة بعد نجاح المعالجة المالية
    UPDATE public.rides
    SET
        status = 'cancelled_by_customer',
        cancelled_at = NOW(),
        cancellation_reason = 'إلغاء الراكب',
        commission_held = 0,
        updated_at = NOW()
    WHERE id = p_ride_id;

END;
$$;

-- سحب الصلاحيات من العموم وتخصيصها للأدوار المصرح بها
REVOKE EXECUTE
ON FUNCTION public.cancel_ride(UUID, TEXT)
FROM PUBLIC, anon;

GRANT EXECUTE
ON FUNCTION public.cancel_ride(UUID, TEXT)
TO authenticated, service_role;
