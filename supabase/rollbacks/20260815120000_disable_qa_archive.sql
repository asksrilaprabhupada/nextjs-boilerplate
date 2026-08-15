-- Non-destructive rollback for the qa_archive table.
--
-- First roll the application back to a commit that never calls the archive
-- writer. This SQL then makes the additive table inert without DROP or DELETE:
-- no role may write or read it through the Data API, and every question already
-- archived remains on disk for the owner.
--
-- Archived questions are never destroyed by a rollback. If the table itself is
-- to be removed, that is a separate, explicitly approved act — the DROP is
-- written at the bottom of this file, commented out, so it can never run by
-- accident as part of an ordinary revert.

-- If the two-year reduction job was ever scheduled, unschedule it first so no
-- row is reduced while the application is rolled back.
--   SELECT cron.unschedule('qa-archive-reduce');

REVOKE SELECT, INSERT, UPDATE ON TABLE public.qa_archive FROM service_role;
REVOKE ALL ON TABLE public.qa_archive FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.reduce_qa_archive(integer) FROM service_role;

COMMENT ON TABLE public.qa_archive IS
  'INERT after non-destructive rollback. No role may write or read through the Data API. Archived rows are retained.';

NOTIFY pgrst, 'reload schema';

-- DESTRUCTIVE — requires its own separate approval. Deletes every archived
-- question and answer permanently. Do not uncomment as part of a revert.
-- DROP FUNCTION public.reduce_qa_archive(integer);
-- DROP TABLE public.qa_archive;
