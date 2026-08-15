-- Non-destructive rollback for the qa_archive table.
--
-- First roll the application back to a commit that never calls the archive
-- writer. This SQL then makes the additive tables inert without DROP or DELETE:
-- no role may write or read them through the Data API, and every question
-- already archived remains on disk for the owner.
--
-- Archived questions are never destroyed by a rollback. If the tables are to be
-- removed, that is a separate, explicitly approved act — the DROPs are written
-- at the bottom of this file, commented out, so they can never run by accident
-- as part of an ordinary revert.

-- If either maintenance job was ever scheduled, unschedule it first so nothing
-- is reduced or settled while the application is rolled back.
--   SELECT cron.unschedule('qa-archive-reduce');
--   SELECT cron.unschedule('qa-archive-settle-stale');

REVOKE SELECT, INSERT, UPDATE ON TABLE public.qa_archive FROM service_role;
REVOKE ALL ON TABLE public.qa_archive FROM PUBLIC, anon, authenticated;

REVOKE SELECT ON TABLE public.qa_archive_erasures FROM service_role;
REVOKE ALL ON TABLE public.qa_archive_erasures FROM PUBLIC, anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.reduce_qa_archive(integer) FROM service_role;
REVOKE EXECUTE ON FUNCTION public.settle_stale_qa_archive_rows(interval, integer)
  FROM service_role;
-- erase_qa_archive_record() was never granted to any role; the table owner
-- retains it, which is what keeps single-record erasure possible during a
-- rollback without handing it to the application.

COMMENT ON TABLE public.qa_archive IS
  'INERT after non-destructive rollback. No role may write or read through the Data API. Archived rows are retained.';
COMMENT ON TABLE public.qa_archive_erasures IS
  'INERT after non-destructive rollback. The erasure audit trail is retained.';

NOTIFY pgrst, 'reload schema';

-- DESTRUCTIVE — requires its own separate approval. Deletes every archived
-- question and answer permanently, and the record that any were erased.
-- Do not uncomment as part of a revert.
-- DROP FUNCTION public.reduce_qa_archive(integer);
-- DROP FUNCTION public.settle_stale_qa_archive_rows(interval, integer);
-- DROP FUNCTION public.erase_qa_archive_record(uuid, text);
-- DROP TABLE public.qa_archive_erasures;
-- DROP TABLE public.qa_archive;
