"""
config.py — shared configuration + credential loading for the Tags & FTS Rebuild
offline batch harness (v2).

Single source of truth for keys, model strings, paths, and tuning constants.
Credentials come from `scripts/tags-rebuild/.env` (git-ignored; copy `.env.example`)
with the process environment taking precedence. NEVER prints secret values.

Loud-failure policy: importing this module never raises, so `run_all.py --doctor`
can diagnose a broken setup. Everything that DOES work calls `require_keys()`
first — there is no anon-key fallback and no silent degradation: the harness
requires the SERVICE key and a direct Postgres DSN (Supabase **Session Pooler**)
or it refuses to start.
"""
from __future__ import annotations

import os
from pathlib import Path

HARNESS_DIR = Path(__file__).resolve().parent
REPO_ROOT = HARNESS_DIR.parents[1]

# The one env file this harness reads (git-ignored). Process env wins over it.
ENV_FILE = HARNESS_DIR / ".env"
try:
    from dotenv import load_dotenv

    load_dotenv(ENV_FILE, override=False)
except Exception:
    pass  # dotenv is in requirements.txt; without it only the process env is used


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _env_int(name: str, default: int) -> int:
    try:
        return int(_env(name) or default)
    except ValueError:
        return default


def _env_float(name: str, default: float) -> float:
    try:
        return float(_env(name) or default)
    except ValueError:
        return default


# ── Supabase ────────────────────────────────────────────────────────────────
SUPABASE_URL = _env("SUPABASE_URL") or _env("NEXT_PUBLIC_SUPABASE_URL")
SUPABASE_SERVICE_KEY = _env("SUPABASE_SERVICE_KEY")  # service role ONLY — no anon fallback
# Direct Postgres DSN — the Supabase **Session Pooler** string
# (aws-*.pooler.supabase.com:5432). Required: bulk backfills, vector reads and
# CREATE INDEX CONCURRENTLY all need a real long-lived SQL connection.
DATABASE_URL = _env("DATABASE_URL")
PROJECT_ID = "wzktlpjtqmjxvragwhqg"

# ── AI providers ────────────────────────────────────────────────────────────
GEMINI_API_KEY = _env("GEMINI_API_KEY")
VOYAGE_API_KEY = _env("VOYAGE_API_KEY")

# Tagging + questions models (v3.p3-hybrid): TWO routed models, one pipeline.
#   core     — verses + verse_chunks of Bhagavad-gītā / Śrīmad-Bhāgavatam /
#              Caitanya-caritāmṛta (routing.py) → FULL Gemini 3.5 Flash.
#   standard — every other eligible passage → Gemini 3 Flash (preview), 3× cheaper.
# Never a -lite variant on either route. Both exact strings are confirmed against
# the live models list (gemini_client.confirm_model) before any paid run and by
# --doctor. The old GEMINI_MODEL env var survives as a deprecated alias for
# MODEL_CORE only. Model strings may not contain ':' or '_' — they are embedded
# in shard keys whose ':' → '_' filename mapping must stay collision-free
# (checked by confirm_model and --doctor, never at import: importing config must
# not raise).
MODEL_CORE = _env("MODEL_CORE") or _env("GEMINI_MODEL") or "gemini-3.5-flash"
MODEL_STANDARD = _env("MODEL_STANDARD") or "gemini-3-flash-preview"
ROUTED_MODELS = list(dict.fromkeys([MODEL_CORE, MODEL_STANDARD]))


def invalid_model_strings() -> list[str]:
    """Routed model strings that would break the shard-key ↔ filename mapping."""
    return [m for m in ROUTED_MODELS if (":" in m or "_" in m or not m)]
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta"
GEMINI_DOWNLOAD_BASE = "https://generativelanguage.googleapis.com/download/v1beta"
VOYAGE_MODEL = "voyage-context-4"  # 1024-dim, matches the stored embedding_context4
VOYAGE_URL = "https://api.voyageai.com/v1/contextualizedembeddings"

# ── Cost ceiling (machine-enforced) ─────────────────────────────────────────
# The submitter refuses to submit a shard once (real spend so far + estimates
# for in-flight work + the new shard's estimate) would exceed this. Set it in
# .env — 325 is the v3.p3-hybrid default. No approval flow can raise it at runtime.
MAX_SPEND_USD = _env_float("MAX_SPEND_USD", 325.0)
# Gemini Batch pricing per 1M tokens (batch = 50% of interactive), PER MODEL
# (v3.p3-hybrid). The CANONICAL map below is the current Batch price sheet for
# both routed models, pinned in code and shipped as the defaults — `--doctor`
# FAILS (not warns) if any ROUTED model has no pinned price, a price ≤ 0, a
# known-stale pair, or an effective price that differs from the canonical map.
# `.env` may still override per model (suffixed vars, see batch_prices), but the
# canonical map must then be updated in lock-step so the doctor passes.
GEMINI_BATCH_PRICES_CANONICAL: dict[str, tuple[float, float]] = {
    "gemini-3.5-flash": (0.75, 4.50),        # $/1M in · $/1M out (candidates + thinking)
    "gemini-3-flash-preview": (0.25, 1.50),
}
# Known-stale pairs PER MODEL that must ALWAYS fail the doctor even if re-pinned
# by accident. (0.15/1.25 was the v3.p1 placeholder — undercounted 5-6x.)
STALE_BATCH_PRICE_PAIRS: dict[str, set[tuple[float, float]]] = {
    "gemini-3.5-flash": {(0.15, 1.25)},
    "gemini-3-flash-preview": set(),
}


def _price_env_suffix(model: str) -> str:
    """'gemini-3-flash-preview' → 'GEMINI_3_FLASH_PREVIEW' (per-model env vars)."""
    return "".join(ch if ch.isalnum() else "_" for ch in model.upper())


def batch_prices(model: str) -> tuple[float, float] | None:
    """Effective ($/1M in, $/1M out) Batch prices for `model`.

    Resolution per component: the model-suffixed env override
    (GEMINI_BATCH_PRICE_IN_PER_M__<MODEL>, _OUT_), then — for gemini-3.5-flash
    ONLY — the legacy un-suffixed GEMINI_BATCH_PRICE_IN_PER_M/_OUT_PER_M vars,
    then the canonical code pin. Returns None when the model has no pinned
    price at all: the doctor FAILS on that and the submitter refuses to plan
    shards for it — an unpriced model can never spend money."""
    suffix = _price_env_suffix(model)
    canon = GEMINI_BATCH_PRICES_CANONICAL.get(model)

    def component(kind: str, canonical: float | None) -> float | None:
        for name in ([f"GEMINI_BATCH_PRICE_{kind}_PER_M__{suffix}"]
                     + ([f"GEMINI_BATCH_PRICE_{kind}_PER_M"] if model == "gemini-3.5-flash" else [])):
            raw = _env(name)
            if raw:
                try:
                    return float(raw)
                except ValueError:
                    return canonical
        return canonical

    pin = component("IN", canon[0] if canon else None)
    pout = component("OUT", canon[1] if canon else None)
    if pin is None or pout is None:
        return None
    return (pin, pout)


GEMINI_BATCH_PRICES: dict[str, tuple[float, float]] = {
    m: p for m in ROUTED_MODELS if (p := batch_prices(m)) is not None
}
# Pre-pilot output estimate per passage (tokens). After the pilot the measured
# average from usageMetadata (candidates + thinking) replaces this for
# extrapolation + ceiling checks — per model in v3.p3, so the cheap standard
# model's estimates are never inflated by 3.5 Flash history (or vice versa).
EST_OUTPUT_TOKENS_PER_PASSAGE = _env_int("EST_OUTPUT_TOKENS_PER_PASSAGE", 500)
# Gemini thinking + output-cap knobs. thinkingLevel LOW is a NON-OVERRIDABLE
# constant (v3.p3): gemini-3-flash-preview defaults to HIGH thinking, so every
# request for BOTH models must carry the explicit LOW override — there is no env
# knob to accidentally drop it. MAX_OUTPUT_TOKENS is a SAFETY CEILING only (not
# a target). temperature is intentionally NOT sent — the model default is used.
THINKING_LEVEL = "LOW"
MAX_OUTPUT_TOKENS = _env_int("MAX_OUTPUT_TOKENS", 8192)

# ── Corpus ──────────────────────────────────────────────────────────────────
CONTENT_TABLES = [
    "verses",
    "verse_chunks",
    "prose_paragraphs",
    "transcript_paragraphs",
    "letter_paragraphs",
]
# Tables sent to Gemini. v3.p2: verse_chunks are now tagged DIRECTLY (target
# chunk + parent-verse translation + adjacent-chunk context; evidence must come
# from the target chunk). The old parent→chunk inheritance step is removed.
GEMINI_TABLES = ["verses", "verse_chunks", "prose_paragraphs", "transcript_paragraphs", "letter_paragraphs"]
# Estimates only (2026-07-08 snapshot) — every decision that matters queries
# live counts; these exist for progress displays before the first DB round-trip.
ESTIMATED_ROW_COUNTS = {
    "verses": 25131,
    "verse_chunks": 18699,
    "prose_paragraphs": 36412,
    "transcript_paragraphs": 144438,
    "letter_paragraphs": 19468,
}

# ── Tagging run ─────────────────────────────────────────────────────────────
PROMPT_VERSION = "asp-tags-v4-tiered"  # bump whenever the prompt/schema/routing changes
BATCH_DISPLAY_PREFIX = "asp-tags-v4"  # Google Batch display_name prefix → reconciliation

# ── v4-tiered: three-tier classifier (REPLACES the generative approach) ──────
# The v4 pipeline is PURE CLASSIFICATION over the frozen 251-term vocabulary:
#   Tier 1 — exact aliases (Person/Place/Scripture)   → free, no LLM
#   Tier 2 — embedding shortlist (Concept/Practice)    → free, no LLM
#   Tier 3 — LLM judge over the Tier-2 middle band     → the ONLY paid part
# Questions + passage_function are DEFERRED (their columns stay; nothing is
# generated now). PURE_CLASSIFICATION also collapses the core/standard BOOK
# routing: every row is judged on TIER3_MODEL first and escalates once to
# TIER3_ESCALATION_MODEL — there is no book-based model choice any more.
PURE_CLASSIFICATION = (_env("PURE_CLASSIFICATION", "1") not in ("0", "false", "no"))
# Facet → tier. Person/Place/Scripture are matched by exact alias (Tier 1);
# Concept/Practice by embedding similarity + LLM judge (Tiers 2-3). (Kept in sync
# with ENTITY_FACETS below — asserted in tests.)
TIER1_FACETS = {"Person", "Place", "Scripture"}
TIER2_FACETS = {"Concept", "Practice"}
# Tier 2 shortlist depth: the top-K nearest Concept/Practice terms per passage —
# the candidate pool the bands (and the Tier-3 middle band) are drawn from. This
# is the ACTIVE width; the pilot keeps the default 12 (the width the judge
# mechanism was validated on) and the full run widens it to TIER2_SHORTLIST_K_FULL
# (run_all.run_full sets TIER2_SHORTLIST_K = TIER2_SHORTLIST_K_FULL before it
# recalibrates the thresholds, so calibration + free tiers + the Tier-3 middle
# band all agree on the same width). Measured shortlist recall ceiling on the live
# DB: k=12 → 0.719, k=20 → 0.823 — width only adds candidates; the row-level gates
# stay active. (Legacy env alias TIER2_TOPK still read for back-compat.)
TIER2_SHORTLIST_K = _env_int("TIER2_SHORTLIST_K", _env_int("TIER2_TOPK", 12))
# The width the FULL corpus run uses (wider than the pilot: more candidates reach
# the judge). run_full switches TIER2_SHORTLIST_K to this and recalibrates
# T_reject against the k=TIER2_SHORTLIST_K_FULL shortlist (same sweep, same
# targets) at full-run start.
TIER2_SHORTLIST_K_FULL = _env_int("TIER2_SHORTLIST_K_FULL", 20)
# v4-tiered.2 candidate shortlist — the Tier-3 candidate list is the UNION of
# three lanes, deduped and capped at TIER3_CANDIDATE_CAP:
#   • top-TIER2_SHORTLIST_K Concept/Practice terms by LABEL embedding similarity;
#   • top-TIER2_SHORTLIST_K by MAX-EXEMPLAR similarity — exemplars are up to
#     TIER3_EXEMPLARS_PER_TERM p1-accepted passage embeddings per term (run
#     P1_PILOT_RUN_ID), so a term is reachable when a passage looks like the
#     passages that term was actually applied to, not only like its label;
#   • every C/P term whose label/variant LITERALLY appears in the passage
#     (word-boundary, diacritic-insensitive — the same fold Tier 1 uses),
#     regardless of embedding rank.
# Lexical hits are ALWAYS kept (they bypass both the top-K cutoff and the
# T_reject filter). Everything else with label similarity ≥ T_reject is judged;
# below T_reject is dropped. There is NO auto-accept band any more (v4-tiered.2:
# it measured 0.800 precision on only 92 tags — below our bar) — Tier 2 is now
# purely shortlist construction + the reject filter, and EVERYTHING above
# T_reject goes to the Tier-3 judge.
TIER3_CANDIDATE_CAP = _env_int("TIER3_CANDIDATE_CAP", 25)
TIER3_EXEMPLARS_PER_TERM = _env_int("TIER3_EXEMPLARS_PER_TERM", 5)
# K used for the calibration recall-ceiling comparison (union vs label-only).
TIER3_RECALL_CEILING_K = _env_int("TIER3_RECALL_CEILING_K", 20)
# Tier-2 reject threshold (cosine similarity, embedding_context4 ↔ vocab_terms).
# DEFAULT is the value calibrated against the p1 pilot (run 63c99428…); a live
# calibration pass recomputes it from tag_evidence and records the result in
# tag_runs.config + pilot-report.md. Below REJECT → drop; ≥ REJECT (or a lexical
# hit) → the Tier-3 judge.
# TIER2_ACCEPT is RETAINED as a DIAGNOSTIC ONLY (the precision-head threshold the
# calibration sweep still reports); nothing is auto-assigned at it in v4-tiered.2.
TIER2_ACCEPT = _env_float("TIER2_ACCEPT", 0.47)   # diagnostic precision head (NOT auto-accepted)
TIER2_REJECT = _env_float("TIER2_REJECT", 0.22)   # < → auto-drop (preserve recall)
# Calibration targets — the RULE the calibrator applies to the p1 pilot sweep:
#   T_accept = smallest threshold whose measured precision ≥ TARGET_ACCEPT_PRECISION
#   T_reject = largest threshold that still retains ≥ TARGET_REJECT_RECALL of the
#              in-shortlist positive pilot tags (so auto-drop loses few positives).
TIER2_TARGET_ACCEPT_PRECISION = _env_float("TIER2_TARGET_ACCEPT_PRECISION", 0.80)
TIER2_TARGET_REJECT_RECALL = _env_float("TIER2_TARGET_REJECT_RECALL", 0.95)
# The frozen p1 pilot run whose accepted tags are the calibration ground truth.
P1_PILOT_RUN_ID = _env("P1_PILOT_RUN_ID") or "63c99428-7ecb-469d-a551-cc99f9585673"
# Tier 3 is classification-only: {"tags":[{"slug","evidence_sentence_id"}]}.
# v4-tiered.2: TIERED, GENEROUS maxOutputTokens by ladder ATTEMPT (a safety
# ceiling, not a target). thinkingLevel stays LOW. A row is quarantined only
# after the FULL ladder — first pass → same-model retry → gemini-3.5-flash
# escalation — has run, so a truncated (finishReason=MAX_TOKENS) classification
# is always given more room before it is abandoned:
#   attempt 1 (first pass)            → TIER3_MAX_OUTPUT_TOKENS        (2048)
#   attempt 2 (same-model retry)      → TIER3_MAX_OUTPUT_TOKENS_RETRY  (4096)
#   attempt 3 (gemini-3.5-flash esc.) → TIER3_MAX_OUTPUT_TOKENS_ESCALATION (8192)
# TIER3_MAX_OUTPUT_TOKENS is the FIRST-attempt cap — the value the request
# builder falls back to when no attempt-specific cap is threaded in.
TIER3_MAX_OUTPUT_TOKENS = _env_int("TIER3_MAX_OUTPUT_TOKENS", 2048)
TIER3_MAX_OUTPUT_TOKENS_RETRY = _env_int("TIER3_MAX_OUTPUT_TOKENS_RETRY", 4096)
TIER3_MAX_OUTPUT_TOKENS_ESCALATION = _env_int("TIER3_MAX_OUTPUT_TOKENS_ESCALATION", 8192)


def tier3_output_cap(attempt: int) -> int:
    """maxOutputTokens for a Tier-3 request by ladder ATTEMPT (derived from the
    shard key by tagging.attempt_for_shard_key): 1 = first pass, 2 = same-model
    retry, 3 = escalation. Monotone and generous so a MAX_TOKENS truncation
    always gets more room before the row is quarantined — quarantine happens
    ONLY after the attempt-3 (8192) escalation still fails."""
    if attempt >= 3:
        return TIER3_MAX_OUTPUT_TOKENS_ESCALATION
    if attempt == 2:
        return TIER3_MAX_OUTPUT_TOKENS_RETRY
    return TIER3_MAX_OUTPUT_TOKENS
# The Tier-3 model ladder reuses the routed model strings: every row is judged on
# TIER3_MODEL (gemini-3-flash-preview) and, if still schema-invalid after one
# retry, escalates ONCE to TIER3_ESCALATION_MODEL (gemini-3.5-flash) before
# quarantine — the exact retry→escalate→quarantine ladder the p3 machinery runs.
TIER3_MODEL = MODEL_STANDARD
TIER3_ESCALATION_MODEL = MODEL_CORE
MAX_TAGS = _env_int("MAX_TAGS", 12)  # flexible count; responseSchema maxItems hard cap
MAX_QUESTIONS = _env_int("MAX_QUESTIONS", 3)  # 0-3 per passage; zero is a valid answer
MIN_EVIDENCE_WORDS = 4               # evidence-sentence floor for the code gate
# Candidate shortlist = semantic top-K ∪ exact alias matches in the passage ∪
# the hard-negative partners of anything shortlisted (both sides of every
# contrast pair). Capped at SHORTLIST_CAP before negatives are added back.
SHORTLIST_SEMANTIC = _env_int("SHORTLIST_SEMANTIC", 25)
SHORTLIST_CAP = _env_int("SHORTLIST_CAP", 40)
PASSAGE_CHAR_CAP = _env_int("PASSAGE_CHAR_CAP", 20000)  # bound the longest purports
SHARD_SIZE = _env_int("SHARD_SIZE", 6000)  # passages per Gemini Batch shard
# Hard cap on a single shard's JSONL INPUT tokens. Our Gemini tier allows at most
# 3M enqueued batch tokens at once; any shard whose built requests exceed this cap
# is split into token-bounded parts before submission, so every job always fits
# the queue. Small on purpose: at 400K about 6 jobs sit in the queue concurrently,
# instead of one 2.5M job blocking every other shard. chars/4 ≈ tokens — the
# same estimate used for the cost ledger. (Renamed from MAX_SHARD_INPUT_TOKENS.)
SHARD_MAX_INPUT_TOKENS = _env_int("SHARD_MAX_INPUT_TOKENS", 400_000)
PILOT_SIZE = _env_int("PILOT_SIZE", 2000)  # exact deterministic manifest (see tagging.plan_pilot_shards)
BATCH_POLL_SECONDS = _env_int("BATCH_POLL_SECONDS", 60)
DB_BATCH = _env_int("DB_BATCH", 5000)  # rows per SQL write batch

# Pilot composition (unchanged sampling method, p3 seed). The manifest is
# EXACTLY PILOT_SIZE rows:
#   all p1-failures + PILOT_SUCCESS_SLICE p1-successes (matched to the
#   failure table mix + per-table length quartile) + the remainder fresh,
#   stratified across all 5 tables × PILOT_LENGTH_BANDS length quartiles by
#   largest-remainder allocation. v3.p3 shard keys embed a short RUN token and
#   the routed model (tagging.pilot_prefix/full_prefix), so p1's `pilot:%` and
#   p2's `pilot:p2:%` shards, files and evidence stay frozen, and two p3 runs
#   can never collide with each other either.
PILOT_SHARD_PREFIX = "pilot:v4:"  # v4-tiered pilot shards (disjoint from every p1/p2/p3 key)
P2_PILOT_SHARD_PREFIX = "pilot:p2:"  # FROZEN p2 manifest/results — the bakeoff baseline
FULL_SHARD_PREFIX = "full:v4:"
PILOT_SUCCESS_SLICE = _env_int("PILOT_SUCCESS_SLICE", 200)  # p1 successes re-tagged for comparison
PILOT_LENGTH_BANDS = _env_int("PILOT_LENGTH_BANDS", 4)      # length quartiles for stratification

# Seeded randomness for every sampling decision (cluster sample, pilot pick,
# report samples) — recorded in vocabulary.json and pilot-report.md so the
# maintainer can reproduce any sample exactly.
SAMPLE_SEED = _env("SAMPLE_SEED") or "asp-tags-v3.p3"

# passage_function — the ONE channel adopted from the 49-channel beta spec.
# One PRIMARY value per passage from this closed enum, returned in the same
# combined call. Hidden metadata on an additive column; killable; will power
# essay sections later. A value outside the enum is stored as NULL.
PASSAGE_FUNCTIONS = [
    "defines", "explains", "instructs", "recommends", "prohibits", "warns",
    "encourages", "answers_question", "compares", "contrasts", "refutes",
    "quotes_scripture", "narrates_event", "gives_analogy", "gives_example",
    "states_conclusion",
    # v3.p2: filler / empty / purely-structural content that DOES nothing
    # doctrinally (chapter headings, salutations, "Hare Kṛṣṇa", stray fragments).
    "not_applicable",
]

# Pilot auto-validation thresholds (pilot continues automatically when ALL pass;
# otherwise the run STOPS with pilot-report.md). Evidence-found rate is REPORTED
# but not gated (the evidence gate is soft: in-vocabulary unevidenced tags are
# kept and flagged). There is deliberately NO minimum-tag-count gate — zero-tag
# passages are valid output.
# v3.p2 schema gates are FILE-BASED (validated before any DB write):
#   first pass ≥ PILOT_MIN_SCHEMA_VALID, then every schema-invalid row is retried
#   once and the run requires PILOT_FINAL_SCHEMA_VALID (100%) before applying.
PILOT_MIN_SCHEMA_VALID = _env_float("PILOT_MIN_SCHEMA_VALID", 0.995)
PILOT_FINAL_SCHEMA_VALID = _env_float("PILOT_FINAL_SCHEMA_VALID", 1.0)
PILOT_MAX_OUT_OF_VOCAB = _env_float("PILOT_MAX_OUT_OF_VOCAB", 0.02)
PILOT_MIN_DISTINCT_TAGS = _env_int("PILOT_MIN_DISTINCT_TAGS", 100)   # "in the hundreds"
PILOT_MAX_SINGLETON_SHARE = _env_float("PILOT_MAX_SINGLETON_SHARE", 0.20)  # of used terms
PILOT_MIN_VOCAB_COVERAGE = _env_float("PILOT_MIN_VOCAB_COVERAGE", 0.60)  # terms used ≥ once
# v4-tiered.2: ceiling raised 0.20 → 0.45. The most-used tag is 'krsna', assigned
# by Tier-1 exact_alias, and Śrīla Prabhupāda's corpus is GENUINELY about Kṛṣṇa —
# a Kṛṣṇa mention on a large share of passages is correct, not a distribution
# defect. The gate still catches a tag that has metastasized onto the near-whole
# corpus (> 45%).
PILOT_MAX_TAG_SHARE = _env_float("PILOT_MAX_TAG_SHARE", 0.45)  # no tag on >45% of passages
PILOT_MEDIAN_TAGS_MIN = _env_int("PILOT_MEDIAN_TAGS_MIN", 3)   # median among TAGGED rows
PILOT_MEDIAN_TAGS_MAX = _env_int("PILOT_MEDIAN_TAGS_MAX", 8)   # (zero-tag rows excluded)
PILOT_SAMPLE_ROWS = _env_int("PILOT_SAMPLE_ROWS", 40)  # passage→tags→evidence skim samples (30-50)

# ── Vocabulary build ────────────────────────────────────────────────────────
# NO Sanskrit facet: one topic = one term, language forms are variants.
FACETS = ["Concept", "Person", "Place", "Scripture", "Practice"]
# Person/Place/Scripture terms are kind=entity; Concept/Practice are kind=concept.
# Entities don't count toward the concept-size expectation (~400-700 concepts is
# healthy; the human gate decides, not a round number).
ENTITY_FACETS = {"Person", "Place", "Scripture"}
CLUSTER_SAMPLE = _env_int("CLUSTER_SAMPLE", 35000)  # seeded-random stratified vectors
# Clustering is a set of LENSES, not truth: several k views + one density view,
# each named independently; Gemini may answer "incoherent — drop" per cluster.
KMEANS_VIEWS = [int(k) for k in (_env("KMEANS_VIEWS") or "150,300,500").split(",") if k.strip()]
HDBSCAN_MIN_CLUSTER_SIZE = _env_int("HDBSCAN_MIN_CLUSTER_SIZE", 25)
HDBSCAN_MAX_POINTS = _env_int("HDBSCAN_MAX_POINTS", 20000)  # density view point cap
CLUSTER_MERGE_COSINE = _env_float("CLUSTER_MERGE_COSINE", 0.10)  # merge-PROPOSAL distance
SANSKRIT_MIN_FREQ = _env_int("SANSKRIT_MIN_FREQ", 25)  # synonyms-gloss recurrence floor
SANSKRIT_MIN_CHAPTERS = _env_int("SANSKRIT_MIN_CHAPTERS", 10)  # dispersion floor (chapters)
SANSKRIT_MAX_NEW = _env_int("SANSKRIT_MAX_NEW", 100)  # net-NEW mined terms cap
SANSKRIT_MAX_CANDIDATES = _env_int("SANSKRIT_MAX_CANDIDATES", 200)  # reviewed per run
VOYAGE_EMBED_BATCH = 128

# ── Bakeoff mode (v3.p3: --bakeoff-model / --bakeoff-route; NO DB writes) ───
# Replays the banked p2 pilot request files verbatim through a named model and
# compares against the banked p2 (3.5 Flash) results. Job state + reports live
# ONLY under SHARDS_DIR (git-ignored); tag_batch_jobs is never touched.
BAKEOFF_SAMPLE_QUESTIONS = _env_int("BAKEOFF_SAMPLE_QUESTIONS", 25)


def bakeoff_state_path(model: str, route: str) -> Path:
    return SHARDS_DIR / f"bakeoff_{model}_{route}.state.json"


def bakeoff_report_path(model: str, route: str, ext: str = "md") -> Path:
    return SHARDS_DIR / f"bakeoff_{model}_{route}_report.{ext}"


# ── Files this harness reads/writes (all inside scripts/tags-rebuild/) ──────
PROVENANCE_PATH = HARNESS_DIR / "provenance.json"        # committed manifest (read-only)
SEEDS_PATH = HARNESS_DIR / "vocabulary_seeds.json"       # committed seeds (read-only)
VOCAB_PATH = HARNESS_DIR / "vocabulary.json"             # built artifact — the ⛔ gate
PILOT_REPORT_PATH = HARNESS_DIR / "pilot-report.md"
HYGIENE_REPORT_PATH = HARNESS_DIR / "hygiene-report.md"  # written at finalize; report only
SHARDS_DIR = HARNESS_DIR / "shards"                      # request/response JSONL per shard

# Hygiene report thresholds (REPORT ONLY — nothing is auto-deleted; the
# maintainer decides in a 10-minute pass).
HYGIENE_MIN_USES = _env_int("HYGIENE_MIN_USES", 20)      # below → merge-up candidate
HYGIENE_MAX_SHARE = _env_float("HYGIENE_MAX_SHARE", 0.15)  # above → too-broad candidate

REQUIRED_KEYS = [
    "SUPABASE_URL",
    "SUPABASE_SERVICE_KEY",
    "DATABASE_URL",
    "GEMINI_API_KEY",
    "VOYAGE_API_KEY",
]


def missing_keys() -> list[str]:
    """Names of required credentials that are absent (values never shown)."""
    values = {
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_KEY": SUPABASE_SERVICE_KEY,
        "DATABASE_URL": DATABASE_URL,
        "GEMINI_API_KEY": GEMINI_API_KEY,
        "VOYAGE_API_KEY": VOYAGE_API_KEY,
    }
    return [k for k in REQUIRED_KEYS if not values[k]]


def require_keys() -> None:
    """Fail LOUDLY if any required credential is missing. No fallbacks."""
    missing = missing_keys()
    if missing:
        raise SystemExit(
            "FATAL: missing required credentials: "
            + ", ".join(missing)
            + f"\nPut them in {ENV_FILE} (see .env.example). The harness requires the"
            " SERVICE key and the Session Pooler DATABASE_URL — there is no anon-key"
            " fallback. Run `python run_all.py --doctor` for a full readiness check."
        )
