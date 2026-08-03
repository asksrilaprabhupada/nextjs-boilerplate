-- Private metadata for owner-authorized preview answer snapshots.
--
-- The raw question, answer, candidate decisions, and response bytes live only
-- in one gzip object in the private `search-answer-snapshots` Storage bucket.
-- This table is metadata-only. The bucket must be provisioned through the
-- Storage Admin API; never write directly to the managed storage schema.

CREATE TABLE public.search_answer_snapshots (
  id uuid PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  search_log_id uuid NOT NULL
    REFERENCES public.search_logs(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL UNIQUE,
  capture_id_hash text NOT NULL UNIQUE
    CHECK (capture_id_hash ~ '^[0-9a-f]{64}$'),
  environment text NOT NULL
    CHECK (environment = 'preview'),
  deployment_sha text NOT NULL
    CHECK (deployment_sha ~ '^[0-9a-f]{40}$'),
  pipeline_version text NOT NULL CHECK (btrim(pipeline_version) <> ''),
  corpus_version text NOT NULL CHECK (btrim(corpus_version) <> ''),
  config_version text NOT NULL CHECK (btrim(config_version) <> ''),
  bucket_id text NOT NULL
    CHECK (bucket_id = 'search-answer-snapshots'),
  object_path text NOT NULL UNIQUE
    CHECK (object_path ~ '^v1/[0-9]{4}/[0-9]{2}/[0-9]{2}/[0-9a-f-]{36}\.json\.gz$'),
  payload_sha256 text NOT NULL
    CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  payload_bytes bigint NOT NULL CHECK (payload_bytes > 0),
  object_sha256 text NOT NULL
    CHECK (object_sha256 ~ '^[0-9a-f]{64}$'),
  object_bytes bigint NOT NULL
    CHECK (object_bytes > 0 AND object_bytes <= 10485760),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.search_answer_snapshots IS
  'Metadata only for owner-authorized preview snapshots. Raw questions, answers and decision traces live in one private gzip Storage object; ordinary searches create no row.';
COMMENT ON COLUMN public.search_answer_snapshots.object_path IS
  'Private Storage object path. Never a public or signed URL.';
COMMENT ON COLUMN public.search_answer_snapshots.expires_at IS
  'Default 30-day review retention. Object deletion must use the Storage API before separately approved metadata deletion.';

CREATE INDEX search_answer_snapshots_expires_at_idx
  ON public.search_answer_snapshots (expires_at);
CREATE INDEX search_answer_snapshots_search_log_id_idx
  ON public.search_answer_snapshots (search_log_id);

ALTER TABLE public.search_answer_snapshots ENABLE ROW LEVEL SECURITY;

-- This project has legacy default ACLs that grant future public tables broadly.
-- RLS and explicit ACL denial are both required; there is intentionally no
-- anon/authenticated policy.
REVOKE ALL ON TABLE public.search_answer_snapshots FROM PUBLIC;
REVOKE ALL ON TABLE public.search_answer_snapshots FROM anon, authenticated;
REVOKE ALL ON TABLE public.search_answer_snapshots FROM service_role;
GRANT SELECT, INSERT ON TABLE public.search_answer_snapshots TO service_role;

DO $verify$
DECLARE
  rel_oid oid := pg_catalog.to_regclass('public.search_answer_snapshots');
BEGIN
  IF rel_oid IS NULL THEN
    RAISE EXCEPTION 'search_answer_snapshots missing after migration';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_class WHERE oid = rel_oid AND relrowsecurity
  ) THEN
    RAISE EXCEPTION 'search_answer_snapshots RLS is not enabled';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = rel_oid
  ) THEN
    RAISE EXCEPTION 'search_answer_snapshots must have no browser policies';
  END IF;
  IF pg_catalog.has_table_privilege('anon', rel_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('authenticated', rel_oid, 'SELECT')
     OR pg_catalog.has_table_privilege('anon', rel_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('authenticated', rel_oid, 'INSERT')
     OR NOT pg_catalog.has_table_privilege('service_role', rel_oid, 'SELECT')
     OR NOT pg_catalog.has_table_privilege('service_role', rel_oid, 'INSERT')
     OR pg_catalog.has_table_privilege('service_role', rel_oid, 'UPDATE')
     OR pg_catalog.has_table_privilege('service_role', rel_oid, 'DELETE')
     OR pg_catalog.has_table_privilege('service_role', rel_oid, 'TRUNCATE') THEN
    RAISE EXCEPTION 'search_answer_snapshots grants are not service-role-only';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
