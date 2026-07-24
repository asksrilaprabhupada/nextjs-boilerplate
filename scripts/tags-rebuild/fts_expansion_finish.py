"""
fts_expansion_finish.py — STEP 0 of the final column build: finish `fts_expansion`
for every content table that still has unbuilt rows. FREE — pure SQL, no API calls.

`fts_expansion` is the tag-gloss expansion lane of the search index: for each row
that carries `tags_core`, every tag slug is resolved through `vocab_terms` into its
canonical term plus all variants, newline-joined into `fts_expansion_src`, and
`to_tsvector('english_unaccent', ...)` of that goes into `fts_expansion`.

Design notes (why this file exists rather than one big UPDATE):

  • BATCHED. A single whole-table UPDATE on transcript_paragraphs (140k rows,
    each fanning out through unnest → vocab_terms → unnest) runs for tens of
    minutes inside one transaction, bloats the table and blocks. We take
    BATCH rows at a time and COMMIT each batch, so progress is durable and the
    job is interruptible/resumable at any point — rerunning simply picks up
    whatever is still unbuilt.

  • RESUMABLE BY CONSTRUCTION. The work queue is a query, not a cursor:
    "rows with tags but no expansion yet" (`length(fts_expansion::text) <= 2`
    is the empty-tsvector test — an empty tsvector renders as `''`). Committed
    batches leave the queue; nothing is tracked in a state file.

  • NEVER COMPETES. Before starting a table we look in pg_stat_activity for
    another session already running an fts_expansion UPDATE against it and WAIT
    for that session rather than launching a second writer. Two concurrent
    updaters on the same rows just block each other on row locks.

This script writes ONLY fts_expansion / fts_expansion_src. It never touches
tags, tags_core, fts or fts_core.

Usage:
    python fts_expansion_finish.py                 # all content tables
    python fts_expansion_finish.py --tables letter_paragraphs,transcript_paragraphs
    python fts_expansion_finish.py --batch 5000
    python fts_expansion_finish.py --verify        # report only, write nothing
"""
from __future__ import annotations

import argparse
import time

import config
import db

# Every table carrying tags_core + fts_expansion. Order matters only for output.
TABLES = list(config.CONTENT_TABLES)

DEFAULT_BATCH = 5000
# How long to wait between polls when another session is already updating a table.
COMPETITOR_POLL_SECONDS = 30
# Give up waiting for a competing writer after this long (it is almost certainly
# a stuck session at that point — the operator should look, not us).
COMPETITOR_GIVE_UP_SECONDS = 3 * 3600

# The empty tsvector serialises as '' (two quote characters), so length(...) <= 2
# is "no expansion built yet". Kept in one place: the work-queue predicate, the
# progress counters and the final verification all use the SAME test.
UNBUILT = "cardinality(tags_core) > 0 AND length(fts_expansion::text) <= 2"
BUILT = "cardinality(tags_core) > 0 AND length(fts_expansion::text) > 2"
TAGGED = "cardinality(tags_core) > 0"

# One batch. Identical shape for every table; the table name is interpolated
# (never user input — it comes from config.CONTENT_TABLES).
#
# The two AS MATERIALIZED hints and the LIMIT on `src` are load-bearing, not
# decoration. Without them the planner has no idea `src` is small: it estimates
# the GROUP BY at the table's n_distinct for id (144,424 on
# transcript_paragraphs) rather than the ≤ BATCH groups it can actually produce,
# and so joins the final UPDATE with a MERGE JOIN that index-scans the ENTIRE
# table — every batch, all 28 of them. Bounding `src` (which can never exceed
# `tgt`, so the LIMIT changes no results) drops the estimate to BATCH and the
# planner switches to a nested loop over BATCH primary-key lookups.
# Measured on the live DB: total plan cost 138,459 → 26,825.
# `tgt` carries tags_core forward so `src` never touches the table a second
# time. The obvious phrasing — re-joining {table} inside `src` to read
# v.tags_core — makes the planner merge-join the whole table: an index scan of
# ALL 144,424 transcript rows plus heap access, on EVERY batch. Carrying the
# array through the CTE instead reduces `src` to pure computation over BATCH
# rows and lets the UPDATE be a nested loop of BATCH primary-key lookups.
# Measured on the live DB (EXPLAIN ANALYZE, 5,000 rows): the whole read phase of
# this phrasing is 382 ms.
#
# That 382 ms is the point: batch wall-clock is NOT the query. On
# transcript_paragraphs a 5,000-row batch takes ~10-11 minutes, essentially all
# of it in the WRITE phase — the table carries 11 indexes totalling 1.3 GB, of
# which a 1.1 GB HNSW vector index dominates, and every updated row must be
# re-inserted into all of them. The update cannot be HOT (and so cannot skip the
# indexes) because fts_expansion is itself GIN-indexed. Consequences worth
# knowing before running this on a big table:
#   • batch SIZE barely affects total time — cost is per ROW, not per batch;
#   • ~140k rows therefore costs ~5 h, and no query tuning will change that;
#   • do NOT infer progress from pg_relation_size or pg_stat_user_tables
#     mid-batch. n_tup_upd only flushes at COMMIT, and the heap can stay flat
#     because new row versions reuse free space. The only honest progress signal
#     is a committed batch — i.e. the built/todo counts moving.
BATCH_SQL = """
WITH tgt AS MATERIALIZED (
  SELECT id, tags_core FROM public.{table}
  WHERE cardinality(tags_core) > 0
    AND length(fts_expansion::text) <= 2
  LIMIT %(batch)s
), src AS MATERIALIZED (
  SELECT tgt.id, string_agg(DISTINCT x.w, E'\\n') AS s
  FROM tgt
  CROSS JOIN LATERAL unnest(tgt.tags_core) AS t(slug)
  JOIN public.vocab_terms vt ON vt.slug = t.slug
  CROSS JOIN LATERAL unnest(
      array[vt.term] || coalesce(vt.variants,'{{}}')) AS x(w)
  GROUP BY tgt.id
  LIMIT %(batch)s
)
UPDATE public.{table} v
SET fts_expansion_src = src.s,
    fts_expansion = to_tsvector('english_unaccent', src.s)
FROM src WHERE src.id = v.id
"""


def counts(table: str) -> tuple[int, int, int]:
    """(tagged, built, todo) for one table — the numbers the verifier compares."""
    row = db.rows(
        f"SELECT count(*) FILTER (WHERE {TAGGED}),"
        f"       count(*) FILTER (WHERE {BUILT}),"
        f"       count(*) FILTER (WHERE {UNBUILT})"
        f" FROM public.{table}"
    )[0]
    return int(row[0]), int(row[1]), int(row[2])


def competing_pids(table: str) -> list[int]:
    """PIDs of OTHER sessions currently running an fts_expansion write against
    `table`. Matching on both the column and the table name keeps us from
    mistaking this script's own reads — or an unrelated query — for a writer."""
    return [
        int(pid)
        for (pid,) in db.rows(
            "SELECT pid FROM pg_stat_activity"
            " WHERE datname = current_database()"
            "   AND pid <> pg_backend_pid()"
            "   AND state <> 'idle'"
            "   AND query ILIKE %s"
            "   AND query ILIKE %s",
            (f"%{table}%", "%fts_expansion%"),
        )
    ]


def wait_for_competitor(table: str) -> None:
    """Block while another session is updating `table`. Launching a second
    writer against the same rows does not go faster — the two just fight over
    row locks — so we let the incumbent finish and then take over the remainder."""
    waited = 0.0
    while True:
        pids = competing_pids(table)
        if not pids:
            if waited:
                print(f"  competing writer on {table} finished after {waited/60:.1f} min"
                      f" — continuing", flush=True)
            return
        if waited == 0:
            _, _, todo = counts(table)
            print(
                f"  ⏸ {table}: another session (pid {', '.join(map(str, pids))}) is already"
                f" building fts_expansion here — waiting for it instead of competing."
                f" ({todo:,} rows still unbuilt)",
                flush=True,
            )
        elif waited % 300 == 0:
            _, built, todo = counts(table)
            print(f"    still waiting on pid {pids} — {built:,} built / {todo:,} to go",
                  flush=True)
        if waited >= COMPETITOR_GIVE_UP_SECONDS:
            raise SystemExit(
                f"FATAL: a competing fts_expansion writer has held {table} for"
                f" {COMPETITOR_GIVE_UP_SECONDS/3600:.0f}h without finishing"
                f" (pid {pids}). Investigate that session before rerunning."
            )
        time.sleep(COMPETITOR_POLL_SECONDS)
        waited += COMPETITOR_POLL_SECONDS


def build_table(table: str, batch: int) -> int:
    """Batch-build fts_expansion for one table until no unbuilt rows remain.
    Each batch is its own committed transaction. Returns rows written."""
    wait_for_competitor(table)
    tagged, built, todo = counts(table)
    if todo == 0:
        print(f"  ✓ {table}: already complete ({built:,}/{tagged:,}) — nothing to do",
              flush=True)
        return 0

    print(f"  {table}: {todo:,} rows to build ({built:,}/{tagged:,} done)", flush=True)
    conn = db.get_pg()  # autocommit=True → each execute() is its own transaction
    sql = BATCH_SQL.format(table=table)
    written = 0
    rounds = 0
    started = time.monotonic()
    while True:
        t0 = time.monotonic()
        with conn.cursor() as cur:
            cur.execute(sql, {"batch": batch})
            n = cur.rowcount
        if not n:
            break
        written += n
        rounds += 1
        elapsed = time.monotonic() - started
        rate = written / elapsed if elapsed else 0
        remaining = max(0, todo - written)
        eta = remaining / rate if rate else 0
        print(
            f"    batch {rounds:>3}: +{n:,} rows in {time.monotonic()-t0:>5.1f}s"
            f"  ({written:,}/{todo:,}"
            f"  {written/todo*100:5.1f}%  eta {eta/60:4.1f} min)",
            flush=True,
        )

    tagged, built, todo = counts(table)
    print(f"  ✓ {table}: wrote {written:,} rows in {rounds} batches"
          f" — {built:,}/{tagged:,} built, {todo:,} remaining", flush=True)
    return written


def verify(tables: list[str]) -> bool:
    """Built count must EQUAL the tagged count for every table. Prints the table
    the brief asks for and returns True only when every row is accounted for."""
    print("\n  fts_expansion — final state")
    print(f"  {'table':<24} {'tagged':>10} {'built':>10} {'missing':>9}  status")
    print(f"  {'-'*24} {'-'*10} {'-'*10} {'-'*9}  ------")
    ok = True
    for table in tables:
        tagged, built, todo = counts(table)
        good = built == tagged and todo == 0
        ok &= good
        print(f"  {table:<24} {tagged:>10,} {built:>10,} {tagged-built:>9,}"
              f"  {'OK' if good else 'INCOMPLETE'}")
    print()
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tables", default=",".join(TABLES),
                        help="comma-separated subset of content tables")
    parser.add_argument("--batch", type=int, default=DEFAULT_BATCH,
                        help=f"rows per committed batch (default {DEFAULT_BATCH})")
    parser.add_argument("--verify", action="store_true",
                        help="report coverage only; write nothing")
    args = parser.parse_args()

    # STEP 0 is pure SQL — it needs the pooler DSN and nothing else. Demanding the
    # Gemini/Voyage keys here (config.require_keys) would block a free job on
    # credentials it never uses.
    if not config.DATABASE_URL:
        raise SystemExit(
            "FATAL: DATABASE_URL missing — set the Supabase Session Pooler DSN"
            f" (port 5432) in {config.ENV_FILE}. See .env.example."
        )
    tables = [t.strip() for t in args.tables.split(",") if t.strip()]
    unknown = [t for t in tables if t not in TABLES]
    if unknown:
        raise SystemExit(f"FATAL: unknown table(s) {unknown}; expected any of {TABLES}")

    if args.verify:
        return 0 if verify(tables) else 1

    print(f"\nSTEP 0 — building fts_expansion (batch={args.batch:,})\n")
    total = 0
    for table in tables:
        total += build_table(table, args.batch)

    print(f"\n  wrote {total:,} rows total")
    if not verify(tables):
        raise SystemExit(
            "FATAL: fts_expansion is INCOMPLETE — at least one table has rows with"
            " tags_core but no expansion. Rerun this script; if a table stays stuck,"
            " check that every slug in tags_core exists in vocab_terms (a slug with"
            " no vocab_terms row produces no src text, so the row can never build)."
        )
    print("  ✓ STEP 0 complete — every tagged row has fts_expansion\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
