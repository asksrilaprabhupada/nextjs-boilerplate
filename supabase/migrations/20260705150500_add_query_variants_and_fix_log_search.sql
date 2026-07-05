-- Real Search Release · Task 3 (m2) — additive telemetry changes.
-- Applied to project wzktlpjtqmjxvragwhqg on 2026-07-05 via Supabase MCP apply_migration
-- (name add_query_variants_and_fix_log_search). Committed here for record.

-- 1) search_logs learns which Gemini variant questions were fused into the search.
ALTER TABLE public.search_logs ADD COLUMN IF NOT EXISTS query_variants text[] DEFAULT '{}';

-- 2) log_search() has always inserted into popular_queries, but that table was
--    never created — every call would have failed. Create it (service-role only;
--    RLS on with no policies).
CREATE TABLE IF NOT EXISTS public.popular_queries (
  query_normalized text PRIMARY KEY,
  display_query    text NOT NULL,
  search_count     integer NOT NULL DEFAULT 0,
  last_searched_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.popular_queries ENABLE ROW LEVEL SECURITY;

-- 3) Recreate log_search with an appended p_query_variants parameter.
--    Drop-and-recreate (not overload): a second overload would make the existing
--    named-argument RPC calls ambiguous. Existing callers stay compatible via the
--    DEFAULT. SECURITY DEFINER + pinned search_path so the RPC family remains the
--    only anon-reachable write path into search_logs.
DROP FUNCTION public.log_search(text, text, text, integer, uuid[], uuid[], text[], text, integer, integer, integer, integer, integer, text, text, text);

CREATE FUNCTION public.log_search(
  p_query text,
  p_session_id text DEFAULT NULL,
  p_visitor_id text DEFAULT NULL,
  p_total_results integer DEFAULT 0,
  p_verse_ids uuid[] DEFAULT '{}'::uuid[],
  p_prose_ids uuid[] DEFAULT '{}'::uuid[],
  p_books_returned text[] DEFAULT '{}'::text[],
  p_search_method text DEFAULT 'hybrid',
  p_search_duration_ms integer DEFAULT NULL,
  p_embedding_duration_ms integer DEFAULT NULL,
  p_synthesis_duration_ms integer DEFAULT NULL,
  p_total_duration_ms integer DEFAULT NULL,
  p_narrative_length integer DEFAULT NULL,
  p_source text DEFAULT 'web',
  p_user_agent text DEFAULT NULL,
  p_referrer text DEFAULT NULL,
  p_query_variants text[] DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_id uuid;
  v_normalized text;
BEGIN
  v_normalized := lower(trim(p_query));

  INSERT INTO search_logs (
    query, query_normalized, session_id, visitor_id,
    total_results, verse_ids, prose_ids, books_returned,
    search_method, search_duration_ms, embedding_duration_ms,
    synthesis_duration_ms, total_duration_ms, narrative_length,
    source, user_agent, referrer, query_variants
  ) VALUES (
    p_query, v_normalized, p_session_id, p_visitor_id,
    p_total_results, p_verse_ids, p_prose_ids, p_books_returned,
    p_search_method, p_search_duration_ms, p_embedding_duration_ms,
    p_synthesis_duration_ms, p_total_duration_ms, p_narrative_length,
    p_source, p_user_agent, p_referrer, COALESCE(p_query_variants, '{}')
  )
  RETURNING id INTO v_id;

  -- Update popular queries
  INSERT INTO popular_queries (query_normalized, display_query, search_count, last_searched_at)
  VALUES (v_normalized, p_query, 1, now())
  ON CONFLICT (query_normalized) DO UPDATE SET
    search_count = popular_queries.search_count + 1,
    last_searched_at = now(),
    display_query = CASE
      WHEN length(EXCLUDED.display_query) > length(popular_queries.display_query)
      THEN EXCLUDED.display_query
      ELSE popular_queries.display_query
    END;

  RETURN v_id;
END;
$function$;
