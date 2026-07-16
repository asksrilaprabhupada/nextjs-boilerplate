"""
finalize.py — after the tagging data lands: verse_chunks inheritance, tsvector
verification, GIN indexes, the vocabulary HYGIENE REPORT, and the completion
checklist. Step 5 of run_all.py; also runnable standalone.

1. verse_chunks inherit tags_core AND passage_function from their parent verse
   by SQL (chunks are never sent to Gemini).
2. Verify the trigger-maintained tsvectors: every row with questions /
   fts_expansion_src must have questions_fts / fts_expansion (the tagging
   UPDATE fires the trigger, so mismatches indicate a disabled trigger —
   they are repaired with the same touch pattern as the fts_core backfill).
3. CREATE INDEX CONCURRENTLY (never inside a transaction; a FRESH autocommit
   connection) — ONE AT A TIME, ANALYZE after each, then assert via pg_index
   that nothing is left INVALID. An invalid leftover from an interrupted run
   is dropped and rebuilt on rerun.
4. Hygiene report (hygiene-report.md): terms with 0 uses (delete candidates),
   < HYGIENE_MIN_USES uses (merge-up candidates), > HYGIENE_MAX_SHARE of the
   corpus (too-broad candidates). REPORT ONLY — the maintainer decides in a
   10-minute pass; nothing is auto-deleted.
5. Print the completion checklist (including the Supabase compute downgrade
   reminder — the heavy writes are over).

Writes touch ONLY the new columns/indexes — the old tags/fts columns and every
live search function stay untouched.
"""
from __future__ import annotations

from collections import Counter
from datetime import datetime, timezone

import build_vocabulary
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
            "UPDATE public.verse_chunks c"
            " SET tags_core = v.tags_core, passage_function = v.passage_function"
            " FROM public.verses v"
            " WHERE c.verse_id = v.id AND v.tags_core IS NOT NULL"
            "   AND (c.tags_core IS DISTINCT FROM v.tags_core"
            "        OR c.passage_function IS DISTINCT FROM v.passage_function)"
        )
        print(
            f"  verse_chunks inherited tags_core + passage_function from parents: {cur.rowcount} rows",
            flush=True,
        )


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


def hygiene_report() -> None:
    """List terms with 0 uses (delete candidates), < HYGIENE_MIN_USES uses
    (merge-up candidates), and terms on > HYGIENE_MAX_SHARE of the corpus
    (too-broad candidates). REPORT ONLY — nothing is auto-deleted; the
    maintainer decides in a 10-minute pass. Counted over the four
    Gemini-tagged tables (verse_chunks mirror their parent verses and would
    double-count)."""
    usage: Counter[str] = Counter()
    corpus_rows = 0
    for table in config.GEMINI_TABLES:
        corpus_rows += db.table_count(table, "tags_core IS NOT NULL")
        for tag, n in db.rows(
            f"SELECT tag, count(*) FROM ("
            f"  SELECT unnest(tags_core) AS tag FROM public.{table}"
            f"  WHERE tags_core IS NOT NULL) x GROUP BY tag"
        ):
            usage[tag] += int(n)
    vocabulary = build_vocabulary.load_vocabulary()
    all_slugs = {t["slug"]: t["term"] for t in vocabulary["terms"]}
    zero = sorted(s for s in all_slugs if s not in usage)
    low = sorted(
        (s for s, n in usage.items() if 0 < n < config.HYGIENE_MIN_USES),
        key=lambda s: usage[s],
    )
    broad_floor = max(1, int(corpus_rows * config.HYGIENE_MAX_SHARE))
    broad = sorted(
        (s for s, n in usage.items() if n > broad_floor),
        key=lambda s: -usage[s],
    )
    lines = [
        "# Vocabulary hygiene report (REPORT ONLY — nothing auto-deleted)",
        "",
        f"- Generated: {datetime.now(timezone.utc).isoformat()}",
        f"- Corpus: {corpus_rows:,} tagged passages across {', '.join(config.GEMINI_TABLES)}"
        " (verse_chunks mirror their parent verses and are not double-counted)",
        f"- Vocabulary: {len(all_slugs)} terms · {len(usage)} used at least once",
        "",
        "The maintainer decides in a 10-minute pass; edit vocabulary.json /",
        "vocab_terms deliberately — the harness never deletes a term itself.",
        "",
        f"## 0 uses — delete candidates ({len(zero)})",
        *[f"- `{s}` — {all_slugs[s]}" for s in zero],
        "",
        f"## Fewer than {config.HYGIENE_MIN_USES} uses — merge-up candidates ({len(low)})",
        *[f"- `{s}` — {all_slugs.get(s, s)} ({usage[s]} uses)" for s in low],
        "",
        f"## More than {config.HYGIENE_MAX_SHARE:.0%} of corpus — too-broad candidates ({len(broad)})",
        *[
            f"- `{s}` — {all_slugs.get(s, s)} ({usage[s]:,} uses · {usage[s] / max(corpus_rows, 1):.1%})"
            for s in broad
        ],
    ]
    with open(config.HYGIENE_REPORT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(
        f"  wrote {config.HYGIENE_REPORT_PATH} ({len(zero)} zero-use ·"
        f" {len(low)} low-use · {len(broad)} too-broad)",
        flush=True,
    )


def print_completion_checklist() -> None:
    print(
        "\nCompletion checklist:\n"
        "  [x] vocabulary.json v2 built · ⛔ gate passed · tags + questions +"
        " passage_function landed · fts_expansion + questions_fts + GIN"
        " (CONCURRENTLY, one at a time, ANALYZE) built\n"
        f"  [x] hygiene report generated → {config.HYGIENE_REPORT_PATH.name}"
        " (maintainer's 10-minute pass; nothing auto-deleted)\n"
        "  [ ] REMINDER FOR THE MAINTAINER: downgrade Supabase compute"
        " (LARGE → MICRO) — the heavy writes are over; leaving it costs"
        " ~$110/month for nothing\n"
        "  [ ] Next task: search wiring (v3 fused engine + old-vs-new"
        " side-by-side page, behind a flag, Vercel preview) — separate"
        " instruction to follow",
        flush=True,
    )


def run() -> None:
    inherit_verse_chunk_tags()
    verify_tsvectors()
    build_indexes()
    hygiene_report()
    print_completion_checklist()


def main() -> int:
    config.require_keys()
    run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
