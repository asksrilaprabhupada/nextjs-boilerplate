-- Semantic ceiling and clamp cap: 200 -> 100, across all five
-- search_*_hybrid_batch_v3 functions. ef_search STAYS AT 200.
--
-- Forward-only. The already-applied migrations that created and last rewrote
-- these functions are never edited; this one replaces the live definitions.
--
-- WHY THESE TWO NUMBERS AND NOT THE THIRD.
--
-- ef_search 200 with a semantic ceiling of 200 is the fragile setting. An HNSW
-- scan can never return more rows than ef_search allows, so when the two are
-- EQUAL the index is being asked for exactly as many rows as it is willing to
-- consider — there is no headroom in which to discard a poor neighbour for a
-- better one. Dropping the ceiling to 100 leaves the graph twice the search
-- effort it is asked to return, which is where the recall comes from.
--
-- The earlier overlap test only checked the top 20, 50 and 100. It never
-- validated 200, so it never actually tested the setting it was used to
-- justify. The 65-question gold set is the acceptance evidence for this
-- change, and it is a separate, separately-approved paid run.
--
-- HOW THIS REWRITES THE FUNCTIONS, AND WHY NOT BY HAND.
--
-- The five bodies are ~10 KB each and one of them (transcripts) contains the
-- Unicode literal U&'[\0300-\036f]', the combining-diacritics range used to
-- strip accents. Retyping ~50 KB of SQL by hand invites exactly the kind of
-- one-character error that literal is most vulnerable to.
--
-- So each definition is read back with pg_get_functiondef, three exactly
-- anchored substitutions are applied, and then the substitutions are REVERSED
-- and compared byte-for-byte against the original. If reversing does not
-- reproduce the original exactly, something other than these two budgets
-- changed and the migration aborts having replaced nothing.
--
-- THE COLLISION THIS TIME IS SHARPER THAN LAST TIME. When ef_search went
-- 400 -> 200 the old and new values differed from the semantic budgets, so a
-- careless anchor could not confuse them. Now ef_search is ALSO 200: the string
-- `200` appears six times in each function (seven in transcripts), and one of
-- those occurrences must not move. Every anchor below therefore contains
-- `p_semantic_limit`, which the ef_search clause does not and cannot contain.
-- The reversal check is what proves it worked rather than what hopes it did.
--
-- Verified against the live database before writing this file:
--   * all five carry `p_semantic_limit integer DEFAULT 200)` exactly once;
--   * all five carry `least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)`
--     exactly twice — once as the LIMIT, once in the saturation test;
--   * all five carry `SET "hnsw.ef_search" TO '200'` exactly once;
--   * removing those three accounts for every `200` in four of the five. The
--     fifth, transcripts, has one more: a comment explaining the clamp. It is
--     substitution three, because the change makes what it says untrue.
--
-- Grants, ownership, SECURITY INVOKER and search_path all survive because
-- CREATE OR REPLACE preserves them and the reversal check proves those clauses
-- are byte-identical.

-- Define hnsw.ef_search for this session before rewriting anything.
--
-- The vector library is loaded on demand, and until it is, `hnsw.ef_search` is
-- an undefined placeholder GUC. Postgres refuses to let a non-superuser put a
-- placeholder in a function's SET clause, so CREATE OR REPLACE fails with
-- "permission denied to set parameter" even though the existing functions
-- already carry that exact clause. One vector operation loads the library and
-- the parameter becomes real.
DO $load$
BEGIN
  PERFORM ('[1]'::extensions.vector) OPERATOR(extensions.<#>) ('[1]'::extensions.vector);
  IF current_setting('hnsw.ef_search', true) IS NULL THEN
    RAISE EXCEPTION 'hnsw.ef_search is still undefined; CREATE OR REPLACE would be refused';
  END IF;
END
$load$;

DO $migrate$
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

    -- Every anchor contains `p_semantic_limit`. The ef_search SET clause does
    -- not, so it cannot be matched by any of them.
    new_def := replace(old_def,
      'p_semantic_limit integer DEFAULT 200)',
      'p_semantic_limit integer DEFAULT 100)');
    new_def := replace(new_def,
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)',
      'least(greatest(COALESCE(p_semantic_limit, 100), 1), 100)');
    -- Only the transcripts function carries this comment. It said the clamp
    -- matches ef_search because asking for more would return fewer; that is no
    -- longer the reason the clamp is where it is, and the next reader will
    -- trust whatever it says.
    new_def := replace(new_def,
      '-- The clamp. ef_search above is 200 and an HNSW scan cannot return more' || E'\n'
      || '      -- rows than ef_search, so asking for more would silently return fewer.',
      '-- The clamp, deliberately BELOW ef_search (200). Equal values leave the' || E'\n'
      || '      -- HNSW graph no room to refine: it would be asked for exactly as many' || E'\n'
      || '      -- rows as it is willing to consider. Half gives it somewhere to choose' || E'\n'
      || '      -- from, which is where the recall comes from.');

    restored := replace(new_def,
      'p_semantic_limit integer DEFAULT 100)',
      'p_semantic_limit integer DEFAULT 200)');
    restored := replace(restored,
      'least(greatest(COALESCE(p_semantic_limit, 100), 1), 100)',
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)');
    restored := replace(restored,
      '-- The clamp, deliberately BELOW ef_search (200). Equal values leave the' || E'\n'
      || '      -- HNSW graph no room to refine: it would be asked for exactly as many' || E'\n'
      || '      -- rows as it is willing to consider. Half gives it somewhere to choose' || E'\n'
      || '      -- from, which is where the recall comes from.',
      '-- The clamp. ef_search above is 200 and an HNSW scan cannot return more' || E'\n'
      || '      -- rows than ef_search, so asking for more would silently return fewer.');

    IF restored IS DISTINCT FROM old_def THEN
      RAISE EXCEPTION
        'refusing to replace %: the rewrite touched something other than the semantic budgets', fn;
    END IF;

    IF new_def = old_def THEN
      RAISE EXCEPTION 'refusing to replace %: neither semantic budget was found', fn;
    END IF;

    -- ef_search must be untouched. This is the one number that shares a value
    -- with the two being changed, so it gets its own explicit assertion rather
    -- than relying on the anchors having been careful.
    IF position('SET "hnsw.ef_search" TO ''200''' in new_def) = 0 THEN
      RAISE EXCEPTION 'refusing to replace %: ef_search 200 was lost by the rewrite', fn;
    END IF;

    EXECUTE new_def;
    changed := changed + 1;
  END LOOP;

  IF changed <> 5 THEN
    RAISE EXCEPTION 'expected exactly five batch retrieval functions, rewrote %', changed;
  END IF;
END
$migrate$;

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
      position('p_semantic_limit integer DEFAULT 100)' in pg_get_functiondef(p.oid)) > 0
      AND position('least(greatest(COALESCE(p_semantic_limit, 100), 1), 100)'
                   in pg_get_functiondef(p.oid)) > 0
      -- No trace of the old budgets anywhere.
      AND position('COALESCE(p_semantic_limit, 200)' in pg_get_functiondef(p.oid)) = 0
      AND position('p_semantic_limit integer DEFAULT 200)' in pg_get_functiondef(p.oid)) = 0
      -- And ef_search still exactly where it was.
      AND position('SET "hnsw.ef_search" TO ''200''' in pg_get_functiondef(p.oid)) > 0
    );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'semantic budgets not fully applied to: %', offenders;
  END IF;

  -- The diacritic range must be exactly as it was. This is the specific
  -- corruption the anchored substitutions exist to avoid.
  --
  -- Note the quoting: pg_get_functiondef returns SOURCE TEXT, so what is present
  -- is the seventeen characters U&'[\0300-\036f]' — not the two codepoints that
  -- literal denotes. Searching for the decoded form finds nothing and would fail
  -- a migration that is perfectly correct.
  SELECT pg_get_functiondef(p.oid) INTO transcripts_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'search_transcripts_hybrid_batch_v3';
  IF position('U&''[\0300-\036f]''' in transcripts_def) = 0 THEN
    RAISE EXCEPTION 'the transcripts diacritic range was altered by this migration';
  END IF;

  -- Every one of the five must still be SECURITY INVOKER, keep a locked
  -- search_path, and still carry ef_search 200 as a real function setting.
  --
  -- proconfig stores the setting as search_path="" — with the quotes — so an
  -- equality test against 'search_path=' fails on a perfectly good function.
  -- left(c, 12) sidesteps both the quoting and LIKE's underscore wildcard.
  SELECT string_agg(p.proname, ', ' ORDER BY p.proname) INTO offenders
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'search\_%\_hybrid\_batch\_v3'
    AND (
      p.prosecdef
      OR NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
        WHERE left(c, 12) = 'search_path='
      )
      OR NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(p.proconfig, ARRAY[]::text[])) c
        WHERE c = 'hnsw.ef_search=200'
      )
    );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'security settings or ef_search wrong on: %', offenders;
  END IF;
END
$verify$;

NOTIFY pgrst, 'reload schema';
