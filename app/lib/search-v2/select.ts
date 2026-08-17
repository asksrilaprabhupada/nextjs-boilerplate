/**
 * select.ts — WHO OWNS EACH LIST. One rule, written down, no arithmetic.
 *
 *   1. One ranked list comes back from Cohere.
 *   2. The duplicate rules have already been applied to it, preserving order.
 *   3. Pinned passages lead, keeping their order among themselves.
 *   4. The first MAIN_TIER_MAX surviving items are the MAIN list.
 *   5. Every remaining surviving item is DIG DEEPER, in the same rerank order.
 *   6. No passage id appears in both.
 *
 * THE CUT IS NOT A DELETION. Everything below the boundary is still returned —
 * as a citation with a sentence-safe snippet rather than full text, because a
 * reader cannot absorb seven hundred purports, not because the passage stopped
 * counting.
 *
 * What this replaces: a cut placed at the largest score gap between positions 8
 * and 20. The reasoning behind it was sound — reranker scores are query-
 * dependent, so a fixed SCORE threshold is a category error — but the answer to
 * that is not a moving COUNT. A gap is a fact about the scores; where the main
 * list ends is a decision about the page, and the owner has made it: twenty.
 *
 * What survives from the old selector, because it is about honesty rather than
 * counting: a letter that cannot be labelled (no recipient or no date) is
 * excluded outright — a hard exclusion, not a scoring penalty — since an
 * unlabelled letter reads as general instruction.
 *
 * What does NOT survive: the promotion that pulled the primary verse's purport
 * up beside it. A verse chunk is never shown together with its parent verse
 * now, so that promotion would have quietly undone the deduplication one stage
 * earlier — removing the chunk from the pile and then putting it back on the
 * page. The chunk is not lost; it falls to the citation tier like anything
 * else below the boundary.
 */
import type { RankedCandidate } from "@/app/lib/search-v2/rerank";

/** The main list is exactly this long, or shorter when fewer survive. */
export const MAIN_TIER_MAX = 20;

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
  /** The main tier: rendered in full. */
  selected: SelectedPassage[];
  /**
   * Everything else that survived, in the same rerank order. Shown as
   * citations — never dropped.
   */
  additional: RankedCandidate[];
  /** Approved subquery ids no main-tier passage covers. Drives honest gaps. */
  uncoveredQueryIds: string[];
  evidenceInsufficient: boolean;
  /** Where the main list ends. Equal to MAIN_TIER_MAX unless fewer survived. */
  mainCount: number;
  /**
   * Pins that were below the boundary on relevance alone and were lifted into
   * the main list. A devotee who searches "BG 18.66" must see that verse on the
   * page, not at position 37 — but a promotion is a decision, so it is counted.
   */
  pinnedPromotions: number;
}

export interface SelectionInput {
  /** Candidates in final relevance order, duplicate rules already applied. */
  ranked: RankedCandidate[];
  /** Ids of every approved query, so coverage gaps can be reported. */
  approvedQueryIds: string[];
  /** True when the reranker actually ran, so the order is judged, not arrival. */
  rerankAvailable: boolean;
  /** Correlates the selection log with the request. */
  requestId?: string;
}

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
  const { ranked, approvedQueryIds, requestId } = input;

  const eligible = ranked.filter(isLabellable);
  if (eligible.length === 0) {
    return {
      selected: [],
      additional: [],
      uncoveredQueryIds: approvedQueryIds,
      evidenceInsufficient: true,
      mainCount: 0,
      pinnedPromotions: 0,
    };
  }

  // Pins lead, each group keeping its own relevance order. This is the ONLY
  // re-ordering applied to Cohere's list, and it is a promotion rather than a
  // sort: a devotee who wrote a reference must find that passage on the page.
  const pinned = eligible.filter((c) => c.pinned);
  const rest = eligible.filter((c) => !c.pinned);
  const ordered = [...pinned, ...rest];

  // A pin that was already inside the boundary on relevance alone was not
  // promoted by anything — only the ones that were not are counted.
  const naturalTop = new Set(
    eligible.slice(0, MAIN_TIER_MAX).map((c) => c.passage_key),
  );
  const promoted = ordered
    .slice(0, MAIN_TIER_MAX)
    .filter((c) => c.pinned && !naturalTop.has(c.passage_key));

  const kept = ordered.slice(0, MAIN_TIER_MAX);
  const additional = ordered.slice(MAIN_TIER_MAX);

  console.info(
    JSON.stringify({
      level: "info",
      event: "search.selection",
      requestId: requestId ?? null,
      basis: input.rerankAvailable ? "rerank_order" : "arrival_order_rerank_unavailable",
      eligible: eligible.length,
      main: kept.length,
      additional: additional.length,
      pinned: pinned.length,
      pinnedPromotions: promoted.length,
      promotedPassageKeys: promoted.map((c) => c.passage_key),
    }),
  );

  const reasonFor = (c: RankedCandidate, index: number): string => {
    if (c.pinned) return "exact reference requested — pinned to the main list";
    if (!input.rerankAvailable) return `arrival order ${index + 1} (reranker unavailable)`;
    return `rerank position ${index + 1} of the first ${MAIN_TIER_MAX}`;
  };

  const covered = new Set<string>();
  const selected: SelectedPassage[] = kept.map((c, index) => {
    for (const q of c.queryCoverage ?? []) covered.add(q);
    return {
      candidate: c,
      reasons: [reasonFor(c, index)],
      contextRequirements: contextRequirementsFor(c),
      rerankPosition: c.rerankScore === null ? null : eligible.indexOf(c),
    };
  });

  return {
    selected,
    additional,
    uncoveredQueryIds: approvedQueryIds.filter((q) => !covered.has(q)),
    evidenceInsufficient: selected.length === 0,
    mainCount: kept.length,
    pinnedPromotions: promoted.length,
  };
}
