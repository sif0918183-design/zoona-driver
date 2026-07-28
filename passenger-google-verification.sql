-- ==============================================================================
-- SQL Migration: Add Google Auth Sync and Turnstile Verification Fields
-- Table: public.customers (الركاب)
-- ==============================================================================

-- 1. Add google_id and google_email columns to customers table if they don't exist
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS google_id TEXT;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS google_email TEXT;

-- 2. Add indexes for fast search and linking
CREATE INDEX IF NOT EXISTS idx_customers_google_id ON public.customers(google_id);
CREATE INDEX IF NOT EXISTS idx_customers_google_email ON public.customers(google_email);

-- 3. Row Level Security (RLS) Configuration and Policies
-- Ensure RLS is enabled on the customers table (already enabled in security.sql, but keeping it robust)
ALTER TABLE IF EXISTS public.customers ENABLE ROW LEVEL SECURITY;

-- Note on access control:
-- Direct client mutations (INSERT, UPDATE, DELETE) are disabled for anon and authenticated roles.
-- Read access (SELECT) is restricted to the logged-in user themselves via 'get_custom_session_id()' helper function.
-- Sensitive mutations (like registration, Turnstile verification, and Google Sync validation) are securely
-- routed through Vercel Serverless Functions under `api/` using the service_role key to bypass RLS safely.

DROP POLICY IF EXISTS "Customers View Own Data" ON public.customers;
CREATE POLICY "Customers View Own Data" ON public.customers
    FOR SELECT TO anon, authenticated
    USING (id = public.get_custom_session_id());
