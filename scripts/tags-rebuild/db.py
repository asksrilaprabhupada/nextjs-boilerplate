"""
db.py — database access for the offline harness (v2).

Two clients, both REQUIRED (config.require_keys enforces this — no fallbacks):
  • get_pg()        → direct psycopg connection via DATABASE_URL (the Supabase
    **Session Pooler** DSN). Used for everything bulk: backfills, vector reads,
    shard planning, applying results, CREATE INDEX CONCURRENTLY. autocommit=True
    so CONCURRENTLY works; wrap multi-statement writes in `with conn.transaction()`.
  • get_supabase()  → supabase-py client (SERVICE key). Used only where PostgREST
    is the natural fit (vocab_terms upserts). Never constructed with the anon key.

Helpers keep retry/iteration logic in one place so step modules stay readable.
"""
from __future__ import annotations

import time
from typing import Any, Callable, Iterator, Sequence

import config

_supabase = None
_pg = None


def get_supabase():
    global _supabase
    if _supabase is None:
        from supabase import create_client

        if not (config.SUPABASE_URL and config.SUPABASE_SERVICE_KEY):
            raise SystemExit(
                "FATAL: SUPABASE_URL / SUPABASE_SERVICE_KEY missing — the harness has"
                " no anon-key fallback. See `python run_all.py --doctor`."
            )
        _supabase = create_client(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY)
    return _supabase


def get_pg():
    """Shared direct Postgres connection (Session Pooler). Fails loudly if absent."""
    global _pg
    if not config.DATABASE_URL:
        raise SystemExit(
            "FATAL: DATABASE_URL missing — set the Supabase Session Pooler DSN in"
            f" {config.ENV_FILE}. The harness requires a direct SQL connection."
        )
    if _pg is None or _pg.closed:
        import psycopg

        _pg = psycopg.connect(config.DATABASE_URL, autocommit=True)
    return _pg


def fresh_pg():
    """A NEW connection (not the shared one) — for CREATE INDEX CONCURRENTLY,
    which must not share a session with any open cursor/transaction state."""
    import psycopg

    if not config.DATABASE_URL:
        raise SystemExit("FATAL: DATABASE_URL missing.")
    return psycopg.connect(config.DATABASE_URL, autocommit=True)


def one(sql: str, params: Sequence[Any] | None = None) -> Any:
    """Run a single-value query on the shared connection."""
    with get_pg().cursor() as cur:
        cur.execute(sql, params)
        row = cur.fetchone()
        return row[0] if row else None


def rows(sql: str, params: Sequence[Any] | None = None) -> list[tuple]:
    with get_pg().cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def iter_rows(sql: str, params: Sequence[Any] | None = None, size: int = 2000) -> Iterator[tuple]:
    """Server-side cursor iteration for big reads (vectors, transcripts)."""
    conn = get_pg()
    # Named cursors require an explicit transaction block (the shared
    # connection is autocommit); these iterations are read-only.
    with conn.transaction():
        with conn.cursor(name=f"harness_iter_{int(time.time() * 1000)}") as cur:
            cur.itersize = size
            cur.execute(sql, params)
            yield from cur


def _is_non_retryable_http(exc: Exception) -> bool:
    """A client-side HTTP failure (4xx except 429) never succeeds on retry — a
    malformed request or bad credentials must fail loudly and immediately, not
    after 3 wasted attempts. Detected via an int `status` attribute, as carried
    by gemini_client.GeminiHTTPError."""
    status = getattr(exc, "status", None)
    return isinstance(status, int) and 400 <= status < 500 and status != 429


def with_retry(fn: Callable[[], Any], what: str, attempts: int = 4,
               retry_429: bool = True) -> Any:
    """Network retry with exponential backoff (2s, 4s, 8s) — pooler blips happen.
    A non-retryable HTTP 4xx (except 429) re-raises immediately without retrying.
    retry_429=False re-raises HTTP 429 immediately AND silently too — for batch
    create, where a 429 means the queue is full: expected backpressure the caller
    waits out patiently, not an error worth printing (let alone its JSON body)."""
    for attempt in range(attempts):
        try:
            return fn()
        except Exception as exc:  # noqa: BLE001 — deliberate catch-all with loud rethrow
            if (attempt == attempts - 1 or _is_non_retryable_http(exc)
                    or (not retry_429 and getattr(exc, "status", None) == 429)):
                raise
            wait = 2 ** (attempt + 1)
            print(f"  retry {attempt + 1}/{attempts - 1} for {what} in {wait}s: {exc}", flush=True)
            time.sleep(wait)


def table_count(table: str, where: str = "TRUE") -> int:
    return int(one(f"SELECT count(*) FROM public.{table} WHERE {where}"))
