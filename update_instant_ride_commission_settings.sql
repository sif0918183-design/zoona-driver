-- ============================================================================
-- تراكا للنقل - تحديث عمولة الرحلات الداخلية وفق الإعدادات المركزية والديناميكية
-- ملف Migration مستقل: update_instant_ride_commission_settings.sql
-- ============================================================================
-- الأهداف وضوابط التزامن والسلامة المالية الصارمة:
-- 1. ربط عمولة قبول الرحلات الفورية بالمفتاح المركزي 'service_fee_percentage' في system_settings.
-- 2. تطبيق الرفض الصارم (Strict Fail-Safe): رفض العملية بالكامل وإلغاء المعاملة إذا تعذرت
--    قراءة الإعداد أو كان غير موجود أو غير صالح، دون الرجوع تلقائياً لأي نسبة غير معتمدة.
-- 3. توحيد الحد الأقصى للعمولة ليكون 50% كحد أقصى متطابق مع لوحة الإدارة (من 0% إلى 50%).
-- 4. التحقق من صحة مبلغ الرحلة (amount > 0) لمنع معالجة المبالغ الصفرية أو التالفة.
-- 5. حصر صلاحية التنفيذ حصراً في دور service_role لضمان عدم إمكانية استدعاء الدالة
--    مباشرة من المتصفحات، وضمان المرور عبر خادم /api/rides للتحقق من هوية السائق ونشاطه.
-- 6. اعتماد أقصى درجات أمان البحث: SET search_path = pg_catalog, pg_temp مع التأهيل الكامل لجميع الجداول.
-- 7. قفل الصفوف الصارم (FOR UPDATE) بترتيب متناسق (rides أولاً ثم drivers) لمنع Deadlock و Lost Update.
-- 8. عدم المساس بأي من دوال الرحلات السفرية أو إعداداتها.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.accept_immediate_ride(p_ride_id UUID, p_driver_id UUID)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    v_ride RECORD;
    v_driver RECORD;
    v_commission DECIMAL;
    v_fee_percentage DECIMAL;
    v_setting_text TEXT;
BEGIN
    -- 1. التحقق من المدخلات الأساسية
    IF p_ride_id IS NULL OR p_driver_id IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'بيانات الرحلة أو السائق غير مكتملة');
    END IF;

    -- 2. قراءة نسبة العمولة المركزية ديناميكياً مع الرفض الصارم (Strict Fail-Safe)
    -- تتم هذه الخطوة قبل حجز أي أقفال لتجنب حجز الموارد عند وجود خلل في الإعدادات
    BEGIN
        SELECT value INTO v_setting_text
        FROM public.system_settings
        WHERE key = 'service_fee_percentage'
        LIMIT 1;

        IF v_setting_text IS NULL OR pg_catalog.btrim(v_setting_text) = '' THEN
            RETURN json_build_object('success', false, 'message', 'فشل في تحديد عمولة النظام، يرجى المحاولة لاحقاً أو مراجعة الإدارة');
        END IF;

        IF pg_catalog.btrim(v_setting_text) !~ '^[0-9]+(\.[0-9]+)?$' THEN
            RETURN json_build_object('success', false, 'message', 'فشل في تحديد عمولة النظام، يرجى المحاولة لاحقاً أو مراجعة الإدارة');
        END IF;

        v_fee_percentage := v_setting_text::DECIMAL;

        -- التحقق من مطابقة النسبة للحدود المعتمدة في لوحة الإدارة (0% إلى 50%)
        IF v_fee_percentage < 0 OR v_fee_percentage > 50 THEN
            RETURN json_build_object('success', false, 'message', 'فشل في تحديد عمولة النظام، يرجى المحاولة لاحقاً أو مراجعة الإدارة');
        END IF;

    EXCEPTION WHEN OTHERS THEN
        RETURN json_build_object('success', false, 'message', 'فشل في تحديد عمولة النظام، يرجى المحاولة لاحقاً أو مراجعة الإدارة');
    END;

    -- 3. قفل صف الرحلة فوراً لتسلسل الطلبات المتزامنة ومنع قبول نفس الرحلة من عدة سائقين
    SELECT * INTO v_ride
    FROM public.rides
    WHERE id = p_ride_id
    FOR UPDATE;

    IF v_ride IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'الرحلة غير موجودة');
    END IF;

    -- 4. فحص حالة الرحلة بعد حيازة القفل الحصري (Mutex Lock)
    IF v_ride.status NOT IN ('searching', 'pending', 'awaiting_driver_acceptance') THEN
        RETURN json_build_object('success', false, 'message', 'عذراً، تم قبول هذه الرحلة بالفعل من قبل سائق آخر');
    END IF;

    -- 5. التحقق الصارم من سلامة مبلغ الرحلة (amount > 0)
    IF v_ride.amount IS NULL OR v_ride.amount <= 0 THEN
        RETURN json_build_object('success', false, 'message', 'مبلغ الرحلة غير صالح');
    END IF;

    -- 6. قفل صف السائق بـ FOR UPDATE لتسلسل عمليات قبول الرحلات المختلفة لنفس السائق وحماية الرصيد
    SELECT * INTO v_driver
    FROM public.drivers
    WHERE id = p_driver_id
    FOR UPDATE;

    IF v_driver IS NULL THEN
        RETURN json_build_object('success', false, 'message', 'بيانات السائق غير موجودة');
    END IF;

    -- 7. حساب العمولة وفق النسبة المقروءة والمعتمدة من الإعدادات ديناميكياً (تقريب لأسفل)
    v_commission := pg_catalog.floor(COALESCE(v_ride.amount, 0) * (v_fee_percentage / 100.0));

    -- 8. التحقق من كفاية رصيد السائق المقفول
    IF COALESCE(v_driver.balance, 0) < v_commission THEN
        RETURN json_build_object('success', false, 'message', 'رصيدك غير كافٍ لخصم عمولة الرحلة');
    END IF;

    -- 9. التحديثات الذرية (تحدث فقط بعد اجتياز كافة الفحوصات والتحققات بنجاح)
    -- أ. تحديث حالة الرحلة وتسجيل العمولة المحجوزة
    UPDATE public.rides
    SET status = 'accepted',
        driver_id = p_driver_id,
        driver_accepted = true,
        accepted_at = pg_catalog.now(),
        commission_held = v_commission,
        commission_held_at = pg_catalog.now(),
        updated_at = pg_catalog.now()
    WHERE id = p_ride_id;

    -- ب. خصم العمولة من رصيد السائق (تجميد وحجز ذري دقيق)
    UPDATE public.drivers
    SET balance = COALESCE(balance, 0) - v_commission
    WHERE id = p_driver_id;

    -- ج. تسجيل المعاملة المالية في سجل الحركات
    INSERT INTO public.balance_transactions (driver_id, ride_id, amount, type, description, created_at)
    VALUES (p_driver_id, p_ride_id, -v_commission, 'commission_held', 'تجميد عمولة الرحلة (سيتم خصمها نهائياً عند الإكمال)', pg_catalog.now());

    -- 10. إرجاع النتيجة بنجاح مع الرصيد الجديد والنسبة المطبقة
    RETURN json_build_object(
        'success', true,
        'message', 'تم قبول الرحلة بنجاح وخصم العمولة',
        'commission_deducted', v_commission,
        'commission_rate_applied', v_fee_percentage,
        'new_balance', COALESCE(v_driver.balance, 0) - v_commission
    );
END;
$$;

-- سحب الصلاحيات بالكامل من العامة والمستخدمين العاديين، وقصرها حصراً على service_role
REVOKE EXECUTE ON FUNCTION public.accept_immediate_ride(UUID, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_immediate_ride(UUID, UUID) TO service_role;
