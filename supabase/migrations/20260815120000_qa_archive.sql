-- qa_archive — every question, and the exact answer the browser received.
--
-- search_logs stays pure technical telemetry and stores only a hash of the
-- question. This table is the opposite and deliberately so: it keeps the RAW
-- question and the complete final response object — main answer, every main
-- passage, citations, speaker information, Vedabase URLs, and the entire Dig
-- Deeper list — exactly as it went out on the wire.
--
-- Because it holds raw questions, it is private with no exceptions: RLS on, no
-- policy for any browser role, and explicit ACL denial on top (this project has
-- legacy default ACLs that grant future public tables broadly). Only the
-- service role writes, and only the server ever constructs the row — the
-- browser is never trusted to send an answer back.
--
-- RETENTION — owner's decision, two stages:
--
--   For two years, the complete archive is kept: the raw question and the whole
--   response_json, including the full main answer and the complete Dig Deeper
--   section.
--
--   After two years, the row is REDUCED, never deleted. The raw question is
--   kept permanently, along with the main passages that were shown and their
--   citations and source URLs. The entire Dig Deeper section — and every field
--   that exists only for Dig Deeper — is removed, and the original full
--   response_json is replaced by the reduced version.
--
-- The reduction is a rewrite, not a delete: no archived question is ever lost.
-- public.reduce_qa_archive() below performs it. It is deliberately NOT
-- scheduled by this migration; turning it on is one separately approved
-- cron.schedule call, and nothing reduces a row until that is done.

CREATE TABLE public.qa_archive (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  -- Nullable on purpose. Telemetry is fail-open, so a search whose search_logs
  -- row could not be written must still be archived; a NOT NULL reference here
  -- would turn a telemetry outage into a lost question.
  search_log_id uuid REFERENCES public.search_logs(id) ON DELETE SET NULL,
  request_id uuid NOT NULL UNIQUE,
  question text NOT NULL CHECK (btrim(question) <> ''),
  response_json jsonb,
  status text NOT NULL CHECK (status IN ('running', 'success', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  -- Reserved for a later Google Docs mirror. Nothing writes it today.
  drive_file_id text,

  -- ── Retention state ──
  -- There is deliberately no stored "reduce after" column. Adding an interval
  -- to a timestamptz is STABLE, not immutable (month arithmetic depends on the
  -- session time zone), so a generated column is rejected outright — and a
  -- plain defaulted column could be back-dated by a later write. The two-year
  -- point is therefore derived from created_at inside reduce_qa_archive(),
  -- where it cannot drift.
  archive_form text NOT NULL DEFAULT 'full'
    CHECK (archive_form IN ('full', 'reduced')),
  reduced_at timestamptz,

  CHECK (completed_at IS NULL OR completed_at >= created_at),
  -- The honesty constraint. A finished-successfully row MUST carry the response
  -- it served, and a failed row may never carry one: the database, not just the
  -- writer, refuses to hold an invented answer.
  CONSTRAINT qa_archive_status_shape CHECK (
    (status = 'running' AND response_json IS NULL AND completed_at IS NULL)
    OR (status = 'success' AND response_json IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND response_json IS NULL AND completed_at IS NOT NULL)
  ),
  -- A row is reduced or it is not; the timestamp and the form cannot disagree.
  CONSTRAINT qa_archive_reduction_shape CHECK (
    (archive_form = 'full' AND reduced_at IS NULL)
    OR (archive_form = 'reduced' AND reduced_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.qa_archive IS
  'Every question and the exact final response sent to the browser. Contains RAW questions: private, service-role only, no browser policy. Complete for two years, then reduced to question + main passages + citations; never deleted.';
COMMENT ON COLUMN public.qa_archive.question IS
  'The raw question as the devotee typed it. Never hashed here — this table exists to keep it — and kept permanently, through reduction.';
COMMENT ON COLUMN public.qa_archive.response_json IS
  'The exact response object the server was about to return, including the full additional (Dig Deeper) list and its Vedabase URLs. Null until the search completes, never set on a failure, and replaced by the reduced form after two years.';
COMMENT ON COLUMN public.qa_archive.status IS
  'running at insert; success once the served response is stored; failed when the search errored, with the question kept and no answer invented.';
COMMENT ON COLUMN public.qa_archive.drive_file_id IS
  'Reserved for a later Google Docs mirror. Always null today; no mirror is built.';
COMMENT ON COLUMN public.qa_archive.archive_form IS
  'full while the complete response is kept; reduced once the Dig Deeper section has been removed.';

CREATE INDEX qa_archive_created_at_idx ON public.qa_archive (created_at DESC);
CREATE INDEX qa_archive_search_log_id_idx ON public.qa_archive (search_log_id);
CREATE INDEX qa_archive_status_idx ON public.qa_archive (status);
-- Only unreduced rows are ever scanned for reduction, so this index stays small
-- and the job's cost does not grow with the permanent archive.
CREATE INDEX qa_archive_unreduced_created_at_idx ON public.qa_archive (created_at)
  WHERE archive_form = 'full';

ALTER TABLE public.qa_archive ENABLE ROW LEVEL SECURITY;

-- RLS and explicit ACL denial are both required. There is intentionally no
-- anon/authenticated policy: no browser role may read or write this table.
REVOKE ALL ON TABLE public.qa_archive FROM PUBLIC;
REVOKE ALL ON TABLE public.qa_archive FROM anon, authenticated;
REVOKE ALL ON TABLE public.qa_archive FROM service_role;
-- UPDATE is granted because the completion write finishes the row the arriving
-- question opened. DELETE and TRUNCATE are not granted: removing archived
-- questions is a separately approved act, never something a request can do.
GRANT SELECT, INSERT, UPDATE ON TABLE public.qa_archive TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- The two-year reduction.
--
-- Keeps an explicit allowlist of top-level response keys rather than deleting a
-- blocklist. If the response contract ever gains another Dig-Deeper-only field,
-- an allowlist drops it automatically; a blocklist would have kept it forever.
-- tests/qa-archive-migration.test.ts pins this list against the live wire
-- contract so a contract change is noticed here rather than discovered in two
-- years' time.
--
-- Removed: additional, additionalCount, additionalTruncated — the Dig Deeper
-- section and the two fields that exist only to describe it.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reduce_qa_archive(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  kept_keys constant text[] := ARRAY[
    'query', 'passages', 'citations', 'intro',
    'suggestion', 'suggestionDisplay', 'queryTerms', 'queryVariants',
    'totalResults', 'validated', 'droppedBlocks',
    'searchLogId', 'requestId',
    'degraded', 'retrievalStatus', 'degradedSources', 'disabledLanes'
  ];
  reduced_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'reduce_qa_archive requires a positive batch limit';
  END IF;

  WITH due AS (
    SELECT id
    FROM public.qa_archive
    WHERE archive_form = 'full'
      AND status IN ('success', 'failed')
      AND created_at <= now() - interval '2 years'
    ORDER BY created_at
    LIMIT p_limit
    -- Batched and lock-skipping so a long backlog never blocks a live search
    -- writing its own row.
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.qa_archive AS a
  SET
    response_json = CASE
      WHEN a.response_json IS NULL THEN NULL
      ELSE COALESCE(
        (
          SELECT jsonb_object_agg(entry.key, entry.value)
          FROM jsonb_each(a.response_json) AS entry
          WHERE entry.key = ANY(kept_keys)
        ),
        '{}'::jsonb
      )
    END,
    archive_form = 'reduced',
    reduced_at = now()
  FROM due
  WHERE a.id = due.id;

  GET DIAGNOSTICS reduced_count = ROW_COUNT;
  RETURN reduced_count;
END
$fn$;

COMMENT ON FUNCTION public.reduce_qa_archive(integer) IS
  'Two-year retention step. Rewrites response_json to question + main passages + citations + technical metadata, dropping the Dig Deeper section. Never deletes a row and never touches the raw question. Not scheduled by default.';

REVOKE ALL ON FUNCTION public.reduce_qa_archive(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reduce_qa_archive(integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reduce_qa_archive(integer) TO service_role;

DO $verify$
DECLARE
  rel_oid oid := pg_catalog.to_regclass('public.qa_archive');
BEGIN
  IF rel_oid IS NULL THEN
    RAISE EXCEPTION 'qa_archive missing after migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class WHERE oid = rel_oid AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'qa_archive RLS is not enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = rel_oid
  ) THEN
    RAISE EXCEPTION 'qa_archive must have no browser policies';
  END IF;
  IF pg_catalog.has_table_privilege('anon', rel_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', rel_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('anon', rel_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', rel_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('anon', rel_oid, 'UPDATE')
     OR pg_catalog.has_table_privilege('authenticated', rel_oid, 'UPDATE')
     OR NOT pg_catalog.has_table_privilege('service_role', rel_oid, 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', rel_oid, 'INSERT')
     OR NOT pg_catalog.has_table_privilege('service_role', rel_oid, 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', rel_oid, 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', rel_oid, 'TRUNCATE') THEN
    RAISE EXCEPTION 'qa_archive grants are not service-role read/write-only';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'public.reduce_qa_archive(integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', 'public.reduce_qa_archive(integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'reduce_qa_archive must not be callable from a browser role';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
