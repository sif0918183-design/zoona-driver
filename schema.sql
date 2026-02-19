-- SQL Schema for Push Notifications Subscription
-- Run this in your Supabase SQL Editor

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  keys JSONB NOT NULL,
  user_id UUID NOT NULL,
  app_type TEXT NOT NULL CHECK (app_type IN ('passenger', 'driver')),
  user_agent TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Index for faster lookups by user_id
CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user_id ON push_subscriptions(user_id);

-- Policy to allow users to manage their own subscriptions (if using RLS)
-- ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Users can manage their own subscriptions" ON push_subscriptions
--   FOR ALL USING (auth.uid() = user_id);
