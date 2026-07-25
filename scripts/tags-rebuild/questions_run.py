"""
questions_run.py — STEPS 1-4 of the final column build: generate `questions`,
`passage_function`, `speaker` and `speaker_evidence` for all 244,148 passages,
then build `questions_fts`.

This is a SEPARATE pipeline from tagging.py and deliberately shares none of its
state. It reuses the harness plumbing (config's .env loading, db's retry/pooler
connection, gemini_client's Files/Batch calls) but keeps its own run tables, its
own shard files and its own cost ledger, so a questions run can never disturb —
or be disturbed by — the tags run. It writes ONLY the four columns above. It
never reads or writes tags, tags_core, fts, fts_core or fts_expansion.

    ┌ STEP 1  routing + prompt + schema      (this file, sections 3-6)
    ├ STEP 2  billing pilot, 2,000 rows      --pilot        (~$3, MANDATORY)
    ├ STEP 3  full run + hard assertions     --full         (resumable)
    └ STEP 4  questions_fts + ANALYZE        --fts

    python questions_run.py                # pilot → gate → full → fts → report
    python questions_run.py --resume       # pick up exactly where it stopped
    python questions_run.py --pilot-only   # stop after the pilot report
    python questions_run.py --verify       # assertions + report, no API calls

MODEL ROUTING — every row is covered, none skipped (asserted before submitting):
    gemini-3.6-flash  verses + verse_chunks whose (parent) verse scripture is
                      BG / SB / CC                                  43,232 rows
    gemini-3-flash    everything else                              200,916 rows
                                                            TOTAL  244,148 rows

BREAKING CHANGE (gemini-3.6-flash): temperature / top_p / top_k are no longer
accepted (silently ignored) and frequency/presence penalties raise an error. This
pipeline sends NONE of them for EITHER model — see `generation_config()`, which is
the single place a sampling knob could enter, and `tests/test_questions_run.py`,
which asserts the built request carries none of them. Also: the final input turn
must not have role "model"; every request here is a single role="user" turn.

COST. Batch pricing (already halved vs interactive) is pinned per model and the
OUTPUT price applies to thinking tokens too — `usage_from_results_file` counts
candidates + thoughts as output, so the ledger never undercounts. MAX_SPEND_USD
is enforced at shard submission: a shard that would push committed spend over the
ceiling is not submitted, and the run stops submitting (collection continues).

RESUME. Everything needed to resume lives in Postgres (`question_batch_jobs`) and
the shard files on disk. Closing the laptop mid-run is safe: submitted jobs keep
running on Google's side for up to 24h, `--resume` re-attaches by provider job id,
and `reconcile()` adopts any job that was accepted but not recorded (matched by
display_name) rather than resubmitting and double-paying.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import config
import db
import gemini_client

# ═══════════════════════════════════════════════════════════════════════════
# 1 — configuration
# ═══════════════════════════════════════════════════════════════════════════

PROMPT_VERSION = "asp-questions-v1"
BATCH_DISPLAY_PREFIX = "asp-questions-v1"

# Model strings. Overridable in .env, but the defaults are the two models the
# brief routes to. Confirmed against the live models list before any paid call.
MODEL_36 = config._env("QUESTIONS_MODEL_36") or "gemini-3.6-flash"
MODEL_3 = config._env("QUESTIONS_MODEL_3") or "gemini-3-flash"

# Batch prices per 1M tokens — the HALVED batch rates, pinned in .env per the
# brief. The out price applies to candidates AND thinking tokens.
PRICES: dict[str, tuple[float, float]] = {
    MODEL_36: (
        config._env_float("GEMINI_36_PRICE_IN_PER_M", 0.75),
        config._env_float("GEMINI_36_PRICE_OUT_PER_M", 3.75),
    ),
    MODEL_3: (
        config._env_float("GEMINI_3_PRICE_IN_PER_M", 0.25),
        config._env_float("GEMINI_3_PRICE_OUT_PER_M", 1.50),
    ),
}

# Machine-enforced ceiling, checked before every shard submission.
MAX_SPEND_USD = config._env_float("MAX_SPEND_USD", 500.0)

# The routing contract. These are ASSERTED against live counts before the full
# run submits anything — if the corpus changed, the run stops rather than
# silently covering a different number of rows than the brief specifies.
CORE_SCRIPTURES = ("BG", "SB", "CC")
EXPECTED_CORE = 43_232
EXPECTED_STANDARD = 200_916
EXPECTED_TOTAL = 244_148

TABLES = ["verses", "verse_chunks", "prose_paragraphs", "transcript_paragraphs",
          "letter_paragraphs"]

# Passage text cap. The brief specifies 6,000 characters; every truncation is
# logged and counted (reported in the pilot report and the final report).
PASSAGE_CHAR_CAP = config._env_int("QUESTIONS_PASSAGE_CHAR_CAP", 6000)

MAX_QUESTIONS = 3
SHARD_SIZE = config._env_int("QUESTIONS_SHARD_SIZE", 6000)
SHARD_MAX_INPUT_TOKENS = config._env_int("QUESTIONS_SHARD_MAX_INPUT_TOKENS", 400_000)
MAX_OUTPUT_TOKENS = config._env_int("QUESTIONS_MAX_OUTPUT_TOKENS", 4096)
THINKING_LEVEL = "LOW"
BATCH_POLL_SECONDS = config._env_int("BATCH_POLL_SECONDS", 60)
DB_WRITE_CHUNK = 1000
MAX_ATTEMPTS = 3  # first pass + 2 retries before a row is reported unresolved

# Pilot (STEP 2).
PILOT_SIZE = config._env_int("QUESTIONS_PILOT_SIZE", 2000)
PILOT_FLOOR_PER_STRATUM = 100     # so every table AND both models get real signal
PILOT_AUTO_CONTINUE_USD = config._env_float("QUESTIONS_PILOT_AUTO_CONTINUE_USD", 320.0)
PILOT_MAX_META_REFERENCE = 0.01   # must be under 1%
PILOT_MAX_QUOTE_MISMATCH = 0.01   # must be under 1%
SAMPLE_SEED = config._env("QUESTIONS_SAMPLE_SEED") or "asp-questions-v1"

SHARDS_DIR = config.HARNESS_DIR / "shards" / "questions"
REPORT_PATH = config.HARNESS_DIR / "questions-report.md"
PILOT_REPORT_PATH = config.HARNESS_DIR / "questions-pilot-report.md"

# The closed enums. FINE-GRAINED on purpose: 16 function labels + "unclear",
# collapsible to any coarser scheme later in SQL for free. Never re-run.
SPEAKERS = [
    "explicit_prabhupada", "likely_prabhupada", "explicit_other_speaker",
    "quoted_or_recited", "editorial_or_metadata", "uncertain",
]
FUNCTIONS = [
    "defines", "explains", "instructs", "recommends", "prohibits", "warns",
    "encourages", "answers_question", "compares", "contrasts", "refutes",
    "quotes_scripture", "narrates_event", "gives_analogy", "gives_example",
    "states_conclusion", "unclear",
]

# Meta-reference detector for the pilot gate. A question that points at its own
# container ("what does this passage say about X") is unusable on a page, so the
# pilot measures the rate and the gate requires it under 1%.
META_PATTERNS = [
    r"\bthis (passage|text|verse|paragraph|excerpt|section|quote|letter|lecture)\b",
    r"\bthe (passage|text|author|speaker|excerpt|paragraph)\b",
    r"\bthe above\b", r"\bthe following\b", r"\bhere\b.{0,12}\bdescribed\b",
    r"\bin this (passage|text|verse|section)\b",
    r"\baccording to (this|the) (passage|text|author)\b",
]
META_RE = re.compile("|".join(META_PATTERNS), re.IGNORECASE)


def require(*names: str) -> None:
    """Fail loudly for the credentials THIS pipeline actually needs. (config's
    own require_keys() also demands VOYAGE_API_KEY, which questions never uses —
    no embeddings are computed here, so a missing Voyage key must not block a
    verify or an fts rebuild.)"""
    values = {
        "SUPABASE_URL": config.SUPABASE_URL,
        "SUPABASE_SERVICE_KEY": config.SUPABASE_SERVICE_KEY,
        "DATABASE_URL": config.DATABASE_URL,
        "GEMINI_API_KEY": config.GEMINI_API_KEY,
    }
    missing = [n for n in names if not values.get(n)]
    if missing:
        raise SystemExit(
            "FATAL: missing required credentials: " + ", ".join(missing)
            + f"\nPut them in {config.ENV_FILE} (see .env.example)."
        )


def prices_for(model: str) -> tuple[float, float]:
    """Effective (in, out) $/1M for `model`. An unpriced model is a hard stop —
    money is never spent, or even estimated, at a guess."""
    p = PRICES.get(model)
    if p is None or p[0] <= 0 or p[1] <= 0:
        raise SystemExit(
            f"FATAL: no pinned batch price for model {model!r}. Pin"
            " GEMINI_36_PRICE_IN_PER_M / _OUT_PER_M (gemini-3.6-flash) and"
            " GEMINI_3_PRICE_IN_PER_M / _OUT_PER_M (gemini-3-flash) in .env."
        )
    return p


def usd(model: str, input_tok: float, output_tok: float) -> float:
    pin, pout = prices_for(model)
    return input_tok / 1e6 * pin + output_tok / 1e6 * pout


# ═══════════════════════════════════════════════════════════════════════════
# 2 — schema (idempotent DDL over DATABASE_URL; never apply_migration)
# ═══════════════════════════════════════════════════════════════════════════

DDL = """
-- STEP 1: speaker + speaker_evidence live on the content tables next to the
-- columns they explain. Additive and idempotent.
{speaker_alters}

CREATE TABLE IF NOT EXISTS public.question_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  prompt_version text NOT NULL,
  config         jsonb NOT NULL DEFAULT '{{}}'::jsonb,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  notes          text
);
ALTER TABLE public.question_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.question_batch_jobs (
  shard_key          text PRIMARY KEY,
  run_id             uuid REFERENCES public.question_runs(id),
  phase              text NOT NULL,
  attempt            int  NOT NULL DEFAULT 1,
  table_name         text NOT NULL,
  model              text NOT NULL,
  price_in_per_m     numeric NOT NULL,
  price_out_per_m    numeric NOT NULL,
  id_list            uuid[] NOT NULL,
  row_count          int  NOT NULL DEFAULT 0,
  provider_job_id    text,
  status             text NOT NULL DEFAULT 'pending',
  submitted_at       timestamptz,
  est_input_tok      bigint DEFAULT 0,
  est_output_tok     bigint DEFAULT 0,
  cost_input_tok     bigint DEFAULT 0,
  cost_output_tok    bigint DEFAULT 0,
  cost_candidate_tok bigint DEFAULT 0,
  cost_thought_tok   bigint DEFAULT 0,
  applied_rows       int DEFAULT 0,
  invalid_rows       int DEFAULT 0,
  truncated_rows     int DEFAULT 0,
  error              text
);
ALTER TABLE public.question_batch_jobs ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_qbj_status ON public.question_batch_jobs (status);
CREATE INDEX IF NOT EXISTS idx_qbj_run    ON public.question_batch_jobs (run_id);

-- Per-row model output, kept for the pilot metrics and for audit. The full run
-- writes evidence only for rows it could not apply, so this stays small.
CREATE TABLE IF NOT EXISTS public.question_evidence (
  id                bigserial PRIMARY KEY,
  run_id            uuid,
  phase             text,
  table_name        text NOT NULL,
  passage_id        uuid NOT NULL,
  model             text,
  speaker           text,
  speaker_evidence  text,
  eligible          boolean,
  questions         jsonb,
  passage_function  text,
  function_evidence text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.question_evidence ENABLE ROW LEVEL SECURITY;
CREATE INDEX IF NOT EXISTS idx_qev_passage ON public.question_evidence (table_name, passage_id);
CREATE INDEX IF NOT EXISTS idx_qev_run     ON public.question_evidence (run_id);
"""


def ensure_schema() -> None:
    """Idempotent DDL. ADD COLUMN needs ACCESS EXCLUSIVE, and a *pending* lock
    request queues every later reader behind it — so if one of these tables is
    busy (an fts_expansion backfill can hold it for hours) an unguarded ALTER
    would stall the live site rather than just waiting its turn. lock_timeout
    makes us fail fast and say which table is busy instead."""
    alters = "\n".join(
        f"ALTER TABLE public.{t} ADD COLUMN IF NOT EXISTS speaker text,"
        f" ADD COLUMN IF NOT EXISTS speaker_evidence text;"
        for t in TABLES
    )
    conn = db.get_pg()
    with conn.cursor() as cur:
        cur.execute("SET lock_timeout = '10s'")
        try:
            cur.execute(DDL.format(speaker_alters=alters))
        except Exception as exc:  # noqa: BLE001 — re-raised with the actionable hint
            if "lock" not in str(exc).lower():
                raise
            raise SystemExit(
                f"FATAL: could not add the speaker columns — a table is busy"
                f" ({exc}).\n  Something long-running holds it (an"
                f" fts_expansion backfill takes hours on transcript_paragraphs)."
                f"\n  Wait for it to finish, then rerun. We deliberately do NOT"
                f" queue for the lock: a pending ACCESS EXCLUSIVE request blocks"
                f" every reader behind it, including the live site."
            ) from exc
        finally:
            cur.execute("SET lock_timeout = '0'")
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)


# ═══════════════════════════════════════════════════════════════════════════
# 3 — routing
# ═══════════════════════════════════════════════════════════════════════════
#
# The SINGLE source of truth for which passage goes to which model, expressed
# once as a SQL predicate (used by the planner and the counters) and once as a
# pure function (used by the request builder and the tests). They must agree —
# `assert_routing_totals` proves it against the live corpus before any spend.

# Rows routed to gemini-3.6-flash: verses (own scripture) and verse_chunks
# (parent verse's scripture) in BG / SB / CC.
_CORE_LIST = ", ".join(f"'{s}'" for s in CORE_SCRIPTURES)
CORE_PREDICATE = {
    "verses": f"upper(coalesce(v.scripture,'')) IN ({_CORE_LIST})",
    "verse_chunks": f"upper(coalesce(pv.scripture,'')) IN ({_CORE_LIST})",
}
# FROM clause per table for the planner (aliased `v`, parent verse `pv`).
FROM_CLAUSE = {
    "verses": "public.verses v",
    "verse_chunks": "public.verse_chunks v JOIN public.verses pv ON pv.id = v.verse_id",
    "prose_paragraphs": "public.prose_paragraphs v",
    "transcript_paragraphs": "public.transcript_paragraphs v",
    "letter_paragraphs": "public.letter_paragraphs v",
}


def model_for(table: str, scripture: str | None) -> str:
    """Pure routing rule. `scripture` is the row's own scripture for verses and
    the PARENT verse's scripture for verse_chunks; it is ignored for every other
    table. Anything not explicitly core routes to the cheaper model — an unknown
    or NULL scripture is never assumed to be core."""
    if table in CORE_PREDICATE and (scripture or "").strip().upper() in CORE_SCRIPTURES:
        return MODEL_36
    return MODEL_3


def model_tag(model: str) -> str:
    return "m36" if model == MODEL_36 else "m3"


def route_counts() -> dict[tuple[str, str], int]:
    """Live population of every (table, model) stratum."""
    out: dict[tuple[str, str], int] = {}
    for table in TABLES:
        frm = FROM_CLAUSE[table]
        pred = CORE_PREDICATE.get(table)
        if pred:
            core = int(db.one(f"SELECT count(*) FROM {frm} WHERE {pred}"))
            total = int(db.one(f"SELECT count(*) FROM {frm}"))
            out[(table, MODEL_36)] = core
            out[(table, MODEL_3)] = total - core
        else:
            out[(table, MODEL_3)] = int(db.one(f"SELECT count(*) FROM {frm}"))
    return {k: v for k, v in out.items() if v > 0}


def assert_routing_totals(strata: dict[tuple[str, str], int]) -> None:
    """Hard gate before any submission: the routed populations must be exactly
    the numbers the brief specifies. A mismatch means the corpus moved under us,
    and covering a different row set than agreed is never a silent decision."""
    core = sum(n for (_t, m), n in strata.items() if m == MODEL_36)
    standard = sum(n for (_t, m), n in strata.items() if m == MODEL_3)
    total = core + standard
    print(f"  routing: {MODEL_36} → {core:,} rows"
          f" · {MODEL_3} → {standard:,} rows · total {total:,}")
    problems = []
    if core != EXPECTED_CORE:
        problems.append(f"{MODEL_36}: {core:,} != expected {EXPECTED_CORE:,}")
    if standard != EXPECTED_STANDARD:
        problems.append(f"{MODEL_3}: {standard:,} != expected {EXPECTED_STANDARD:,}")
    if total != EXPECTED_TOTAL:
        problems.append(f"total: {total:,} != expected {EXPECTED_TOTAL:,}")
    if problems:
        raise SystemExit(
            "FATAL: routed row counts do not match the agreed plan —\n    "
            + "\n    ".join(problems)
            + "\n  Refusing to submit. Reconcile the corpus (or update"
              " EXPECTED_CORE/EXPECTED_STANDARD/EXPECTED_TOTAL deliberately)"
              " before spending money."
        )
    print(f"  ✓ routing totals match the plan exactly ({EXPECTED_TOTAL:,} rows)")


# ═══════════════════════════════════════════════════════════════════════════
# 4 — passages
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class Passage:
    table: str
    id: str
    text: str
    model: str
    truncated_from: int = 0   # original char length when the cap bit, else 0


def _verse_text(translation: str | None, synonyms: str | None,
                purport: str | None, has_chunks: bool) -> str:
    """Assemble a verse's passage text.

    AVOIDING A DOUBLE PAYMENT FOR PURPORTS: 11,945 verses have their purport
    ALSO split across verse_chunks, and every chunk gets its own request. Sending
    the full purport on the parent verse as well would bill that text twice — so
    a verse THAT HAS CHUNKS is sent as translation + synonyms only (the chunks
    carry the purport), and a verse with NO chunks is sent as translation +
    purport. Either way every row still gets its own request; nothing is skipped."""
    parts = []
    if translation:
        parts.append("TRANSLATION:\n" + translation.strip())
    if has_chunks:
        if synonyms:
            parts.append("SYNONYMS (word-for-word):\n" + synonyms.strip())
    elif purport:
        parts.append("PURPORT:\n" + purport.strip())
    return "\n\n".join(parts)


def _cap(text: str) -> tuple[str, int]:
    """Apply the 6,000-character cap. Returns (text, original_len_if_truncated)."""
    text = text or ""
    if len(text) <= PASSAGE_CHAR_CAP:
        return text, 0
    return text[:PASSAGE_CHAR_CAP], len(text)


def load_passages(table: str, ids: list[str]) -> list[Passage]:
    """Fetch passage text for a shard's rows, in the shard's id order where
    possible. Every requested id yields exactly one Passage — a row with empty
    text still gets its request (the model is expected to return zero questions
    for it), because the brief requires that no row be skipped."""
    out: dict[str, Passage] = {}
    if table == "verses":
        rows = db.rows(
            "SELECT v.id::text, v.translation, v.synonyms, v.purport, v.scripture,"
            "       EXISTS (SELECT 1 FROM public.verse_chunks c WHERE c.verse_id = v.id)"
            " FROM public.verses v WHERE v.id = ANY(%s::uuid[])",
            (ids,),
        )
        for vid, translation, synonyms, purport, scripture, has_chunks in rows:
            text, was = _cap(_verse_text(translation, synonyms, purport, has_chunks))
            out[vid] = Passage(table, vid, text, model_for(table, scripture), was)
    elif table == "verse_chunks":
        rows = db.rows(
            "SELECT c.id::text, c.body_text, pv.scripture"
            " FROM public.verse_chunks c JOIN public.verses pv ON pv.id = c.verse_id"
            " WHERE c.id = ANY(%s::uuid[])",
            (ids,),
        )
        for cid, body, scripture in rows:
            text, was = _cap(body or "")
            out[cid] = Passage(table, cid, text, model_for(table, scripture), was)
    else:
        rows = db.rows(
            f"SELECT id::text, body_text FROM public.{table} WHERE id = ANY(%s::uuid[])",
            (ids,),
        )
        for pid, body in rows:
            text, was = _cap(body or "")
            out[pid] = Passage(table, pid, text, model_for(table, None), was)

    missing = [i for i in ids if i not in out]
    if missing:
        raise SystemExit(
            f"FATAL: {len(missing)} id(s) planned for {table} no longer exist"
            f" (first: {missing[:3]}). The corpus changed mid-run; re-plan."
        )
    return [out[i] for i in ids]


# ═══════════════════════════════════════════════════════════════════════════
# 5 — prompt + response schema
# ═══════════════════════════════════════════════════════════════════════════

PROMPT_TEMPLATE = """\
You are reading ONE passage from the collected works of His Divine Grace
A. C. Bhaktivedanta Swami Prabhupāda — his books and purports, his recorded
lectures and conversations, and his letters.

Your job is to decide what questions this passage genuinely answers, so a
devotee's typed question can be matched to it later. Work in the order below and
report the EVIDENCE BEFORE each answer — quote first, conclude second.

STEP A — WHO IS SPEAKING
Decide who is speaking in the passage and quote the exact line that proves it.
  explicit_prabhupada     a "Prabhupāda:" marker, or his own book/purport/letter
                          voice, or a signature identifying him
  likely_prabhupada       clearly his teaching voice, but no explicit marker
  explicit_other_speaker  another named speaker's words (a guest, a reporter,
                          a disciple asking a question)
  quoted_or_recited       scripture, a verse, or another authority being quoted
                          or recited rather than spoken by the speaker
  editorial_or_metadata   headings, place/date lines, track labels, editorial
                          notes, publication apparatus
  uncertain               the passage genuinely does not say
Put the proving line in "speaker_evidence", copied exactly from the passage. If
nothing in the passage proves it, say so there in a short phrase.

STEP B — IS THIS PASSAGE WORTH ANY QUESTION AT ALL
Set "eligible" false, and return an EMPTY questions list, when the passage is
filler, a fragment, a greeting, a citation-only line, a heading, or another
speaker's words with no teaching in them. ZERO QUESTIONS IS CORRECT AND
PREFERRED for such passages. Never invent a question to fill space.

STEP C — THE QUESTIONS (0 to {max_questions})
Write questions a real devotee might actually type, that THIS passage directly
answers. For each one, first quote the exact supporting sentence from the
passage, then write the question. Rules:
  1. Copy "support_quote" VERBATIM from the passage — it must appear in the
     passage character for character.
  2. Never use "this passage", "the text", "the author", or any other
     meta-reference. Each question must stand completely on its own, readable
     by someone who has not seen the passage.
  3. Do not put the answer inside the question.
  4. Do not make a question by swapping one word of a sentence for a question
     word. Ask what a person would actually ask.
  5. Each question must cover a DIFFERENT point in the passage.
  6. Where a Sanskrit term appears, write at least one question that uses the
     term and at least one that uses ordinary English for the same idea.
  7. Questions must be well written enough to display on a page: complete,
     correctly punctuated, and specific.
If the passage supports only one good question, return only one. If it supports
none, return an empty list.

STEP D — WHAT THE PASSAGE DOES
Choose the ONE label that best describes what the passage does, and quote the
line that shows it in "function_evidence":
{function_list}
Use "unclear" only when none of the others fit.

Return JSON matching the required schema exactly. Include EVERY field, in the
schema's order, even when a list is empty or a value is "uncertain"/"unclear".

PASSAGE_ID: {passage_id}
PASSAGE:
\"\"\"
{passage_text}
\"\"\"
"""

_FUNCTION_GLOSS = {
    "defines": "states what something is",
    "explains": "explains why or how something is so",
    "instructs": "tells the reader/listener to do something",
    "recommends": "advises a course as best",
    "prohibits": "forbids something",
    "warns": "warns of a consequence",
    "encourages": "reassures or urges on",
    "answers_question": "answers a question that was asked",
    "compares": "draws a likeness between two things",
    "contrasts": "sets two things against each other",
    "refutes": "argues against a position",
    "quotes_scripture": "cites or recites scripture as authority",
    "narrates_event": "tells what happened",
    "gives_analogy": "illustrates by analogy",
    "gives_example": "illustrates by concrete example",
    "states_conclusion": "sums up or concludes",
    "unclear": "none of the above fits",
}


def build_prompt(passage: Passage) -> str:
    functions = "\n".join(f"  {name:<18} {_FUNCTION_GLOSS[name]}" for name in FUNCTIONS)
    return PROMPT_TEMPLATE.format(
        max_questions=MAX_QUESTIONS,
        function_list=functions,
        passage_id=passage.id,
        passage_text=passage.text,
    )


def response_schema() -> dict:
    """The JSON contract. `propertyOrdering` pins the EVIDENCE-FIRST field order
    the brief specifies: the model commits to who is speaking and to a supporting
    quote before it is allowed to write the answer it is being paid for."""
    return {
        "type": "object",
        "properties": {
            "passage_id": {"type": "string"},
            "speaker": {"type": "string", "enum": SPEAKERS},
            "speaker_evidence": {"type": "string"},
            "eligible": {"type": "boolean"},
            "questions": {
                "type": "array",
                "maxItems": MAX_QUESTIONS,
                "items": {
                    "type": "object",
                    "properties": {
                        "support_quote": {"type": "string"},
                        "question": {"type": "string"},
                    },
                    "required": ["support_quote", "question"],
                    "propertyOrdering": ["support_quote", "question"],
                },
            },
            "function": {"type": "string", "enum": FUNCTIONS},
            "function_evidence": {"type": "string"},
        },
        "required": ["passage_id", "speaker", "speaker_evidence", "eligible",
                     "questions", "function", "function_evidence"],
        "propertyOrdering": ["passage_id", "speaker", "speaker_evidence",
                             "eligible", "questions", "function",
                             "function_evidence"],
    }


def generation_config() -> dict:
    """The ONLY place a generation knob can enter a request.

    gemini-3.6-flash no longer accepts temperature / topP / topK (they are
    ignored) and RAISES on frequencyPenalty / presencePenalty. None of them are
    sent for EITHER model — not as None, not as a default, not at all. If a
    sampling knob is ever needed again it has to be added here, in the open,
    where the test that forbids it will fail."""
    return {
        "responseMimeType": "application/json",
        "responseSchema": response_schema(),
        "thinkingConfig": {"thinkingLevel": THINKING_LEVEL},
        "maxOutputTokens": MAX_OUTPUT_TOKENS,
    }


def request_line(passage: Passage) -> dict:
    """One batch request. A SINGLE role="user" turn: the final input turn must
    never carry role "model"."""
    return {
        "key": f"{passage.table}|{passage.id}",
        "request": {
            "contents": [{"role": "user", "parts": [{"text": build_prompt(passage)}]}],
            "generationConfig": generation_config(),
        },
    }


# ═══════════════════════════════════════════════════════════════════════════
# 6 — run bookkeeping + shard planning
# ═══════════════════════════════════════════════════════════════════════════

def run_config() -> dict:
    return {
        "prompt_version": PROMPT_VERSION,
        "models": {"core": MODEL_36, "standard": MODEL_3},
        "prices": {m: list(p) for m, p in PRICES.items()},
        "max_spend_usd": MAX_SPEND_USD,
        "passage_char_cap": PASSAGE_CHAR_CAP,
        "max_questions": MAX_QUESTIONS,
        "shard_size": SHARD_SIZE,
        "pilot_size": PILOT_SIZE,
        "sample_seed": SAMPLE_SEED,
        "expected_total": EXPECTED_TOTAL,
    }


def open_run() -> str:
    """Resume the open run if there is one, else register a new one. Matching on
    (prompt_version, finished_at IS NULL) is what makes `--resume` find the same
    run after the laptop was closed."""
    existing = db.rows(
        "SELECT id::text FROM public.question_runs"
        " WHERE finished_at IS NULL AND prompt_version = %s"
        " ORDER BY started_at DESC LIMIT 1",
        (PROMPT_VERSION,),
    )
    if existing:
        run_id = existing[0][0]
        with db.get_pg().cursor() as cur:
            cur.execute(
                "UPDATE public.question_runs SET config = config || %s::jsonb"
                " WHERE id = %s::uuid",
                (json.dumps(run_config()), run_id),
            )
        print(f"  resuming run {run_id}")
        return run_id
    run_id = db.one(
        "INSERT INTO public.question_runs (prompt_version, config)"
        " VALUES (%s, %s::jsonb) RETURNING id::text",
        (PROMPT_VERSION, json.dumps(run_config())),
    )
    print(f"  started run {run_id}")
    return run_id


def finish_run(run_id: str, notes: str) -> None:
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.question_runs SET finished_at = %s, notes = %s"
            " WHERE id = %s::uuid",
            (datetime.now(timezone.utc), notes, run_id),
        )


def shard_path(shard_key: str, kind: str) -> Path:
    return SHARDS_DIR / f"{shard_key}.{kind}.jsonl"


def _insert_shards(run_id: str, phase: str, table: str, model: str,
                   ids: list[str], attempt: int = 1) -> int:
    """Persist shard rows BEFORE anything is built or submitted, so a crash at
    any later point is recoverable from the DB alone. Idempotent: an existing
    shard_key is left untouched (ON CONFLICT DO NOTHING), which is what makes
    re-planning during --resume safe."""
    pin, pout = prices_for(model)
    tag = model_tag(model)
    made = 0
    conn = db.get_pg()
    with conn.transaction():
        with conn.cursor() as cur:
            for i in range(0, len(ids), SHARD_SIZE):
                chunk = ids[i:i + SHARD_SIZE]
                key = (f"q-{phase}-{run_id[:8]}-{table}-{tag}"
                       f"-a{attempt}-{i // SHARD_SIZE:03d}")
                cur.execute(
                    "INSERT INTO public.question_batch_jobs"
                    " (shard_key, run_id, phase, attempt, table_name, model,"
                    "  price_in_per_m, price_out_per_m, id_list, row_count)"
                    " VALUES (%s, %s::uuid, %s, %s, %s, %s, %s, %s, %s::uuid[], %s)"
                    " ON CONFLICT (shard_key) DO NOTHING",
                    (key, run_id, phase, attempt, table, model, pin, pout,
                     chunk, len(chunk)),
                )
                made += cur.rowcount
    return made


def already_planned_ids(run_id: str, phase: str) -> int:
    return int(db.one(
        "SELECT coalesce(sum(row_count), 0) FROM public.question_batch_jobs"
        " WHERE run_id = %s::uuid AND phase = %s AND attempt = 1",
        (run_id, phase),
    ))


def plan_full(run_id: str, strata: dict[tuple[str, str], int]) -> int:
    """Plan every one of the 244,148 rows into shards, split by (table, model).
    Rows already planned for this run are left alone, so this is safe to re-enter."""
    planned = already_planned_ids(run_id, "full")
    if planned:
        print(f"  full run already planned: {planned:,} rows in shards — reusing")
        return planned
    total = 0
    for (table, model), population in sorted(strata.items()):
        frm = FROM_CLAUSE[table]
        pred = CORE_PREDICATE.get(table)
        if pred:
            where = pred if model == MODEL_36 else f"NOT ({pred})"
        else:
            where = "TRUE"
        ids = [r[0] for r in db.rows(
            f"SELECT v.id::text FROM {frm} WHERE {where} ORDER BY v.id"
        )]
        if len(ids) != population:
            raise SystemExit(
                f"FATAL: {table}/{model} planned {len(ids):,} ids but counted"
                f" {population:,} — the corpus moved mid-plan."
            )
        _insert_shards(run_id, "full", table, model, ids)
        total += len(ids)
        print(f"    planned {table:<22} {model_tag(model):<4} {len(ids):>8,} rows")
    if total != EXPECTED_TOTAL:
        raise SystemExit(
            f"FATAL: planned {total:,} rows, expected exactly {EXPECTED_TOTAL:,}."
        )
    print(f"  ✓ planned {total:,} rows == {EXPECTED_TOTAL:,}")
    return total


def _largest_remainder(total: int, weights: dict, caps: dict) -> dict:
    """Allocate `total` across `weights` proportionally, never exceeding `caps`."""
    keys = list(weights)
    mass = sum(weights.values()) or 1
    exact = {k: total * weights[k] / mass for k in keys}
    alloc = {k: min(int(exact[k]), caps[k]) for k in keys}
    remainder = total - sum(alloc.values())
    order = sorted(keys, key=lambda k: exact[k] - int(exact[k]), reverse=True)
    i = 0
    while remainder > 0 and i < len(order) * 4:
        k = order[i % len(order)]
        if alloc[k] < caps[k]:
            alloc[k] += 1
            remainder -= 1
        i += 1
    return alloc


def plan_pilot(run_id: str, strata: dict[tuple[str, str], int]) -> int:
    """STEP 2's manifest: PILOT_SIZE rows, seeded-random, stratified across all
    five tables AND both models.

    Every stratum gets a floor (so the 111 standard-route verses and the 487
    standard-route chunks are actually represented, not rounded away), and the
    remainder is allocated proportionally to population. Selection is
    `ORDER BY md5(seed || id)`, which is deterministic and reproducible from the
    seed alone — no setseed, no state file, and re-planning picks the same rows."""
    planned = already_planned_ids(run_id, "pilot")
    if planned:
        print(f"  pilot already planned: {planned:,} rows — reusing")
        return planned

    caps = dict(strata)
    floors = {k: min(PILOT_FLOOR_PER_STRATUM, caps[k]) for k in caps}
    remaining = PILOT_SIZE - sum(floors.values())
    if remaining < 0:
        raise SystemExit(
            f"FATAL: pilot floors ({sum(floors.values())}) exceed PILOT_SIZE"
            f" ({PILOT_SIZE}); lower PILOT_FLOOR_PER_STRATUM."
        )
    headroom = {k: caps[k] - floors[k] for k in caps}
    extra = _largest_remainder(remaining, headroom, headroom)
    alloc = {k: floors[k] + extra[k] for k in caps}
    if sum(alloc.values()) != PILOT_SIZE:
        raise SystemExit(
            f"FATAL: pilot allocation sums to {sum(alloc.values())}, expected {PILOT_SIZE}"
        )

    total = 0
    for (table, model), n in sorted(alloc.items()):
        if n <= 0:
            continue
        frm = FROM_CLAUSE[table]
        pred = CORE_PREDICATE.get(table)
        if pred:
            where = pred if model == MODEL_36 else f"NOT ({pred})"
        else:
            where = "TRUE"
        ids = [r[0] for r in db.rows(
            f"SELECT v.id::text FROM {frm} WHERE {where}"
            f" ORDER BY md5(%s || v.id::text) LIMIT %s",
            (SAMPLE_SEED, n),
        )]
        _insert_shards(run_id, "pilot", table, model, ids)
        total += len(ids)
        print(f"    pilot {table:<22} {model_tag(model):<4} {len(ids):>5,}"
              f" of {caps[(table, model)]:>8,}")
    print(f"  ✓ pilot manifest: {total:,} rows (seed {SAMPLE_SEED!r})")
    return total


# ═══════════════════════════════════════════════════════════════════════════
# 7 — cost ledger + submission
# ═══════════════════════════════════════════════════════════════════════════

def preflight_estimate(strata: dict[tuple[str, str], int], sample: int = 60) -> float:
    """FREE, before a single paid call: build real requests for a small sample of
    each stratum, measure their actual size, and project the full-run input cost.

    Input is the predictable half of the bill — the prompt and JSON schema are a
    fixed ~1,400 tokens on every one of 244,148 requests — so this catches an
    unaffordable run before even the pilot is submitted. Output tokens are still
    a guess here (the pilot measures them for real), so the number printed is a
    FLOOR plus an estimate, never a promise."""
    est_out_per_row = float(config._env_int("QUESTIONS_EST_OUTPUT_TOKENS", 420))
    total = 0.0
    print("\n  pre-flight cost projection (input measured, output estimated)")
    print(f"  {'stratum':<34} {'rows':>9} {'in/row':>8} {'est $':>10}")
    print(f"  {'-'*34} {'-'*9} {'-'*8} {'-'*10}")
    for (table, model), population in sorted(strata.items()):
        frm = FROM_CLAUSE[table]
        pred = CORE_PREDICATE.get(table)
        where = "TRUE" if not pred else (pred if model == MODEL_36 else f"NOT ({pred})")
        ids = [r[0] for r in db.rows(
            f"SELECT v.id::text FROM {frm} WHERE {where}"
            f" ORDER BY md5(%s || v.id::text) LIMIT %s", (SAMPLE_SEED, sample))]
        if not ids:
            continue
        passages = load_passages(table, ids)
        per_row = sum(est_tokens(json.dumps(request_line(p), ensure_ascii=False))
                      for p in passages) / len(passages)
        cost = usd(model, per_row * population, est_out_per_row * population)
        total += cost
        print(f"  {table + '/' + model_tag(model):<34} {population:>9,}"
              f" {per_row:>8,.0f} {cost:>10,.2f}")
    print(f"  {'TOTAL':<34} {sum(strata.values()):>9,} {'':>8} {total:>10,.2f}")
    if total > PILOT_AUTO_CONTINUE_USD:
        print(f"\n  ⚠ projected ${total:,.2f} already exceeds the"
              f" ${PILOT_AUTO_CONTINUE_USD:,.2f} auto-continue threshold."
              f"\n    The pilot will measure the real number; if it agrees, the run"
              f" will STOP and wait for you."
              f"\n    Levers: raise QUESTIONS_PILOT_AUTO_CONTINUE_USD, shorten the"
              f" prompt, or route more rows to {MODEL_3}.")
    return total


def spend_ledger() -> dict:
    """Real (billed) + in-flight (estimated) spend, priced at each shard's OWN
    recorded prices. Scoped to question_batch_jobs — the tags run's spend is a
    separate ledger and never counts against this ceiling (or vice versa)."""
    real, est = db.rows(
        "SELECT"
        " coalesce(sum(CASE WHEN status IN ('retrieved','applied','failed') THEN"
        "   cost_input_tok * price_in_per_m / 1e6"
        " + cost_output_tok * price_out_per_m / 1e6 END), 0),"
        " coalesce(sum(CASE WHEN status IN ('submitted','running') THEN"
        "   est_input_tok * price_in_per_m / 1e6"
        " + est_output_tok * price_out_per_m / 1e6 END), 0)"
        " FROM public.question_batch_jobs"
    )[0]
    return {"real_usd": float(real), "in_flight_est_usd": float(est),
            "committed_usd": float(real) + float(est)}


def measured_output_tokens_per_row(model: str) -> float:
    """Measured avg output tokens/row for `model` once real usage exists (per
    model, so the cheap model's estimates are never inflated by the other's),
    else a conservative pre-pilot estimate."""
    row = db.rows(
        "SELECT coalesce(sum(cost_output_tok),0), coalesce(sum(applied_rows),0)"
        " FROM public.question_batch_jobs"
        " WHERE status IN ('retrieved','applied') AND cost_output_tok > 0"
        "   AND model = %s",
        (model,),
    )[0]
    out, rows = float(row[0]), float(row[1])
    if rows > 0 and out > 0:
        return out / rows
    return float(config._env_int("QUESTIONS_EST_OUTPUT_TOKENS", 420))


def est_tokens(raw: str) -> int:
    return len(raw) // 4  # chars/4 ≈ tokens, same estimator the tags ledger uses


@dataclass
class ShardPart:
    shard_key: str
    rows: int
    est_in: int
    est_out: int
    model: str
    truncated: int = 0


def build_shard_files(shard_key: str, table: str, model: str,
                      ids: list[str]) -> list[ShardPart]:
    """Write the request JSONL for one shard, splitting into token-bounded parts
    when the built requests exceed the per-job queue cap. Every part's id_list is
    persisted, and the union of the parts equals the original id_list — so no row
    is ever lost to a split."""
    passages = load_passages(table, ids)
    lines: list[tuple[str, str, int]] = []
    truncated = 0
    for p in passages:
        if p.truncated_from:
            truncated += 1
            print(f"      truncated {table}|{p.id}: {p.truncated_from:,} →"
                  f" {PASSAGE_CHAR_CAP:,} chars", flush=True)
        raw = json.dumps(request_line(p), ensure_ascii=False)
        lines.append((p.id, raw, est_tokens(raw)))

    parts: list[list[tuple[str, str, int]]] = []
    current: list[tuple[str, str, int]] = []
    current_tok = 0
    for line in lines:
        if current and current_tok + line[2] > SHARD_MAX_INPUT_TOKENS:
            parts.append(current)
            current, current_tok = [], 0
        current.append(line)
        current_tok += line[2]
    if current:
        parts.append(current)

    if len(parts) <= 1:
        return [_write_part(shard_key, parts[0] if parts else [], model, truncated)]

    # Oversized shard → repartition the DB row atomically FIRST, then write files.
    pin, pout = prices_for(model)
    conn = db.get_pg()
    part_keys = [f"{shard_key}p{i:02d}" for i in range(len(parts))]
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute(
                "SELECT run_id::text, phase, attempt FROM public.question_batch_jobs"
                " WHERE shard_key = %s", (shard_key,))
            run_id, phase, attempt = cur.fetchone()
            cur.execute("DELETE FROM public.question_batch_jobs WHERE shard_key = %s",
                        (shard_key,))
            for key, part in zip(part_keys, parts):
                cur.execute(
                    "INSERT INTO public.question_batch_jobs"
                    " (shard_key, run_id, phase, attempt, table_name, model,"
                    "  price_in_per_m, price_out_per_m, id_list, row_count)"
                    " VALUES (%s, %s::uuid, %s, %s, %s, %s, %s, %s, %s::uuid[], %s)",
                    (key, run_id, phase, attempt, table, model, pin, pout,
                     [pid for pid, _r, _t in part], len(part)),
                )
    print(f"    split {shard_key} → {len(parts)} parts (per-job token cap)", flush=True)
    return [_write_part(k, p, model, 0) for k, p in zip(part_keys, parts)]


def _write_part(shard_key: str, lines: list[tuple[str, str, int]],
                model: str, truncated: int) -> ShardPart:
    SHARDS_DIR.mkdir(parents=True, exist_ok=True)
    est_in = 0
    with open(shard_path(shard_key, "requests"), "w", encoding="utf-8", newline="\n") as f:
        for _pid, raw, tok in lines:
            est_in += tok
            f.write(raw + "\n")
    est_out = int(len(lines) * measured_output_tokens_per_row(model))
    return ShardPart(shard_key, len(lines), est_in, est_out, model, truncated)


def submit_pending(run_id: str, phase: str, collect_fn=None) -> bool:
    """Submit this run+phase's pending shards, each against its own model.

    Returns False when the cost ceiling stopped submission (collection should
    still continue). Job ids are recorded the instant Google accepts a job —
    BEFORE any polling — so a crash never loses track of work already paid for.
    A full batch queue is expected backpressure, not an error: we wait for a slot,
    draining the queue by collecting finished shards."""
    pending = db.rows(
        "SELECT shard_key, table_name, id_list::text[], model"
        " FROM public.question_batch_jobs"
        " WHERE run_id = %s::uuid AND phase = %s AND status = 'pending'"
        " ORDER BY shard_key",
        (run_id, phase),
    )
    if not pending:
        return True
    print(f"  submitting {len(pending)} pending shard(s) for phase '{phase}'")
    seen_terminal: set[str] = set()
    for shard_key, table, ids, model in pending:
        for part in build_shard_files(shard_key, table, model, ids):
            if part.rows == 0:
                with db.get_pg().cursor() as cur:
                    cur.execute(
                        "UPDATE public.question_batch_jobs SET status='failed',"
                        " error='no rows' WHERE shard_key=%s", (part.shard_key,))
                continue
            if not _submit_one(part, seen_terminal, run_id, phase, collect_fn):
                return False
    return True


def _submit_one(part: ShardPart, seen_terminal: set[str], run_id: str,
                phase: str, collect_fn) -> bool:
    ledger = spend_ledger()
    projected = ledger["committed_usd"] + usd(part.model, part.est_in, part.est_out)
    if projected > MAX_SPEND_USD:
        print(
            f"  ⛔ COST CEILING: submitting {part.shard_key} would commit"
            f" ~${projected:,.2f} > MAX_SPEND_USD=${MAX_SPEND_USD:,.2f}."
            " Refusing to submit further shards (collection continues).",
            flush=True,
        )
        return False
    display_name = f"{BATCH_DISPLAY_PREFIX}:{part.shard_key}"
    file_name = db.with_retry(
        lambda: gemini_client.upload_jsonl(shard_path(part.shard_key, "requests"),
                                           display_name),
        f"upload {part.shard_key}",
    )
    job_name = _create_batch_waiting_for_queue(
        part.model, file_name, display_name, part.shard_key, seen_terminal,
        run_id, phase, collect_fn)
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.question_batch_jobs SET provider_job_id=%s,"
            " status='submitted', submitted_at=%s, est_input_tok=%s,"
            " est_output_tok=%s, row_count=%s, truncated_rows=%s"
            " WHERE shard_key=%s",
            (job_name, datetime.now(timezone.utc), part.est_in, part.est_out,
             part.rows, part.truncated, part.shard_key),
        )
    print(f"  submitted {part.shard_key} → {job_name}"
          f" ({part.model}, {part.rows:,} rows, ~{part.est_in/1e6:.2f}M in tok)",
          flush=True)
    return True


QUEUE_POLL_SECONDS = 300
QUEUE_GIVE_UP_SECONDS = 24 * 3600


def _create_batch_waiting_for_queue(model, file_name, display_name, shard_key,
                                    seen_terminal, run_id, phase, collect_fn) -> str:
    """create_batch, but patient about a full batch queue. HTTP 429 here means
    the enqueued-token quota is exhausted — expected backpressure — so we wait
    for a job to finish (collecting finished shards, which is what actually frees
    the quota) and retry. Every other error re-raises immediately."""
    deadline = time.monotonic() + QUEUE_GIVE_UP_SECONDS
    while True:
        try:
            return db.with_retry(
                lambda: gemini_client.create_batch(model, file_name, display_name),
                f"batch create {shard_key}", retry_429=False,
            )
        except gemini_client.GeminiHTTPError as exc:
            if exc.status != 429:
                raise
        print("  queue full — waiting for space", flush=True)
        time.sleep(QUEUE_POLL_SECONDS)
        freed = bool(collect_fn()) if collect_fn else False
        for (job_id,) in db.rows(
            "SELECT provider_job_id FROM public.question_batch_jobs"
            " WHERE status='submitted' AND provider_job_id IS NOT NULL"
        ):
            try:
                job = gemini_client.get_batch(job_id)
            except Exception:  # noqa: BLE001 — a poll blip must not abort the wait
                continue
            if (job["state"] in gemini_client.TERMINAL_STATES or job["done"]) \
                    and job_id not in seen_terminal:
                seen_terminal.add(job_id)
                freed = True
        if freed:
            deadline = time.monotonic() + QUEUE_GIVE_UP_SECONDS
        elif time.monotonic() >= deadline:
            raise SystemExit(
                "FATAL: the Gemini batch queue has been full for 24h with no job"
                " finishing. Rerun `python questions_run.py --resume` once jobs"
                " drain — already-submitted work is safe in the DB."
            )


def reconcile(run_id: str) -> None:
    """Adopt any batch job that Google accepted but we failed to record (crash
    between create_batch and the UPDATE), matched by display_name. Without this a
    resume would resubmit and pay twice for the same shard."""
    unrecorded = {
        k for (k,) in db.rows(
            "SELECT shard_key FROM public.question_batch_jobs"
            " WHERE run_id = %s::uuid AND provider_job_id IS NULL"
            "   AND status IN ('pending','submitted')",
            (run_id,),
        )
    }
    if not unrecorded:
        return
    adopted = 0
    for job in gemini_client.list_batches():
        name = job.get("display_name") or ""
        if not name.startswith(BATCH_DISPLAY_PREFIX + ":"):
            continue
        key = name.split(":", 1)[1]
        if key in unrecorded:
            with db.get_pg().cursor() as cur:
                cur.execute(
                    "UPDATE public.question_batch_jobs SET provider_job_id=%s,"
                    " status='submitted' WHERE shard_key=%s AND provider_job_id IS NULL",
                    (job["name"], key),
                )
            adopted += 1
    if adopted:
        print(f"  reconciled {adopted} accepted-but-unrecorded job(s) — not resubmitted")


# ═══════════════════════════════════════════════════════════════════════════
# 8 — collection, validation, apply
# ═══════════════════════════════════════════════════════════════════════════

@dataclass
class RowResult:
    table: str
    passage_id: str
    speaker: str
    speaker_evidence: str
    eligible: bool
    questions: list[dict]
    function: str
    function_evidence: str


@dataclass
class ShardOutcome:
    shard_key: str
    table: str
    model: str
    applied: list[RowResult] = field(default_factory=list)
    invalid: list[tuple[str, str]] = field(default_factory=list)  # (id, reason)


def _parse_response_line(line: str) -> tuple[str | None, dict | None, dict, str | None]:
    """(key, parsed_json, usage, error). Never raises on malformed input — a bad
    line is an invalid row, not a crashed run."""
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None, None, {}, "unparseable results line"
    key = obj.get("key")
    if obj.get("error"):
        return key, None, {}, json.dumps(obj["error"])[:500]
    response = obj.get("response") or {}
    usage = response.get("usageMetadata") or {}
    candidates = response.get("candidates") or []
    if not candidates:
        return key, None, usage, "no candidates"
    candidate = candidates[0]
    finish = candidate.get("finishReason")
    parts = (candidate.get("content") or {}).get("parts") or []
    text = "".join(p.get("text", "") for p in parts)
    if not text.strip():
        return key, None, usage, f"empty text (finishReason={finish})"
    try:
        return key, json.loads(text), usage, None
    except json.JSONDecodeError:
        return key, None, usage, f"non-JSON response (finishReason={finish})"


def validate_row(table: str, passage_id: str, parsed: dict
                 ) -> tuple[RowResult | None, str | None]:
    """Reject anything that is not a COMPLETE answer.

    This is the check that would have caught the silent field drop in the last
    run: a response missing `questions`, `function` or `speaker` is INVALID and
    is retried — it is never written as a partial row and never counted as done.
    An EMPTY questions list is valid; a MISSING questions field is not."""
    if not isinstance(parsed, dict):
        return None, "response is not an object"
    for required in ("speaker", "speaker_evidence", "eligible", "questions",
                     "function", "function_evidence"):
        if required not in parsed:
            return None, f"missing field '{required}'"
    speaker = parsed["speaker"]
    if speaker not in SPEAKERS:
        return None, f"speaker not in enum: {str(speaker)[:40]!r}"
    function = parsed["function"]
    if function not in FUNCTIONS:
        return None, f"function not in enum: {str(function)[:40]!r}"
    raw_questions = parsed["questions"]
    if not isinstance(raw_questions, list):
        return None, "questions is not a list"
    if len(raw_questions) > MAX_QUESTIONS:
        raw_questions = raw_questions[:MAX_QUESTIONS]
    questions: list[dict] = []
    for item in raw_questions:
        if not isinstance(item, dict):
            return None, "question item is not an object"
        q = (item.get("question") or "").strip()
        if not q:
            continue  # a blank question is dropped, not a reason to fail the row
        questions.append({"support_quote": (item.get("support_quote") or "").strip(),
                          "question": q})
    return RowResult(
        table=table, passage_id=passage_id, speaker=speaker,
        speaker_evidence=str(parsed.get("speaker_evidence") or "")[:4000],
        eligible=bool(parsed["eligible"]), questions=questions,
        function=function,
        function_evidence=str(parsed.get("function_evidence") or "")[:4000],
    ), None


def gate_shard(shard_key: str, table: str, model: str, path: Path) -> ShardOutcome:
    outcome = ShardOutcome(shard_key, table, model)
    seen: set[str] = set()
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            key, parsed, _usage, error = _parse_response_line(line)
            passage_id = (key or "|").split("|", 1)[-1]
            if not passage_id:
                continue
            seen.add(passage_id)
            if error or parsed is None:
                outcome.invalid.append((passage_id, error or "no parsed body"))
                continue
            row, reason = validate_row(table, passage_id, parsed)
            if row is None:
                outcome.invalid.append((passage_id, reason or "invalid"))
            else:
                outcome.applied.append(row)
    # A row the provider never answered at all is invalid too — never silently lost.
    planned = db.rows(
        "SELECT id_list::text[] FROM public.question_batch_jobs WHERE shard_key=%s",
        (shard_key,),
    )
    if planned:
        for pid in planned[0][0]:
            if pid not in seen:
                outcome.invalid.append((pid, "no response line for this row"))
    return outcome


def questions_text(questions: list[dict]) -> str:
    """The stored `questions` value: one question per line, matching the format
    already in the column (and what questions_fts is built from). An empty list
    stores an EMPTY STRING — non-null, so the STEP 3 assertion passes, and
    to_tsvector of it is simply empty."""
    return "\n".join(q["question"] for q in questions)


_PREWARMED: set[str] = set()


def prewarm_table_indexes(table: str) -> None:
    """Pull `table`'s vector indexes into shared_buffers before we start writing
    to it. Once per table per process.

    Writing `questions`/`passage_function`/`speaker` cannot be a HOT update
    (questions_fts is GIN-indexed), so EVERY row written is re-inserted into
    EVERY index on the table — including the HNSW vector index, even though we
    never touch the embedding. An HNSW insert walks the graph over thousands of
    random pages, so whether that graph is resident decides whether this run
    takes minutes or days. Measured on this project's DB during the
    fts_expansion backfill, same SQL, only cache state differing:
    1.69 s/row cold versus 14.9 ms/row prewarmed — 114x. With 244,148 rows to
    write here, that is the difference between ~30 minutes and weeks.

    Best-effort: a missing pg_prewarm extension or a permissions error only
    costs speed, never correctness, so it warns rather than failing the run."""
    if table in _PREWARMED:
        return
    _PREWARMED.add(table)
    try:
        indexes = db.rows(
            "SELECT i.indexname, pg_relation_size(i.indexname::regclass)"
            " FROM pg_indexes i"
            " WHERE i.tablename = %s"
            "   AND (i.indexdef ILIKE '%%hnsw%%' OR i.indexdef ILIKE '%%ivfflat%%')"
            " ORDER BY pg_relation_size(i.indexname::regclass) DESC",
            (table,),
        )
        if not indexes:
            return
        if not db.one("SELECT 1 FROM pg_extension WHERE extname = 'pg_prewarm'"):
            print(f"    note: pg_prewarm not installed — writes to {table} may be"
                  f" slow until the cache warms (CREATE EXTENSION pg_prewarm;)",
                  flush=True)
            return
        buffers = int(db.one("SELECT setting::bigint * 8192 FROM pg_settings"
                             " WHERE name = 'shared_buffers'") or 0)
        total = sum(int(s) for _n, s in indexes)
        if buffers and total > buffers:
            print(f"    ⚠ {table}: vector indexes total {total/2**20:,.0f} MB vs"
                  f" shared_buffers {buffers/2**20:,.0f} MB — writes will thrash."
                  f" Consider a larger instance for the duration of this run.",
                  flush=True)
        for name, size in indexes:
            db.one("SELECT pg_prewarm(%s, 'buffer')", (name,))
            print(f"    prewarmed {name} ({int(size)/2**20:,.0f} MB)", flush=True)
    except Exception as exc:  # noqa: BLE001 — speed-only optimisation
        print(f"    note: could not prewarm {table} ({exc}) — continuing", flush=True)


def apply_outcome(outcome: ShardOutcome, run_id: str, phase: str) -> int:
    """Write one shard's rows in a single transaction. UPDATE ... FROM (VALUES …)
    so 6,000 rows go in a handful of statements rather than 6,000 round-trips.

    Writes ONLY questions / passage_function / speaker / speaker_evidence.
    questions_fts is maintained by the table's existing trigger; STEP 4 rebuilds
    it explicitly as well."""
    if not outcome.applied:
        return 0
    prewarm_table_indexes(outcome.table)
    conn = db.get_pg()
    written = 0
    with conn.transaction():
        with conn.cursor() as cur:
            for i in range(0, len(outcome.applied), DB_WRITE_CHUNK):
                chunk = outcome.applied[i:i + DB_WRITE_CHUNK]
                values = [
                    (r.passage_id, questions_text(r.questions), r.function,
                     r.speaker, r.speaker_evidence)
                    for r in chunk
                ]
                placeholders = ",".join(["(%s::uuid,%s,%s,%s,%s)"] * len(values))
                cur.execute(
                    f"UPDATE public.{outcome.table} t"
                    f" SET questions = d.q, passage_function = d.fn,"
                    f"     speaker = d.sp, speaker_evidence = d.se"
                    f" FROM (VALUES {placeholders}) AS d(id, q, fn, sp, se)"
                    f" WHERE t.id = d.id",
                    [v for row in values for v in row],
                )
                written += cur.rowcount
            if phase == "pilot":
                for r in outcome.applied:
                    cur.execute(
                        "INSERT INTO public.question_evidence"
                        " (run_id, phase, table_name, passage_id, model, speaker,"
                        "  speaker_evidence, eligible, questions, passage_function,"
                        "  function_evidence)"
                        " VALUES (%s::uuid,%s,%s,%s::uuid,%s,%s,%s,%s,%s::jsonb,%s,%s)",
                        (run_id, phase, r.table, r.passage_id, outcome.model,
                         r.speaker, r.speaker_evidence, r.eligible,
                         json.dumps(r.questions, ensure_ascii=False),
                         r.function, r.function_evidence),
                    )
            cur.execute(
                "UPDATE public.question_batch_jobs SET status='applied',"
                " applied_rows=%s, invalid_rows=%s WHERE shard_key=%s",
                (written, len(outcome.invalid), outcome.shard_key),
            )
    return written


def usage_from_results_file(path: Path) -> tuple[int, int, int, int]:
    """(input, output, candidates, thoughts) summed over every line. Output =
    candidates + thoughts: THINKING TOKENS ARE BILLED AT THE OUTPUT RATE, so the
    ledger counts them or it undercounts the bill."""
    inp = cand = thought = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            _key, _parsed, usage, _err = _parse_response_line(line)
            inp += int(usage.get("promptTokenCount") or 0)
            cand += int(usage.get("candidatesTokenCount") or 0)
            thought += int(usage.get("thoughtsTokenCount") or 0)
    return inp, cand + thought, cand, thought


def collect(run_id: str, phase: str, block: bool = True) -> list[ShardOutcome]:
    """Poll this phase's in-flight shards, downloading + applying each as it
    finishes. Safe to Ctrl+C: state lives in the DB, `--resume` continues."""
    outcomes: list[ShardOutcome] = []
    while True:
        jobs = db.rows(
            "SELECT shard_key, table_name, model, provider_job_id, status"
            " FROM public.question_batch_jobs"
            " WHERE run_id = %s::uuid AND phase = %s"
            "   AND status IN ('submitted','running','retrieved')"
            " ORDER BY shard_key",
            (run_id, phase),
        )
        if not jobs:
            return outcomes
        progressed = False
        for shard_key, table, model, job_name, status in jobs:
            outcome, signal = _advance(shard_key, table, model, job_name, status,
                                       run_id, phase)
            if outcome is not None:
                outcomes.append(outcome)
            if signal in ("applied", "failed"):
                progressed = True
        if not block:
            return outcomes
        if not progressed:
            print(f"  waiting on {len(jobs)} shard(s) — polling every"
                  f" {BATCH_POLL_SECONDS}s (Ctrl+C is safe; --resume continues)",
                  flush=True)
            time.sleep(BATCH_POLL_SECONDS)


def _advance(shard_key, table, model, job_name, status, run_id, phase):
    path = shard_path(shard_key, "results")
    if status == "retrieved":
        outcome = gate_shard(shard_key, table, model, path)
        apply_outcome(outcome, run_id, phase)
        return outcome, "applied"
    if not job_name:
        return None, "waiting"
    job = db.with_retry(lambda: gemini_client.get_batch(job_name), f"poll {shard_key}")
    state = job["state"]
    if state == "BATCH_STATE_RUNNING" and status != "running":
        with db.get_pg().cursor() as cur:
            cur.execute("UPDATE public.question_batch_jobs SET status='running'"
                        " WHERE shard_key=%s", (shard_key,))
        return None, "running"
    if state == gemini_client.SUCCESS_STATE and job.get("output_file"):
        db.with_retry(lambda: gemini_client.download_file(job["output_file"], path),
                      f"download {shard_key}")
        inp, out, cand, thought = usage_from_results_file(path)
        with db.get_pg().cursor() as cur:
            cur.execute(
                "UPDATE public.question_batch_jobs SET status='retrieved',"
                " cost_input_tok=%s, cost_output_tok=%s, cost_candidate_tok=%s,"
                " cost_thought_tok=%s WHERE shard_key=%s",
                (inp, out, cand, thought, shard_key),
            )
        outcome = gate_shard(shard_key, table, model, path)
        applied = apply_outcome(outcome, run_id, phase)
        print(f"  applied {shard_key}: {applied:,} rows"
              f" ({len(outcome.invalid)} invalid)"
              f"  billed {inp/1e6:.2f}M in / {out/1e6:.2f}M out"
              f" (thinking {thought/1e6:.2f}M) = ${usd(model, inp, out):,.2f}",
              flush=True)
        return outcome, "applied"
    if state in gemini_client.TERMINAL_STATES:
        with db.get_pg().cursor() as cur:
            cur.execute("UPDATE public.question_batch_jobs SET status='failed',"
                        " error=%s WHERE shard_key=%s",
                        (f"batch ended {state}: {job.get('error')}", shard_key))
        print(f"  ✗ {shard_key} ended {state} — its rows re-plan on the next wave",
              flush=True)
        return None, "failed"
    return None, "waiting"


def replan_unresolved(run_id: str, phase: str) -> int:
    """Rows that failed or came back invalid get a fresh shard at the next
    attempt, same model. Bounded by MAX_ATTEMPTS so a systematically-unanswerable
    row is reported rather than retried forever."""
    done = db.rows(
        "SELECT max(attempt) FROM public.question_batch_jobs"
        " WHERE run_id=%s::uuid AND phase=%s", (run_id, phase))[0][0] or 1
    if done >= MAX_ATTEMPTS:
        return 0
    # Rows sitting in shards that were never submitted (the cost ceiling stopped
    # submission) are NOT unresolved — they are un-started. Re-planning them here
    # would create a second shard for the same row and pay for it twice, so we
    # refuse to re-plan at all while any shard of this phase is still unsent.
    unsent = int(db.one(
        "SELECT count(*) FROM public.question_batch_jobs"
        " WHERE run_id=%s::uuid AND phase=%s"
        "   AND status IN ('pending','submitted','running')",
        (run_id, phase),
    ))
    if unsent:
        print(f"  {unsent} shard(s) still unsent (cost ceiling?) — not re-planning;"
              f" rerun with --resume to submit them")
        return 0
    total = 0
    for table in TABLES:
        rows = db.rows(
            "SELECT DISTINCT u.id::text, j.model FROM public.question_batch_jobs j"
            " CROSS JOIN LATERAL unnest(j.id_list) AS u(id)"
            f" JOIN public.{table} t ON t.id = u.id"
            " WHERE j.run_id=%s::uuid AND j.phase=%s AND j.table_name=%s"
            "   AND j.status IN ('applied','failed')"
            "   AND (t.questions IS NULL OR t.passage_function IS NULL"
            "        OR t.speaker IS NULL)",
            (run_id, phase, table),
        )
        by_model: dict[str, list[str]] = {}
        for pid, model in rows:
            by_model.setdefault(model, []).append(pid)
        for model, ids in by_model.items():
            _insert_shards(run_id, phase, table, model, sorted(ids), attempt=done + 1)
            total += len(ids)
    if total:
        print(f"  re-planned {total:,} unresolved row(s) as attempt {done + 1}")
    return total


# ═══════════════════════════════════════════════════════════════════════════
# 9 — pilot metrics (STEP 2)
# ═══════════════════════════════════════════════════════════════════════════

def pilot_metrics(run_id: str) -> dict:
    """Everything STEP 2 must report, measured from what was ACTUALLY billed and
    what was ACTUALLY returned."""
    per_stratum = {}
    for table, model, rows_, inp, out, cand, thought in db.rows(
        "SELECT table_name, model, coalesce(sum(applied_rows),0),"
        "       coalesce(sum(cost_input_tok),0), coalesce(sum(cost_output_tok),0),"
        "       coalesce(sum(cost_candidate_tok),0), coalesce(sum(cost_thought_tok),0)"
        " FROM public.question_batch_jobs"
        " WHERE run_id=%s::uuid AND phase='pilot' AND status='applied'"
        " GROUP BY 1,2", (run_id,),
    ):
        per_stratum[(table, model)] = {
            "rows": int(rows_), "in": int(inp), "out": int(out),
            "candidates": int(cand), "thinking": int(thought),
        }

    per_model: dict[str, dict] = {}
    for (table, model), s in per_stratum.items():
        m = per_model.setdefault(model, {"rows": 0, "in": 0, "out": 0,
                                         "candidates": 0, "thinking": 0})
        for k in ("rows", "in", "out", "candidates", "thinking"):
            m[k] += s[k]
    for model, m in per_model.items():
        rows_ = m["rows"] or 1
        m["in_per_row"] = m["in"] / rows_
        m["out_per_row"] = m["out"] / rows_
        m["thinking_per_row"] = m["thinking"] / rows_
        m["candidates_per_row"] = m["candidates"] / rows_
        m["usd"] = usd(model, m["in"], m["out"])
        m["usd_per_row"] = m["usd"] / rows_

    # Extrapolate STRATUM-WISE: input length varies hugely by table (a transcript
    # paragraph vs a full purport), so scaling one blended per-model average over
    # a differently-shaped population would misestimate the bill. Each stratum is
    # scaled by its own live population.
    populations = route_counts()
    extrapolated = 0.0
    per_model_extrapolated: dict[str, float] = {}
    uncovered: list[tuple[str, str]] = []
    for key, pop in populations.items():
        s = per_stratum.get(key)
        if not s or not s["rows"]:
            uncovered.append(key)
            continue
        table, model = key
        scale = pop / s["rows"]
        cost = usd(model, s["in"] * scale, s["out"] * scale)
        extrapolated += cost
        per_model_extrapolated[model] = per_model_extrapolated.get(model, 0.0) + cost

    quality = pilot_quality(run_id)
    return {
        "per_stratum": per_stratum, "per_model": per_model,
        "extrapolated_usd": extrapolated,
        "per_model_extrapolated": per_model_extrapolated,
        "uncovered_strata": uncovered, "populations": populations,
        **quality,
    }


def pilot_quality(run_id: str) -> dict:
    """Zero-question rate by table, mean questions/row, meta-reference rate,
    support_quote-exactness, and the speaker/function distributions — computed
    from question_evidence (the model's own output) joined back to the passage
    text, so the substring check is against what was actually sent."""
    rows = db.rows(
        "SELECT table_name, passage_id::text, questions, speaker, passage_function"
        " FROM public.question_evidence WHERE run_id = %s::uuid AND phase='pilot'",
        (run_id,),
    )
    by_table: dict[str, dict] = {}
    speakers: dict[str, int] = {}
    functions: dict[str, int] = {}
    total_questions = 0
    total_rows = len(rows)
    meta_hits = 0
    ids_by_table: dict[str, list[str]] = {}
    payload: dict[tuple[str, str], list[dict]] = {}

    for table, pid, questions, speaker, function in rows:
        qs = questions or []
        stat = by_table.setdefault(table, {"rows": 0, "zero": 0, "questions": 0})
        stat["rows"] += 1
        stat["questions"] += len(qs)
        if not qs:
            stat["zero"] += 1
        total_questions += len(qs)
        speakers[speaker] = speakers.get(speaker, 0) + 1
        functions[function] = functions.get(function, 0) + 1
        for q in qs:
            if META_RE.search(q.get("question") or ""):
                meta_hits += 1
        ids_by_table.setdefault(table, []).append(pid)
        payload[(table, pid)] = qs

    # support_quote must be an exact substring of the passage text that was sent.
    quote_total = quote_missing = 0
    for table, ids in ids_by_table.items():
        for passage in load_passages(table, ids):
            haystack = passage.text
            for q in payload.get((table, passage.id), []):
                quote = (q.get("support_quote") or "").strip()
                quote_total += 1
                if not quote or quote not in haystack:
                    quote_missing += 1

    return {
        "rows_scored": total_rows,
        "by_table": by_table,
        "mean_questions_per_row": (total_questions / total_rows) if total_rows else 0.0,
        "total_questions": total_questions,
        "meta_reference_rate": (meta_hits / total_questions) if total_questions else 0.0,
        "meta_reference_hits": meta_hits,
        "quote_mismatch_rate": (quote_missing / quote_total) if quote_total else 0.0,
        "quote_mismatch_hits": quote_missing,
        "quote_total": quote_total,
        "speaker_distribution": dict(sorted(speakers.items(), key=lambda kv: -kv[1])),
        "function_distribution": dict(sorted(functions.items(), key=lambda kv: -kv[1])),
    }


def _pct(x: float) -> str:
    return f"{x*100:.2f}%"


def render_pilot_report(m: dict) -> str:
    lines = ["# Questions pilot — billing + quality", ""]
    lines.append(f"Rows scored: **{m['rows_scored']:,}**  ·  seed `{SAMPLE_SEED}`  ·"
                 f"  prompt `{PROMPT_VERSION}`")
    lines.append("")
    lines.append("## Billed tokens per row (ACTUAL)")
    lines.append("")
    lines.append("| model | rows | in/row | out/row | of which thinking | $/row | pilot $ |")
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for model, s in sorted(m["per_model"].items()):
        lines.append(
            f"| `{model}` | {s['rows']:,} | {s['in_per_row']:,.0f} |"
            f" {s['out_per_row']:,.0f} | {s['thinking_per_row']:,.0f} |"
            f" ${s['usd_per_row']:.5f} | ${s['usd']:,.2f} |")
    lines.append("")
    lines.append("## Extrapolated full-run cost (stratum-wise)")
    lines.append("")
    lines.append("| model | full-run rows | extrapolated $ |")
    lines.append("|---|---:|---:|")
    for model, cost in sorted(m["per_model_extrapolated"].items()):
        pop = sum(n for (_t, mm), n in m["populations"].items() if mm == model)
        lines.append(f"| `{model}` | {pop:,} | ${cost:,.2f} |")
    lines.append(f"| **total** | **{sum(m['populations'].values()):,}** |"
                 f" **${m['extrapolated_usd']:,.2f}** |")
    lines.append("")
    lines.append(f"Auto-continue threshold: **${PILOT_AUTO_CONTINUE_USD:,.2f}** — "
                 + ("**PASS**, continuing to the full run."
                    if m["extrapolated_usd"] <= PILOT_AUTO_CONTINUE_USD
                    else "**STOP**, exceeds the threshold."))
    lines.append("")
    lines.append("## Quality")
    lines.append("")
    lines.append("| table | rows | zero-question | mean q/row |")
    lines.append("|---|---:|---:|---:|")
    for table, s in sorted(m["by_table"].items()):
        lines.append(f"| {table} | {s['rows']:,} |"
                     f" {_pct(s['zero']/s['rows'] if s['rows'] else 0)} |"
                     f" {s['questions']/s['rows'] if s['rows'] else 0:.2f} |")
    lines.append("")
    lines.append(f"- mean questions per row: **{m['mean_questions_per_row']:.2f}**"
                 f" ({m['total_questions']:,} questions)")
    lines.append(f"- meta-reference rate: **{_pct(m['meta_reference_rate'])}**"
                 f" ({m['meta_reference_hits']:,}) — gate < 1%"
                 f" {'PASS' if m['meta_reference_rate'] < PILOT_MAX_META_REFERENCE else 'FAIL'}")
    lines.append(f"- support_quote not an exact substring: **{_pct(m['quote_mismatch_rate'])}**"
                 f" ({m['quote_mismatch_hits']:,}/{m['quote_total']:,}) — gate < 1%"
                 f" {'PASS' if m['quote_mismatch_rate'] < PILOT_MAX_QUOTE_MISMATCH else 'FAIL'}")
    lines.append("")
    lines.append("### speaker distribution")
    lines.append("")
    for k, v in m["speaker_distribution"].items():
        lines.append(f"- `{k}`: {v:,} ({_pct(v/max(1, m['rows_scored']))})")
    lines.append("")
    lines.append("### function distribution")
    lines.append("")
    for k, v in m["function_distribution"].items():
        lines.append(f"- `{k}`: {v:,} ({_pct(v/max(1, m['rows_scored']))})")
    lines.append("")
    if m["uncovered_strata"]:
        lines.append("> ⚠ strata with no pilot coverage (extrapolation excludes them): "
                     + ", ".join(f"{t}/{mm}" for t, mm in m["uncovered_strata"]))
        lines.append("")
    return "\n".join(lines)


def print_pilot_summary(m: dict) -> None:
    print(render_pilot_report(m))


# ═══════════════════════════════════════════════════════════════════════════
# 10 — STEP 3 assertions + STEP 4 questions_fts
# ═══════════════════════════════════════════════════════════════════════════

def column_counts() -> dict[str, dict]:
    out = {}
    for table in TABLES:
        row = db.rows(
            f"SELECT count(*), count(questions), count(passage_function),"
            f"       count(speaker), count(speaker_evidence),"
            f"       count(*) FILTER (WHERE questions_fts IS NOT NULL"
            f"                        AND length(questions_fts::text) > 2)"
            f" FROM public.{table}"
        )[0]
        out[table] = {
            "total": int(row[0]), "questions": int(row[1]),
            "passage_function": int(row[2]), "speaker": int(row[3]),
            "speaker_evidence": int(row[4]), "questions_fts": int(row[5]),
        }
    return out


def print_counts(title: str, counts: dict[str, dict]) -> None:
    print(f"\n  {title}")
    print(f"  {'table':<24} {'rows':>9} {'questions':>10} {'function':>9}"
          f" {'speaker':>9} {'q_fts':>9}")
    print(f"  {'-'*24} {'-'*9} {'-'*10} {'-'*9} {'-'*9} {'-'*9}")
    for table, c in counts.items():
        print(f"  {table:<24} {c['total']:>9,} {c['questions']:>10,}"
              f" {c['passage_function']:>9,} {c['speaker']:>9,}"
              f" {c['questions_fts']:>9,}")
    t = {k: sum(c[k] for c in counts.values())
         for k in ("total", "questions", "passage_function", "speaker", "questions_fts")}
    print(f"  {'TOTAL':<24} {t['total']:>9,} {t['questions']:>10,}"
          f" {t['passage_function']:>9,} {t['speaker']:>9,} {t['questions_fts']:>9,}")
    print()


def assert_full_coverage(counts: dict[str, dict]) -> list[str]:
    """The hard assertions the brief demands. Returns the list of failures —
    the caller fails loudly. This is the check that would have caught the silent
    field drop in the last run."""
    problems = []
    total = sum(c["total"] for c in counts.values())
    if total != EXPECTED_TOTAL:
        problems.append(f"corpus has {total:,} rows, expected {EXPECTED_TOTAL:,}")
    for table, c in counts.items():
        if c["questions"] != c["total"]:
            problems.append(
                f"{table}: {c['total'] - c['questions']:,} row(s) have NULL questions"
                f" ({c['questions']:,}/{c['total']:,})")
        if c["passage_function"] != c["total"]:
            problems.append(
                f"{table}: {c['total'] - c['passage_function']:,} row(s) have NULL"
                f" passage_function ({c['passage_function']:,}/{c['total']:,})")
        if c["speaker"] != c["total"]:
            problems.append(
                f"{table}: {c['total'] - c['speaker']:,} row(s) have NULL speaker"
                f" ({c['speaker']:,}/{c['total']:,})")
    return problems


def build_questions_fts(batch: int = 5000) -> None:
    """STEP 4. The content tables already carry a trigger that recomputes
    questions_fts from questions on every write, so this is normally a no-op
    re-assertion — but it is cheap, idempotent, and it guarantees the column is
    correct even for rows written before the trigger existed. Batched and
    committed per batch; the GIN indexes already exist and are NOT recreated."""
    print("\n  STEP 4 — building questions_fts")
    conn = db.get_pg()
    for table in TABLES:
        prewarm_table_indexes(table)
        written = 0
        rounds = 0
        while True:
            with conn.cursor() as cur:
                cur.execute(
                    f"WITH tgt AS ("
                    f"  SELECT id FROM public.{table}"
                    f"  WHERE questions IS NOT NULL"
                    f"    AND questions_fts IS DISTINCT FROM"
                    f"        to_tsvector('english_unaccent', coalesce(questions,''))"
                    f"  LIMIT %s)"
                    f" UPDATE public.{table} t"
                    f" SET questions_fts ="
                    f"     to_tsvector('english_unaccent', coalesce(t.questions,''))"
                    f" FROM tgt WHERE tgt.id = t.id",
                    (batch,),
                )
                n = cur.rowcount
            if not n:
                break
            written += n
            rounds += 1
            print(f"    {table}: +{n:,} ({written:,} total)", flush=True)
        print(f"  ✓ {table}: questions_fts current ({written:,} rewritten"
              f" in {rounds} batches)", flush=True)
    for table in TABLES:
        with conn.cursor() as cur:
            cur.execute(f"ANALYZE public.{table}")
        print(f"  ✓ ANALYZE {table}", flush=True)


# ═══════════════════════════════════════════════════════════════════════════
# 11 — final report
# ═══════════════════════════════════════════════════════════════════════════

def final_report(run_id: str, counts_before: dict, counts_after: dict,
                 problems: list[str]) -> str:
    ledger = spend_ledger()
    lines = ["# Questions + passage_function — final report", ""]
    lines.append(f"Run `{run_id}` · prompt `{PROMPT_VERSION}`")
    lines.append("")

    lines.append("## Rows done per table (before → after)")
    lines.append("")
    lines.append("| table | rows | questions | passage_function | speaker | questions_fts |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    for table, c in counts_after.items():
        b = counts_before.get(table, {})
        lines.append(
            f"| {table} | {c['total']:,} |"
            f" {b.get('questions', 0):,} → {c['questions']:,} |"
            f" {b.get('passage_function', 0):,} → {c['passage_function']:,} |"
            f" {b.get('speaker', 0):,} → {c['speaker']:,} |"
            f" {b.get('questions_fts', 0):,} → {c['questions_fts']:,} |")
    t = {k: sum(c[k] for c in counts_after.values())
         for k in ("total", "questions", "passage_function", "speaker", "questions_fts")}
    lines.append(f"| **TOTAL** | **{t['total']:,}** | **{t['questions']:,}** |"
                 f" **{t['passage_function']:,}** | **{t['speaker']:,}** |"
                 f" **{t['questions_fts']:,}** |")
    lines.append("")

    lines.append("## Real cost per model")
    lines.append("")
    lines.append("| model | rows | billed in | billed out | of which thinking | $ |")
    lines.append("|---|---:|---:|---:|---:|---:|")
    grand = 0.0
    for model, rows_, inp, out, thought in db.rows(
        "SELECT model, coalesce(sum(applied_rows),0), coalesce(sum(cost_input_tok),0),"
        "       coalesce(sum(cost_output_tok),0), coalesce(sum(cost_thought_tok),0)"
        " FROM public.question_batch_jobs WHERE run_id=%s::uuid GROUP BY 1 ORDER BY 1",
        (run_id,),
    ):
        cost = usd(model, float(inp), float(out))
        grand += cost
        lines.append(f"| `{model}` | {int(rows_):,} | {int(inp)/1e6:.2f}M |"
                     f" {int(out)/1e6:.2f}M | {int(thought)/1e6:.2f}M | ${cost:,.2f} |")
    lines.append(f"| **total** | | | | | **${grand:,.2f}** |")
    lines.append("")
    lines.append(f"Ledger: real ${ledger['real_usd']:,.2f} ·"
                 f" in-flight est ${ledger['in_flight_est_usd']:,.2f} ·"
                 f" ceiling ${MAX_SPEND_USD:,.2f}")
    lines.append("")

    zero_rows = 0
    lines.append("## Zero-question rate")
    lines.append("")
    lines.append("| table | rows | zero questions | rate |")
    lines.append("|---|---:|---:|---:|")
    for table in TABLES:
        total, zero = db.rows(
            f"SELECT count(*), count(*) FILTER (WHERE questions = '')"
            f" FROM public.{table} WHERE questions IS NOT NULL"
        )[0]
        zero_rows += int(zero)
        lines.append(f"| {table} | {int(total):,} | {int(zero):,} |"
                     f" {_pct(int(zero)/int(total) if total else 0)} |")
    lines.append("")

    for column, title in (("speaker", "Speaker distribution"),
                          ("passage_function", "Function distribution")):
        lines.append(f"## {title}")
        lines.append("")
        union = " UNION ALL ".join(
            f"SELECT {column} AS v FROM public.{t} WHERE {column} IS NOT NULL"
            for t in TABLES)
        for value, n in db.rows(
            f"SELECT v, count(*) FROM ({union}) x GROUP BY 1 ORDER BY 2 DESC"
        ):
            lines.append(f"- `{value}`: {int(n):,}")
        lines.append("")

    truncated = db.one(
        "SELECT coalesce(sum(truncated_rows),0) FROM public.question_batch_jobs"
        " WHERE run_id=%s::uuid", (run_id,))
    lines.append("## Anything that failed")
    lines.append("")
    lines.append(f"- passages truncated at {PASSAGE_CHAR_CAP:,} chars: **{int(truncated):,}**")
    failed = db.rows(
        "SELECT shard_key, error FROM public.question_batch_jobs"
        " WHERE run_id=%s::uuid AND status='failed'", (run_id,))
    lines.append(f"- failed shards: **{len(failed)}**")
    for key, err in failed[:20]:
        lines.append(f"  - `{key}`: {str(err)[:200]}")
    invalid = db.one(
        "SELECT coalesce(sum(invalid_rows),0) FROM public.question_batch_jobs"
        " WHERE run_id=%s::uuid", (run_id,))
    lines.append(f"- rows rejected by the validator (retried): **{int(invalid):,}**")
    if problems:
        lines.append("")
        lines.append("### ❌ ASSERTION FAILURES")
        for p in problems:
            lines.append(f"- {p}")
    else:
        lines.append("- ✓ all STEP 3 assertions passed")
    lines.append("")
    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════════════════
# 12 — phases + CLI
# ═══════════════════════════════════════════════════════════════════════════

def run_phase(run_id: str, phase: str) -> None:
    """Submit → collect → retry unresolved, until the phase has nothing left."""
    for _wave in range(MAX_ATTEMPTS):
        reconcile(run_id)
        submit_pending(run_id, phase,
                       collect_fn=lambda: len(collect(run_id, phase, block=False)))
        collect(run_id, phase, block=True)
        if not replan_unresolved(run_id, phase):
            return


def do_pilot(run_id: str, strata: dict) -> dict:
    print("\n══ STEP 2 — billing pilot ══")
    plan_pilot(run_id, strata)
    run_phase(run_id, "pilot")
    metrics = pilot_metrics(run_id)
    PILOT_REPORT_PATH.write_text(render_pilot_report(metrics), encoding="utf-8")
    print_pilot_summary(metrics)
    print(f"  pilot report written to {PILOT_REPORT_PATH}")
    return metrics


def pilot_gate(metrics: dict) -> bool:
    """AUTO-CONTINUE when the extrapolated full-run cost is within threshold."""
    cost = metrics["extrapolated_usd"]
    if cost > PILOT_AUTO_CONTINUE_USD:
        print(f"\n  ⛔ STOP — extrapolated full-run cost ${cost:,.2f} exceeds"
              f" ${PILOT_AUTO_CONTINUE_USD:,.2f}. Not continuing automatically."
              f"\n  Review {PILOT_REPORT_PATH}, then rerun with --full to proceed"
              f" anyway.")
        return False
    print(f"\n  ✓ extrapolated full-run cost ${cost:,.2f} ≤"
          f" ${PILOT_AUTO_CONTINUE_USD:,.2f} — continuing automatically.")
    return True


def do_full(run_id: str, strata: dict) -> None:
    print("\n══ STEP 3 — full run ══")
    assert_routing_totals(strata)
    plan_full(run_id, strata)
    run_phase(run_id, "full")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--resume", action="store_true",
                        help="continue the open run (submit/collect where it stopped)")
    parser.add_argument("--pilot-only", action="store_true",
                        help="run the pilot and stop after its report")
    parser.add_argument("--full", action="store_true",
                        help="skip the pilot gate and run the full corpus")
    parser.add_argument("--fts", action="store_true",
                        help="STEP 4 only: rebuild questions_fts + ANALYZE")
    parser.add_argument("--verify", action="store_true",
                        help="assertions + report only; no API calls, no writes")
    args = parser.parse_args()

    # Only what each path actually needs: the verify/fts paths make no API calls,
    # so a missing Gemini key must not block them.
    require("DATABASE_URL")
    if not (args.verify or args.fts):
        require("GEMINI_API_KEY")
    ensure_schema()

    if args.verify:
        counts = column_counts()
        print_counts("current state", counts)
        problems = assert_full_coverage(counts)
        for p in problems:
            print(f"  ❌ {p}")
        print("  ✓ all assertions passed" if not problems else
              f"  ❌ {len(problems)} assertion failure(s)")
        return 1 if problems else 0

    if args.fts:
        build_questions_fts()
        print_counts("after STEP 4", column_counts())
        return 0

    print(f"\n  models: core={MODEL_36}  standard={MODEL_3}")
    print(f"  prices/1M: {MODEL_36} {PRICES[MODEL_36]}  ·  {MODEL_3} {PRICES[MODEL_3]}")
    print(f"  ceiling: ${MAX_SPEND_USD:,.2f}")
    for model in (MODEL_36, MODEL_3):
        confirmed = gemini_client.confirm_model(model)
        print(f"  ✓ confirmed model {confirmed}")

    run_id = open_run()
    strata = route_counts()
    assert_routing_totals(strata)
    counts_before = column_counts()
    print_counts("before", counts_before)
    preflight_estimate(strata)

    if not args.full:
        metrics = do_pilot(run_id, strata)
        if args.pilot_only:
            return 0
        if not pilot_gate(metrics):
            return 2

    do_full(run_id, strata)
    build_questions_fts()

    counts_after = column_counts()
    print_counts("after", counts_after)
    problems = assert_full_coverage(counts_after)
    report = final_report(run_id, counts_before, counts_after, problems)
    REPORT_PATH.write_text(report, encoding="utf-8")
    print(report)
    print(f"  report written to {REPORT_PATH}")

    if problems:
        finish_run(run_id, f"FAILED assertions: {len(problems)}")
        raise SystemExit(
            "FATAL: STEP 3 assertions FAILED —\n    " + "\n    ".join(problems)
            + "\n  The run is NOT complete. Rerun with --resume to fill the gaps."
        )
    finish_run(run_id, "complete")
    print("  ✓ all assertions passed — questions, passage_function, speaker and"
          " questions_fts are complete.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
