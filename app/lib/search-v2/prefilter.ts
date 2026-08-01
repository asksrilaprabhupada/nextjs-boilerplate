/**
 * prefilter.ts — The cheap gate between retrieval and the reranker.
 *
 * A cross-encoder is the most expensive thing in the pipeline, so it should read
 * a few hundred well-chosen passages, not two thousand indiscriminate ones. This
 * gate uses only signals the RPCs already returned — no model call, no round
 * trip — and it is deliberately CONSERVATIVE: it decides who gets the careful
 * reading, NOT what the devotee is allowed to see. Everything it sets aside is
 * still returned to the page as a citation (see select.ts, the `additional`
 * tier). Nothing is deleted.
 *
 * Two signals, both free:
 *   - AGREEMENT: how many distinct channels found this passage. A passage the
 *     keyword search AND the meaning search both surfaced is evidence; one that
 *     only drifted in from the semantic lane at rank 380 is a guess.
 *   - COVERAGE: how many distinct approved queries surfaced it.
 * Ties break on fusedScore, which already carries the RRF weighting.
 *
 * Source floors exist because agreement alone would let 144,438 transcript
 * paragraphs outvote 25,131 verses. A devotee preparing a class needs the verse.
 */
import type { FusedCandidate } from "@/app/lib/search-v2/fusion";
import { PREFILTER_POOL } from "@/app/lib/search-v2/config";

/** Pseudo query ids the SQL layer emits — they are channels, not queries. */
const PSEUDO_QUERY_IDS = new Set(["__lexical__", "__tags__"]);

/**
 * Guaranteed seats per source, taken BEFORE the global cut. Starting values, to
 * be tuned from the gold set like every other number in config.ts.
 */
export const SOURCE_FLOORS: Record<string, number> = {
  verse: 60,
  purport: 50,
  book: 40,
  lecture: 50,
  letter: 25,
};

export interface PrefilterStats {
  before: number;
  after: number;
  setAside: number;
  perSource: Record<string, { in: number; passed: number }>;
}

export interface PrefilterResult<T extends FusedCandidate> {
  /** The candidates that earn a cross-encoder reading, in agreement order. */
  passed: T[];
  /**
   * NOT discarded — the pipeline returns these as the tail of the `additional`
   * tier, ordered by fusedScore, so completeness survives the spending cut.
   */
  setAside: T[];
  stats: PrefilterStats;
}

/** distinctChannels × 2 + distinctQueries, from data the RPCs already sent. */
export function agreementScore(c: FusedCandidate): number {
  const channels = new Set<string>();
  const queries = new Set<string>();
  for (const cr of c.channel_ranks ?? []) {
    if (!cr?.channel) continue;
    channels.add(cr.channel);
    if (cr.query_id && !PSEUDO_QUERY_IDS.has(cr.query_id)) queries.add(cr.query_id);
  }
  return channels.size * 2 + queries.size;
}

export function prefilterCandidates<T extends FusedCandidate>(
  candidates: T[],
  opts: { pool?: number } = {},
): PrefilterResult<T> {
  const pool = opts.pool ?? PREFILTER_POOL;

  // Deterministic order: agreement, then RRF weight, then key.
  const sorted = [...candidates].sort((a, b) => {
    const s = agreementScore(b) - agreementScore(a);
    if (s !== 0) return s;
    if (b.fusedScore !== a.fusedScore) return b.fusedScore - a.fusedScore;
    return a.passage_key.localeCompare(b.passage_key);
  });

  const included = new Set<string>();

  // Pinned candidates are always included — the pre-filter is a spending
  // decision, and the passage the devotee named is never optional spend.
  for (const c of sorted) if (c.pinned) included.add(c.passage_key);

  // Source floors first, so a numerous source cannot outvote a scarce one.
  const perSourceTaken = new Map<string, number>();
  for (const c of sorted) {
    const floor = SOURCE_FLOORS[c.source_type] ?? 0;
    const taken = perSourceTaken.get(c.source_type) ?? 0;
    if (taken < floor && !included.has(c.passage_key)) {
      included.add(c.passage_key);
      perSourceTaken.set(c.source_type, taken + 1);
    }
  }

  // Then the remainder of the pool from the global order.
  for (const c of sorted) {
    if (included.size >= pool) break;
    included.add(c.passage_key);
  }

  const passed = sorted.filter((c) => included.has(c.passage_key));
  const setAside = sorted
    .filter((c) => !included.has(c.passage_key))
    .sort((a, b) => b.fusedScore - a.fusedScore || a.passage_key.localeCompare(b.passage_key));

  const perSource: PrefilterStats["perSource"] = {};
  for (const c of candidates) {
    const entry = perSource[c.source_type] ?? { in: 0, passed: 0 };
    entry.in += 1;
    if (included.has(c.passage_key)) entry.passed += 1;
    perSource[c.source_type] = entry;
  }

  return {
    passed,
    setAside,
    stats: {
      before: candidates.length,
      after: passed.length,
      setAside: setAside.length,
      perSource,
    },
  };
}
