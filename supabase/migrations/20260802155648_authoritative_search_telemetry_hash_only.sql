-- Deep Research V2 - Phase 3: authoritative technical search telemetry.
--
-- This migration is additive. It does not touch corpus tables, embeddings, or
-- retrieval indexes. The two RPCs are service-role-only lifecycle writers:
-- `begin_search_run` creates the row before paid/search work starts, and
-- `complete_search_run` finalises that same row before the response closes.
-- Ordinary rows are hash-only. Raw fields require an explicit capture flag;
-- the application does not set that flag outside a future owner diagnostic.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE public.search_logs
  ADD COLUMN IF NOT EXISTS request_id text,
  ADD COLUMN IF NOT EXISTS environment text,
  ADD COLUMN IF NOT EXISTS deployment_sha text,
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS failed_stage text,
  ADD COLUMN IF NOT EXISTS error_code text,
  ADD COLUMN IF NOT EXISTS stage_durations_ms jsonb,
  ADD COLUMN IF NOT EXISTS source_durations_ms jsonb,
  ADD COLUMN IF NOT EXISTS telemetry jsonb,
  ADD COLUMN IF NOT EXISTS started_at timestamptz,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS search_logs_request_id_unique
  ON public.search_logs (request_id)
  WHERE request_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS search_logs_status_started_at_idx
  ON public.search_logs (status, started_at DESC);

DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.search_logs'::regclass
      AND conname = 'search_logs_status_known'
  ) THEN
    ALTER TABLE public.search_logs
      ADD CONSTRAINT search_logs_status_known
      CHECK (status IS NULL OR status IN ('running', 'success', 'degraded', 'failed', 'abandoned'))
      NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint
    WHERE conrelid = 'public.search_logs'::regclass
      AND conname = 'search_logs_environment_known'
  ) THEN
    ALTER TABLE public.search_logs
      ADD CONSTRAINT search_logs_environment_known
      CHECK (environment IS NULL OR environment IN ('preview', 'production'))
      NOT VALID;
  END IF;
END
$constraints$;

ALTER TABLE public.search_logs VALIDATE CONSTRAINT search_logs_status_known;
ALTER TABLE public.search_logs VALIDATE CONSTRAINT search_logs_environment_known;

COMMENT ON COLUMN public.search_logs.request_id IS
  'Application correlation id. Unique for lifecycle-written rows.';
COMMENT ON COLUMN public.search_logs.telemetry IS
  'Strictly allowlisted technical facts only; never passage text, provider responses, or arbitrary errors.';
COMMENT ON COLUMN public.search_logs.source_durations_ms IS
  'Object keyed by internal retrieval function with numeric elapsed milliseconds.';

CREATE OR REPLACE FUNCTION public.begin_search_run(
  p_request_id text,
  p_question_hash text,
  p_environment text,
  p_deployment_sha text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_hash text;
BEGIN
  IF NULLIF(btrim(p_request_id), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'request id is required';
  END IF;

  v_hash := lower(btrim(p_question_hash));
  IF p_environment IS NULL OR p_environment NOT IN ('preview', 'production') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'known environment is required';
  END IF;

  IF v_hash IS NULL OR v_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'question hash must be 64 lowercase hex characters';
  END IF;

  INSERT INTO public.search_logs (
    query,
    query_normalized,
    search_method,
    source,
    request_id,
    environment,
    deployment_sha,
    status,
    started_at
  ) VALUES (
    'sha256:' || v_hash,
    'sha256:' || v_hash,
    'pending',
    'web',
    p_request_id,
    p_environment,
    NULLIF(btrim(p_deployment_sha), ''),
    'running',
    clock_timestamp()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.complete_search_run(
  p_request_id text,
  p_status text,
  p_query text DEFAULT NULL,
  p_visitor_id text DEFAULT NULL,
  p_total_results integer DEFAULT 0,
  p_verse_ids uuid[] DEFAULT '{}'::uuid[],
  p_prose_ids uuid[] DEFAULT '{}'::uuid[],
  p_books_returned text[] DEFAULT '{}'::text[],
  p_search_method text DEFAULT 'pipeline',
  p_total_duration_ms integer DEFAULT NULL,
  p_source text DEFAULT 'web',
  p_user_agent text DEFAULT NULL,
  p_referrer text DEFAULT NULL,
  p_query_variants text[] DEFAULT '{}'::text[],
  p_failed_stage text DEFAULT NULL,
  p_error_code text DEFAULT NULL,
  p_stage_durations_ms jsonb DEFAULT '{}'::jsonb,
  p_source_durations_ms jsonb DEFAULT '{}'::jsonb,
  p_telemetry jsonb DEFAULT '{}'::jsonb,
  p_capture_raw boolean DEFAULT false
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = ''
AS $function$
DECLARE
  v_id uuid;
  v_normalized text;
BEGIN
  IF p_status IS NULL OR p_status NOT IN ('success', 'degraded', 'failed', 'abandoned') THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'unknown terminal search status';
  END IF;

  IF NOT COALESCE(p_capture_raw, false) AND (
    p_query IS NOT NULL
    OR p_visitor_id IS NOT NULL
    OR p_user_agent IS NOT NULL
    OR p_referrer IS NOT NULL
    OR cardinality(COALESCE(p_query_variants, '{}'::text[])) > 0
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'ordinary searches must remain hash-only';
  END IF;

  IF COALESCE(p_capture_raw, false) AND NULLIF(btrim(p_query), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '22023', MESSAGE = 'diagnostic raw capture requires a query';
  END IF;

  v_normalized := CASE
    WHEN p_query IS NULL THEN NULL
    ELSE lower(btrim(p_query))
  END;

  UPDATE public.search_logs
  SET
    query = CASE WHEN p_capture_raw THEN p_query ELSE query END,
    query_normalized = CASE WHEN p_capture_raw THEN v_normalized ELSE query_normalized END,
    visitor_id = CASE WHEN p_capture_raw THEN p_visitor_id ELSE NULL END,
    total_results = GREATEST(COALESCE(p_total_results, 0), 0),
    verse_ids = COALESCE(p_verse_ids, '{}'::uuid[]),
    prose_ids = COALESCE(p_prose_ids, '{}'::uuid[]),
    books_returned = COALESCE(p_books_returned, '{}'::text[]),
    search_method = p_search_method,
    total_duration_ms = p_total_duration_ms,
    source = p_source,
    user_agent = CASE WHEN p_capture_raw THEN p_user_agent ELSE NULL END,
    referrer = CASE WHEN p_capture_raw THEN p_referrer ELSE NULL END,
    query_variants = CASE
      WHEN p_capture_raw THEN COALESCE(p_query_variants, '{}'::text[])
      ELSE '{}'::text[]
    END,
    status = p_status,
    failed_stage = p_failed_stage,
    error_code = p_error_code,
    stage_durations_ms = COALESCE(p_stage_durations_ms, '{}'::jsonb),
    source_durations_ms = COALESCE(p_source_durations_ms, '{}'::jsonb),
    telemetry = COALESCE(p_telemetry, '{}'::jsonb),
    completed_at = clock_timestamp(),
    updated_at = clock_timestamp()
  WHERE request_id = p_request_id
    AND status = 'running'
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = 'running search row not found';
  END IF;

  RETURN v_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.begin_search_run(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_search_run(
  text, text, text, text, integer, uuid[], uuid[], text[], text, integer,
  text, text, text, text[], text, text, jsonb, jsonb, jsonb, boolean
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.begin_search_run(text, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_search_run(
  text, text, text, text, integer, uuid[], uuid[], text[], text, integer,
  text, text, text, text[], text, text, jsonb, jsonb, jsonb, boolean
) TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

-- Documented manual maintenance only; do not schedule it in this task:
--
-- UPDATE public.search_logs
-- SET status = 'abandoned',
--     completed_at = clock_timestamp(),
--     updated_at = clock_timestamp()
-- WHERE status = 'running'
--   AND started_at < clock_timestamp() - interval '10 minutes'
-- RETURNING id, request_id, started_at;

-- Non-destructive rollback: deploy the previous application commit. These
-- nullable columns, indexes, constraints, and service-role-only functions can
-- remain inert. Removing schema is intentionally outside this task's no-DROP
-- boundary and would require a separate approved maintenance change.
