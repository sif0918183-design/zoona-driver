-- ==============================================================================
-- Tracka Strict RLS Policies - Custom Session Token Compatible
-- ==============================================================================

-- Enable RLS on all tables
ALTER TABLE IF EXISTS public.customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ride_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.rides ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ride_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.ride_driver_accepts ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.driver_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.driver_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.driver_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.device_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.balance_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.complaints ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.travel_trips ENABLE ROW LEVEL SECURITY;

-- Revoke all modifications from anon/authenticated
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, service_role;

-- Grant permissions to anon and authenticated
GRANT SELECT ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT INSERT ON public.complaints TO anon, authenticated;
GRANT INSERT, UPDATE ON public.driver_locations TO anon, authenticated;

-- Grant INSERT, UPDATE, DELETE permissions on travel-platform related tables
GRANT INSERT, UPDATE, DELETE ON public.ride_requests TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.travel_trips TO anon, authenticated;

-- ==============================================================================
-- HELPER FUNCTION TO EXTRACT CUSTOM SESSION ID FROM REQUEST HEADERS
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.get_custom_session_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    headers text;
    auth_header text;
    token_b64 text;
    token_json text;
    user_id uuid;
BEGIN
    -- Get request headers from PostgREST settings
    headers := current_setting('request.headers', true);
    IF headers IS NULL OR headers = '' THEN
        RETURN NULL;
    END IF;

    -- Extract Authorization header
    auth_header := NULL;

    -- Check if it is a JSON array (PostgREST standard)
    IF headers LIKE '[%' THEN
        BEGIN
            auth_header := (
                SELECT x.val->>'value'
                FROM json_array_elements(headers::json) AS x(val)
                WHERE lower(x.val->>'key') = 'authorization'
                LIMIT 1
            );
        EXCEPTION WHEN OTHERS THEN
            auth_header := NULL;
        END;
    ELSIF headers LIKE '{%' THEN
        BEGIN
            auth_header := headers::json->>'authorization';
            IF auth_header IS NULL THEN
                auth_header := headers::json->>'Authorization';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            auth_header := NULL;
        END;
    END IF;

    -- Fallback regex search if JSON parsing failed or wasn't array/object
    IF auth_header IS NULL THEN
        BEGIN
            auth_header := substring(headers from '"[aA]uthorization"\s*:\s*"Bearer\s+([^"]+)"');
        EXCEPTION WHEN OTHERS THEN
            auth_header := NULL;
        END;
    END IF;

    -- Extract token from "Bearer <token>"
    IF auth_header IS NULL THEN
        RETURN NULL;
    END IF;

    IF auth_header LIKE 'Bearer %' OR auth_header LIKE 'bearer %' THEN
        token_b64 := substring(auth_header from 8);
    ELSE
        token_b64 := auth_header;
    END IF;

    IF token_b64 IS NULL OR token_b64 = '' THEN
        RETURN NULL;
    END IF;

    -- Decode Base64 to JSON string and parse id
    BEGIN
        token_json := convert_from(decode(token_b64, 'base64'), 'UTF-8');
        user_id := (token_json::json->>'id')::uuid;
        RETURN user_id;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
END;
$$;

-- ==============================================================================
-- CUSTOMERS - الراكب يرى بياناته فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Customers View Own Data" ON public.customers;
CREATE POLICY "Customers View Own Data" ON public.customers
    FOR SELECT TO anon, authenticated
    USING (id = public.get_custom_session_id());

-- ==============================================================================
-- DRIVERS - السائق يرى بياناته فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Drivers View Own Data" ON public.drivers;
CREATE POLICY "Drivers View Own Data" ON public.drivers
    FOR SELECT TO anon, authenticated
    USING (id = public.get_custom_session_id());

-- ==============================================================================
-- RIDE_REQUESTS - الراكب ينشئ ويرى طلباته، السائق يرى المتاحة والخاصة به
-- ==============================================================================
DROP POLICY IF EXISTS "Passenger View Own Requests" ON public.ride_requests;
DROP POLICY IF EXISTS "Driver View Pending Requests" ON public.ride_requests;
DROP POLICY IF EXISTS "Passenger Insert Own Requests" ON public.ride_requests;
DROP POLICY IF EXISTS "Passenger/Driver Update Own Requests" ON public.ride_requests;

CREATE POLICY "Passenger View Own Requests" ON public.ride_requests
    FOR SELECT TO anon, authenticated
    USING (
        customer_id = public.get_custom_session_id() OR
        driver_id = public.get_custom_session_id() OR
        status = 'pending'
    );

CREATE POLICY "Passenger Insert Own Requests" ON public.ride_requests
    FOR INSERT TO anon, authenticated
    WITH CHECK (
        customer_id = public.get_custom_session_id()
    );

CREATE POLICY "Passenger/Driver Update Own Requests" ON public.ride_requests
    FOR UPDATE TO anon, authenticated
    USING (
        customer_id = public.get_custom_session_id() OR
        driver_id = public.get_custom_session_id() OR
        status = 'pending'
    )
    WITH CHECK (true);

-- ==============================================================================
-- RIDES - المشاركون فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Participants View Own Rides" ON public.rides;
CREATE POLICY "Participants View Own Rides" ON public.rides
    FOR SELECT TO anon, authenticated
    USING (
        passenger_id = public.get_custom_session_id() OR
        driver_id = public.get_custom_session_id()
    );

-- ==============================================================================
-- DRIVER_LOCATIONS - السائق يكتب، الكل يقرأ
-- ==============================================================================
DROP POLICY IF EXISTS "Driver Insert Own Location" ON public.driver_locations;
DROP POLICY IF EXISTS "Driver Update Own Location" ON public.driver_locations;
DROP POLICY IF EXISTS "Anyone Read Driver Locations" ON public.driver_locations;

CREATE POLICY "Driver Insert Own Location" ON public.driver_locations
    FOR INSERT TO anon, authenticated
    WITH CHECK (driver_id = public.get_custom_session_id());

CREATE POLICY "Driver Update Own Location" ON public.driver_locations
    FOR UPDATE TO anon, authenticated
    USING (driver_id = public.get_custom_session_id())
    WITH CHECK (driver_id = public.get_custom_session_id());

CREATE POLICY "Anyone Read Driver Locations" ON public.driver_locations
    FOR SELECT TO anon, authenticated
    USING (true);

-- ==============================================================================
-- BALANCE_TRANSACTIONS - السائق يرى معاملاته فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Driver View Own Transactions" ON public.balance_transactions;
CREATE POLICY "Driver View Own Transactions" ON public.balance_transactions
    FOR SELECT TO anon, authenticated
    USING (driver_id = public.get_custom_session_id());

-- ==============================================================================
-- COMPLAINTS - الكل يرسل، الإداري يقرأ
-- ==============================================================================
DROP POLICY IF EXISTS "Anyone Insert Complaints" ON public.complaints;
DROP POLICY IF EXISTS "Admins View Complaints" ON public.complaints;

CREATE POLICY "Anyone Insert Complaints" ON public.complaints
    FOR INSERT TO anon, authenticated
    WITH CHECK (true);

CREATE POLICY "Admins View Complaints" ON public.complaints
    FOR SELECT TO service_role
    USING (true);

-- ==============================================================================
-- TRAVEL_TRIPS - المشاركون فقط
-- ==============================================================================
DROP POLICY IF EXISTS "Participants View Own Travel Trips" ON public.travel_trips;
DROP POLICY IF EXISTS "Participants Insert Travel Trips" ON public.travel_trips;
DROP POLICY IF EXISTS "Participants Update Travel Trips" ON public.travel_trips;

CREATE POLICY "Participants View Own Travel Trips" ON public.travel_trips
    FOR SELECT TO anon, authenticated
    USING (
        passenger_id = public.get_custom_session_id() OR
        driver_id = public.get_custom_session_id()
    );

CREATE POLICY "Participants Insert Travel Trips" ON public.travel_trips
    FOR INSERT TO anon, authenticated
    WITH CHECK (
        passenger_id = public.get_custom_session_id() OR
        driver_id = public.get_custom_session_id()
    );

CREATE POLICY "Participants Update Travel Trips" ON public.travel_trips
    FOR UPDATE TO anon, authenticated
    USING (
        passenger_id = public.get_custom_session_id() OR
        driver_id = public.get_custom_session_id()
    )
    WITH CHECK (true);
