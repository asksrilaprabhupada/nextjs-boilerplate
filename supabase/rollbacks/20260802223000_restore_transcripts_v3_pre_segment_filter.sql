-- OWNER APPROVAL REQUIRED. DO NOT APPLY AUTOMATICALLY.
--
-- Forward rollback only for migration 20260802223000. This restores the exact
-- live predecessor captured before the segment-presence filter was applied.
-- It is deliberately outside supabase/migrations and must be executed only
-- after the owner approves rollback.
--
-- Captured live on 2026-08-03:
--   pg_get_functiondef MD5: f279df34ed55e0493e0c4f2f94cc0660
--   pg_proc.prosrc MD5:     2dff515d4009d751888697e61410ef2a
--   signature: public.search_transcripts_hybrid_batch_v3(
--     jsonb,text[],text[],jsonb,integer,integer
--   )
--
-- Effect: replace one function body and its comment, restore service_role-only
-- EXECUTE grants, and request a PostgREST schema-cache reload. This performs no
-- corpus row update, table rewrite, column change, or index/HNSW rebuild.

CREATE OR REPLACE FUNCTION public.search_transcripts_hybrid_batch_v3(p_queries jsonb, p_lexical_phrases text[] DEFAULT ARRAY[]::text[], p_tag_slugs text[] DEFAULT ARRAY[]::text[], p_constraints jsonb DEFAULT '{}'::jsonb, p_limit integer DEFAULT 120, p_semantic_limit integer DEFAULT 300)
 RETURNS TABLE(passage_key text, source_type text, row_id uuid, retrieval_text text, reference text, speaker text, recipient text, occurred_on date, location text, matched_query_ids text[], channel_ranks jsonb, channel_scores jsonb, tag_matches integer, channel_saturated jsonb)
 LANGUAGE sql
 STABLE
 SET search_path TO ''
 SET "hnsw.ef_search" TO '400'
AS $function$
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
      FROM public.transcript_paragraphs t
      CROSS JOIN cons cn
      WHERE t.embedding_context4 IS NOT NULL
        AND (cn.location IS NULL OR t.location ILIKE '%' || cn.location || '%')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)
      ORDER BY t.embedding_context4 OPERATOR(extensions.<#>) q.emb
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
      FROM public.transcript_paragraphs t
      CROSS JOIN cons cn
      WHERE t.fts_core @@ q.tsq
        AND (cn.location IS NULL OR t.location ILIKE '%' || cn.location || '%')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)
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
      FROM public.transcript_paragraphs t
      CROSS JOIN cons cn
      WHERE t.fts_expansion @@ q.tsq
        AND (cn.location IS NULL OR t.location ILIKE '%' || cn.location || '%')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)
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
      FROM public.transcript_paragraphs t
      CROSS JOIN cons cn
      WHERE t.fts_core @@ l.tsq
        AND (cn.location IS NULL OR t.location ILIKE '%' || cn.location || '%')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)
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
    FROM public.transcript_paragraphs t
    CROSS JOIN cons cn
    WHERE cardinality(COALESCE(p_tag_slugs, ARRAY[]::text[])) > 0
      AND t.tags_core && p_tag_slugs
        AND (cn.location IS NULL OR t.location ILIKE '%' || cn.location || '%')
        AND (cn.date_from IS NULL OR t.date >= cn.date_from)
        AND (cn.date_to IS NULL OR t.date <= cn.date_to)
    ORDER BY (SELECT count(*) FROM unnest(t.tags_core) g WHERE g = ANY(p_tag_slugs)) DESC
    LIMIT p_limit
  ) s
),
sat AS (
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
  'lecture:' || a.row_id::text                                                  AS passage_key,
  'lecture'::text                                                                  AS source_type,
  a.row_id,
  COALESCE(t.body_text, '')                                                                    AS retrieval_text,
  COALESCE(NULLIF(t.title,''), COALESCE(t.content_type,'Recorded talk'))                                                                     AS reference,
  NULL::text                                                                      AS speaker,
  NULL::text                                                                    AS recipient,
  t.date                                                                         AS occurred_on,
  t.location                                                                     AS location,
  a.matched_query_ids,
  a.channel_ranks,
  a.channel_scores,
  a.tag_matches,
  COALESCE(st.flags, '{}'::jsonb)                                                AS channel_saturated
FROM agg a
JOIN public.transcript_paragraphs t ON t.id = a.row_id
CROSS JOIN sat st

ORDER BY a.provisional DESC
LIMIT p_limit;
$function$
;

COMMENT ON FUNCTION public.search_transcripts_hybrid_batch_v3(jsonb, text[], text[], jsonb, integer, integer) IS 'Single-pipeline batched hybrid retrieval over transcript_paragraphs. Takes the original question and all six search angles in ONE call; runs semantic (<#>), fts_core, fts_expansion, caller phrases and controlled tags, keeping every query id separate. Returns raw per-query-per-channel ranks with NO fusion and NO source-type weighting -- ranking happens once, in the application, over the whole pool. ef_search is 400 and p_semantic_limit is clamped to it, so the semantic lane can never be asked for more rows than the index will return (the v2 defect). channel_saturated reports, per channel, whether any query filled its allowance, so adaptive retrieval can tell an exhausted source from a truncated one. Returns passage text only. Generated from the shared template in migration 20260727120000. Added 2026-07-27.';

REVOKE ALL ON FUNCTION public.search_transcripts_hybrid_batch_v3(jsonb, text[], text[], jsonb, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.search_transcripts_hybrid_batch_v3(jsonb, text[], text[], jsonb, integer, integer) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_transcripts_hybrid_batch_v3(jsonb, text[], text[], jsonb, integer, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
