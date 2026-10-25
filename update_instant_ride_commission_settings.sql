-- ============================================================================
-- نظام تراكا - ربط عمولة ورسوم خدمة الرحلات الداخلية بإعدادات المنصة
-- Migration: update_instant_ride_commission_settings.sql
-- ============================================================================

-- 1. تحديث دالة قبول الرحلة الفورية لقراءة نسبة العمولة ديناميكياً من system_settings
CREATE OR REPLACE FUNCTION accept_immediate_ride(p_ride_id UUID, p_driver_id UUID)
RETURNS JSON AS $$
DECLARE
    v_amount DECIMAL;
    v_commission DECIMAL;
    v_driver_balance DECIMAL;
    v_status TEXT;
    v_setting_val TEXT;
    v_comm_rate NUMERIC := 10.0; -- القيمة الافتراضية للعمولة 10%
BEGIN
    -- أ. جلب نسبة عمولة الخدمة للرحلات الداخلية من system_settings
    SELECT value INTO v_setting_val FROM system_settings WHERE key = 'service_fee_percentage';
    IF v_setting_val IS NOT NULL THEN
        BEGIN
            v_comm_rate := v_setting_val::NUMERIC;
        EXCEPTION WHEN OTHERS THEN
            v_comm_rate := 10.0;
        END;
    END IF;

    -- ب. التحقق من حالة الرحلة وجلب المبلغ
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

    -- ج. التحقق من رصيد السائق
    SELECT balance INTO v_driver_balance
    FROM public.drivers
    WHERE id = p_driver_id;

    IF v_driver_balance IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'بيانات السائق غير موجودة');
    END IF;

    -- د. حساب عمولة الخدمة بناءً على الإعداد المحفوظ في قاعدة البيانات
    v_commission := FLOOR(COALESCE(v_amount, 0) * (v_comm_rate / 100.0));

    IF v_driver_balance < v_commission THEN
        RETURN json_build_object('success', false, 'message', 'رصيدك غير كافٍ لخصم عمولة الرحلة');
    END IF;

    -- هـ. التحديثات الذرية
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


-- 2. تحديث دالة إكمال الرحلة للتعامل مع العمولة المحجوزة مسبقاً وقراءة الإعداد في حال المسار الاحتياطي
CREATE OR REPLACE FUNCTION complete_ride(p_ride_id UUID)
RETURNS VOID AS $$
DECLARE
    v_driver_id UUID;
    v_amount DECIMAL;
    v_commission_held DECIMAL;
    v_commission DECIMAL;
    v_setting_val TEXT;
    v_comm_rate NUMERIC := 10.0;
BEGIN
    -- جلب تفاصيل الرحلة والعمولة المحجوزة
    SELECT driver_id, amount, COALESCE(commission_held, 0) INTO v_driver_id, v_amount, v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'Ride not found or no driver assigned';
    END IF;

    -- تحديد قيمة العمولة النهائية (استخدام المحجوزة مسبقاً دائماً إن وجدت لمنع إعادة الحساب)
    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        SELECT value INTO v_setting_val FROM system_settings WHERE key = 'service_fee_percentage';
        IF v_setting_val IS NOT NULL THEN
            BEGIN
                v_comm_rate := v_setting_val::NUMERIC;
            EXCEPTION WHEN OTHERS THEN
                v_comm_rate := 10.0;
            END;
        END IF;
        v_commission := FLOOR(COALESCE(v_amount, 0) * (v_comm_rate / 100.0));
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


-- 3. تحديث دالة غرامة إلغاء السائق للتعامل مع العمولة المحجوزة مسبقاً وقراءة الإعداد
CREATE OR REPLACE FUNCTION handle_cancellation_penalty(p_ride_id UUID, p_driver_id UUID, p_amount DECIMAL)
RETURNS VOID AS $$
DECLARE
    v_commission DECIMAL;
    v_commission_held DECIMAL;
    v_setting_val TEXT;
    v_comm_rate NUMERIC := 10.0;
BEGIN
    -- جلب العمولة المحجوزة إن وجدت
    SELECT COALESCE(commission_held, 0) INTO v_commission_held
    FROM public.rides
    WHERE id = p_ride_id;

    -- استخدام العمولة المحجوزة كغرامة إن وجدت، أو حساب الغرامة بناءً على نسبة الإعداد
    IF v_commission_held > 0 THEN
        v_commission := v_commission_held;
    ELSE
        SELECT value INTO v_setting_val FROM system_settings WHERE key = 'service_fee_percentage';
        IF v_setting_val IS NOT NULL THEN
            BEGIN
                v_comm_rate := v_setting_val::NUMERIC;
            EXCEPTION WHEN OTHERS THEN
                v_comm_rate := 10.0;
            END;
        END IF;
        v_commission := FLOOR(COALESCE(p_amount, 0) * (v_comm_rate / 100.0));
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


-- 4. تحديث دالة إلغاء الرحلة المباشرة لقراءة نسبة الإعداد وحساب مبلغ الاسترداد
CREATE OR REPLACE FUNCTION public.cancel_ride(p_ride_id UUID, p_cancelled_by TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_ride RECORD;
    v_driver RECORD;
    v_commission_amount DECIMAL(10,2);
    v_setting_val TEXT;
    v_comm_rate NUMERIC := 10.0;
BEGIN
    -- جلب تفاصيل الرحلة
    SELECT * INTO v_ride FROM rides WHERE id = p_ride_id;

    IF v_ride IS NULL THEN
        RAISE EXCEPTION 'Ride not found';
    END IF;

    -- التأكد من أن الرحلة نشطة
    IF v_ride.status NOT IN ('accepted', 'arrived', 'ongoing') THEN
        RAISE EXCEPTION 'Ride is not active';
    END IF;

    -- استخدام العمولة المحجوزة مسبقاً إن وجدت، أو استعلام الإعداد لحساب الاسترداد
    IF COALESCE(v_ride.commission_held, 0) > 0 THEN
        v_commission_amount := v_ride.commission_held;
    ELSE
        SELECT value INTO v_setting_val FROM system_settings WHERE key = 'service_fee_percentage';
        IF v_setting_val IS NOT NULL THEN
            BEGIN
                v_comm_rate := v_setting_val::NUMERIC;
            EXCEPTION WHEN OTHERS THEN
                v_comm_rate := 10.0;
            END;
        END IF;
        v_commission_amount := FLOOR(COALESCE(v_ride.amount, 0) * (v_comm_rate / 100.0));
    END IF;

    -- تحديث حالة الرحلة
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

    -- جلب تفاصيل السائق
    SELECT * INTO v_driver FROM drivers WHERE id = v_ride.driver_id;

    IF v_driver IS NOT NULL AND v_commission_amount > 0 THEN
        -- استرجاع العمولة لرصيد السائق
        UPDATE drivers
        SET balance = COALESCE(balance, 0) + v_commission_amount
        WHERE id = v_ride.driver_id;

        -- تسجيل المعاملة المالية
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

GRANT EXECUTE ON FUNCTION public.cancel_ride(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_ride(UUID, TEXT) TO anon;
