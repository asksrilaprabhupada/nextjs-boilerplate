"""
backfill_fts_core.py — finish populating fts_core on existing rows for all five
content tables (Phase 3 bulk backfill). Step 1 of run_all.py; also runnable
standalone: `python backfill_fts_core.py`.

The BEFORE INSERT/UPDATE trigger (migration 20260708120000) computes fts_core
from each row's text; the backfill just "touches" every not-yet-populated row
once so the trigger fires. It runs over DATABASE_URL (Session Pooler) in
controlled batches — the big tables (transcripts ~144k rows, letters with long
paragraphs) exceed any PostgREST/statement-cap path, which is exactly why the
harness requires a direct connection.

Idempotent + resumable: only rows WHERE fts_core IS NULL are touched, so a
crash or Ctrl+C loses at most one uncommitted batch. Progress is printed per
batch. Remaining at last snapshot: prose ~29,412 · transcripts ~144,438 ·
letters ~10,468 (verses + verse_chunks already done) — live counts win.
"""
from __future__ import annotations

import config
import db

BATCH = 8000  # rows per touch batch; each batch is its own committed statement


def remaining(table: str) -> int:
    return db.table_count(table, "fts_core IS NULL")


def backfill_table(table: str) -> None:
    total = db.table_count(table)
    left = remaining(table)
    if left == 0:
        print(f"  {table}: {total}/{total} — already complete", flush=True)
        return
    conn = db.get_pg()
    while left > 0:
        def _touch():
            with conn.cursor() as cur:
                cur.execute(
                    f"WITH b AS (SELECT id FROM public.{table} WHERE fts_core IS NULL LIMIT %s) "
                    f"UPDATE public.{table} t SET fts_core = fts_core FROM b WHERE t.id = b.id",
                    (BATCH,),
                )
                return cur.rowcount

        touched = db.with_retry(_touch, f"{table} fts_core batch")
        left = remaining(table)
        print(f"  {table}: {total - left}/{total} done ({left} left)", flush=True)
        if touched == 0 and left > 0:
            raise SystemExit(
                f"FATAL: {table} backfill made no progress with {left} rows left —"
                " investigate before rerunning (trigger disabled?)."
            )


def run() -> None:
    print("fts_core backfill (direct connection, batches of "
          f"{BATCH}) —", flush=True)
    for table in config.CONTENT_TABLES:
        backfill_table(table)
    print("fts_core backfill complete.", flush=True)


def main() -> int:
    config.require_keys()
    run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
