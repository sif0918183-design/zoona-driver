-- Add missing timestamp columns to the rides table
ALTER TABLE rides ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;

-- Add commission hold columns
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_held DECIMAL(10,2) DEFAULT 0;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS commission_held_at TIMESTAMPTZ;
ALTER TABLE rides ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Add ban columns to drivers table
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_banned BOOLEAN DEFAULT false;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ban_reason TEXT;
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS ban_until TIMESTAMPTZ;

-- Create balance_transactions table if not exists
CREATE TABLE IF NOT EXISTS balance_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    driver_id UUID REFERENCES drivers(id),
    ride_id UUID REFERENCES rides(id),
    amount DECIMAL(10,2) NOT NULL,
    type VARCHAR(50) NOT NULL,
    description TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
