-- ============================================================================
-- Restore the 18 search RPCs the application calls, reimplemented on v3 columns
-- ============================================================================
--
-- WHY THIS EXISTS
--
-- Every search_* RPC and direct_verse_lookup was dropped from this database.
-- app/api/search/route.ts still calls them, and because supabase-js RESOLVES
-- (rather than rejects) on a Postgres error, `{ data: null, error }` was being
-- read as `.data || []` — so a total infrastructure failure was rendered to
-- devotees as "no passages found", HTTP 200, validated: true.
--
-- WHY IT IS A REWRITE AND NOT A REPLAY
--
-- The historical definitions are recoverable from
-- supabase_migrations.schema_migrations.statements, but their bodies reference
-- the columns `fts`, `tags` and `embedding`, which a v3 cutover deleted. Those
-- historical bodies are PROVENANCE ONLY. This migration preserves each
-- function's argument names/order/types/defaults and its return column
-- names/order/types EXACTLY (the application calls them with named arguments
-- and maps the result columns positionally), while reimplementing the bodies
-- against the surviving v3 columns:
--
--     legacy `fts`        -> `fts_core`
--     legacy `embedding`  -> `embedding_context4`
--     legacy `tags`       -> `tags_core`  (returned under the alias `tags`)
--
-- Provenance of each restored signature:
--   fulltext ............ 20260331112116_fix_all_fulltext_search_functions_english_unaccent
--   semantic ............ 20260330151807_add_hnsw_ef_search_to_semantic_functions
--   verse_chunks ........ 20260331220334_drop_and_recreate_verse_chunks_search
--   verses/prose by_tags  20260325223207_create_tag_search_functions_and_indexes
--   transcript/letter ... 20260327233210_create_transcript_letter_search_rpcs
--   direct lookup ....... 20260331221727_fix_direct_verse_lookup_range_match
--
-- THREE DELIBERATE DEVIATIONS FROM THE HISTORICAL BODIES
--
-- 1. Ranking matches `fts_core` only. `fts_expansion` is populated and useful,
--    but weighting it is a retrieval change that belongs in a benchmarked PR,
--    not in an integrity hotfix. `fts_core` is the honest analogue of `fts`.
--
-- 2. Semantic ordering uses `<#>` (negative inner product), not the historical
--    `<=>` (cosine). The live indexes are `hnsw (embedding_context4
--    vector_ip_ops)`, which `<=>` CANNOT use — replaying it verbatim would have
--    silently degraded every semantic lane to a sequential scan. The stored
--    vectors are unit-norm (measured: L2 = 1.0000000), so -(a <#> b) equals
--    cosine similarity exactly and the historical match_threshold defaults keep
--    their meaning. Verified with EXPLAIN ANALYZE against production:
--    "Index Scan using idx_verses_ctx4_hnsw ... Order By: (embedding_context4 <#> ...)".
--
-- 3. The *_by_tags functions accept CANONICAL VOCABULARY SLUGS ONLY, validated
--    against public.vocab_terms. The historical bodies did ILIKE '%term%'
--    substring matching against free-text tags; `tags_core` now holds slugs
--    ("goloka-vrndavana", "krsna"), and the caller splits queries into single
--    words, so 143 of the 251 vocabulary terms are unreachable that way.
--    NOTE: the application DISABLES these five lanes in Phase A. They are
--    restored so the contract is whole and testable; PR B owns phrase-
--    preserving, ambiguity-aware, batched resolution before re-enabling them.
--    Measured cost of the restored ranked shape on transcript_paragraphs:
--    66,461 rows / ~1.25 s for a common slug ("krsna" tags 60,958 of 144,438
--    paragraphs). PR B must address that before these lanes are called again.
--
-- CORRECTIONS AFTER REVIEW (this file was revised before ever being applied)
--
-- 1. ef_search moved from a body-level `SET LOCAL` to a function-level `SET`
--    clause. A STABLE plpgsql function runs read-only through SPI and cannot
--    execute SET, so all five semantic lanes would have failed on first call.
--    See the note above section 2 — two of the historical definitions had this
--    same bug, which is very likely why the lecture and letter semantic lanes
--    were already returning nothing before the functions were dropped.
-- 2. Added preconditions (section 0a) so a wrong-shaped database fails before
--    any function is created.
-- 3. Grants now cover all 23 RPCs the application calls, not just the ones
--    created here; the five that survived still had PUBLIC EXECUTE.
-- 4. search_rpc_contract_v1 now asserts return schema, security mode, pinned
--    search_path, pinned ef_search and effective grants. Presence checking
--    alone would not have caught correction 1 or 3.
-- 5. Repaired suggest_spelling, which has been raising 42883 on every call
--    since its search_path was pinned without qualifying pg_trgm (section 7b).
--
-- SAFETY
--
-- Forward-only and additive. No DROP ... CASCADE, no table/column/index/data
-- changes, no HNSW tuning, no migration-history repair. Every function is
-- SECURITY INVOKER with `SET search_path = ''` and fully-qualified references;
-- EXECUTE is revoked from PUBLIC/anon/authenticated and granted to service_role
-- only, because every caller is a server route holding the service key.
--
-- Apply atomically. Every statement here is transactional DDL.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0a. Preconditions.
--
-- Every function below is written against a specific schema shape. If any of it
-- is missing, fail here — before a single function is created — rather than
-- creating functions whose bodies explode on first call. This is the check that
-- would have caught a v3 column rename or a moved extension.
-- ---------------------------------------------------------------------------
DO $preconditions$
DECLARE
  missing text;
BEGIN
  -- v3 columns on all five corpus tables.
  SELECT string_agg(t.tbl || '.' || c.col, ', ')
    INTO missing
  FROM (VALUES
      ('verses'), ('verse_chunks'), ('prose_paragraphs'),
      ('transcript_paragraphs'), ('letter_paragraphs')
    ) AS t(tbl)
  CROSS JOIN (VALUES ('embedding_context4'), ('fts_core'), ('tags_core')) AS c(col)
  WHERE NOT EXISTS (
    SELECT 1 FROM information_schema.columns ic
    WHERE ic.table_schema = 'public' AND ic.table_name = t.tbl AND ic.column_name = c.col
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: missing v3 columns: %', missing;
  END IF;

  -- pgvector, and the operator class the semantic ORDER BY depends on. If the
  -- index were built with a different opclass, <#> would silently seq-scan.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'Precondition failed: the vector extension is not installed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_opclass WHERE opcname = 'vector_ip_ops') THEN
    RAISE EXCEPTION 'Precondition failed: vector_ip_ops operator class is absent';
  END IF;

  -- The text search configuration every full-text lane names explicitly.
  IF NOT EXISTS (
    SELECT 1 FROM pg_ts_config c
    JOIN pg_namespace n ON n.oid = c.cfgnamespace
    WHERE n.nspname = 'public' AND c.cfgname = 'english_unaccent'
  ) THEN
    RAISE EXCEPTION 'Precondition failed: text search config public.english_unaccent is absent';
  END IF;

  -- normalize_search_query is called by all seven full-text functions.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'normalize_search_query'
  ) THEN
    RAISE EXCEPTION 'Precondition failed: public.normalize_search_query is absent';
  END IF;

  -- pg_trgm backs suggest_spelling, which section 7b repairs.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') THEN
    RAISE EXCEPTION 'Precondition failed: pg_trgm is not installed';
  END IF;

  -- The indexes that make these functions viable rather than merely correct.
  SELECT string_agg(x.idx, ', ') INTO missing
  FROM (VALUES
      ('idx_verses_ctx4_hnsw'), ('idx_verse_chunks_ctx4_hnsw'),
      ('idx_prose_paragraphs_ctx4_hnsw'), ('idx_transcript_paragraphs_ctx4_hnsw'),
      ('idx_letter_paragraphs_ctx4_hnsw'),
      ('idx_verses_fts_core_gin'), ('idx_verse_chunks_fts_core_gin'),
      ('idx_prose_paragraphs_fts_core_gin'), ('idx_transcript_paragraphs_fts_core_gin'),
      ('idx_letter_paragraphs_fts_core_gin')
    ) AS x(idx)
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes i WHERE i.schemaname = 'public' AND i.indexname = x.idx
  );
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: missing indexes: %', missing;
  END IF;

  -- The exact log_search identity section 7a alters. If it has drifted, stop
  -- rather than hardening the wrong function.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'log_search'
      AND pg_get_function_identity_arguments(p.oid) =
          'p_query text, p_session_id text, p_visitor_id text, p_total_results integer, '
          || 'p_verse_ids uuid[], p_prose_ids uuid[], p_books_returned text[], p_search_method text, '
          || 'p_search_duration_ms integer, p_embedding_duration_ms integer, '
          || 'p_synthesis_duration_ms integer, p_total_duration_ms integer, '
          || 'p_narrative_length integer, p_source text, p_user_agent text, p_referrer text, '
          || 'p_query_variants text[]'
  ) THEN
    RAISE EXCEPTION 'Precondition failed: log_search does not have the expected 17-argument identity';
  END IF;

  -- log_search becomes SECURITY INVOKER below, so service_role must be able to
  -- write the telemetry tables in its own right.
  IF NOT (
    has_table_privilege('service_role', 'public.search_logs', 'INSERT')
    AND has_table_privilege('service_role', 'public.popular_queries', 'INSERT')
  ) THEN
    RAISE EXCEPTION 'Precondition failed: service_role cannot INSERT into search_logs/popular_queries';
  END IF;
END
$preconditions$;


-- ---------------------------------------------------------------------------
-- 0b. Refuse to run if any target already exists.
--
-- These functions are currently absent. If one reappears, something else
-- created it and CREATE OR REPLACE would silently overwrite an unknown
-- definition. Fail loudly instead.
-- ---------------------------------------------------------------------------
DO $guard$
DECLARE
  collisions text;
BEGIN
  SELECT string_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')',
                    ', ' ORDER BY p.proname)
    INTO collisions
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'direct_verse_lookup',
      'search_verses_fulltext', 'search_verses_fulltext_v2',
      'search_prose_fulltext', 'search_prose_fulltext_v2',
      'search_transcript_paragraphs_fulltext', 'search_letter_paragraphs_fulltext',
      'search_verse_chunks_fulltext',
      'search_verses_semantic_v2', 'search_prose_semantic_v2',
      'search_verse_chunks_semantic',
      'search_transcript_paragraphs_semantic', 'search_letter_paragraphs_semantic',
      'search_verses_by_tags', 'search_prose_by_tags', 'search_verse_chunks_by_tags',
      'search_transcript_paragraphs_by_tags', 'search_letter_paragraphs_by_tags',
      'search_rpc_contract_v1'
    );

  IF collisions IS NOT NULL THEN
    RAISE EXCEPTION
      'Refusing to restore search functions: unexpected existing definitions: %',
      collisions;
  END IF;
END
$guard$;


-- ===========================================================================
-- 1. FULL-TEXT LANES  (fts_core, public.english_unaccent, ts_rank_cd)
-- ===========================================================================

CREATE FUNCTION public.search_verses_fulltext(
  search_query text,
  match_count integer DEFAULT 15
)
RETURNS TABLE(
  id uuid, scripture text, verse_number text, sanskrit_devanagari text,
  transliteration text, translation text, purport text, chapter_id uuid,
  vedabase_url text, rank real
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tsq pg_catalog.tsquery := pg_catalog.websearch_to_tsquery(
    'public.english_unaccent', public.normalize_search_query(search_query));
BEGIN
  IF tsq IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
         v.transliteration, v.translation, v.purport, v.chapter_id,
         v.vedabase_url,
         pg_catalog.ts_rank_cd(v.fts_core, tsq) AS rank
  FROM public.verses v
  WHERE v.fts_core @@ tsq
  ORDER BY pg_catalog.ts_rank_cd(v.fts_core, tsq) DESC
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_verses_fulltext_v2(
  search_query text,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, scripture text, verse_number text, sanskrit_devanagari text,
  transliteration text, translation text, purport text, chapter_id uuid,
  vedabase_url text, tags text[], rank real, chapter_number integer,
  canto_or_division text, chapter_title text, book_slug text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tsq pg_catalog.tsquery := pg_catalog.websearch_to_tsquery(
    'public.english_unaccent', public.normalize_search_query(search_query));
BEGIN
  IF tsq IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
         v.transliteration, v.translation, v.purport, v.chapter_id,
         v.vedabase_url, v.tags_core,
         pg_catalog.ts_rank_cd(v.fts_core, tsq) AS rank,
         c.chapter_number, c.canto_or_division, c.chapter_title, c.book_slug
  FROM public.verses v
  LEFT JOIN public.chapters c ON c.id = v.chapter_id
  WHERE v.fts_core @@ tsq
  ORDER BY pg_catalog.ts_rank_cd(v.fts_core, tsq) DESC
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_prose_fulltext(
  search_query text,
  match_count integer DEFAULT 10
)
RETURNS TABLE(
  id uuid, book_slug text, paragraph_number integer, body_text text,
  chapter_id uuid, vedabase_url text, vedabase_url_precise text, rank real
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tsq pg_catalog.tsquery := pg_catalog.websearch_to_tsquery(
    'public.english_unaccent', public.normalize_search_query(search_query));
BEGIN
  IF tsq IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT p.id, p.book_slug, p.paragraph_number, p.body_text,
         p.chapter_id, p.vedabase_url, p.vedabase_url_precise,
         pg_catalog.ts_rank_cd(p.fts_core, tsq) AS rank
  FROM public.prose_paragraphs p
  WHERE p.fts_core @@ tsq
  ORDER BY pg_catalog.ts_rank_cd(p.fts_core, tsq) DESC
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_prose_fulltext_v2(
  search_query text,
  match_count integer DEFAULT 15
)
RETURNS TABLE(
  id uuid, book_slug text, paragraph_number integer, body_text text,
  chapter_id uuid, vedabase_url text, vedabase_url_precise text,
  tags text[], rank real, chapter_title text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tsq pg_catalog.tsquery := pg_catalog.websearch_to_tsquery(
    'public.english_unaccent', public.normalize_search_query(search_query));
BEGIN
  IF tsq IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT p.id, p.book_slug, p.paragraph_number, p.body_text,
         p.chapter_id, p.vedabase_url, p.vedabase_url_precise, p.tags_core,
         pg_catalog.ts_rank_cd(p.fts_core, tsq) AS rank,
         c.chapter_title
  FROM public.prose_paragraphs p
  LEFT JOIN public.chapters c ON c.id = p.chapter_id
  WHERE p.fts_core @@ tsq
  ORDER BY pg_catalog.ts_rank_cd(p.fts_core, tsq) DESC
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_transcript_paragraphs_fulltext(
  search_query text,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, transcript_id uuid, paragraph_number integer, body_text text,
  tags text[], rank real
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tsq pg_catalog.tsquery := pg_catalog.websearch_to_tsquery(
    'public.english_unaccent', public.normalize_search_query(search_query));
BEGIN
  IF tsq IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT tp.id, tp.transcript_id, tp.paragraph_number, tp.body_text, tp.tags_core,
         pg_catalog.ts_rank_cd(tp.fts_core, tsq) AS rank
  FROM public.transcript_paragraphs tp
  WHERE tp.fts_core @@ tsq
  ORDER BY pg_catalog.ts_rank_cd(tp.fts_core, tsq) DESC
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_letter_paragraphs_fulltext(
  search_query text,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, letter_id uuid, paragraph_number integer, body_text text,
  tags text[], rank real
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tsq pg_catalog.tsquery := pg_catalog.websearch_to_tsquery(
    'public.english_unaccent', public.normalize_search_query(search_query));
BEGIN
  IF tsq IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT lp.id, lp.letter_id, lp.paragraph_number, lp.body_text, lp.tags_core,
         pg_catalog.ts_rank_cd(lp.fts_core, tsq) AS rank
  FROM public.letter_paragraphs lp
  WHERE lp.fts_core @@ tsq
  ORDER BY pg_catalog.ts_rank_cd(lp.fts_core, tsq) DESC
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_verse_chunks_fulltext(
  search_query text,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, verse_id uuid, scripture text, chapter_number integer,
  verse_number text, chunk_number integer, body_text text,
  tags text[], rank real
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  tsq pg_catalog.tsquery := pg_catalog.websearch_to_tsquery(
    'public.english_unaccent', public.normalize_search_query(search_query));
BEGIN
  IF tsq IS NULL THEN RETURN; END IF;

  RETURN QUERY
  SELECT vc.id, vc.verse_id, vc.scripture, vc.chapter_number,
         vc.verse_number, vc.chunk_number, vc.body_text, vc.tags_core,
         pg_catalog.ts_rank_cd(vc.fts_core, tsq) AS rank
  FROM public.verse_chunks vc
  WHERE vc.fts_core @@ tsq
  ORDER BY pg_catalog.ts_rank_cd(vc.fts_core, tsq) DESC
  LIMIT match_count;
END;
$fn$;


-- ===========================================================================
-- 2. SEMANTIC LANES  (embedding_context4, hnsw vector_ip_ops via <#>)
--
-- similarity is exposed under its historical name and historical scale:
-- -(a <#> b) == cosine similarity for the unit-norm vectors stored here.
--
-- ef_search is set with a FUNCTION-LEVEL `SET` clause, not a body-level
-- `SET LOCAL`. PL/pgSQL runs a STABLE or IMMUTABLE function through SPI in
-- read-only mode, which rejects `SET` outright, so a body-level statement would
-- make every one of these fail on first call.
--
-- The historical definitions are the cautionary tale. verses/prose/verse_chunks
-- were VOLATILE (unmarked) and their body-level SET LOCAL worked; but
-- search_transcript_paragraphs_semantic and search_letter_paragraphs_semantic
-- were declared STABLE *with* a body-level SET LOCAL — so those two lanes were
-- almost certainly erroring long before the functions were dropped, and the
-- route's `.data || []` swallowed it. The lecture and letter semantic channels
-- were dead silently. The function-level clause is equivalent in effect (the
-- value is scoped to the call and reset on exit) and is valid at any volatility.
-- ===========================================================================

CREATE FUNCTION public.search_verses_semantic_v2(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 30
)
RETURNS TABLE(
  id uuid, scripture text, verse_number text, sanskrit_devanagari text,
  transliteration text, translation text, purport text, chapter_id uuid,
  vedabase_url text, tags text[], similarity double precision,
  chapter_number integer, canto_or_division text, chapter_title text,
  book_slug text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
SET hnsw.ef_search = '100'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
         v.transliteration, v.translation, v.purport, v.chapter_id,
         v.vedabase_url, v.tags_core,
         (-1.0 * (v.embedding_context4 OPERATOR(extensions.<#>) query_embedding))::double precision,
         c.chapter_number, c.canto_or_division, c.chapter_title, c.book_slug
  FROM public.verses v
  LEFT JOIN public.chapters c ON c.id = v.chapter_id
  WHERE v.embedding_context4 IS NOT NULL
    AND (-1.0 * (v.embedding_context4 OPERATOR(extensions.<#>) query_embedding)) > match_threshold
  ORDER BY v.embedding_context4 OPERATOR(extensions.<#>) query_embedding
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_prose_semantic_v2(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, book_slug text, paragraph_number integer, body_text text,
  chapter_id uuid, vedabase_url text, vedabase_url_precise text,
  tags text[], similarity double precision, chapter_title text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
SET hnsw.ef_search = '100'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT p.id, p.book_slug, p.paragraph_number, p.body_text,
         p.chapter_id, p.vedabase_url, p.vedabase_url_precise, p.tags_core,
         (-1.0 * (p.embedding_context4 OPERATOR(extensions.<#>) query_embedding))::double precision,
         c.chapter_title
  FROM public.prose_paragraphs p
  LEFT JOIN public.chapters c ON c.id = p.chapter_id
  WHERE p.embedding_context4 IS NOT NULL
    AND (-1.0 * (p.embedding_context4 OPERATOR(extensions.<#>) query_embedding)) > match_threshold
  ORDER BY p.embedding_context4 OPERATOR(extensions.<#>) query_embedding
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_verse_chunks_semantic(
  query_embedding extensions.vector,
  match_threshold double precision DEFAULT 0.3,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, verse_id uuid, scripture text, chapter_number integer,
  verse_number text, chunk_number integer, body_text text,
  tags text[], similarity double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
SET hnsw.ef_search = '100'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT vc.id, vc.verse_id, vc.scripture, vc.chapter_number,
         vc.verse_number, vc.chunk_number, vc.body_text, vc.tags_core,
         (-1.0 * (vc.embedding_context4 OPERATOR(extensions.<#>) query_embedding))::double precision
  FROM public.verse_chunks vc
  WHERE vc.embedding_context4 IS NOT NULL
    AND (-1.0 * (vc.embedding_context4 OPERATOR(extensions.<#>) query_embedding)) > match_threshold
  ORDER BY vc.embedding_context4 OPERATOR(extensions.<#>) query_embedding
  LIMIT match_count;
END;
$fn$;

-- Transcripts and letters historically took no match_threshold. Preserved.
CREATE FUNCTION public.search_transcript_paragraphs_semantic(
  query_embedding extensions.vector,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, transcript_id uuid, paragraph_number integer, body_text text,
  tags text[], similarity double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
SET hnsw.ef_search = '100'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT tp.id, tp.transcript_id, tp.paragraph_number, tp.body_text, tp.tags_core,
         (-1.0 * (tp.embedding_context4 OPERATOR(extensions.<#>) query_embedding))::double precision
  FROM public.transcript_paragraphs tp
  WHERE tp.embedding_context4 IS NOT NULL
  ORDER BY tp.embedding_context4 OPERATOR(extensions.<#>) query_embedding
  LIMIT match_count;
END;
$fn$;

CREATE FUNCTION public.search_letter_paragraphs_semantic(
  query_embedding extensions.vector,
  match_count integer DEFAULT 20
)
RETURNS TABLE(
  id uuid, letter_id uuid, paragraph_number integer, body_text text,
  tags text[], similarity double precision
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
SET hnsw.ef_search = '100'
AS $fn$
#variable_conflict use_column
BEGIN
  RETURN QUERY
  SELECT lp.id, lp.letter_id, lp.paragraph_number, lp.body_text, lp.tags_core,
         (-1.0 * (lp.embedding_context4 OPERATOR(extensions.<#>) query_embedding))::double precision
  FROM public.letter_paragraphs lp
  WHERE lp.embedding_context4 IS NOT NULL
  ORDER BY lp.embedding_context4 OPERATOR(extensions.<#>) query_embedding
  LIMIT match_count;
END;
$fn$;


-- ===========================================================================
-- 3. TAG LANES  (canonical vocabulary slugs only)
--
-- search_terms are validated against public.vocab_terms.slug; anything that is
-- not a known canonical slug is discarded, and a request that resolves to no
-- slugs returns zero rows rather than an error. The application disables these
-- lanes in Phase A — see the header note.
-- ===========================================================================

CREATE FUNCTION public.search_verses_by_tags(
  search_terms text[],
  match_count integer DEFAULT 15
)
RETURNS TABLE(
  id uuid, scripture text, verse_number text, sanskrit_devanagari text,
  transliteration text, translation text, purport text, chapter_id uuid,
  vedabase_url text, tags text[], tag_matches bigint,
  chapter_number integer, canto_or_division text, chapter_title text,
  book_slug text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH resolved AS (
    SELECT array_agg(DISTINCT vt.slug) AS slugs
    FROM public.vocab_terms vt
    WHERE vt.slug = ANY(search_terms)
  )
  SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
         v.transliteration, v.translation, v.purport, v.chapter_id,
         v.vedabase_url, v.tags_core,
         (SELECT count(*) FROM unnest(v.tags_core) t WHERE t = ANY(r.slugs)) AS tag_matches,
         c.chapter_number, c.canto_or_division, c.chapter_title, c.book_slug
  FROM public.verses v
  CROSS JOIN resolved r
  LEFT JOIN public.chapters c ON c.id = v.chapter_id
  WHERE r.slugs IS NOT NULL
    AND v.tags_core && r.slugs
  ORDER BY (SELECT count(*) FROM unnest(v.tags_core) t WHERE t = ANY(r.slugs)) DESC
  LIMIT match_count;
$fn$;

CREATE FUNCTION public.search_prose_by_tags(
  search_terms text[],
  match_count integer DEFAULT 10
)
RETURNS TABLE(
  id uuid, book_slug text, paragraph_number integer, body_text text,
  chapter_id uuid, vedabase_url text, vedabase_url_precise text,
  tags text[], tag_matches bigint, chapter_title text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH resolved AS (
    SELECT array_agg(DISTINCT vt.slug) AS slugs
    FROM public.vocab_terms vt
    WHERE vt.slug = ANY(search_terms)
  )
  SELECT p.id, p.book_slug, p.paragraph_number, p.body_text,
         p.chapter_id, p.vedabase_url, p.vedabase_url_precise, p.tags_core,
         (SELECT count(*) FROM unnest(p.tags_core) t WHERE t = ANY(r.slugs)) AS tag_matches,
         c.chapter_title
  FROM public.prose_paragraphs p
  CROSS JOIN resolved r
  LEFT JOIN public.chapters c ON c.id = p.chapter_id
  WHERE r.slugs IS NOT NULL
    AND p.tags_core && r.slugs
  ORDER BY (SELECT count(*) FROM unnest(p.tags_core) t WHERE t = ANY(r.slugs)) DESC
  LIMIT match_count;
$fn$;

CREATE FUNCTION public.search_verse_chunks_by_tags(
  search_terms text[],
  match_count integer DEFAULT 15
)
RETURNS TABLE(
  id uuid, verse_id uuid, scripture text, chapter_number integer,
  verse_number text, chunk_number integer, body_text text,
  tags text[], matched_tags text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH resolved AS (
    SELECT array_agg(DISTINCT vt.slug) AS slugs
    FROM public.vocab_terms vt
    WHERE vt.slug = ANY(search_terms)
  )
  SELECT vc.id, vc.verse_id, vc.scripture, vc.chapter_number,
         vc.verse_number, vc.chunk_number, vc.body_text, vc.tags_core,
         ARRAY(SELECT t FROM unnest(vc.tags_core) t WHERE t = ANY(r.slugs)) AS matched_tags
  FROM public.verse_chunks vc
  CROSS JOIN resolved r
  WHERE r.slugs IS NOT NULL
    AND vc.tags_core && r.slugs
  ORDER BY (SELECT count(*) FROM unnest(vc.tags_core) t WHERE t = ANY(r.slugs)) DESC
  LIMIT match_count;
$fn$;

-- Transcripts and letters historically applied no ordering. Preserved: adding
-- one would impose the ~1.25 s ranked scan documented in the header.
CREATE FUNCTION public.search_transcript_paragraphs_by_tags(
  search_terms text[],
  match_count integer DEFAULT 15
)
RETURNS TABLE(
  id uuid, transcript_id uuid, paragraph_number integer, body_text text,
  tags text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH resolved AS (
    SELECT array_agg(DISTINCT vt.slug) AS slugs
    FROM public.vocab_terms vt
    WHERE vt.slug = ANY(search_terms)
  )
  SELECT tp.id, tp.transcript_id, tp.paragraph_number, tp.body_text, tp.tags_core
  FROM public.transcript_paragraphs tp
  CROSS JOIN resolved r
  WHERE r.slugs IS NOT NULL
    AND tp.tags_core && r.slugs
  LIMIT match_count;
$fn$;

CREATE FUNCTION public.search_letter_paragraphs_by_tags(
  search_terms text[],
  match_count integer DEFAULT 15
)
RETURNS TABLE(
  id uuid, letter_id uuid, paragraph_number integer, body_text text,
  tags text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH resolved AS (
    SELECT array_agg(DISTINCT vt.slug) AS slugs
    FROM public.vocab_terms vt
    WHERE vt.slug = ANY(search_terms)
  )
  SELECT lp.id, lp.letter_id, lp.paragraph_number, lp.body_text, lp.tags_core
  FROM public.letter_paragraphs lp
  CROSS JOIN resolved r
  WHERE r.slugs IS NOT NULL
    AND lp.tags_core && r.slugs
  LIMIT match_count;
$fn$;


-- ===========================================================================
-- 4. DIRECT REFERENCE LOOKUP
--
-- Restored from 20260331221727 unchanged except `v.tags` -> `v.tags_core`,
-- full qualification, and the hardened security clauses. The reference parser
-- is behaviour the application depends on for exact-citation queries.
-- ===========================================================================

CREATE FUNCTION public.direct_verse_lookup(ref_query text)
RETURNS TABLE(
  id uuid, scripture text, verse_number text, sanskrit_devanagari text,
  transliteration text, translation text, purport text, chapter_id uuid,
  vedabase_url text, tags text[], chapter_number integer,
  canto_or_division text, chapter_title text, book_slug text
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
#variable_conflict use_column
DECLARE
  cleaned text;
  parts text[];
  ref_scripture text;
  ref_canto text;
  ref_chapter text;
  ref_verse text;
  ref_division text;
BEGIN
  cleaned := lower(btrim(regexp_replace(ref_query, '\s+', ' ', 'g')));
  cleaned := regexp_replace(cleaned, '(^|\s)(verse|mantra|text|sloka|shloka|chapter|canto)(\s|$)', ' ', 'gi');
  cleaned := regexp_replace(cleaned, '(^|\s)(verse|mantra|text|sloka|shloka|chapter|canto)(\s|$)', ' ', 'gi');
  cleaned := btrim(regexp_replace(cleaned, '\s+', ' ', 'g'));
  cleaned := replace(cleaned, '.', ' ');
  cleaned := btrim(regexp_replace(cleaned, '\s+', ' ', 'g'));
  parts := string_to_array(cleaned, ' ');

  IF array_length(parts, 1) IS NULL OR array_length(parts, 1) < 2 THEN RETURN; END IF;
  ref_scripture := upper(parts[1]);

  -- Bhagavad-gita: BG <chapter> [<verse>]
  IF ref_scripture = 'BG' THEN
    IF array_length(parts, 1) >= 3 THEN ref_chapter := parts[2]; ref_verse := parts[3];
    ELSE ref_chapter := parts[2]; ref_verse := NULL; END IF;

    RETURN QUERY
    SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
           v.transliteration, v.translation, v.purport, v.chapter_id,
           v.vedabase_url, v.tags_core, c.chapter_number, c.canto_or_division,
           c.chapter_title, c.book_slug
    FROM public.verses v
    JOIN public.chapters c ON c.id = v.chapter_id
    WHERE v.scripture = 'BG' AND c.chapter_number = ref_chapter::int
      AND (ref_verse IS NULL
           OR v.verse_number = ref_verse
           OR v.verse_number = 'Text ' || ref_verse
           OR v.verse_number LIKE ref_verse || '-%'
           OR v.verse_number LIKE 'Text ' || ref_verse || '-%');
    RETURN;
  END IF;

  -- Srimad-Bhagavatam: SB <canto> <chapter> [<verse>]
  IF ref_scripture = 'SB' THEN
    IF array_length(parts, 1) >= 4 THEN ref_canto := parts[2]; ref_chapter := parts[3]; ref_verse := parts[4];
    ELSIF array_length(parts, 1) = 3 THEN ref_canto := parts[2]; ref_chapter := parts[3]; ref_verse := NULL;
    ELSE RETURN; END IF;

    RETURN QUERY
    SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
           v.transliteration, v.translation, v.purport, v.chapter_id,
           v.vedabase_url, v.tags_core, c.chapter_number, c.canto_or_division,
           c.chapter_title, c.book_slug
    FROM public.verses v
    JOIN public.chapters c ON c.id = v.chapter_id
    WHERE v.scripture = 'SB' AND c.canto_or_division = ref_canto
      AND c.chapter_number = ref_chapter::int
      AND (ref_verse IS NULL
           OR v.verse_number = ref_verse
           OR v.verse_number = 'Text ' || ref_verse
           OR v.verse_number LIKE ref_verse || '-%'
           OR v.verse_number LIKE 'Text ' || ref_verse || '-%');
    RETURN;
  END IF;

  -- Caitanya-caritamrta: CC <division> <chapter> [<verse>]
  IF ref_scripture = 'CC' THEN
    IF array_length(parts, 1) >= 4 THEN ref_division := parts[2]; ref_chapter := parts[3]; ref_verse := parts[4];
    ELSIF array_length(parts, 1) = 3 THEN ref_division := parts[2]; ref_chapter := parts[3]; ref_verse := NULL;
    ELSE RETURN; END IF;

    RETURN QUERY
    SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
           v.transliteration, v.translation, v.purport, v.chapter_id,
           v.vedabase_url, v.tags_core, c.chapter_number, c.canto_or_division,
           c.chapter_title, c.book_slug
    FROM public.verses v
    JOIN public.chapters c ON c.id = v.chapter_id
    WHERE v.scripture = 'CC' AND lower(c.canto_or_division) = lower(ref_division)
      AND c.chapter_number = ref_chapter::int
      AND (ref_verse IS NULL
           OR v.verse_number = ref_verse
           OR v.verse_number = 'Text ' || ref_verse
           OR v.verse_number LIKE ref_verse || '-%'
           OR v.verse_number LIKE 'Text ' || ref_verse || '-%');
    RETURN;
  END IF;

  -- NOI / ISO / BS store the verse number as chapter_number.
  IF ref_scripture IN ('NOI', 'ISO', 'BS') THEN
    ref_verse := parts[2];
    RETURN QUERY
    SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
           v.transliteration, v.translation, v.purport, v.chapter_id,
           v.vedabase_url, v.tags_core, c.chapter_number, c.canto_or_division,
           c.chapter_title, c.book_slug
    FROM public.verses v
    JOIN public.chapters c ON c.id = v.chapter_id
    WHERE v.scripture = ref_scripture AND c.chapter_number = ref_verse::int
    LIMIT 1;
    RETURN;
  END IF;

  IF ref_scripture IN ('NBS', 'MMS') THEN
    ref_verse := parts[2];
    RETURN QUERY
    SELECT v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
           v.transliteration, v.translation, v.purport, v.chapter_id,
           v.vedabase_url, v.tags_core, c.chapter_number, c.canto_or_division,
           c.chapter_title, c.book_slug
    FROM public.verses v
    JOIN public.chapters c ON c.id = v.chapter_id
    WHERE v.scripture = ref_scripture AND v.verse_number = ref_verse
    LIMIT 5;
    RETURN;
  END IF;

  RETURN;
END;
$fn$;


-- ===========================================================================
-- 5. RUNTIME CONTRACT CHECK
--
-- Backs GET /api/health and the contract tests. Reports, for every RPC the
-- application calls, whether a function with the exact expected identity
-- arguments exists, how many overloads share the name, and its security
-- posture. Schema qualification of argument types is normalized away so the
-- result does not depend on the caller's search_path.
-- ===========================================================================

CREATE FUNCTION public.search_rpc_contract_v1()
RETURNS TABLE(
  rpc_name text,
  present boolean,
  overloads integer,
  result_matches boolean,
  security_invoker boolean,
  search_path_pinned boolean,
  ef_search_pinned boolean,
  service_role_executable boolean,
  publicly_executable boolean,
  compatible boolean
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  -- expected_args is matched against pg_get_function_identity_arguments, with
  -- schema qualification normalised away so the result does not depend on the
  -- caller's search_path. needs_ef_search marks the five semantic lanes, whose
  -- ef_search must be pinned as a function configuration rather than set in the
  -- body -- a STABLE function cannot execute SET.
  WITH manifest(rpc_name, expected_args, expected_result, needs_ef_search) AS (
    VALUES
      ('direct_verse_lookup', 'ref_query text',
       'TABLE(id uuid, scripture text, verse_number text, sanskrit_devanagari text, transliteration text, translation text, purport text, chapter_id uuid, vedabase_url text, tags text[], chapter_number integer, canto_or_division text, chapter_title text, book_slug text)', false),
      ('search_verses_fulltext', 'search_query text, match_count integer',
       'TABLE(id uuid, scripture text, verse_number text, sanskrit_devanagari text, transliteration text, translation text, purport text, chapter_id uuid, vedabase_url text, rank real)', false),
      ('search_verses_fulltext_v2', 'search_query text, match_count integer',
       'TABLE(id uuid, scripture text, verse_number text, sanskrit_devanagari text, transliteration text, translation text, purport text, chapter_id uuid, vedabase_url text, tags text[], rank real, chapter_number integer, canto_or_division text, chapter_title text, book_slug text)', false),
      ('search_prose_fulltext', 'search_query text, match_count integer',
       'TABLE(id uuid, book_slug text, paragraph_number integer, body_text text, chapter_id uuid, vedabase_url text, vedabase_url_precise text, rank real)', false),
      ('search_prose_fulltext_v2', 'search_query text, match_count integer',
       'TABLE(id uuid, book_slug text, paragraph_number integer, body_text text, chapter_id uuid, vedabase_url text, vedabase_url_precise text, tags text[], rank real, chapter_title text)', false),
      ('search_transcript_paragraphs_fulltext', 'search_query text, match_count integer',
       'TABLE(id uuid, transcript_id uuid, paragraph_number integer, body_text text, tags text[], rank real)', false),
      ('search_letter_paragraphs_fulltext', 'search_query text, match_count integer',
       'TABLE(id uuid, letter_id uuid, paragraph_number integer, body_text text, tags text[], rank real)', false),
      ('search_verse_chunks_fulltext', 'search_query text, match_count integer',
       'TABLE(id uuid, verse_id uuid, scripture text, chapter_number integer, verse_number text, chunk_number integer, body_text text, tags text[], rank real)', false),
      ('search_verses_semantic_v2', 'query_embedding vector, match_threshold double precision, match_count integer',
       'TABLE(id uuid, scripture text, verse_number text, sanskrit_devanagari text, transliteration text, translation text, purport text, chapter_id uuid, vedabase_url text, tags text[], similarity double precision, chapter_number integer, canto_or_division text, chapter_title text, book_slug text)', true),
      ('search_prose_semantic_v2', 'query_embedding vector, match_threshold double precision, match_count integer',
       'TABLE(id uuid, book_slug text, paragraph_number integer, body_text text, chapter_id uuid, vedabase_url text, vedabase_url_precise text, tags text[], similarity double precision, chapter_title text)', true),
      ('search_verse_chunks_semantic', 'query_embedding vector, match_threshold double precision, match_count integer',
       'TABLE(id uuid, verse_id uuid, scripture text, chapter_number integer, verse_number text, chunk_number integer, body_text text, tags text[], similarity double precision)', true),
      ('search_transcript_paragraphs_semantic', 'query_embedding vector, match_count integer',
       'TABLE(id uuid, transcript_id uuid, paragraph_number integer, body_text text, tags text[], similarity double precision)', true),
      ('search_letter_paragraphs_semantic', 'query_embedding vector, match_count integer',
       'TABLE(id uuid, letter_id uuid, paragraph_number integer, body_text text, tags text[], similarity double precision)', true),
      ('search_verses_by_tags', 'search_terms text[], match_count integer',
       'TABLE(id uuid, scripture text, verse_number text, sanskrit_devanagari text, transliteration text, translation text, purport text, chapter_id uuid, vedabase_url text, tags text[], tag_matches bigint, chapter_number integer, canto_or_division text, chapter_title text, book_slug text)', false),
      ('search_prose_by_tags', 'search_terms text[], match_count integer',
       'TABLE(id uuid, book_slug text, paragraph_number integer, body_text text, chapter_id uuid, vedabase_url text, vedabase_url_precise text, tags text[], tag_matches bigint, chapter_title text)', false),
      ('search_verse_chunks_by_tags', 'search_terms text[], match_count integer',
       'TABLE(id uuid, verse_id uuid, scripture text, chapter_number integer, verse_number text, chunk_number integer, body_text text, tags text[], matched_tags text[])', false),
      ('search_transcript_paragraphs_by_tags', 'search_terms text[], match_count integer',
       'TABLE(id uuid, transcript_id uuid, paragraph_number integer, body_text text, tags text[])', false),
      ('search_letter_paragraphs_by_tags', 'search_terms text[], match_count integer',
       'TABLE(id uuid, letter_id uuid, paragraph_number integer, body_text text, tags text[])', false),
      ('suggest_spelling', 'raw_query text',
       'TABLE(original_query text, suggested_query text, display_query text, corrections jsonb)', false),
      ('get_verse_context', 'p_verse_id uuid, p_radius integer',
       'TABLE(id uuid, chapter_id uuid, scripture text, verse_number text, translation text, vedabase_url text, rel_position integer)', false),
      ('log_search_feedback', 'p_search_log_id uuid, p_vote smallint, p_text text', 'void', false),
      ('log_search_behavior', 'p_search_log_id uuid, p_clicked_citations text[], p_clicked_want_more text[], p_scrolled_to_bottom boolean, p_time_on_result_ms integer, p_followed_up_query text', 'void', false),
      ('log_search', 'p_query text, p_session_id text, p_visitor_id text, p_total_results integer, p_verse_ids uuid[], p_prose_ids uuid[], p_books_returned text[], p_search_method text, p_search_duration_ms integer, p_embedding_duration_ms integer, p_synthesis_duration_ms integer, p_total_duration_ms integer, p_narrative_length integer, p_source text, p_user_agent text, p_referrer text, p_query_variants text[]', 'uuid', false)
  ),
  actual AS (
    SELECT p.oid,
           p.proname::text AS name,
           replace(replace(pg_catalog.pg_get_function_identity_arguments(p.oid),
                           'extensions.', ''), 'public.', '') AS args,
           replace(replace(pg_catalog.pg_get_function_result(p.oid),
                           'extensions.', ''), 'public.', '') AS result,
           p.prosecdef,
           p.proconfig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  ),
  joined AS (
    SELECT m.rpc_name::text AS rpc_name,
           m.needs_ef_search,
           (a.oid IS NOT NULL) AS present,
           (SELECT count(*)::integer FROM actual x WHERE x.name = m.rpc_name) AS overloads,
           (a.result IS NOT DISTINCT FROM m.expected_result) AS result_matches,
           (a.prosecdef IS FALSE) AS security_invoker,
           COALESCE(
             EXISTS (SELECT 1 FROM unnest(a.proconfig) c WHERE c LIKE 'search\_path=%'),
             false) AS search_path_pinned,
           COALESCE(
             EXISTS (SELECT 1 FROM unnest(a.proconfig) c WHERE c LIKE 'hnsw.ef\_search=%'),
             false) AS ef_search_pinned,
           COALESCE(pg_catalog.has_function_privilege('service_role', a.oid, 'EXECUTE'), false)
             AS service_role_executable,
           COALESCE(
             pg_catalog.has_function_privilege('public', a.oid, 'EXECUTE')
             OR pg_catalog.has_function_privilege('anon', a.oid, 'EXECUTE')
             OR pg_catalog.has_function_privilege('authenticated', a.oid, 'EXECUTE'),
             false) AS publicly_executable
    FROM manifest m
    LEFT JOIN actual a
      ON a.name = m.rpc_name
     AND a.args = m.expected_args
  )
  SELECT j.rpc_name,
         j.present,
         j.overloads,
         j.result_matches,
         j.security_invoker,
         j.search_path_pinned,
         j.ef_search_pinned,
         j.service_role_executable,
         j.publicly_executable,
         (j.present
          AND j.overloads = 1
          AND j.result_matches
          AND j.security_invoker
          AND j.search_path_pinned
          AND j.service_role_executable
          AND NOT j.publicly_executable
          AND (NOT j.needs_ef_search OR j.ef_search_pinned)) AS compatible
  FROM joined j
  ORDER BY j.rpc_name;
$fn$;


-- ===========================================================================
-- 6. PRIVILEGES
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on CREATE FUNCTION. Every
-- caller of these functions is a Next.js server route using the service key,
-- so the exposed surface is narrowed deliberately rather than inherited.
-- ===========================================================================

-- Covers all 23 RPCs the application calls, not only the ones created here.
-- The five that survived the outage still carried PUBLIC + anon + authenticated
-- EXECUTE, which nothing needs: every caller is a server route holding the
-- service key.
DO $grants$
DECLARE
  fn record;
BEGIN
  FOR fn IN
    SELECT p.oid::regprocedure AS sig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname IN (
        -- restored here
        'direct_verse_lookup',
        'search_verses_fulltext', 'search_verses_fulltext_v2',
        'search_prose_fulltext', 'search_prose_fulltext_v2',
        'search_transcript_paragraphs_fulltext', 'search_letter_paragraphs_fulltext',
        'search_verse_chunks_fulltext',
        'search_verses_semantic_v2', 'search_prose_semantic_v2',
        'search_verse_chunks_semantic',
        'search_transcript_paragraphs_semantic', 'search_letter_paragraphs_semantic',
        'search_verses_by_tags', 'search_prose_by_tags', 'search_verse_chunks_by_tags',
        'search_transcript_paragraphs_by_tags', 'search_letter_paragraphs_by_tags',
        'search_rpc_contract_v1',
        -- survived the outage, still over-granted until now
        'suggest_spelling', 'get_verse_context',
        'log_search', 'log_search_feedback', 'log_search_behavior'
      )
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM anon', fn.sig);
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM authenticated', fn.sig);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn.sig);
  END LOOP;
END
$grants$;


-- ===========================================================================
-- 7a. log_search hardening
--
-- log_search is SECURITY DEFINER and executable by anon/authenticated, which
-- the Supabase linter flags (0028/0029). It dated from a time when the browser
-- logged searches directly; today its only callers are app/api/search/route.ts
-- and app/api/analytics/log/route.ts, both server-side with the service key.
-- service_role has rolbypassrls = true and INSERT on search_logs and
-- popular_queries (asserted in the preconditions), so SECURITY INVOKER is
-- sufficient. Grants are handled by the loop above.
-- ===========================================================================

ALTER FUNCTION public.log_search(
  text, text, text, integer, uuid[], uuid[], text[], text, integer, integer,
  integer, integer, integer, text, text, text, text[]
) SECURITY INVOKER;


-- ===========================================================================
-- 7b. suggest_spelling repair
--
-- Verified broken in production:
--   ERROR 42883: function similarity(text, text) does not exist
--
-- pg_trgm lives in the `extensions` schema, but 20260705144937 pinned this
-- function to `search_path = public, pg_temp` without qualifying the call, so
-- every invocation has been failing. The route swallowed it along with
-- everything else; it is now reported as a recorded degradation, which is how
-- it came to light.
--
-- Body is byte-for-byte the deployed definition except that the three
-- similarity() calls are schema-qualified and the table is qualified too.
-- CREATE OR REPLACE, because unlike the restored eighteen this one exists.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.suggest_spelling(raw_query text)
RETURNS TABLE(original_query text, suggested_query text, display_query text, corrections jsonb)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
DECLARE
  words text[];
  word text;
  cleaned_word text;
  best_match text;
  best_canonical text;
  best_display text;
  best_score real;
  suggested_words text[];
  display_words text[];
  corrections_arr jsonb := '[]'::jsonb;
  has_corrections boolean := false;
  found_canonical text;
  found_display text;
BEGIN
  words := string_to_array(lower(btrim(raw_query)), ' ');
  suggested_words := ARRAY[]::text[];
  display_words := ARRAY[]::text[];

  FOREACH word IN ARRAY words LOOP
    cleaned_word := regexp_replace(word, '[^a-z]', '', 'g');

    IF length(cleaned_word) < 3 THEN
      suggested_words := array_append(suggested_words, word);
      display_words := array_append(display_words, word);
      CONTINUE;
    END IF;

    -- Exact match on a known variant.
    SELECT ts.canonical, ts.display_name INTO found_canonical, found_display
    FROM public.transliteration_synonyms ts
    WHERE ts.variant = cleaned_word
    LIMIT 1;

    IF FOUND THEN
      IF found_canonical = cleaned_word THEN
        suggested_words := array_append(suggested_words, word);
        display_words := array_append(display_words, word);
      ELSE
        suggested_words := array_append(suggested_words, found_canonical);
        display_words := array_append(display_words, COALESCE(found_display, initcap(found_canonical)));
        corrections_arr := corrections_arr || jsonb_build_object(
          'original', word,
          'suggested', found_canonical,
          'display', COALESCE(found_display, initcap(found_canonical)),
          'matched_variant', cleaned_word,
          'similarity', 1.0
        );
        has_corrections := true;
      END IF;
      CONTINUE;
    END IF;

    -- Already a canonical value.
    PERFORM 1 FROM public.transliteration_synonyms
    WHERE canonical = cleaned_word
    LIMIT 1;

    IF FOUND THEN
      suggested_words := array_append(suggested_words, word);
      display_words := array_append(display_words, word);
      CONTINUE;
    END IF;

    -- Best fuzzy match (threshold 0.55).
    SELECT ts.variant, ts.canonical, COALESCE(ts.display_name, initcap(ts.canonical)),
           extensions.similarity(ts.variant, cleaned_word) AS score
    INTO best_match, best_canonical, best_display, best_score
    FROM public.transliteration_synonyms ts
    WHERE extensions.similarity(ts.variant, cleaned_word) > 0.55
    ORDER BY extensions.similarity(ts.variant, cleaned_word) DESC
    LIMIT 1;

    IF best_match IS NOT NULL THEN
      suggested_words := array_append(suggested_words, best_canonical);
      display_words := array_append(display_words, best_display);
      corrections_arr := corrections_arr || jsonb_build_object(
        'original', word,
        'suggested', best_canonical,
        'display', best_display,
        'matched_variant', best_match,
        'similarity', round(best_score::numeric, 3)
      );
      has_corrections := true;
    ELSE
      suggested_words := array_append(suggested_words, word);
      display_words := array_append(display_words, word);
    END IF;
  END LOOP;

  IF has_corrections THEN
    original_query := raw_query;
    suggested_query := array_to_string(suggested_words, ' ');
    display_query := array_to_string(display_words, ' ');
    corrections := corrections_arr;
    RETURN NEXT;
  END IF;

  RETURN;
END;
$fn$;

COMMENT ON FUNCTION public.suggest_spelling(text) IS
  'Spelling suggestions over transliteration_synonyms. similarity() is schema-qualified to extensions because pg_trgm is not in this function''s pinned search_path -- it was raising 42883 on every call. Repaired 2026-07-26.';


-- ===========================================================================
-- 8. Documentation
-- ===========================================================================

COMMENT ON FUNCTION public.search_verses_fulltext(text, integer) IS
  'v3-column reimplementation of the pre-cutover signature. Matches fts_core via public.english_unaccent. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_verses_fulltext_v2(text, integer) IS
  'v3-column reimplementation of the pre-cutover signature. tags column is sourced from tags_core. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_prose_fulltext(text, integer) IS
  'v3-column reimplementation of the pre-cutover signature. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_prose_fulltext_v2(text, integer) IS
  'v3-column reimplementation of the pre-cutover signature. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_transcript_paragraphs_fulltext(text, integer) IS
  'v3-column reimplementation of the pre-cutover signature. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_letter_paragraphs_fulltext(text, integer) IS
  'v3-column reimplementation of the pre-cutover signature. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_verse_chunks_fulltext(text, integer) IS
  'v3-column reimplementation of the pre-cutover signature. Restored 2026-07-26.';

COMMENT ON FUNCTION public.search_verses_semantic_v2(extensions.vector, double precision, integer) IS
  'v3-column reimplementation. Uses <#> to match the hnsw vector_ip_ops index; similarity is -(a <#> b), equal to cosine for the unit-norm vectors stored here. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_prose_semantic_v2(extensions.vector, double precision, integer) IS
  'v3-column reimplementation. See search_verses_semantic_v2 for the <#> rationale. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_verse_chunks_semantic(extensions.vector, double precision, integer) IS
  'v3-column reimplementation. See search_verses_semantic_v2 for the <#> rationale. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_transcript_paragraphs_semantic(extensions.vector, integer) IS
  'v3-column reimplementation. Historically took no match_threshold; preserved. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_letter_paragraphs_semantic(extensions.vector, integer) IS
  'v3-column reimplementation. Historically took no match_threshold; preserved. Restored 2026-07-26.';

COMMENT ON FUNCTION public.search_verses_by_tags(text[], integer) IS
  'v3-column reimplementation. Accepts canonical vocab_terms slugs only. DISABLED at the application call site in Phase A; PR B owns phrase-preserving resolution. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_prose_by_tags(text[], integer) IS
  'v3-column reimplementation. Canonical slugs only. Disabled at the call site in Phase A. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_verse_chunks_by_tags(text[], integer) IS
  'v3-column reimplementation. Canonical slugs only. Disabled at the call site in Phase A. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_transcript_paragraphs_by_tags(text[], integer) IS
  'v3-column reimplementation. Canonical slugs only, unordered as historically. Disabled at the call site in Phase A. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_letter_paragraphs_by_tags(text[], integer) IS
  'v3-column reimplementation. Canonical slugs only, unordered as historically. Disabled at the call site in Phase A. Restored 2026-07-26.';

COMMENT ON FUNCTION public.direct_verse_lookup(text) IS
  'Restored from 20260331221727 with tags sourced from tags_core. Exact-reference lookup for BG/SB/CC/NOI/ISO/BS/NBS/MMS. Restored 2026-07-26.';
COMMENT ON FUNCTION public.search_rpc_contract_v1() IS
  'Manifest check for every RPC app/api/search and app/api/analytics call. Backs GET /api/health. Added 2026-07-26.';


-- ---------------------------------------------------------------------------
-- 9. Make the new functions visible to PostgREST immediately.
--
-- Without this the schema cache can still answer PGRST202 ("function not
-- found") for a function that exists. The application classifies PGRST202 as
-- an infrastructure error, never as an empty result.
-- ---------------------------------------------------------------------------
NOTIFY pgrst, 'reload schema';
