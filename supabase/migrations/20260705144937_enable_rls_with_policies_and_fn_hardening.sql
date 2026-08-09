-- Real Search Release · Task 4 — additive security hardening.
-- Applied to project wzktlpjtqmjxvragwhqg on 2026-07-05 via Supabase MCP apply_migration
-- (version 20260705144937). Committed here for record; strictly additive:
-- ENABLE RLS + CREATE POLICY + ALTER FUNCTION SET search_path only.

-- A. Content tables: enable RLS + public READ for anon/authenticated; no write policies.
DO $$ DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['verses','books','prose_paragraphs','transcripts',
    'transcript_paragraphs','letters','letter_paragraphs','verse_chunks',
    'transliteration_synonyms']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY "public read" ON public.%I FOR SELECT TO anon, authenticated USING (true)', t);
  END LOOP;
END $$;

-- B. chapters already has RLS enabled but no policies (anon fully blocked) — add read.
CREATE POLICY "public read" ON public.chapters FOR SELECT TO anon, authenticated USING (true);

-- C. Telemetry: RLS on; INSERT-only for anon on feedback + citation_clicks.
--    search_logs gets NO anon policies — writes go through log_* RPCs / service role only.
ALTER TABLE public.search_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.feedback    ENABLE ROW LEVEL SECURITY;
CREATE POLICY "anon insert" ON public.feedback        FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "anon insert" ON public.citation_clicks FOR INSERT TO anon WITH CHECK (true);

-- D. Pin search_path on all 45 advisor-flagged functions (generated from pg_proc;
--    unaccent-extension functions intentionally excluded).
ALTER FUNCTION public.batch_fill_fts(batch_size integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.batch_fill_transcript_fts(batch_size integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.batch_set_embeddings(p_table text, p_ids text[], p_embeddings text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.batch_set_embeddings_v2(p_table text, p_ids uuid[], p_embeddings text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.batch_set_tags(p_table text, p_ids uuid[], p_tags text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.direct_verse_lookup(ref_query text) SET search_path = public, pg_temp;
ALTER FUNCTION public.fetch_null_embedding_ids(p_table text, p_limit integer, p_offset integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.fetch_null_embedding_ids_v2(p_table text, p_limit integer, p_offset integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_search(p_query text, p_session_id text, p_visitor_id text, p_total_results integer, p_verse_ids uuid[], p_prose_ids uuid[], p_books_returned text[], p_search_method text, p_search_duration_ms integer, p_embedding_duration_ms integer, p_synthesis_duration_ms integer, p_total_duration_ms integer, p_narrative_length integer, p_source text, p_user_agent text, p_referrer text) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_search_behavior(p_search_log_id uuid, p_clicked_citations text[], p_clicked_want_more text[], p_scrolled_to_bottom boolean, p_time_on_result_ms integer, p_followed_up_query text) SET search_path = public, pg_temp;
ALTER FUNCTION public.log_search_feedback(p_search_log_id uuid, p_vote smallint, p_text text) SET search_path = public, pg_temp;
ALTER FUNCTION public.normalize_search_query(raw_query text) SET search_path = public, pg_temp;
ALTER FUNCTION public.ref_hit(retrieved_ref text, expected text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.run_benchmark(test_category text, result_limit integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.run_benchmark_v2(k integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_letter_paragraphs_by_tags(search_terms text[], match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_letter_paragraphs_fulltext(search_query text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_letter_paragraphs_semantic(query_embedding vector, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_prabhupada(query_embedding text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_prabhupada_v2(query_embedding text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_prose_by_tags(search_terms text[], match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_prose_fulltext(search_query text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_prose_fulltext_v2(search_query text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_prose_semantic(query_embedding vector, match_threshold double precision, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_prose_semantic_v2(query_embedding vector, match_threshold double precision, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_transcript_paragraphs_by_tags(search_terms text[], match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_transcript_paragraphs_fulltext(search_query text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_transcript_paragraphs_semantic(query_embedding vector, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verse_chunks_by_tags(search_terms text[], match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verse_chunks_fulltext(search_query text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verse_chunks_semantic(query_embedding vector, match_threshold double precision, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verses_by_tags(search_terms text[], match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verses_fulltext(search_query text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verses_fulltext_v2(search_query text, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verses_semantic(query_embedding vector, match_threshold double precision, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verses_semantic_v2(query_embedding vector, match_threshold double precision, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.search_verses_semantic_v3(query_embedding vector, match_threshold double precision, match_count integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_embedding_new_bulk(p_table text, p_ids uuid[], p_embs text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_embeddings_context4(tbl text, ids text[], embs text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_query_embedding(p_id uuid, p_emb text) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_query_embeddings_bulk(p_ids uuid[], p_embs text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.set_verse_embeddings_bulk(p_ids uuid[], p_embs text[]) SET search_path = public, pg_temp;
ALTER FUNCTION public.split_into_chunks(full_text text, target_size integer, overlap_size integer) SET search_path = public, pg_temp;
ALTER FUNCTION public.suggest_spelling(raw_query text) SET search_path = public, pg_temp;
ALTER FUNCTION public.verse_chunks_fts_trigger() SET search_path = public, pg_temp;
