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

-- passage_function (additive, killable, hidden metadata) on the five content
-- tables — ONE primary value per passage from the closed enum in config.py,
-- enforced in harness code, never by a constraint. verse_chunks inherit it
-- from their parent verse at finalize.
ALTER TABLE public.verses                ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.verse_chunks          ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.prose_paragraphs      ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.transcript_paragraphs ADD COLUMN IF NOT EXISTS passage_function text;
ALTER TABLE public.letter_paragraphs     ADD COLUMN IF NOT EXISTS passage_function text;
"""


def ensure_audit_tables() -> None:
    with db.get_pg().cursor() as cur:
        cur.execute(AUDIT_DDL)


def audit_tables_exist() -> bool:
    return bool(
        db.one(
            "SELECT count(*) = 2 FROM information_schema.tables"
            " WHERE table_schema='public' AND table_name IN ('tag_runs','tag_evidence')"
        )
    )


def vocab_version() -> str:
    """Version of the frozen vocabulary = sha256 of vocabulary.json content."""
    import hashlib

    if not config.VOCAB_PATH.exists():
        raise SystemExit(f"FATAL: {config.VOCAB_PATH} not built yet — run the vocabulary step first.")
    return "sha256:" + hashlib.sha256(config.VOCAB_PATH.read_bytes()).hexdigest()[:16]


def open_or_create_run(model: str) -> str:
    """Reuse the unfinished run with the same model/prompt/vocab identity
    (resume), else register a new tag_runs row. Returns the run id."""
    vv = vocab_version()
    existing = db.one(
        "SELECT id::text FROM public.tag_runs WHERE finished_at IS NULL AND model=%s"
        " AND prompt_version=%s AND vocab_version=%s ORDER BY started_at DESC LIMIT 1",
        (model, config.PROMPT_VERSION, vv),
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
    }
    with db.get_pg().cursor() as cur:
        cur.execute(
            "INSERT INTO public.tag_runs (id, model, prompt_version, vocab_version, max_tags, config)"
            " VALUES (%s::uuid, %s, %s, %s, %s, %s::jsonb)",
            (run_id, model, config.PROMPT_VERSION, vv, config.MAX_TAGS, json.dumps(snapshot)),
        )
    return run_id


def finish_run(run_id: str, notes: str = "") -> None:
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_runs SET finished_at=%s, notes=%s WHERE id=%s::uuid",
            (datetime.now(timezone.utc), notes, run_id),
        )


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
