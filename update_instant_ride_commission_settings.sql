-- ============================================================================
-- SQL Migration Script: Surgical Fix for Instant Ride Commission & Penalty Rates (5%)
-- Preserves 100% exact live function logic, replacing 0.10 with 0.05
-- ============================================================================

-- 1. Update accept_immediate_ride (exact live logic, 0.10 -> 0.05)
CREATE OR REPLACE FUNCTION public.accept_immediate_ride(p_ride_id uuid, p_driver_id uuid)
 RETURNS json
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_amount DECIMAL;
    v_commission DECIMAL;
    v_driver_balance DECIMAL;
    v_status TEXT;
BEGIN
    -- أ. التحقق من حالة الرحلة وجلب المبلغ
    SELECT status, amount INTO v_status, v_amount
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_status IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'الرحلة غير موجودة');
    END IF;

    -- السماح بالقبول فقط إذا كانت الرحلة لم تقبل بعد
    IF v_status != 'searching' AND v_status != 'pending' AND v_status != 'awaiting_driver_acceptance' THEN
        RETURN json_build_object('success', false, 'message', 'عذراً، تم قبول هذه الرحلة بالفعل من قبل سائق آخر');
    END IF;

    -- ب. التحقق من رصيد السائق
    SELECT balance INTO v_driver_balance
    FROM public.drivers
    WHERE id = p_driver_id;

    IF v_driver_balance IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'بيانات السائق غير موجودة');
    END IF;

    -- ج. حساب عمولة 5% (تقريب لأسفل)
    v_commission := FLOOR(COALESCE(v_amount, 0) * 0.05);

    IF v_driver_balance < v_commission THEN
        RETURN json_build_object('success', false, 'message', 'رصيدك غير كافٍ لخصم عمولة الرحلة');
    END IF;

    -- د. التحديثات الذرية
    -- تحديث حالة الرحلة وتسجيل العمولة المحجوزة
    UPDATE public.rides
    SET status = 'accepted',
        driver_id = p_driver_id,
        driver_accepted = true,
        accepted_at = NOW(),
        commission_held = v_commission,
        commission_held_at = NOW(),
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- خصم العمولة من رصيد السائق
    UPDATE public.drivers
    SET balance = v_driver_balance - v_commission
    WHERE id = p_driver_id;

    -- تسجيل المعاملة المالية
    INSERT INTO public.balance_transactions (driver_id, ride_id, amount, type, description, created_at)
    VALUES (p_driver_id, p_ride_id, -v_commission, 'commission_held', 'تجميد عمولة الرحلة (سيتم خصمها نهائياً عند الإكمال)', NOW());

    RETURN json_build_object(
        'success', true,
        'message', 'تم قبول الرحلة بنجاح وخصم العمولة',
        'commission_deducted', v_commission,
        'new_balance', v_driver_balance - v_commission
    );
END;
$function$;

-- 2. Update complete_ride (exact live logic, 0.10 -> 0.05)
CREATE OR REPLACE FUNCTION public.complete_ride(p_ride_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_driver_id UUID;
    v_amount DECIMAL;
    v_commission_held DECIMAL;
    v_commission DECIMAL;
BEGIN
    -- جلب تفاصيل الرحلة والعمولة المحجوزة
    SELECT driver_id, amount, COALESCE(commission_held, 0) INTO v_driver_id, v_amount, v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'Ride not found or no driver assigned';
    END IF;

    -- تحديد قيمة العمولة النهائية (استخدام المحجوزة إن وجدت)
    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        v_commission := FLOOR(COALESCE(v_amount, 0) * 0.05);
    END IF;

    -- تحديث حالة الرحلة
    UPDATE public.rides
    SET status = 'completed',
        completed_at = NOW(),
        commission_amount = v_commission,
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- خصم العمولة فقط إذا لم تكن قد خصمت (حجزت) عند القبول
    IF v_commission_held <= 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_commission
        WHERE id = v_driver_id;

        INSERT INTO balance_transactions (driver_id, amount, type, ride_id, description, created_at)
        VALUES (v_driver_id, -v_commission, 'commission_deduction', p_ride_id, 'خصم عمولة الرحلة', NOW());
    ELSE
        -- إذا كانت محجوزة مسبقاً، نقوم فقط بتحديث وصف المعاملة لتصبح نهائية
        UPDATE public.balance_transactions
        SET type = 'commission_deduction',
            description = 'خصم عمولة الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id AND type = 'commission_held';
    END IF;
END;
$function$;

-- 3. Update handle_cancellation_penalty (exact live logic, 0.10 -> 0.05)
CREATE OR REPLACE FUNCTION public.handle_cancellation_penalty(p_ride_id uuid, p_driver_id uuid, p_amount numeric)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    v_commission DECIMAL;
    v_commission_held DECIMAL;
BEGIN
    -- جلب العمولة المحجوزة إن وجدت
    SELECT COALESCE(commission_held, 0) INTO v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    -- حساب الغرامة (تساوي العمولة)
    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        v_commission := FLOOR(COALESCE(p_amount, 0) * 0.05);
    END IF;

    -- تحديث حالة الرحلة للإلغاء بواسطة السائق
    UPDATE public.rides
    SET status = 'cancelled_by_driver',
        cancelled_at = NOW(),
        cancellation_reason = 'إلغاء السائق',
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- الخصم فقط إذا لم تكن محجوزة مسبقاً
    IF v_commission_held <= 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_commission
        WHERE id = p_driver_id;

        INSERT INTO balance_transactions (driver_id, ride_id, amount, type, description, created_at)
        VALUES (p_driver_id, p_ride_id, -v_commission, 'cancellation_penalty', 'خصم رسوم إلغاء الرحلة', NOW());
    ELSE
        -- تحديث المعاملة المحجوزة لتصبح غرامة إلغاء
        UPDATE balance_transactions
        SET type = 'cancellation_penalty',
            description = 'خصم رسوم إلغاء الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id AND type = 'commission_held';
    END IF;
END;
$function$;
