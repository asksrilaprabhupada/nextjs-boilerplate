-- ============================================================================
-- Single-pipeline rebuild: five batched hybrid retrieval RPCs, v3
-- ============================================================================
--
-- v2 (migration 20260726180000) is left in place and untouched. Dropping it
-- belongs in a separate migration once the new pipeline has been stable in
-- production, per the rule that no function is dropped until code search and
-- runtime both prove nothing calls it.
--
-- WHY v3 EXISTS AT ALL — one measured defect, and one thing v2 could not say.
--
-- 1. THE SEMANTIC LANE WAS SILENTLY CAPPED.
--    v2 pins `SET hnsw.ef_search = '100'` at function level. pgvector's HNSW
--    scan cannot return more rows than ef_search, so a caller asking for more
--    got fewer -- with no error and no signal. Measured against production on
--    2026-07-27: calling search_transcripts_hybrid_batch_v2 with seven queries,
--    real embeddings and p_limit = 300 returned 300 rows of which exactly 100
--    carried a semantic score. Raising p_limit on v2 buys nothing semantically.
--
--    v3 raises ef_search to 400 and adds p_semantic_limit, CLAMPED IN SQL to
--    that same 400. The clamp is the point: the caller can ask for less, never
--    for more than the index will honour, so the truncation that cannot be
--    detected also cannot be requested.
--
--    Cost, measured warm on transcript_paragraphs (144,438 rows):
--        ef_search=100, LIMIT 100  ->   6.5 ms
--        ef_search=400, LIMIT 300  ->  25.0 ms
--    Cold first touch is 1.4-3.0 s and dominates; that is a prewarm problem,
--    not a reason to keep a cap that loses passages.
--
-- 2. "NO MORE ROWS" AND "WE STOPPED EARLY" LOOKED IDENTICAL.
--    Adaptive retrieval has to decide whether to widen a table. It cannot read
--    that off the returned rows: the outer LIMIT truncates the union, so the
--    highest rank actually observed understates how deep a channel really went.
--
--    v3 adds `channel_saturated` -- per channel, did ANY query fill its
--    allowance. False means that channel is genuinely exhausted and widening
--    would return nothing new; true means widening may still find passages.
--    It is computed from the channel CTEs that are already materialised, so it
--    costs no extra scan, and it is repeated on every row because a
--    set-returning function has nowhere else to put it. The payload is five
--    booleans.
--
-- WHAT IS DELIBERATELY UNCHANGED FROM v2
--   Still no fusion, and now not even a provisional one that the application
--   respects: `provisional` orders the truncation only. Ranking is one pass in
--   the application, over the whole pool, with no query weighting and no
--   source-type weighting -- `source_type` remains a literal label, never a
--   score. Still no parent hydration. Still SECURITY INVOKER, search_path
--   pinned, service_role only.
--
-- Forward-only and additive. No table, column, index or corpus changes.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Emitted from ONE template, for the same two reasons as v2:
--
--  1. `PERFORM '[1]'::extensions.vector` must run in the SAME session before
--     any CREATE carrying `SET hnsw.ef_search`, or a non-superuser hits
--     ERROR 42501: permission denied to set parameter "hnsw.ef_search".
--
--  2. Five bodies differing only in table and projection drift one edit at a
--     time when copied; generated from one template they cannot.
--
-- Substitution is `replace()`, not `format()`, so the `%` in the ILIKE
-- constraints needs no escaping and cannot be misread as a format specifier.
-- ---------------------------------------------------------------------------
DO $emit$
DECLARE
  tpl text := $tpl$
CREATE OR REPLACE FUNCTION public.@FN@(
  p_queries jsonb,
  p_lexical_phrases text[] DEFAULT ARRAY[]::text[],
  p_tag_slugs text[] DEFAULT ARRAY[]::text[],
  p_constraints jsonb DEFAULT '{}'::jsonb,
  p_limit integer DEFAULT 120,
  p_semantic_limit integer DEFAULT 300
)
RETURNS TABLE(
  passage_key text,
  source_type text,
  row_id uuid,
  retrieval_text text,
  reference text,
  speaker text,
  recipient text,
  occurred_on date,
  location text,
  matched_query_ids text[],
  channel_ranks jsonb,
  channel_scores jsonb,
  tag_matches integer,
  channel_saturated jsonb
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
SET hnsw.ef_search = '400'
AS $fn$
WITH cons AS (
  SELECT
    CASE WHEN jsonb_typeof(p_constraints -> 'scripture_references') = 'array'
         THEN ARRAY(SELECT upper(btrim(v))
                    FROM jsonb_array_elements_text(p_constraints -> 'scripture_references') v
                    WHERE btrim(v) <> '')
         ELSE ARRAY[]::text[] END                                        AS scriptures,
    NULLIF(btrim(COALESCE(p_constraints ->> 'recipient', '')), '')       AS recipient,
    NULLIF(btrim(COALESCE(p_constraints ->> 'location', '')), '')        AS location,
    CASE WHEN COALESCE(p_constraints ->> 'date_from', '') ~ '^\d{4}-\d{2}-\d{2}$'
         THEN (p_constraints ->> 'date_from')::date END                  AS date_from,
    CASE WHEN COALESCE(p_constraints ->> 'date_to', '') ~ '^\d{4}-\d{2}-\d{2}$'
         THEN (p_constraints ->> 'date_to')::date END                    AS date_to
),
qs AS (
  SELECT
    x.id                                                                 AS query_id,
    x."text"                                                             AS query_text,
    CASE WHEN jsonb_typeof(x.embedding) = 'array' AND jsonb_array_length(x.embedding) > 0
         THEN ('[' || (SELECT string_agg(e.v, ',' ORDER BY e.ord)
                       FROM jsonb_array_elements_text(x.embedding) WITH ORDINALITY AS e(v, ord))
                   || ']')::extensions.vector
    END                                                                  AS emb,
    pg_catalog.websearch_to_tsquery('public.english_unaccent',
      public.normalize_search_query(x."text"))                           AS tsq
  FROM jsonb_to_recordset(COALESCE(p_queries, '[]'::jsonb))
       AS x(id text, "text" text, embedding jsonb)
  WHERE COALESCE(btrim(x.id), '') <> '' AND COALESCE(btrim(x."text"), '') <> ''
),
sem AS (
  SELECT q.query_id, r.row_id, r.rnk, r.score
  FROM qs q
  CROSS JOIN LATERAL (
    SELECT s.row_id, s.score, row_number() OVER (ORDER BY s.score DESC) AS rnk
    FROM (
      SELECT t.id AS row_id,
             (-1.0 * (t.embedding_context4 OPERATOR(extensions.<#>) q.emb))::double precision AS score
      FROM public.@TBL@ t
      CROSS JOIN cons cn
      WHERE t.embedding_context4 IS NOT NULL@CONS@
      ORDER BY t.embedding_context4 OPERATOR(extensions.<#>) q.emb
      -- The clamp. ef_search above is 400 and an HNSW scan cannot return more
      -- rows than ef_search, so asking for more would silently return fewer.
      LIMIT least(greatest(COALESCE(p_semantic_limit, 300), 1), 400)
    ) s
  ) r
  WHERE q.emb IS NOT NULL
),
ftsc AS (
  SELECT q.query_id, r.row_id, r.rnk, r.score
  FROM qs q
  CROSS JOIN LATERAL (
    SELECT s.row_id, s.score, row_number() OVER (ORDER BY s.score DESC) AS rnk
    FROM (
      SELECT t.id AS row_id,
             pg_catalog.ts_rank_cd(t.fts_core, q.tsq)::double precision AS score
      FROM public.@TBL@ t
      CROSS JOIN cons cn
      WHERE t.fts_core @@ q.tsq@CONS@
      ORDER BY pg_catalog.ts_rank_cd(t.fts_core, q.tsq) DESC
      LIMIT p_limit
    ) s
  ) r
  WHERE q.tsq IS NOT NULL
),
ftse AS (
  SELECT q.query_id, r.row_id, r.rnk, r.score
  FROM qs q
  CROSS JOIN LATERAL (
    SELECT s.row_id, s.score, row_number() OVER (ORDER BY s.score DESC) AS rnk
    FROM (
      SELECT t.id AS row_id,
             pg_catalog.ts_rank_cd(t.fts_expansion, q.tsq)::double precision AS score
      FROM public.@TBL@ t
      CROSS JOIN cons cn
      WHERE t.fts_expansion @@ q.tsq@CONS@
      ORDER BY pg_catalog.ts_rank_cd(t.fts_expansion, q.tsq) DESC
      LIMIT p_limit
    ) s
  ) r
  WHERE q.tsq IS NOT NULL
),
lexq AS (
  SELECT pg_catalog.phraseto_tsquery('public.english_unaccent',
           public.normalize_search_query(p)) AS tsq
  FROM unnest(COALESCE(p_lexical_phrases, ARRAY[]::text[])) p
  WHERE COALESCE(btrim(p), '') <> ''
),
lex AS (
  SELECT r.row_id, min(r.rnk) AS rnk, max(r.score) AS score
  FROM lexq l
  CROSS JOIN LATERAL (
    SELECT s.row_id, s.score, row_number() OVER (ORDER BY s.score DESC) AS rnk
    FROM (
      SELECT t.id AS row_id,
             pg_catalog.ts_rank_cd(t.fts_core, l.tsq)::double precision AS score
      FROM public.@TBL@ t
      CROSS JOIN cons cn
      WHERE t.fts_core @@ l.tsq@CONS@
      ORDER BY pg_catalog.ts_rank_cd(t.fts_core, l.tsq) DESC
      LIMIT p_limit
    ) s
  ) r
  WHERE l.tsq IS NOT NULL
  GROUP BY r.row_id
),
tg AS (
  SELECT s.row_id, s.n, row_number() OVER (ORDER BY s.n DESC) AS rnk
  FROM (
    SELECT t.id AS row_id,
           (SELECT count(*) FROM unnest(t.tags_core) g WHERE g = ANY(p_tag_slugs))::integer AS n
    FROM public.@TBL@ t
    CROSS JOIN cons cn
    WHERE cardinality(COALESCE(p_tag_slugs, ARRAY[]::text[])) > 0
      AND t.tags_core && p_tag_slugs@CONS@
    ORDER BY (SELECT count(*) FROM unnest(t.tags_core) g WHERE g = ANY(p_tag_slugs)) DESC
    LIMIT p_limit
  ) s
),
sat AS (
  -- Did any query fill its allowance on this channel? Read off the CTEs above,
  -- which are already materialised because each is referenced twice, so this
  -- adds no scan. FALSE means the channel is exhausted and widening this table
  -- would return nothing new.
  SELECT jsonb_object_agg(s.ch, s.hit) AS flags
  FROM (
    SELECT 'semantic'::text AS ch,
           COALESCE(bool_or(c.n >= least(greatest(COALESCE(p_semantic_limit, 300), 1), 400)),
                    false) AS hit
    FROM (SELECT query_id, count(*) AS n FROM sem GROUP BY query_id) c
    UNION ALL
    SELECT 'fts_core', COALESCE(bool_or(c.n >= p_limit), false)
    FROM (SELECT query_id, count(*) AS n FROM ftsc GROUP BY query_id) c
    UNION ALL
    SELECT 'fts_expansion', COALESCE(bool_or(c.n >= p_limit), false)
    FROM (SELECT query_id, count(*) AS n FROM ftse GROUP BY query_id) c
    UNION ALL
    SELECT 'lexical', COALESCE((SELECT count(*) FROM lex) >= p_limit, false)
    UNION ALL
    SELECT 'controlled_tags', COALESCE((SELECT count(*) FROM tg) >= p_limit, false)
  ) s
),
hits AS (
              SELECT query_id            AS query_id, 'semantic'::text      AS channel,
                     row_id AS row_id, rnk AS rnk, score AS score               FROM sem
    UNION ALL SELECT query_id,           'fts_core',        row_id, rnk, score  FROM ftsc
    UNION ALL SELECT query_id,           'fts_expansion',   row_id, rnk, score  FROM ftse
    UNION ALL SELECT '__lexical__',      'lexical',         row_id, rnk, score  FROM lex
    UNION ALL SELECT '__tags__',         'controlled_tags', row_id, rnk,
                     n::double precision                                        FROM tg
),
agg AS (
  SELECT h.row_id,
         COALESCE(array_agg(DISTINCT h.query_id)
                    FILTER (WHERE h.query_id NOT IN ('__lexical__', '__tags__')),
                  ARRAY[]::text[])                                               AS matched_query_ids,
         jsonb_agg(jsonb_build_object(
           'query_id', h.query_id, 'channel', h.channel,
           'rank', h.rnk, 'score', round(h.score::numeric, 6))
           ORDER BY h.channel, h.rnk)                                            AS channel_ranks,
         jsonb_object_agg(h.channel, h.best_score)                               AS channel_scores,
         COALESCE(max(h.tagn), 0)::integer                                       AS tag_matches,
         sum(1.0 / (50 + h.rnk))                                                 AS provisional
  FROM (
    SELECT query_id, channel, row_id, rnk, score,
           max(score) OVER (PARTITION BY row_id, channel)                        AS best_score,
           CASE WHEN channel = 'controlled_tags' THEN score::integer END          AS tagn
    FROM hits
  ) h
  GROUP BY h.row_id
)
SELECT
  '@PREFIX@:' || a.row_id::text                                                  AS passage_key,
  '@SRC@'::text                                                                  AS source_type,
  a.row_id,
  @TEXT@                                                                    AS retrieval_text,
  @REF@                                                                     AS reference,
  @SPEAKER@                                                                      AS speaker,
  @RECIPIENT@                                                                    AS recipient,
  @DATE@                                                                         AS occurred_on,
  @LOCATION@                                                                     AS location,
  a.matched_query_ids,
  a.channel_ranks,
  a.channel_scores,
  a.tag_matches,
  COALESCE(st.flags, '{}'::jsonb)                                                AS channel_saturated
FROM agg a
JOIN public.@TBL@ t ON t.id = a.row_id
CROSS JOIN sat st
@JOINS@
ORDER BY a.provisional DESC
LIMIT p_limit;
$fn$;
$tpl$;
  sql text;
  r   record;
BEGIN
  PERFORM '[1]'::extensions.vector;

  FOR r IN
    SELECT * FROM (VALUES
    ('search_verses_hybrid_batch_v3', 'verses', 'verse', 'verse', 'COALESCE(t.translation, '''')', 't.scripture || '' '' || COALESCE(NULLIF(ch.canto_or_division,'''') || ''.'', '''') || COALESCE(ch.chapter_number::text || ''.'', '''') || t.verse_number', 'NULL::text', 'NULL::text', 'NULL::date', 'NULL::text', 'LEFT JOIN public.chapters ch ON ch.id = t.chapter_id', '
        AND (cardinality(cn.scriptures) = 0 OR t.scripture = ANY(cn.scriptures))'),
    ('search_verse_chunks_hybrid_batch_v3', 'verse_chunks', 'purport', 'purport', 'COALESCE(t.body_text, '''')', 't.scripture || '' '' || COALESCE(t.chapter_number::text || ''.'', '''') || t.verse_number', 'NULL::text', 'NULL::text', 'NULL::date', 'NULL::text', '', '
        AND (cardinality(cn.scriptures) = 0 OR t.scripture = ANY(cn.scriptures))'),
    ('search_prose_hybrid_batch_v3', 'prose_paragraphs', 'book', 'book', 'COALESCE(t.body_text, '''')', 'COALESCE(ch.chapter_title, t.book_slug) || '' ¶'' || t.paragraph_number::text', 'NULL::text', 'NULL::text', 'NULL::date', 'NULL::text', 'LEFT JOIN public.chapters ch ON ch.id = t.chapter_id', ''),
    ('search_transcripts_hybrid_batch_v3', 'transcript_paragraphs', 'lecture', 'lecture', 'COALESCE(t.body_text, '''')', 'COALESCE(NULLIF(t.title,''''), COALESCE(t.content_type,''Recorded talk''))', 'NULL::text', 'NULL::text', 't.date', 't.location', '', '
        AND (cn.location IS NULL OR t.location ILIKE ''%'' || cn.location || ''%'')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)'),
    ('search_letters_hybrid_batch_v3', 'letter_paragraphs', 'letter', 'letter', 'COALESCE(t.body_text, '''')', 'COALESCE(NULLIF(t.title,''''), ''Letter'')', 'NULL::text', 't.recipient', 't.date', 't.location', '', '
        AND (cn.recipient IS NULL OR t.recipient ILIKE ''%'' || cn.recipient || ''%'')
        AND (cn.location IS NULL OR t.location ILIKE ''%'' || cn.location || ''%'')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)')
    ) AS v(fn, tbl, src, prefix, text_expr, ref_expr, speaker,
           recipient, dt, loc, joins, cons)
  LOOP
    sql := tpl;
    sql := replace(sql, '@FN@',        r.fn);
    sql := replace(sql, '@TBL@',       r.tbl);
    sql := replace(sql, '@SRC@',       r.src);
    sql := replace(sql, '@PREFIX@',    r.prefix);
    sql := replace(sql, '@TEXT@',      r.text_expr);
    sql := replace(sql, '@REF@',       r.ref_expr);
    sql := replace(sql, '@SPEAKER@',   r.speaker);
    sql := replace(sql, '@RECIPIENT@', r.recipient);
    sql := replace(sql, '@DATE@',      r.dt);
    sql := replace(sql, '@LOCATION@',  r.loc);
    sql := replace(sql, '@JOINS@',     r.joins);
    sql := replace(sql, '@CONS@',      r.cons);

    -- Guard on the placeholder SHAPE, not on '@': the bodies legitimately
    -- contain '@@' (the full-text match operator), so a bare '@' test would
    -- fire on every table.
    IF sql ~ '@[A-Z_]+@' THEN
      RAISE EXCEPTION 'Unsubstituted placeholder % left in generated body for %',
        substring(sql from '@[A-Z_]+@'), r.fn;
    END IF;

    EXECUTE sql;

    EXECUTE format(
      'COMMENT ON FUNCTION public.%I(jsonb, text[], text[], jsonb, integer, integer) IS %L',
      r.fn,
      'Single-pipeline batched hybrid retrieval over ' || r.tbl || '. Takes the '
      || 'original question and all six search angles in ONE call; runs semantic '
      || '(<#>), fts_core, fts_expansion, caller phrases and controlled tags, '
      || 'keeping every query id separate. Returns raw per-query-per-channel ranks '
      || 'with NO fusion and NO source-type weighting -- ranking happens once, in '
      || 'the application, over the whole pool. ef_search is 400 and p_semantic_limit '
      || 'is clamped to it, so the semantic lane can never be asked for more rows '
      || 'than the index will return (the v2 defect). channel_saturated reports, per '
      || 'channel, whether any query filled its allowance, so adaptive retrieval can '
      || 'tell an exhausted source from a truncated one. Returns passage text only. '
      || 'Generated from the shared template in migration 20260727120000. Added 2026-07-27.');
  END LOOP;
END
$emit$;

-- ---------------------------------------------------------------------------
-- Verification. A migration that reports success without checking is how the
-- functions went missing in the first place.
-- ---------------------------------------------------------------------------
DO $verify$
DECLARE
  problem text;
BEGIN
  -- 1. All five present.
  SELECT string_agg(x.fn, ', ') INTO problem
  FROM (VALUES
    ('search_verses_hybrid_batch_v3'), ('search_verse_chunks_hybrid_batch_v3'),
    ('search_prose_hybrid_batch_v3'), ('search_transcripts_hybrid_batch_v3'),
    ('search_letters_hybrid_batch_v3')
  ) AS x(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = x.fn
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'v3 retrieval functions missing after apply: %', problem;
  END IF;

  -- 2. ef_search pinned, and pinned to 400 specifically. A v3 function that
  --    inherited 100 would reintroduce the exact defect this migration exists
  --    to fix, while looking correct.
  SELECT string_agg(p.proname, ', ') INTO problem
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'search%hybrid_batch_v3'
    AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'hnsw.ef_search=400');
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'ef_search not pinned to 400 on: %', problem;
  END IF;

  -- 3. search_path pinned and SECURITY INVOKER, matching v2's hardening.
  SELECT string_agg(p.proname, ', ') INTO problem
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'search%hybrid_batch_v3'
    AND (p.prosecdef
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%'));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'search_path unpinned or SECURITY DEFINER on: %', problem;
  END IF;

  -- 4. The new column is actually in the result type.
  SELECT string_agg(p.proname, ', ') INTO problem
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'search%hybrid_batch_v3'
    AND NOT ('channel_saturated' = ANY(p.proargnames));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'channel_saturated missing from result type on: %', problem;
  END IF;

  -- 5. v2 must still be here. This migration is additive; the new pipeline is
  --    not yet serving, and removing the old lane before that would be an
  --    outage rather than a cleanup.
  SELECT string_agg(x.fn, ', ') INTO problem
  FROM (VALUES
    ('search_verses_hybrid_batch_v2'), ('search_verse_chunks_hybrid_batch_v2'),
    ('search_prose_hybrid_batch_v2'), ('search_transcripts_hybrid_batch_v2'),
    ('search_letters_hybrid_batch_v2')
  ) AS x(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = x.fn
  );
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'v2 retrieval functions were removed by this migration: %', problem;
  END IF;
END
$verify$;

-- ---------------------------------------------------------------------------
-- Grants. Service role only -- these read the whole corpus and must never be
-- reachable from the browser's anon key.
-- ---------------------------------------------------------------------------
DO $c_grants$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'search_verses_hybrid_batch_v3', 'search_verse_chunks_hybrid_batch_v3',
        'search_prose_hybrid_batch_v3', 'search_transcripts_hybrid_batch_v3',
        'search_letters_hybrid_batch_v3'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END
$c_grants$;

NOTIFY pgrst, 'reload schema';
