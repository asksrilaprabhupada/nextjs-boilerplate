"""
finalize.py — after the tagging data lands: verse_chunks inheritance, tsvector
verification, and GIN indexes. Step 5 of run_all.py; also runnable standalone.

1. verse_chunks inherit tags_core from their parent verse by SQL (chunks are
   never sent to Gemini).
2. Verify the trigger-maintained tsvectors: every row with questions /
   fts_expansion_src must have questions_fts / fts_expansion (the tagging
   UPDATE fires the trigger, so mismatches indicate a disabled trigger —
   they are repaired with the same touch pattern as the fts_core backfill).
3. CREATE INDEX CONCURRENTLY (never inside a transaction; a FRESH autocommit
   connection) — ONE AT A TIME, ANALYZE after each, then assert via pg_index
   that nothing is left INVALID. An invalid leftover from an interrupted run
   is dropped and rebuilt on rerun.

Writes touch ONLY the new columns/indexes — the old tags/fts columns and every
live search function stay untouched.
"""
from __future__ import annotations

import config
import db

# (table, column, index name) — deterministic names; one CONCURRENTLY build each.
GIN_INDEXES = [
    (t, col, f"idx_{t}_{col}_gin")
    for col in ("fts_core", "fts_expansion", "questions_fts", "tags_core")
    for t in config.CONTENT_TABLES
]


def inherit_verse_chunk_tags() -> None:
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.verse_chunks c SET tags_core = v.tags_core"
            " FROM public.verses v"
            " WHERE c.verse_id = v.id AND v.tags_core IS NOT NULL"
            "   AND c.tags_core IS DISTINCT FROM v.tags_core"
        )
        print(f"  verse_chunks inherited tags_core from parents: {cur.rowcount} rows", flush=True)


def verify_tsvectors() -> None:
    """The BEFORE UPDATE trigger derives questions_fts/fts_expansion whenever
    the tagging apply writes questions/fts_expansion_src. Repair any gap by
    touching the affected rows (same pattern as the fts_core backfill)."""
    for table in config.CONTENT_TABLES:
        for src, dst in (("questions", "questions_fts"), ("fts_expansion_src", "fts_expansion")):
            gap = db.table_count(table, f"{src} IS NOT NULL AND {dst} IS NULL")
            if gap:
                print(f"  {table}: {gap} rows missing {dst} — touching to re-fire trigger", flush=True)
                with db.get_pg().cursor() as cur:
                    cur.execute(
                        f"UPDATE public.{table} SET {src} = {src}"
                        f" WHERE {src} IS NOT NULL AND {dst} IS NULL"
                    )
            remaining = db.table_count(table, f"{src} IS NOT NULL AND {dst} IS NULL")
            if remaining:
                raise SystemExit(
                    f"FATAL: {table}.{dst} still NULL on {remaining} rows with {src} set —"
                    " is the search-vectors trigger disabled?"
                )
    print("  tsvectors verified on all five tables.", flush=True)


def _invalid_indexes(conn) -> list[str]:
    with conn.cursor() as cur:
        cur.execute(
            "SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid"
            " JOIN pg_namespace n ON n.oid = c.relnamespace"
            " WHERE NOT i.indisvalid AND n.nspname = 'public'"
        )
        return [r[0] for r in cur.fetchall()]


def build_indexes() -> None:
    """One CONCURRENTLY build at a time on a fresh autocommit connection,
    ANALYZE after each, invalid-check at the end."""
    conn = db.fresh_pg()
    try:
        # Drop invalid leftovers from a previously interrupted run first —
        # CREATE INDEX CONCURRENTLY IF NOT EXISTS would silently keep them.
        for name in _invalid_indexes(conn):
            if name.startswith("idx_") and name.endswith("_gin"):
                print(f"  dropping INVALID leftover index {name}", flush=True)
                with conn.cursor() as cur:
                    cur.execute(f"DROP INDEX CONCURRENTLY IF EXISTS public.{name}")
        for table, column, name in GIN_INDEXES:
            with conn.cursor() as cur:
                cur.execute(
                    f"CREATE INDEX CONCURRENTLY IF NOT EXISTS {name}"
                    f" ON public.{table} USING gin ({column})"
                )
                print(f"  index {name} ready", flush=True)
                cur.execute(f"ANALYZE public.{table}")
        invalid = _invalid_indexes(conn)
        if invalid:
            raise SystemExit(
                f"FATAL: invalid indexes remain after the build: {', '.join(invalid)} —"
                " rerun finalize (invalid leftovers are dropped and rebuilt)."
            )
        print("  all GIN indexes valid; tables analyzed.", flush=True)
    finally:
        conn.close()


def run() -> None:
    inherit_verse_chunk_tags()
    verify_tsvectors()
    build_indexes()


def main() -> int:
    config.require_keys()
    run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
