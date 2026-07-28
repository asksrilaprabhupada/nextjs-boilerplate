/**
 * select.ts — Rule-based evidence selection.
 *
 * NOT "take the top N". The reranker answers "how relevant is this passage to
 * the question"; it does not answer "which set of passages, together, answers
 * it honestly". That second question is this module's job, and it is decided by
 * rules rather than by a model, because the failure it prevents — a
 * recipient-specific letter presented as universal instruction — is the one
 * failure the brief says cannot be undone.
 *
 * What this deliberately does NOT do: force a lecture, force a letter, force
 * multiple books, multiple years, or a full spread of PLEASE categories. Three
 * Gītā verses and one purport with no letter is a better answer than a weak
 * letter dragged in for variety, and source diversity bought at the cost of
 * relevance is a lie about what the corpus says.
 */
import { SELECTION_SIZING, MMR_LAMBDA, mmrEnabled } from "@/app/lib/search-v2/config";
import type { DedupedCandidate } from "@/app/lib/search-v2/dedup";

/** A context notice the renderer MUST show alongside the passage. */
export type ContextRequirement =
  | "letter_context"
  | "conversation_context"
  | "narrative_not_instruction";

export interface SelectedPassage {
  candidate: DedupedCandidate;
  /** Why this passage was chosen. Shown in the evidence trail, not as prose. */
  reasons: string[];
  contextRequirements: ContextRequirement[];
  /** Rerank position, when a rerank ran. */
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
  ranked: DedupedCandidate[];
  /** Ids of every approved query, so coverage gaps can be reported. */
  approvedQueryIds: string[];
  /** Hard ceiling on shown passages. The sizing floor governs the lower bound. */
  maxFinalPassages: number;
  /** Embeddings for redundancy scoring; absent disables the MMR component. */
  embeddings?: Map<string, number[]>;
}

const VERSE_TYPES = new Set(["verse", "purport"]);

/**
 * A candidate scoring below this fraction of the primary passage is not
 * strong enough to be shown purely to reach the sizing minimum. Benchmarked in
 * Phase D alongside the fusion weights.
 */
const MIN_RELATIVE_SCORE = 0.25;

function contextRequirementsFor(c: DedupedCandidate): ContextRequirement[] {
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
export function isLabellable(c: DedupedCandidate): boolean {
  if (c.source_type !== "letter") return true;
  return Boolean((c.recipient || "").trim()) && Boolean((c.occurred_on || "").trim());
}

function cosine(a: number[], b: number[]): number {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Selects the passages that will actually be shown.
 *
 * Passes, in order:
 *   1. drop anything unlabellable,
 *   2. take the strongest passage outright — the direct answer,
 *   3. pull in the verse↔purport partner of a selected verse, because a
 *      purport explaining a shown verse is context, not redundancy,
 *   4. fill remaining slots preferring passages that cover a subquery nothing
 *      selected covers yet, with a redundancy penalty,
 *   5. stop at the sizing minimum unless coverage still demands more.
 */
export function selectEvidence(input: SelectionInput): SelectionResult {
  const { ranked, approvedQueryIds, maxFinalPassages, embeddings } = input;
  const sizing = SELECTION_SIZING;
  const ceiling = Math.min(maxFinalPassages, sizing.max);

  const eligible = ranked.filter(isLabellable);
  if (eligible.length === 0) {
    return { selected: [], uncoveredQueryIds: approvedQueryIds, evidenceInsufficient: true };
  }

  const chosen: SelectedPassage[] = [];
  const chosenKeys = new Set<string>();
  const covered = new Set<string>();

  const take = (c: DedupedCandidate, reason: string) => {
    if (chosenKeys.has(c.passage_key) || chosen.length >= ceiling) return;
    chosenKeys.add(c.passage_key);
    chosen.push({
      candidate: c,
      reasons: [reason],
      contextRequirements: contextRequirementsFor(c),
      rerankPosition: eligible.indexOf(c),
    });
    for (const q of c.queryCoverage ?? []) covered.add(q);
  };

  // 2. The strongest passage. Often it is most of the answer on its own.
  take(eligible[0], "highest relevance to the original question");

  // 3. Verse ↔ purport partner.
  const first = eligible[0];
  if (VERSE_TYPES.has(first.source_type)) {
    const partner = eligible.find(
      (c) =>
        !chosenKeys.has(c.passage_key) &&
        VERSE_TYPES.has(c.source_type) &&
        c.source_type !== first.source_type &&
        c.reference &&
        first.reference &&
        c.reference.trim() === first.reference.trim(),
    );
    if (partner) take(partner, "purport/verse partner of the primary passage");
  }

  // 4. Coverage-first fill.
  while (chosen.length < ceiling) {
    let best: DedupedCandidate | null = null;
    let bestScore = -Infinity;
    let bestReason = "";

    for (const c of eligible) {
      if (chosenKeys.has(c.passage_key)) continue;

      const newCoverage = (c.queryCoverage ?? []).filter((q) => !covered.has(q)).length;

      // Redundancy penalty: max similarity to anything already chosen.
      let redundancy = 0;
      if (embeddings) {
        const v = embeddings.get(c.passage_key);
        if (v) {
          for (const s of chosen) {
            const sv = embeddings.get(s.candidate.passage_key);
            if (sv) redundancy = Math.max(redundancy, cosine(v, sv));
          }
        }
      }

      const relevance = c.fusedScore;
      const lambda = mmrEnabled() ? MMR_LAMBDA : 1;
      // With MMR disabled the redundancy term vanishes entirely rather than
      // applying a half-measure: 0.70 is a candidate, not a finding.
      const score =
        lambda * relevance +
        newCoverage * 0.05 -
        (mmrEnabled() ? (1 - lambda) * redundancy : 0);

      if (score > bestScore) {
        bestScore = score;
        best = c;
        bestReason = newCoverage > 0 ? `covers ${newCoverage} otherwise-unanswered angle(s)` : "next strongest evidence";
      }
    }

    if (!best) break;

    // The sizing MINIMUM is a target, not an obligation. A passage far weaker
    // than the primary one is not evidence just because a slot is open — that
    // is exactly the "weak letter dragged in for variety" the brief rejects.
    // Below the floor a candidate earns its place only by covering a gap.
    const topScore = chosen[0]?.candidate.fusedScore ?? 0;
    const addsCoverage = (best.queryCoverage ?? []).some((q) => !covered.has(q));
    if (topScore > 0 && best.fusedScore < topScore * MIN_RELATIVE_SCORE && !addsCoverage) break;

    // Past the sizing minimum, only keep going while a real gap remains.
    if (chosen.length >= sizing.min && !addsCoverage) break;

    take(best, bestReason);
  }

  const uncovered = approvedQueryIds.filter((q) => !covered.has(q));

  return {
    selected: chosen,
    uncoveredQueryIds: uncovered,
    // Genuinely weak evidence is reported as such rather than dressed up.
    evidenceInsufficient: chosen.length === 0,
  };
}
