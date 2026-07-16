"""
doctor.py — `python run_all.py --doctor`: read-only readiness checklist.

Checks keys, the Session Pooler connection, live row/remaining counts,
vocabulary/manifest/table readiness, and that the EXACT current Gemini
3.5 Flash model string is reachable via the live models list. Prints a
green/red checklist and exits 0 (ready) / 1 (not ready). CHANGES NOTHING:
every query is a SELECT; no table is created; no paid endpoint is called
(models.list is free metadata).
"""
from __future__ import annotations

import json

import config

try:
    import colorama

    colorama.just_fix_windows_console()
except Exception:
    pass

_GREEN, _RED, _YELLOW, _RESET = "\033[32m", "\033[31m", "\033[33m", "\033[0m"
_failures = 0


def _ok(label: str, detail: str = "") -> None:
    print(f"  {_GREEN}✓{_RESET} {label}" + (f" — {detail}" if detail else ""), flush=True)


def _bad(label: str, detail: str = "") -> None:
    global _failures
    _failures += 1
    print(f"  {_RED}✗{_RESET} {label}" + (f" — {detail}" if detail else ""), flush=True)


def _warn(label: str, detail: str = "") -> None:
    print(f"  {_YELLOW}!{_RESET} {label}" + (f" — {detail}" if detail else ""), flush=True)


def _check_keys() -> None:
    print("\nCredentials", flush=True)
    if config.ENV_FILE.exists():
        _ok(f"{config.ENV_FILE.name} present", str(config.ENV_FILE))
    else:
        _warn(f"{config.ENV_FILE.name} missing", "reading process environment only")
    missing = set(config.missing_keys())
    for key in config.REQUIRED_KEYS:
        if key in missing:
            _bad(f"{key} set")
        else:
            _ok(f"{key} set")
    dsn = config.DATABASE_URL
    if dsn:
        if "pooler.supabase.com" in dsn:
            _ok("DATABASE_URL is a Supabase pooler DSN")
        else:
            _warn("DATABASE_URL host is not *.pooler.supabase.com", "expected the Session Pooler string")
        if ":6543" in dsn:
            _warn(
                "DATABASE_URL uses port 6543 (Transaction Pooler)",
                "use the SESSION pooler (5432): long statements + CREATE INDEX CONCURRENTLY need it",
            )


def _check_db() -> bool:
    print("\nDatabase (read-only)", flush=True)
    if not config.DATABASE_URL:
        _bad("DB reachable", "no DATABASE_URL")
        return False
    try:
        import db

        version = db.one("SELECT version()")
        _ok("DB reachable via pooler", str(version).split(" on ")[0])
    except Exception as exc:  # noqa: BLE001
        _bad("DB reachable", str(exc)[:200])
        return False

    import db

    for table in config.CONTENT_TABLES:
        try:
            total = db.table_count(table)
            fts_left = db.table_count(table, "fts_core IS NULL")
            tags_left = db.table_count(table, "tags_core IS NULL")
            no_embed = db.table_count(table, "embedding_context4 IS NULL")
            detail = (
                f"{total:,} rows · fts_core remaining {fts_left:,}"
                f" · tags_core remaining {tags_left:,}"
                + (f" · {no_embed:,} without embedding_context4" if no_embed else "")
            )
            (_ok if fts_left == 0 else _warn)(table, detail)
        except Exception as exc:  # noqa: BLE001
            _bad(table, str(exc)[:200])

    try:
        missing_fn = [
            t
            for t in config.CONTENT_TABLES
            if not db.one(
                "SELECT count(*) FROM information_schema.columns"
                " WHERE table_schema='public' AND table_name=%s AND column_name='passage_function'",
                (t,),
            )
        ]
        if missing_fn:
            _warn(
                "passage_function column",
                f"missing on {', '.join(missing_fn)} — run_all adds it (additive, audit.ensure_audit_tables)",
            )
        else:
            _ok("passage_function column", "present on all five content tables")
    except Exception as exc:  # noqa: BLE001
        _bad("passage_function column", str(exc)[:200])

    try:
        vocab_count = db.table_count("vocab_terms")
        embedded = db.table_count("vocab_terms", "embedding IS NOT NULL")
        (_ok if embedded else _warn)("vocab_terms", f"{vocab_count:,} terms · {embedded:,} embedded")
    except Exception as exc:  # noqa: BLE001
        _bad("vocab_terms", str(exc)[:200])

    try:
        by_status = db.rows(
            "SELECT status, count(*) FROM public.tag_batch_jobs GROUP BY status ORDER BY status"
        )
        detail = ", ".join(f"{s}:{n}" for s, n in by_status) or "empty"
        _ok("tag_batch_jobs", detail)
    except Exception as exc:  # noqa: BLE001
        _bad("tag_batch_jobs", str(exc)[:200])

    try:
        import audit

        if audit.audit_tables_exist():
            runs = db.one("SELECT count(*) FROM public.tag_runs")
            evidence = db.one("SELECT count(*) FROM public.tag_evidence")
            _ok("audit tables (tag_runs / tag_evidence)", f"{runs} runs · {evidence:,} evidence rows")
        else:
            _warn("audit tables (tag_runs / tag_evidence)", "not created yet — run_all creates them")
    except Exception as exc:  # noqa: BLE001
        _bad("audit tables", str(exc)[:200])
    return True


def _check_artifacts() -> None:
    print("\nManifest + vocabulary artifacts", flush=True)
    try:
        import provenance

        manifest = provenance.load_manifest()
        _ok("provenance.json parses", f"version {manifest.get('version')}")
    except SystemExit as exc:
        _bad("provenance.json", str(exc)[:200])
    except Exception as exc:  # noqa: BLE001
        _bad("provenance.json", str(exc)[:200])
    if config.SEEDS_PATH.exists():
        _ok("vocabulary_seeds.json present")
    else:
        _bad("vocabulary_seeds.json present", "committed seed file is missing")
    if config.VOCAB_PATH.exists():
        try:
            with open(config.VOCAB_PATH, encoding="utf-8") as f:
                vocab = json.load(f)
            _ok(
                "vocabulary.json built",
                f"{vocab.get('term_count')} terms ({vocab.get('concept_count', '?')} concepts ·"
                f" {vocab.get('entity_count', '?')} entities) · {len(vocab.get('merges', []))} merge"
                f" proposals · {len(vocab.get('warnings', []))} warnings · version {vocab.get('version')}",
            )
        except Exception as exc:  # noqa: BLE001
            _bad("vocabulary.json parses", str(exc)[:200])
    else:
        _warn("vocabulary.json", "not built yet — run_all builds it (then ⛔ review gate)")


def _check_gemini() -> None:
    print("\nGemini (free models.list — confirms the exact current model string)", flush=True)
    if not config.GEMINI_API_KEY:
        _bad("Gemini reachable", "GEMINI_API_KEY missing")
        return
    try:
        import gemini_client

        resolved = gemini_client.confirm_model()
        _ok("model confirmed", f"GEMINI_MODEL={resolved} (full Flash, batch-capable)")
    except SystemExit as exc:
        _bad("model confirmed", str(exc)[:300])
    except Exception as exc:  # noqa: BLE001
        _bad("Gemini reachable", str(exc)[:200])


def _check_budget() -> None:
    print("\nCost ceiling", flush=True)
    _ok(
        "MAX_SPEND_USD",
        f"${config.MAX_SPEND_USD:,.2f} (machine-enforced at shard submission)",
    )
    _warn(
        "batch pricing knobs",
        f"${config.GEMINI_BATCH_PRICE_IN_PER_M}/M in · ${config.GEMINI_BATCH_PRICE_OUT_PER_M}/M out"
        " — verify against the live price sheet and pin in .env",
    )
    try:
        import tagging

        ledger = tagging.spend_ledger()
        _ok(
            "spend ledger",
            f"real ${ledger['real_usd']:,.2f} · in-flight est ${ledger['in_flight_est_usd']:,.2f}",
        )
    except Exception:
        _warn("spend ledger", "no shard state yet (nothing submitted)")


def run() -> int:
    global _failures
    _failures = 0
    print("Tags & FTS Rebuild — doctor (read-only; changes nothing)", flush=True)
    _check_keys()
    db_ok = _check_db()
    _check_artifacts()
    _check_gemini()
    _check_budget()
    print(flush=True)
    if _failures:
        print(f"{_RED}NOT READY{_RESET} — {_failures} check(s) failed.", flush=True)
        return 1
    verdict = "READY" if db_ok else "NOT READY"
    print(f"{_GREEN}{verdict}{_RESET} — all required checks passed.", flush=True)
    return 0
