"""
db.py — database access for the offline harness.

Two paths, chosen by what credentials are present:
  • get_supabase()  → supabase-py client (service key). Used for RPCs
    (fts_core_backfill_batch, batch_set_tags, …) and small reads/writes via
    PostgREST. Works with only SUPABASE_SERVICE_KEY — no DB password needed.
  • get_pg()        → direct psycopg connection (needs DATABASE_URL). Preferred
    for bulk vector reads (clustering) and large backfills: no PostgREST size
    limits and no 60s statement cap. Returns None if DATABASE_URL is unset.
"""
from __future__ import annotations
from typing import Optional
import config

_supabase = None


def get_supabase():
    global _supabase
    if _supabase is None:
        from supabase import create_client
        if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY):
            raise RuntimeError("SUPABASE_URL / SUPABASE_SERVICE_KEY missing — see config.missing_keys()")
        _supabase = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    return _supabase


def get_pg() -> Optional["object"]:
    """Direct Postgres connection, or None if DATABASE_URL is not configured."""
    if not config.DATABASE_URL:
        return None
    import psycopg
    return psycopg.connect(config.DATABASE_URL, autocommit=True)
