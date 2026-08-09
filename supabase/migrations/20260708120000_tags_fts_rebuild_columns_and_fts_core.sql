-- Tags & FTS Rebuild · Phase 2 (columns + support table) and Phase 3 (fts_core
-- trigger + diacritic-bug fix). Applied to project wzktlpjtqmjxvragwhqg on
-- 2026-07-08 via Supabase MCP execute_sql (this project's apply_migration fails
-- silently — execute_sql is the required path). Committed here for record.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- CORRECTED 2026-08-08 TO MATCH WHAT WAS ACTUALLY APPLIED.
--
-- This file had no row in supabase_migrations.schema_migrations, and when it was
-- compared against the live database (part A3) it turned out to declare more
-- than was ever run. A trimmed version was applied on 2026-07-08 and the fuller
-- version was committed here, so the file described a database that does not
-- exist. Recording it as "applied" while it still said that would have written
-- the discrepancy into the ledger instead of resolving it.
--
-- REMOVED from this historical file because they are absent from the live
-- database on all five content tables. Current maintenance files still refer to
-- some of them; those references need a separate repository correction and are
-- not evidence that these objects were applied:
--
--   · columns  tags_ai, questions, questions_fts
--   · table    tag_batch_jobs, and its index idx_tag_batch_jobs_status
--   · indexes  idx_{verses,vchunks,prose,transcript,letter}_null_tags_core
--   · the two trigger lines that set NEW.questions_fts from NEW.questions
--
-- That last one matters more than it looks. Had the trigger been applied WITHOUT
-- its columns, every insert and update on all five content tables would have
-- failed. It was not: the live trigger bodies set fts_core and fts_expansion and
-- stop there, so the database is internally consistent. It was this file that
-- was wrong, not the database.
--
-- Nothing here was applied to the database to make this correction. The three
-- columns and the tag_batch_jobs table are NOT created by this history repair.
-- Maintenance workflows that still require them are not runnable against the
-- verified live schema and need a separate owner-approved decision: update or
-- retire those workflows, or create the objects in a new forward migration if
-- that work is revived. This migration-history repair makes no such decision.
-- ─────────────────────────────────────────────────────────────────────────────
--
-- STRICTLY ADDITIVE and REVERSIBLE. The old `tags` / `fts` columns and every
-- live `search_*` function are left completely untouched.
--
-- WHY: the old `tags` are noise (359,433 distinct tags on verses alone, 89%
-- singletons) so the tag lane connects nothing; and verse_chunks_fts_trigger
-- used to_tsvector('english', …) making verse_chunks diacritic-SENSITIVE while
-- the other four tables use english_unaccent. This migration lays the new
-- columns and builds a diacritic-blind fts_core on ALL five tables (fixing the
-- verse_chunks hole on a NEW column, never touching the old `fts`).

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2a — new columns on all 5 content tables
--   tags_core         text[]    closed-vocabulary tags (retrieval lane + mindmap)
--   fts_core          tsvector  his real body text (english_unaccent, weighted)
--   fts_expansion     tsvector  his glosses + transliteration variants
--   fts_expansion_src text      staging text for fts_expansion
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['verses','verse_chunks','prose_paragraphs','transcript_paragraphs','letter_paragraphs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I
      ADD COLUMN IF NOT EXISTS tags_core text[],
      ADD COLUMN IF NOT EXISTS fts_core tsvector,
      ADD COLUMN IF NOT EXISTS fts_expansion tsvector,
      ADD COLUMN IF NOT EXISTS fts_expansion_src text', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2b — support table
-- ─────────────────────────────────────────────────────────────────────────────

-- Frozen controlled vocabulary. `slug` (unaccent+lower) is the closed-enum value
-- tags_core is validated against; `embedding` (Voyage, 1024-dim) drives the
-- per-passage candidate shortlist via `embedding <=> passage.embedding_context4`.
CREATE TABLE IF NOT EXISTS public.vocab_terms (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  term        text NOT NULL,                 -- canonical display term
  slug        text NOT NULL UNIQUE,          -- normalized key (unaccent+lower) = the enum value
  facet       text NOT NULL,                 -- Concept | Sanskrit | Person | Place | Scripture | Practice
  parent      text,                          -- parent slug in the tree (null = top level)
  variants    text[] NOT NULL DEFAULT '{}',  -- spelling variants (transliteration_synonyms + folding)
  is_ai       boolean NOT NULL DEFAULT false,-- reserved; no AI-proposed terms were ever loaded
  embedding   vector(1024),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3 — fts_core / fts_expansion trigger maintenance.
-- All use english_unaccent (diacritic-blind). This is the corrected config that
-- fixes the verse_chunks 'english' bug — on the NEW fts_core column. The old
-- `fts` column and verse_chunks_fts_trigger are deliberately left in place.
-- Trigger-maintained (not GENERATED) because fts_expansion is later assembled by
-- the tagging job (joins transliteration_synonyms), and unaccent is STABLE not
-- IMMUTABLE. Weights: verses translation=A, synonyms=B, purport=C; body tables
-- body_text=A. Query time ranks with ts_rank_cd.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verses_search_vectors_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $fn$
BEGIN
  NEW.fts_core :=
      setweight(to_tsvector('english_unaccent', coalesce(NEW.translation,'')), 'A') ||
      setweight(to_tsvector('english_unaccent', coalesce(NEW.synonyms,'')),     'B') ||
      setweight(to_tsvector('english_unaccent', coalesce(NEW.purport,'')),      'C');
  NEW.fts_expansion := to_tsvector('english_unaccent', coalesce(NEW.fts_expansion_src,''));
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.body_search_vectors_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $fn$
BEGIN
  NEW.fts_core := setweight(to_tsvector('english_unaccent', coalesce(NEW.body_text,'')), 'A');
  NEW.fts_expansion := to_tsvector('english_unaccent', coalesce(NEW.fts_expansion_src,''));
  RETURN NEW;
END $fn$;

DROP TRIGGER IF EXISTS trg_verses_search_vectors ON public.verses;
CREATE TRIGGER trg_verses_search_vectors BEFORE INSERT OR UPDATE ON public.verses
  FOR EACH ROW EXECUTE FUNCTION public.verses_search_vectors_trigger();

DROP TRIGGER IF EXISTS trg_vchunks_search_vectors ON public.verse_chunks;
CREATE TRIGGER trg_vchunks_search_vectors BEFORE INSERT OR UPDATE ON public.verse_chunks
  FOR EACH ROW EXECUTE FUNCTION public.body_search_vectors_trigger();

DROP TRIGGER IF EXISTS trg_prose_search_vectors ON public.prose_paragraphs;
CREATE TRIGGER trg_prose_search_vectors BEFORE INSERT OR UPDATE ON public.prose_paragraphs
  FOR EACH ROW EXECUTE FUNCTION public.body_search_vectors_trigger();

DROP TRIGGER IF EXISTS trg_transcript_search_vectors ON public.transcript_paragraphs;
CREATE TRIGGER trg_transcript_search_vectors BEFORE INSERT OR UPDATE ON public.transcript_paragraphs
  FOR EACH ROW EXECUTE FUNCTION public.body_search_vectors_trigger();

DROP TRIGGER IF EXISTS trg_letter_search_vectors ON public.letter_paragraphs;
CREATE TRIGGER trg_letter_search_vectors BEFORE INSERT OR UPDATE ON public.letter_paragraphs
  FOR EACH ROW EXECUTE FUNCTION public.body_search_vectors_trigger();

-- Existing-row backfill was performed out-of-band by
-- scripts/tags-rebuild/backfill_fts_core.py (direct connection, no
-- statement-timeout limit, resumable via `WHERE fts_core IS NULL`).
-- Touch pattern that fires the trigger once per row (single compute):
--   WITH b AS (SELECT id FROM public.<t> WHERE fts_core IS NULL LIMIT <n>)
--   UPDATE public.<t> x SET fts_core = fts_core FROM b WHERE x.id = b.id;
--
-- The GIN indexes were created by those same backfill scripts, not by this
-- migration, and all fifteen are live: idx_<table>_{fts_core,fts_expansion,
-- tags_core}_gin on each of the five content tables.
