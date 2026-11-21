-- ==============================================================================
-- Secure custom session ID extraction
-- Requires:
--   1. pgcrypto installed in the extensions schema.
--   2. Supabase Vault secret named TRACKA_SESSION_TOKEN_SECRET.
-- This function validates the existing Node.js HMAC-SHA256 token format:
--   <base64url(payload)>.<base64url(signature)>
-- It does not change any RLS policy definitions.
-- ==============================================================================

CREATE OR REPLACE FUNCTION public.get_custom_session_id()
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    headers_text text;
    headers_json jsonb;
    auth_header text;
    token_text text;
    payload_b64 text;
    signature_b64 text;
    payload_bytes bytea;
    payload_json jsonb;
    secret_value text;
    expected_signature bytea;
    provided_signature bytea;
    difference integer := 0;
    i integer;
    session_id uuid;
    session_role text;
    expires_at_ms numeric;
BEGIN
    headers_text := current_setting('request.headers', true);
    IF headers_text IS NULL OR headers_text = '' THEN
        RETURN NULL;
    END IF;

    BEGIN
        headers_json := headers_text::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    IF jsonb_typeof(headers_json) = 'object' THEN
        auth_header := COALESCE(headers_json ->> 'x-session-token', headers_json ->> 'X-Session-Token');
        IF auth_header IS NULL THEN
            auth_header := COALESCE(headers_json ->> 'authorization', headers_json ->> 'Authorization');
        END IF;
    ELSIF jsonb_typeof(headers_json) = 'array' THEN
        SELECT element ->> 'value' INTO auth_header
          FROM jsonb_array_elements(headers_json) AS element
         WHERE lower(element ->> 'key') = 'x-session-token' LIMIT 1;
        IF auth_header IS NULL THEN
            SELECT element ->> 'value' INTO auth_header
              FROM jsonb_array_elements(headers_json) AS element
             WHERE lower(element ->> 'key') = 'authorization' LIMIT 1;
        END IF;
    END IF;

    IF auth_header IS NULL OR auth_header = '' THEN RETURN NULL; END IF;
    IF auth_header ~* '^Bearer[[:space:]]+' THEN
        token_text := regexp_replace(auth_header, '^Bearer[[:space:]]+', '', 'i');
    ELSE
        token_text := auth_header;
    END IF;

    IF token_text IS NULL OR length(token_text) > 4096
       OR length(token_text) - length(replace(token_text, '.', '')) <> 1 THEN
        RETURN NULL;
    END IF;

    payload_b64 := split_part(token_text, '.', 1);
    signature_b64 := split_part(token_text, '.', 2);
    IF payload_b64 !~ '^[A-Za-z0-9_-]+$'
       OR signature_b64 !~ '^[A-Za-z0-9_-]+$'
       OR length(signature_b64) <> 43 THEN
        RETURN NULL;
    END IF;

    BEGIN
        payload_bytes := decode(
            translate(payload_b64, '-_', '+/') || repeat('=', (4 - length(payload_b64) % 4) % 4),
            'base64'
        );
        provided_signature := decode(translate(signature_b64, '-_', '+/') || '=', 'base64');
        payload_json := convert_from(payload_bytes, 'UTF8')::jsonb;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    IF jsonb_typeof(payload_json) <> 'object' THEN RETURN NULL; END IF;
    IF COALESCE(payload_json ->> 'id', '') !~
       '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
        RETURN NULL;
    END IF;

    session_role := payload_json ->> 'role';
    IF session_role NOT IN ('passenger', 'driver', 'admin') THEN RETURN NULL; END IF;

    BEGIN
        expires_at_ms := (payload_json ->> 'exp')::numeric;
        session_id := (payload_json ->> 'id')::uuid;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;

    IF expires_at_ms IS NULL
       OR expires_at_ms <= floor(extract(epoch FROM clock_timestamp()) * 1000) THEN
        RETURN NULL;
    END IF;

    SELECT decrypted_secret INTO secret_value
      FROM vault.decrypted_secrets
     WHERE name = 'TRACKA_SESSION_TOKEN_SECRET' LIMIT 1;
    IF secret_value IS NULL OR secret_value = '' THEN RETURN NULL; END IF;

    expected_signature := extensions.hmac(
        convert_to(payload_b64, 'UTF8'),
        convert_to(secret_value, 'UTF8'),
        'sha256'
    );
    IF octet_length(provided_signature) <> 32 THEN RETURN NULL; END IF;

    FOR i IN 0..31 LOOP
        difference := difference | (get_byte(provided_signature, i) # get_byte(expected_signature, i));
    END LOOP;
    IF difference <> 0 THEN RETURN NULL; END IF;

    RETURN session_id;
EXCEPTION WHEN OTHERS THEN
    RETURN NULL;
END;
$function$;
