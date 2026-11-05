-- ==============================================================================
-- Migration: Support Signed HMAC Tokens in get_custom_session_id()
-- Purpose: Extract session ID from both signed tokens (payload.signature)
--          and legacy unsigned base64 tokens, enabling proper RLS evaluations.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_custom_session_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
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

    auth_header := NULL;

    -- Check if it is a JSON array (PostgREST standard)
    IF headers LIKE '[%' THEN
        BEGIN
            -- Try x-session-token first
            auth_header := (
                SELECT x.val->>'value'
                FROM json_array_elements(headers::json) AS x(val)
                WHERE lower(x.val->>'key') = 'x-session-token'
                LIMIT 1
            );

            -- Fallback to authorization
            IF auth_header IS NULL THEN
                auth_header := (
                    SELECT x.val->>'value'
                    FROM json_array_elements(headers::json) AS x(val)
                    WHERE lower(x.val->>'key') = 'authorization'
                    LIMIT 1
                );
            END IF;
        EXCEPTION WHEN OTHERS THEN
            auth_header := NULL;
        END;
    ELSIF headers LIKE '{%' THEN
        BEGIN
            auth_header := headers::json->>'x-session-token';
            IF auth_header IS NULL THEN
                auth_header := headers::json->>'authorization';
            END IF;
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
            auth_header := substring(headers from '"x-session-token"\s*:\s*"([^"]+)"');
        EXCEPTION WHEN OTHERS THEN
            auth_header := NULL;
        END;
    END IF;

    IF auth_header IS NULL THEN
        BEGIN
            auth_header := substring(headers from '"[aA]uthorization"\s*:\s*"Bearer\s+([^"]+)"');
        EXCEPTION WHEN OTHERS THEN
            auth_header := NULL;
        END;
    END IF;

    -- Extract token from "Bearer <token>" or raw string
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

    -- Handle signed tokens (payload.signature): extract payload part before the dot
    IF position('.' in token_b64) > 0 THEN
        token_b64 := split_part(token_b64, '.', 1);
    END IF;

    -- Normalize Base64URL to standard Base64 for PostgreSQL
    token_b64 := replace(replace(token_b64, '-', '+'), '_', '/');
    WHILE length(token_b64) % 4 <> 0 LOOP
        token_b64 := token_b64 || '=';
    END LOOP;

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
