-- Non-destructive rollback for Phase 5 snapshot metadata.
--
-- First roll the application back to a commit that never calls the snapshot
-- writer. This SQL then makes the additive table inert without DROP or DELETE.
-- Existing private objects and metadata remain available for owner review and
-- separately approved Storage-API retention handling.

REVOKE INSERT, SELECT ON TABLE public.search_answer_snapshots FROM service_role;
REVOKE ALL ON TABLE public.search_answer_snapshots FROM PUBLIC, anon, authenticated;

COMMENT ON TABLE public.search_answer_snapshots IS
  'INERT after non-destructive Phase 5 rollback. No role may write or read through the Data API.';

NOTIFY pgrst, 'reload schema';
