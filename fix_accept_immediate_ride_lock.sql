-- ============================================================================
-- تراكا - تحديث دالة قبول الرحلة الفورية بـ Row-Level Lock لحماية التزامن المزدوج
-- ============================================================================

CREATE OR REPLACE FUNCTION accept_immediate_ride(p_ride_id UUID, p_driver_id UUID)
RETURNS JSON AS $$
DECLARE
    v_amount DECIMAL;
    v_commission DECIMAL;
    v_driver_balance DECIMAL;
    v_status TEXT;
BEGIN
    -- أ. التحقق من حالة الرحلة وجلب المبلغ وقفل السطر في جدول الرحلات
    SELECT status, amount INTO v_status, v_amount
    FROM public.rides
    WHERE id = p_ride_id
    FOR UPDATE;

    IF v_status IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'الرحلة غير موجودة');
    END IF;

    -- السماح بالقبول فقط إذا كانت الرحلة لم تقبل بعد
    IF v_status != 'searching' AND v_status != 'pending' AND v_status != 'awaiting_driver_acceptance' THEN
        RETURN json_build_object('success', false, 'message', 'عذراً، تم قبول هذه الرحلة بالفعل من قبل سائق آخر');
    END IF;

    -- ب. التحقق من رصيد السائق مع تفعيل قفل السطر (Row-Level Lock) للتعامل التزامني الآمن
    SELECT balance INTO v_driver_balance
    FROM public.drivers
    WHERE id = p_driver_id
    FOR UPDATE;

    IF v_driver_balance IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'بيانات السائق غير موجودة');
    END IF;

    -- ج. حساب عمولة 10% (تقريب لأسفل)
    v_commission := FLOOR(COALESCE(v_amount, 0) * 0.10);

    IF v_driver_balance < v_commission THEN
        RETURN json_build_object('success', false, 'message', 'رصيدك غير كافٍ لخصم عمولة الرحلة');
    END IF;

    -- د. التحديثات الذرية
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
    VALUES (p_driver_id, p_ride_id, -v_commission, 'commission_held', 'تجميد عمولة الرحلة (سيتم خصمها نهائياً عند الإكمال)', NOW());

    RETURN json_build_object(
        'success', true,
        'message', 'تم قبول الرحلة بنجاح وخصم العمولة',
        'commission_deducted', v_commission,
        'new_balance', v_driver_balance - v_commission
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
