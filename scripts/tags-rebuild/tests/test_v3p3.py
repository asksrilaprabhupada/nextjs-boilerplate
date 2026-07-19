"""
test_v3p3.py — unit tests for the v3.p3-hybrid changes (two models, one pipeline).

All DETERMINISTIC and OFFLINE: no database, no Gemini, no credentials — the
DB-adjacent logic under test is factored into pure helpers (routing rules,
shard-key/attempt derivation, per-model pricing, usage summation, the outcome
upsert SQL via a fake cursor, file-based failure/rescue scanning, and the
bakeoff comparison machinery over synthetic files).

Run:  cd scripts/tags-rebuild && python -m pytest tests/ -q
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import audit
import bakeoff
import config
import routing
import tagging

RUN_ID = "12345678-9abc-def0-1234-56789abcdef0"
RUN8 = "12345678"
CORE = "gemini-3.5-flash"
STD = "gemini-3-flash-preview"

TAGGING_SRC = Path(tagging.__file__).read_text(encoding="utf-8")


# ── routing (item 2) ─────────────────────────────────────────────────────────

def test_route_for_matrix():
    for slug in ("bg", "sb", "cc", "BG", " Sb "):
        assert routing.route_for("verses", slug) == "core"
        assert routing.route_for("verse_chunks", slug) == "core"
    for slug in ("iso", "noi", "unknown", "", None):
        assert routing.route_for("verses", slug) == "standard"
    # book routing applies ONLY to verses/verse_chunks — prose of bg is standard
    assert routing.route_for("prose_paragraphs", "bg") == "standard"
    assert routing.route_for("transcript_paragraphs", "cc") == "standard"
    assert routing.route_for("letter_paragraphs", None) == "standard"


def test_model_for_route_and_inverse():
    assert routing.model_for_route("core") == config.MODEL_CORE
    assert routing.model_for_route("standard") == config.MODEL_STANDARD
    assert routing.route_for_model(config.MODEL_STANDARD) in ("core", "standard")
    try:
        routing.model_for_route("bogus")
        assert False, "unknown route must be fatal"
    except SystemExit:
        pass


def test_route_sql_fragments():
    join, expr = routing.route_sql("verses")
    assert "public.chapters" in join and "chapter_id" in join
    assert "coalesce(rc.book_slug, t.scripture)" in expr
    assert "'bg', 'cc', 'sb'" in expr and "'core'" in expr and "'standard'" in expr
    join, expr = routing.route_sql("verse_chunks")
    assert "public.verses rv" in join and "rv.verse_id" not in join  # joins ON rv.id = t.verse_id
    assert "rv.id = t.verse_id" in join
    assert "coalesce(rc.book_slug, rv.scripture)" in expr
    for table in ("prose_paragraphs", "transcript_paragraphs", "letter_paragraphs"):
        assert routing.route_sql(table) == ("", "'standard'")


def test_model_strings_are_key_safe():
    assert config.invalid_model_strings() == []
    for m in config.ROUTED_MODELS:
        assert ":" not in m and "_" not in m


# ── shard keys: model + run token embedded, no collisions (item 1) ───────────

def test_shard_key_scheme_and_no_p2_collision():
    pilot = tagging.pilot_prefix(RUN_ID)
    full = tagging.full_prefix(RUN_ID)
    assert pilot == f"pilot:p3:{RUN8}:"
    assert full == f"full:p3:{RUN8}:"
    keys = [
        f"{pilot}{CORE}:verses:000",
        f"{pilot}retry:{STD}:prose_paragraphs:000",
        f"{pilot}esc:{CORE}:letter_paragraphs:000",
        f"{full}{STD}:transcript_paragraphs:w01:0003",
        f"{full}retry:{CORE}:verses:w02:0000",
        f"{full}esc:{CORE}:verse_chunks:w02:0000:p01",
    ]
    for key in keys:
        assert not key.startswith("pilot:p2:")           # p2 pilot keys frozen
        assert not re.match(r"^[a-z_]+:w\d", key)        # p2 full keys frozen
    # distinct filenames per model — request/result files can never collide
    a = tagging.shard_request_path(f"{pilot}{CORE}:verses:000")
    b = tagging.shard_request_path(f"{pilot}{STD}:verses:000")
    assert a != b and RUN8 in a.name and CORE in a.name and STD in b.name
    # a second run's keys can never collide with this run's
    other = tagging.pilot_prefix("87654321-9abc-def0-1234-56789abcdef0")
    assert other != pilot


def test_attempt_for_shard_key():
    assert tagging.attempt_for_shard_key(f"pilot:p3:{RUN8}:{CORE}:verses:000") == 1
    assert tagging.attempt_for_shard_key(f"pilot:p3:{RUN8}:retry:{STD}:verses:000") == 2
    assert tagging.attempt_for_shard_key(f"pilot:p3:{RUN8}:esc:{CORE}:verses:000") == 3
    assert tagging.attempt_for_shard_key(f"full:p3:{RUN8}:{STD}:verses:w01:0000") == 1
    assert tagging.attempt_for_shard_key(f"full:p3:{RUN8}:retry:{STD}:verses:w01:0000:p02") == 2
    assert tagging.attempt_for_shard_key(f"full:p3:{RUN8}:esc:{CORE}:verses:w03:0001:p00") == 3


# ── per-model pricing map (item 1) ───────────────────────────────────────────

def test_batch_prices_canonical_and_overrides(monkeypatch):
    assert config.batch_prices(CORE) == (0.75, 4.50)
    assert config.batch_prices(STD) == (0.25, 1.50)
    assert config.batch_prices("gemini-nonexistent") is None
    # model-suffixed override wins for that model only
    monkeypatch.setenv("GEMINI_BATCH_PRICE_IN_PER_M__GEMINI_3_FLASH_PREVIEW", "0.30")
    assert config.batch_prices(STD) == (0.30, 1.50)
    assert config.batch_prices(CORE) == (0.75, 4.50)
    monkeypatch.delenv("GEMINI_BATCH_PRICE_IN_PER_M__GEMINI_3_FLASH_PREVIEW")
    # legacy un-suffixed vars are a gemini-3.5-flash alias ONLY
    monkeypatch.setenv("GEMINI_BATCH_PRICE_OUT_PER_M", "9.99")
    assert config.batch_prices(CORE) == (0.75, 9.99)
    assert config.batch_prices(STD) == (0.25, 1.50)


def test_ledger_prices_by_recorded_columns():
    assert "price_in_per_m" in tagging._LEDGER_SUMS
    assert "price_out_per_m" in tagging._LEDGER_SUMS
    # the pre-backfill fallback must be the CORE canonical pair — legacy rows
    # were all gemini-3.5-flash and must never be priced at preview rates
    assert tagging._LEDGER_FALLBACK == config.GEMINI_BATCH_PRICES_CANONICAL[CORE]


def test_max_spend_default_325():
    assert config.MAX_SPEND_USD == 325.0


# ── thinkingLevel LOW: non-overridable, in EVERY request (both models) ───────

def test_thinking_level_constant_and_request_line():
    assert config.THINKING_LEVEL == "LOW"
    vocab = tagging.VocabIndex({
        "term_count": 1,
        "terms": [{"slug": "bhakti", "term": "devotion", "variants": [], "facet": "Concept"}],
    })
    for questions_allowed in (True, False):
        passage = tagging.Passage(
            table="verses", id="x", text="One. Two.", authorship="HIS",
            questions_allowed=questions_allowed, shortlist=["bhakti"],
        )
        line = tagging.request_line(passage, vocab)
        gc = line["request"]["generationConfig"]
        assert gc["thinkingConfig"]["thinkingLevel"] == "LOW"
        assert ("questions" in gc["responseSchema"]["properties"]) is questions_allowed


# ── retrieval-time usage recording (item 1) ──────────────────────────────────

def test_usage_from_results_file(tmp_path):
    lines = [
        {"key": "verses|a", "response": {"usageMetadata": {
            "promptTokenCount": 100, "candidatesTokenCount": 40, "thoughtsTokenCount": 25},
            "candidates": []}},
        {"key": "verses|b", "error": {"code": 500, "message": "boom"}},  # no usage
        {"key": "verses|c", "response": {"usageMetadata": {
            "promptTokenCount": 10, "candidatesTokenCount": 5, "thoughtsTokenCount": 0},
            "candidates": []}},
    ]
    path = tmp_path / "r.results.jsonl"
    path.write_text("\n".join(json.dumps(l) for l in lines) + "\n", encoding="utf-8")
    assert tagging.usage_from_results_file(path) == (110, 70, 45, 25)


def test_costs_recorded_at_retrieval_not_apply():
    # exactly ONE statement writes real cost columns — the retrieval UPDATE
    assert TAGGING_SRC.count("cost_input_tok=%s") == 1
    assert "SET status='retrieved', retrieved_at=%s," in TAGGING_SRC
    # the apply statement flips status/applied_at ONLY (no cost columns)
    assert "SET status='applied', applied_at=%s" in TAGGING_SRC


# ── outcome state machine (item 3) ───────────────────────────────────────────

def test_quarantine_predicate(monkeypatch):
    assert not tagging.is_quarantinable(STD, 1)
    assert not tagging.is_quarantinable(CORE, 1)
    assert not tagging.is_quarantinable(STD, 2)      # escalation still available
    assert tagging.is_quarantinable(CORE, 2)         # core retry failed → done
    assert tagging.is_quarantinable(STD, 3)          # escalation failed → done
    assert tagging.is_quarantinable(CORE, 3)
    # degeneration: identical models terminate the ladder at attempt 2
    monkeypatch.setattr(config, "MODEL_CORE", STD)
    assert tagging.is_quarantinable(STD, 2)
    # the SQL predicate must mirror the pure helper
    assert "(o.attempt >= 2 AND o.model = %s) OR o.attempt >= 3" in TAGGING_SRC


class _FakeCursor:
    def __init__(self):
        self.calls: list[tuple[str, list]] = []

    def executemany(self, sql, rows):
        self.calls.append((sql, list(rows)))


def test_record_outcomes_upsert_guard():
    cur = _FakeCursor()
    tagging.record_outcomes(
        RUN_ID,
        [("verses", "11111111-1111-1111-1111-111111111111", "k", STD, 1,
          "invalid", "MALFORMED_JSON")],
        cur,
    )
    (sql, rows), = cur.calls
    # resolved rows are never downgraded; attempt never decreases; history appends
    assert "ON CONFLICT (run_id, table_name, passage_id) DO UPDATE" in sql
    assert "WHERE o.outcome NOT IN ('applied','skipped_no_shortlist')" in sql
    assert "greatest(o.attempt, EXCLUDED.attempt)" in sql
    assert "history = o.history || EXCLUDED.history" in sql
    assert rows[0][0] == RUN_ID and len(rows[0]) == 12
    assert tagging.record_outcomes(RUN_ID, [], cur) is None  # no-op stays a no-op
    assert len(cur.calls) == 1


def test_resolved_outcomes_include_skips():
    # without an explicit skip state, no-shortlist rows could never resolve and
    # the run would deadlock — the state set must contain both
    assert set(tagging.RESOLVED_OUTCOMES) == {"applied", "skipped_no_shortlist"}
    assert set(tagging.RETRYABLE_OUTCOMES) == {"invalid", "missing_response"}
    assert "'quarantined'" in audit.AUDIT_DDL  # terminal-but-unresolved state exists


def test_audit_ddl_and_legacy_backfill():
    assert "tag_passage_outcomes" in audit.AUDIT_DDL
    assert "price_in_per_m" in audit.AUDIT_DDL and "price_out_per_m" in audit.AUDIT_DDL
    assert audit.LEGACY_MODEL == CORE
    assert "WHERE model IS NULL" in audit.LEGACY_BACKFILL_SQL  # idempotent, additive
    assert audit.run_model_fingerprint(CORE, STD) == f"core={CORE};standard={STD}"


# ── file-based failure scan + rescue ladder (items 2 + 3) ────────────────────

def _result_line(key: str, valid: bool = True, tag: str = "bhakti") -> str:
    if not valid:
        return json.dumps({"key": key, "error": {"code": 500, "message": "boom"}})
    return json.dumps({
        "key": key,
        "response": {
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5,
                              "thoughtsTokenCount": 2},
            "candidates": [{"content": {"parts": [{"text": json.dumps({
                "passage_function": "explains",
                "tags": [{"tag": tag, "evidence_sentence_id": "S001"}],
            })}]}, "finishReason": "STOP"}],
        },
    })


def test_valid_and_invalid_keys_first_valid_wins(tmp_path):
    path = tmp_path / "x.results.jsonl"
    path.write_text(
        "\n".join([
            _result_line("verses|dup", valid=False),
            _result_line("verses|dup", valid=True),   # duplicate: valid wins
            _result_line("verses|bad", valid=False),
            _result_line("verses|good", valid=True),
        ]) + "\n",
        encoding="utf-8",
    )
    valid, invalid = tagging._valid_and_invalid_keys([path])
    assert "verses|dup" in valid and "verses|dup" not in invalid
    assert invalid == {"verses|bad"}


def _bank_pilot_files(shards_dir: Path, prefix: str) -> None:
    base = prefix.replace(":", "_")
    (shards_dir / f"{base}{CORE}_verses_000.results.jsonl").write_text(
        _result_line("verses|c-ok") + "\n" + _result_line("verses|c-bad", valid=False) + "\n",
        encoding="utf-8",
    )
    (shards_dir / f"{base}{STD}_prose_paragraphs_000.results.jsonl").write_text(
        "\n".join([
            _result_line("prose_paragraphs|s-ok"),
            _result_line("prose_paragraphs|s-bad1", valid=False),
            _result_line("prose_paragraphs|s-bad2", valid=False),
            _result_line("prose_paragraphs|s-bad3", valid=False),
        ]) + "\n",
        encoding="utf-8",
    )


def test_failed_keys_grouped_by_model(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SHARDS_DIR", tmp_path)
    prefix = tagging.pilot_prefix(RUN_ID)
    _bank_pilot_files(tmp_path, prefix)
    failed = tagging.failed_keys_from_files(prefix)
    assert failed[(CORE, "verses")] == ["c-bad"]
    assert failed[(STD, "prose_paragraphs")] == ["s-bad1", "s-bad2", "s-bad3"]


def test_pilot_final_failures_with_retry_and_escalation_rescue(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SHARDS_DIR", tmp_path)
    prefix = tagging.pilot_prefix(RUN_ID)
    base = prefix.replace(":", "_")
    _bank_pilot_files(tmp_path, prefix)
    # retry rescues s-bad1 (valid) but not s-bad2/s-bad3/c-bad
    (tmp_path / f"{base}retry_{STD}_prose_paragraphs_000.results.jsonl").write_text(
        _result_line("prose_paragraphs|s-bad1") + "\n"
        + _result_line("prose_paragraphs|s-bad2", valid=False) + "\n",
        encoding="utf-8",
    )
    # escalation (on the core model) rescues s-bad2
    (tmp_path / f"{base}esc_{CORE}_prose_paragraphs_000.results.jsonl").write_text(
        _result_line("prose_paragraphs|s-bad2") + "\n",
        encoding="utf-8",
    )
    before_esc = tagging.pilot_final_failures(prefix, include_escalation=False)
    assert set(before_esc[(STD, "prose_paragraphs")]) == {"s-bad2", "s-bad3"}
    still = tagging.pilot_final_failures(prefix)
    assert still[(STD, "prose_paragraphs")] == ["s-bad3"]
    assert still[(CORE, "verses")] == ["c-bad"]  # core rows never escalate


def test_scan_pilot_results_by_model(tmp_path, monkeypatch):
    vocab = {"term_count": 1,
             "terms": [{"slug": "bhakti", "term": "devotion", "variants": [], "facet": "Concept"}]}
    (tmp_path / "vocabulary.json").write_text(json.dumps(vocab), encoding="utf-8")
    shards = tmp_path / "shards"
    shards.mkdir()
    monkeypatch.setattr(config, "VOCAB_PATH", tmp_path / "vocabulary.json")
    monkeypatch.setattr(config, "SHARDS_DIR", shards)
    prefix = tagging.pilot_prefix(RUN_ID)
    _bank_pilot_files(shards, prefix)
    stats = tagging.scan_pilot_results(prefix)["stats"]
    assert stats["by_model"][CORE]["responses"] == 2
    assert stats["by_model"][CORE]["schema_valid"] == 1
    assert stats["by_model"][STD]["responses"] == 4
    assert stats["by_model"][STD]["output_tokens"] == 7  # one valid row: 5 + 2


# ── bakeoff (item 4) ─────────────────────────────────────────────────────────

def test_bakeoff_gate_and_jaccard():
    slugs = {"a", "b", "c"}
    parsed = {"tags": [{"tag": "a"}, {"tag": "zzz"}, {"tag": "a"}, {"tag": "b"}]}
    assert bakeoff.gate_tags_offline(parsed, slugs) == ["a", "b"]  # OOV drop + dedupe
    capped = {"tags": [{"tag": t} for t in ["a"] * (config.MAX_TAGS + 5)]}
    assert bakeoff.gate_tags_offline(capped, slugs) == ["a"]
    assert bakeoff.jaccard(set(), set()) == 1.0
    assert bakeoff.jaccard({"a"}, set()) == 0.0
    assert abs(bakeoff.jaccard({"a", "b"}, {"b", "c"}) - 1 / 3) < 1e-9


def _mk_row(tags: list[str], fn: str = "explains", questions: list[str] | None = None,
            valid: bool = True, usage: dict | None = None) -> dict:
    parsed = None
    if valid:
        parsed = {"passage_function": fn,
                  "tags": [{"tag": t, "evidence_sentence_id": "S001"} for t in tags]}
        if questions is not None:
            parsed["questions"] = [{"question": q, "evidence_sentence_id": "S001"}
                                   for q in questions]
    return {"parsed": parsed, "usage": usage or {}, "bucket": None if valid else "other"}


def test_bakeoff_compare_rows():
    slugs = {"a", "b", "c"}
    baseline = {
        "verses|1": _mk_row(["a", "b"], fn="explains", questions=["Q1?"]),
        "verses|2": _mk_row(["a"], fn="defines"),
        "prose_paragraphs|3": _mk_row(["c"], fn="warns"),
        "verses|4": _mk_row([], valid=False),          # baseline-invalid
        "verses|5": _mk_row(["b"], fn="explains"),
    }
    candidate = {
        "verses|1": _mk_row(["a", "b"], fn="explains", questions=["Q1 alt?"]),
        "verses|2": _mk_row(["a", "c"], fn="explains"),
        "prose_paragraphs|3": _mk_row(["c"], fn="warns"),
        "verses|4": _mk_row(["a"]),
        "verses|5": _mk_row([], valid=False),          # candidate-invalid
    }
    routes = {"verses|1": "core", "verses|2": "core", "verses|4": "core",
              "verses|5": "core", "prose_paragraphs|3": "standard"}
    cmp = bakeoff.compare_rows(baseline, candidate, routes, slugs,
                               questions_sample=5, sample_seed="seed")
    core = cmp["per_route"]["core"]
    std = cmp["per_route"]["standard"]
    assert core["compared"] == 2 and core["exact"] == 1
    assert std["compared"] == 1 and std["exact"] == 1 and std["jaccard_mean"] == 1.0
    assert core["tags_candidate_only"] == {"c": 1}
    assert cmp["baseline_invalid"] == ["verses|4"]
    assert cmp["candidate_invalid"] == {"verses|5": "other"}
    assert cmp["function_confusions"] == {"defines → explains": 1}
    assert any(s["key"] == "verses|1" for s in cmp["question_samples"])


def test_bakeoff_cost_math():
    side = bakeoff._cost_side(STD, 1_000_000, 2_000_000, 1000)
    assert abs(side["usd"] - (0.25 + 2 * 1.50)) < 1e-9
    assert side["price_in"] == 0.25 and side["price_out"] == 1.50
    assert abs(side["per_row_usd"] - side["usd"] / 1000) < 1e-12


def test_bakeoff_state_roundtrip(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SHARDS_DIR", tmp_path)
    state = bakeoff.load_state(STD, "standard")
    assert state == {"model": STD, "route": "standard", "shards": {}}
    state["shards"]["bakeoff:x"] = {"status": "submitted", "job": "batches/1",
                                    "est_in": 5, "est_out": 6, "usage": None}
    bakeoff.save_state(STD, "standard", state)
    assert bakeoff.load_state(STD, "standard") == state


def test_bakeoff_never_writes_the_db():
    # tripwire: the bakeoff module must contain NO mutating SQL — read-only
    # SELECTs only; its job state lives in the local state file.
    src = Path(bakeoff.__file__).read_text(encoding="utf-8")
    for verb in ("INSERT INTO", "UPDATE public.", "DELETE FROM",
                 "CREATE TABLE", "ALTER TABLE", "TRUNCATE"):
        assert verb not in src, f"bakeoff.py must never contain {verb!r}"
    assert "ensure_audit_tables" not in src
