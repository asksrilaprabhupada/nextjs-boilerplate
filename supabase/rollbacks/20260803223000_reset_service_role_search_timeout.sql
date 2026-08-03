-- Non-destructive rollback for the Phase 6 service-role timeout change.
-- Restores service_role to inheritance from the authenticator role and reloads
-- PostgREST configuration. This does not alter authenticator itself.

ALTER ROLE service_role RESET statement_timeout;

NOTIFY pgrst, 'reload config';
