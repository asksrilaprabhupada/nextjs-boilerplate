"""
test_v4_tiered.py — the v4-tiered three-tier classifier.

All DETERMINISTIC and OFFLINE (no DB, no Gemini, no credentials). Pure logic is
exercised directly; DB-facing SQL is asserted via source-text tripwires + a
_FakeCursor that captures executemany, matching the existing test style.
"""
from pathlib import Path

import audit
import bakeoff
import config
import sentences as S
import tagging
import tiers

TIERS_SRC = Path(tiers.__file__).read_text()
TAGGING_SRC = Path(tagging.__file__).read_text()
BAKEOFF_SRC = Path(bakeoff.__file__).read_text()
AUDIT_SRC = Path(audit.__file__).read_text()


def _vocab():
    return {
        "term_count": 4,
        "terms": [
            {"slug": "krsna", "term": "Kṛṣṇa", "variants": ["Krishna"], "facet": "Person"},
            {"slug": "vrndavana", "term": "Vṛndāvana", "variants": [], "facet": "Place"},
            {"slug": "bhakti", "term": "devotion", "variants": ["bhakti"], "facet": "Concept",
             "scope_note": "loving devotional service", "hard_negatives": ["jnana"]},
            {"slug": "jnana", "term": "speculative knowledge", "variants": [], "facet": "Concept",
             "scope_note": "impersonal knowledge", "hard_negatives": ["bhakti"]},
        ],
    }


# ── config ───────────────────────────────────────────────────────────────────

def test_v4_config_constants():
    assert config.PURE_CLASSIFICATION is True
    assert config.PROMPT_VERSION == "asp-tags-v4-tiered"
    assert config.TIER1_FACETS == config.ENTITY_FACETS == {"Person", "Place", "Scripture"}
    assert config.TIER2_FACETS == {"Concept", "Practice"}
    # Tier-2 shortlist width is a config: the pilot default is 12 (the width the
    # judge mechanism was validated on); the full run widens to 20.
    assert config.TIER2_SHORTLIST_K == 12
    assert config.TIER2_SHORTLIST_K_FULL == 20
    assert 0.0 < config.TIER2_REJECT < config.TIER2_ACCEPT < 1.0
    assert config.TIER3_MODEL == config.MODEL_STANDARD == "gemini-3-flash-preview"
    assert config.TIER3_ESCALATION_MODEL == config.MODEL_CORE == "gemini-3.5-flash"
    assert config.PILOT_SHARD_PREFIX == "pilot:v4:" and config.FULL_SHARD_PREFIX == "full:v4:"


def test_audit_ddl_has_method_confidence_and_outcomes():
    assert "ADD COLUMN IF NOT EXISTS method" in AUDIT_SRC
    assert "ADD COLUMN IF NOT EXISTS confidence real" in AUDIT_SRC
    assert "tag_passage_outcomes" in AUDIT_SRC
    # the (now canonical) legacy evidence writer carries method + confidence too
    assert "method, confidence)" in AUDIT_SRC


# ── Tier 1: exact aliases ─────────────────────────────────────────────────────

def test_tier1_exact_alias_hits_entities_only():
    idx = tiers.EntityAliasIndex(_vocab())
    sents = S.split_sentences("Kṛṣṇa spoke. Vrndavana glowed. Pure devotion grew.")
    hits = tiers.tier1_hits(sents, idx)
    by_slug = {h.slug: h for h in hits}
    # Person + Place matched (diacritic-insensitive: "Vrndavana" ↔ "Vṛndāvana").
    assert set(by_slug) == {"krsna", "vrndavana"}
    assert by_slug["krsna"].sentence_id == "S001" and "Kṛṣṇa" in by_slug["krsna"].evidence
    assert by_slug["vrndavana"].sentence_id == "S002"
    # A Concept term ("devotion") is NEVER assigned by the exact-alias tier.
    assert "bhakti" not in by_slug


def test_tier1_word_boundary_and_first_sentence_wins():
    idx = tiers.EntityAliasIndex(_vocab())
    # "Krishnaism" must NOT match the "Krishna" alias (word boundary).
    assert tiers.tier1_hits(S.split_sentences("Krishnaism prevails."), idx) == []
    # First matching sentence wins; a later mention does not add a second hit.
    hits = tiers.tier1_hits(S.split_sentences("Krishna is here. Krishna again."), idx)
    assert [h.slug for h in hits] == ["krsna"] and hits[0].sentence_id == "S001"


# ── Tier 2: banding + calibration ─────────────────────────────────────────────

def test_tier2_band():
    assert tiers.band(0.60, 0.47, 0.22) == "accept"
    assert tiers.band(0.47, 0.47, 0.22) == "accept"     # ≥ accept
    assert tiers.band(0.30, 0.47, 0.22) == "judge"
    assert tiers.band(0.22, 0.47, 0.22) == "judge"      # ≥ reject → judged, not dropped
    assert tiers.band(0.21, 0.47, 0.22) == "reject"


def test_pick_thresholds_rule():
    pairs = [(0.6, True), (0.6, True), (0.5, True), (0.5, False),
             (0.3, True), (0.3, False), (0.3, False), (0.1, False)]
    r = tiers.pick_thresholds(pairs, target_accept_precision=0.8, target_reject_recall=0.75)
    # T_accept = smallest grid t with precision ≥ 0.8 (0.51: only the two 0.6s).
    assert r["t_accept"] == 0.51
    assert r["accept_precision"] == 1.0
    # T_reject = largest t retaining ≥ 0.75 of in-shortlist positives (0.50),
    # clamped ≤ T_accept.
    assert r["t_reject"] == 0.50
    assert r["reject_recall_retained"] == 0.75
    assert r["t_reject"] <= r["t_accept"]
    # per-band counts on the pooled candidates.
    assert r["pairs_auto_accepted"] == 2   # the two 0.6s
    assert r["pairs_judged"] == 2          # the two 0.5s
    assert r["pairs_auto_rejected"] == 4   # 0.3,0.3,0.3,0.1


def test_pick_thresholds_fallback_when_target_unreachable():
    # No candidate clears precision 0.99 → fall back to the most-precise supported t.
    pairs = [(0.5, True), (0.5, False), (0.4, False)]
    r = tiers.pick_thresholds(pairs, target_accept_precision=0.99, target_reject_recall=0.9)
    assert r["t_accept"] in {row["t"] for row in r["sweep"]}
    assert r["accept_precision"] is not None


# ── merge ─────────────────────────────────────────────────────────────────────

def test_merge_tags_priority_dedupe_cap():
    merged = tiers.merge_tags(["krsna"], ["bhakti", "krsna"], ["jnana", "bhakti"], cap=12)
    assert merged == ["krsna", "bhakti", "jnana"]      # tier order, deduped
    assert tiers.merge_tags(["a", "b", "c"], ["d"], ["e"], cap=2) == ["a", "b"]


# ── Tier 3: classification-only request ───────────────────────────────────────

def test_response_schema_v4_is_classification_only():
    sch = tagging.response_schema_v4(["bhakti", "jnana"], ["S001", "S002"])
    assert set(sch["properties"]) == {"tags"} and sch["required"] == ["tags"]
    item = sch["properties"]["tags"]["items"]["properties"]
    assert set(item) == {"slug", "evidence_sentence_id"}
    assert item["slug"]["enum"] == ["bhakti", "jnana"]
    assert item["evidence_sentence_id"]["enum"] == ["S001", "S002"]


def test_build_prompt_v4_hard_negatives_only_if_shortlisted():
    vocab = tagging.VocabIndex(_vocab())
    sents = S.split_sentences("Devotion is the path.")
    # Both partners shortlisted → the contrast is shown.
    p = tagging.Passage("verses", "x", "Devotion is the path.", "HIS", False,
                        shortlist=["bhakti", "jnana"])
    both = tagging.build_prompt_v4(p, vocab, sents)
    assert "Do NOT confuse with: jnana" in both
    # Only bhakti shortlisted → its hard-negative jnana is NOT surfaced (not a candidate).
    p2 = tagging.Passage("verses", "x", "Devotion is the path.", "HIS", False, shortlist=["bhakti"])
    one = tagging.build_prompt_v4(p2, vocab, sents)
    assert "Do NOT confuse with" not in one
    assert "passage_function" not in one and "questions" not in one


# ── gate + write: slug field, method/confidence, merged tags_core ─────────────

def test_gate_reads_slug_and_tags_method_confidence():
    # v4 reads {"slug": …}; evidence carries method + confidence; the judge's
    # NEGATIVE decisions (middle-band, not confirmed) are recorded as llm_rejected.
    assert 'item.get("slug")' in TAGGING_SRC
    assert '"llm_confirmed"' in TAGGING_SRC
    assert '"llm_rejected"' in TAGGING_SRC
    # 12-column tag_evidence insert (…, method, confidence) in the atomic writer.
    assert "evidence_sentence_id," in TAGGING_SRC and "method, confidence)" in TAGGING_SRC
    # 13 VALUES placeholders (run_id + the 12-tuple).
    assert "VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)" in TAGGING_SRC


class _FakeCursor:
    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append(("execute", sql, params))

    def executemany(self, sql, rows):
        self.calls.append(("executemany", sql, list(rows)))


def test_recompute_tags_core_merges_from_evidence():
    cur = _FakeCursor()
    tiers.recompute_tags_core(cur, "run-1", "verses", ["id-a", "id-b"])
    assert len(cur.calls) == 1
    kind, sql, rows = cur.calls[0]
    assert kind == "executemany"
    # merges ALL accepted evidence (tiers 1+2+3), highest-confidence first, capped.
    assert "FROM public.tag_evidence" in sql and "AND accepted" in sql
    assert "max(confidence) DESC NULLS LAST" in sql
    assert "LIMIT %s" in sql and "COALESCE(" in sql and "'{}'::text[]" in sql
    # one param row per passage: (run, table, pid, MAX_TAGS, pid)
    assert rows[0] == ("run-1", "verses", "id-a", config.MAX_TAGS, "id-a")


def test_free_tier_writer_is_idempotent_by_method():
    # apply_free_tiers deletes only its OWN evidence (exact_alias/semantic) before
    # rewriting, so re-running never duplicates and never touches Tier-3 rows.
    assert tiers._FREE_TIER_METHODS == ("exact_alias", "semantic")
    assert "DELETE FROM public.tag_evidence" in TIERS_SRC
    assert "method = ANY(%s)" in TIERS_SRC


# ── queue-wait fix (429): now covers bakeoff too ─────────────────────────────

def test_queue_wait_covers_bakeoff():
    # bakeoff no longer calls create_batch directly — it uses the shared draining
    # helper with a state-file inflight callback, so a full queue makes it WAIT.
    assert "_create_batch_draining_queue" in BAKEOFF_SRC
    assert "inflight_fn=" in BAKEOFF_SRC
    assert "def _inflight_jobs_from_state" in BAKEOFF_SRC
    assert "gemini_client.create_batch" not in BAKEOFF_SRC   # only via the helper now
    # the helper accepts an inflight_fn so pilot/full/bakeoff share one wait.
    assert "def _poll_queue_quota(already_terminal: set[str], inflight_fn=None)" in TAGGING_SRC
    assert "def _inflight_jobs_from_db" in TAGGING_SRC


def test_both_entrypoints_dispatch_to_v4_pilot():
    # BOTH `--pilot-only` (pilot_only) AND the full pipeline (main) must branch to
    # run_pilot_v4 under pure classification — otherwise `python run_all.py` would
    # silently run the legacy generative pilot and skip calibration + free tiers.
    # Both now thread --accept-quarantine through (trailing `,` after vocab_index).
    import run_all
    src = Path(run_all.__file__).read_text()
    assert src.count("run_pilot_v4(run_id, models, vocab_index") >= 2
    assert src.count("if config.PURE_CLASSIFICATION:\n        run_pilot_v4") == 2
    # …and both call sites pass the flag explicitly.
    assert src.count("run_pilot_v4(run_id, models, vocab_index, accept_quarantine=") == 2


def test_shortlist_query_restricts_to_tier2_facets():
    # Tier 2 ranks ONLY Concept/Practice terms (entities never enter the judge).
    assert "facet = ANY(%s)" in TIERS_SRC
    assert "attach_shortlists_v4" in TAGGING_SRC
    assert "TIER2_REJECT <= sim < config.TIER2_ACCEPT" in TAGGING_SRC


# ── Fix 3: shortlist width is a config (default 12; full run widens to 20) ────

def test_shortlist_width_config_replaces_topk():
    # The active width is the config; the legacy hard-coded TIER2_TOPK is gone from
    # the code paths (only the back-compat env alias inside config.py may name it).
    assert "config.TIER2_SHORTLIST_K" in TIERS_SRC and "config.TIER2_TOPK" not in TIERS_SRC
    assert "config.TIER2_SHORTLIST_K" in TAGGING_SRC and "config.TIER2_TOPK" not in TAGGING_SRC


def test_calibration_and_shortlist_default_to_active_width():
    # Both the calibrator and the shortlist reader default topk to the ACTIVE width,
    # so setting config.TIER2_SHORTLIST_K (full run) flows to calibration + banding.
    assert "topk = topk or config.TIER2_SHORTLIST_K" in TIERS_SRC
    assert TIERS_SRC.count("topk = topk or config.TIER2_SHORTLIST_K") == 2


def test_full_run_widens_then_recalibrates():
    # run_full must set the active width to the FULL value BEFORE it recalibrates,
    # so calibration sweeps the k=20 shortlist (same sweep, same targets).
    import run_all
    src = Path(run_all.__file__).read_text()
    widen = src.index("config.TIER2_SHORTLIST_K = config.TIER2_SHORTLIST_K_FULL")
    recal = src.index("cal = tiers.calibrate_tier2_thresholds()", widen)
    assert 0 <= widen < recal
    # the recalibrated thresholds + width are recorded for the audit trail.
    assert "tier2_shortlist_k_full" in src and "tier2_thresholds_full" in src


# ── Fix 1 + 2: quarantine listing + --accept-quarantine in the pilot ──────────

def test_pilot_report_v4_renders_quarantine_and_rich_samples():
    # The v4 report gained the quarantine listing (table · id · per-attempt
    # finishReason/blockReason history · excerpt) and the raw `other` signal, plus
    # samples that show method + evidence sentence — all previously missing.
    assert "def write_pilot_report_v4(" in TAGGING_SRC
    assert "unresolved: dict | None = None" in TAGGING_SRC
    assert "accepted_quarantine: bool = False" in TAGGING_SRC
    assert "## Quarantine — rows still invalid after retry + escalation" in TAGGING_SRC
    assert "pilot_quarantine_listing(prefix, unresolved)" in TAGGING_SRC
    assert "_failure_reason_lines(scan_pilot_results(prefix))" in TAGGING_SRC
    # rich samples: method + evidence sentence per accepted tag.
    assert "method {method_s} · evidence" in TAGGING_SRC
    assert "coalesce(method, '')" in TAGGING_SRC


def test_pilot_only_and_run_pilot_v4_honor_accept_quarantine():
    import run_all
    src = Path(run_all.__file__).read_text()
    # signatures + plumbing.
    assert "def run_pilot_v4(run_id: str, models: dict, vocab_index, accept_quarantine: bool = False)" in src
    assert "def pilot_only(accept_quarantine: bool = False)" in src
    assert "pilot_only(accept_quarantine=args.accept_quarantine)" in src
    # refuse ONLY without the flag; otherwise apply + quarantine + continue.
    assert "if n_still > 0 and not accept_quarantine:" in src
    assert "quarantined = tagging.quarantine_exhausted(run_id)" in src
    assert "accepted_quarantine=bool(n_still)" in src


def _write(path, lines):
    path.write_text("".join(lines), encoding="utf-8")


def test_pilot_quarantine_listing_reconstructs_full_history(tmp_path, monkeypatch):
    import json

    prefix = "pilot:v4:abc12345:"
    base = prefix.replace(":", "_")
    std, core = config.MODEL_STANDARD, config.MODEL_CORE

    def rline(key, finish=None, block=None, err=None):
        if err:
            return json.dumps({"key": key, "error": err}) + "\n"
        cand = {"content": {"parts": [{"text": "not valid json"}]}}
        if finish:
            cand["finishReason"] = finish
        resp = {"key": key, "response": {"candidates": [cand], "usageMetadata": {}}}
        if block:
            resp["response"]["promptFeedback"] = {"blockReason": block}
        return json.dumps(resp) + "\n"

    # Row A: attempt 1 RECITATION (std) → 2 SAFETY (std) → 3 escalated, RECITATION (core).
    _write(tmp_path / f"{base}{std}_verses_000.results.jsonl",
           [rline("verses|A", finish="RECITATION"), rline("verses|B", finish="MAX_TOKENS")])
    _write(tmp_path / f"{base}retry_{std}_verses_000.results.jsonl",
           [rline("verses|A", finish="SAFETY"), rline("verses|B")])  # B: no signal → MALFORMED_JSON
    _write(tmp_path / f"{base}esc_{core}_verses_000.results.jsonl",
           [rline("verses|A", finish="RECITATION"), rline("verses|B", block="SAFETY")])

    monkeypatch.setattr(config, "SHARDS_DIR", tmp_path)
    monkeypatch.setattr(tagging, "load_passages", lambda table, ids: [
        tagging.Passage(table, pid, f"Body of {pid}. " * 20, "HIS", False) for pid in ids])

    still = {(std, "verses"): ["A", "B"]}
    listing = tagging.pilot_quarantine_listing(prefix, still)

    assert [r["passage_id"] for r in listing] == ["A", "B"]
    a = next(r for r in listing if r["passage_id"] == "A")
    # attempts ordered 1→3, reconstructed across first-pass/retry/esc files.
    assert [x["attempt"] for x in a["attempts"]] == [1, 2, 3]
    assert [x["bucket"] for x in a["attempts"]] == [
        "RECITATION", "SAFETY/PROMPT_BLOCKED", "RECITATION"]
    assert a["attempts"][2]["model"] == core   # attempt 3 escalated to the core model
    assert a["excerpt"].startswith("Body of A")
    b = next(r for r in listing if r["passage_id"] == "B")
    assert [x["bucket"] for x in b["attempts"]] == [
        "MAX_TOKENS", "MALFORMED_JSON", "SAFETY/PROMPT_BLOCKED"]


def test_pilot_quarantine_listing_logs_other_raw_signal(tmp_path, monkeypatch):
    import json

    prefix = "pilot:v4:def67890:"
    base = prefix.replace(":", "_")
    std = config.MODEL_STANDARD
    # A transport/API error (no JSON symptom, no recognized finish/block reason)
    # lands in the `other` bucket — its raw signal MUST be kept inline (never lost).
    line = json.dumps({"key": "verses|Z",
                       "error": {"code": 503, "message": "backend unavailable"}}) + "\n"
    _write(tmp_path / f"{base}{std}_verses_000.results.jsonl", [line])
    monkeypatch.setattr(config, "SHARDS_DIR", tmp_path)
    monkeypatch.setattr(tagging, "load_passages", lambda table, ids: [])
    listing = tagging.pilot_quarantine_listing(prefix, {(std, "verses"): ["Z"]})
    (attempt,) = listing[0]["attempts"]
    assert attempt["bucket"] == "other"
    assert "backend unavailable" in attempt["raw"]
