-- ============================================================================
-- جدول الشكاوى والمقترحات لتطبيق تراكا
-- ============================================================================

-- إنشاء الجدول
CREATE TABLE IF NOT EXISTS complaints (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name TEXT NOT NULL,
    user_type TEXT NOT NULL CHECK (user_type IN ('driver', 'passenger')),
    whatsapp TEXT,
    phone TEXT NOT NULL,
    complaint_type TEXT NOT NULL,
    description TEXT NOT NULL,
    rating INTEGER DEFAULT 0 CHECK (rating >= 0 AND rating <= 5),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- إنشاء فهارس لتحسين الأداء
CREATE INDEX IF NOT EXISTS idx_complaints_user_type ON complaints(user_type);
CREATE INDEX IF NOT EXISTS idx_complaints_complaint_type ON complaints(complaint_type);
CREATE INDEX IF NOT EXISTS idx_complaints_created_at ON complaints(created_at DESC);

-- تفعيل Row Level Security
ALTER TABLE complaints ENABLE ROW LEVEL SECURITY;

-- سياسة للقراءة (القراءة للجميع)
CREATE POLICY "Allow read access to all users" ON complaints
    FOR SELECT USING (true);

-- سياسة للكتابة (الكتابة للجميع)
CREATE POLICY "Allow insert access to all users" ON complaints
    FOR INSERT WITH CHECK (true);

-- سياسة للتحديث (التحديث للجميع)
CREATE POLICY "Allow update access to all users" ON complaints
    FOR UPDATE USING (true);

-- سياسة للحذف (الحذف للجميع)
CREATE POLICY "Allow delete access to all users" ON complaints
    FOR DELETE USING (true);

-- Trigger لتحديث تاريخ التعديل تلقائياً
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_complaints_updated_at
    BEFORE UPDATE ON complaints
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- ملاحظة: هذا الملف يحتوي على جميع الإعدادات المطلوبة لجدول الشكاوى
-- قم بتشغيل هذا الملف في Supabase SQL Editor
-- ============================================================================