-- The one query behind every row of docs/search-performance-results.md.
--
-- Committed so that each benchmark is read the same way. If the numbers in the
-- table are ever disputed, this is what produced them.
--
-- Matching is on the question hash, not the text: search_logs is hash-only
-- telemetry and never stores what was asked. The hashes are the sha256 of the
-- normalised question — lowercased, whitespace collapsed, trailing ? ! .
-- stripped — which is what app/lib/search-v2/hash.ts computes.
--
-- The three fixed benchmark questions, by hash:
--   q022  09e1f2ea4614bf52ef4ff305b1d40291bd22ecc00b26bbfac3aebbb0c56a1d61
--   q043  66294d0b5c2266e9fc428e3e73822e2321ee1b56545ead774ceab38097a293ca
--   q055  0770ce70dfbc93346c1797d53144688911189dcfc62faf0be71e5148b5b737b7
--
-- Usage: set the window to cover the benchmark run, then read the rows in
-- created_at order. The FIRST run of question 1 is the cold number; the
-- remaining four are the warm set whose MEDIAN is reported. Nothing else is
-- cold, whatever it cost.

WITH bench AS (
  SELECT
    l.id,
    l.created_at,
    l.telemetry ->> 'questionHash'                              AS question_hash,
    l.status,
    l.total_duration_ms,
    (l.stage_durations_ms ->> 'planning')::numeric              AS planning_ms,
    (l.stage_durations_ms ->> 'retrieving')::numeric            AS retrieving_ms,
    (l.stage_durations_ms ->> 'fusing')::numeric                AS fusing_ms,
    (l.stage_durations_ms ->> 'reranking')::numeric             AS reranking_ms,
    (l.stage_durations_ms ->> 'verifying')::numeric             AS verifying_ms,
    -- The organizing stage is gone; the marker now records a literal 0 so the
    -- column keeps its meaning. COALESCE stays as the belt to that braces: a
    -- row written before the marker existed, or one where the key is missing
    -- for any reason, must still appear in our own results table rather than
    -- vanishing from it silently.
    COALESCE((l.stage_durations_ms ->> 'organizing')::numeric, 0) AS organizing_ms,
    l.telemetry ->> 'cache_status'                              AS cache_status,
    l.telemetry -> 'plan'  ->> 'source'                         AS plan_source,
    (l.telemetry -> 'plan' ->> 'subqueryCount')::int            AS angles,
    l.telemetry -> 'candidates' ->> 'beforeFusion'              AS before_fusion,
    l.telemetry -> 'candidates' ->> 'afterFusion'               AS after_fusion,
    l.telemetry -> 'candidates' ->> 'rerankDocuments'           AS rerank_docs,
    -- The five sources run concurrently, so the slowest one is the floor under
    -- the retrieving stage. The gap above it is embedding and vocabulary, not
    -- the database.
    (SELECT max(v) FROM jsonb_array_elements_text(
       COALESCE(jsonb_path_query_array(l.source_durations_ms, '$.*[*]'), '[]'::jsonb)
     ) AS t(v_text), LATERAL (SELECT v_text::numeric) AS n(v))  AS slowest_source_ms,
    l.source_durations_ms
  FROM public.search_logs l
  WHERE l.created_at >= :'window_start'
    AND l.created_at <  :'window_end'
)
SELECT
  created_at,
  left(question_hash, 12) AS question,
  status,
  round(total_duration_ms / 1000.0, 2)  AS total_s,
  round(planning_ms   / 1000.0, 2)      AS planning_s,
  round(retrieving_ms / 1000.0, 2)      AS retrieving_s,
  round(slowest_source_ms / 1000.0, 2)  AS slowest_source_s,
  round((retrieving_ms - slowest_source_ms) / 1000.0, 2) AS embed_and_vocab_s,
  round(reranking_ms  / 1000.0, 2)      AS reranking_s,
  round(verifying_ms  / 1000.0, 2)      AS verifying_s,
  round(organizing_ms / 1000.0, 2)      AS organizing_s,
  cache_status,
  plan_source,
  angles,
  before_fusion,
  after_fusion,
  rerank_docs,
  source_durations_ms
FROM bench
ORDER BY created_at;
