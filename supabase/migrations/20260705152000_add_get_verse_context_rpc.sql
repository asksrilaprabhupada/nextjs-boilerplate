-- Real Search Release · Task 9 (m3) — chapter-neighbour lookup for the essay's
-- primary verse. Applied to project wzktlpjtqmjxvragwhqg on 2026-07-05 via
-- Supabase MCP apply_migration (name add_get_verse_context_rpc). Committed for
-- record.
--
-- Additive; explicit RETURNS TABLE (not SETOF verses) so heavy vector/tsvector
-- columns never leave the database. Ordering extracts the first integer from
-- the text verse_number ("Text 17", "13-14", "29.1a-2a" all order by their
-- leading number; non-numeric rows like "Invocation" sort last). Verified
-- against live data: BG 2.20 → neighbours 2.19 (rel_position -1) and 2.21 (+1).
CREATE OR REPLACE FUNCTION public.get_verse_context(p_verse_id uuid, p_radius int DEFAULT 1)
RETURNS TABLE (
  id uuid,
  chapter_id uuid,
  scripture text,
  verse_number text,
  translation text,
  vedabase_url text,
  rel_position int
)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  WITH me AS (
    SELECT v.chapter_id FROM public.verses v WHERE v.id = p_verse_id
  ),
  ordered AS (
    SELECT v.id, v.chapter_id, v.scripture, v.verse_number, v.translation, v.vedabase_url,
           row_number() OVER (
             ORDER BY (substring(v.verse_number from '\d+'))::int NULLS LAST, v.verse_number
           ) AS rn
    FROM public.verses v JOIN me USING (chapter_id)
  )
  SELECT o.id, o.chapter_id, o.scripture, o.verse_number, o.translation, o.vedabase_url,
         (o.rn - s.rn)::int AS rel_position
  FROM ordered o, (SELECT rn FROM ordered WHERE ordered.id = p_verse_id) s
  WHERE abs(o.rn - s.rn) <= p_radius AND o.id <> p_verse_id
  ORDER BY o.rn;
$$;

GRANT EXECUTE ON FUNCTION public.get_verse_context(uuid, int) TO anon, authenticated;
