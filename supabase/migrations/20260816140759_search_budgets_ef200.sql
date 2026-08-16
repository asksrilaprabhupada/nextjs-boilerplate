-- Retrieval budgets: ef_search 400 -> 200, semantic default 300 -> 200,
-- clamp cap 400 -> 200, across all five search_*_hybrid_batch_v3 functions.
--
-- Forward-only. The already-applied migrations that created these functions are
-- never edited; this one replaces the live definitions.
--
-- The three numbers move together on purpose. An HNSW scan can never return
-- more rows than ef_search allows, so leaving the semantic ceiling at 300 or
-- the clamp at 400 while ef_search drops to 200 would make the saturation flag
-- lie — it would report a lane as unsaturated when the index had already
-- stopped handing rows back.
--
-- HOW THIS REWRITES THE FUNCTIONS, AND WHY NOT BY HAND.
--
-- The five bodies are ~10 KB each and one of them (transcripts) contains the
-- Unicode literal U&'[\0300-\036f]', the combining-diacritics range used to
-- strip accents. A blind 300 -> 200 replace would silently corrupt it into
-- \0200-\036f and break accent-insensitive transcript search. Retyping ~50 KB
-- of SQL by hand invites a subtler version of the same mistake.
--
-- So each definition is read back with pg_get_functiondef, four exactly
-- anchored substitutions are applied, and then the substitutions are REVERSED
-- and compared byte-for-byte against the original. If reversing does not
-- reproduce the original exactly, something other than the three budgets
-- changed and the migration aborts having replaced nothing. That check is what
-- protects the diacritic literal: it shares no context with any anchor.
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
-- the parameter becomes real (default 40).
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

    new_def := replace(old_def,
      'SET "hnsw.ef_search" TO ''400''',
      'SET "hnsw.ef_search" TO ''200''');
    new_def := replace(new_def,
      'p_semantic_limit integer DEFAULT 300)',
      'p_semantic_limit integer DEFAULT 200)');
    new_def := replace(new_def,
      'least(greatest(COALESCE(p_semantic_limit, 300), 1), 400)',
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)');
    -- Only the transcripts function carries this comment; keeping it truthful
    -- matters because the next reader will trust it.
    new_def := replace(new_def,
      'ef_search above is 400',
      'ef_search above is 200');

    restored := replace(new_def,
      'SET "hnsw.ef_search" TO ''200''',
      'SET "hnsw.ef_search" TO ''400''');
    restored := replace(restored,
      'p_semantic_limit integer DEFAULT 200)',
      'p_semantic_limit integer DEFAULT 300)');
    restored := replace(restored,
      'least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)',
      'least(greatest(COALESCE(p_semantic_limit, 300), 1), 400)');
    restored := replace(restored,
      'ef_search above is 200',
      'ef_search above is 400');

    IF restored IS DISTINCT FROM old_def THEN
      RAISE EXCEPTION
        'refusing to replace %: the rewrite touched something other than the three budgets', fn;
    END IF;

    IF new_def = old_def THEN
      RAISE EXCEPTION 'refusing to replace %: none of the three budgets were found', fn;
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
      position('SET "hnsw.ef_search" TO ''200''' in pg_get_functiondef(p.oid)) > 0
      AND position('p_semantic_limit integer DEFAULT 200)' in pg_get_functiondef(p.oid)) > 0
      AND position('least(greatest(COALESCE(p_semantic_limit, 200), 1), 200)'
                   in pg_get_functiondef(p.oid)) > 0
      AND position('SET "hnsw.ef_search" TO ''400''' in pg_get_functiondef(p.oid)) = 0
      AND position('COALESCE(p_semantic_limit, 300)' in pg_get_functiondef(p.oid)) = 0
    );
  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'budgets not fully applied to: %', offenders;
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
  -- search_path, and now carry ef_search 200 as a real function setting.
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
