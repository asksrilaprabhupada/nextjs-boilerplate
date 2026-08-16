-- Run the two qa_archive maintenance jobs automatically, so neither depends on
-- anyone remembering.
--
-- The sweep runs hourly: it settles `running` rows older than one hour to
-- `abandoned`, so a search whose process died is brought into retention within
-- about two hours at worst. It refuses any threshold under ten minutes, so it
-- can never settle a search that is still working.
--
-- The reduction runs once daily at a quiet hour. Rows become due exactly two
-- years after they were archived, so nothing is gained by checking more often.
--
-- Both are batched and lock-skipping, so neither can block a live search
-- writing its own row, and both are idempotent: a run with nothing due does
-- nothing and returns zero.
--
-- Applied as ledger version 20260816135602.

SELECT cron.schedule(
  'qa-archive-settle-stale',
  '20 * * * *',
  $job$SELECT public.settle_stale_qa_archive_rows(interval '1 hour', 1000);$job$
);

SELECT cron.schedule(
  'qa-archive-reduce',
  '40 3 * * *',
  $job$SELECT public.reduce_qa_archive(1000);$job$
);

DO $verify$
DECLARE
  scheduled integer;
BEGIN
  SELECT count(*) INTO scheduled
  FROM cron.job
  WHERE jobname IN ('qa-archive-settle-stale', 'qa-archive-reduce') AND active;
  IF scheduled <> 2 THEN
    RAISE EXCEPTION
      'expected both qa_archive maintenance jobs to be scheduled and active, found %', scheduled;
  END IF;
END
$verify$;
