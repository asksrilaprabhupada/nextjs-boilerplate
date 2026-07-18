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
    python run_all.py --revalidate-pilot
                                   re-scan the ALREADY-banked shards/pilot_*.results.jsonl,
                                   recompute the pilot gates + a per-bucket breakdown of WHY
                                   schema-invalid rows failed, and rewrite pilot-report.md.
                                   No DB writes, no Gemini calls, no cost. Missing banked
                                   shards are reported as "cannot validate", never clean.
    python run_all.py --pilot-only run ONLY the v3.p2 pilot (open/freeze runs, validate the
                                   result files locally, retry failures once, apply on a
                                   100%% + distribution pass) and STOP before the full run.
                                   Requires vocabulary.json already built.

Steps (each idempotent):
  1. fts_core backfill               (touch rows WHERE fts_core IS NULL)
  2. vocabulary build + load         (vocabulary.json + vocab_terms; scope
                                      notes; merge PROPOSALS in "merges")
  ⛔  THE ONE GATE: review vocabulary.json — terms, scope notes AND the MERGES
      section (veto a merge by editing the file) — then press Enter
      (skipped by --yes)
  3. pilot (v3.p2)                   (EXACT 2,000-row manifest: all p1-failures +
                                      matched p1-successes + fresh, stratified by
                                      table × length quartile; validate FILES
                                      before any DB write; retry schema-invalid
                                      rows once; require 100% + distribution gates;
                                      apply atomically; pilot-report.md with true
                                      cost incl. thinking + full-run extrapolation +
                                      40 skim samples)
  4. full tagging                    (sharded Gemini Batch; machine-enforced
                                      MAX_SPEND_USD ceiling; run_id-scoped coverage;
                                      resumable)
  5. finalize                        (tsvector verification; GIN indexes
                                      CONCURRENTLY; hygiene report; completion
                                      checklist — verse_chunks are tagged directly,
                                      no inheritance step)

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
    """v3.p2 pilot: validate the banked result FILES locally BEFORE any DB write,
    auto-retry every schema-invalid row exactly once, require 100% schema validity
    AND all distribution gates on the files, then apply all 2,000 rows atomically."""
    import tagging

    prefix = config.PILOT_SHARD_PREFIX
    if tagging.pilot_done() and config.PILOT_REPORT_PATH.exists():
        print("Step 3 · pilot: already complete (pilot-report.md exists).", flush=True)
        return
    print(
        f"Step 3 · pilot ({config.PILOT_SIZE:,} rows: all p1-failures + matched"
        f" p1-successes + fresh, seed {config.SAMPLE_SEED!r})…",
        flush=True,
    )
    tagging.plan_pilot_shards(run_id)
    tagging.reconcile()
    tagging.submit_pending(model, vocab_index)

    # 1) Download results ONLY — no DB writes yet.
    tagging.collect(run_id, prefix, apply=False)

    # 2) First-pass schema validity (files).
    scan = tagging.scan_pilot_results(prefix)
    if not scan["files"] or scan["stats"] is None:
        raise SystemExit(
            f"⛔ PILOT: no banked result files under {config.SHARDS_DIR} to validate —"
            " cannot proceed (this is NOT a clean pass)."
        )
    n_manifest = scan["stats"]["responses"]
    first_pass = scan["stats"]["schema_valid_rate"]
    print(
        f"  first-pass schema validity: {first_pass:.2%} of {n_manifest}"
        f" (gate ≥ {config.PILOT_MIN_SCHEMA_VALID:.1%})",
        flush=True,
    )
    if first_pass < config.PILOT_MIN_SCHEMA_VALID:
        tagging.write_pilot_report(
            scan["stats"],
            [f"first-pass schema validity {first_pass:.3f} < {config.PILOT_MIN_SCHEMA_VALID}"],
            model, failure_reasons=scan, run_id=run_id,
            validity={"first_pass": first_pass, "retry_rows": 0, "final": first_pass},
        )
        raise SystemExit(
            f"⛔ PILOT VALIDATION FAILED — first-pass schema validity {first_pass:.2%}"
            f" < {config.PILOT_MIN_SCHEMA_VALID:.1%}. No DB writes. See {config.PILOT_REPORT_PATH}"
        )

    # 3) Retry every schema-invalid row exactly once.
    retry_rows = tagging.plan_pilot_retry(run_id)
    if retry_rows:
        tagging.reconcile()
        tagging.submit_pending(model, vocab_index)
        tagging.collect(run_id, prefix, apply=False)

    # 4) Require 100% after the single retry.
    still = tagging.pilot_final_failures(prefix)
    n_still = sum(len(v) for v in still.values())
    final_rate = (n_manifest - n_still) / n_manifest if n_manifest else 0.0
    validity = {"first_pass": first_pass, "retry_rows": retry_rows, "final": final_rate}
    scan_final = tagging.scan_pilot_results(prefix)
    if n_still > 0:
        tagging.write_pilot_report(
            scan_final["stats"] or scan["stats"],
            [f"final schema validity {final_rate:.4f} < {config.PILOT_FINAL_SCHEMA_VALID} "
             f"({n_still} row(s) still invalid after retry)"],
            model, failure_reasons=scan_final, run_id=run_id, validity=validity,
        )
        raise SystemExit(
            f"⛔ PILOT VALIDATION FAILED — {n_still} row(s) still schema-invalid after retry"
            f" (final {final_rate:.2%} < 100%). No DB writes. See {config.PILOT_REPORT_PATH}"
        )

    # 5) Distribution gates on the FILES — still BEFORE any DB write.
    dist_failures = tagging.pilot_thresholds_pass(scan_final["stats"])
    if dist_failures:
        tagging.write_pilot_report(
            scan_final["stats"], dist_failures, model,
            failure_reasons=scan_final, run_id=run_id, validity=validity,
        )
        raise SystemExit(
            "⛔ PILOT VALIDATION FAILED — distribution gate(s): "
            + "; ".join(dist_failures)
            + f". No DB writes. See {config.PILOT_REPORT_PATH}"
        )

    # 6) All gates pass — apply every pilot row in ONE transaction.
    print(f"  all file-based gates PASS (final validity {final_rate:.2%}) — applying atomically.", flush=True)
    tagging.apply_pilot_bundle(run_id, prefix, vocab_index)

    # 7) Report from the DB (richer: evidence-found rate + skim samples).
    stats = tagging.pilot_stats_from_db()
    tagging.write_pilot_report(
        stats, [], model, failure_reasons=scan_final, run_id=run_id, validity=validity,
    )
    print(
        "  pilot PASSED validation and applied — continuing automatically (standing ruling)."
        f" Report: {config.PILOT_REPORT_PATH}",
        flush=True,
    )


def revalidate_pilot() -> int:
    """No-cost re-validation of an ALREADY-banked pilot. Re-scans the banked
    shards/pilot_*.results.jsonl files, recomputes the pilot gates AND the
    schema-invalid failure buckets (from each row's own finishReason/blockReason),
    and rewrites pilot-report.md with the 'Schema-invalid failure reasons'
    section. NO DB writes, NO Gemini calls, NO cost. Missing banked shards are
    reported as 'cannot validate' — never as a clean pass.

    Returns 0 when the recomputed gates pass, 1 when they fail, 2 when there is
    nothing banked to validate."""
    import tagging

    print(
        "Re-validating the banked pilot offline (no DB writes · no Gemini · no cost)…",
        flush=True,
    )
    scan = tagging.scan_pilot_results(config.PILOT_SHARD_PREFIX)
    if not scan["files"]:
        print(
            f"⛔ No banked pilot shard files found under {config.SHARDS_DIR}"
            f" (looked for `{scan['pattern']}`). Nothing to re-validate — this is NOT"
            " a clean result. Run the pilot first (`python run_all.py`), then re-run"
            " `--revalidate-pilot`.",
            flush=True,
        )
        return 2

    stats = scan["stats"]
    failures = tagging.pilot_thresholds_pass(stats)
    tagging.write_pilot_report(
        stats,
        failures,
        model="(offline re-validation — Gemini not queried)",
        failure_reasons=scan,
        offline=True,
    )
    invalid = sum(scan["buckets"].values())
    print(
        f"  scanned {len(scan['files'])} banked shard file(s): {stats['responses']:,} responses,"
        f" schema-valid {stats['schema_valid_rate']:.1%}, {invalid} schema-invalid.",
        flush=True,
    )
    if invalid:
        breakdown = ", ".join(f"{bucket}={n}" for bucket, n in scan["buckets"].items() if n)
        print(f"  schema-invalid failure reasons — {breakdown}", flush=True)
    if failures:
        print("⛔ Recomputed gates FAIL: " + "; ".join(failures), flush=True)
        print(f"  See {config.PILOT_REPORT_PATH}.", flush=True)
        return 1
    print(f"  Recomputed gates PASS. See {config.PILOT_REPORT_PATH}.", flush=True)
    return 0


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
        # v3.p2: remaining is run_id-scoped (matches plan_full_shards), so a p2
        # full run retags every eligible row not yet covered by this run.
        remaining = tagging.remaining_for_run(run_id)
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


def pilot_only() -> int:
    """--pilot-only: run just the v3.p2 pilot and STOP before the full corpus run.
    Requires vocabulary.json to already be built (the ⛔ vocabulary gate is part of
    the full pipeline, not this path)."""
    config.require_keys()

    import audit
    import gemini_client
    import tagging

    print("Preflight: confirming the exact current Gemini model string…", flush=True)
    model = gemini_client.confirm_model()
    print(f"  model: {model}", flush=True)
    audit.ensure_audit_tables()
    if not config.VOCAB_PATH.exists():
        raise SystemExit(
            f"FATAL: {config.VOCAB_PATH} is not built. Run the full pipeline through the"
            " vocabulary step (and its ⛔ review gate) first, then rerun with --pilot-only."
        )
    vocab_index = tagging.load_vocab_index()
    run_id = audit.open_or_create_run(model)
    superseded = audit.supersede_prior_runs(run_id)
    if superseded:
        print(f"  froze {superseded} prior run(s) as superseded by {config.PROMPT_VERSION}.", flush=True)
    print(f"  tag run: {run_id} · prompt {config.PROMPT_VERSION} · vocab {audit.vocab_version()}", flush=True)

    run_pilot(run_id, model, vocab_index)

    print(
        f"\nPILOT COMPLETE ({config.PROMPT_VERSION}). The full corpus run was NOT started"
        f" (--pilot-only). Review {config.PILOT_REPORT_PATH}; run `python run_all.py --resume`"
        " to continue into full tagging when ready.",
        flush=True,
    )
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Tags & FTS rebuild — one resumable command (see module docstring)."
    )
    parser.add_argument("--doctor", action="store_true", help="read-only readiness checks; changes nothing")
    parser.add_argument("--resume", action="store_true", help="continue a previous run (resume is automatic; flag documents intent)")
    parser.add_argument("--yes", action="store_true", help="skip the ⛔ vocabulary review gate (standing one-shot ruling)")
    parser.add_argument(
        "--revalidate-pilot",
        action="store_true",
        help="re-scan banked shards/pilot_*.results.jsonl, recompute the pilot gates +"
        " schema-invalid failure buckets, rewrite pilot-report.md (no DB writes, no Gemini, no cost)",
    )
    parser.add_argument(
        "--pilot-only",
        action="store_true",
        help="run ONLY the v3.p2 pilot: preflight, open/freeze runs, validate the result files"
        " locally, retry failures once, apply on a 100%% + distribution pass, write the report,"
        " then STOP before the full corpus run",
    )
    args = parser.parse_args()

    if args.doctor:
        import doctor

        return doctor.run()

    if args.revalidate_pilot:
        return revalidate_pilot()

    if args.pilot_only:
        return pilot_only()

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
    superseded = audit.supersede_prior_runs(run_id)
    if superseded:
        print(f"  froze {superseded} prior run(s) as superseded by {config.PROMPT_VERSION}.", flush=True)
    print(f"  tag run: {run_id} · prompt {config.PROMPT_VERSION} · vocab {audit.vocab_version()}", flush=True)

    run_pilot(run_id, model, vocab_index)

    complete = run_full(run_id, model, vocab_index)
    if not complete:
        return 3

    print("Step 5 · finalize (tsvectors, GIN indexes, hygiene report)…", flush=True)
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
