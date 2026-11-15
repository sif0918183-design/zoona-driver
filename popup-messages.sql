-- =============================================================================
-- Tracka - Popup Messages & Announcements (الرسائل المنبثقة والإعلانات)
-- Feature scope: admin-managed popup messages shown inside the passenger/driver apps.
-- This script is additive and does not modify any existing table or policy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. popup_messages - الرسائل المنبثقة والإعلانات
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.popup_messages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    image_url TEXT,
    primary_button_text TEXT,
    primary_button_url TEXT,
    secondary_button_text TEXT,
    secondary_button_url TEXT,
    delay_seconds INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 0,
    -- مكان ظهور الرسالة: واجهة واحدة فقط (driver أو passenger)
    target_app TEXT NOT NULL CHECK (target_app IN ('driver', 'passenger')),
    repeat_policy TEXT NOT NULL DEFAULT 'once'
        CHECK (repeat_policy IN ('once', 'session', 'every_visit', 'interval')),
    repeat_interval_minutes INTEGER,
    start_at TIMESTAMPTZ,
    end_at TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_popup_messages_target_active
    ON public.popup_messages (target_app, is_active);
CREATE INDEX IF NOT EXISTS idx_popup_messages_priority
    ON public.popup_messages (priority DESC);
CREATE INDEX IF NOT EXISTS idx_popup_messages_window
    ON public.popup_messages (start_at, end_at);

-- -----------------------------------------------------------------------------
-- 2. popup_message_views - سجل الظهور الدائم (لمرة واحدة لكل مستخدم)
--    مرتبط بمعرّف المستخدم في قاعدة البيانات، وليس بمتصفح المستخدم.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.popup_message_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL REFERENCES public.popup_messages(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    viewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_popup_message_views_user
    ON public.popup_message_views (user_id);
CREATE INDEX IF NOT EXISTS idx_popup_message_views_message
    ON public.popup_message_views (message_id);

-- -----------------------------------------------------------------------------
-- 3. تحديث updated_at تلقائياً
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_popup_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_popup_messages_updated_at ON public.popup_messages;
CREATE TRIGGER trg_popup_messages_updated_at
    BEFORE UPDATE ON public.popup_messages
    FOR EACH ROW
    EXECUTE FUNCTION public.set_popup_messages_updated_at();

-- -----------------------------------------------------------------------------
-- 4. Row Level Security - عزل تام
--    جميع القراءات/الكتابات تمر عبر الخادم (service_role) فقط.
--    لا يُمنح anon/authenticated أي وصول مباشر.
-- -----------------------------------------------------------------------------
ALTER TABLE public.popup_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.popup_message_views ENABLE ROW LEVEL SECURITY;

-- سحب أي صلاحيات عامة (security.sql يمنح SELECT ON ALL TABLES للجداول الموجودة مسبقاً،
-- لذا نسحب صراحةً لضمان عدم الوصول المباشر من الواجهة الأمامية).
REVOKE ALL ON public.popup_messages FROM anon, authenticated;
REVOKE ALL ON public.popup_message_views FROM anon, authenticated;

GRANT ALL ON public.popup_messages TO postgres, service_role;
GRANT ALL ON public.popup_message_views TO postgres, service_role;

-- -----------------------------------------------------------------------------
-- ملخص الأعمدة (popup_messages):
-- id, title, body, image_url,
-- primary_button_text, primary_button_url,
-- secondary_button_text, secondary_button_url,
-- delay_seconds, priority, target_app (driver|passenger),
-- repeat_policy (once|session|every_visit|interval), repeat_interval_minutes,
-- start_at, end_at, is_active, created_at, updated_at
-- -----------------------------------------------------------------------------
