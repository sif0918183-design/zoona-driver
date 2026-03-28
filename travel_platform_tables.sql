-- ============================================
-- SQL - منصة سفريات تراكا (Travel Platform)
-- يتضمن:
-- 1. جدول travel_trips للرحلات الخارجية
-- 2. جدول user_message_reads لتتبع قراءة الرسائل
-- 3. جدول driver_violations لمخالفات السائقين
-- ============================================

-- ============================================
-- 1. جدول travel_trips للرحلات الخارجية
-- ============================================
CREATE TABLE IF NOT EXISTS travel_trips (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ride_request_id UUID REFERENCES ride_requests(id) ON DELETE CASCADE,
    passenger_id UUID REFERENCES customers(id) ON DELETE CASCADE,
    driver_id UUID REFERENCES drivers(id) ON DELETE SET NULL,
    from_city TEXT NOT NULL,
    to_city TEXT NOT NULL,
    vehicle_category TEXT,
    final_price DECIMAL(10,2),
    status TEXT NOT NULL DEFAULT 'driver_selected',
    commission_deducted BOOLEAN DEFAULT false,
    commission_amount DECIMAL(10,2) DEFAULT 0,
    driver_arrival_confirmed_at TIMESTAMPTZ,
    trip_started_at TIMESTAMPTZ,
    trip_completed_at TIMESTAMPTZ,
    cancelled_by TEXT,
    cancelled_at TIMESTAMPTZ,
    cancellation_reason TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- الفهارس المطلوبة لجدول travel_trips
CREATE INDEX IF NOT EXISTS idx_travel_trips_ride_request_id ON travel_trips(ride_request_id);
CREATE INDEX IF NOT EXISTS idx_travel_trips_passenger_id ON travel_trips(passenger_id);
CREATE INDEX IF NOT EXISTS idx_travel_trips_driver_id ON travel_trips(driver_id);
CREATE INDEX IF NOT EXISTS idx_travel_trips_status ON travel_trips(status);
CREATE INDEX IF NOT EXISTS idx_travel_trips_driver_status ON travel_trips(driver_id, status);

-- إضافة العمود foreign key إذا لم يكن موجوداً
ALTER TABLE travel_trips ADD CONSTRAINT fk_travel_trips_ride_request 
    FOREIGN KEY (ride_request_id) REFERENCES ride_requests(id) ON DELETE CASCADE;
ALTER TABLE travel_trips ADD CONSTRAINT fk_travel_trips_passenger 
    FOREIGN KEY (passenger_id) REFERENCES customers(id) ON DELETE CASCADE;
ALTER TABLE travel_trips ADD CONSTRAINT fk_travel_trips_driver 
    FOREIGN KEY (driver_id) REFERENCES drivers(id) ON DELETE SET NULL;

-- ============================================
-- 2. جدول user_message_reads لتتبع قراءة الرسائل
-- ============================================
CREATE TABLE IF NOT EXISTS user_message_reads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL,
    chat_id UUID NOT NULL,
    last_read_message_id UUID,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, chat_id)
);

-- فهرس لتحسين أداء الاستعلامات
CREATE INDEX IF NOT EXISTS idx_user_message_reads_user_chat ON user_message_reads(user_id, chat_id);
CREATE INDEX IF NOT EXISTS idx_user_message_reads_user_id ON user_message_reads(user_id);

-- ============================================
-- 3. جدول driver_violations لمخالفات السائقين
-- ============================================
CREATE TABLE IF NOT EXISTS driver_violations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID REFERENCES drivers(id) ON DELETE CASCADE,
    trip_id UUID REFERENCES travel_trips(id) ON DELETE SET NULL,
    violation_type TEXT NOT NULL,
    description TEXT,
    penalty_amount DECIMAL(10,2) DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- فهارس جدول المخالفات
CREATE INDEX IF NOT EXISTS idx_driver_violations_driver_id ON driver_violations(driver_id);
CREATE INDEX IF NOT EXISTS idx_driver_violations_trip_id ON driver_violations(trip_id);
CREATE INDEX IF NOT EXISTS idx_driver_violations_type ON driver_violations(violation_type);

-- ============================================
-- 4. تعديلات على جدول ride_requests
-- ============================================
-- إضافة أعمدة جديدة لجدول ride_requests لتتبع الرحلة الخارجية
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS final_price DECIMAL(10,2);
ALTER TABLE ride_requests ADD COLUMN IF NOT EXISTS travel_trip_id UUID REFERENCES travel_trips(id) ON DELETE SET NULL;

-- ============================================
-- 5. تعديلات على جدول ride_driver_acceptances
-- ============================================
ALTER TABLE ride_driver_acceptances ADD COLUMN IF NOT EXISTS shown_to_passenger BOOLEAN DEFAULT false;

-- ============================================
-- 6. دالة SQL لإكمال الرحلة وخصم العمولة
-- ============================================
CREATE OR REPLACE FUNCTION complete_travel_trip(p_trip_id UUID)
RETURNS VOID AS $$
DECLARE
    v_driver_id UUID;
    v_amount DECIMAL(10,2);
    v_commission DECIMAL(10,2);
    v_new_balance DECIMAL(10,2);
BEGIN
    -- 1. الحصول على تفاصيل الرحلة
    SELECT driver_id, final_price INTO v_driver_id, v_amount
    FROM public.travel_trips
    WHERE id = p_trip_id;

    IF v_driver_id IS NULL THEN
        RAISE EXCEPTION 'الرحلة غير موجودة أو لم يتم تعيين سائق';
    END IF;

    IF v_amount IS NULL OR v_amount <= 0 THEN
        RAISE EXCEPTION 'سعر الرحلة غير صالح';
    END IF;

    -- 2. حساب العمولة (5%)
    v_commission := v_amount * 0.05;

    -- 3. تحديث حالة الرحلة وتسجيل الوقت
    UPDATE public.travel_trips
    SET status = 'completed',
        trip_completed_at = NOW(),
        commission_deducted = true,
        commission_amount = v_commission,
        updated_at = NOW()
    WHERE id = p_trip_id;

    -- 4. خصم العمولة من رصيد السائق
    UPDATE public.drivers
    SET balance = COALESCE(balance, 0) - v_commission
    WHERE id = v_driver_id;

    -- 5. الحصول على الرصيد الجديد
    SELECT balance INTO v_new_balance FROM public.drivers WHERE id = v_driver_id;
    
    RAISE NOTICE 'تم إكمال الرحلة بنجاح. العمولة المخصومة: %. الرصيد الجديد للسائق: %', v_commission, v_new_balance;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 7. دالة SQL لإلغاء الرحلة ومعالجة المخالفات
-- ============================================
CREATE OR REPLACE FUNCTION cancel_travel_trip(p_trip_id UUID, p_cancelled_by TEXT, p_reason TEXT DEFAULT NULL)
RETURNS VOID AS $$
DECLARE
    v_trip travel_trips%ROWTYPE;
    v_passenger_id UUID;
    v_driver_id UUID;
    v_status TEXT;
BEGIN
    -- 1. الحصول على تفاصيل الرحلة
    SELECT * INTO v_trip FROM travel_trips WHERE id = p_trip_id;
    
    IF v_trip.id IS NULL THEN
        RAISE EXCEPTION 'الرحلة غير موجودة';
    END IF;

    v_status := v_trip.status;
    v_passenger_id := v_trip.passenger_id;
    v_driver_id := v_trip.driver_id;

    -- 2. تحديث حالة الرحلة
    UPDATE travel_trips
    SET status = 'cancelled',
        cancelled_by = p_cancelled_by,
        cancelled_at = NOW(),
        cancellation_reason = p_reason,
        updated_at = NOW()
    WHERE id = p_trip_id;

    -- 3. تحديث جدول ride_requests بالحالة
    UPDATE ride_requests
    SET status = 'cancelled',
        updated_at = NOW()
    WHERE id = v_trip.ride_request_id;

    -- 4. إذا كان الإلغاء من السائق بعد اختياره ولم يتم إكمال الرحلة
    IF p_cancelled_by = 'driver' AND v_driver_id IS NOT NULL 
       AND v_status IN ('driver_selected', 'confirmed', 'in_progress') THEN
        -- تسجيل مخالفة
        INSERT INTO driver_violations (driver_id, trip_id, violation_type, description)
        VALUES (v_driver_id, p_trip_id, 'cancellation_after_selection', p_reason);
        
        -- خصم غرامة إلغاء (قيمة افتراضية)
        UPDATE drivers
        SET balance = COALESCE(balance, 0) - 10
        WHERE id = v_driver_id;
    END IF;

    RAISE NOTICE 'تم إلغاء الرحلة بنجاح';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 8. دالة SQL لمنع السائق من قبول رحلة جديدة
-- ============================================
CREATE OR REPLACE FUNCTION driver_can_accept_trip(p_driver_id UUID)
RETURNS BOOLEAN AS $$
DECLARE
    v_active_trip_count INTEGER;
BEGIN
    -- التحقق من وجود رحلة سارية
    SELECT COUNT(*) INTO v_active_trip_count
    FROM travel_trips
    WHERE driver_id = p_driver_id
      AND status IN ('driver_selected', 'confirmed', 'in_progress');

    IF v_active_trip_count > 0 THEN
        RETURN false;
    END IF;

    RETURN true;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ============================================
-- 9. VIEW للرحلات النشطة للسائق
-- ============================================
CREATE OR REPLACE VIEW active_driver_trips AS
SELECT 
    tt.id,
    tt.ride_request_id,
    tt.passenger_id,
    tt.driver_id,
    tt.from_city,
    tt.to_city,
    tt.vehicle_category,
    tt.final_price,
    tt.status,
    tt.driver_arrival_confirmed_at,
    tt.trip_started_at,
    tt.trip_completed_at,
    c.full_name as passenger_name,
    c.phone as passenger_phone,
    d.full_name as driver_name,
    d.phone as driver_phone
FROM travel_trips tt
LEFT JOIN customers c ON tt.passenger_id = c.id
LEFT JOIN drivers d ON tt.driver_id = d.id
WHERE tt.status IN ('driver_selected', 'confirmed', 'in_progress');

-- ============================================
-- 10. VIEW للرحلات النشطة للراكب
-- ============================================
CREATE OR REPLACE VIEW active_passenger_trips AS
SELECT 
    tt.id,
    tt.ride_request_id,
    tt.passenger_id,
    tt.driver_id,
    tt.from_city,
    tt.to_city,
    tt.vehicle_category,
    tt.final_price,
    tt.status,
    tt.driver_arrival_confirmed_at,
    tt.trip_started_at,
    tt.trip_completed_at,
    c.full_name as passenger_name,
    c.phone as passenger_phone,
    d.full_name as driver_name,
    d.phone as driver_phone
FROM travel_trips tt
LEFT JOIN customers c ON tt.passenger_id = c.id
LEFT JOIN drivers d ON tt.driver_id = d.id
WHERE tt.status != 'cancelled';

-- ============================================
-- 11. منح الصلاحيات (للجداول الجديدة)
-- ============================================
-- ملاحظة: يجب تنفيذ هذا الكود بمستوى الصلاحيات المناسب
-- GRANT SELECT, INSERT, UPDATE, DELETE ON travel_trips TO authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON user_message_reads TO authenticated;
-- GRANT SELECT, INSERT, UPDATE, DELETE ON driver_violations TO authenticated;
-- GRANT EXECUTE ON FUNCTION complete_travel_trip TO authenticated;
-- GRANT EXECUTE ON FUNCTION cancel_travel_trip TO authenticated;
-- GRANT EXECUTE ON FUNCTION driver_can_accept_trip TO authenticated;

-- ============================================
-- 12. ملخص الجداول والفهارس
-- ============================================
/*
جدول travel_trips:
- الأعمدة الأساسية: id, ride_request_id, passenger_id, driver_id, from_city, to_city
- حالة الرحلة: status (driver_selected, confirmed, in_progress, completed, cancelled)
- العمولة: commission_deducted, commission_amount
- التواريخ: driver_arrival_confirmed_at, trip_started_at, trip_completed_at
- الإلغاء: cancelled_by, cancelled_at, cancellation_reason
- الفهارس: ride_request_id, passenger_id, driver_id, status, (driver_id, status)

جدول user_message_reads:
- الأعمدة: id, user_id, chat_id, last_read_message_id, updated_at
- الغرض: تتبع آخر رسالة تمت قراءتها لكل محادثة لكل مستخدم

جدول driver_violations:
- الأعمدة: id, driver_id, trip_id, violation_type, description, penalty_amount
- الغرض: تسجيل مخالفات السائقين (الإلغاء المتكرر، etc)
*/