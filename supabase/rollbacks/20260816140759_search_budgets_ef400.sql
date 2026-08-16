-- Rollback for the retrieval budget change: puts ef_search back to 400, the
-- semantic default back to 300, and the clamp cap back to 400, across all five
-- search_*_hybrid_batch_v3 functions.
--
-- Exactly the forward migration with the substitutions reversed, including the
-- same byte-for-byte reversal check, so it cannot corrupt the transcripts
-- function's U&'[\0300-\036f]' diacritic range either.

DO $rollback$
DECLARE
  fn       regprocedure;
  old_def  text;
  new_def  text;
  restored text;
  changed  integer := 0;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname LIKE 'search\_%\_hybrid\_batch\_v3'
    ORDER BY p.proname
  LOOP
    old_def := pg_get_functiondef(fn);

    new_def := replace(old_def,
      'SET "hnsw.ef_search" TO ''200''',
      'SET "hnsw.ef_search" TO ''400''');
    new_def := replace(new_def,
      'p_semantic_limit integer DEFAULT 200)',
      'p_semantic_limit integer DEFAULT 300)');
    new_def := replace(new_def,
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)',
      'least(greatest(COALESCE(p_semantic_limit, 300), 1), 400)');
    new_def := replace(new_def,
      'ef_search above is 200',
      'ef_search above is 400');

    restored := replace(new_def,
      'SET "hnsw.ef_search" TO ''400''',
      'SET "hnsw.ef_search" TO ''200''');
    restored := replace(restored,
      'p_semantic_limit integer DEFAULT 300)',
      'p_semantic_limit integer DEFAULT 200)');
    restored := replace(restored,
      'least(greatest(COALESCE(p_semantic_limit, 300), 1), 400)',
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)');
    restored := replace(restored,
      'ef_search above is 400',
      'ef_search above is 200');

    IF restored IS DISTINCT FROM old_def THEN
      RAISE EXCEPTION
        'refusing to restore %: the rewrite touched something other than the three budgets', fn;
    END IF;

    EXECUTE new_def;
    changed := changed + 1;
  END LOOP;

  IF changed <> 5 THEN
    RAISE EXCEPTION 'expected exactly five batch retrieval functions, restored %', changed;
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
