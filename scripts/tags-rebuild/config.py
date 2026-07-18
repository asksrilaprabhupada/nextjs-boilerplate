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

# Tagging + questions model. The brief specifies FULL Gemini 3.5 Flash — never
# a -lite variant. The exact current model string is confirmed against the live
# models list (gemini_client.confirm_model) before any paid run and by --doctor.
GEMINI_MODEL = _env("GEMINI_MODEL") or "gemini-3.5-flash"
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
GEMINI_UPLOAD_BASE = "https://generativelanguage.googleapis.com/upload/v1beta"
GEMINI_DOWNLOAD_BASE = "https://generativelanguage.googleapis.com/download/v1beta"
VOYAGE_MODEL = "voyage-context-4"  # 1024-dim, matches the stored embedding_context4
VOYAGE_URL = "https://api.voyageai.com/v1/contextualizedembeddings"

# ── Cost ceiling (machine-enforced) ─────────────────────────────────────────
# The submitter refuses to submit a shard once (real spend so far + estimates
# for in-flight work + the new shard's estimate) would exceed this. Set it in
# .env — 500 is the suggested value. No approval flow can raise it at runtime.
MAX_SPEND_USD = _env_float("MAX_SPEND_USD", 500.0)
# Gemini Batch pricing per 1M tokens (batch = 50% of interactive). The CANONICAL
# values below are the current Gemini 3.5 Flash Batch price sheet, pinned in code
# and shipped as the defaults — `--doctor` FAILS (not warns) if the effective
# prices are absent (≤0), match the stale v3.p1 placeholder, or differ from these
# canonical values. `.env` may still override (to react to a live price change),
# but the canonical constants must then be updated in lock-step so the doctor passes.
GEMINI_BATCH_PRICE_IN_PER_M_CANONICAL = 0.75   # $/1M input  tokens (Gemini 3.5 Flash Batch)
GEMINI_BATCH_PRICE_OUT_PER_M_CANONICAL = 4.50  # $/1M output tokens (candidates + thinking)
# Known-stale pairs that must ALWAYS fail the doctor even if re-pinned by accident.
STALE_BATCH_PRICE_PAIRS = {(0.15, 1.25)}       # the v3.p1 placeholder (undercounted 5-6x)
GEMINI_BATCH_PRICE_IN_PER_M = _env_float("GEMINI_BATCH_PRICE_IN_PER_M", GEMINI_BATCH_PRICE_IN_PER_M_CANONICAL)
GEMINI_BATCH_PRICE_OUT_PER_M = _env_float("GEMINI_BATCH_PRICE_OUT_PER_M", GEMINI_BATCH_PRICE_OUT_PER_M_CANONICAL)
# Pre-pilot output estimate per passage (tokens). After the pilot the measured
# average from usageMetadata (candidates + thinking) replaces this for
# extrapolation + ceiling checks. v3.p2 drops the free-text reasoning field but
# adds LOW thinking (billable output) — net estimate held at 500.
EST_OUTPUT_TOKENS_PER_PASSAGE = _env_int("EST_OUTPUT_TOKENS_PER_PASSAGE", 500)
# Gemini thinking + output-cap knobs (v3.p2). thinkingLevel LOW keeps native
# reasoning cheap; MAX_OUTPUT_TOKENS is a SAFETY CEILING only (not a target).
# temperature is intentionally NOT sent — the model default is used.
THINKING_LEVEL = _env("THINKING_LEVEL") or "LOW"
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
PROMPT_VERSION = "asp-tags-v3.p2"   # bump whenever the prompt or schema changes
BATCH_DISPLAY_PREFIX = "asp-tags-v3"  # Google Batch display_name prefix → reconciliation
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
# the queue (2.5M leaves headroom under the 3M ceiling). chars/4 ≈ tokens — the
# same estimate used for the cost ledger.
MAX_SHARD_INPUT_TOKENS = _env_int("MAX_SHARD_INPUT_TOKENS", 2_500_000)
PILOT_SIZE = _env_int("PILOT_SIZE", 2000)  # exact deterministic manifest (see tagging.plan_pilot_shards)
BATCH_POLL_SECONDS = _env_int("BATCH_POLL_SECONDS", 60)
DB_BATCH = _env_int("DB_BATCH", 5000)  # rows per SQL write batch

# v3.p2 pilot composition. The manifest is EXACTLY PILOT_SIZE rows:
#   all p1-failures (66) + PILOT_SUCCESS_SLICE p1-successes (matched to the
#   failure table mix + per-table length quartile) + the remainder fresh,
#   stratified across all 5 tables × PILOT_LENGTH_BANDS length quartiles by
#   largest-remainder allocation. p2 pilot shards use PILOT_SHARD_PREFIX so p1's
#   `pilot:%` shards, files and evidence stay frozen; retry shards live under it too.
PILOT_SHARD_PREFIX = "pilot:p2:"
PILOT_SUCCESS_SLICE = _env_int("PILOT_SUCCESS_SLICE", 200)  # p1 successes re-tagged for comparison
PILOT_LENGTH_BANDS = _env_int("PILOT_LENGTH_BANDS", 4)      # length quartiles for stratification

# Seeded randomness for every sampling decision (cluster sample, pilot pick,
# report samples) — recorded in vocabulary.json and pilot-report.md so the
# maintainer can reproduce any sample exactly.
SAMPLE_SEED = _env("SAMPLE_SEED") or "asp-tags-v3.p2"

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
PILOT_MAX_TAG_SHARE = _env_float("PILOT_MAX_TAG_SHARE", 0.20)  # no tag on >20% of passages
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
