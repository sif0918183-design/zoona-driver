-- ==============================================================================
-- Grant passenger access to driver_locations table
-- This allows passengers to read driver location for tracking their ride
-- ==============================================================================

-- Enable RLE (Row Level Security) on driver_locations if not already enabled
ALTER TABLE driver_locations ENABLE ROW LEVEL SECURITY;

-- Create policy to allow passengers to read driver locations for their rides
-- This policy checks if there's an active ride for the passenger with this driver
CREATE OR REPLACE POLICY "Passengers can read driver locations for their rides"
ON driver_locations
FOR SELECT
TO authenticated
USING (
    -- Check if there's an active ride (accepted, arrived, ongoing) for this passenger
    -- that matches the driver_id in driver_locations
    EXISTS (
        SELECT 1 FROM rides r
        WHERE r.driver_id = driver_locations.driver_id
        AND r.passenger_id = auth.uid()
        AND r.status IN ('accepted', 'arrived', 'ongoing')
    )
);

-- Also allow drivers to read their own location
CREATE OR REPLACE POLICY "Drivers can read their own location"
ON driver_locations
FOR SELECT
TO authenticated
USING (
    driver_id = auth.uid()
);

-- Grant read access to passengers for driver locations related to their rides
-- This is handled by the RLS policies above
GRANT SELECT ON driver_locations TO authenticated;

COMMENT ON POLICY "Passengers can read driver locations for their rides" ON driver_locations 
IS 'Allows passengers to track their driver location during an active ride';

COMMENT ON POLICY "Drivers can read their own location" ON driver_locations 
IS 'Allows drivers to update their own location';