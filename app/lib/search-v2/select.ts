/**
 * select.ts — Selection by RELEVANCE, not by counting.
 *
 * The old selector took the best passage and then filled slots until it hit a
 * ceiling, so even when two hundred passages answered the question a reader saw
 * eight. That whole method is gone. The rule now:
 *
 *   - Every passage the reranker scores at or above RELEVANCE_THRESHOLD is
 *     kept. No upper limit — if 240 pass, all 240 are shown.
 *   - If fewer than MIN_KEPT pass, the top MIN_KEPT are kept anyway, so a page
 *     is never nearly empty just because a threshold was strict.
 *   - If the reranker could not be reached there are no scores to threshold
 *     on; the top RERANK_DOWN_KEEP of the fused order are kept and the answer
 *     is marked degraded upstream.
 *
 * Every score is logged, so the threshold can be tuned from real distributions
 * instead of guesses.
 *
 * What survives from the old selector, because it is about honesty rather than
 * counting: an unlabellable letter (no recipient or no date) is excluded
 * outright — a hard exclusion, not a scoring penalty — and the purport
 * belonging to the strongest verse is pulled in beside it, because a purport
 * explaining a shown verse is context, not repetition.
 */
import { RELEVANCE_THRESHOLD } from "@/app/lib/search-v2/config";
import type { RankedCandidate } from "@/app/lib/search-v2/rerank";

/** The floor: a page is never nearly empty because the threshold was strict. */
export const MIN_KEPT = 10;

/** With no reranker there is no relevance line; keep this many of the fused order. */
export const RERANK_DOWN_KEEP = 100;

/** A context notice the renderer MUST show alongside the passage. */
export type ContextRequirement =
  | "letter_context"
  | "conversation_context"
  | "narrative_not_instruction";

export interface SelectedPassage {
  candidate: RankedCandidate;
  /** Why this passage was chosen. Shown in the evidence trail, not as prose. */
  reasons: string[];
  contextRequirements: ContextRequirement[];
  /** Position in the reranker's order (0-based), when a rerank ran. */
  rerankPosition: number | null;
}

export interface SelectionResult {
  selected: SelectedPassage[];
  /** Approved subquery ids no selected passage covers. Drives honest gaps. */
  uncoveredQueryIds: string[];
  evidenceInsufficient: boolean;
}

export interface SelectionInput {
  /** Candidates in final relevance order (reranked, or fused if rerank failed). */
  ranked: RankedCandidate[];
  /** Ids of every approved query, so coverage gaps can be reported. */
  approvedQueryIds: string[];
  /** True when the reranker actually ran, so scores exist to threshold on. */
  rerankAvailable: boolean;
  /** Correlates the score log with the request. */
  requestId?: string;
}

const VERSE_TYPES = new Set(["verse", "purport"]);

function contextRequirementsFor(c: RankedCandidate): ContextRequirement[] {
  const out: ContextRequirement[] = [];
  if (c.source_type === "letter") out.push("letter_context");
  if (c.source_type === "lecture") {
    // A recorded exchange may contain other speakers; the renderer must say so
    // rather than let the reader assume every line is Śrīla Prabhupāda's.
    out.push("conversation_context");
  }
  return out;
}

/**
 * A letter with no recipient or no date cannot be labelled honestly, and an
 * unlabelled letter reads as general instruction. Such a passage is not
 * selectable — this is a hard exclusion, not a scoring penalty.
 */
export function isLabellable(c: RankedCandidate): boolean {
  if (c.source_type !== "letter") return true;
  return Boolean((c.recipient || "").trim()) && Boolean((c.occurred_on || "").trim());
}

export function selectEvidence(input: SelectionInput): SelectionResult {
  const { ranked, approvedQueryIds, rerankAvailable, requestId } = input;

  const eligible = ranked.filter(isLabellable);
  if (eligible.length === 0) {
    return { selected: [], uncoveredQueryIds: approvedQueryIds, evidenceInsufficient: true };
  }

  // ── The relevance line ──
  let kept: RankedCandidate[];
  let basis: "threshold" | "floor" | "rerank_unavailable";
  if (rerankAvailable) {
    const above = eligible.filter((c) => (c.rerankScore ?? 0) >= RELEVANCE_THRESHOLD);
    if (above.length >= MIN_KEPT) {
      kept = above;
      basis = "threshold";
    } else {
      kept = eligible.slice(0, MIN_KEPT);
      basis = "floor";
    }
  } else {
    kept = eligible.slice(0, RERANK_DOWN_KEEP);
    basis = "rerank_unavailable";
  }

  // ── The purport partner of the strongest verse ──
  // A purport explaining a shown verse is context, not repetition; it joins its
  // verse even when its own score fell below the line.
  const keptKeys = new Set(kept.map((c) => c.passage_key));
  let partnerKey: string | null = null;
  const primary = kept[0];
  if (primary && VERSE_TYPES.has(primary.source_type)) {
    const partner = eligible.find(
      (c) =>
        !keptKeys.has(c.passage_key) &&
        VERSE_TYPES.has(c.source_type) &&
        c.source_type !== primary.source_type &&
        c.reference &&
        primary.reference &&
        c.reference.trim() === primary.reference.trim(),
    );
    if (partner) {
      kept = [kept[0], partner, ...kept.slice(1)];
      keptKeys.add(partner.passage_key);
      partnerKey = partner.passage_key;
    }
  }

  // ── Log every score, so the threshold is tuned from data, not guesses ──
  console.info(
    JSON.stringify({
      level: "info",
      event: "search.selection_scores",
      requestId: requestId ?? null,
      basis,
      threshold: RELEVANCE_THRESHOLD,
      eligible: eligible.length,
      kept: kept.length,
      scores: eligible.map((c) => (c.rerankScore === null ? null : Math.round(c.rerankScore * 1000) / 1000)),
    }),
  );

  const reasonFor = (c: RankedCandidate): string => {
    if (c.passage_key === partnerKey) return "purport/verse partner of the primary passage";
    if (c.rerankScore !== null && c.rerankScore >= RELEVANCE_THRESHOLD) {
      return `relevance ${c.rerankScore.toFixed(3)} ≥ ${RELEVANCE_THRESHOLD}`;
    }
    if (basis === "rerank_unavailable") return "fused order (reranker unavailable)";
    return `top ${MIN_KEPT} floor — fewer than ${MIN_KEPT} passages cleared the threshold`;
  };

  const covered = new Set<string>();
  const selected: SelectedPassage[] = kept.map((c) => {
    for (const q of c.queryCoverage ?? []) covered.add(q);
    return {
      candidate: c,
      reasons: [reasonFor(c)],
      contextRequirements: contextRequirementsFor(c),
      rerankPosition: c.rerankScore === null ? null : eligible.indexOf(c),
    };
  });

  return {
    selected,
    uncoveredQueryIds: approvedQueryIds.filter((q) => !covered.has(q)),
    evidenceInsufficient: selected.length === 0,
  };
}
