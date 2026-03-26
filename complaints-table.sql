-- =====================================================
-- جدول الشكاوى والمقترحات - Complaints Table for Zoona
-- =====================================================

-- إنشاء الجدول
CREATE TABLE IF NOT EXISTS public.complaints (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id TEXT NOT NULL,
    user_type TEXT NOT NULL CHECK (user_type IN ('driver', 'passenger')),
    user_name TEXT NOT NULL,
    account_type TEXT,
    whatsapp TEXT,
    phone TEXT NOT NULL,
    complaint_type TEXT,
    message TEXT NOT NULL,
    rating INTEGER CHECK (rating >= 0 AND rating <= 5),
    status TEXT DEFAULT 'new' CHECK (status IN ('new', 'read', 'replied', 'resolved')),
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_complaints_user_id ON public.complaints(user_id);
CREATE INDEX IF NOT EXISTS idx_complaints_user_type ON public.complaints(user_type);
CREATE INDEX IF NOT EXISTS idx_complaints_status ON public.complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_created_at ON public.complaints(created_at DESC);

-- =====================================================
-- Row Level Security (RLS) Policies
-- =====================================================

-- Enable RLS
ALTER TABLE public.complaints ENABLE ROW LEVEL SECURITY;

-- Policy: Allow all users to insert their own complaints
CREATE POLICY "Users can insert their own complaints" ON public.complaints
    FOR INSERT
    WITH CHECK (true); -- Allow all insertions (client-side auth will be handled by app)

-- Policy: Allow all users to view complaints (for admin panel)
CREATE POLICY "Anyone can view complaints" ON public.complaints
    FOR SELECT
    USING (true);

-- Policy: Allow all users to update their own complaints
CREATE POLICY "Anyone can update complaints" ON public.complaints
    FOR UPDATE
    USING (true);

-- Policy: Allow all users to delete complaints
CREATE POLICY "Anyone can delete complaints" ON public.complaints
    FOR DELETE
    USING (true);

-- =====================================================
-- Function to auto-update updated_at timestamp
-- =====================================================
CREATE OR REPLACE FUNCTION public.update_complaints_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at
CREATE TRIGGER set_complaints_updated_at
    BEFORE UPDATE ON public.complaints
    FOR EACH ROW
    EXECUTE FUNCTION public.update_complaints_updated_at();

-- =====================================================
-- ملخص الأعمدة:
-- id: معرف فريد للشكوى (UUID)
-- user_id: معرف المستخدم من تطبيق الركاب/السائق
-- user_type: نوع المستخدم (driver أو passenger)
-- user_name: اسم المستخدم
-- account_type: نوع الحساب (سائق، راكب، إلخ)
-- whatsapp: رقم الواتساب
-- phone: رقم الهاتف
-- complaint_type: نوع الشكوى
-- message: نص الشكوى
-- rating: التقييم (1-5)
-- status: حالة الشكوى (new, read, replied, resolved)
-- created_at: تاريخ الإنشاء
-- updated_at: تاريخ التحديث
-- =====================================================