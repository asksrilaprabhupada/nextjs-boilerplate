"""
tiers.py — the v4-tiered classifier (Tiers 1-2, calibration, and the merge).

v4 REPLACES the single generative Gemini pass with a three-tier classifier over
the frozen 251-term vocabulary. Only Tier 3 costs money:

  Tier 1 — EXACT ALIASES (free). Person/Place/Scripture terms are matched by
    their term + variants against the passage sentences (word-boundary,
    diacritic-insensitive — the same `fold_text` normalization the fts_core
    lane uses). A hit assigns the tag with method='exact_alias', confidence=1.0,
    evidence = the FIRST matching sentence (id + offsets).

  Tier 2 — CANDIDATE SHORTLIST + REJECT FILTER (free). The Concept/Practice
    candidate list is the UNION of three lanes, deduped and capped at
    TIER3_CANDIDATE_CAP: (a) the top-TIER2_SHORTLIST_K terms by LABEL embedding
    similarity; (b) the top-TIER2_SHORTLIST_K by MAX-EXEMPLAR similarity
    (exemplars = up to TIER3_EXEMPLARS_PER_TERM p1-accepted passage embeddings
    per term); (c) every term whose label/variant LITERALLY appears in the
    passage (the same fold Tier 1 uses), regardless of embedding rank. The single
    calibrated threshold T_reject then filters: a candidate is dropped when its
    label similarity < T_reject (unless it is a lexical hit, which is always
    kept); everything else goes to the Tier-3 judge. v4-tiered.2 REMOVED the
    auto-accept band — nothing is assigned method='semantic' any more.

  Tier 3 — LLM JUDGE (paid; lives in tagging.py). Only the Tier-2 candidate list
    is shown to the model, which confirms which genuinely apply
    (method='llm_confirmed').

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

# Tier-2 band labels. v4-tiered.2 has only TWO bands (the auto-accept band was
# removed): everything with label similarity ≥ T_reject is judged, the rest is
# dropped.
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
    """Word-boundary, diacritic-insensitive alias matcher over a chosen set of
    facets. Mirrors tagging.VocabIndex's alias regex but is RESTRICTED to the
    `facets` passed in (default the Tier-1 entity facets), so a Concept/Practice
    term never leaks into the free exact-alias lane — while the SAME machinery,
    pointed at TIER2_FACETS (see `concept_alias_index`), powers the v4-tiered.2
    LEXICAL shortlist lane (a C/P term literally present is always a candidate)."""

    def __init__(self, vocabulary: dict, facets: set[str] | None = None) -> None:
        import tagging  # lazy: reuse the canonical fold (fts_core-style normalization)

        facets = config.TIER1_FACETS if facets is None else facets
        self.facets = facets
        self._fold = tagging.fold_text
        self.facet_by_slug: dict[str, str] = {}
        alias_map: dict[str, str] = {}
        for term in vocabulary["terms"]:
            facet = term.get("facet")
            slug = term["slug"]
            self.facet_by_slug[slug] = facet
            if facet not in facets:
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


def concept_alias_index(vocabulary: dict) -> "EntityAliasIndex":
    """Alias matcher RESTRICTED to the Tier-2 facets (Concept/Practice) — the
    LEXICAL shortlist lane. A C/P term whose label/variant literally appears in a
    passage (word-boundary, diacritic-insensitive, the same fold as Tier 1) is
    ALWAYS a Tier-3 candidate, regardless of embedding rank."""
    return EntityAliasIndex(vocabulary, facets=config.TIER2_FACETS)


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

def band(sim: float, t_reject: float) -> str:
    """Band a candidate by LABEL cosine similarity. v4-tiered.2 has no auto-accept
    band: ≥ t_reject → the Tier-3 judge; < t_reject → auto-drop. (Lexical hits
    bypass this filter entirely — see `middle_band` — and are always judged.)"""
    return BAND_JUDGE if sim >= t_reject else BAND_REJECT


# ── v4-tiered.2 candidate union (pure) ───────────────────────────────────────

def union_candidates(members: dict[str, float | None], lexical, cap: int
                     ) -> list[tuple[str, float | None, bool]]:
    """The Tier-3 candidate list for one passage: the union of the embedding lanes
    (`members` maps every top-K label / top-K exemplar slug to its LABEL cosine
    similarity) and the `lexical` hits, deduped and capped at `cap`.

    Returns (slug, label_sim, is_lexical) highest-label-sim first (slug tie-break).
    LEXICAL hits are NEVER trimmed by the cap — they are kept in full and the
    remaining room is filled with the highest-similarity non-lexical members. A
    lexical hit with no embedding similarity (no term embedding) still rides along
    with label_sim=None so a literal appearance is never silently discarded."""
    lexical = set(lexical)
    slugs = set(members) | lexical

    def sortkey(slug: str):
        sim = members.get(slug)
        return (-(sim if sim is not None else -1.0), slug)

    ranked = sorted(slugs, key=sortkey)
    lex_first = [s for s in ranked if s in lexical]
    others = [s for s in ranked if s not in lexical]
    room = max(cap - len(lex_first), 0)
    kept = sorted(lex_first + others[:room], key=sortkey)
    return [(s, members.get(s), s in lexical) for s in kept]


def middle_band(candidates: list[tuple[str, float | None, bool]], t_reject: float) -> list[str]:
    """The slugs that go to the Tier-3 judge: every union candidate whose LABEL
    similarity is ≥ t_reject, PLUS every lexical hit (a literal appearance is
    always judged regardless of embedding similarity). Order is preserved."""
    out: list[str] = []
    for slug, sim, is_lex in candidates:
        if is_lex or (sim is not None and sim >= t_reject):
            out.append(slug)
    return out


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

def merge_tags(tier1: list[str], tier2: list[str], tier3: list[str],
               cap: int) -> list[str]:
    """The fast merged tags_core copy: Tier 1 (highest-confidence exact aliases)
    first, then the Tier-2 group (EMPTY in v4-tiered.2 — the auto-accept band was
    removed), then Tier-3 confirmations — deduped in that priority order and capped
    at `cap`. (tag_evidence remains the source of truth; recompute_tags_core is the
    authoritative merge — this pure helper is kept for its priority/dedupe/cap tests.)"""
    out: list[str] = []
    seen: set[str] = set()
    for group in (tier1, tier2, tier3):
        for slug in group:
            if slug not in seen:
                seen.add(slug)
                out.append(slug)
    return out[:cap]


# ── DB runners (Tier 2 shortlist, calibration, free-tier writer) ─────────────

def _content_embedding_union() -> str:
    """UNION ALL of (table, id, embedding_context4) over the content tables — the
    calibration reads pilot passages that span several tables at once. Rows with
    no embedding are excluded (they can never be shortlisted, and a NULL sim would
    crash the float() in _calibration_pairs)."""
    return " UNION ALL ".join(
        f"SELECT '{t}'::text tbl, id, embedding_context4 e FROM public.{t}"
        f" WHERE embedding_context4 IS NOT NULL"
        for t in config.GEMINI_TABLES
    )


# ── v4-tiered.2 exemplar cache (p1-accepted passage embeddings per C/P term) ──

def _exemplar_select_sql() -> str:
    """SELECT (slug, embedding) for up to TIER3_EXEMPLARS_PER_TERM p1-accepted
    passage embeddings per Concept/Practice term. Params (in order): the C/P
    facets, the pilot run id, the per-term cap. The accepted-passage rows are
    JOINED to their embeddings BEFORE the per-term row_number, so ranking runs
    only over passages that actually have an embedding — a term always gets up to
    N REAL exemplars even if its lowest-id accepted passages lack embeddings."""
    return (
        "WITH cp AS (SELECT slug FROM public.vocab_terms"
        "            WHERE embedding IS NOT NULL AND NOT is_ai AND facet = ANY(%s)),"
        f" pe AS ({_content_embedding_union()}),"
        " embedded AS (SELECT te.tag AS slug, pe.e AS embedding,"
        "     row_number() OVER (PARTITION BY te.tag ORDER BY te.passage_id) rk"
        "   FROM public.tag_evidence te JOIN cp ON cp.slug = te.tag"
        "   JOIN pe ON pe.tbl = te.table_name AND pe.id = te.passage_id"
        "   WHERE te.run_id = %s::uuid AND te.accepted)"
        " SELECT slug, embedding FROM embedded WHERE rk <= %s"
    )


_exemplar_cache_run: str | None = None


def ensure_exemplar_cache(pilot_run_id: str | None = None) -> int:
    """Build (once per connection) the pg_temp table `_tier3_exemplars(slug,
    embedding)` — up to TIER3_EXEMPLARS_PER_TERM p1-accepted passage embeddings per
    Concept/Practice term. The exemplars are a FIXED asset derived from the frozen
    p1 run, so they are computed once and reused for every shard's shortlist rather
    than re-scanned per shard. Idempotent: rebuilt only when the cached run id
    changes or the temp table is gone (a reconnected pooler session). Returns the
    exemplar row count."""
    global _exemplar_cache_run
    pilot_run_id = pilot_run_id or config.P1_PILOT_RUN_ID
    present = db.one("SELECT to_regclass('pg_temp._tier3_exemplars') IS NOT NULL")
    if _exemplar_cache_run == pilot_run_id and present:
        return int(db.one("SELECT count(*) FROM pg_temp._tier3_exemplars") or 0)
    conn = db.get_pg()
    with conn.cursor() as cur:
        cur.execute("DROP TABLE IF EXISTS _tier3_exemplars")
        cur.execute(
            "CREATE TEMP TABLE _tier3_exemplars AS " + _exemplar_select_sql(),
            (sorted(config.TIER2_FACETS), pilot_run_id, config.TIER3_EXEMPLARS_PER_TERM),
        )
    _exemplar_cache_run = pilot_run_id
    return int(db.one("SELECT count(*) FROM pg_temp._tier3_exemplars") or 0)


def tier3_candidate_members(table: str, ids: list[str],
                            lexical_by_id: dict[str, list[str]] | None = None,
                            topk: int | None = None) -> dict[str, dict[str, float]]:
    """Per passage, the LABEL cosine similarity of every candidate slug in the
    UNION of the three lanes: top-`topk` by label similarity ∪ top-`topk` by
    max-exemplar similarity (from the pg_temp exemplar cache) ∪ the passed-in
    `lexical_by_id` (passage → [slug]) hits. Returns {pid: {slug: label_sim}}; a
    lexical slug whose term has no embedding is simply absent (union_candidates
    still keeps it, with label_sim=None). Rows with no passage embedding are
    absent (→ no candidates)."""
    topk = topk or config.TIER2_SHORTLIST_K
    ensure_exemplar_cache()
    facets = sorted(config.TIER2_FACETS)
    lex_pids: list[str] = []
    lex_slugs: list[str] = []
    for pid, slugs in (lexical_by_id or {}).items():
        for s in slugs:
            lex_pids.append(pid)
            lex_slugs.append(s)
    out: dict[str, dict[str, float]] = {}
    for pid, slug, lsim in db.rows(
        "WITH cp AS (SELECT slug, embedding FROM public.vocab_terms"
        "            WHERE embedding IS NOT NULL AND NOT is_ai AND facet = ANY(%s)),"
        f" p AS (SELECT id, embedding_context4 emb FROM public.{table}"
        "       WHERE id = ANY(%s::uuid[]) AND embedding_context4 IS NOT NULL),"
        " lbl AS (SELECT p.id pid, s.slug, s.lsim FROM p CROSS JOIN LATERAL ("
        "     SELECT slug, 1 - (embedding <=> p.emb) lsim FROM cp"
        "     ORDER BY embedding <=> p.emb LIMIT %s) s),"
        " exl AS (SELECT pid, slug, lsim FROM ("
        "     SELECT pid, slug, lsim,"
        "       row_number() OVER (PARTITION BY pid ORDER BY xsim DESC) rk FROM ("
        "       SELECT p.id pid, cp.slug, min(1 - (cp.embedding <=> p.emb)) lsim,"
        "              max(1 - (x.embedding <=> p.emb)) xsim"
        "         FROM p CROSS JOIN cp JOIN pg_temp._tier3_exemplars x ON x.slug = cp.slug"
        "        GROUP BY p.id, cp.slug) a) b WHERE rk <= %s),"
        " lex AS (SELECT l.pid, l.slug, 1 - (cp.embedding <=> p.emb) lsim"
        "     FROM unnest(%s::uuid[], %s::text[]) AS l(pid, slug)"
        "     JOIN p ON p.id = l.pid JOIN cp ON cp.slug = l.slug)"
        " SELECT u.pid::text, u.slug, max(u.lsim) FROM ("
        "     SELECT pid, slug, lsim FROM lbl"
        "     UNION ALL SELECT pid, slug, lsim FROM exl"
        "     UNION ALL SELECT pid, slug, lsim FROM lex) u"
        " GROUP BY u.pid, u.slug",
        (facets, ids, topk, topk, lex_pids, lex_slugs),
    ):
        out.setdefault(pid, {})[slug] = float(lsim)
    return out


def tier3_shortlist_for_passages(table: str, passages, concept_index,
                                 topk: int | None = None, cap: int | None = None
                                 ) -> dict[str, list[tuple[str, float | None, bool]]]:
    """The v4-tiered.2 Tier-3 candidate list per passage: union(top-K label,
    top-K exemplar, lexical) capped at `cap`, as (slug, label_sim, is_lexical).
    The SINGLE source of the candidate list — the free-tier counter, the judge
    prompt (attach_shortlists_v4) and the apply reconstruction (the llm_rejected
    trail) all call this so they agree exactly on every resume. `passages` are
    Passage objects (their `.text` feeds the lexical lane); `concept_index` is a
    concept_alias_index over the same vocabulary."""
    cap = cap or config.TIER3_CANDIDATE_CAP
    lexical_by_id: dict[str, list[str]] = {
        p.id: concept_index.slugs_in(concept_index._fold(p.text)) for p in passages
    }
    members = tier3_candidate_members(table, [p.id for p in passages], lexical_by_id, topk)
    return {
        p.id: union_candidates(members.get(p.id, {}), lexical_by_id.get(p.id, []), cap)
        for p in passages
    }


def _calibration_pairs(pilot_run_id: str, topk: int) -> list[tuple[float, bool]]:
    """Pooled shortlist candidates for calibration: for every passage tagged in
    the pilot run, its top-`topk` Concept/Practice candidates paired with whether
    that (passage, slug) was an accepted Concept/Practice tag in that run."""
    rows = db.rows(
        f"WITH pe AS ({_content_embedding_union()}),"
        " pilot AS (SELECT DISTINCT table_name tbl, passage_id FROM public.tag_evidence"
        "           WHERE run_id = %s::uuid),"
        " cp AS (SELECT slug, embedding FROM public.vocab_terms"
        "        WHERE embedding IS NOT NULL AND NOT is_ai AND facet = ANY(%s)),"
        " pos AS (SELECT e.passage_id, e.tag FROM public.tag_evidence e"
        "         JOIN public.vocab_terms v ON v.slug = e.tag"
        "         WHERE e.run_id = %s::uuid AND e.accepted AND NOT v.is_ai AND v.facet = ANY(%s)),"
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


def _pilot_passage_texts(pilot_run_id: str) -> dict[str, dict[str, str]]:
    """{table: {passage_id: text}} for every passage carrying an accepted C/P tag
    in the pilot run — the calibration ground-truth passages, loaded once for the
    LEXICAL lane of the recall-ceiling measurement."""
    import tagging
    by_table: dict[str, list[str]] = {}
    for tbl, pid in db.rows(
        "SELECT DISTINCT e.table_name, e.passage_id::text FROM public.tag_evidence e"
        " JOIN public.vocab_terms v ON v.slug = e.tag"
        " WHERE e.run_id = %s::uuid AND e.accepted AND NOT v.is_ai AND v.facet = ANY(%s)",
        (pilot_run_id, sorted(config.TIER2_FACETS)),
    ):
        by_table.setdefault(tbl, []).append(pid)
    out: dict[str, dict[str, str]] = {}
    for tbl, ids in by_table.items():
        out[tbl] = {p.id: p.text for p in tagging.load_passages(tbl, ids)}
    return out


def measure_union_recall_ceiling(pilot_run_id: str, vocab_dict: dict,
                                 k: int | None = None) -> dict:
    """Measure the recall ceiling of the v4-tiered.2 UNION shortlist (top-k label ∪
    top-k max-exemplar ∪ lexical) vs the LABEL-ONLY top-k shortlist, over the
    accepted Concept/Practice pilot tags, at K = `k` (default TIER3_RECALL_CEILING_K
    = 20). A positive is 'reached' when it lands inside the shortlist at all — the
    structural limit no downstream judge can exceed. Reads only stored embeddings +
    tag_evidence + passage text (no LLM, no cost)."""
    k = k or config.TIER3_RECALL_CEILING_K
    ensure_exemplar_cache(pilot_run_id)
    facets = sorted(config.TIER2_FACETS)
    # Embedding lanes: per accepted (passage, tag), is it inside the top-k LABEL
    # shortlist and/or the top-k MAX-EXEMPLAR shortlist?
    rows = db.rows(
        f"WITH pe AS ({_content_embedding_union()}),"
        " cp AS (SELECT slug, embedding FROM public.vocab_terms"
        "        WHERE embedding IS NOT NULL AND NOT is_ai AND facet = ANY(%s)),"
        " pos AS (SELECT DISTINCT e.table_name tbl, e.passage_id, e.tag FROM public.tag_evidence e"
        "         JOIN public.vocab_terms v ON v.slug = e.tag"
        "         WHERE e.run_id = %s::uuid AND e.accepted AND NOT v.is_ai AND v.facet = ANY(%s)),"
        " pilot AS (SELECT DISTINCT tbl, passage_id FROM pos),"
        " lab AS (SELECT pl.passage_id, cp.slug,"
        "     row_number() OVER (PARTITION BY pl.passage_id ORDER BY (pe.e <=> cp.embedding)) rk"
        "   FROM pilot pl JOIN pe ON pe.tbl = pl.tbl AND pe.id = pl.passage_id CROSS JOIN cp),"
        " exm AS (SELECT passage_id, slug,"
        "     row_number() OVER (PARTITION BY passage_id ORDER BY xsim DESC) rk FROM ("
        "     SELECT pl.passage_id, cp.slug, max(1 - (x.embedding <=> pe.e)) xsim"
        "       FROM pilot pl JOIN pe ON pe.tbl = pl.tbl AND pe.id = pl.passage_id"
        "            CROSS JOIN cp JOIN pg_temp._tier3_exemplars x ON x.slug = cp.slug"
        "      GROUP BY pl.passage_id, cp.slug) z)"
        " SELECT pos.passage_id::text, pos.tag,"
        "   EXISTS (SELECT 1 FROM lab WHERE lab.passage_id = pos.passage_id"
        "           AND lab.slug = pos.tag AND lab.rk <= %s),"
        "   EXISTS (SELECT 1 FROM exm WHERE exm.passage_id = pos.passage_id"
        "           AND exm.slug = pos.tag AND exm.rk <= %s)"
        " FROM pos",
        (facets, pilot_run_id, facets, k, k),
    )
    # Lexical lane (Python: needs passage text + the C/P alias index).
    ci = concept_alias_index(vocab_dict)
    lexical_positives: set[tuple[str, str]] = set()
    for _tbl, id_text in _pilot_passage_texts(pilot_run_id).items():
        for pid, text in id_text.items():
            for slug in ci.slugs_in(ci._fold(text or "")):
                lexical_positives.add((pid, slug))
    total = len(rows)
    label_reached = union_reached = lexical_reached = 0
    for pid, tag, in_label, in_exem in rows:
        is_lex = (pid, tag) in lexical_positives
        if in_label:
            label_reached += 1
        if is_lex:
            lexical_reached += 1
        if in_label or in_exem or is_lex:
            union_reached += 1
    return {
        "recall_ceiling_k": k,
        "positives_total": total,
        "label_reached": label_reached,
        "union_reached": union_reached,
        "lexical_reached": lexical_reached,
        "label_only_recall_ceiling": (label_reached / total) if total else None,
        "union_recall_ceiling": (union_reached / total) if total else None,
    }


def calibrate_tier2_thresholds(pilot_run_id: str | None = None,
                               topk: int | None = None, vocab=None) -> dict:
    """Calibrate T_reject against the frozen p1 pilot tags (T_accept is retained as
    a DIAGNOSTIC precision head only — v4-tiered.2 auto-accepts nothing). Reads ONLY
    tag_evidence + the stored embeddings + (for the union recall ceiling) passage
    text — no LLM, no cost. Returns the thresholds, measured precision/recall,
    per-band counts, the sweep, and — when `vocab` is supplied — the UNION vs
    label-only recall ceiling at K=TIER3_RECALL_CEILING_K."""
    pilot_run_id = pilot_run_id or config.P1_PILOT_RUN_ID
    topk = topk or config.TIER2_SHORTLIST_K
    pairs = _calibration_pairs(pilot_run_id, topk)
    result = pick_thresholds(
        pairs, config.TIER2_TARGET_ACCEPT_PRECISION, config.TIER2_TARGET_REJECT_RECALL)
    result["pilot_run_id"] = pilot_run_id
    result["topk"] = topk
    # Shortlist recall ceiling: how many accepted Concept/Practice pilot tags a
    # top-`topk` LABEL embedding shortlist can reach at all (its structural limit).
    # Count DISTINCT (passage, tag) so this denominator matches the union
    # measurement's (both treat a positive as a (passage, tag) pair, not a row).
    total_pos = db.one(
        "SELECT count(DISTINCT (e.passage_id, e.tag))"
        " FROM public.tag_evidence e JOIN public.vocab_terms v ON v.slug = e.tag"
        " WHERE e.run_id = %s::uuid AND e.accepted AND NOT v.is_ai AND v.facet = ANY(%s)",
        (pilot_run_id, sorted(config.TIER2_FACETS)),
    ) or 0
    result["positives_total"] = int(total_pos)
    result["shortlist_recall_ceiling"] = (
        result["positives_in_shortlist"] / total_pos if total_pos else None)
    # v4-tiered.2: the UNION recall ceiling (top-K label ∪ top-K max-exemplar ∪
    # lexical) vs label-only, at K=TIER3_RECALL_CEILING_K — quantifies how much the
    # exemplar + lexical lanes widen reachability beyond the label shortlist.
    if vocab is not None:
        try:
            result["union_recall"] = measure_union_recall_ceiling(
                pilot_run_id, build_vocab_dict(vocab))
        except Exception as exc:  # noqa: BLE001 — a reported metric, never fatal
            result["union_recall"] = {"error": str(exc)}
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
    """Run the free tiers over every planned passage and WRITE their results (no
    LLM). v4-tiered.2 writes ONLY Tier-1 exact-alias hits (accepted tag_evidence,
    method='exact_alias'); the auto-accept band is REMOVED, so NOTHING is assigned
    method='semantic' any more. The Tier-3 candidate list (union of top-K label,
    top-K exemplar, and lexical lanes, filtered by T_reject) is recomputed
    deterministically at build time (attach_shortlists_v4 in tagging.py) and its
    per-band counts are tallied here for the report. `t_accept` is accepted for
    signature stability but is NOT used for banding. Idempotent: it deletes only
    its OWN (exact_alias/semantic) evidence for these passages before rewriting —
    the stale-semantic delete also cleans up any auto-accepts from an earlier v4.1
    run — leaving any Tier-3 rows intact.

    Returns per-tier counts for pilot-report.md."""
    import tagging  # lazy (avoids an import cycle)

    vocab_dict = build_vocab_dict(vocab)
    entity_index = EntityAliasIndex(vocab_dict)
    concept_index = concept_alias_index(vocab_dict)
    summary = {
        "passages": 0, "tier1_tags": 0, "tier1_passages": 0,
        # Retained (always 0) for report/back-compat: the auto-accept band is gone.
        "tier2_accept_tags": 0, "tier2_accept_passages": 0,
        "judged_pairs": 0, "passages_needing_tier3": 0,
        "auto_rejected_pairs": 0, "free_tier_passages_only": 0,
        "lexical_candidate_tags": 0, "candidate_pairs": 0,
        "t_accept": t_accept, "t_reject": t_reject,
    }
    if manifest is None:
        manifest = _manifest_by_table(run_id)
    conn = db.get_pg()
    for table, ids in manifest.items():
        for start in range(0, len(ids), chunk):
            batch = ids[start:start + chunk]
            passages = tagging.load_passages(table, batch)
            # The SAME union candidate list the judge will see (attach_shortlists_v4).
            shortlists = tier3_shortlist_for_passages(table, passages, concept_index)
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
                # Tier 2 — union candidate list + reject filter (no auto-accept).
                cand = shortlists.get(passage.id, [])
                judged = set(middle_band(cand, t_reject))
                summary["candidate_pairs"] += len(cand)
                summary["judged_pairs"] += len(judged)
                summary["lexical_candidate_tags"] += sum(1 for _s, _sim, is_lex in cand if is_lex)
                summary["auto_rejected_pairs"] += sum(1 for s, _sim, _l in cand if s not in judged)
                if judged:
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
