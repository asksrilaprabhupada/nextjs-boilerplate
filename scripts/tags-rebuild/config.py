"""
config.py — shared configuration + credential loading for the Tags & FTS Rebuild
offline batch harness.

Loads from the process environment (and, if present, a .env.local at the repo
root for local runs). NEVER prints secret values. All scripts import from here so
there is one source of truth for keys, model strings, and tuning constants.
"""
from __future__ import annotations
import os
from pathlib import Path

try:
    from dotenv import load_dotenv  # optional convenience for local runs
    _repo_root = Path(__file__).resolve().parents[2]
    load_dotenv(_repo_root / ".env.local")
except Exception:
    pass  # in the cloud sandbox the env is populated directly

# ── Supabase ────────────────────────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL") or os.environ.get("NEXT_PUBLIC_SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY") or os.environ.get("NEXT_PUBLIC_SUPABASE_ANON_KEY", "")
# Optional direct Postgres DSN (pooler/session string). Preferred for the bulk
# vector reads (clustering) and backfills — no PostgREST row/size limits, no 60s
# statement cap. If absent, scripts fall back to the service-key RPC path.
DATABASE_URL = os.environ.get("DATABASE_URL", "")
PROJECT_ID = "wzktlpjtqmjxvragwhqg"

# ── AI providers ────────────────────────────────────────────────────────────
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
VOYAGE_API_KEY = os.environ.get("VOYAGE_API_KEY", "")
COHERE_API_KEY = os.environ.get("COHERE_API_KEY", "")

# Tagging + questions model. Brief specifies full Gemini 3.5 Flash (NOT Flash-Lite).
# Confirmed GA July 2026. Verify the exact string at runtime via models.list before
# any paid run (see gemini_client.confirm_model()); avoid gemini-3-flash (deprecating).
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.5-flash")
GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta"
VOYAGE_MODEL = "voyage-context-4"   # 1024-dim, matches the stored embedding_context4
VOYAGE_BASE = "https://api.voyageai.com/v1"

# ── Corpus ──────────────────────────────────────────────────────────────────
CONTENT_TABLES = [
    "verses",
    "verse_chunks",
    "prose_paragraphs",
    "transcript_paragraphs",
    "letter_paragraphs",
]
# Verified row counts (2026-07-08) — used for stratified sampling + cost extrapolation.
ROW_COUNTS = {
    "verses": 25131,
    "verse_chunks": 18699,
    "prose_paragraphs": 36412,
    "transcript_paragraphs": 144438,
    "letter_paragraphs": 19468,
}
TOTAL_ROWS = sum(ROW_COUNTS.values())  # 244,148

# ── Tuning ──────────────────────────────────────────────────────────────────
EMBED_DIM = 1024
SHORTLIST_SIZE = 30          # nearest vocab terms offered to Gemini per passage (prompt-steer)
MAX_TAGS_CORE = 6            # responseSchema maxItems — hard cap the model can't exceed
MAX_QUESTIONS = 5
MAX_TAGS_AI = 5
MIN_EVIDENCE_WORDS = 4       # evidence-sentence floor for the gate
CLUSTER_SAMPLE = 35000       # stratified vectors for MiniBatchKMeans (Phase 1)
KMEANS_K = 500               # over-cluster; merged down afterward
SHARD_SIZE = 6000            # rows per Gemini Batch shard (resumable unit)


def missing_keys() -> list[str]:
    """Return the names of required credentials that are absent (values never shown)."""
    required = {
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_SERVICE_KEY": SUPABASE_SERVICE_KEY,
        "GEMINI_API_KEY": GEMINI_API_KEY,
        "VOYAGE_API_KEY": VOYAGE_API_KEY,
        "COHERE_API_KEY": COHERE_API_KEY,
    }
    return [k for k, v in required.items() if not v]
