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
-- RETENTION — owner's decision, two stages, unchanged:
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
-- THE FOUR STATUSES. A row is `running` from the moment the question arrives.
-- It becomes `success` when the served response is stored, or `failed` when the
-- search errored. The fourth exists because a search can simply stop being
-- observed — the function is killed, the container reclaimed — and its row
-- would otherwise stay `running` forever, holding a raw question that no
-- retention step would ever touch. Such a row is swept to `abandoned`, which is
-- the honest label: we do not know whether the devotee got an answer, and
-- saying `failed` would assert something nobody verified. `abandoned` is
-- already this project's word for it — search_logs uses the same term.
--
-- ERASURE. There is no broad DELETE anywhere. The application cannot remove a
-- row at all. One specific record can be erased by an administrator through
-- erase_qa_archive_record(), which takes one primary key and a written reason,
-- refuses to run without both, and leaves a contentless audit row behind. It is
-- executable by the table owner only: no browser role and not even the service
-- role can call it, so no application code path can erase a devotee's question.
--
-- Neither maintenance function is scheduled by this migration. Turning either
-- on is a separately approved cron.schedule call.

CREATE TABLE public.qa_archive (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  -- Nullable on purpose. Telemetry is fail-open, so a search whose search_logs
  -- row could not be written must still be archived; a NOT NULL reference here
  -- would turn a telemetry outage into a lost question.
  search_log_id uuid REFERENCES public.search_logs(id) ON DELETE SET NULL,
  request_id uuid NOT NULL UNIQUE,
  question text NOT NULL CHECK (btrim(question) <> ''),
  response_json jsonb,
  status text NOT NULL
    CHECK (status IN ('running', 'success', 'failed', 'abandoned')),
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
  -- it served; a failed or abandoned row may never carry one. The database, not
  -- just the writer, refuses to hold an invented answer.
  CONSTRAINT qa_archive_status_shape CHECK (
    (status = 'running' AND response_json IS NULL AND completed_at IS NULL)
    OR (status = 'success' AND response_json IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND response_json IS NULL AND completed_at IS NOT NULL)
    OR (status = 'abandoned' AND response_json IS NULL AND completed_at IS NOT NULL)
  ),
  -- A row is reduced or it is not; the timestamp and the form cannot disagree.
  CONSTRAINT qa_archive_reduction_shape CHECK (
    (archive_form = 'full' AND reduced_at IS NULL)
    OR (archive_form = 'reduced' AND reduced_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.qa_archive IS
  'Every question and the exact final response sent to the browser. Contains RAW questions: private, service-role only, no browser policy. Complete for two years, then reduced to question + main passages + citations; never deleted except by an administrator, one record at a time, with an audit row.';
COMMENT ON COLUMN public.qa_archive.question IS
  'The raw question as the devotee typed it. Never hashed here — this table exists to keep it — and kept permanently, through reduction.';
COMMENT ON COLUMN public.qa_archive.response_json IS
  'The exact response object the server was about to return, including the full additional (Dig Deeper) list and its Vedabase URLs. Null until the search completes, never set on a failure or abandonment, and replaced by the reduced form after two years.';
COMMENT ON COLUMN public.qa_archive.status IS
  'running at insert; success once the served response is stored; failed when the search errored; abandoned when a running row was swept because its outcome was never observed. The question is kept in every case and no answer is ever invented.';
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
-- Likewise for the stale sweep: only rows still claiming to be in flight.
CREATE INDEX qa_archive_running_created_at_idx ON public.qa_archive (created_at)
  WHERE status = 'running';

ALTER TABLE public.qa_archive ENABLE ROW LEVEL SECURITY;

-- RLS and explicit ACL denial are both required. There is intentionally no
-- anon/authenticated policy: no browser role may read or write this table.
REVOKE ALL ON TABLE public.qa_archive FROM PUBLIC;
REVOKE ALL ON TABLE public.qa_archive FROM anon, authenticated;
REVOKE ALL ON TABLE public.qa_archive FROM service_role;
-- UPDATE is granted because the completion write finishes the row the arriving
-- question opened. DELETE and TRUNCATE are NOT granted to anyone: the running
-- application has no way to remove an archived question, by design.
GRANT SELECT, INSERT, UPDATE ON TABLE public.qa_archive TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Erasure audit.
--
-- Deliberately contentless: it records THAT a record was erased and why, never
-- what was in it. Keeping the question here would defeat the erasure.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE public.qa_archive_erasures (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  qa_archive_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL,
  archived_at timestamptz NOT NULL,
  erased_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (btrim(reason) <> '')
);

COMMENT ON TABLE public.qa_archive_erasures IS
  'Contentless audit of single-record erasures from qa_archive. Records that a record was erased and why; never the question or the response, which would defeat the erasure.';
COMMENT ON COLUMN public.qa_archive_erasures.reason IS
  'Written reason supplied by the administrator. Required — erase_qa_archive_record() refuses to run without one.';

ALTER TABLE public.qa_archive_erasures ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.qa_archive_erasures FROM PUBLIC;
REVOKE ALL ON TABLE public.qa_archive_erasures FROM anon, authenticated;
REVOKE ALL ON TABLE public.qa_archive_erasures FROM service_role;
-- Readable so the trail can be reviewed; not writable by the application, and
-- never deletable — an audit an application can rewrite is not an audit.
GRANT SELECT ON TABLE public.qa_archive_erasures TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Safeguard 1 — erase exactly one record, administrator only.
--
-- Scoped as narrowly as the requirement allows: one primary key, one row, a
-- mandatory written reason, an audit row, and an exception if the id matches
-- nothing (so a mistyped id fails loudly instead of silently erasing nothing).
--
-- EXECUTE is revoked from every role including service_role, so this is
-- callable only by the table owner — an administrator in the SQL editor. No
-- application code path can reach it, and the application still holds no DELETE
-- privilege on the table itself.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erase_qa_archive_record(p_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  v_request_id uuid;
  v_created_at timestamptz;
BEGIN
  IF p_id IS NULL THEN
    RAISE EXCEPTION 'erase_qa_archive_record requires the id of one record';
  END IF;
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'erase_qa_archive_record requires a written reason';
  END IF;

  DELETE FROM public.qa_archive
  WHERE id = p_id
  RETURNING request_id, created_at INTO v_request_id, v_created_at;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'qa_archive record % does not exist; nothing was erased', p_id;
  END IF;

  INSERT INTO public.qa_archive_erasures (qa_archive_id, request_id, archived_at, reason)
  VALUES (p_id, v_request_id, v_created_at, btrim(p_reason));

  RETURN p_id;
END
$fn$;

COMMENT ON FUNCTION public.erase_qa_archive_record(uuid, text) IS
  'Erases exactly one qa_archive record by primary key, with a mandatory written reason, leaving a contentless audit row. Administrator only: EXECUTE is revoked from every role including service_role, so no application code path can erase a question.';

REVOKE ALL ON FUNCTION public.erase_qa_archive_record(uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.erase_qa_archive_record(uuid, text) FROM anon, authenticated;
REVOKE ALL ON FUNCTION public.erase_qa_archive_record(uuid, text) FROM service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- Safeguard 2 — no row stays outside retention forever.
--
-- A search whose process died leaves a `running` row with no completed_at.
-- reduce_qa_archive() will not touch it, so without this sweep it would hold a
-- raw question indefinitely, past any retention the owner chose. This settles
-- such rows to `abandoned` — question kept, no answer invented — which brings
-- them into the ordinary two-year process.
--
-- The threshold has a hard floor of ten minutes. A search may run for up to 300
-- seconds (route.ts maxDuration), so anything shorter could settle a search
-- that is still working and race its own completion write. If a completion does
-- arrive later, it simply updates the row to `success` with its response — the
-- status shape allows that, and a late answer is still the true answer.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.settle_stale_qa_archive_rows(
  p_older_than interval DEFAULT interval '1 hour',
  p_limit integer DEFAULT 1000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  settled_count integer;
BEGIN
  IF p_limit IS NULL OR p_limit < 1 THEN
    RAISE EXCEPTION 'settle_stale_qa_archive_rows requires a positive batch limit';
  END IF;
  IF p_older_than IS NULL OR p_older_than < interval '10 minutes' THEN
    RAISE EXCEPTION
      'settle_stale_qa_archive_rows refuses a threshold under 10 minutes; a search may still be running';
  END IF;

  WITH stale AS (
    SELECT id
    FROM public.qa_archive
    WHERE status = 'running'
      AND created_at <= now() - p_older_than
    ORDER BY created_at
    LIMIT p_limit
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.qa_archive AS a
  SET status = 'abandoned',
      completed_at = now()
  FROM stale
  WHERE a.id = stale.id;

  GET DIAGNOSTICS settled_count = ROW_COUNT;
  RETURN settled_count;
END
$fn$;

COMMENT ON FUNCTION public.settle_stale_qa_archive_rows(interval, integer) IS
  'Sweeps running rows whose outcome was never observed to abandoned, so no question stays outside the retention process. Keeps the question, invents no answer, and refuses a threshold under ten minutes. Not scheduled by default.';

REVOKE ALL ON FUNCTION public.settle_stale_qa_archive_rows(interval, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.settle_stale_qa_archive_rows(interval, integer)
  FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.settle_stale_qa_archive_rows(interval, integer) TO service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- The two-year reduction.
--
-- The rule is literal: after two years keep the raw question, the main passages
-- that were shown, their citations and source URLs, and genuinely non-content
-- technical metadata. Nothing else that carries words survives — no generated
-- or framing text is kept permanently merely because it sat beside the answer.
--
-- Keeps an explicit allowlist of top-level response keys rather than deleting a
-- blocklist. If the response contract ever gains another field, an allowlist
-- drops it automatically; a blocklist would have kept it forever.
-- tests/qa-archive-migration.test.ts pins this list against the live wire
-- contract and requires every contract key to be deliberately classified, so a
-- contract change is noticed here rather than discovered in two years' time.
--
-- Removed, and why:
--   additional, additionalCount, additionalTruncated — the Dig Deeper section
--     and the two fields that exist only to describe it.
--   intro, suggestion, suggestionDisplay, queryTerms, queryVariants — generated
--     answer and framing content that is not part of the main passages.
--
-- Abandoned and failed rows carry no response to reduce; they are still marked
-- reduced so that every row, without exception, passes through retention.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.reduce_qa_archive(p_limit integer DEFAULT 1000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  kept_keys constant text[] := ARRAY[
    -- The question, the passages that were shown, and their citations and
    -- source URLs. Nothing else that carries words.
    'query', 'passages', 'citations',
    -- Genuinely non-content technical metadata.
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
      AND status IN ('success', 'failed', 'abandoned')
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
  audit_oid oid := pg_catalog.to_regclass('public.qa_archive_erasures');
BEGIN
  IF rel_oid IS NULL OR audit_oid IS NULL THEN
    RAISE EXCEPTION 'qa_archive or its erasure audit is missing after migration';
  END IF;
  IF (
    SELECT count(*) FROM pg_catalog.pg_class
    WHERE oid IN (rel_oid, audit_oid) AND relrowsecurity
  ) <> 2 THEN
    RAISE EXCEPTION 'qa_archive RLS is not enabled on both tables';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid IN (rel_oid, audit_oid)
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
  IF pg_catalog.has_table_privilege('anon', audit_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', audit_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('service_role', audit_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', audit_oid, 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', audit_oid, 'DELETE') THEN
    RAISE EXCEPTION 'qa_archive_erasures must be read-only to the application';
  END IF;
  IF pg_catalog.has_function_privilege('anon', 'public.reduce_qa_archive(integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', 'public.reduce_qa_archive(integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'anon', 'public.settle_stale_qa_archive_rows(interval, integer)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', 'public.settle_stale_qa_archive_rows(interval, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'maintenance functions must not be callable from a browser role';
  END IF;
  -- The erasure path is administrator-only: not the browser roles, and not the
  -- application either.
  IF pg_catalog.has_function_privilege(
       'anon', 'public.erase_qa_archive_record(uuid, text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'authenticated', 'public.erase_qa_archive_record(uuid, text)', 'EXECUTE')
     OR pg_catalog.has_function_privilege(
          'service_role', 'public.erase_qa_archive_record(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'erase_qa_archive_record must be callable by the table owner only';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
