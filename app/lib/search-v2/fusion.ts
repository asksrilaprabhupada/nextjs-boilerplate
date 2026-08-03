/**
 * fusion.ts — One weighted reciprocal-rank fusion pass.
 *
 *     score(d) = Σ_query Σ_channel [ w_query × w_channel ÷ (k + rank) ]
 *
 * ONE pass, over every (query × channel) ranking at once. Deliberately not a
 * per-subquery RRF followed by a second fusion across subqueries: that second
 * pass throws away the weights, and a cluster of agreeing weak variants ends up
 * outvoting the devotee's actual question. Here the original query's rankings
 * carry their full weight into the only comparison that happens.
 *
 * The per-contribution breakdown is retained on every candidate. When a result
 * looks wrong, the question "why did this rank here" has to be answerable
 * without re-running anything.
 */
import {
  SEARCH_V2_CONFIG,
  CHANNEL_WEIGHT_KEY,
  type ChannelName,
  type QueryPriority,
} from "@/app/lib/search-v2/config";

/** One (query, channel, rank) observation, exactly as a batch RPC reported it. */
export interface ChannelRank {
  query_id: string;
  channel: string;
  rank: number;
  score?: number | string | null;
}

/**
 * Server-only proof that a transcript candidate was projected from one full
 * source row. This object is deliberately absent from the wire adapters.
 */
export interface SpeakerProjectionMarker {
  mode: "prabhupada_segments";
  /** SHA-256 of the exact full RPC text, never the text itself. */
  sourceVerificationHash: string;
  keptSegments: number;
  guestSegmentsRemoved: number;
  unknownSegmentsRemoved: number;
}

/** A candidate as returned by any of the five batch retrieval RPCs. */
export interface RetrievedCandidate {
  passage_key: string;
  source_type: string;
  row_id: string;
  retrieval_text: string;
  reference: string | null;
  speaker: string | null;
  recipient: string | null;
  occurred_on: string | null;
  location: string | null;
  matched_query_ids: string[] | null;
  channel_ranks: ChannelRank[] | null;
  channel_scores: Record<string, number> | null;
  tag_matches: number | null;
  /** True when any bytes in an unfiltered transcript lack a speaker prefix. */
  speakerUnidentified?: boolean;
  /** Present only on speaker-filtered transcript candidates. */
  speakerProjection?: SpeakerProjectionMarker;
  /**
   * Set only by the pipeline for a verse the devotee asked for BY REFERENCE
   * (direct_verse_lookup). A pinned candidate skips every cut downstream —
   * junk floor, pre-filter, rerank pool, tiering — and is never deduplicated
   * away: the one thing that must not happen to "BG 18.66" is losing BG 18.66.
   */
  pinned?: boolean;
}

export interface FusionContribution {
  queryId: string;
  channel: string;
  rank: number;
  queryWeight: number;
  channelWeight: number;
  contribution: number;
}

export interface FusedCandidate extends RetrievedCandidate {
  fusedScore: number;
  contributions: FusionContribution[];
  /** Distinct approved queries that surfaced this passage at all. */
  queryCoverage: string[];
}

/** Priority of each query id. The original question is always `original`. */
export type QueryPriorityMap = Record<string, QueryPriority>;

const KNOWN_CHANNELS = new Set<string>(Object.keys(CHANNEL_WEIGHT_KEY));

/**
 * The junk floor. The corpus holds roughly 5,000 fragments shorter than this —
 * section headers, reference labels, single-word replies like "Devotee: No."
 * They are not passages, and every one that reaches the reranker spends money
 * to be told so. Verses are exempt: some translations are legitimately short.
 */
export const JUNK_FLOOR_CHARS = 60;

/**
 * Drops sub-floor fragments before fusion. Pure — the pipeline logs the count
 * (`search.junk_floor`) with its request id. Applied to the raw RPC groups so
 * fusion never spends a rank on a section header.
 */
export function applyJunkFloor<T extends RetrievedCandidate>(
  groups: T[][],
): { groups: T[][]; dropped: number } {
  let dropped = 0;
  const kept = groups.map((group) =>
    (group ?? []).filter((c) => {
      if (c.pinned || c.source_type === "verse") return true;
      if ((c.retrieval_text || "").trim().length >= JUNK_FLOOR_CHARS) return true;
      dropped += 1;
      return false;
    }),
  );
  return { groups: kept, dropped };
}

/**
 * The pseudo query ids the SQL layer uses for rankings that belong to no single
 * subquery. They carry the ORIGINAL question's weight: caller-supplied phrases
 * and validated tag slugs are derived from the devotee's own question, so
 * discounting them as if they were exploratory variants would be wrong.
 */
const PSEUDO_QUERY_WEIGHT: Record<string, QueryPriority> = {
  __lexical__: "original",
  __tags__: "original",
};

function weightForQuery(queryId: string, priorities: QueryPriorityMap): number {
  const priority = priorities[queryId] ?? PSEUDO_QUERY_WEIGHT[queryId] ?? "supporting";
  return SEARCH_V2_CONFIG.queryWeights[priority];
}

function weightForChannel(channel: string): number {
  if (!KNOWN_CHANNELS.has(channel)) return 0;
  return SEARCH_V2_CONFIG.channelWeights[CHANNEL_WEIGHT_KEY[channel as ChannelName]];
}

/**
 * Fuses candidates from every table into one ranked list.
 *
 * @param groups   one array per table — order is irrelevant, fusion is global.
 * @param priorities  query id → priority. Ids absent from the map are treated
 *                    as `supporting`, never as `original`: an unrecognised id
 *                    must not be able to promote itself.
 */
export function fuseWeighted(
  groups: RetrievedCandidate[][],
  priorities: QueryPriorityMap,
  k: number = SEARCH_V2_CONFIG.rrfK,
): FusedCandidate[] {
  const byKey = new Map<string, FusedCandidate>();

  for (const group of groups) {
    for (const candidate of group ?? []) {
      if (!candidate?.passage_key) continue;

      const existing = byKey.get(candidate.passage_key);
      const target: FusedCandidate =
        existing ??
        ({
          ...candidate,
          fusedScore: 0,
          contributions: [],
          queryCoverage: [],
        } as FusedCandidate);

      for (const cr of candidate.channel_ranks ?? []) {
        if (!cr || typeof cr.rank !== "number" || cr.rank < 1) continue;
        const channelWeight = weightForChannel(cr.channel);
        if (channelWeight === 0) continue; // unknown channel contributes nothing

        const queryWeight = weightForQuery(cr.query_id, priorities);
        const contribution = (queryWeight * channelWeight) / (k + cr.rank);

        target.fusedScore += contribution;
        target.contributions.push({
          queryId: cr.query_id,
          channel: cr.channel,
          rank: cr.rank,
          queryWeight,
          channelWeight,
          contribution,
        });
      }

      const coverage = new Set(target.queryCoverage);
      for (const id of candidate.matched_query_ids ?? []) coverage.add(id);
      target.queryCoverage = [...coverage];

      if (!existing) byKey.set(candidate.passage_key, target);
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.fusedScore - a.fusedScore || a.passage_key.localeCompare(b.passage_key),
  );
}

/**
 * Assigns each approved subquery its priority, with the original question
 * pinned to `original`. Kept here so the pipeline cannot accidentally hand the
 * original question a subquery weight.
 */
export function buildPriorityMap(
  originalQueryId: string,
  subqueries: { id: string; priority: QueryPriority }[],
): QueryPriorityMap {
  const map: QueryPriorityMap = { [originalQueryId]: "original" };
  for (const sq of subqueries) {
    if (sq.id === originalQueryId) continue; // the original cannot be demoted
    map[sq.id] = sq.priority;
  }
  return map;
}
