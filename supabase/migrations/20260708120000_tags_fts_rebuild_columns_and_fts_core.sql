-- Tags & FTS Rebuild · Phase 2 (columns + support tables) and Phase 3 (fts_core
-- trigger + diacritic-bug fix). Applied to project wzktlpjtqmjxvragwhqg on
-- 2026-07-08 via Supabase MCP execute_sql (this project's apply_migration fails
-- silently — execute_sql is the required path). Committed here for record.
--
-- STRICTLY ADDITIVE and REVERSIBLE. The old `tags` / `fts` columns and every
-- live `search_*` function are left completely untouched — the new search wiring
-- (Phase 6) sits behind a one-env-var flag (SEARCH_ENGINE=v3|legacy), so revert
-- is a flag flip. Nothing here is read by the live site yet.
--
-- WHY: the old `tags` are noise (359,433 distinct tags on verses alone, 89%
-- singletons) so the tag lane connects nothing; and verse_chunks_fts_trigger
-- used to_tsvector('english', …) making verse_chunks diacritic-SENSITIVE while
-- the other four tables use english_unaccent. This migration lays the new
-- columns and builds a diacritic-blind fts_core on ALL five tables (fixing the
-- verse_chunks hole on a NEW column, never touching the old `fts`).

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2a — new columns on all 5 content tables
--   tags_core        text[]    closed-vocabulary tags (retrieval lane + mindmap)
--   tags_ai          text[]    Gemini suggested themes (mindmap "explore" only)
--   fts_core         tsvector  his real body text (english_unaccent, weighted)
--   fts_expansion    tsvector  his glosses + transliteration variants (built Phase 5)
--   fts_expansion_src text     staging text for fts_expansion (written by tagging job)
--   questions        text      doc2query questions the passage answers (never shown)
--   questions_fts    tsvector  to_tsvector(questions)
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['verses','verse_chunks','prose_paragraphs','transcript_paragraphs','letter_paragraphs']
  LOOP
    EXECUTE format('ALTER TABLE public.%I
      ADD COLUMN IF NOT EXISTS tags_core text[],
      ADD COLUMN IF NOT EXISTS tags_ai text[],
      ADD COLUMN IF NOT EXISTS fts_core tsvector,
      ADD COLUMN IF NOT EXISTS fts_expansion tsvector,
      ADD COLUMN IF NOT EXISTS fts_expansion_src text,
      ADD COLUMN IF NOT EXISTS questions text,
      ADD COLUMN IF NOT EXISTS questions_fts tsvector', t);
  END LOOP;
END $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 2b — support tables
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
  is_ai       boolean NOT NULL DEFAULT false,-- true = tags_ai proposed theme (walled off from tags_core)
  embedding   vector(1024),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Resumable state machine for the Gemini Batch tagging run (one row per shard).
CREATE TABLE IF NOT EXISTS public.tag_batch_jobs (
  id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shard_key       text NOT NULL UNIQUE,      -- e.g. 'transcript_paragraphs:000'
  table_name      text NOT NULL,
  id_list         uuid[] NOT NULL,
  row_count       int NOT NULL DEFAULT 0,
  provider_job_id text,                       -- Gemini Batch job name
  status          text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','submitted','running','retrieved','applied','failed')),
  error           text,
  cost_input_tok  bigint DEFAULT 0,
  cost_output_tok bigint DEFAULT 0,
  submitted_at    timestamptz,
  retrieved_at    timestamptz,
  applied_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tag_batch_jobs_status ON public.tag_batch_jobs (status);

-- Partial indexes for resumable tagging backfill (mirror the existing idx_*_null_tags pattern).
CREATE INDEX IF NOT EXISTS idx_verses_null_tags_core     ON public.verses                (id) WHERE tags_core IS NULL;
CREATE INDEX IF NOT EXISTS idx_vchunks_null_tags_core    ON public.verse_chunks          (id) WHERE tags_core IS NULL;
CREATE INDEX IF NOT EXISTS idx_prose_null_tags_core      ON public.prose_paragraphs      (id) WHERE tags_core IS NULL;
CREATE INDEX IF NOT EXISTS idx_transcript_null_tags_core ON public.transcript_paragraphs (id) WHERE tags_core IS NULL;
CREATE INDEX IF NOT EXISTS idx_letter_null_tags_core     ON public.letter_paragraphs     (id) WHERE tags_core IS NULL;

-- ─────────────────────────────────────────────────────────────────────────────
-- Phase 3 — fts_core / fts_expansion / questions_fts trigger maintenance.
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
  NEW.questions_fts := to_tsvector('english_unaccent', coalesce(NEW.questions,''));
  NEW.fts_expansion := to_tsvector('english_unaccent', coalesce(NEW.fts_expansion_src,''));
  RETURN NEW;
END $fn$;

CREATE OR REPLACE FUNCTION public.body_search_vectors_trigger()
RETURNS trigger LANGUAGE plpgsql SET search_path TO 'public','pg_temp' AS $fn$
BEGIN
  NEW.fts_core := setweight(to_tsvector('english_unaccent', coalesce(NEW.body_text,'')), 'A');
  NEW.questions_fts := to_tsvector('english_unaccent', coalesce(NEW.questions,''));
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

-- Existing-row backfill is performed out-of-band by scripts/tags-rebuild/backfill_fts_core.py
-- (direct connection, no statement-timeout limit, resumable via `WHERE fts_core IS NULL`).
-- Touch pattern that fires the trigger once per row (single compute):
--   WITH b AS (SELECT id FROM public.<t> WHERE fts_core IS NULL LIMIT <n>)
--   UPDATE public.<t> x SET fts_core = fts_core FROM b WHERE x.id = b.id;
-- GIN indexes on fts_core / fts_expansion / questions_fts / tags_core / tags_ai are
-- created AFTER their respective backfills complete (see backfill scripts).
