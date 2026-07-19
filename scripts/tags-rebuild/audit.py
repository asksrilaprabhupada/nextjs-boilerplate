"""
audit.py — audit storage: tag_runs + tag_evidence (+ run bookkeeping).

Every tagging run is recorded in `tag_runs` (run id, resolved model string,
prompt version, vocabulary version, timestamps, config snapshot) and every tag
the model returned — accepted OR rejected by the code gates — is recorded in
`tag_evidence` with its evidence sentence. Evidence is stored, never discarded:
a rejected tag keeps its reject_reason so gate behavior stays auditable.

The tables are created here idempotently over DATABASE_URL (CREATE TABLE IF
NOT EXISTS) because this project's apply_migration path is off-limits to the
harness. They are support tables — no live search code reads them. RLS is
enabled with no policies: only the service role / direct connection can touch
them, matching the rest of the schema.
"""
from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone

import config
import db
import sentences

AUDIT_DDL = """
CREATE TABLE IF NOT EXISTS public.tag_runs (
  id             uuid PRIMARY KEY,
  model          text NOT NULL,
  prompt_version text NOT NULL,
  vocab_version  text NOT NULL,
  max_tags       int  NOT NULL,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  notes          text
);
ALTER TABLE public.tag_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.tag_evidence (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         uuid NOT NULL REFERENCES public.tag_runs(id),
  table_name     text NOT NULL,
  passage_id     uuid NOT NULL,
  tag            text NOT NULL,
  evidence       text NOT NULL,
  accepted       boolean NOT NULL,
  reject_reason  text,
  -- Soft evidence gate: in-vocabulary tags are KEPT even when their evidence
  -- sentence can't be located (accepted=true, evidence_found=false, the miss
  -- reason in reject_reason). evidence_start/evidence_end are character
  -- offsets of the matched evidence into the composed passage text AS SENT to
  -- Gemini (for verses that is the TRANSLATION/SYNONYMS/PURPORT composition,
  -- not a single raw column).
  evidence_found boolean,
  evidence_start integer,
  evidence_end   integer,
  created_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.tag_evidence ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_tag_evidence_passage ON public.tag_evidence (table_name, passage_id);
CREATE INDEX IF NOT EXISTS idx_tag_evidence_run     ON public.tag_evidence (run_id);
-- Same columns as additive ALTERs for a tag_evidence created by harness v2.
ALTER TABLE public.tag_evidence ADD COLUMN IF NOT EXISTS evidence_found boolean;
ALTER TABLE public.tag_evidence ADD COLUMN IF NOT EXISTS evidence_start integer;
ALTER TABLE public.tag_evidence ADD COLUMN IF NOT EXISTS evidence_end integer;

-- Additive columns on the shard state machine (support table owned by this
-- harness): run linkage + pre-submission token estimates for the cost ceiling
-- (cost_input_tok/cost_output_tok keep REAL usage only).
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS run_id uuid;
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS est_input_tok bigint DEFAULT 0;
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS est_output_tok bigint DEFAULT 0;
-- v3.p2: cost_output_tok holds TOTAL billable output (candidates + thinking).
-- The split is stored additively for resumable, transparent reporting.
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS cost_candidate_tok bigint DEFAULT 0;
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS cost_thought_tok bigint DEFAULT 0;

-- v3.p2: evidence is a sentence ID (S001…) resolved back to the exact source
-- sentence (stored in `evidence`) + its offsets. The raw returned ID is kept
-- here for audit; the splitter version is recorded in tag_runs.config.
ALTER TABLE public.tag_evidence ADD COLUMN IF NOT EXISTS evidence_sentence_id text;

-- passage_function (additive, killable, hidden metadata) on the five content
-- tables — ONE primary value per passage from the closed enum in config.py,
-- enforced in harness code, never by a constraint. (v3.p2+: verse_chunks are
-- tagged directly and carry their own value — no inheritance step.)
ALTER TABLE public.verses                ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.verse_chunks          ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.prose_paragraphs      ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.transcript_paragraphs ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.letter_paragraphs     ADD COLUMN IF NOT EXISTS passage_function text;

-- v3.p3-hybrid: the routed model + its pinned Batch prices are recorded on
-- EVERY shard row, so the spend ledger prices each row by what it actually
-- cost and per-model runs/files can never collide or mis-price each other.
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS price_in_per_m  numeric;
ALTER TABLE public.tag_batch_jobs ADD COLUMN IF NOT EXISTS price_out_per_m numeric;

-- v3.p3-hybrid: ROW-LEVEL completion. Coverage = "this passage has an outcome
-- row in this run", NEVER "its id appeared in a submitted shard's id_list"
-- (the v3.p2 silent-holes flaw). One row per (run, table, passage); `history`
-- appends every attempt so quarantine reports keep the full error trail.
CREATE TABLE IF NOT EXISTS public.tag_passage_outcomes (
  run_id        uuid NOT NULL REFERENCES public.tag_runs(id),
  table_name    text NOT NULL,
  passage_id    uuid NOT NULL,
  shard_key     text NOT NULL,
  model         text NOT NULL,
  attempt       int  NOT NULL DEFAULT 1,
  outcome       text NOT NULL CHECK (outcome IN
                ('applied','invalid','missing_response','skipped_no_shortlist','quarantined')),
  failure_class text,
  history       jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, table_name, passage_id)
);
ALTER TABLE public.tag_passage_outcomes ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_tag_passage_outcomes_state
  ON public.tag_passage_outcomes (run_id, outcome);
"""

# Idempotent legacy backfill: every pre-p3 tag_batch_jobs row (p1/p2) was
# gemini-3.5-flash (the harness was single-model until v3.p3) — stamp the model
# + its canonical prices so the ledger prices ALL billed tokens by recorded
# per-row prices and --doctor can FAIL on any billed-but-unpriced row.
LEGACY_BACKFILL_SQL = (
    "UPDATE public.tag_batch_jobs SET model = %s, price_in_per_m = %s, price_out_per_m = %s"
    " WHERE model IS NULL"
)
LEGACY_MODEL = "gemini-3.5-flash"


def ensure_audit_tables() -> None:
    legacy_prices = config.GEMINI_BATCH_PRICES_CANONICAL[LEGACY_MODEL]
    with db.get_pg().cursor() as cur:
        cur.execute(AUDIT_DDL)
        cur.execute(LEGACY_BACKFILL_SQL, (LEGACY_MODEL, *legacy_prices))


def audit_tables_exist() -> bool:
    return bool(
        db.one(
            "SELECT count(*) = 3 FROM information_schema.tables"
            " WHERE table_schema='public'"
            " AND table_name IN ('tag_runs','tag_evidence','tag_passage_outcomes')"
        )
    )


def vocab_version() -> str:
    """Version of the frozen vocabulary = sha256 of vocabulary.json content."""
    import hashlib

    if not config.VOCAB_PATH.exists():
        raise SystemExit(f"FATAL: {config.VOCAB_PATH} not built yet — run the vocabulary step first.")
    return "sha256:" + hashlib.sha256(config.VOCAB_PATH.read_bytes()).hexdigest()[:16]


def run_model_fingerprint(model_core: str, model_standard: str) -> str:
    """The composite stored in tag_runs.model — deterministic, so resume matching
    (model + prompt_version + vocab_version) works unchanged for hybrid runs."""
    return f"core={model_core};standard={model_standard}"


def open_or_create_run(model_core: str, model_standard: str) -> str:
    """Reuse the unfinished run with the same models/prompt/vocab identity
    (resume), else register a new tag_runs row. Returns the run id."""
    import routing

    vv = vocab_version()
    fingerprint = run_model_fingerprint(model_core, model_standard)
    existing = db.one(
        "SELECT id::text FROM public.tag_runs WHERE finished_at IS NULL AND model=%s"
        " AND prompt_version=%s AND vocab_version=%s ORDER BY started_at DESC LIMIT 1",
        (fingerprint, config.PROMPT_VERSION, vv),
    )
    if existing:
        return str(existing)
    run_id = str(uuid.uuid4())
    snapshot = {
        "max_tags": config.MAX_TAGS,
        "max_questions": config.MAX_QUESTIONS,
        "shortlist_semantic": config.SHORTLIST_SEMANTIC,
        "shortlist_cap": config.SHORTLIST_CAP,
        "shard_size": config.SHARD_SIZE,
        "min_evidence_words": config.MIN_EVIDENCE_WORDS,
        "passage_char_cap": config.PASSAGE_CHAR_CAP,
        "max_spend_usd": config.MAX_SPEND_USD,
        "sample_seed": config.SAMPLE_SEED,
        "pilot_size": config.PILOT_SIZE,
        "passage_functions": config.PASSAGE_FUNCTIONS,
        # v3.p3-hybrid run knobs (recorded for cost + reproducibility auditing).
        "routing": {
            "core_books": sorted(routing.CORE_BOOK_SLUGS),
            "routed_tables": sorted(routing.ROUTED_TABLES),
            "model_core": model_core,
            "model_standard": model_standard,
        },
        "batch_prices": {
            m: {"in_per_m": p[0], "out_per_m": p[1]}
            for m, p in sorted(config.GEMINI_BATCH_PRICES.items())
        },
        "pricing_source": "code-canonical-per-model",
        "thinking_level": config.THINKING_LEVEL,
        "temperature": None,
        "temperature_provenance": "model_default",
        "max_output_tokens": config.MAX_OUTPUT_TOKENS,
        "splitter_version": sentences.SPLITTER_VERSION,
        "thinking_billed_as_output": True,
    }
    with db.get_pg().cursor() as cur:
        cur.execute(
            "INSERT INTO public.tag_runs (id, model, prompt_version, vocab_version, max_tags, config)"
            " VALUES (%s::uuid, %s, %s, %s, %s, %s::jsonb)",
            (run_id, fingerprint, config.PROMPT_VERSION, vv, config.MAX_TAGS, json.dumps(snapshot)),
        )
    return run_id


def latest_run_id_for_prompt(prompt_version: str | None = None) -> str | None:
    """Most recent run for a prompt version (default: the current one) — used by
    standalone finalize and the doctor's outcome-state census."""
    return db.one(
        "SELECT id::text FROM public.tag_runs WHERE prompt_version=%s"
        " ORDER BY started_at DESC LIMIT 1",
        (prompt_version or config.PROMPT_VERSION,),
    )


def finish_run(run_id: str, notes: str = "") -> None:
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_runs SET finished_at=%s, notes=%s WHERE id=%s::uuid",
            (datetime.now(timezone.utc), notes, run_id),
        )


def supersede_prior_runs(current_run_id: str) -> int:
    """Freeze any UNFINISHED run with a different prompt_version (e.g. the v3.p1
    pilot) by stamping finished_at + a 'superseded by <this prompt>' note. Its
    jobs and evidence are retained — only tag_runs bookkeeping is updated. Returns
    the number of runs superseded. Idempotent (already-finished runs are skipped)."""
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_runs SET finished_at=%s,"
            " notes=coalesce(nullif(notes,''),'') || %s"
            " WHERE finished_at IS NULL AND id <> %s::uuid AND prompt_version <> %s",
            (datetime.now(timezone.utc), f"superseded by {config.PROMPT_VERSION}",
             current_run_id, config.PROMPT_VERSION),
        )
        return cur.rowcount


def record_evidence(run_id: str, records: list[tuple]) -> None:
    """records: (table_name, passage_id, tag, evidence, accepted, reject_reason,
    evidence_found, evidence_start, evidence_end) — matches tagging.apply_results."""
    if not records:
        return
    conn = db.get_pg()
    with conn.transaction():
        with conn.cursor() as cur:
            cur.executemany(
                "INSERT INTO public.tag_evidence"
                " (run_id, table_name, passage_id, tag, evidence, accepted, reject_reason,"
                "  evidence_found, evidence_start, evidence_end)"
                " VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s)",
                [(run_id, *r) for r in records],
            )
