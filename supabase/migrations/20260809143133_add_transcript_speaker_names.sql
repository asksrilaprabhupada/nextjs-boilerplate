-- OWNER APPROVAL REQUIRED. DO NOT APPLY AUTOMATICALLY.
--
-- Additive schema packet for deterministic transcript-speaker attribution.
-- This migration adds metadata only. It performs no paragraph backfill and
-- creates no speaker index.

BEGIN;

SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
DECLARE
  v_table_oid oid := pg_catalog.to_regclass('public.transcript_paragraphs');
  v_column_type oid;
  v_column_not_null boolean;
  v_column_default text;
  v_rls_enabled boolean;
  v_vector_function oid := pg_catalog.to_regprocedure('public.body_search_vectors_trigger()');
  v_function_fingerprint text;
  v_function_config text[];
  v_expected_function_fingerprint constant text := '2b79af99b4080b9c2c0b80ef8a642074';
  v_expected_function_config constant text[] := ARRAY['search_path=public, pg_temp'];
  v_body_text_attnum smallint;
  v_expansion_src_attnum smallint;
  v_fts_core_attnum smallint;
  v_expected_trigger_columns text;
  v_trigger_type smallint;
  v_trigger_enabled text;
  v_trigger_function oid;
  v_trigger_columns text;
  v_trigger_has_condition boolean;
  v_trigger_argument_count smallint;
BEGIN
  IF v_table_oid IS NULL THEN
    RAISE EXCEPTION 'preflight failed: public.transcript_paragraphs does not exist';
  END IF;

  SELECT c.relrowsecurity
  INTO v_rls_enabled
  FROM pg_catalog.pg_class AS c
  WHERE c.oid = v_table_oid;

  IF NOT COALESCE(v_rls_enabled, false) THEN
    RAISE EXCEPTION 'preflight failed: RLS is not enabled on public.transcript_paragraphs';
  END IF;

  SELECT
    a.atttypid,
    a.attnotnull,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  INTO
    v_column_type,
    v_column_not_null,
    v_column_default
  FROM pg_catalog.pg_attribute AS a
  LEFT JOIN pg_catalog.pg_attrdef AS d
    ON d.adrelid = a.attrelid
   AND d.adnum = a.attnum
  WHERE a.attrelid = v_table_oid
    AND a.attname = 'speaker_names'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF FOUND AND (
    v_column_type <> 'text[]'::pg_catalog.regtype
    OR v_column_not_null
    OR v_column_default IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'preflight failed: speaker_names exists with an incompatible shape';
  END IF;

  IF v_vector_function IS NULL THEN
    RAISE EXCEPTION 'preflight failed: public.body_search_vectors_trigger() does not exist';
  END IF;

  -- Pin the exact trigger-function body and function-level search_path from
  -- 20260708120000_tags_fts_rebuild_columns_and_fts_core.sql. The fingerprint
  -- is calculated over the raw pg_proc.prosrc bytes; no case or whitespace is
  -- discarded. Refuse any body or configuration drift.
  SELECT pg_catalog.md5(p.prosrc), p.proconfig
  INTO v_function_fingerprint, v_function_config
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_language AS l
    ON l.oid = p.prolang
  WHERE p.oid = v_vector_function
    AND p.prokind = 'f'
    AND p.pronargs = 0
    AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND l.lanname = 'plpgsql'
    AND p.provolatile = 'v'
    AND NOT p.prosecdef;

  IF v_function_fingerprint IS DISTINCT FROM v_expected_function_fingerprint
     OR v_function_config IS DISTINCT FROM v_expected_function_config THEN
    RAISE EXCEPTION 'preflight failed: body_search_vectors_trigger() body, search_path, or properties are unexpected';
  END IF;

  SELECT
    MAX(a.attnum) FILTER (WHERE a.attname = 'body_text'),
    MAX(a.attnum) FILTER (WHERE a.attname = 'fts_expansion_src'),
    MAX(a.attnum) FILTER (WHERE a.attname = 'fts_core')
  INTO
    v_body_text_attnum,
    v_expansion_src_attnum,
    v_fts_core_attnum
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = v_table_oid
    AND a.attname IN ('body_text', 'fts_expansion_src', 'fts_core')
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF v_body_text_attnum IS NULL
     OR v_expansion_src_attnum IS NULL
     OR v_fts_core_attnum IS NULL THEN
    RAISE EXCEPTION 'preflight failed: transcript vector-source/touch columns are missing';
  END IF;

  v_expected_trigger_columns := pg_catalog.format(
    '%s %s %s',
    v_body_text_attnum,
    v_expansion_src_attnum,
    v_fts_core_attnum
  );

  SELECT
    t.tgtype,
    t.tgenabled::text,
    t.tgfoid,
    COALESCE(t.tgattr::text, ''),
    t.tgqual IS NOT NULL,
    t.tgnargs
  INTO
    v_trigger_type,
    v_trigger_enabled,
    v_trigger_function,
    v_trigger_columns,
    v_trigger_has_condition,
    v_trigger_argument_count
  FROM pg_catalog.pg_trigger AS t
  WHERE t.tgrelid = v_table_oid
    AND t.tgname = 'trg_transcript_search_vectors'
    AND NOT t.tgisinternal;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'preflight failed: transcript search-vector trigger is missing';
  END IF;

  IF v_trigger_type <> 23
     OR v_trigger_enabled <> 'O'
     OR v_trigger_function <> v_vector_function
     OR v_trigger_has_condition
     OR v_trigger_argument_count <> 0
     OR v_trigger_columns NOT IN ('', v_expected_trigger_columns) THEN
    RAISE EXCEPTION 'preflight failed: transcript search-vector trigger shape is unexpected';
  END IF;
END
$preflight$;

ALTER TABLE public.transcript_paragraphs
  ADD COLUMN IF NOT EXISTS speaker_names text[];

COMMENT ON COLUMN public.transcript_paragraphs.speaker_names IS
  'Ordered, de-duplicated proved speakers: NULL means not processed; an empty array means processed but no speaker was proved; Speaker not identified records a genuinely unknown portion alongside known speakers.';

-- The existing trigger recalculates FTS vectors for every row update. Limit it
-- to inserts, source changes, and the established fts_core self-touch used by
-- scripts/tags-rebuild/backfill_fts_core.py. Speaker-only updates still bypass
-- vector recomputation without breaking that active repair workflow.
DROP TRIGGER IF EXISTS trg_transcript_search_vectors
  ON public.transcript_paragraphs;

CREATE TRIGGER trg_transcript_search_vectors
  BEFORE INSERT OR UPDATE OF body_text, fts_expansion_src, fts_core
  ON public.transcript_paragraphs
  FOR EACH ROW
  EXECUTE FUNCTION public.body_search_vectors_trigger();

DO $verify$
DECLARE
  v_table_oid oid := pg_catalog.to_regclass('public.transcript_paragraphs');
  v_column_type oid;
  v_column_not_null boolean;
  v_column_default text;
  v_rls_enabled boolean;
  v_function_fingerprint text;
  v_function_config text[];
  v_trigger_definition text;
  v_body_text_attnum smallint;
  v_expansion_src_attnum smallint;
  v_fts_core_attnum smallint;
  v_trigger_columns text;
  v_trigger_enabled text;
  v_trigger_has_condition boolean;
  v_trigger_argument_count smallint;
BEGIN
  IF v_table_oid IS NULL THEN
    RAISE EXCEPTION 'verification failed: public.transcript_paragraphs does not exist';
  END IF;

  SELECT c.relrowsecurity
  INTO v_rls_enabled
  FROM pg_catalog.pg_class AS c
  WHERE c.oid = v_table_oid;

  IF NOT COALESCE(v_rls_enabled, false) THEN
    RAISE EXCEPTION 'verification failed: RLS is not enabled on public.transcript_paragraphs';
  END IF;

  SELECT
    a.atttypid,
    a.attnotnull,
    pg_catalog.pg_get_expr(d.adbin, d.adrelid)
  INTO
    v_column_type,
    v_column_not_null,
    v_column_default
  FROM pg_catalog.pg_attribute AS a
  LEFT JOIN pg_catalog.pg_attrdef AS d
    ON d.adrelid = a.attrelid
   AND d.adnum = a.attnum
  WHERE a.attrelid = v_table_oid
    AND a.attname = 'speaker_names'
    AND a.attnum > 0
    AND NOT a.attisdropped;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'verification failed: speaker_names was not created';
  END IF;

  IF v_column_type <> 'text[]'::pg_catalog.regtype
     OR v_column_not_null
     OR v_column_default IS NOT NULL THEN
    RAISE EXCEPTION 'verification failed: speaker_names is not nullable text[] without a default';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index AS i
    WHERE i.indrelid = v_table_oid
      AND pg_catalog.strpos(
        pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
        'speaker_names'
      ) > 0
  ) THEN
    RAISE EXCEPTION 'verification failed: speaker_names must not be indexed';
  END IF;

  SELECT pg_catalog.md5(p.prosrc), p.proconfig
  INTO v_function_fingerprint, v_function_config
  FROM pg_catalog.pg_proc AS p
  JOIN pg_catalog.pg_language AS l
    ON l.oid = p.prolang
  WHERE p.oid = pg_catalog.to_regprocedure('public.body_search_vectors_trigger()')
    AND p.prokind = 'f'
    AND p.pronargs = 0
    AND p.prorettype = 'pg_catalog.trigger'::pg_catalog.regtype
    AND l.lanname = 'plpgsql'
    AND p.provolatile = 'v'
    AND NOT p.prosecdef;

  IF v_function_fingerprint IS DISTINCT FROM '2b79af99b4080b9c2c0b80ef8a642074'
     OR v_function_config IS DISTINCT FROM ARRAY['search_path=public, pg_temp']::text[] THEN
    RAISE EXCEPTION 'verification failed: body_search_vectors_trigger() drifted';
  END IF;

  SELECT
    MAX(a.attnum) FILTER (WHERE a.attname = 'body_text'),
    MAX(a.attnum) FILTER (WHERE a.attname = 'fts_expansion_src'),
    MAX(a.attnum) FILTER (WHERE a.attname = 'fts_core')
  INTO
    v_body_text_attnum,
    v_expansion_src_attnum,
    v_fts_core_attnum
  FROM pg_catalog.pg_attribute AS a
  WHERE a.attrelid = v_table_oid
    AND a.attname IN ('body_text', 'fts_expansion_src', 'fts_core')
    AND a.attnum > 0
    AND NOT a.attisdropped;

  SELECT
    pg_catalog.pg_get_triggerdef(t.oid, true),
    t.tgenabled::text,
    COALESCE(t.tgattr::text, ''),
    t.tgqual IS NOT NULL,
    t.tgnargs
  INTO
    v_trigger_definition,
    v_trigger_enabled,
    v_trigger_columns,
    v_trigger_has_condition,
    v_trigger_argument_count
  FROM pg_catalog.pg_trigger AS t
  WHERE t.tgrelid = v_table_oid
    AND t.tgname = 'trg_transcript_search_vectors'
    AND NOT t.tgisinternal
    AND t.tgtype = 23
    AND t.tgfoid = pg_catalog.to_regprocedure('public.body_search_vectors_trigger()');

  IF v_trigger_definition IS NULL
     OR v_body_text_attnum IS NULL
     OR v_expansion_src_attnum IS NULL
     OR v_fts_core_attnum IS NULL
     OR v_trigger_enabled <> 'O'
     OR v_trigger_columns <> pg_catalog.format(
       '%s %s %s',
       v_body_text_attnum,
       v_expansion_src_attnum,
       v_fts_core_attnum
     )
     OR v_trigger_has_condition
     OR v_trigger_argument_count <> 0
     OR v_trigger_definition NOT ILIKE '%BEFORE INSERT OR UPDATE OF body_text, fts_expansion_src, fts_core ON%'
     OR v_trigger_definition ILIKE '%UPDATE ON public.transcript_paragraphs%' THEN
    RAISE EXCEPTION 'verification failed: transcript search-vector trigger is not column-scoped';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';

COMMIT;
