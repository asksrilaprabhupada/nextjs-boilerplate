/**
 * select.ts — Selection by RELEVANCE, split into two tiers, never a deletion.
 *
 * THE CUT IS NOT A DELETION. A fixed threshold cannot work here: reranker scores
 * are query-dependent, and on a corpus this topically homogeneous almost every
 * passage scores respectably. 1,942 of 1,971 clearing 0.3 is not a bug in the
 * number, it is a category error in the method.
 *
 * So the scores are used to SPLIT, not to filter:
 *   - main:       full text, rendered on the page. Capped, because a reader
 *                 cannot absorb a thousand purports.
 *   - additional: citation, label and one line each. Uncapped. Every passage
 *                 that survived retrieval is here. Nothing is lost.
 *
 * The split point is where the scores actually fall off — the largest gap in the
 * sorted curve, searched within a sane window — not a number chosen in advance.
 *
 * What survives from the old selector, because it is about honesty rather than
 * counting: an unlabellable letter (no recipient or no date) is excluded
 * outright — a hard exclusion, not a scoring penalty — and the purport
 * belonging to the strongest verse is pulled in beside it, because a purport
 * explaining a shown verse is context, not repetition.
 */
import type { RankedCandidate } from "@/app/lib/search-v2/rerank";

export const MAIN_TIER_MIN = 8;
export const MAIN_TIER_MAX = 20;

/** A gap smaller than this is score noise, not a boundary; the cap governs. */
export const MIN_CUT_GAP = 0.02;

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
   * Everything else that survived retrieval, in rerank-score order (fused
   * score as the tiebreak). Shown as citations — never dropped.
   */
  additional: RankedCandidate[];
  /** Approved subquery ids no main-tier passage covers. Drives honest gaps. */
  uncoveredQueryIds: string[];
  evidenceInsufficient: boolean;
  /** Where the largest-gap cut landed, and how big the gap was — for tuning. */
  cutIndex: number;
  cutGap: number;
}

export interface SelectionInput {
  /** Candidates in final relevance order (reranked, or fused if rerank failed). */
  ranked: RankedCandidate[];
  /** Ids of every approved query, so coverage gaps can be reported. */
  approvedQueryIds: string[];
  /** True when the reranker actually ran, so scores exist to split on. */
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

/**
 * The largest drop in the sorted score curve, searched between MAIN_TIER_MIN
 * and MAIN_TIER_MAX. Returns the cut index (main = first `cutIndex` items) and
 * the gap it sits on. Null scores contribute no gap, so a rerank-down search
 * falls through to the cap — with no scores there is no natural boundary.
 */
export function findCut(scores: (number | null)[]): { cutIndex: number; cutGap: number } {
  const cap = Math.min(MAIN_TIER_MAX, scores.length);
  if (scores.length <= MAIN_TIER_MIN) return { cutIndex: scores.length, cutGap: 0 };

  let cutIndex = cap;
  let cutGap = 0;
  for (let c = MAIN_TIER_MIN; c <= cap && c < scores.length; c++) {
    const before = scores[c - 1];
    const after = scores[c];
    if (before === null || after === null) continue;
    const drop = before - after;
    if (drop > cutGap) {
      cutGap = drop;
      cutIndex = c;
    }
  }
  if (cutGap <= MIN_CUT_GAP) return { cutIndex: cap, cutGap };
  return { cutIndex, cutGap };
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
      cutIndex: 0,
      cutGap: 0,
    };
  }

  // Pinned passages (an exact reference the devotee wrote) lead the main tier
  // and consume no slot — the cut is computed over the unpinned remainder.
  const pinned = eligible.filter((c) => c.pinned);
  const unpinned = eligible.filter((c) => !c.pinned);

  // ── The cut: the largest score gap inside the window, or the cap. ──
  const { cutIndex, cutGap } = findCut(unpinned.map((c) => c.rerankScore));
  let kept = [...pinned, ...unpinned.slice(0, cutIndex)];
  let additional = unpinned.slice(cutIndex);

  // ── The purport partner of the strongest verse ──
  // A purport explaining a shown verse is context, not repetition; it joins its
  // verse even when its own score fell below the cut.
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
      additional = additional.filter((c) => c.passage_key !== partner.passage_key);
    }
  }

  // ── Log every score plus the chosen cut, so the window and the gap floor
  //    can be tuned from real distributions rather than guesses. ──
  console.info(
    JSON.stringify({
      level: "info",
      event: "search.selection_scores",
      requestId: requestId ?? null,
      basis: input.rerankAvailable ? "largest_gap" : "rerank_unavailable",
      cutIndex,
      cutGap: Math.round(cutGap * 1000) / 1000,
      eligible: eligible.length,
      main: kept.length,
      additional: additional.length,
      scores: eligible.map((c) => (c.rerankScore === null ? null : Math.round(c.rerankScore * 1000) / 1000)),
    }),
  );

  const reasonFor = (c: RankedCandidate): string => {
    if (c.pinned) return "exact reference requested";
    if (c.passage_key === partnerKey) return "purport/verse partner of the primary passage";
    if (!input.rerankAvailable) return "fused order (reranker unavailable)";
    return `above the largest score gap (cut at ${cutIndex}, gap ${cutGap.toFixed(3)})`;
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
    additional,
    uncoveredQueryIds: approvedQueryIds.filter((q) => !covered.has(q)),
    evidenceInsufficient: selected.length === 0,
    cutIndex,
    cutGap,
  };
}
