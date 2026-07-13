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
# Gemini Batch pricing per 1M tokens (batch = 50% of interactive). Defaults are
# a conservative guess — VERIFY against the live price sheet for the resolved
# model string and pin them in .env before the full run.
GEMINI_BATCH_PRICE_IN_PER_M = _env_float("GEMINI_BATCH_PRICE_IN_PER_M", 0.15)
GEMINI_BATCH_PRICE_OUT_PER_M = _env_float("GEMINI_BATCH_PRICE_OUT_PER_M", 1.25)
# Pre-pilot output estimate per passage (tokens). After the pilot the measured
# average from usageMetadata replaces this for extrapolation + ceiling checks.
EST_OUTPUT_TOKENS_PER_PASSAGE = _env_int("EST_OUTPUT_TOKENS_PER_PASSAGE", 350)

# ── Corpus ──────────────────────────────────────────────────────────────────
CONTENT_TABLES = [
    "verses",
    "verse_chunks",
    "prose_paragraphs",
    "transcript_paragraphs",
    "letter_paragraphs",
]
# Tables sent to Gemini. verse_chunks are NEVER sent — they inherit tags_core
# from their parent verse by SQL (finalize step).
GEMINI_TABLES = ["verses", "prose_paragraphs", "transcript_paragraphs", "letter_paragraphs"]
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
PROMPT_VERSION = "asp-tags-v2.p1"   # bump whenever the prompt or schema changes
BATCH_DISPLAY_PREFIX = "asp-tags-v2"  # Google Batch display_name prefix → reconciliation
MAX_TAGS = _env_int("MAX_TAGS", 12)  # flexible count; responseSchema maxItems hard cap
MAX_QUESTIONS = _env_int("MAX_QUESTIONS", 5)
MIN_EVIDENCE_WORDS = 4               # evidence-sentence floor for the code gate
SHORTLIST_SIZE = _env_int("SHORTLIST_SIZE", 30)  # nearest vocab terms offered per passage
PASSAGE_CHAR_CAP = _env_int("PASSAGE_CHAR_CAP", 20000)  # bound the longest purports
SHARD_SIZE = _env_int("SHARD_SIZE", 6000)  # passages per Gemini Batch shard
PILOT_SIZE = 1000                    # first stratified passages (proportional, 5 tables)
BATCH_POLL_SECONDS = _env_int("BATCH_POLL_SECONDS", 60)
DB_BATCH = _env_int("DB_BATCH", 5000)  # rows per SQL write batch

# Pilot auto-validation thresholds (pilot continues automatically when ALL pass;
# otherwise the run STOPS with pilot-report.md).
PILOT_MIN_SCHEMA_VALID = _env_float("PILOT_MIN_SCHEMA_VALID", 0.98)
PILOT_MIN_EVIDENCE_MATCH = _env_float("PILOT_MIN_EVIDENCE_MATCH", 0.90)
PILOT_MAX_OUT_OF_VOCAB = _env_float("PILOT_MAX_OUT_OF_VOCAB", 0.02)
PILOT_MIN_MEAN_TAGS = _env_float("PILOT_MIN_MEAN_TAGS", 2.0)

# ── Vocabulary build ────────────────────────────────────────────────────────
FACETS = ["Concept", "Sanskrit", "Person", "Place", "Scripture", "Practice"]
CLUSTER_SAMPLE = _env_int("CLUSTER_SAMPLE", 35000)  # stratified vectors for KMeans
KMEANS_K = _env_int("KMEANS_K", 500)                # over-cluster, then merge
CLUSTER_MERGE_COSINE = _env_float("CLUSTER_MERGE_COSINE", 0.10)  # merge distance
SANSKRIT_MIN_FREQ = _env_int("SANSKRIT_MIN_FREQ", 25)  # synonyms-gloss recurrence floor
SANSKRIT_MAX_TERMS = _env_int("SANSKRIT_MAX_TERMS", 400)
VOYAGE_EMBED_BATCH = 128

# ── Files this harness reads/writes (all inside scripts/tags-rebuild/) ──────
PROVENANCE_PATH = HARNESS_DIR / "provenance.json"        # committed manifest (read-only)
SEEDS_PATH = HARNESS_DIR / "vocabulary_seeds.json"       # committed seeds (read-only)
VOCAB_PATH = HARNESS_DIR / "vocabulary.json"             # built artifact — the ⛔ gate
PILOT_REPORT_PATH = HARNESS_DIR / "pilot-report.md"
SHARDS_DIR = HARNESS_DIR / "shards"                      # request/response JSONL per shard

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
