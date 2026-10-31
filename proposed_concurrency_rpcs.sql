-- ============================================================================
-- تراكا للنقل - حزمة التحديث المقترحة المحمية لدوال العمولات والإلغاء والتزامن
-- (النسخة النهائية المعتمدة - التعديل الجراحي المحدود والآمن مالياً بنسبة 5%)
-- ============================================================================

-- 1. دالة complete_ride المعدلة والمحميّة
CREATE OR REPLACE FUNCTION public.complete_ride(p_ride_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ride RECORD;
    v_driver RECORD;
    v_commission DECIMAL(10,2) := 0;
    v_current_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), current_setting('role', true));
    v_caller_id UUID := auth.uid();
    v_held_count INT := 0;
    v_held_sum DECIMAL(10,2) := 0;
    v_driver_corrupt_count INT := 0;
    v_orphan_held_count INT := 0;
    v_ride_comm_held DECIMAL(10,2) := 0;
BEGIN
    -- التحقق من الدور المصرح به
    IF v_current_role IS NULL OR v_current_role NOT IN ('authenticated', 'service_role') THEN
        RAISE EXCEPTION 'غير مصرح: يجب استدعاء الدالة بواسطة دور موثق (authenticated) أو خدمة خلفية (service_role)';
    END IF;

    -- قفل صف الرحلة فوراً لتسلسل الطلبات المتزامنة (FOR UPDATE)
    SELECT * INTO v_ride
    FROM public.rides
    WHERE id = p_ride_id
    FOR UPDATE;

    IF v_ride IS NULL THEN
        RAISE EXCEPTION 'الرحلة غير موجودة برقم: %', p_ride_id;
    END IF;

    -- التحقق من سلامة حالة الرحلة (حظر الرحلات الملغاة أو المسواة مسبقاً)
    IF v_ride.status IN ('completed', 'cancelled_by_driver', 'cancelled_by_customer', 'cancelled') THEN
        RAISE NOTICE 'الرحلة غير قابلة للإكمال لأن حالتها الحالية هي: %', v_ride.status;
        RETURN;
    END IF;

    IF v_ride.status NOT IN ('accepted', 'arrived', 'ongoing') THEN
        RAISE EXCEPTION 'لا يمكن إكمال رحلة بحالة غير نشطة: %', v_ride.status;
    END IF;

    IF v_ride.driver_id IS NULL THEN
        RAISE EXCEPTION 'الرحلة تفتقر لبيانات السائق المعين ولا يمكن إكمالها';
    END IF;

    -- التحقق الأمني من ملكية السائق عند الاستدعاء بواسطة authenticated
    IF v_current_role = 'authenticated' THEN
        IF v_caller_id IS NULL THEN
            RAISE EXCEPTION 'غير مصرح: يتعذر الحصول على هوية المستدعي الموثق';
        END IF;
        IF v_ride.driver_id <> v_caller_id THEN
            RAISE EXCEPTION 'غير مصرح لك بإكمال رحلة سائق آخر';
        END IF;
    END IF;

    -- قفل صف السائق بـ FOR UPDATE
    SELECT * INTO v_driver
    FROM public.drivers
    WHERE id = v_ride.driver_id
    FOR UPDATE;

    IF v_driver IS NULL THEN
        RAISE EXCEPTION 'السائق المعين غير موجود برقم: %', v_ride.driver_id;
    END IF;

    -- تخصيص فحص الإشارات التالفة لسائق الرحلة المعني فقط لعدم تعطيل تسويته بسجل سائق آخر
    SELECT COUNT(*) INTO v_driver_corrupt_count
    FROM public.balance_transactions
    WHERE ride_id = p_ride_id
      AND driver_id = v_ride.driver_id
      AND ((type = 'commission_held' AND amount >= 0) OR (type = 'commission_deduction' AND amount >= 0));

    IF v_driver_corrupt_count > 0 THEN
        RAISE EXCEPTION 'تم اكتشاف معاملات مالية ذات إشارات تالفة للسائق % في الرحلة %', v_ride.driver_id, p_ride_id;
    END IF;

    -- التحقق من عدم وجود سجلات حجز يتيمة أو غير متطابقة على الرحلة منسوبة لغير سائقها المعين
    SELECT COUNT(*) INTO v_orphan_held_count
    FROM public.balance_transactions
    WHERE ride_id = p_ride_id
      AND type = 'commission_held'
      AND (driver_id IS NULL OR driver_id <> v_ride.driver_id);

    IF v_orphan_held_count > 0 THEN
        RAISE EXCEPTION 'تم اكتشاف سجلات حجز عمولة غير متطابقة أو يتيمة منسوبة لغير السائق المعين للرحلة %', p_ride_id;
    END IF;

    -- فحص سجلات العمولة المحجوزة للسائق المعني
    SELECT COUNT(*), COALESCE(SUM(-amount), 0)
    INTO v_held_count, v_held_sum
    FROM public.balance_transactions
    WHERE ride_id = p_ride_id
      AND driver_id = v_ride.driver_id
      AND type = 'commission_held'
      AND amount < 0;

    v_ride_comm_held := COALESCE(v_ride.commission_held, 0);

    -- اشتراط التطابق الصارم لمجموع سجلات الحجز مع rides.commission_held
    IF v_held_count > 0 OR v_ride_comm_held > 0 THEN
        IF v_held_sum <> v_ride_comm_held THEN
            RAISE EXCEPTION 'عدم تطابق مجموع سجلات الحجز (%) مع العمولة المحجوزة بالرحلة (%) للرحلة %', v_held_sum, v_ride_comm_held, p_ride_id;
        END IF;
        v_commission := v_held_sum;
    ELSE
        v_commission := FLOOR(COALESCE(v_ride.amount, 0) * 0.05);
    END IF;

    -- تحديث حالة الرحلة ذرياً إلى completed
    UPDATE public.rides
    SET status = 'completed',
        completed_at = NOW(),
        commission_amount = v_commission,
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- التسوية المالية
    IF v_held_count = 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_commission
        WHERE id = v_ride.driver_id;

        INSERT INTO public.balance_transactions (
            driver_id, ride_id, amount, type, description, created_at
        ) VALUES (
            v_ride.driver_id, p_ride_id, -v_commission, 'commission_deduction', 'خصم عمولة الرحلة المكتملة 5%', NOW()
        );
    ELSE
        UPDATE public.balance_transactions
        SET type = 'commission_deduction',
            description = 'خصم عمولة الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id
          AND driver_id = v_ride.driver_id
          AND type = 'commission_held';
    END IF;
END;
$$;


-- 2. دالة handle_cancellation_penalty المعدلة والمحميّة (المعالجة المالية الصارمة للغرامة السابقة)
CREATE OR REPLACE FUNCTION public.handle_cancellation_penalty(
    p_ride_id UUID,
    p_driver_id UUID,
    p_amount DECIMAL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_ride RECORD;
    v_driver RECORD;
    v_expected_penalty DECIMAL(10,2) := 0;
    v_current_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), current_setting('role', true));
    v_caller_id UUID := auth.uid();
    v_held_count INT := 0;
    v_held_sum DECIMAL(10,2) := 0;
    v_corrupt_count INT := 0;
    v_ride_comm_held DECIMAL(10,2) := 0;
    v_prior_penalty_count INT := 0;
    v_prior_penalty_sum DECIMAL(10,2) := 0;
    v_prior_penalty_corrupt INT := 0;
BEGIN
    -- التحقق من الدور المصرح به
    IF v_current_role IS NULL OR v_current_role NOT IN ('authenticated', 'service_role') THEN
        RAISE EXCEPTION 'غير مصرح: يجب استدعاء الدالة بواسطة دور موثق (authenticated) أو خدمة خلفية (service_role)';
    END IF;

    IF p_driver_id IS NULL THEN
        RAISE EXCEPTION 'معرف السائق (p_driver_id) مطلوب ولا يمكن أن يكون NULL';
    END IF;

    -- قفل صف الرحلة فوراً بـ FOR UPDATE
    SELECT * INTO v_ride
    FROM public.rides
    WHERE id = p_ride_id
    FOR UPDATE;

    IF v_ride IS NULL THEN
        RAISE EXCEPTION 'الرحلة غير موجودة برقم: %', p_ride_id;
    END IF;

    -- التحقق من تطابق p_amount مع مبلغ الرحلة الحقيقي المسجل عند تمريره
    IF p_amount IS NOT NULL AND p_amount > 0 AND COALESCE(v_ride.amount, 0) > 0 THEN
        IF p_amount <> v_ride.amount THEN
            RAISE EXCEPTION 'المبلغ المرسل (%) لا يطابق مبلغ الرحلة الفعلي المسجل (%)', p_amount, v_ride.amount;
        END IF;
    END IF;

    -- حظر تطبيق الغرامة على الرحلات المكتملة أو الملغاة بواسطة الراكب أو المسواة
    IF v_ride.status = 'completed' THEN
        RAISE NOTICE 'لا يمكن تطبيق غرامة إلغاء على رحلة مكتملة مسبقاً';
        RETURN;
    END IF;

    IF v_ride.status IN ('cancelled_by_customer', 'cancelled') THEN
        RAISE EXCEPTION 'لا يمكن تطبيق غرامة إلغاء سائق على رحلة ملغاة مسبقاً بواسطة الراكب أو منصة الخدمة';
    END IF;

    -- التحقق من حظر الاستدعاء بـ driver_id مفقود على الرحلة أو عدم المطابقة
    IF v_ride.driver_id IS NULL THEN
        RAISE EXCEPTION 'لا يوجد سائق عين لهذه الرحلة لتطبيق الغرامة عليه';
    END IF;

    IF v_ride.driver_id <> p_driver_id THEN
        RAISE EXCEPTION 'السائق المرسل (%) لا يطابق السائق المعين للرحلة (%)', p_driver_id, v_ride.driver_id;
    END IF;

    -- التحقق الأمني من الملكية لصلاحية authenticated
    IF v_current_role = 'authenticated' THEN
        IF v_caller_id IS NULL THEN
            RAISE EXCEPTION 'غير مصرح: يتعذر الحصول على هوية المستدعي الموثق';
        END IF;
        IF p_driver_id <> v_caller_id THEN
            RAISE EXCEPTION 'غير مصرح لك بتطبيق غرامة على رحلة سائق آخر';
        END IF;
    END IF;

    -- 1. حساب الغرامة المستحقة وفق المنطق المالي الحالي من بيانات الرحلة وسجلات الحجز (دون الاعتماد على p_amount)
    SELECT COUNT(*), COALESCE(SUM(-amount), 0)
    INTO v_held_count, v_held_sum
    FROM public.balance_transactions
    WHERE ride_id = p_ride_id
      AND driver_id = p_driver_id
      AND type = 'commission_held'
      AND amount < 0;

    SELECT COUNT(*) INTO v_corrupt_count
    FROM public.balance_transactions
    WHERE ride_id = p_ride_id
      AND ((type = 'commission_held' AND amount >= 0) OR (type = 'cancellation_penalty' AND amount >= 0));

    IF v_corrupt_count > 0 THEN
        RAISE EXCEPTION 'تم اكتشاف معاملات مالية ذات إشارات تالفة للرحلة %', p_ride_id;
    END IF;

    v_ride_comm_held := COALESCE(v_ride.commission_held, 0);

    IF v_held_count > 0 OR v_ride_comm_held > 0 THEN
        IF v_held_sum <> v_ride_comm_held THEN
            RAISE EXCEPTION 'عدم تطابق مجموع سجلات الحجز (%) مع العمولة المحجوزة بالرحلة (%) قبل تطبيق الغرامة للرحلة %', v_held_sum, v_ride_comm_held, p_ride_id;
        END IF;
        v_expected_penalty := v_held_sum;
    ELSE
        v_expected_penalty := FLOOR(COALESCE(v_ride.amount, 0) * 0.05);
    END IF;

    -- 2. التحقق من أي غرامة سابقة ومطابقة مجموعها للمبلغ المستحق الفعلي بدقة
    IF v_ride.status = 'cancelled_by_driver' THEN
        SELECT COUNT(*), COALESCE(SUM(-amount), 0)
        INTO v_prior_penalty_count, v_prior_penalty_sum
        FROM public.balance_transactions
        WHERE ride_id = p_ride_id AND driver_id = p_driver_id AND type = 'cancellation_penalty' AND amount < 0;

        IF v_prior_penalty_count > 0 THEN
            -- إذا كان هناك سجلات مكررة متعارضة أو المجموع لا يطابق المستحق تماماً -> إيقاف العملية بـ EXCEPTION
            IF v_prior_penalty_count > 1 OR v_prior_penalty_sum <> v_expected_penalty THEN
                RAISE EXCEPTION 'تعارض مالي: مجموع الغرامة السابقة (%) أو عدد سجلاتها (%) لا يطابق الغرامة المستحقة (%) للرحلة %', v_prior_penalty_sum, v_prior_penalty_count, v_expected_penalty, p_ride_id;
            END IF;

            -- إذا كان المبلغ مطابقاً تماماً وسجلاً واحداً صحيحاً -> اعتباره منفذاً ولا يخصم مجدداً
            RAISE NOTICE 'الغرامة مطبقة مسبقاً لهذه الرحلة ومطابقة تماماً للمستحق';
            RETURN;
        END IF;
    END IF;

    -- قفل صف السائق بـ FOR UPDATE
    SELECT * INTO v_driver
    FROM public.drivers
    WHERE id = p_driver_id
    FOR UPDATE;

    IF v_driver IS NULL THEN
        RAISE EXCEPTION 'السائق غير موجود';
    END IF;

    -- تحديث حالة الرحلة
    UPDATE public.rides
    SET status = 'cancelled_by_driver',
        cancelled_at = NOW(),
        cancellation_reason = 'إلغاء السائق وتطبيق الغرامة',
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- تطبيق الخصم أو التحويل الحسابي بمبلغ الغرامة المستحقة المحسوبة
    IF v_held_count = 0 THEN
        UPDATE public.drivers
        SET balance = COALESCE(balance, 0) - v_expected_penalty
        WHERE id = p_driver_id;

        INSERT INTO public.balance_transactions (
            driver_id, ride_id, amount, type, description, created_at
        ) VALUES (
            p_driver_id, p_ride_id, -v_expected_penalty, 'cancellation_penalty', 'خصم رسوم إلغاء الرحلة', NOW()
        );
    ELSE
        UPDATE public.balance_transactions
        SET type = 'cancellation_penalty',
            description = 'خصم رسوم إلغاء الرحلة (محولة من عمولة مجمدة)'
        WHERE ride_id = p_ride_id
          AND driver_id = p_driver_id
          AND type = 'commission_held';
    END IF;
END;
$$;


-- 3. دالة cancel_ride المعدلة والمحميّة
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
    v_refund_amount DECIMAL(10,2) := 0;
    v_cancelled_by_clean TEXT;
    v_current_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), current_setting('role', true));
    v_caller_id UUID := auth.uid();
    v_ride_comm_held DECIMAL(10,2) := 0;
BEGIN
    -- التحقق من الدور المصرح به
    IF v_current_role IS NULL OR v_current_role NOT IN ('authenticated', 'service_role') THEN
        RAISE EXCEPTION 'غير مصرح: يجب استدعاء الدالة بواسطة دور موثق (authenticated) أو خدمة خلفية (service_role)';
    END IF;

    -- التحقق الصارم من المدخلات
    IF p_cancelled_by IS NULL OR TRIM(p_cancelled_by) = '' THEN
        RAISE EXCEPTION 'جهة الإلغاء مطلوبة ولا يمكن أن تكون فارغة';
    END IF;

    v_cancelled_by_clean := LOWER(TRIM(p_cancelled_by));

    IF v_cancelled_by_clean NOT IN ('customer', 'passenger', 'driver') THEN
        RAISE EXCEPTION 'جهة الإلغاء غير صالحة: % (القيم المقبولة: customer, passenger, driver)', p_cancelled_by;
    END IF;

    -- قفل صف الرحلة فوراً بـ FOR UPDATE لتسلسل الطلبات المتزامنة
    SELECT * INTO v_ride
    FROM public.rides
    WHERE id = p_ride_id
    FOR UPDATE;

    IF v_ride IS NULL THEN
        RAISE EXCEPTION 'الرحلة غير موجودة برقم: %', p_ride_id;
    END IF;

    -- إعادة فحص حالة الرحلة بعد الحصول على القفل
    IF v_ride.status IN ('completed', 'cancelled_by_driver', 'cancelled_by_customer', 'cancelled') THEN
        RAISE NOTICE 'الرحلة غير قابلة للإلغاء لأن حالتها الحالية هي: %', v_ride.status;
        RETURN;
    END IF;

    IF v_ride.status NOT IN ('accepted', 'arrived', 'ongoing') THEN
        RETURN;
    END IF;

    -- التحقق الأمني الصارم من الملكية للصلاحية الموثقة
    IF v_current_role = 'authenticated' THEN
        IF v_caller_id IS NULL THEN
            RAISE EXCEPTION 'غير مصرح: يتعذر التحقق من هوية المستدعي الموثق';
        END IF;

        IF v_cancelled_by_clean IN ('customer', 'passenger') THEN
            IF v_ride.passenger_id IS NULL THEN
                RAISE EXCEPTION 'غير مصرح: الرحلة تفتقر لبيانات الراكب المعين ولا يمكن إلغاؤها من طرف موثق غير متاح';
            END IF;
            IF v_ride.passenger_id <> v_caller_id THEN
                RAISE EXCEPTION 'غير مصرح لك بإلغاء رحلة راكب آخر';
            END IF;
        ELSIF v_cancelled_by_clean = 'driver' THEN
            IF v_ride.driver_id IS NULL THEN
                RAISE EXCEPTION 'غير مصرح: الرحلة تفتقر لبيانات السائق المعين';
            END IF;
            IF v_ride.driver_id <> v_caller_id THEN
                RAISE EXCEPTION 'غير مصرح لك بإلغاء رحلة سائق آخر';
            END IF;
        END IF;
    END IF;

    v_ride_comm_held := COALESCE(v_ride.commission_held, 0);

    -- الفحص المالي عند إلغاء الراكب مع وجود السائق المعين
    IF v_cancelled_by_clean IN ('customer', 'passenger') AND v_ride.driver_id IS NOT NULL THEN
        SELECT COUNT(*), COALESCE(SUM(-amount), 0) INTO v_held_count, v_total_held
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND type = 'commission_held'
          AND amount < 0;

        SELECT COUNT(*) INTO v_corrupt_count
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND ((type = 'commission_held' AND amount >= 0) OR (type = 'cancellation_refund' AND amount <= 0));

        IF v_corrupt_count > 0 THEN
            RAISE EXCEPTION 'تم اكتشاف معاملات مالية ذات إشارات تالفة للرحلة %', p_ride_id;
        END IF;

        IF v_held_count > 0 OR v_ride_comm_held > 0 THEN
            IF v_total_held <> v_ride_comm_held THEN
                RAISE EXCEPTION 'عدم تطابق مجموع سجلات الحجز (%) مع العمولة المحجوزة بالرحلة (%) - تم إيقاف الإلغاء حماية للأرصدة', v_total_held, v_ride_comm_held;
            END IF;
        END IF;

        -- رفض صريح بـ EXCEPTION إذا كان مجموع الاستردادات السابقة أكبر من مجموع الحجوزات
        SELECT COALESCE(SUM(amount), 0) INTO v_total_refunded
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND type = 'cancellation_refund'
          AND amount > 0;

        IF v_total_refunded > v_total_held THEN
            RAISE EXCEPTION 'فساد مالي: مجموع الاستردادات السابقة (%) يتجاوز مجموع الحجوزات (%) للرحلة %', v_total_refunded, v_total_held, p_ride_id;
        END IF;
    END IF;

    -- تحديث حالة الرحلة ذرياً
    UPDATE public.rides
    SET
        status = CASE
            WHEN v_cancelled_by_clean = 'driver' THEN 'cancelled_by_driver'
            ELSE 'cancelled_by_customer'
        END,
        cancelled_at = NOW(),
        cancellation_reason = CASE
            WHEN v_cancelled_by_clean = 'driver' THEN 'إلغاء السائق'
            ELSE 'إلغاء الراكب'
        END,
        updated_at = NOW()
    WHERE id = p_ride_id;

    -- معالجة استرداد العمولة: فقط عند إلغاء الراكب
    IF v_cancelled_by_clean IN ('customer', 'passenger') AND v_ride.driver_id IS NOT NULL THEN

        -- فحص وجود أي معاملات تسوية نهائية مانعة للاسترداد
        SELECT COUNT(*) INTO v_settled_count
        FROM public.balance_transactions
        WHERE driver_id = v_ride.driver_id
          AND ride_id = p_ride_id
          AND type IN ('commission_deduction', 'cancellation_penalty');

        IF v_settled_count = 0 THEN

            v_net_unrefunded := v_total_held - v_total_refunded;

            IF v_total_held > 0
               AND v_ride_comm_held > 0
               AND v_total_held = v_ride_comm_held
               AND v_net_unrefunded > 0 THEN

                v_refund_amount := LEAST(v_ride_comm_held, v_net_unrefunded);

                IF v_refund_amount > 0 THEN

                    SELECT * INTO v_driver
                    FROM public.drivers
                    WHERE id = v_ride.driver_id
                    FOR UPDATE;

                    IF v_driver IS NOT NULL THEN
                        UPDATE public.drivers
                        SET balance = COALESCE(balance, 0) + v_refund_amount
                        WHERE id = v_ride.driver_id;

                        INSERT INTO public.balance_transactions (
                            driver_id, ride_id, amount, type, description, created_at
                        ) VALUES (
                            v_ride.driver_id, p_ride_id, v_refund_amount, 'cancellation_refund', 'استرجاع عمولة الرحلة - إلغاء الراكب', NOW()
                        );
                    END IF;
                END IF;
            END IF;
        END IF;
    END IF;
END;
$$;

-- سحب الصلاحيات من PUBLIC و anon ومنحها حصراً لـ authenticated و service_role
REVOKE EXECUTE ON FUNCTION public.cancel_ride(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cancel_ride(UUID, TEXT) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.complete_ride(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.complete_ride(UUID) TO authenticated, service_role;

REVOKE EXECUTE ON FUNCTION public.handle_cancellation_penalty(UUID, UUID, DECIMAL) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.handle_cancellation_penalty(UUID, UUID, DECIMAL) TO authenticated, service_role;
