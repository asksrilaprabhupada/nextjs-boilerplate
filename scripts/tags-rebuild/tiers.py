"""
tiers.py — the v4-tiered classifier (Tiers 1-2, calibration, and the merge).

v4 REPLACES the single generative Gemini pass with a three-tier classifier over
the frozen 251-term vocabulary. Only Tier 3 costs money:

  Tier 1 — EXACT ALIASES (free). Person/Place/Scripture terms are matched by
    their term + variants against the passage sentences (word-boundary,
    diacritic-insensitive — the same `fold_text` normalization the fts_core
    lane uses). A hit assigns the tag with method='exact_alias', confidence=1.0,
    evidence = the FIRST matching sentence (id + offsets).

  Tier 2 — EMBEDDING SHORTLIST (free). Concept/Practice terms are ranked by
    cosine similarity between the passage `embedding_context4` and
    `vocab_terms.embedding`; the top TIER2_TOPK per passage form the shortlist.
    Two thresholds (calibrated against the p1 pilot tags) band each candidate:
    ≥ T_accept → auto-assign (method='semantic', confidence=similarity);
    < T_reject → drop; in between → the Tier-3 judge (tagging.py).

  Tier 3 — LLM JUDGE (paid; lives in tagging.py). Only the middle-band
    Concept/Practice candidates are shown to the model, which confirms which
    genuinely apply (method='llm_confirmed').

This module owns the two FREE tiers, the calibration, the merge, and the
row-level free-tier writer. The paid Tier-3 batch machinery, gating and
row-level completion are reused verbatim from tagging.py. Pure functions come
first (offline-testable, no DB); the DB runners follow. Cross-imports with
tagging are LAZY (inside functions) so neither module imports the other at load.
"""
from __future__ import annotations

import re as stdre
from dataclasses import dataclass

import config
import db
import sentences as sentence_split

# Tag-evidence method strings (also the audit vocabulary).
METHOD_EXACT_ALIAS = "exact_alias"
METHOD_SEMANTIC = "semantic"
METHOD_LLM_CONFIRMED = "llm_confirmed"

# Tier-2 band labels.
BAND_ACCEPT = "accept"
BAND_JUDGE = "judge"
BAND_REJECT = "reject"


# ── Tier 1: exact aliases (pure) ─────────────────────────────────────────────

@dataclass(frozen=True)
class Tier1Hit:
    slug: str
    sentence_id: str
    start: int          # char offset of the matching sentence into the passage
    end: int
    evidence: str       # the exact matching sentence text


class EntityAliasIndex:
    """Word-boundary, diacritic-insensitive alias matcher for the Tier-1 facets
    (Person/Place/Scripture). Mirrors tagging.VocabIndex's alias regex but is
    RESTRICTED to entity terms, so a Concept/Practice term never leaks into the
    free exact-alias lane (those go through Tiers 2-3)."""

    def __init__(self, vocabulary: dict) -> None:
        import tagging  # lazy: reuse the canonical fold (fts_core-style normalization)

        self._fold = tagging.fold_text
        self.facet_by_slug: dict[str, str] = {}
        alias_map: dict[str, str] = {}
        for term in vocabulary["terms"]:
            facet = term.get("facet")
            slug = term["slug"]
            self.facet_by_slug[slug] = facet
            if facet not in config.TIER1_FACETS:
                continue
            for alias in [term["term"], *term.get("variants", [])]:
                folded = tagging.fold_text(alias)
                if len(folded) >= 3:                    # 1-2 char aliases are too noisy
                    alias_map.setdefault(folded, slug)
        self.alias_to_slug = alias_map
        if alias_map:
            pattern = "|".join(stdre.escape(a) for a in sorted(alias_map, key=len, reverse=True))
            self.alias_regex = stdre.compile(r"(?<![a-z0-9])(?:" + pattern + r")(?![a-z0-9])")
        else:
            self.alias_regex = None

    def slugs_in(self, folded_text: str) -> list[str]:
        if self.alias_regex is None:
            return []
        found: dict[str, None] = {}
        for m in self.alias_regex.finditer(folded_text):
            found.setdefault(self.alias_to_slug[m.group(0)], None)
        return list(found)


def tier1_hits(sentences: list, index: EntityAliasIndex) -> list[Tier1Hit]:
    """Assign every entity term whose alias appears in the passage, evidenced by
    the FIRST sentence it appears in (id + offsets). Deterministic: sentences are
    scanned in order, first match per slug wins; ties within one sentence are
    ordered by slug for reproducibility."""
    if index.alias_regex is None:
        return []
    seen: set[str] = set()
    hits: list[Tier1Hit] = []
    for sent in sentences:
        folded = index._fold(sent.text)
        fresh = sorted(s for s in index.slugs_in(folded) if s not in seen)
        for slug in fresh:
            seen.add(slug)
            hits.append(Tier1Hit(slug, sent.id, sent.start, sent.end, sent.text))
    return hits


# ── Tier 2: banding + calibration (pure) ─────────────────────────────────────

def band(sim: float, t_accept: float, t_reject: float) -> str:
    """Band a candidate by cosine similarity: ≥ t_accept auto-accept; < t_reject
    auto-drop; otherwise the middle band → the Tier-3 judge."""
    if sim >= t_accept:
        return BAND_ACCEPT
    if sim < t_reject:
        return BAND_REJECT
    return BAND_JUDGE


def _grid(lo: float, hi: float, step: float) -> list[float]:
    n = int(round((hi - lo) / step))
    return [round(lo + i * step, 4) for i in range(n + 1)]


def sweep_thresholds(pairs: list[tuple[float, bool]],
                     lo: float = 0.15, hi: float = 0.60, step: float = 0.01) -> list[dict]:
    """For a pooled list of shortlist candidates `(cosine_sim, is_positive)`,
    compute precision + in-shortlist recall at every grid threshold `t` (a
    candidate is kept when sim ≥ t). `is_positive` = this (passage, term) pair
    was an accepted Concept/Practice tag in the calibration run."""
    pos_total = sum(1 for _s, p in pairs if p)
    rows: list[dict] = []
    for t in _grid(lo, hi, step):
        tp = fp = 0
        for sim, is_pos in pairs:
            if sim >= t:
                if is_pos:
                    tp += 1
                else:
                    fp += 1
        cand = tp + fp
        rows.append({
            "t": t,
            "cand": cand,
            "tp": tp,
            "fp": fp,
            "precision": (tp / cand) if cand else None,
            "recall_inshortlist": (tp / pos_total) if pos_total else None,
        })
    return rows


def pick_thresholds(pairs: list[tuple[float, bool]],
                    target_accept_precision: float,
                    target_reject_recall: float,
                    lo: float = 0.15, hi: float = 0.60, step: float = 0.01) -> dict:
    """Calibrate (T_accept, T_reject) from pooled shortlist candidates.

      T_accept = the SMALLEST grid threshold whose measured precision ≥
                 target_accept_precision (high precision for silent auto-accept);
                 if none reaches it, the most-precise grid threshold with support.
      T_reject = the LARGEST grid threshold that still retains ≥
                 target_reject_recall of the in-shortlist positives (auto-drop
                 must lose few positives); clamped ≤ T_accept.

    Returns the chosen thresholds, the full sweep, and the measured metrics at
    each threshold (for pilot-report.md)."""
    sweep = sweep_thresholds(pairs, lo, hi, step)
    pos_total = sum(1 for _s, p in pairs if p)

    # T_accept — smallest t with precision ≥ target (needs candidate support).
    accept_row = None
    for row in sweep:
        if row["cand"] > 0 and row["precision"] is not None \
                and row["precision"] >= target_accept_precision:
            accept_row = row
            break
    if accept_row is None:  # nothing hits the bar → the most precise supported t
        supported = [r for r in sweep if r["cand"] > 0 and r["precision"] is not None]
        accept_row = max(supported, key=lambda r: (r["precision"], r["t"])) if supported else sweep[-1]
    t_accept = accept_row["t"]

    # T_reject — largest t retaining ≥ target of in-shortlist positives.
    reject_row = sweep[0]
    for row in sweep:
        if row["recall_inshortlist"] is not None and row["recall_inshortlist"] >= target_reject_recall:
            reject_row = row
    t_reject = min(reject_row["t"], t_accept)

    def _row_at(t: float) -> dict:
        return min(sweep, key=lambda r: abs(r["t"] - t))

    ar, rr = _row_at(t_accept), _row_at(t_reject)
    judged = sum(1 for sim, _p in pairs if t_reject <= sim < t_accept)
    accepted = sum(1 for sim, _p in pairs if sim >= t_accept)
    rejected = sum(1 for sim, _p in pairs if sim < t_reject)
    return {
        "t_accept": t_accept,
        "t_reject": t_reject,
        "target_accept_precision": target_accept_precision,
        "target_reject_recall": target_reject_recall,
        "accept_precision": ar["precision"],
        "accept_recall_inshortlist": ar["recall_inshortlist"],
        "reject_recall_retained": rr["recall_inshortlist"],
        "positives_in_shortlist": pos_total,
        "candidate_pairs": len(pairs),
        "pairs_auto_accepted": accepted,
        "pairs_judged": judged,
        "pairs_auto_rejected": rejected,
        "sweep": sweep,
    }


# ── merge (pure) ─────────────────────────────────────────────────────────────

def merge_tags(tier1: list[str], tier2_accept: list[str], tier3: list[str],
               cap: int) -> list[str]:
    """The fast merged tags_core copy: Tier 1 (highest-confidence exact aliases)
    first, then Tier-2 auto-accepts, then Tier-3 confirmations — deduped in that
    priority order and capped at `cap`."""
    out: list[str] = []
    seen: set[str] = set()
    for group in (tier1, tier2_accept, tier3):
        for slug in group:
            if slug not in seen:
                seen.add(slug)
                out.append(slug)
    return out[:cap]


# ── DB runners (Tier 2 shortlist, calibration, free-tier writer) ─────────────

def _content_embedding_union(alias: str = "pe") -> str:
    """UNION ALL of (table, id, embedding_context4) over the content tables — the
    calibration reads pilot passages that span several tables at once."""
    return " UNION ALL ".join(
        f"SELECT '{t}'::text tbl, id, embedding_context4 e FROM public.{t}"
        for t in config.GEMINI_TABLES
    )


def tier2_shortlist_for_passages(table: str, ids: list[str],
                                 topk: int | None = None) -> dict[str, list[tuple[str, float]]]:
    """Per passage, the top-`topk` nearest Concept/Practice vocab terms by cosine
    similarity (embedding_context4 ↔ vocab_terms.embedding), highest first. Rows
    with no embedding are absent from the result (→ no Tier-2 candidates)."""
    topk = topk or config.TIER2_TOPK
    facets = sorted(config.TIER2_FACETS)
    out: dict[str, list[tuple[str, float]]] = {}
    for pid, slug, dist in db.rows(
        f"SELECT p.id::text, sub.slug, sub.dist FROM public.{table} p"
        f" CROSS JOIN LATERAL ("
        f"   SELECT slug, embedding <=> p.embedding_context4 AS dist FROM public.vocab_terms"
        f"   WHERE embedding IS NOT NULL AND NOT is_ai AND facet = ANY(%s)"
        f"   ORDER BY embedding <=> p.embedding_context4 LIMIT %s) sub"
        f" WHERE p.id = ANY(%s::uuid[]) AND p.embedding_context4 IS NOT NULL",
        (facets, topk, ids),
    ):
        out.setdefault(pid, []).append((slug, 1.0 - float(dist)))
    for pid in out:
        out[pid].sort(key=lambda sp: sp[1], reverse=True)
    return out


def _calibration_pairs(pilot_run_id: str, topk: int) -> list[tuple[float, bool]]:
    """Pooled shortlist candidates for calibration: for every passage tagged in
    the pilot run, its top-`topk` Concept/Practice candidates paired with whether
    that (passage, slug) was an accepted Concept/Practice tag in that run."""
    rows = db.rows(
        f"WITH pe AS ({_content_embedding_union()}),"
        " pilot AS (SELECT DISTINCT table_name tbl, passage_id FROM public.tag_evidence"
        "           WHERE run_id = %s::uuid),"
        " cp AS (SELECT slug, embedding FROM public.vocab_terms"
        "        WHERE embedding IS NOT NULL AND facet = ANY(%s)),"
        " pos AS (SELECT e.passage_id, e.tag FROM public.tag_evidence e"
        "         JOIN public.vocab_terms v ON v.slug = e.tag"
        "         WHERE e.run_id = %s::uuid AND e.accepted AND v.facet = ANY(%s)),"
        " ranked AS (SELECT p.passage_id, cp.slug, 1 - (pe.e <=> cp.embedding) sim,"
        "   row_number() OVER (PARTITION BY p.passage_id ORDER BY pe.e <=> cp.embedding) rk"
        "   FROM pilot p JOIN pe ON pe.tbl = p.tbl AND pe.id = p.passage_id CROSS JOIN cp)"
        " SELECT r.sim,"
        "   EXISTS (SELECT 1 FROM pos WHERE pos.passage_id = r.passage_id AND pos.tag = r.slug)"
        " FROM ranked r WHERE r.rk <= %s",
        (pilot_run_id, sorted(config.TIER2_FACETS), pilot_run_id,
         sorted(config.TIER2_FACETS), topk),
    )
    return [(float(sim), bool(is_pos)) for sim, is_pos in rows]


def calibrate_tier2_thresholds(pilot_run_id: str | None = None,
                               topk: int | None = None) -> dict:
    """Calibrate (T_accept, T_reject) against the frozen p1 pilot tags. Reads
    ONLY tag_evidence + the stored embeddings — no LLM, no cost. Returns the
    thresholds, measured precision/recall, per-band counts and the sweep."""
    pilot_run_id = pilot_run_id or config.P1_PILOT_RUN_ID
    topk = topk or config.TIER2_TOPK
    pairs = _calibration_pairs(pilot_run_id, topk)
    result = pick_thresholds(
        pairs, config.TIER2_TARGET_ACCEPT_PRECISION, config.TIER2_TARGET_REJECT_RECALL)
    result["pilot_run_id"] = pilot_run_id
    result["topk"] = topk
    # Shortlist recall ceiling: how many accepted Concept/Practice pilot tags a
    # top-`topk` embedding shortlist can reach at all (its structural limit).
    total_pos = db.one(
        "SELECT count(*) FROM public.tag_evidence e JOIN public.vocab_terms v ON v.slug = e.tag"
        " WHERE e.run_id = %s::uuid AND e.accepted AND v.facet = ANY(%s)",
        (pilot_run_id, sorted(config.TIER2_FACETS)),
    ) or 0
    result["positives_total"] = int(total_pos)
    result["shortlist_recall_ceiling"] = (
        result["positives_in_shortlist"] / total_pos if total_pos else None)
    return result


# The two free tiers persist their evidence with these methods; the merge below
# reads tag_evidence back so Tier-3 (llm_confirmed) rows are never overwritten.
_FREE_TIER_METHODS = (METHOD_EXACT_ALIAS, METHOD_SEMANTIC)


def recompute_tags_core(cur, run_id: str, table: str, passage_ids: list[str]) -> None:
    """Materialize tags_core[] for `passage_ids` as the merged copy of ALL
    accepted tag_evidence rows in this run (Tiers 1+2+3), highest-confidence
    first and capped at MAX_TAGS. Idempotent and tier-order-independent — the
    free-tier writer and the Tier-3 apply both call it and always agree, because
    tag_evidence is the single source of truth. Zero accepted tags → '{}'."""
    cur.executemany(
        f"UPDATE public.{table} SET tags_core = COALESCE(("
        "   SELECT array_agg(tag ORDER BY conf DESC NULLS LAST, tag) FROM ("
        "     SELECT tag, max(confidence) conf FROM public.tag_evidence"
        "     WHERE run_id=%s::uuid AND table_name=%s AND passage_id=%s::uuid AND accepted"
        "     GROUP BY tag ORDER BY max(confidence) DESC NULLS LAST, tag LIMIT %s) s"
        "), '{}'::text[]) WHERE id=%s::uuid",
        [(run_id, table, pid, config.MAX_TAGS, pid) for pid in passage_ids],
    )


def _manifest_by_table(run_id: str) -> dict[str, list[str]]:
    """The run's planned passages per table, read from the shard id_lists (the
    union equals the pilot/full manifest). De-duplicated + sorted."""
    out: dict[str, list[str]] = {}
    for table, id_list in db.rows(
        "SELECT table_name, id_list::text[] FROM public.tag_batch_jobs WHERE run_id=%s::uuid",
        (run_id,),
    ):
        out.setdefault(table, [])
        out[table].extend(id_list or [])
    return {t: sorted(set(ids)) for t, ids in out.items()}


def all_eligible_ids() -> dict[str, list[str]]:
    """Every Gemini-eligible passage id (embedding present) per table — the full
    manifest for a corpus-wide free-tier pass (the full run, out of pilot scope)."""
    out: dict[str, list[str]] = {}
    for table in config.GEMINI_TABLES:
        out[table] = [r[0] for r in db.rows(
            f"SELECT id::text FROM public.{table} WHERE embedding_context4 IS NOT NULL")]
    return out


def apply_free_tiers(run_id: str, vocab, t_accept: float, t_reject: float,
                     chunk: int = 500, manifest: dict | None = None) -> dict:
    """Run Tiers 1-2 over every planned passage and WRITE their results (free, no
    LLM): Tier-1 exact-alias hits + Tier-2 auto-accepts become accepted
    tag_evidence rows (with method + confidence), and tags_core is materialized
    from tag_evidence. Middle-band Concept/Practice candidates are NOT written —
    they are recomputed deterministically at Tier-3 build time (attach_shortlists
    in tagging.py). Idempotent: it deletes only its OWN (exact_alias/semantic)
    evidence for these passages before rewriting, leaving any Tier-3 rows intact.

    Returns per-tier counts for pilot-report.md."""
    import tagging  # lazy (avoids an import cycle)

    entity_index = EntityAliasIndex(build_vocab_dict(vocab))
    summary = {
        "passages": 0, "tier1_tags": 0, "tier1_passages": 0,
        "tier2_accept_tags": 0, "tier2_accept_passages": 0,
        "judged_pairs": 0, "passages_needing_tier3": 0,
        "auto_rejected_pairs": 0, "free_tier_passages_only": 0,
        "t_accept": t_accept, "t_reject": t_reject,
    }
    if manifest is None:
        manifest = _manifest_by_table(run_id)
    conn = db.get_pg()
    for table, ids in manifest.items():
        for start in range(0, len(ids), chunk):
            batch = ids[start:start + chunk]
            passages = tagging.load_passages(table, batch)
            shortlists = tier2_shortlist_for_passages(table, batch)
            evidence: list[tuple] = []
            for passage in passages:
                sents = sentence_split.split_sentences(passage.text)
                # Tier 1 — exact aliases (entity facets).
                hits = tier1_hits(sents, entity_index)
                if hits:
                    summary["tier1_passages"] += 1
                for h in hits:
                    evidence.append((table, passage.id, h.slug, h.evidence, True, None,
                                     True, h.start, h.end, h.sentence_id,
                                     METHOD_EXACT_ALIAS, 1.0))
                summary["tier1_tags"] += len(hits)
                # Tier 2 — embedding shortlist bands.
                sl = shortlists.get(passage.id, [])
                had_accept = False
                had_judge = False
                for slug, sim in sl:
                    b = band(sim, t_accept, t_reject)
                    if b == BAND_ACCEPT:
                        evidence.append((table, passage.id, slug, "", True, None,
                                         False, None, None, None, METHOD_SEMANTIC, sim))
                        summary["tier2_accept_tags"] += 1
                        had_accept = True
                    elif b == BAND_JUDGE:
                        summary["judged_pairs"] += 1
                        had_judge = True
                    else:
                        summary["auto_rejected_pairs"] += 1
                if had_accept:
                    summary["tier2_accept_passages"] += 1
                if had_judge:
                    summary["passages_needing_tier3"] += 1
                else:
                    summary["free_tier_passages_only"] += 1
                summary["passages"] += 1
            with conn.transaction():
                with conn.cursor() as cur:
                    cur.execute(
                        "DELETE FROM public.tag_evidence WHERE run_id=%s::uuid"
                        " AND table_name=%s AND passage_id = ANY(%s::uuid[])"
                        " AND method = ANY(%s)",
                        (run_id, table, batch, list(_FREE_TIER_METHODS)),
                    )
                    if evidence:
                        cur.executemany(
                            "INSERT INTO public.tag_evidence"
                            " (run_id, table_name, passage_id, tag, evidence, accepted,"
                            "  reject_reason, evidence_found, evidence_start, evidence_end,"
                            "  evidence_sentence_id, method, confidence)"
                            " VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                            [(run_id, *r) for r in evidence],
                        )
                    recompute_tags_core(cur, run_id, table, batch)
    return summary


def build_vocab_dict(vocab) -> dict:
    """Accept either a tagging.VocabIndex or the raw vocabulary dict and return
    the raw dict EntityAliasIndex needs."""
    if isinstance(vocab, dict):
        return vocab
    return {"terms": vocab.terms, "term_count": getattr(vocab, "term_count", None)}
