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
-- SAFETY
--
-- Forward-only and additive. No DROP ... CASCADE, no table/column/index/data
-- changes, no HNSW tuning, no migration-history repair. Every function is
-- SECURITY INVOKER with `SET search_path = ''` and fully-qualified references;
-- EXECUTE is revoked from PUBLIC/anon/authenticated and granted to service_role
-- only, because every caller is a server route holding the service key.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Refuse to run if any target already exists.
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
AS $fn$
#variable_conflict use_column
BEGIN
  SET LOCAL hnsw.ef_search = 100;

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
AS $fn$
#variable_conflict use_column
BEGIN
  SET LOCAL hnsw.ef_search = 100;

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
AS $fn$
#variable_conflict use_column
BEGIN
  SET LOCAL hnsw.ef_search = 100;

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
AS $fn$
#variable_conflict use_column
BEGIN
  SET LOCAL hnsw.ef_search = 100;

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
AS $fn$
#variable_conflict use_column
BEGIN
  SET LOCAL hnsw.ef_search = 100;

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
  expected_args text,
  present boolean,
  overloads integer,
  security_definer boolean,
  proconfig text[]
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $fn$
  WITH manifest(rpc_name, expected_args) AS (
    VALUES
      ('direct_verse_lookup',                    'ref_query text'),
      ('search_verses_fulltext',                 'search_query text, match_count integer'),
      ('search_verses_fulltext_v2',              'search_query text, match_count integer'),
      ('search_prose_fulltext',                  'search_query text, match_count integer'),
      ('search_prose_fulltext_v2',               'search_query text, match_count integer'),
      ('search_transcript_paragraphs_fulltext',  'search_query text, match_count integer'),
      ('search_letter_paragraphs_fulltext',      'search_query text, match_count integer'),
      ('search_verse_chunks_fulltext',           'search_query text, match_count integer'),
      ('search_verses_semantic_v2',              'query_embedding vector, match_threshold double precision, match_count integer'),
      ('search_prose_semantic_v2',               'query_embedding vector, match_threshold double precision, match_count integer'),
      ('search_verse_chunks_semantic',           'query_embedding vector, match_threshold double precision, match_count integer'),
      ('search_transcript_paragraphs_semantic',  'query_embedding vector, match_count integer'),
      ('search_letter_paragraphs_semantic',      'query_embedding vector, match_count integer'),
      ('search_verses_by_tags',                  'search_terms text[], match_count integer'),
      ('search_prose_by_tags',                   'search_terms text[], match_count integer'),
      ('search_verse_chunks_by_tags',            'search_terms text[], match_count integer'),
      ('search_transcript_paragraphs_by_tags',   'search_terms text[], match_count integer'),
      ('search_letter_paragraphs_by_tags',       'search_terms text[], match_count integer'),
      ('suggest_spelling',                       'raw_query text'),
      ('get_verse_context',                      'p_verse_id uuid, p_radius integer'),
      ('log_search_feedback',                    'p_search_log_id uuid, p_vote smallint, p_text text'),
      ('log_search_behavior',                    'p_search_log_id uuid, p_clicked_citations text[], p_clicked_want_more text[], p_scrolled_to_bottom boolean, p_time_on_result_ms integer, p_followed_up_query text'),
      ('log_search',                             'p_query text, p_session_id text, p_visitor_id text, p_total_results integer, p_verse_ids uuid[], p_prose_ids uuid[], p_books_returned text[], p_search_method text, p_search_duration_ms integer, p_embedding_duration_ms integer, p_synthesis_duration_ms integer, p_total_duration_ms integer, p_narrative_length integer, p_source text, p_user_agent text, p_referrer text, p_query_variants text[]')
  ),
  actual AS (
    SELECT p.proname::text AS name,
           replace(replace(pg_catalog.pg_get_function_identity_arguments(p.oid),
                           'extensions.', ''), 'public.', '') AS args,
           p.prosecdef,
           p.proconfig
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
  )
  SELECT m.rpc_name::text,
         m.expected_args::text,
         (a.name IS NOT NULL) AS present,
         (SELECT count(*)::integer FROM actual x WHERE x.name = m.rpc_name) AS overloads,
         a.prosecdef,
         a.proconfig
  FROM manifest m
  LEFT JOIN actual a
    ON a.name = m.rpc_name
   AND a.args = m.expected_args
  ORDER BY m.rpc_name;
$fn$;


-- ===========================================================================
-- 6. PRIVILEGES
--
-- PostgreSQL grants EXECUTE to PUBLIC by default on CREATE FUNCTION. Every
-- caller of these functions is a Next.js server route using the service key,
-- so the exposed surface is narrowed deliberately rather than inherited.
-- ===========================================================================

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
-- 7. log_search hardening
--
-- log_search is SECURITY DEFINER and executable by anon/authenticated, which
-- the Supabase linter flags (0028/0029). It dated from a time when the browser
-- logged searches directly; today its only callers are app/api/search/route.ts
-- and app/api/analytics/log/route.ts, both server-side with the service key.
-- service_role has rolbypassrls = true and full DML grants on search_logs and
-- popular_queries (both verified), so SECURITY INVOKER is sufficient.
-- ===========================================================================

ALTER FUNCTION public.log_search(
  text, text, text, integer, uuid[], uuid[], text[], text, integer, integer,
  integer, integer, integer, text, text, text, text[]
) SECURITY INVOKER;

REVOKE ALL ON FUNCTION public.log_search(
  text, text, text, integer, uuid[], uuid[], text[], text, integer, integer,
  integer, integer, integer, text, text, text, text[]
) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.log_search(
  text, text, text, integer, uuid[], uuid[], text[], text, integer, integer,
  integer, integer, integer, text, text, text, text[]
) TO service_role;


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
