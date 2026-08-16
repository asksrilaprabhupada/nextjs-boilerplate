-- Stop the two qa_archive maintenance jobs.
--
-- Non-destructive: unscheduling only stops future runs. No archived question is
-- touched, the functions remain callable by hand, and rows already settled or
-- reduced stay as they are.
--
-- Run this before rolling the qa_archive table itself back to inert, so nothing
-- is settled or reduced while the application is mid-rollback.

SELECT cron.unschedule('qa-archive-settle-stale');
SELECT cron.unschedule('qa-archive-reduce');

DO $verify$
DECLARE
  remaining integer;
BEGIN
  SELECT count(*) INTO remaining
  FROM cron.job
  WHERE jobname IN ('qa-archive-settle-stale', 'qa-archive-reduce');
  IF remaining <> 0 THEN
    RAISE EXCEPTION 'qa_archive maintenance jobs are still scheduled: %', remaining;
  END IF;
END
$verify$;
