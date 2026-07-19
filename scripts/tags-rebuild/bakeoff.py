"""
bakeoff.py — NO-DB-WRITE model bakeoff (v3.p3-hybrid).

`python run_all.py --bakeoff-model MODEL [--bakeoff-route all|core|standard]`
replays the banked p2 pilot REQUEST files **verbatim** through MODEL and writes
a comparison report against the banked p2 (gemini-3.5-flash) RESULTS:
schema validity + failure buckets + invalid ids, per-route tag agreement
(exact-set match, mean/median Jaccard, exhaustive baseline-only/candidate-only
tag tables), passage_function agreement + confusion pairs, seeded side-by-side
question samples, token totals and TRUE cost at each model's pinned prices.

Verbatim replay means the comparison is apples-to-apples by construction: the
same prompts, the same responseSchema (closed enums), the same explicit
thinkingConfig.thinkingLevel=LOW already baked into every banked request line.

DATABASE ACCESS IS READ-ONLY (SELECTs for route classification, the p2 manifest
assertion, and the committed-spend ledger). tag_batch_jobs, the audit DDL and
the content tables are NEVER touched — job state lives exclusively in a local
JSON state file under shards/ (git-ignored), so a crash resumes from the state
file, reconciling against Google's job list by display name first.

Prerequisites (maintainer-local): the banked p2 files
shards/pilot_p2_*.requests.jsonl + shards/pilot_p2_*.results.jsonl (git-ignored
— absent in fresh checkouts; the bakeoff exits 2 loudly, never "clean"), plus
GEMINI_API_KEY and DATABASE_URL. The MAX_SPEND_USD ceiling applies: committed
DB spend + this bakeoff's own real/estimated spend must stay under it.
"""
from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import config
import db
import gemini_client
import routing
import tagging

# Single-pass by design: the bakeoff never retries rows (the pipeline's
# retry/escalation ladder is what the pilot exercises); a failed batch job is
# reported, not re-run — rerunning `--bakeoff-model` resumes/completes it.
BASELINE_MODEL = "gemini-3.5-flash"  # what the banked p2 results were produced by


def _require_bakeoff_keys() -> None:
    missing = [
        name for name, value in (
            ("GEMINI_API_KEY", config.GEMINI_API_KEY),
            ("DATABASE_URL", config.DATABASE_URL),
        ) if not value
    ]
    if missing:
        raise SystemExit(
            "FATAL: bakeoff needs " + ", ".join(missing) + " (Gemini Batch + read-only"
            " route/manifest/ledger SELECTs). See `python run_all.py --doctor`."
        )


# ── banked p2 artifacts ─────────────────────────────────────────────────────

def _p2_base() -> str:
    return config.P2_PILOT_SHARD_PREFIX.replace(":", "_")


def load_banked_requests() -> dict[str, str]:
    """'table|id' → raw request-line JSON from the banked FIRST-PASS p2 request
    files, byte-identical (same prompt/schema/LOW thinking as the baseline saw)."""
    paths = [
        p for p in sorted(config.SHARDS_DIR.glob(f"{_p2_base()}*.requests.jsonl"))
        if "_retry_" not in p.name
    ]
    out: dict[str, str] = {}
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    key = json.loads(line).get("key")
                except json.JSONDecodeError:
                    raise SystemExit(f"FATAL: unparseable banked request line in {path.name}")
                if key and "|" in key:
                    out[key] = line
    return out


def baseline_map() -> dict[str, dict]:
    """'table|id' → baseline row from the banked p2 RESULTS, with the p2 retry
    rescue applied exactly as pilot_final_failures would: a first-pass-invalid
    key rescued by a valid retry response counts as valid. Rows invalid even
    after the rescue are kept with parsed=None (listed + excluded from
    agreement denominators, never silently dropped)."""
    first = [
        p for p in sorted(config.SHARDS_DIR.glob(f"{_p2_base()}*.results.jsonl"))
        if "_retry_" not in p.name
    ]
    retry = sorted(config.SHARDS_DIR.glob(f"{_p2_base()}retry_*.results.jsonl"))
    out: dict[str, dict] = {}
    for paths, is_retry in ((first, False), (retry, True)):
        for path in paths:
            with open(path, encoding="utf-8") as f:
                for line in f:
                    if not line.strip():
                        continue
                    key, parsed, usage, error, fr, br = tagging._parse_response_line(line)
                    if not key or "|" not in (key or ""):
                        continue
                    row = out.get(key)
                    valid = parsed is not None and not error
                    if row is None:
                        out[key] = {
                            "parsed": parsed if valid else None,
                            "usage": usage,
                            "bucket": None if valid else tagging.classify_schema_failure(error, fr, br),
                            "from_retry": is_retry,
                        }
                    elif valid and row["parsed"] is None:
                        # retry (or duplicate) rescue: first valid response wins
                        row.update(parsed=parsed, bucket=None, from_retry=is_retry)
                    # usage: keep first-pass usage for cost honesty; retry usage
                    # was billed to p2 as well but belongs to its rescue pass —
                    # the report prices baseline cost from FIRST-PASS usage only
                    # and says so.
    return out


def p2_manifest_keys() -> set[str]:
    """READ-ONLY: the frozen 2,000-row p2 manifest as 'table|id' keys from the
    first-pass pilot:p2: shard rows."""
    rows = db.rows(
        "SELECT table_name, unnest(id_list)::text FROM public.tag_batch_jobs"
        " WHERE shard_key LIKE %s AND shard_key NOT LIKE %s",
        (config.P2_PILOT_SHARD_PREFIX + "%", config.P2_PILOT_SHARD_PREFIX + "retry:%"),
    )
    return {f"{t}|{pid}" for t, pid in rows}


def routes_for_keys(keys: set[str]) -> dict[str, str]:
    """READ-ONLY route classification for every 'table|id' key (verses and
    verse_chunks via the routed SQL; everything else is standard by rule)."""
    by_table: dict[str, list[str]] = {}
    for key in keys:
        table, pid = key.split("|", 1)
        by_table.setdefault(table, []).append(pid)
    out: dict[str, str] = {}
    for table, ids in by_table.items():
        if table not in routing.ROUTED_TABLES:
            for pid in ids:
                out[f"{table}|{pid}"] = "standard"
            continue
        join, expr = routing.route_sql(table)
        for pid, route in db.rows(
            f"SELECT t.id::text, {expr} FROM public.{table} t{join}"
            f" WHERE t.id = ANY(%s::uuid[])",
            (sorted(ids),),
        ):
            out[f"{table}|{pid}"] = route
        for pid in ids:  # ids missing from the table (deleted rows) stay standard
            out.setdefault(f"{table}|{pid}", "standard")
    return out


# ── local job state (the ONLY place bakeoff jobs are recorded) ──────────────

def load_state(model: str, route: str) -> dict:
    path = config.bakeoff_state_path(model, route)
    if path.exists():
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    return {"model": model, "route": route, "shards": {}}


def save_state(model: str, route: str, state: dict) -> None:
    path = config.bakeoff_state_path(model, route)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(state, f, indent=1, sort_keys=True)
    tmp.replace(path)


def _state_local_usd(state: dict) -> float:
    """Committed spend of one bakeoff state file, priced at ITS OWN recorded
    model: real usage where present, else the in-flight estimate for
    submitted/running shards."""
    m = state.get("model") or ""
    total = 0.0
    for shard in state.get("shards", {}).values():
        usage = shard.get("usage") or {}
        if usage:
            total += tagging._usd(m, usage.get("in", 0), usage.get("out", 0))
        elif shard.get("job") and shard.get("status") in ("submitted", "running"):
            total += tagging._usd(m, shard.get("est_in", 0), shard.get("est_out", 0))
    return total


def _sibling_bakeoff_usd(exclude: Path) -> float:
    """Committed spend of every OTHER bakeoff state file on disk, each priced at
    its own model — so concurrent/prior sibling bakeoffs (other models or routes)
    count toward the shared MAX_SPEND_USD ceiling instead of each ignoring the
    others. The active run's own file is excluded; its (newer, maybe unsaved)
    spend is added from the in-memory state by the caller."""
    total = 0.0
    for path in sorted(config.SHARDS_DIR.glob("bakeoff_*.state.json")):
        if path == exclude:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                total += _state_local_usd(json.load(f))
        except (OSError, json.JSONDecodeError):
            continue
    return total


def _bakeoff_committed_usd(state: dict, model: str) -> float:
    """Ceiling basis for a NO-DB-WRITE bakeoff: committed DB spend + this
    bakeoff's own spend (in-memory) + every sibling bakeoff's spend on disk.

    DB spend is read with a SCHEMA-AGNOSTIC query (only columns present on both
    the p2 and p3 schemas, priced at the canonical core rate). Bakeoff never runs
    the p3 audit DDL, so the full ledger's `price_*` columns may not exist yet —
    and a query error there must NEVER be silently read as $0 committed spend.
    Only a genuinely unreachable DB falls back to $0, and it says so loudly."""
    try:
        committed = tagging.committed_usd_schema_agnostic()
    except (Exception, SystemExit) as exc:  # noqa: BLE001
        committed = 0.0
        print(
            f"  ⚠ bakeoff: DB committed spend unreadable ({str(exc)[:150]}) — the"
            " ceiling floor is treating DB spend as $0. Confirm no paid pipeline"
            " run is in flight before continuing.",
            flush=True,
        )
    committed += _state_local_usd(state)
    committed += _sibling_bakeoff_usd(
        config.bakeoff_state_path(state.get("model", model), state.get("route", "all"))
    )
    return committed


# ── submit / reconcile / collect (state-file only) ──────────────────────────

def _plan_shards(model: str, route: str, requests: dict[str, str],
                 routes: dict[str, str], state: dict) -> None:
    """Group the (route-filtered) banked request lines into token-capped shards
    under bakeoff:{model}:{route}:{table}:{i:03d} and write their request files.
    Idempotent: already-planned shards in the state file are left alone."""
    if state["shards"]:
        return
    by_table: dict[str, list[str]] = {}
    for key, raw in sorted(requests.items()):
        if route != "all" and routes.get(key, "standard") != route:
            continue
        table = key.split("|", 1)[0]
        by_table.setdefault(table, []).append(raw)
    for table, lines in sorted(by_table.items()):
        index = 0
        current: list[str] = []
        current_tok = 0
        def flush() -> None:
            nonlocal index, current, current_tok
            if not current:
                return
            shard_key = f"bakeoff:{model}:{route}:{table}:{index:03d}"
            path = tagging.shard_request_path(shard_key)
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write("\n".join(current) + "\n")
            state["shards"][shard_key] = {
                "table": table,
                "rows": len(current),
                "est_in": current_tok,
                "est_out": len(current) * config.EST_OUTPUT_TOKENS_PER_PASSAGE,
                "status": "pending",
                "job": None,
                "usage": None,
            }
            index += 1
            current, current_tok = [], 0
        for raw in lines:
            tok = len(raw) // 4
            if current and (current_tok + tok > config.MAX_SHARD_INPUT_TOKENS
                            or len(current) >= config.SHARD_SIZE):
                flush()
            current.append(raw)
            current_tok += tok
        flush()
    save_state(model, route, state)
    total = sum(s["rows"] for s in state["shards"].values())
    print(f"  planned {len(state['shards'])} bakeoff shard(s) over {total} request(s).", flush=True)


def reconcile_state(model: str, route: str, state: dict) -> None:
    """Adopt accepted-but-unrecorded jobs from Google's list by display name —
    same crash-safety as the pipeline's reconcile, but against the state file."""
    unrecorded = {k for k, s in state["shards"].items() if s["status"] == "pending" and not s["job"]}
    if not unrecorded:
        return
    prefix = config.BATCH_DISPLAY_PREFIX + ":"
    try:
        for job in gemini_client.list_batches():
            display = job.get("display_name") or ""
            shard_key = display[len(prefix):] if display.startswith(prefix) else ""
            if shard_key in unrecorded and job.get("name"):
                state["shards"][shard_key].update(job=job["name"], status="submitted")
    except Exception as exc:  # noqa: BLE001
        print(f"  bakeoff reconcile: Google job list unavailable ({exc})", flush=True)
        return
    save_state(model, route, state)


def submit(model: str, route: str, state: dict) -> None:
    for shard_key, shard in sorted(state["shards"].items()):
        if shard["status"] != "pending" or shard["job"]:
            continue
        projected = _bakeoff_committed_usd(state, model) + tagging._usd(
            model, shard["est_in"], shard["est_out"]
        )
        if projected > config.MAX_SPEND_USD:
            print(
                f"  ⛔ COST CEILING: submitting {shard_key} would commit"
                f" ~${projected:,.2f} > MAX_SPEND_USD=${config.MAX_SPEND_USD:,.2f}."
                " Stopping bakeoff submission (rerun after reviewing spend).",
                flush=True,
            )
            return
        display_name = f"{config.BATCH_DISPLAY_PREFIX}:{shard_key}"
        file_name = db.with_retry(
            lambda sk=shard_key: gemini_client.upload_jsonl(tagging.shard_request_path(sk), display_name),
            f"bakeoff upload {shard_key}",
        )
        job_name = db.with_retry(
            lambda: gemini_client.create_batch(model, file_name, display_name),
            f"bakeoff batch create {shard_key}",
        )
        shard.update(job=job_name, status="submitted")
        save_state(model, route, state)
        print(f"  submitted {shard_key} → {job_name} ({model})", flush=True)


def collect(model: str, route: str, state: dict) -> None:
    while True:
        open_shards = {
            k: s for k, s in state["shards"].items()
            if s["job"] and s["status"] in ("submitted", "running")
        }
        if not open_shards:
            return
        progressed = False
        for shard_key, shard in sorted(open_shards.items()):
            job = db.with_retry(
                lambda name=shard["job"]: gemini_client.get_batch(name),
                f"bakeoff poll {shard_key}",
            )
            state_name = job["state"]
            if state_name == "BATCH_STATE_RUNNING" and shard["status"] != "running":
                shard["status"] = "running"
                progressed = True
            elif state_name == gemini_client.SUCCESS_STATE:
                if not job.get("output_file"):
                    shard.update(status="failed", error="succeeded but no output file")
                    progressed = True
                    continue
                results_path = config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.results.jsonl"
                db.with_retry(
                    lambda j=job, p=results_path: gemini_client.download_file(j["output_file"], p),
                    f"bakeoff download {shard_key}",
                )
                in_tok, out_tok, cand_tok, thought_tok = tagging.usage_from_results_file(results_path)
                shard.update(
                    status="done",
                    usage={"in": in_tok, "out": out_tok, "cand": cand_tok, "thought": thought_tok},
                )
                progressed = True
                print(f"  downloaded {shard_key}", flush=True)
            elif state_name in gemini_client.TERMINAL_STATES:
                shard.update(status="failed", error=f"batch ended in {state_name}")
                progressed = True
                print(f"  FAILED {shard_key}: {state_name}", flush=True)
        save_state(model, route, state)
        if not progressed:
            print(
                f"  waiting on {len(open_shards)} bakeoff shard(s) — polling every"
                f" {config.BATCH_POLL_SECONDS}s (Ctrl+C is safe; rerun to resume)",
                flush=True,
            )
            time.sleep(config.BATCH_POLL_SECONDS)


# ── comparison (pure over files; unit-testable) ─────────────────────────────

def gate_tags_offline(parsed: dict, vocab_slugs: set[str]) -> list[str]:
    """The same offline tag gate scan_pilot_results applies: out-of-vocabulary
    is a HARD drop, in-vocab tags are deduped, capped at MAX_TAGS."""
    accepted: list[str] = []
    for item in (parsed.get("tags") or [])[: config.MAX_TAGS]:
        if not isinstance(item, dict):
            continue
        tag = str(item.get("tag") or "").strip()
        if tag and tag in vocab_slugs and tag not in accepted:
            accepted.append(tag)
    return accepted


def jaccard(a: set[str], b: set[str]) -> float:
    if not a and not b:
        return 1.0  # two empty tag sets agree perfectly
    union = a | b
    return len(a & b) / len(union) if union else 1.0


def _median(values: list[float]) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    mid = len(s) // 2
    return s[mid] if len(s) % 2 else (s[mid - 1] + s[mid]) / 2.0


def candidate_map(model: str, route: str) -> dict[str, dict]:
    """'table|id' → candidate row from the bakeoff result files (single pass,
    first valid response wins on duplicates)."""
    base = f"bakeoff_{model}_{route}_"
    out: dict[str, dict] = {}
    for path in sorted(config.SHARDS_DIR.glob(f"{base}*.results.jsonl")):
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                key, parsed, usage, error, fr, br = tagging._parse_response_line(line)
                if not key or "|" not in (key or ""):
                    continue
                valid = parsed is not None and not error
                row = out.get(key)
                if row is None:
                    out[key] = {
                        "parsed": parsed if valid else None,
                        "usage": usage,
                        "bucket": None if valid else tagging.classify_schema_failure(error, fr, br),
                    }
                elif valid and row["parsed"] is None:
                    row.update(parsed=parsed, bucket=None)
    return out


def compare_rows(baseline: dict[str, dict], candidate: dict[str, dict],
                 routes: dict[str, str], vocab_slugs: set[str],
                 questions_sample: int, sample_seed: str) -> dict:
    """Pure comparison over the two maps. Keys compared = candidate keys that
    exist in baseline; baseline-invalid rows are EXCLUDED from agreement
    denominators and listed; candidate-invalid rows count against candidate
    schema validity and are listed."""
    per_route: dict[str, dict] = {}
    baseline_invalid: list[str] = []
    candidate_invalid: dict[str, str] = {}
    fn_pairs: dict[tuple[str, str], int] = {}
    question_rows: list[dict] = []

    for key in sorted(candidate):
        if key not in baseline:
            continue
        route = routes.get(key, "standard")
        r = per_route.setdefault(route, {
            "compared": 0, "exact": 0, "jaccards": [],
            "tags_both": {}, "tags_baseline_only": {}, "tags_candidate_only": {},
            "fn_total": 0, "fn_agree": 0,
        })
        cand_row = candidate[key]
        base_row = baseline[key]
        if cand_row["parsed"] is None:
            candidate_invalid[key] = cand_row.get("bucket") or "?"
            continue
        if base_row["parsed"] is None:
            baseline_invalid.append(key)
            continue
        r["compared"] += 1
        b_tags = set(gate_tags_offline(base_row["parsed"], vocab_slugs))
        c_tags = set(gate_tags_offline(cand_row["parsed"], vocab_slugs))
        r["jaccards"].append(jaccard(b_tags, c_tags))
        if b_tags == c_tags:
            r["exact"] += 1
        for tag in b_tags & c_tags:
            r["tags_both"][tag] = r["tags_both"].get(tag, 0) + 1
        for tag in b_tags - c_tags:
            r["tags_baseline_only"][tag] = r["tags_baseline_only"].get(tag, 0) + 1
        for tag in c_tags - b_tags:
            r["tags_candidate_only"][tag] = r["tags_candidate_only"].get(tag, 0) + 1

        b_fn = str(base_row["parsed"].get("passage_function") or "").strip() or "(none)"
        c_fn = str(cand_row["parsed"].get("passage_function") or "").strip() or "(none)"
        r["fn_total"] += 1
        if b_fn == c_fn:
            r["fn_agree"] += 1
        else:
            fn_pairs[(b_fn, c_fn)] = fn_pairs.get((b_fn, c_fn), 0) + 1

        b_q = [str(q.get("question") or "").strip()
               for q in (base_row["parsed"].get("questions") or []) if isinstance(q, dict)]
        c_q = [str(q.get("question") or "").strip()
               for q in (cand_row["parsed"].get("questions") or []) if isinstance(q, dict)]
        if b_q or c_q:
            question_rows.append({"key": key, "baseline": b_q, "candidate": c_q})

    question_rows.sort(key=lambda r: hashlib.md5((sample_seed + r["key"]).encode()).hexdigest())
    for r in per_route.values():
        r["jaccard_mean"] = (sum(r["jaccards"]) / len(r["jaccards"])) if r["jaccards"] else 0.0
        r["jaccard_median"] = _median(r["jaccards"])
        del r["jaccards"]
    return {
        "per_route": per_route,
        "baseline_invalid": baseline_invalid,
        "candidate_invalid": candidate_invalid,
        "function_confusions": {f"{b} → {c}": n for (b, c), n in
                                sorted(fn_pairs.items(), key=lambda kv: -kv[1])},
        "question_samples": question_rows[:questions_sample],
    }


def _tag_table_lines(counts: dict[str, int], limit: int = 30) -> list[str]:
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    lines = [f"  - `{tag}`: {n}" for tag, n in ranked[:limit]]
    if len(ranked) > limit:
        lines.append(f"  - … and {len(ranked) - limit} more tag(s)")
    return lines or ["  - (none)"]


def write_bakeoff_report(model: str, route: str, cmp: dict, costs: dict,
                         meta: dict) -> tuple[Path, Path]:
    md_path = config.bakeoff_report_path(model, route, "md")
    json_path = config.bakeoff_report_path(model, route, "json")
    lines = [
        f"# Bakeoff — `{model}` vs banked p2 `{BASELINE_MODEL}` (route: {route})",
        "",
        f"- Generated: {datetime.now(timezone.utc).isoformat()}",
        f"- Requests replayed VERBATIM from the banked p2 files ({meta['requests']} rows"
        f" after the route filter; manifest {meta['manifest_rows']} rows,"
        f" {meta['manifest_skipped']} never sent in p2 — no shortlist)",
        "- Single pass, no retries (the pipeline's retry/escalation ladder is a"
        " pilot concern; this measures raw model behaviour)",
        f"- Baseline validity includes the p2 retry rescue; baseline cost is"
        f" FIRST-PASS usage only",
        f"- thinkingLevel LOW is baked into every replayed request (both models)",
    ]
    if meta.get("vocab_note"):
        lines.append(f"- ⚠️ {meta['vocab_note']}")
    lines += [
        "",
        "## Schema validity",
        f"- Candidate `{model}`: {meta['candidate_valid']}/{meta['candidate_rows']}"
        f" ({meta['candidate_valid'] / max(meta['candidate_rows'], 1):.2%});"
        f" invalid buckets: {meta['candidate_buckets'] or '—'}",
        f"- Baseline `{BASELINE_MODEL}` (after p2 retry rescue):"
        f" {meta['baseline_valid']}/{meta['baseline_rows']}"
        f" ({meta['baseline_valid'] / max(meta['baseline_rows'], 1):.2%})",
    ]
    if cmp["candidate_invalid"]:
        lines.append("- Candidate-invalid ids:")
        for key, bucket in sorted(cmp["candidate_invalid"].items()):
            lines.append(f"  - `{key}` ({bucket})")
    if cmp["baseline_invalid"]:
        lines.append(
            f"- Baseline-invalid ids (excluded from agreement denominators,"
            f" {len(cmp['baseline_invalid'])}):"
        )
        for key in cmp["baseline_invalid"]:
            lines.append(f"  - `{key}`")
    for route_name, r in sorted(cmp["per_route"].items()):
        lines += [
            "",
            f"## Tag agreement — route `{route_name}` ({r['compared']} rows compared)",
            f"- Exact tag-set match: {r['exact']}/{r['compared']}"
            f" ({r['exact'] / max(r['compared'], 1):.1%})",
            f"- Jaccard: mean {r['jaccard_mean']:.3f} · median {r['jaccard_median']:.3f}",
            f"- passage_function agreement: {r['fn_agree']}/{r['fn_total']}"
            f" ({r['fn_agree'] / max(r['fn_total'], 1):.1%})",
            "- Tags BOTH agreed on (top):",
            *_tag_table_lines(r["tags_both"]),
            "- Baseline-only tags (candidate missed):",
            *_tag_table_lines(r["tags_baseline_only"]),
            "- Candidate-only tags (baseline missed):",
            *_tag_table_lines(r["tags_candidate_only"]),
        ]
    if cmp["function_confusions"]:
        lines += ["", "## passage_function confusions (baseline → candidate)"]
        for pair, n in list(cmp["function_confusions"].items())[:20]:
            lines.append(f"- {pair}: {n}")
    lines += ["", f"## Question samples (seeded, up to {config.BAKEOFF_SAMPLE_QUESTIONS})"]
    if not cmp["question_samples"]:
        lines.append("- (no compared row returned questions)")
    for sample in cmp["question_samples"]:
        lines += [
            f"- `{sample['key']}`",
            f"  - baseline: {'; '.join(q for q in sample['baseline'] if q) or '(none)'}",
            f"  - candidate: {'; '.join(q for q in sample['candidate'] if q) or '(none)'}",
        ]
    lines += [
        "",
        "## True cost (from usageMetadata, at pinned Batch prices)",
        f"- Candidate `{model}`: {costs['candidate']['in']:,} in /"
        f" {costs['candidate']['out']:,} out → ${costs['candidate']['usd']:,.2f}"
        f" (${costs['candidate']['price_in']}/M in · ${costs['candidate']['price_out']}/M out)",
        f"- Baseline `{BASELINE_MODEL}` first pass: {costs['baseline']['in']:,} in /"
        f" {costs['baseline']['out']:,} out → ${costs['baseline']['usd']:,.2f}"
        f" (${costs['baseline']['price_in']}/M in · ${costs['baseline']['price_out']}/M out)",
        f"- Per-row averages — candidate: {costs['candidate']['per_row_usd']:.5f} USD;"
        f" baseline: {costs['baseline']['per_row_usd']:.5f} USD",
    ]
    md_path.parent.mkdir(parents=True, exist_ok=True)
    with open(md_path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    with open(json_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({"meta": meta, "comparison": cmp, "costs": costs}, f, indent=1, sort_keys=True)
    return md_path, json_path


def _cost_side(model: str, in_tok: int, out_tok: int, rows: int) -> dict:
    prices = config.batch_prices(model)
    usd = tagging._usd(model, in_tok, out_tok)
    return {
        "in": in_tok, "out": out_tok, "usd": usd,
        "price_in": prices[0], "price_out": prices[1],
        "per_row_usd": usd / max(rows, 1),
    }


# ── entry point ─────────────────────────────────────────────────────────────

def run(model: str, route: str = "all") -> int:
    """The whole bakeoff: verify prerequisites → plan/reconcile/submit/collect
    (state-file only) → compare → write shards/bakeoff_<model>_<route>_report.md
    + .json. Returns 0 on a written report, 2 when the banked p2 artifacts are
    absent (maintainer-local — nothing to replay/compare; NEVER a clean pass)."""
    if route not in ("all", *routing.ROUTES):
        raise SystemExit(f"FATAL: unknown bakeoff route {route!r}")
    _require_bakeoff_keys()
    model = gemini_client.confirm_model(model)
    if config.batch_prices(model) is None:
        raise SystemExit(
            f"FATAL: no pinned batch price for {model!r} — a bakeoff would spend"
            " unpriced money. Pin it in config.GEMINI_BATCH_PRICES_CANONICAL."
        )

    requests = load_banked_requests()
    baseline = baseline_map()
    if not requests or not baseline:
        print(
            "⛔ Banked p2 request/result files are absent under"
            f" {config.SHARDS_DIR} (they are maintainer-local and git-ignored)."
            " Nothing to replay or compare — this is NOT a clean result.",
            flush=True,
        )
        return 2
    req_keys, res_keys = set(requests), set(baseline)
    if req_keys != res_keys:
        only_req = sorted(req_keys - res_keys)[:10]
        only_res = sorted(res_keys - req_keys)[:10]
        raise SystemExit(
            "FATAL: banked p2 requests and results disagree on their key sets —"
            f" {len(req_keys - res_keys)} request-only (e.g. {only_req}),"
            f" {len(res_keys - req_keys)} result-only (e.g. {only_res})."
            " The bank is inconsistent; refusing to compare."
        )
    manifest = p2_manifest_keys()
    if manifest and not req_keys <= manifest:
        raise SystemExit(
            "FATAL: banked p2 request keys are not a subset of the DB p2 manifest —"
            " the files do not belong to this database's pilot. Refusing."
        )
    manifest_skipped = len(manifest - req_keys) if manifest else 0

    routes = routes_for_keys(req_keys)
    vocab_note = None
    try:
        vocab_slugs = tagging.load_vocab_index().slugs
        import audit

        p2_vocab = db.one(
            "SELECT vocab_version FROM public.tag_runs WHERE prompt_version=%s"
            " ORDER BY started_at DESC LIMIT 1",
            ("asp-tags-v3.p2",),
        )
        if p2_vocab and p2_vocab != audit.vocab_version():
            vocab_note = (
                f"local vocabulary.json ({audit.vocab_version()}) differs from the p2"
                f" run's ({p2_vocab}) — prompts are verbatim either way, but the"
                " offline OOV gate may differ between the two columns"
            )
    except SystemExit:
        raise SystemExit(
            f"FATAL: {config.VOCAB_PATH} is not built — the offline tag gate needs it"
            " for a fair comparison. Build the vocabulary first."
        )

    state = load_state(model, route)
    _plan_shards(model, route, requests, routes, state)
    reconcile_state(model, route, state)
    submit(model, route, state)
    collect(model, route, state)
    failed = [k for k, s in state["shards"].items() if s["status"] == "failed"]
    if failed:
        print(
            f"  ⚠️ {len(failed)} bakeoff shard(s) FAILED ({', '.join(sorted(failed))}) —"
            " their rows are absent from the comparison (rerun to retry them).",
            flush=True,
        )
    unfinished = [k for k, s in state["shards"].items()
                  if s["status"] in ("pending", "submitted", "running")]
    if unfinished:
        print(
            f"⛔ {len(unfinished)} bakeoff shard(s) not finished (ceiling or interrupt) —"
            " rerun the same --bakeoff-model command to resume before comparing.",
            flush=True,
        )
        return 3

    candidate = candidate_map(model, route)
    compared_keys = req_keys if route == "all" else {
        k for k in req_keys if routes.get(k, "standard") == route
    }
    cmp = compare_rows(baseline, candidate, routes, vocab_slugs,
                       config.BAKEOFF_SAMPLE_QUESTIONS, config.SAMPLE_SEED)

    cand_in = sum(s["usage"]["in"] for s in state["shards"].values() if s.get("usage"))
    cand_out = sum(s["usage"]["out"] for s in state["shards"].values() if s.get("usage"))
    base_rows = {k: baseline[k] for k in compared_keys if k in baseline}
    base_in = sum(int((r.get("usage") or {}).get("promptTokenCount") or 0) for r in base_rows.values())
    base_out = sum(
        int((r.get("usage") or {}).get("candidatesTokenCount") or 0)
        + int((r.get("usage") or {}).get("thoughtsTokenCount") or 0)
        for r in base_rows.values()
    )
    candidate_valid = sum(1 for k in compared_keys if (candidate.get(k) or {}).get("parsed"))
    baseline_valid = sum(1 for k in compared_keys if (baseline.get(k) or {}).get("parsed"))
    buckets: dict[str, int] = {}
    for bucket in cmp["candidate_invalid"].values():
        buckets[bucket] = buckets.get(bucket, 0) + 1
    meta = {
        "model": model,
        "route": route,
        "requests": len(compared_keys),
        "manifest_rows": len(manifest),
        "manifest_skipped": manifest_skipped,
        "candidate_rows": len(compared_keys),
        "candidate_valid": candidate_valid,
        "candidate_buckets": ", ".join(f"{b}={n}" for b, n in sorted(buckets.items())),
        "baseline_rows": len(compared_keys),
        "baseline_valid": baseline_valid,
        "vocab_note": vocab_note,
    }
    costs = {
        "candidate": _cost_side(model, cand_in, cand_out, len(compared_keys)),
        "baseline": _cost_side(BASELINE_MODEL, base_in, base_out, len(compared_keys)),
    }
    md_path, json_path = write_bakeoff_report(model, route, cmp, costs, meta)
    print(f"\nBAKEOFF COMPLETE — no DB writes. Report: {md_path} (+ {json_path.name})", flush=True)
    return 0
