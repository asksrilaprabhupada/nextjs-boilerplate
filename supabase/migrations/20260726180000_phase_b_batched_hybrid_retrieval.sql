-- ============================================================================
-- Phase B: five batched table-level hybrid retrieval RPCs
-- ============================================================================
--
-- Replaces the per-variant fan-out. The old shape issued 15 RPCs for the
-- original query plus 12 per variant x 10 variants (~135 round trips, up to
-- ~143 for long questions), each crossing the network separately. These five
-- functions each take the ORIGINAL query and every approved subquery in ONE
-- call, run all channels internally, and return per-query-per-channel ranks so
-- the application can perform a single auditable weighted RRF pass.
--
-- CHANNEL ROLES (per the build brief)
--   fts_core       exact phrases, quotations, references, names
--   fts_expansion  aliases, spelling and transliteration variants (weighted lower)
--   semantic       conceptual matches that do not repeat the user's wording
--   lexical        caller-supplied phrases, matched as phrases not bags of words
--   controlled_tags  a modest signal and a coverage aid, never a filter
--
-- WHAT IS DELIBERATELY *NOT* DONE HERE
--   No fusion. These return raw per-channel ranks. Fusion is one weighted pass
--   in the application (SEARCH_V2_CONFIG), so the weights are auditable and
--   testable in one place rather than smeared across five SQL bodies.
--
--   No parent hydration. Each returns passage or chunk text only -- never a
--   whole book, transcript or complete purport. Context is hydrated after
--   selection.
--
-- RANKING SUBQUERY SHAPE
--   Every channel nests an inner ORDER BY ... LIMIT and applies row_number()
--   in an OUTER query. This is load-bearing: window functions are evaluated
--   BEFORE the query's own ORDER BY/LIMIT, so ranking in the same level would
--   compute row_number() across the entire table and discard the index. The
--   nested form lets the HNSW / GIN index serve the LIMIT.
--
-- Semantic uses <#> against the vector_ip_ops HNSW indexes; -(a <#> b) equals
-- cosine because the stored vectors are unit-norm. ef_search is pinned as a
-- function-level SET (a STABLE function cannot execute SET in its body).
--
-- Forward-only and additive. No table, column, index or corpus changes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.resolve_vocabulary_terms_v1(
  p_candidates text[],
  p_limit_per_candidate integer DEFAULT 2
)
RETURNS TABLE(
  candidate text,
  slug text,
  term text,
  facet text,
  match_kind text,
  confidence double precision
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  -- Resolution ladder, strongest first. A candidate that matches nothing
  -- resolves to nothing: Gemini's suggestion is a hint, never an authority,
  -- and an unrecognised concept must not become an arbitrary database slug.
  WITH cand AS (
    SELECT DISTINCT lower(btrim(c)) AS raw
    FROM unnest(COALESCE(p_candidates, ARRAY[]::text[])) c
    WHERE btrim(COALESCE(c, '')) <> ''
  ),
  norm AS (
    SELECT raw,
           regexp_replace(public.normalize_search_query(raw), '[^a-z0-9]+', '-', 'g') AS slugified
    FROM cand
  ),
  matched AS (
    -- 1. exact canonical slug
    SELECT n.raw AS candidate, v.slug, v.term, v.facet, 'slug'::text AS match_kind, 1.00::double precision AS confidence
    FROM norm n JOIN public.vocab_terms v ON v.slug = n.raw OR v.slug = n.slugified
    UNION ALL
    -- 2. exact term
    SELECT n.raw, v.slug, v.term, v.facet, 'term', 0.98
    FROM norm n JOIN public.vocab_terms v ON lower(v.term) = n.raw
    UNION ALL
    -- 3. exact alias / spelling variant
    SELECT n.raw, v.slug, v.term, v.facet, 'variant', 0.94
    FROM norm n JOIN public.vocab_terms v
      ON EXISTS (SELECT 1 FROM unnest(COALESCE(v.variants, ARRAY[]::text[])) a
                 WHERE lower(btrim(a)) = n.raw)
    UNION ALL
    -- 4. normalised-spelling match against term
    SELECT n.raw, v.slug, v.term, v.facet, 'normalised', 0.88
    FROM norm n JOIN public.vocab_terms v
      ON regexp_replace(public.normalize_search_query(lower(v.term)), '[^a-z0-9]+', '-', 'g') = n.slugified
    UNION ALL
    -- 5. trigram similarity, deliberately strict
    SELECT n.raw, v.slug, v.term, v.facet, 'fuzzy',
           0.60 + 0.25 * extensions.similarity(lower(v.term), n.raw)
    FROM norm n JOIN public.vocab_terms v
      ON extensions.similarity(lower(v.term), n.raw) > 0.62
  ),
  ranked AS (
    SELECT m.*, row_number() OVER (PARTITION BY m.candidate
                                   ORDER BY m.confidence DESC, m.slug) AS rn
    FROM (SELECT DISTINCT ON (candidate, slug) * FROM matched
          ORDER BY candidate, slug, confidence DESC) m
  )
  SELECT candidate, slug, term, facet, match_kind, confidence
  FROM ranked
  WHERE rn <= GREATEST(COALESCE(p_limit_per_candidate, 2), 1)
  ORDER BY candidate, confidence DESC;
$fn$;

COMMENT ON FUNCTION public.resolve_vocabulary_terms_v1(text[], integer) IS
  'Resolves model-suggested vocabulary concepts to canonical vocab_terms slugs: exact slug, exact term, alias, normalised spelling, then strict trigram. Unmatched candidates resolve to nothing so an invented concept can never become a retrieval filter. Added 2026-07-26.';


-- ---------------------------------------------------------------------------
-- The five batched retrieval functions, emitted from ONE template.
--
-- PL/pgSQL rather than five literal CREATE statements for two reasons:
--
--  1. `PERFORM '[1]'::extensions.vector` must run in the SAME session, before
--     any CREATE that carries `SET hnsw.ef_search`. Until pgvector's library is
--     loaded the parameter exists only as a GUC *placeholder*, and a
--     non-superuser (Supabase's `postgres`) gets:
--         ERROR 42501: permission denied to set parameter "hnsw.ef_search"
--
--  2. The five bodies are identical apart from the table and its projection.
--     Copied out five times they drift one edit at a time; generated from one
--     template they cannot. `pg_get_functiondef` shows the expanded truth.
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
  p_limit integer DEFAULT 60
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
  tag_matches integer
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
SET hnsw.ef_search = '100'
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
      LIMIT p_limit
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
  a.tag_matches
FROM agg a
JOIN public.@TBL@ t ON t.id = a.row_id
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
    ('search_verses_hybrid_batch_v2', 'verses', 'verse', 'verse', 'COALESCE(t.translation, '''')', 't.scripture || '' '' || COALESCE(NULLIF(ch.canto_or_division,'''') || ''.'', '''') || COALESCE(ch.chapter_number::text || ''.'', '''') || t.verse_number', 'NULL::text', 'NULL::text', 'NULL::date', 'NULL::text', 'LEFT JOIN public.chapters ch ON ch.id = t.chapter_id', '
        AND (cardinality(cn.scriptures) = 0 OR t.scripture = ANY(cn.scriptures))'),
    ('search_verse_chunks_hybrid_batch_v2', 'verse_chunks', 'purport', 'purport', 'COALESCE(t.body_text, '''')', 't.scripture || '' '' || COALESCE(t.chapter_number::text || ''.'', '''') || t.verse_number', 'NULL::text', 'NULL::text', 'NULL::date', 'NULL::text', '', '
        AND (cardinality(cn.scriptures) = 0 OR t.scripture = ANY(cn.scriptures))'),
    ('search_prose_hybrid_batch_v2', 'prose_paragraphs', 'book', 'book', 'COALESCE(t.body_text, '''')', 'COALESCE(ch.chapter_title, t.book_slug) || '' ¶'' || t.paragraph_number::text', 'NULL::text', 'NULL::text', 'NULL::date', 'NULL::text', 'LEFT JOIN public.chapters ch ON ch.id = t.chapter_id', ''),
    ('search_transcripts_hybrid_batch_v2', 'transcript_paragraphs', 'lecture', 'lecture', 'COALESCE(t.body_text, '''')', 'COALESCE(NULLIF(t.title,''''), COALESCE(t.content_type,''Recorded talk''))', 'NULL::text', 'NULL::text', 't.date', 't.location', '', '
        AND (cn.location IS NULL OR t.location ILIKE ''%'' || cn.location || ''%'')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)'),
    ('search_letters_hybrid_batch_v2', 'letter_paragraphs', 'letter', 'letter', 'COALESCE(t.body_text, '''')', 'COALESCE(NULLIF(t.title,''''), ''Letter'')', 'NULL::text', 't.recipient', 't.date', 't.location', '', '
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
      'COMMENT ON FUNCTION public.%I(jsonb, text[], text[], jsonb, integer) IS %L',
      r.fn,
      'Phase B batched hybrid retrieval over ' || r.tbl || '. Takes the original '
      || 'query and all approved subqueries in ONE call; runs semantic (<#>), '
      || 'fts_core, fts_expansion, caller phrases and controlled tags; returns '
      || 'per-query-per-channel ranks for a single application-side weighted RRF. '
      || 'Returns passage text only -- parent context is hydrated after selection. '
      || 'Generated from the shared template in migration 20260726180000. Added 2026-07-26.');
  END LOOP;
END
$emit$;

DO $verify$
DECLARE
  missing text;
BEGIN
  SELECT string_agg(x.fn, ', ') INTO missing
  FROM (VALUES
    ('search_verses_hybrid_batch_v2'), ('search_verse_chunks_hybrid_batch_v2'),
    ('search_prose_hybrid_batch_v2'), ('search_transcripts_hybrid_batch_v2'),
    ('search_letters_hybrid_batch_v2'), ('resolve_vocabulary_terms_v1')
  ) AS x(fn)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = x.fn
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Phase B retrieval functions missing after apply: %', missing;
  END IF;

  SELECT string_agg(p.proname, ', ') INTO missing
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname LIKE 'search%hybrid_batch_v2'
    AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'hnsw.ef\_search=%');
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'ef_search not pinned on: %', missing;
  END IF;
END
$verify$;

DO $b_grants$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        'search_verses_hybrid_batch_v2', 'search_verse_chunks_hybrid_batch_v2',
        'search_prose_hybrid_batch_v2', 'search_transcripts_hybrid_batch_v2',
        'search_letters_hybrid_batch_v2', 'resolve_vocabulary_terms_v1'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END
$b_grants$;

NOTIFY pgrst, 'reload schema';
