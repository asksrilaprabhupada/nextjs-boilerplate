-- ROLLBACK for 20260817193000_semantic_limit_100.sql
--
-- Puts the semantic ceiling and clamp cap back to 200 across all five
-- search_*_hybrid_batch_v3 functions. ef_search is not touched here either —
-- it was 200 before that migration and is 200 after it.
--
-- Same technique and the same guard, with the substitutions the other way
-- round: read the live definition, apply exactly anchored replacements, reverse
-- them, and refuse to write anything unless reversing reproduces the current
-- definition byte-for-byte. Every anchor contains `p_semantic_limit`, which the
-- ef_search SET clause does not and cannot contain.
--
-- Running this after any LATER migration has touched these functions will abort
-- on the reversal check rather than silently reverting that later work. That is
-- the intended behaviour: a rollback that quietly undoes someone else's change
-- is worse than one that stops.

DO $load$
BEGIN
  PERFORM ('[1]'::extensions.vector) OPERATOR(extensions.<#>) ('[1]'::extensions.vector);
  IF current_setting('hnsw.ef_search', true) IS NULL THEN
    RAISE EXCEPTION 'hnsw.ef_search is still undefined; CREATE OR REPLACE would be refused';
  END IF;
END
$load$;

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
      'p_semantic_limit integer DEFAULT 100)',
      'p_semantic_limit integer DEFAULT 200)');
    new_def := replace(new_def,
      'least(greatest(COALESCE(p_semantic_limit, 100), 1), 100)',
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)');
    new_def := replace(new_def,
      '-- The clamp, deliberately BELOW ef_search (200). Equal values leave the' || E'\n'
      || '      -- HNSW graph no room to refine: it would be asked for exactly as many' || E'\n'
      || '      -- rows as it is willing to consider. Half gives it somewhere to choose' || E'\n'
      || '      -- from, which is where the recall comes from.',
      '-- The clamp. ef_search above is 200 and an HNSW scan cannot return more' || E'\n'
      || '      -- rows than ef_search, so asking for more would silently return fewer.');

    restored := replace(new_def,
      'p_semantic_limit integer DEFAULT 200)',
      'p_semantic_limit integer DEFAULT 100)');
    restored := replace(restored,
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)',
      'least(greatest(COALESCE(p_semantic_limit, 100), 1), 100)');
    restored := replace(restored,
      '-- The clamp. ef_search above is 200 and an HNSW scan cannot return more' || E'\n'
      || '      -- rows than ef_search, so asking for more would silently return fewer.',
      '-- The clamp, deliberately BELOW ef_search (200). Equal values leave the' || E'\n'
      || '      -- HNSW graph no room to refine: it would be asked for exactly as many' || E'\n'
      || '      -- rows as it is willing to consider. Half gives it somewhere to choose' || E'\n'
      || '      -- from, which is where the recall comes from.');

    IF restored IS DISTINCT FROM old_def THEN
      RAISE EXCEPTION
        'refusing to roll back %: something other than the semantic budgets differs', fn;
    END IF;

    IF new_def = old_def THEN
      RAISE EXCEPTION 'refusing to roll back %: the 100 budgets are not present', fn;
    END IF;

    IF position('SET "hnsw.ef_search" TO ''200''' in new_def) = 0 THEN
      RAISE EXCEPTION 'refusing to roll back %: ef_search 200 was lost by the rewrite', fn;
    END IF;

    EXECUTE new_def;
    changed := changed + 1;
  END LOOP;

  IF changed <> 5 THEN
    RAISE EXCEPTION 'expected exactly five batch retrieval functions, rewrote %', changed;
  END IF;
END
$rollback$;

DO $verify$
DECLARE
  offenders text;
  transcripts_def text;
BEGIN
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO offenders
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'search\_%\_hybrid\_batch\_v3'
    AND NOT (
      position('p_semantic_limit integer DEFAULT 200)' in pg_get_functiondef(p.oid)) > 0
      AND position('least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)'
                   in pg_get_functiondef(p.oid)) > 0
      AND position('COALESCE(p_semantic_limit, 100)' in pg_get_functiondef(p.oid)) = 0
      AND position('SET "hnsw.ef_search" TO ''200''' in pg_get_functiondef(p.oid)) > 0
    );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'rollback not fully applied to: %', offenders;
  END IF;

  SELECT pg_get_functiondef(p.oid) INTO transcripts_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'search_transcripts_hybrid_batch_v3';
  IF position('U&''[\0300-\036f]''' in transcripts_def) = 0 THEN
    RAISE EXCEPTION 'the transcripts diacritic range was altered by this rollback';
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
