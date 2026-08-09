"""
finalize.py — after the tagging data lands: tsvector verification, GIN indexes,
the vocabulary HYGIENE REPORT, and the completion checklist. Step 5 of
run_all.py; also runnable standalone.

0. (v3.p3) REFUSES to touch anything while any Gemini-eligible passage lacks a
   resolved row-level outcome in the run (tag_passage_outcomes): applied /
   skipped_no_shortlist resolve; quarantined rows are UNRESOLVED and block
   finalize unless the maintainer explicitly passes --accept-quarantine (the
   rows are listed loudly either way).
1. (v3.p2) verse_chunks are now Gemini-tagged DIRECTLY, so there is NO parent→
   chunk inheritance step — every content table carries its own tags.
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

import argparse
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
    maintainer decides in a 10-minute pass. Counted over all five directly
    Gemini-tagged tables (v3.p2: verse_chunks now carry their own tags, so they
    are first-class corpus rows, not parent mirrors)."""
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
        " (v3.p2: verse_chunks are tagged directly, counted as first-class rows)",
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


def assert_run_resolved(run_id: str, allow_quarantined: bool = False) -> None:
    """REFUSE (SystemExit) unless every Gemini-eligible row has a RESOLVED
    row-level outcome in this run: applied or skipped_no_shortlist (plus
    quarantined ONLY under the explicit --accept-quarantine override — those are
    still listed loudly). v3.p3: this is the finalize gate that makes silent
    holes impossible — no index/report work happens over an incomplete run."""
    import tagging

    resolved = list(tagging.RESOLVED_OUTCOMES) + (["quarantined"] if allow_quarantined else [])
    unresolved_by_table: dict[str, int] = {}
    for table in config.GEMINI_TABLES:
        n = int(
            db.one(
                f"SELECT count(*) FROM public.{table} t"
                f" LEFT JOIN public.tag_passage_outcomes o"
                f"   ON o.run_id = %s::uuid AND o.table_name = %s AND o.passage_id = t.id"
                f"   AND o.outcome = ANY(%s)"
                f" WHERE t.embedding_context4 IS NOT NULL AND o.passage_id IS NULL",
                (run_id, table, resolved),
            )
            or 0
        )
        if n:
            unresolved_by_table[table] = n
    skipped = int(
        db.one(
            "SELECT count(*) FROM public.tag_passage_outcomes"
            " WHERE run_id = %s::uuid AND outcome = 'skipped_no_shortlist'",
            (run_id,),
        )
        or 0
    )
    quarantined = int(
        db.one(
            "SELECT count(*) FROM public.tag_passage_outcomes"
            " WHERE run_id = %s::uuid AND outcome = 'quarantined'",
            (run_id,),
        )
        or 0
    )
    if skipped:
        print(
            f"  note: {skipped} row(s) resolved as skipped_no_shortlist"
            " (no embedding/shortlist — explicitly listed, never silently covered).",
            flush=True,
        )
    if quarantined:
        print(f"  ⛔ {quarantined} QUARANTINED (unresolved) row(s) in run {run_id}:", flush=True)
        for table, pid, model, attempt, failure_class, history in tagging.quarantined_rows(run_id):
            print(
                f"    - {table} {pid} · {model} · attempt {attempt}"
                f" · {failure_class or '?'} · history {history}",
                flush=True,
            )
    if unresolved_by_table:
        detail = ", ".join(f"{t}: {n:,}" for t, n in unresolved_by_table.items())
        raise SystemExit(
            "⛔ FINALIZE REFUSED — this run has Gemini-eligible passages WITHOUT a"
            f" resolved row-level outcome ({detail}). Rerun `python run_all.py --resume`"
            " until every passage is applied/skipped"
            + ("" if allow_quarantined else
               "; quarantined rows require an explicit --accept-quarantine override")
            + ". Nothing was finalized."
        )
    print(
        "  row-level completion verified: every eligible passage is resolved"
        + (f" ({quarantined} quarantined ACCEPTED by override)" if quarantined and allow_quarantined else "")
        + ".",
        flush=True,
    )


def run(run_id: str | None = None, allow_quarantined: bool = False) -> None:
    if run_id is None:
        import audit

        run_id = audit.latest_run_id_for_prompt()
        if run_id is None:
            raise SystemExit(
                f"⛔ FINALIZE REFUSED — no tag run found for prompt {config.PROMPT_VERSION!r};"
                " run the pipeline first (finalize never runs over nothing)."
            )
    assert_run_resolved(run_id, allow_quarantined=allow_quarantined)
    verify_tsvectors()
    build_indexes()
    hygiene_report()
    print_completion_checklist()


def main() -> int:
    parser = argparse.ArgumentParser(description="Step 5 (standalone): finalize the tag run.")
    parser.add_argument(
        "--run-id", help="tag run to verify/finalize (default: latest run for this prompt version)"
    )
    parser.add_argument(
        "--accept-quarantine",
        action="store_true",
        help="proceed although quarantined (unresolved) rows exist — they are listed loudly",
    )
    args = parser.parse_args()
    config.require_keys()
    run(run_id=args.run_id, allow_quarantined=args.accept_quarantine)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
