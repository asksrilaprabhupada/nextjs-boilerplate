-- Phase 6 timeout-headroom fix, PREPARED BUT NOT APPLIED.
--
-- Observed before this migration:
--   * service_role has no explicit statement_timeout and therefore inherits
--     the Data API authenticator role's 8 second timeout.
--   * a warmed, serial transcript retrieval took 7,988.770 ms, leaving only
--     11.230 ms of headroom. The acceptance gate requires at least 1,500 ms.
--
-- Effect and expected load:
--   * set only service_role statement_timeout to 20 seconds;
--   * reload PostgREST configuration so new Data API sessions see it;
--   * no corpus rows or indexes are scanned or rewritten.
--
-- Rollback:
--   supabase/rollbacks/20260803223000_reset_service_role_search_timeout.sql
--
-- Apply only after a fresh exact owner approval packet. After application,
-- verify through the preview application's real service-role Data API path.

ALTER ROLE service_role SET statement_timeout = '20s';

DO $verify$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_roles AS role
    CROSS JOIN LATERAL unnest(COALESCE(role.rolconfig, ARRAY[]::text[])) AS setting(value)
    WHERE role.rolname = 'service_role'
      AND setting.value = 'statement_timeout=20s'
  ) THEN
    RAISE EXCEPTION 'service_role statement_timeout was not set to 20s';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload config';
