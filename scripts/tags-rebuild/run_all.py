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
    python run_all.py --pilot-only run ONLY the v3.p3 pilot (open/freeze runs, validate the
                                   result files locally, retry invalid/missing rows once on
                                   their own model, escalate still-invalid standard rows once
                                   to MODEL_CORE, apply on a 100%% + distribution pass) and
                                   STOP before the full run. Requires vocabulary.json built.
    python run_all.py --bakeoff-model MODEL [--bakeoff-route all|core|standard]
                                   NO-DB-WRITE bakeoff: replay the banked p2 pilot request
                                   files verbatim through MODEL, track jobs in a local state
                                   file, and write shards/bakeoff_<model>_<route>_report.md
                                   + .json comparing against the banked p2 (3.5 Flash)
                                   results. Needs the maintainer-local banked p2 files.
    python run_all.py --accept-quarantine
                                   let the run finish + finalize although quarantined
                                   (unresolved) rows exist — they are listed loudly; every
                                   other unresolved state still refuses.

Steps (each idempotent):
  1. fts_core backfill               (touch rows WHERE fts_core IS NULL)
  2. vocabulary build + load         (vocabulary.json + vocab_terms; scope
                                      notes; merge PROPOSALS in "merges";
                                      vocabulary calls stay on MODEL_CORE)
  ⛔  THE ONE GATE: review vocabulary.json — terms, scope notes AND the MERGES
      section (veto a merge by editing the file) — then press Enter
      (skipped by --yes)
  3. pilot (v3.p3-hybrid)            (EXACT 2,000-row manifest: all p1-failures +
                                      matched p1-successes + fresh, stratified by
                                      table × length quartile, ROUTE-SPLIT per
                                      model; validate FILES before any DB content
                                      write; first-pass validity is DIAGNOSTIC;
                                      retry invalid/missing rows once on their own
                                      model, escalate still-invalid standard rows
                                      once to MODEL_CORE; require 100% row-level
                                      validity + distribution gates; apply
                                      atomically; pilot-report.md with per-model
                                      true cost incl. thinking + per-route
                                      full-run extrapolation + 40 skim samples)
  4. full tagging                    (two-model sharded Gemini Batch; machine-
                                      enforced MAX_SPEND_USD ceiling; ROW-LEVEL
                                      completion via tag_passage_outcomes with
                                      retry → escalation → quarantine; resumable)
  5. finalize                        (REFUSES while any passage is unresolved;
                                      tsvector verification; GIN indexes
                                      CONCURRENTLY; hygiene report; completion
                                      checklist)

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


def run_pilot(run_id: str, models: dict, vocab_index) -> None:
    """v3.p3 pilot: validate the banked result FILES locally BEFORE any DB
    content write. First-pass validity is DIAGNOSTIC (never an abort); every
    invalid/missing row auto-retries once on its own model; standard-route rows
    still invalid then escalate once to MODEL_CORE. The gate is 100% row-level
    validity after retry + escalation — still-invalid rows are listed explicitly
    (the would-be quarantine list) and the run STOPS with nothing applied. Then
    the distribution gates run and all 2,000 rows apply atomically."""
    import tagging

    prefix = tagging.pilot_prefix(run_id)
    if tagging.pilot_done(prefix) and config.PILOT_REPORT_PATH.exists():
        print("Step 3 · pilot: already complete (pilot-report.md exists).", flush=True)
        return
    print(
        f"Step 3 · pilot ({config.PILOT_SIZE:,} rows: all p1-failures + matched"
        f" p1-successes + fresh, seed {config.SAMPLE_SEED!r}; routed"
        f" core → {models['core']} / standard → {models['standard']})…",
        flush=True,
    )
    tagging.plan_pilot_shards(run_id)
    tagging.reconcile()
    tagging.submit_pending(vocab_index, run_id)

    # 1) Download results ONLY — no DB content writes yet. (Real usage IS
    #    recorded at retrieval, so the ledger counts this spend immediately.)
    tagging.collect(run_id, prefix, apply=False)

    # 2) First-pass schema validity — DIAGNOSTIC only; the gate comes after
    #    retry + escalation.
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
        f" (diagnostic — invalid/missing rows retry on their own model,"
        " still-invalid standard rows escalate once)",
        flush=True,
    )

    # 3) Retry every invalid/missing row exactly once, on the model that failed.
    retry_rows = tagging.plan_pilot_retry(run_id)
    if retry_rows:
        tagging.reconcile()
        tagging.submit_pending(vocab_index, run_id)
        tagging.collect(run_id, prefix, apply=False)

    # 4) Escalate still-invalid STANDARD-route rows once to MODEL_CORE.
    esc_rows = tagging.plan_pilot_escalation(run_id)
    if esc_rows:
        tagging.reconcile()
        tagging.submit_pending(vocab_index, run_id)
        tagging.collect(run_id, prefix, apply=False)

    # 5) THE GATE: 100% row-level validity after retry + escalation. Rows still
    #    invalid are the would-be quarantine list — listed, never applied.
    still = tagging.pilot_final_failures(prefix, run_id=run_id)
    n_still = sum(len(v) for v in still.values())
    # n_manifest counts first-pass RESPONSES; `still` may also contain rows whose
    # response line was missing entirely, so clamp the informational rate.
    final_rate = max(0.0, (n_manifest - n_still) / n_manifest) if n_manifest else 0.0
    validity = {"first_pass": first_pass, "retry_rows": retry_rows,
                "esc_rows": esc_rows, "final": final_rate}
    scan_final = tagging.scan_pilot_results(prefix)
    if n_still > 0:
        tagging.write_pilot_report(
            scan_final["stats"] or scan["stats"],
            [f"final row-level validity {final_rate:.4f} < {config.PILOT_FINAL_SCHEMA_VALID} "
             f"({n_still} row(s) still invalid after retry + escalation)"],
            models, failure_reasons=scan_final, run_id=run_id, validity=validity,
            unresolved=still,
        )
        raise SystemExit(
            f"⛔ PILOT VALIDATION FAILED — {n_still} row(s) still invalid after retry +"
            f" escalation (final {final_rate:.2%} < 100%). No DB content writes; the"
            f" still-invalid rows are listed in {config.PILOT_REPORT_PATH}"
        )

    # 6) Distribution gates on the FILES — still BEFORE any DB content write.
    dist_failures = tagging.pilot_thresholds_pass(scan_final["stats"])
    if dist_failures:
        tagging.write_pilot_report(
            scan_final["stats"], dist_failures, models,
            failure_reasons=scan_final, run_id=run_id, validity=validity,
        )
        raise SystemExit(
            "⛔ PILOT VALIDATION FAILED — distribution gate(s): "
            + "; ".join(dist_failures)
            + f". No DB content writes. See {config.PILOT_REPORT_PATH}"
        )

    # 7) All gates pass — apply every pilot row in ONE transaction (also writes
    #    the row-level outcome rows atomically).
    print(f"  all file-based gates PASS (final validity {final_rate:.2%}) — applying atomically.", flush=True)
    tagging.apply_pilot_bundle(run_id, prefix, vocab_index)

    # 8) Report from the DB (richer: evidence-found rate + skim samples).
    stats = tagging.pilot_stats_from_db(prefix)
    tagging.write_pilot_report(
        stats, [], models, failure_reasons=scan_final, run_id=run_id, validity=validity,
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
        models="(offline re-validation — Gemini not queried)",
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


def _print_quarantine(run_id: str, n_quarantined: int) -> None:
    import tagging

    rows = tagging.quarantined_rows(run_id)
    print(
        f"  ⛔ {n_quarantined} row(s) QUARANTINED as UNRESOLVED (retry + escalation"
        " exhausted) — listed explicitly, never silently dropped:",
        flush=True,
    )
    for table, pid, model, attempt, failure_class, history in rows:
        print(
            f"    - {table} {pid} · {model} · attempt {attempt}"
            f" · {failure_class or '?'} · history {history}",
            flush=True,
        )
    if n_quarantined > len(rows):
        print(f"    … and {n_quarantined - len(rows)} more (see tag_passage_outcomes)", flush=True)


def run_full(run_id: str, vocab_index, accept_quarantine: bool = False) -> bool:
    """Returns True when EVERY Gemini-eligible row has a resolved row-level
    outcome in this run (applied / skipped_no_shortlist). Quarantined rows are
    UNRESOLVED: the run is never marked complete while any exist, unless the
    maintainer explicitly passed --accept-quarantine (they are still listed).
    False when the cost ceiling, repeated shard failure, or quarantined rows
    stopped the run."""
    import db
    import tagging

    print("Step 4 · full tagging run (row-level completion)…", flush=True)
    prefix = tagging.full_prefix(run_id)
    for _ in range(MAX_WAVES_PER_INVOCATION):
        tagging.reconcile()
        tagging.plan_full_shards(run_id)
        tagging.submit_pending(vocab_index, run_id)
        in_flight = db.one(
            "SELECT count(*) FROM public.tag_batch_jobs"
            " WHERE run_id = %s::uuid AND status IN ('submitted','running','retrieved')",
            (run_id,),
        )
        if in_flight:
            tagging.collect(run_id, prefix)
        pending = db.one(
            "SELECT count(*) FROM public.tag_batch_jobs"
            " WHERE run_id = %s::uuid AND status='pending'",
            (run_id,),
        )
        if pending:
            print(
                f"  {pending} shard(s) still pending — the MAX_SPEND_USD ceiling"
                f" (${config.MAX_SPEND_USD:,.2f}) blocked submission. Nothing more will"
                " be spent. Review spend, adjust .env deliberately, and rerun with --resume.",
                flush=True,
            )
            return False
        tagging.quarantine_exhausted(run_id)
        status = tagging.unresolved_for_run(run_id)
        if status["unattempted"] == 0 and status["retryable"] == 0:
            if status["quarantined"]:
                _print_quarantine(run_id, status["quarantined"])
                if accept_quarantine:
                    print(
                        "  --accept-quarantine: continuing DESPITE the unresolved rows"
                        " above (maintainer override).",
                        flush=True,
                    )
                    return True
                print(
                    "  full tagging NOT complete: quarantined rows are unresolved."
                    " Rerun with --accept-quarantine only after reviewing them.",
                    flush=True,
                )
                return False
            print(
                "  full tagging complete — every eligible passage has a successfully"
                " applied result (or an explicit skip) in this run.",
                flush=True,
            )
            return True
        print(
            f"  {status['unattempted']:,} unattempted · {status['retryable']:,} awaiting"
            " retry/escalation — planning another wave.",
            flush=True,
        )
    print(
        f"  stopped after {MAX_WAVES_PER_INVOCATION} waves with rows still unresolved —"
        " inspect tag_batch_jobs / tag_passage_outcomes, then rerun with --resume.",
        flush=True,
    )
    return False


def confirm_both_models() -> dict:
    """Confirm BOTH routed models against the live models list. A failure on
    either is fatal — the harness never silently swaps or drops a route."""
    import gemini_client

    print("Preflight: confirming the exact current Gemini model strings…", flush=True)
    models = {
        "core": gemini_client.confirm_model(config.MODEL_CORE),
        "standard": gemini_client.confirm_model(config.MODEL_STANDARD),
    }
    print(f"  route core → {models['core']} · route standard → {models['standard']}", flush=True)
    return models


def pilot_only() -> int:
    """--pilot-only: run just the v3.p3 pilot and STOP before the full corpus run.
    Requires vocabulary.json to already be built (the ⛔ vocabulary gate is part of
    the full pipeline, not this path)."""
    config.require_keys()

    import audit
    import tagging

    models = confirm_both_models()
    audit.ensure_audit_tables()
    if not config.VOCAB_PATH.exists():
        raise SystemExit(
            f"FATAL: {config.VOCAB_PATH} is not built. Run the full pipeline through the"
            " vocabulary step (and its ⛔ review gate) first, then rerun with --pilot-only."
        )
    vocab_index = tagging.load_vocab_index()
    run_id = audit.open_or_create_run(models["core"], models["standard"])
    superseded = audit.supersede_prior_runs(run_id)
    if superseded:
        print(f"  froze {superseded} prior run(s) as superseded by {config.PROMPT_VERSION}.", flush=True)
    print(f"  tag run: {run_id} · prompt {config.PROMPT_VERSION} · vocab {audit.vocab_version()}", flush=True)

    run_pilot(run_id, models, vocab_index)

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
        help="run ONLY the v3.p3 pilot: preflight, open/freeze runs, validate the result files"
        " locally, retry failures once (same model) + escalate still-invalid standard rows to"
        " MODEL_CORE, apply on a 100%% + distribution pass, write the report,"
        " then STOP before the full corpus run",
    )
    parser.add_argument(
        "--bakeoff-model",
        metavar="MODEL",
        help="NO-DB-WRITE bakeoff: replay the banked p2 pilot request files verbatim through"
        " MODEL, track jobs in a local state file under shards/, download results, and write"
        " shards/bakeoff_<model>_<route>_report.md + .json comparing against the banked p2"
        " (3.5 Flash) results. Requires the maintainer-local banked p2 files.",
    )
    parser.add_argument(
        "--bakeoff-route",
        choices=["all", "core", "standard"],
        default="all",
        help="restrict the bakeoff to one route's subset of the p2 manifest (default: all)",
    )
    parser.add_argument(
        "--accept-quarantine",
        action="store_true",
        help="let the full run + finalize proceed although quarantined (unresolved) rows exist;"
        " they are listed loudly — every other unresolved state still refuses",
    )
    args = parser.parse_args()

    if args.doctor:
        import doctor

        return doctor.run()

    if args.revalidate_pilot:
        return revalidate_pilot()

    if args.bakeoff_model:
        import bakeoff

        return bakeoff.run(args.bakeoff_model, args.bakeoff_route)

    if args.pilot_only:
        return pilot_only()

    config.require_keys()

    import audit
    import backfill_fts_core
    import build_vocabulary
    import db  # noqa: F401 — imported for parity with the rest of the pipeline
    import finalize
    import tagging

    models = confirm_both_models()
    audit.ensure_audit_tables()

    print("Step 1 · fts_core backfill…", flush=True)
    backfill_fts_core.run()

    print("Step 2 · vocabulary build…", flush=True)
    build_vocabulary.run(models["core"])

    gate_vocabulary(skip=args.yes)

    vocab_index = tagging.load_vocab_index()
    run_id = audit.open_or_create_run(models["core"], models["standard"])
    superseded = audit.supersede_prior_runs(run_id)
    if superseded:
        print(f"  froze {superseded} prior run(s) as superseded by {config.PROMPT_VERSION}.", flush=True)
    print(f"  tag run: {run_id} · prompt {config.PROMPT_VERSION} · vocab {audit.vocab_version()}", flush=True)

    run_pilot(run_id, models, vocab_index)

    complete = run_full(run_id, vocab_index, accept_quarantine=args.accept_quarantine)
    if not complete:
        return 3

    print("Step 5 · finalize (unresolved-row gate, tsvectors, GIN indexes, hygiene report)…", flush=True)
    finalize.run(run_id=run_id, allow_quarantined=args.accept_quarantine)

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
