-- =====================================================
-- نظام التحقق عبر OTP ورقم واتساب - WhatsApp OTP System Schema
-- =====================================================

-- 1. جدول حفظ جلسات Baileys للـ WhatsApp Gateway
CREATE TABLE IF NOT EXISTS public.whatsapp_sessions (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for whatsapp_sessions for faster lookup
CREATE INDEX IF NOT EXISTS idx_whatsapp_sessions_id ON public.whatsapp_sessions(id);

-- 2. جدول رموز تحقق الركاب (Passenger OTPs)
CREATE TABLE IF NOT EXISTS public.passenger_otps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone_number TEXT NOT NULL,
    otp_code TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    verified_at TIMESTAMPTZ,
    is_verified BOOLEAN DEFAULT FALSE,
    UNIQUE (phone_number, otp_code)
);

-- Indexes for passenger_otps
CREATE INDEX IF NOT EXISTS idx_passenger_otps_phone ON public.passenger_otps(phone_number);
CREATE INDEX IF NOT EXISTS idx_passenger_otps_phone_unverified ON public.passenger_otps(phone_number) WHERE is_verified = FALSE;
CREATE INDEX IF NOT EXISTS idx_passenger_otps_expires ON public.passenger_otps(expires_at);

-- 3. جدول سجلات إرسال الرموز (OTP Logs) لمنع الإساءة ومراقبة الأداء
CREATE TABLE IF NOT EXISTS public.otp_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    phone TEXT NOT NULL,
    sent_at TIMESTAMPTZ DEFAULT NOW(),
    status TEXT NOT NULL, -- 'success', 'failed'
    latency INTEGER, -- بالفيمتو/ملي ثانية
    provider TEXT DEFAULT 'whatsapp_render',
    error TEXT,
    ip_address TEXT
);

-- Indexes for otp_logs
CREATE INDEX IF NOT EXISTS idx_otp_logs_phone_sent ON public.otp_logs(phone, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_logs_ip_sent ON public.otp_logs(ip_address, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_logs_sent_at ON public.otp_logs(sent_at DESC);

-- Enable Row Level Security (RLS) on these tables
ALTER TABLE public.whatsapp_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.passenger_otps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.otp_logs ENABLE ROW LEVEL SECURITY;

-- Allow read/write access for service role only (bypassing normal client access)
-- This ensures that only the backend API/Vercel functions can read/write to these tables,
-- protecting the OTP verification from frontend manipulation.

CREATE POLICY "Service role full access on whatsapp_sessions" ON public.whatsapp_sessions
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on passenger_otps" ON public.passenger_otps
    FOR ALL TO service_role USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on otp_logs" ON public.otp_logs
    FOR ALL TO service_role USING (true) WITH CHECK (true);
