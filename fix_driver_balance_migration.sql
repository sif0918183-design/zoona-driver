-- ============================================================================
-- نظام تراكا - إصلاح منطق خصم واسترجاع عمولة السائق
-- يقوم هذا الملف بتحديث قاعدة البيانات لضمان خصم العمولة عند قبول الرحلة
-- وتجنب أخطاء زيادة الرصيد عند الإلغاء.
-- ============================================================================

-- 1. إضافة الأعمدة اللازمة لتتبع العمولة المحجوزة في جدول الرحلات
ALTER TABLE public.rides ADD COLUMN IF NOT EXISTS commission_held DECIMAL(10,2) DEFAULT 0;
ALTER TABLE public.rides ADD COLUMN IF NOT EXISTS commission_held_at TIMESTAMPTZ;

-- 2. دالة قبول الرحلة الفورية بشكل ذري (Atomic)
-- تضمن هذه الدالة تغيير حالة الرحلة وخصم العمولة في عملية واحدة آمنة
CREATE OR REPLACE FUNCTION accept_immediate_ride(p_ride_id UUID, p_driver_id UUID)
RETURNS JSON AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 3. تحديث دالة إكمال الرحلة للتعامل مع العمولة المحجوزة مسبقاً
-- تمنع هذه الدالة الخصم المزدوج (Double Deduction)
CREATE OR REPLACE FUNCTION complete_ride(p_ride_id UUID)
RETURNS VOID AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. تحديث دالة غرامة إلغاء السائق للتعامل مع العمولة المحجوزة
CREATE OR REPLACE FUNCTION handle_cancellation_penalty(p_ride_id UUID, p_driver_id UUID, p_amount DECIMAL)
RETURNS VOID AS $$
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
$$ LANGUAGE plpgsql SECURITY DEFINER;
