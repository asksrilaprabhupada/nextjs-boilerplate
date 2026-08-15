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
-- RETENTION: raw questions are kept indefinitely. If a fixed retention is
-- chosen instead, that is a separate approved migration adding an expires_at
-- column and a deletion job; nothing here silently expires a row.

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
  CHECK (completed_at IS NULL OR completed_at >= created_at),
  -- The honesty constraint. A finished-successfully row MUST carry the response
  -- it served, and a failed row may never carry one: the database itself
  -- refuses to hold an invented answer.
  CONSTRAINT qa_archive_status_shape CHECK (
    (status = 'running' AND response_json IS NULL AND completed_at IS NULL)
    OR (status = 'success' AND response_json IS NOT NULL AND completed_at IS NOT NULL)
    OR (status = 'failed' AND response_json IS NULL AND completed_at IS NOT NULL)
  )
);

COMMENT ON TABLE public.qa_archive IS
  'Every question and the exact final response sent to the browser. Contains RAW questions: private, service-role only, no browser policy. search_logs remains hash-only technical telemetry.';
COMMENT ON COLUMN public.qa_archive.question IS
  'The raw question as the devotee typed it. Never hashed here — this table exists to keep it.';
COMMENT ON COLUMN public.qa_archive.response_json IS
  'The exact response object the server was about to return, including the full additional (Dig Deeper) list and its Vedabase URLs. Null until the search completes, and never set on a failure.';
COMMENT ON COLUMN public.qa_archive.status IS
  'running at insert; success once the served response is stored; failed when the search errored, with the question kept and no answer invented.';
COMMENT ON COLUMN public.qa_archive.drive_file_id IS
  'Reserved for a later Google Docs mirror. Always null today; no mirror is built.';

CREATE INDEX qa_archive_created_at_idx ON public.qa_archive (created_at DESC);
CREATE INDEX qa_archive_search_log_id_idx ON public.qa_archive (search_log_id);
CREATE INDEX qa_archive_status_idx ON public.qa_archive (status);

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
END
$verify$;

NOTIFY pgrst, 'reload schema';
