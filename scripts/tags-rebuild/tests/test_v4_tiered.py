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
    assert config.TIER2_TOPK == 12
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


def test_shortlist_query_restricts_to_tier2_facets():
    # Tier 2 ranks ONLY Concept/Practice terms (entities never enter the judge).
    assert "facet = ANY(%s)" in TIERS_SRC
    assert "attach_shortlists_v4" in TAGGING_SRC
    assert "TIER2_REJECT <= sim < config.TIER2_ACCEPT" in TAGGING_SRC
