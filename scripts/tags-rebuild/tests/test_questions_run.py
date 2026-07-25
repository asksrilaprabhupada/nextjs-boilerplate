"""
Offline tests for questions_run.py (STEPS 1-4 of the final column build).

Everything here is pure — no DB, no network. The point is to pin the rules that
are expensive or irreversible to get wrong:

  • the BREAKING CHANGE: no sampling knobs may reach either model, and the final
    input turn must never carry role "model";
  • the routing contract (43,232 / 200,916 / 244,148);
  • the purport de-duplication that stops us paying twice for 11,945 purports;
  • the response validator — the check that would have caught the silent field
    drop in the last run;
  • the money math, including thinking tokens billed at the OUTPUT rate.
"""
import json

import pytest

import config
import questions_run as qr


# ── the breaking change ─────────────────────────────────────────────────────

FORBIDDEN_KNOBS = {
    "temperature", "topP", "top_p", "topK", "top_k",
    "frequencyPenalty", "frequency_penalty",
    "presencePenalty", "presence_penalty",
}


def _walk_keys(obj):
    if isinstance(obj, dict):
        for k, v in obj.items():
            yield k
            yield from _walk_keys(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_keys(v)


def _passage(text="Kṛṣṇa is the Supreme Personality of Godhead.", table="verses"):
    return qr.Passage(table=table, id="11111111-2222-3333-4444-555555555555",
                      text=text, model=qr.MODEL_36)


def test_generation_config_sends_no_sampling_knobs():
    """gemini-3.6-flash ignores temperature/top_p/top_k and RAISES on the
    penalties. None of them may be present for EITHER model."""
    keys = set(_walk_keys(qr.generation_config()))
    assert not (keys & FORBIDDEN_KNOBS), f"forbidden knob(s) present: {keys & FORBIDDEN_KNOBS}"


def test_full_request_sends_no_sampling_knobs():
    keys = set(_walk_keys(qr.request_line(_passage())))
    assert not (keys & FORBIDDEN_KNOBS)


def test_final_input_turn_is_user_never_model():
    """The final input turn must not have role 'model'."""
    contents = qr.request_line(_passage())["request"]["contents"]
    assert len(contents) == 1
    assert contents[-1]["role"] == "user"
    assert all(turn.get("role") != "model" for turn in contents)


def test_request_carries_thinking_level_and_output_cap():
    cfg = qr.request_line(_passage())["request"]["generationConfig"]
    assert cfg["thinkingConfig"]["thinkingLevel"] == "LOW"
    assert cfg["maxOutputTokens"] == qr.MAX_OUTPUT_TOKENS
    assert cfg["responseMimeType"] == "application/json"


def test_request_key_is_table_pipe_id():
    line = qr.request_line(_passage())
    assert line["key"] == f"verses|{_passage().id}"


# ── routing ─────────────────────────────────────────────────────────────────

def test_expected_totals_are_self_consistent():
    assert qr.EXPECTED_CORE + qr.EXPECTED_STANDARD == qr.EXPECTED_TOTAL
    assert qr.EXPECTED_TOTAL == 244_148


@pytest.mark.parametrize("table,scripture,expected", [
    ("verses", "BG", qr.MODEL_36),
    ("verses", "SB", qr.MODEL_36),
    ("verses", "CC", qr.MODEL_36),
    ("verses", "bg", qr.MODEL_36),          # case-insensitive
    ("verses", "ISO", qr.MODEL_3),
    ("verses", "BS", qr.MODEL_3),
    ("verses", None, qr.MODEL_3),           # unknown is never assumed core
    ("verses", "", qr.MODEL_3),
    ("verse_chunks", "SB", qr.MODEL_36),
    ("verse_chunks", "NOI", qr.MODEL_3),
    ("prose_paragraphs", "BG", qr.MODEL_3),  # scripture is irrelevant off-verse
    ("transcript_paragraphs", None, qr.MODEL_3),
    ("letter_paragraphs", None, qr.MODEL_3),
])
def test_model_routing(table, scripture, expected):
    assert qr.model_for(table, scripture) == expected


def test_every_table_is_routed_somewhere():
    for table in qr.TABLES:
        assert qr.model_for(table, None) in (qr.MODEL_36, qr.MODEL_3)


def test_routed_model_strings_are_exact():
    """The literal strings are the contract. The cheap model is `gemini-3-flash`
    — NOT `gemini-3.0-flash`, which is a different (nonexistent) id and would be
    rejected by confirm_model after the plan was already built."""
    assert qr.MODEL_36 == "gemini-3.6-flash"
    assert qr.MODEL_3 == "gemini-3-flash"


def test_assert_routing_totals_rejects_a_changed_corpus():
    good = {("verses", qr.MODEL_36): qr.EXPECTED_CORE,
            ("transcript_paragraphs", qr.MODEL_3): qr.EXPECTED_STANDARD}
    qr.assert_routing_totals(good)  # must not raise

    bad = dict(good)
    bad[("verses", qr.MODEL_36)] = qr.EXPECTED_CORE - 1
    with pytest.raises(SystemExit):
        qr.assert_routing_totals(bad)


# ── purport de-duplication + truncation ─────────────────────────────────────

def test_verse_with_chunks_omits_the_purport():
    """11,945 purports are also split across verse_chunks; sending them on the
    parent verse too would bill the same text twice."""
    text = qr._verse_text("TR", "SY", "PURPORT BODY", has_chunks=True)
    assert "TR" in text and "SY" in text
    assert "PURPORT BODY" not in text


def test_verse_without_chunks_includes_the_purport():
    text = qr._verse_text("TR", "SY", "PURPORT BODY", has_chunks=False)
    assert "TR" in text and "PURPORT BODY" in text


def test_verse_text_survives_missing_fields():
    assert qr._verse_text(None, None, None, has_chunks=True) == ""
    assert "TR" in qr._verse_text("TR", None, None, has_chunks=False)


def test_cap_truncates_at_6000_and_reports_the_original_length():
    assert qr.PASSAGE_CHAR_CAP == 6000
    short, was = qr._cap("x" * 100)
    assert was == 0 and len(short) == 100
    long, was = qr._cap("y" * 9000)
    assert len(long) == qr.PASSAGE_CHAR_CAP
    assert was == 9000


def test_cap_handles_none():
    assert qr._cap(None) == ("", 0)


# ── response schema ─────────────────────────────────────────────────────────

def test_schema_puts_evidence_before_answers():
    schema = qr.response_schema()
    order = schema["propertyOrdering"]
    assert order == ["passage_id", "speaker", "speaker_evidence", "eligible",
                     "questions", "function", "function_evidence"]
    # the proving quote is committed to before the questions it supports
    assert order.index("speaker_evidence") < order.index("questions")
    item_order = schema["properties"]["questions"]["items"]["propertyOrdering"]
    assert item_order == ["support_quote", "question"]


def test_schema_keeps_the_fine_grained_labels():
    schema = qr.response_schema()
    functions = schema["properties"]["function"]["enum"]
    assert len(functions) == 17          # 16 fine-grained + "unclear"
    assert "unclear" in functions
    assert "not_applicable" not in functions   # that was the tags-era enum
    assert schema["properties"]["speaker"]["enum"] == qr.SPEAKERS
    assert len(qr.SPEAKERS) == 6


def test_schema_caps_questions_at_three():
    assert qr.response_schema()["properties"]["questions"]["maxItems"] == 3
    assert qr.MAX_QUESTIONS == 3


def test_every_function_label_has_a_gloss_in_the_prompt():
    prompt = qr.build_prompt(_passage())
    for name in qr.FUNCTIONS:
        assert name in prompt


def test_prompt_states_the_hard_rules():
    prompt = qr.build_prompt(_passage())
    for rule in ("VERBATIM", "meta-reference", "DIFFERENT point", "Sanskrit",
                 "EMPTY questions list", "0 to 3"):
        assert rule in prompt, f"prompt lost the rule: {rule}"


def test_prompt_embeds_the_passage_and_id():
    p = _passage(text="A distinctive sentence about bhakti.")
    prompt = qr.build_prompt(p)
    assert p.id in prompt
    assert "A distinctive sentence about bhakti." in prompt


# ── the validator (the silent-field-drop guard) ─────────────────────────────

def _good_payload(**overrides):
    payload = {
        "passage_id": "abc",
        "speaker": "explicit_prabhupada",
        "speaker_evidence": "Prabhupāda: ...",
        "eligible": True,
        "questions": [{"support_quote": "q", "question": "What is bhakti?"}],
        "function": "explains",
        "function_evidence": "because ...",
    }
    payload.update(overrides)
    return payload


def test_validator_accepts_a_complete_row():
    row, reason = qr.validate_row("verses", "id", _good_payload())
    assert reason is None and row is not None
    assert row.speaker == "explicit_prabhupada"
    assert row.function == "explains"
    assert len(row.questions) == 1


@pytest.mark.parametrize("dropped", ["speaker", "speaker_evidence", "eligible",
                                     "questions", "function", "function_evidence"])
def test_validator_rejects_any_missing_field(dropped):
    """A MISSING field is invalid — this is the check that would have caught the
    silent field drop in the last run."""
    payload = _good_payload()
    del payload[dropped]
    row, reason = qr.validate_row("verses", "id", payload)
    assert row is None
    assert dropped in reason


def test_validator_accepts_an_empty_question_list():
    """Zero questions is a valid, preferred answer for filler — not a failure."""
    row, reason = qr.validate_row("verses", "id",
                                  _good_payload(questions=[], eligible=False))
    assert reason is None and row is not None
    assert row.questions == []


def test_validator_rejects_out_of_enum_values():
    assert qr.validate_row("verses", "id", _good_payload(speaker="pope"))[0] is None
    assert qr.validate_row("verses", "id", _good_payload(function="vibes"))[0] is None


def test_validator_rejects_non_list_questions():
    assert qr.validate_row("verses", "id", _good_payload(questions="none"))[0] is None


def test_validator_drops_blank_questions_without_failing_the_row():
    row, reason = qr.validate_row("verses", "id", _good_payload(questions=[
        {"support_quote": "a", "question": "  "},
        {"support_quote": "b", "question": "Who is Kṛṣṇa?"},
    ]))
    assert reason is None
    assert [q["question"] for q in row.questions] == ["Who is Kṛṣṇa?"]


def test_validator_truncates_over_long_question_lists():
    row, _ = qr.validate_row("verses", "id", _good_payload(questions=[
        {"support_quote": "s", "question": f"Q{i}?"} for i in range(9)
    ]))
    assert len(row.questions) == qr.MAX_QUESTIONS


def test_validator_rejects_a_non_object():
    assert qr.validate_row("verses", "id", ["nope"])[0] is None


# ── stored value shape ──────────────────────────────────────────────────────

def test_questions_text_is_newline_joined():
    text = qr.questions_text([{"question": "A?"}, {"question": "B?"}])
    assert text == "A?\nB?"


def test_empty_questions_store_as_empty_string_not_null():
    """The STEP 3 assertion requires a non-null value for every processed row;
    an empty list is fine, a missing field is not."""
    assert qr.questions_text([]) == ""
    assert qr.questions_text([]) is not None


# ── the write path: ONE pass per row per table ──────────────────────────────
#
# Writing these columns can never be a HOT update (questions_fts is GIN-indexed),
# so every row written re-inserts into every index on the table — including the
# 1.1 GB HNSW vector index on transcript_paragraphs. A second pass over that
# table costs roughly five hours of index maintenance for nothing, so the four
# columns MUST go down in a single UPDATE. This test is the guard.

class _Noop:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeCursor:
    def __init__(self, log):
        self.log = log
        self.rowcount = 0

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=None):
        self.log.append(" ".join(str(sql).split()))
        self.rowcount = 1


class _FakeConn:
    def __init__(self):
        self.log: list[str] = []

    def cursor(self):
        return _FakeCursor(self.log)

    def transaction(self):
        return _Noop()


def _row(i):
    return qr.RowResult(
        table="transcript_paragraphs", passage_id=f"id{i}",
        speaker="explicit_prabhupada", speaker_evidence="Prabhupāda: ...",
        eligible=True,
        questions=[{"support_quote": "s", "question": "What is bhakti?"}],
        function="explains", function_evidence="because ...")


def _apply(monkeypatch, rows_):
    conn = _FakeConn()
    monkeypatch.setattr(qr.db, "get_pg", lambda: conn)
    monkeypatch.setattr(qr, "prewarm_table_indexes", lambda table: None)
    outcome = qr.ShardOutcome("q-full-abcdef12-transcript_paragraphs-m3-a1-000",
                              "transcript_paragraphs", qr.MODEL_3)
    outcome.applied = rows_
    qr.apply_outcome(outcome, "00000000-0000-0000-0000-000000000000", "full")
    return [s for s in conn.log if s.startswith("UPDATE public.transcript_paragraphs")]


def test_all_four_columns_go_down_in_one_update(monkeypatch):
    updates = _apply(monkeypatch, [_row(i) for i in range(3)])
    assert len(updates) == 1, (
        f"expected ONE UPDATE over transcript_paragraphs, got {len(updates)}"
        " — a per-column pass costs ~5h of index maintenance each")
    sql = updates[0]
    for assignment in ("questions = d.q", "passage_function = d.fn",
                       "speaker = d.sp", "speaker_evidence = d.se"):
        assert assignment in sql, f"the single UPDATE lost {assignment!r}"


def test_write_batches_by_chunk_not_by_column(monkeypatch):
    """More rows than DB_WRITE_CHUNK split by ROWS (one UPDATE per chunk), never
    by column — the count must track the chunking, not the four columns."""
    n = qr.DB_WRITE_CHUNK + 1
    updates = _apply(monkeypatch, [_row(i) for i in range(n)])
    assert len(updates) == 2
    for sql in updates:
        assert "speaker_evidence = d.se" in sql


# ── response parsing + usage metering ───────────────────────────────────────

def _response_line(payload, prompt=100, cand=40, thoughts=25):
    return json.dumps({
        "key": "verses|abc",
        "response": {
            "candidates": [{"content": {"parts": [{"text": json.dumps(payload)}]},
                            "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": prompt,
                              "candidatesTokenCount": cand,
                              "thoughtsTokenCount": thoughts},
        },
    })


def test_parse_response_line_reads_a_normal_batch_line():
    key, parsed, usage, error = qr._parse_response_line(_response_line(_good_payload()))
    assert key == "verses|abc" and error is None
    assert parsed["function"] == "explains"
    assert usage["promptTokenCount"] == 100


def test_parse_response_line_surfaces_provider_errors():
    line = json.dumps({"key": "verses|abc", "error": {"code": 429}})
    _key, parsed, _usage, error = qr._parse_response_line(line)
    assert parsed is None and error


def test_parse_response_line_never_raises_on_garbage():
    _key, parsed, _usage, error = qr._parse_response_line("{not json")
    assert parsed is None and error


def test_parse_response_line_flags_truncated_output():
    line = json.dumps({"key": "verses|abc", "response": {"candidates": [
        {"content": {"parts": [{"text": '{"speaker":'}]}, "finishReason": "MAX_TOKENS"}]}})
    _key, parsed, _usage, error = qr._parse_response_line(line)
    assert parsed is None and "MAX_TOKENS" in error


def test_usage_counts_thinking_tokens_as_output(tmp_path):
    path = tmp_path / "r.jsonl"
    path.write_text(_response_line(_good_payload(), 100, 40, 25) + "\n"
                    + _response_line(_good_payload(), 200, 60, 15) + "\n",
                    encoding="utf-8")
    inp, out, cand, thought = qr.usage_from_results_file(path)
    assert inp == 300
    assert cand == 100 and thought == 40
    assert out == 140, "output must be candidates + thinking (both billed at the out rate)"


# ── money ───────────────────────────────────────────────────────────────────

def test_batch_prices_are_the_halved_rates():
    assert qr.PRICES[qr.MODEL_36] == (0.75, 3.75)
    assert qr.PRICES[qr.MODEL_3] == (0.25, 1.50)


def test_usd_prices_input_and_output_separately():
    assert qr.usd(qr.MODEL_36, 1_000_000, 0) == pytest.approx(0.75)
    assert qr.usd(qr.MODEL_36, 0, 1_000_000) == pytest.approx(3.75)
    assert qr.usd(qr.MODEL_3, 1_000_000, 1_000_000) == pytest.approx(1.75)


def test_unpriced_model_is_a_hard_stop():
    with pytest.raises(SystemExit):
        qr.prices_for("gemini-nonexistent")


def test_ceiling_default_is_380():
    """The approved budget. MAX_SPEND_USD is ONE env var shared with the tagging
    harness, so the two modules must pin the same default — a split default means
    the effective ceiling depends on which module happens to read it."""
    assert qr.MAX_SPEND_USD == 380.0
    assert config.MAX_SPEND_USD == qr.MAX_SPEND_USD


# ── pilot manifest allocation ───────────────────────────────────────────────

def test_pilot_allocation_hits_the_exact_size_and_respects_caps():
    strata = {
        ("verses", qr.MODEL_36): 25_020,
        ("verses", qr.MODEL_3): 111,
        ("verse_chunks", qr.MODEL_36): 18_212,
        ("verse_chunks", qr.MODEL_3): 487,
        ("prose_paragraphs", qr.MODEL_3): 36_412,
        ("transcript_paragraphs", qr.MODEL_3): 144_438,
        ("letter_paragraphs", qr.MODEL_3): 19_468,
    }
    floors = {k: min(qr.PILOT_FLOOR_PER_STRATUM, v) for k, v in strata.items()}
    headroom = {k: strata[k] - floors[k] for k in strata}
    extra = qr._largest_remainder(qr.PILOT_SIZE - sum(floors.values()), headroom, headroom)
    alloc = {k: floors[k] + extra[k] for k in strata}

    assert sum(alloc.values()) == qr.PILOT_SIZE
    for k, n in alloc.items():
        assert 0 < n <= strata[k], f"{k} allocated {n} of {strata[k]}"
    # every table AND both models are represented
    assert {t for t, _m in alloc} == set(qr.TABLES)
    assert {m for _t, m in alloc} == {qr.MODEL_36, qr.MODEL_3}


def test_pilot_size_is_2000():
    assert qr.PILOT_SIZE == 2000


def test_auto_continue_threshold_is_360():
    """Raised 320 → 360 for the approved ~$313 run: the pilot's extrapolation
    must clear the approved number, or the gate stops a run that was signed off.
    It stays BELOW the $380 ceiling — a gate at or above the ceiling would wave
    through a full run that submission then refuses part-way."""
    assert qr.PILOT_AUTO_CONTINUE_USD == 360.0
    assert qr.PILOT_AUTO_CONTINUE_USD < qr.MAX_SPEND_USD


# ── meta-reference detector ─────────────────────────────────────────────────

@pytest.mark.parametrize("question", [
    "What does this passage say about devotional service?",
    "According to the text, who is the Supreme?",
    "What is the author's view of karma?",
    "In this verse, what is prescribed?",
    "What does the speaker recommend?",
])
def test_meta_reference_detector_catches_meta_questions(question):
    assert qr.META_RE.search(question)


@pytest.mark.parametrize("question", [
    "What is bhakti-yoga?",
    "Why does Kṛṣṇa say that surrender is the highest path?",
    "How should a devotee chant the holy name?",
    "What is the difference between the soul and the body?",
])
def test_meta_reference_detector_leaves_good_questions_alone(question):
    assert not qr.META_RE.search(question)


# ── misc invariants ─────────────────────────────────────────────────────────

def test_shard_keys_are_filename_safe():
    """Shard keys become filenames; a ':' or '/' would break the mapping."""
    key = f"q-full-abcdef12-verses-{qr.model_tag(qr.MODEL_36)}-a1-000"
    assert ":" not in key and "/" not in key
    assert qr.shard_path(key, "requests").name.endswith(".requests.jsonl")


def test_model_tags_are_distinct():
    assert qr.model_tag(qr.MODEL_36) != qr.model_tag(qr.MODEL_3)


def test_tables_match_the_five_content_tables():
    assert set(qr.TABLES) == {"verses", "verse_chunks", "prose_paragraphs",
                              "transcript_paragraphs", "letter_paragraphs"}
