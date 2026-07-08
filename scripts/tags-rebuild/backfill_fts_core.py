"""
backfill_fts_core.py — populate fts_core on existing rows for all five content
tables (Phase 3 bulk backfill).

The BEFORE INSERT/UPDATE trigger (migration 20260708120000) computes fts_core from
each row's text. Backfill just needs to "touch" every not-yet-populated row once so
the trigger fires. We deliberately do this from a direct/long-lived connection
because the Supabase MCP has a 60s statement cap that the big tables (letters have
long paragraphs; transcripts have 144k rows) exceed.

Two modes, auto-selected:
  • DATABASE_URL present → direct psycopg loop, arbitrary batch size, one pass.
  • else → loop the public.fts_core_backfill_batch(table, n) RPC via supabase-py
    (service key only). Each RPC call is one committed batch and returns the
    remaining count, so it is fully resumable (safe to re-run any time).

Idempotent: only rows WHERE fts_core IS NULL are touched. Run:  python backfill_fts_core.py
"""
from __future__ import annotations
import sys
import time
import config
import db

BATCH = 8000  # rows per batch; safe well under any statement timeout


def _remaining_pg(conn, table: str) -> int:
    with conn.cursor() as cur:
        cur.execute(f"SELECT count(*) FROM public.{table} WHERE fts_core IS NULL")
        return cur.fetchone()[0]


def backfill_pg(conn, table: str) -> None:
    total = config.ROW_COUNTS[table]
    while True:
        with conn.cursor() as cur:
            cur.execute(
                f"WITH b AS (SELECT id FROM public.{table} WHERE fts_core IS NULL LIMIT %s) "
                f"UPDATE public.{table} t SET fts_core = fts_core FROM b WHERE t.id = b.id",
                (BATCH,),
            )
        remaining = _remaining_pg(conn, table)
        print(f"  {table}: {total - remaining}/{total} done ({remaining} left)", flush=True)
        if remaining == 0:
            break


def backfill_rpc(table: str) -> None:
    sb = db.get_supabase()
    total = config.ROW_COUNTS[table]
    while True:
        remaining = sb.rpc("fts_core_backfill_batch", {"p_table": table, "p_batch": BATCH}).execute().data
        remaining = int(remaining)
        print(f"  {table}: {total - remaining}/{total} done ({remaining} left)", flush=True)
        if remaining == 0:
            break
        time.sleep(0.1)


def main() -> int:
    missing = [k for k in ("SUPABASE_URL", "SUPABASE_SERVICE_KEY") if k in config.missing_keys()]
    if missing:
        print(f"ERROR: missing credentials: {', '.join(missing)}", file=sys.stderr)
        return 1
    conn = db.get_pg()
    mode = "direct psycopg" if conn else "service-key RPC"
    print(f"fts_core backfill — mode: {mode}", flush=True)
    try:
        for table in config.CONTENT_TABLES:
            if conn:
                backfill_pg(conn, table)
            else:
                backfill_rpc(table)
    finally:
        if conn:
            conn.close()
    print("fts_core backfill complete.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
