-- ============================================================================
-- search_transcripts_hybrid_batch_v3: surface the speaker, honour speaker_only
-- ============================================================================
--
-- Re-runs the v3 template generator from 20260727120000 for the TRANSCRIPTS
-- row only, with two changes and nothing else:
--
--   1. The @SPEAKER@ slot — hardcoded to 'NULL::text' for every table in the
--      original — becomes 't.speaker', so retrieval carries the deterministic
--      speaker label added by 20260801120000 and the application can warn when
--      a candidate's words are a guest's, not Śrīla Prabhupāda's.
--
--   2. The transcripts constraint gains `p_constraints -> 'speaker_only'`:
--      when true, only paragraphs whose labelled speaker IS Śrīla Prabhupāda
--      are returned. Unlabelled ('unknown') paragraphs are excluded under the
--      filter — "probably him" is not "him". Absent or false, nothing changes.
--
-- The other four functions are untouched. The function signature is untouched,
-- so the application needs no coordination: an app running against the old
-- body simply receives NULL speakers and an ignored constraint key.
--
-- Everything else — clamped p_semantic_limit, ef_search 400, channel_saturated,
-- SECURITY INVOKER, pinned search_path, service_role-only grants — is copied
-- verbatim from 20260727120000. Apply via execute_sql; finish with the pgrst
-- reload NOTIFY so PostgREST picks up the new body.
-- ============================================================================
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
         THEN (p_constraints ->> 'date_to')::date END                    AS date_to,
    COALESCE((p_constraints ->> 'speaker_only') = 'true', false)         AS speaker_only
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
    ('search_transcripts_hybrid_batch_v3', 'transcript_paragraphs', 'lecture', 'lecture', 'COALESCE(t.body_text, '''')', 'COALESCE(NULLIF(t.title,''''), COALESCE(t.content_type,''Recorded talk''))', 't.speaker', 'NULL::text', 't.date', 't.location', '', '
        AND (cn.location IS NULL OR t.location ILIKE ''%'' || cn.location || ''%'')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)
        AND (NOT cn.speaker_only OR t.speaker = ''Śrīla Prabhupāda'')')
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
      || 'with NO fusion and NO source-type weighting. ef_search is 400 and '
      || 'p_semantic_limit is clamped to it. Returns t.speaker (deterministic '
      || '"Name:" backfill, 20260801120000) and honours p_constraints->speaker_only '
      || '(true = only paragraphs labelled as Śrīla Prabhupāda; unlabelled rows are '
      || 'excluded under the filter, because "probably him" is not "him"). '
      || 'Regenerated from the 20260727120000 template on 2026-08-01.');
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
  body text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO body
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'search_transcripts_hybrid_batch_v3';
  IF body IS NULL THEN
    RAISE EXCEPTION 'search_transcripts_hybrid_batch_v3 missing after apply';
  END IF;
  IF body NOT LIKE '%t.speaker%' THEN
    RAISE EXCEPTION 'speaker slot still NULL — the regeneration did not take';
  END IF;
  IF body NOT LIKE '%speaker_only%' THEN
    RAISE EXCEPTION 'speaker_only constraint missing from the regenerated body';
  END IF;

  -- ef_search still pinned to 400 and search_path still pinned, as in v3.
  SELECT string_agg(p.proname, ', ') INTO problem
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'search_transcripts_hybrid_batch_v3'
    AND (p.prosecdef
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c = 'hnsw.ef_search=400')
         OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c LIKE 'search\_path=%'));
  IF problem IS NOT NULL THEN
    RAISE EXCEPTION 'hardening regressed on: %', problem;
  END IF;
END
$verify$;

-- ---------------------------------------------------------------------------
-- Grants. Service role only, matching the other v3 functions.
-- ---------------------------------------------------------------------------
DO $c_grants$
DECLARE fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'search_transcripts_hybrid_batch_v3'
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END
$c_grants$;

NOTIFY pgrst, 'reload schema';
