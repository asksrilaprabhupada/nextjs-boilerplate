"""
test_v3p2.py — focused unit tests for the v3.p2 tagging changes.

Covers the DETERMINISTIC / pure pieces that can be validated with no database and
no Gemini: the sentence splitter, the sentence-ID response schema, thinking-token
cost accounting (incl. a real scan_pilot_results wiring test over temp files), the
--doctor pricing FAIL, the exact largest-remainder manifest allocation, and the
failure classifier's raw-reason capture.

Run:  cd scripts/tags-rebuild && python -m pytest tests/ -q
(the harness dir must be on sys.path — conftest.py handles that).
"""
from __future__ import annotations

import json

import config
import sentences as S
import tagging


# ── sentence splitter (item 3) ───────────────────────────────────────────────

def test_splitter_determinism_and_offsets():
    text = "Kṛṣṇa is God. Arjuna asked. He replied: chant Hare Kṛṣṇa!"
    a = S.split_sentences(text)
    b = S.split_sentences(text)
    assert [s.text for s in a] == [s.text for s in b]      # deterministic
    assert [s.id for s in a] == ["S001", "S002", "S003"]    # 1-based, padded
    for s in a:
        assert text[s.start:s.end] == s.text               # offset round-trip


def test_splitter_devanagari_dandas():
    text = "line one ।\nline two ॥"
    ids = [s.text for s in S.split_sentences(text)]
    assert ids == ["line one ।", "line two ॥"]


def test_splitter_protects_abbreviations_and_initials():
    text = "See Bg. 4.7 and SB. 1.2.3. Śrīla Prabhupāda wrote. A. C. Bhaktivedanta signed."
    out = [s.text for s in S.split_sentences(text)]
    assert out[0] == "See Bg. 4.7 and SB. 1.2.3."          # abbreviations not split
    assert out[-1] == "A. C. Bhaktivedanta signed."        # initials not split


def test_splitter_trailing_fragment_and_empty():
    assert [s.text for s in S.split_sentences("no terminator")] == ["no terminator"]
    assert S.split_sentences("") == []
    assert S.split_sentences("   ") == []
    assert S.split_sentences(None) == []


def test_resolve_sentence_boundaries():
    sents = S.split_sentences("One. Two. Three.")
    assert S.resolve_sentence("S002", sents)[:2] == (True, "Two.")
    assert S.resolve_sentence("S999", sents)[0] is False
    assert S.resolve_sentence(None, sents)[0] is False
    assert S.resolve_sentence("", sents)[0] is False
    assert S.resolve_sentence(3, sents)[0] is False        # non-str id


def test_render_numbered():
    sents = S.split_sentences("Alpha. Beta.")
    assert S.render_numbered(sents) == "[S001] Alpha.\n[S002] Beta."


# ── response schema (items 2 + 3) ────────────────────────────────────────────

def test_response_schema_shape():
    sch = tagging.response_schema(["a", "b"], True, ["S001", "S002"])
    props = sch["properties"]
    assert "reasoning" not in props                         # reasoning removed
    assert props["passage_function"]["enum"] == config.PASSAGE_FUNCTIONS
    assert "not_applicable" in props["passage_function"]["enum"]
    tag_ev = props["tags"]["items"]["properties"]["evidence_sentence_id"]
    assert tag_ev["type"] == "STRING" and tag_ev["enum"] == ["S001", "S002"]
    assert props["tags"]["items"]["required"] == ["tag", "evidence_sentence_id"]
    assert props["questions"]["items"]["properties"]["evidence_sentence_id"]["enum"] == ["S001", "S002"]
    assert sch["required"] == ["passage_function", "tags"]


def test_response_schema_no_questions_and_empty_target():
    sch = tagging.response_schema(["a"], False, ["S001"])
    assert "questions" not in sch["properties"]
    # No sentences → bare STRING (no enum), so an empty passage still validates.
    ev = tagging._evidence_id_schema([])
    assert ev == {"type": "STRING"}


# ── manifest allocation (item 6) ─────────────────────────────────────────────

def test_largest_remainder_sums_exactly():
    a = tagging._largest_remainder(
        2000, {"verses": 48.0, "transcript_paragraphs": 11.0, "prose_paragraphs": 6.0, "letter_paragraphs": 1.0}
    )
    assert sum(a.values()) == 2000
    b = tagging._largest_remainder(10, {"x": 1.0, "y": 1.0, "z": 1.0})
    assert sum(b.values()) == 10 and set(b.values()) <= {3, 4}
    assert tagging._largest_remainder(0, {"x": 1.0}) == {"x": 0}
    assert tagging._largest_remainder(5, {"x": 0.0}) == {"x": 0}   # zero-weight → 0


def test_len_expr_verses_vs_body():
    assert "translation" in tagging._len_expr("verses")
    assert tagging._len_expr("verse_chunks") == "length(coalesce(t.body_text,''))"


# ── cost: thinking is billable output (item 1) ───────────────────────────────

def test_usd_pricing():
    # v3.p3: pricing is model-aware — each routed model at its own pinned pair.
    assert abs(tagging._usd("gemini-3.5-flash", 1_000_000, 1_000_000) - (0.75 + 4.50)) < 1e-9
    assert abs(tagging._usd("gemini-3-flash-preview", 1_000_000, 1_000_000) - (0.25 + 1.50)) < 1e-9
    try:
        tagging._usd("model-with-no-pinned-price", 1, 1)
        assert False, "unpinned model must be a hard stop"
    except SystemExit:
        pass


def test_parse_line_surfaces_thoughts():
    line = json.dumps({
        "key": "verses|x",
        "response": {
            "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "thoughtsTokenCount": 3},
            "candidates": [{"content": {"parts": [{"text": json.dumps({"passage_function": "explains", "tags": []})}]}, "finishReason": "STOP"}],
        },
    })
    key, parsed, usage, error, fr, br = tagging._parse_response_line(line)
    assert usage["thoughtsTokenCount"] == 3 and parsed["tags"] == [] and error is None


def _write_pilot_file(tmp_path, monkeypatch, *, cand, thought, tag="bhakti"):
    vocab = {"term_count": 1, "terms": [{"slug": "bhakti", "term": "devotion", "variants": [], "facet": "Concept"}]}
    (tmp_path / "vocabulary.json").write_text(json.dumps(vocab), encoding="utf-8")
    shards = tmp_path / "shards"
    shards.mkdir()
    monkeypatch.setattr(config, "VOCAB_PATH", tmp_path / "vocabulary.json")
    monkeypatch.setattr(config, "SHARDS_DIR", shards)
    line = json.dumps({
        "key": "verses|11111111-1111-1111-1111-111111111111",
        "response": {
            "usageMetadata": {"promptTokenCount": 100, "candidatesTokenCount": cand, "thoughtsTokenCount": thought},
            "candidates": [{"content": {"parts": [{"text": json.dumps({
                "passage_function": "explains",
                "tags": [{"tag": tag, "evidence_sentence_id": "S001"}],
            })}]}, "finishReason": "STOP"}],
        },
    })
    (shards / "pilot_p2_verses_000.results.jsonl").write_text(line + "\n", encoding="utf-8")


def test_scan_counts_thinking_tokens(tmp_path, monkeypatch):
    _write_pilot_file(tmp_path, monkeypatch, cand=40, thought=25)
    res = tagging.scan_pilot_results("pilot:p2:")
    st = res["stats"]
    assert st["candidate_tokens"] == 40
    assert st["thought_tokens"] == 25
    assert st["output_tokens"] == 65               # candidates + thinking (billable)
    assert st["schema_valid_rate"] == 1.0
    assert st["distinct_tags"] == 1


def test_scan_oov_and_failure_prefix(tmp_path, monkeypatch):
    # An out-of-vocab tag is HARD-dropped; the row is still schema-valid with 0 tags.
    _write_pilot_file(tmp_path, monkeypatch, cand=10, thought=0, tag="not_in_vocab")
    res = tagging.scan_pilot_results("pilot:p2:")
    st = res["stats"]
    assert st["schema_valid_rate"] == 1.0 and st["distinct_tags"] == 0
    assert st["out_of_vocab_rate"] == 1.0


# ── diagnostics: raw reason for "other" (item 5) ─────────────────────────────

def test_classifier_and_raw_signal():
    assert tagging.classify_schema_failure(None, "RECITATION", None) == "RECITATION"
    assert tagging.classify_schema_failure(None, "MAX_TOKENS", None) == "MAX_TOKENS"
    assert tagging.classify_schema_failure(None, None, "SAFETY") == "SAFETY/PROMPT_BLOCKED"
    assert tagging.classify_schema_failure("boom", "WEIRD_NEW_REASON", None) == "other"
    sig = tagging.raw_failure_signal("boom", "WEIRD_NEW_REASON", "blk")
    assert "WEIRD_NEW_REASON" in sig and "blk" in sig and "boom" in sig


def test_scan_captures_raw_other_reason(tmp_path, monkeypatch):
    (tmp_path / "vocabulary.json").write_text(
        json.dumps({"term_count": 1, "terms": [{"slug": "x", "term": "X", "variants": [], "facet": "Concept"}]}),
        encoding="utf-8",
    )
    shards = tmp_path / "shards"
    shards.mkdir()
    monkeypatch.setattr(config, "VOCAB_PATH", tmp_path / "vocabulary.json")
    monkeypatch.setattr(config, "SHARDS_DIR", shards)
    # A transport/API error (not RECITATION/MAX_TOKENS/SAFETY, not a JSON symptom)
    # → bucket 'other', and its raw signal must be logged verbatim.
    line = json.dumps({
        "key": "verses|22222222-2222-2222-2222-222222222222",
        "error": {"code": 503, "message": "GALAXY_BRAINED backend unavailable"},
    })
    (shards / "pilot_p2_verses_000.results.jsonl").write_text(line + "\n", encoding="utf-8")
    res = tagging.scan_pilot_results("pilot:p2:")
    assert res["buckets"]["other"] == 1
    assert any("GALAXY_BRAINED" in r for r in res["other_reasons"])


# ── doctor pricing gate FAILs (item 1; per-model in v3.p3) ───────────────────

def _budget_failures(monkeypatch, prices: dict):
    """Run doctor._check_budget with an effective per-model price map. A model
    mapped to None simulates a routed model with NO pinned price at all."""
    import doctor
    monkeypatch.setattr(config, "GEMINI_BATCH_PRICES",
                        {m: p for m, p in prices.items() if p is not None})
    monkeypatch.setattr(config, "batch_prices", lambda m: prices.get(m))
    doctor._failures = 0
    doctor._check_budget()
    return doctor._failures


_CANON = {"gemini-3.5-flash": (0.75, 4.50), "gemini-3-flash-preview": (0.25, 1.50)}


def test_doctor_pricing_fail(monkeypatch):
    ok = dict(_CANON)
    assert _budget_failures(monkeypatch, ok) == 0                       # canonical → OK
    assert _budget_failures(monkeypatch, {**ok, "gemini-3-flash-preview": None}) >= 1   # unpinned routed model → FAIL
    assert _budget_failures(monkeypatch, {**ok, "gemini-3.5-flash": (0.0, 0.0)}) >= 1   # absent/zero → FAIL
    assert _budget_failures(monkeypatch, {**ok, "gemini-3.5-flash": (0.15, 1.25)}) >= 1  # known p1 stale → FAIL
    assert _budget_failures(monkeypatch, {**ok, "gemini-3-flash-preview": (0.25, 9.99)}) >= 1  # mismatch → FAIL
