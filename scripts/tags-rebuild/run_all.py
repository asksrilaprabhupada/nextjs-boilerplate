"""
run_all.py — ONE command for the whole tags+FTS data build. Resumable: every
step checks live state first, so `python run_all.py --resume` after a crash,
Ctrl+C, or a deliberate shutdown (batch jobs run server-side up to 24h)
continues exactly where the previous invocation stopped.

    python run_all.py --doctor     read-only readiness checklist; changes nothing
    python run_all.py              full pipeline (stops at the ⛔ vocabulary gate)
    python run_all.py --resume     rerun/continue (same as above; the flag documents intent)
    python run_all.py --yes        skip the ⛔ vocabulary review gate entirely
                                   (the maintainer's standing one-shot ruling)

Steps (each idempotent):
  1. fts_core backfill               (touch rows WHERE fts_core IS NULL)
  2. vocabulary build + load         (vocabulary.json + vocab_terms; scope
                                      notes; merge PROPOSALS in "merges")
  ⛔  THE ONE GATE: review vocabulary.json — terms, scope notes AND the MERGES
      section (veto a merge by editing the file) — then press Enter
      (skipped by --yes)
  3. pilot                           (2,000 seeded-random stratified passages;
                                      auto-gates + pilot-report.md with the
                                      real extrapolated cost + 30 skim samples;
                                      auto-continue per the standing ruling
                                      unless a gate fails)
  4. full tagging                    (sharded Gemini Batch; machine-enforced
                                      MAX_SPEND_USD ceiling; resumable)
  5. finalize                        (verse_chunks inheritance; tsvector
                                      verification; GIN indexes CONCURRENTLY;
                                      hygiene report; completion checklist)

The harness only ever writes the NEW columns (tags_core, questions,
fts_expansion_src, passage_function + their trigger-derived tsvectors) and its
own support tables — the old tags/fts columns and the live search stay
untouched.
"""
from __future__ import annotations

import argparse
import sys

import config

MAX_WAVES_PER_INVOCATION = 5


def gate_vocabulary(skip: bool) -> None:
    if skip:
        print("⛔ gate skipped (--yes): vocabulary accepted by standing ruling.", flush=True)
        return
    print(
        f"\n⛔ Review {config.VOCAB_PATH} — the terms with their scope notes AND"
        " the \"merges\" section (every entry is a PROPOSAL; veto one by editing"
        " the file: rename/split/re-add terms). Then press Enter to continue.",
        flush=True,
    )
    try:
        input()
    except EOFError:
        raise SystemExit(
            "FATAL: no interactive stdin for the vocabulary gate. Rerun with --yes"
            " (standing one-shot ruling) or from an interactive terminal."
        )


def run_pilot(run_id: str, model: str, vocab_index) -> None:
    import tagging

    if tagging.pilot_done() and config.PILOT_REPORT_PATH.exists():
        print("Step 3 · pilot: already complete (pilot-report.md exists).", flush=True)
        return
    print(
        f"Step 3 · pilot ({config.PILOT_SIZE:,} seeded-random stratified passages,"
        f" seed {config.SAMPLE_SEED!r})…",
        flush=True,
    )
    tagging.plan_pilot_shards(run_id)
    tagging.reconcile()
    tagging.submit_pending(model, vocab_index)
    tagging.collect(run_id, shard_key_prefix="pilot:")
    stats = tagging.pilot_stats_from_db()
    failures = tagging.pilot_thresholds_pass(stats)
    tagging.write_pilot_report(stats, failures, model)
    if failures:
        raise SystemExit(
            "⛔ PILOT VALIDATION FAILED — run stopped. See "
            f"{config.PILOT_REPORT_PATH} :: " + "; ".join(failures)
        )
    print(
        "  pilot PASSED validation — continuing automatically (standing ruling)."
        f" Report: {config.PILOT_REPORT_PATH}",
        flush=True,
    )


def run_full(run_id: str, model: str, vocab_index) -> bool:
    """Returns True when every Gemini-eligible row is tagged; False when the
    cost ceiling (or repeated shard failure) stopped the run early."""
    import db
    import tagging

    print("Step 4 · full tagging run…", flush=True)
    for _ in range(MAX_WAVES_PER_INVOCATION):
        tagging.reconcile()
        tagging.plan_full_shards(run_id)
        tagging.submit_pending(model, vocab_index)
        in_flight = db.one(
            "SELECT count(*) FROM public.tag_batch_jobs"
            " WHERE status IN ('submitted','running','retrieved')"
        )
        if in_flight:
            tagging.collect(run_id)
        pending = db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE status='pending'")
        if pending:
            print(
                f"  {pending} shard(s) still pending — the MAX_SPEND_USD ceiling"
                f" (${config.MAX_SPEND_USD:,.2f}) blocked submission. Nothing more will"
                " be spent. Review spend, adjust .env deliberately, and rerun with --resume.",
                flush=True,
            )
            return False
        remaining = sum(
            db.table_count(t, "tags_core IS NULL AND embedding_context4 IS NOT NULL")
            for t in config.GEMINI_TABLES
        )
        if remaining == 0:
            print("  full tagging complete — every eligible passage processed.", flush=True)
            return True
        print(f"  {remaining:,} rows still untagged — planning another wave.", flush=True)
    print(
        f"  stopped after {MAX_WAVES_PER_INVOCATION} waves with rows still untagged —"
        " inspect failed shards in tag_batch_jobs, then rerun with --resume.",
        flush=True,
    )
    return False


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Tags & FTS rebuild — one resumable command (see module docstring)."
    )
    parser.add_argument("--doctor", action="store_true", help="read-only readiness checks; changes nothing")
    parser.add_argument("--resume", action="store_true", help="continue a previous run (resume is automatic; flag documents intent)")
    parser.add_argument("--yes", action="store_true", help="skip the ⛔ vocabulary review gate (standing one-shot ruling)")
    args = parser.parse_args()

    if args.doctor:
        import doctor

        return doctor.run()

    config.require_keys()

    import audit
    import backfill_fts_core
    import build_vocabulary
    import db
    import finalize
    import gemini_client
    import tagging

    print("Preflight: confirming the exact current Gemini model string…", flush=True)
    model = gemini_client.confirm_model()
    print(f"  model: {model}", flush=True)
    audit.ensure_audit_tables()

    print("Step 1 · fts_core backfill…", flush=True)
    backfill_fts_core.run()

    print("Step 2 · vocabulary build…", flush=True)
    build_vocabulary.run(model)

    gate_vocabulary(skip=args.yes)

    vocab_index = tagging.load_vocab_index()
    run_id = audit.open_or_create_run(model)
    print(f"  tag run: {run_id} · prompt {config.PROMPT_VERSION} · vocab {audit.vocab_version()}", flush=True)

    run_pilot(run_id, model, vocab_index)

    complete = run_full(run_id, model, vocab_index)
    if not complete:
        return 3

    print("Step 5 · finalize (inheritance, tsvectors, GIN indexes, hygiene report)…", flush=True)
    finalize.run()

    ledger = tagging.spend_ledger()
    audit.finish_run(run_id, notes=f"complete; real spend ${ledger['real_usd']:,.2f}")
    print(
        f"\nDONE. Real spend ${ledger['real_usd']:,.2f}"
        f" (ceiling ${config.MAX_SPEND_USD:,.2f}). Old tags/fts untouched;"
        " new columns + indexes ready for the Phase 6 search wiring.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print(
            "\nInterrupted — state is saved in tag_batch_jobs; submitted batch jobs"
            " keep running server-side. Rerun `python run_all.py --resume` to continue.",
            flush=True,
        )
        sys.exit(130)
