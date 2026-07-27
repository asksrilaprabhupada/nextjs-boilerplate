/**
 * 01-config.ts — Every tunable in the one search pipeline, in one typed place.
 *
 * There is ONE mode. No quick/guided, no article/references, no per-intent
 * budget. If a number here varies by question type, that is a bug: the whole
 * point of the rebuild is that `BG 18.66` and `How can I control my mind?`
 * travel the identical path.
 *
 * Three kinds of number live here, and they are not the same kind of thing:
 *
 *   RELATIVE THRESHOLDS  — fractions of an observed top score. These are the
 *     only portable form. `ts_rank_cd` is unbounded and its scale varies per
 *     table: measured on production for "How can I control my mind?", the top
 *     fts_core score was 1.73 on verses, 7.80 on transcripts and 2.24 on
 *     letters. An absolute cross-table cut-off would silently mean something
 *     different on every source.
 *
 *   INFRASTRUCTURE CEILINGS — runaway guards, NOT content limits. The brief is
 *     explicit that a ceiling must never act as the normal stopping rule, must
 *     be logged when reached, and must never let the response imply that
 *     everything relevant was found. `retrievalCeilingRows` is sized so that
 *     ordinary questions never touch it.
 *
 *   CALIBRATION CANDIDATES — the two final relevance floors. They are starting
 *     points to be swept against tests/gold/gold-set-v1.json, not findings.
 *
 * Nothing here reads a provider secret. Flags go through helpers so tests can
 * assert the default rather than whatever the ambient environment holds.
 */

/** Query id reserved for the devotee's actual question. */
export const ORIGINAL_QUERY_ID = "q_original";

/** Exactly six angles. Not a maximum, not a target — the contract. */
export const ANGLE_COUNT = 6;

/** Query ids for the six angles, in order. */
export const ANGLE_QUERY_IDS = Array.from(
  { length: ANGLE_COUNT },
  (_, i) => `q_angle_${i + 1}`,
) as readonly string[];

/** Every query id the pipeline will accept from a plan. */
export const ALL_QUERY_IDS = [ORIGINAL_QUERY_ID, ...ANGLE_QUERY_IDS] as readonly string[];

export const SEARCH_CONFIG = {
  /* ── Angle generation ─────────────────────────────────────────────── */

  /** Wall-clock cap on one angle-generation call. Two calls max (one retry). */
  angleTimeoutMs: 8_000,

  /**
   * Two angles whose token sets overlap this much are the same angle wearing
   * different words, and the brief forbids six paraphrases of one sentence.
   */
  angleMaxJaccard: 0.8,

  /* ── Retrieval ────────────────────────────────────────────────────── */

  /**
   * Rows requested per table per round. Escalation is the exception: a round
   * only widens when the DB says a channel was truncated AND the previous
   * round's tail was still above the floor.
   */
  retrievalRounds: [120, 280, 400] as readonly number[],

  /**
   * Semantic rows per query per table. Clamped to 400 inside the SQL because
   * hnsw.ef_search is 400 and an HNSW scan cannot return more than ef_search —
   * asking for more is how v2 silently returned 100 when asked for 300.
   */
  semanticLimit: 300,

  /**
   * Tail floor, as a fraction of the top score within the SAME
   * (query, channel, table) group. Below this a newly-arrived candidate is
   * noise, and its arrival is not a reason to widen the search further.
   */
  retrievalTailFloor: 0.05,

  /** Infrastructure ceiling. Logged when reached. Never the normal limit. */
  retrievalCeilingRows: 400,

  /* ── Duplicate collapse ───────────────────────────────────────────── */

  /**
   * Containment: |shingles(shorter) ∩ shingles(longer)| / |shingles(shorter)|.
   * The brief's band is 85–90%; this sits in the middle. Only collapses when
   * most of the SHORTER passage is repeated inside the longer one.
   */
  containmentThreshold: 0.87,

  /** Shingle width, in tokens. */
  shingleTokens: 8,

  /**
   * A passage with fewer shingles than this can never be collapsed by
   * containment. Containment over a handful of tokens is noise, and this is
   * what stops the deliberate overlap region between adjacent purport chunks
   * from swallowing a genuinely distinct short chunk.
   */
  minShinglesForContainment: 8,

  /* ── Rerank ───────────────────────────────────────────────────────── */

  /**
   * Documents per provider call. Above this the pool is split into
   * deterministic batches, survivors are collected, and ONE final call over
   * the survivors produces the global order.
   */
  rerankBatchSize: 500,

  /** Full text sent in the final, order-deciding pass. */
  rerankFullChars: 4_000,

  /** Truncated text sent in the cheap coarse pass. */
  rerankCoarseChars: 1_200,

  /**
   * A coarse-pass document survives if it clears this score OR sits in the
   * batch's top fraction — whichever is more inclusive, so a batch of
   * uniformly strong passages is not cut merely for being uniform.
   */
  rerankCoarseFloor: 0.02,
  rerankCoarseKeepFraction: 0.4,

  /* ── Final selection ──────────────────────────────────────────────── */

  /**
   * CALIBRATION CANDIDATES. A passage is kept when it clears BOTH. There is no
   * minimum count, no maximum count and no source quota — every passage above
   * the threshold is returned, and the interface collapses the tail rather
   * than discarding it.
   */
  finalAbsoluteFloor: 0.05,
  finalRelativeFloor: 0.12,
} as const;

/** Channels the SQL emits. Unknown channel names are ignored, never guessed. */
export type ChannelName =
  | "semantic"
  | "fts_core"
  | "fts_expansion"
  | "lexical"
  | "controlled_tags";

export const CHANNEL_NAMES: readonly ChannelName[] = [
  "semantic",
  "fts_core",
  "fts_expansion",
  "lexical",
  "controlled_tags",
];

/**
 * Pseudo query ids the SQL uses for rankings belonging to no single question:
 * caller-supplied phrases and validated tag slugs. They are derived from the
 * devotee's own question and are not one of the seven searches, so they never
 * appear in a candidate's `foundBy` coverage.
 */
export const PSEUDO_QUERY_IDS = new Set(["__lexical__", "__tags__"]);

/** The five retrieval RPCs and the source namespace each one owns. */
export const BATCH_FUNCTIONS = [
  "search_verses_hybrid_batch_v3",
  "search_verse_chunks_hybrid_batch_v3",
  "search_prose_hybrid_batch_v3",
  "search_transcripts_hybrid_batch_v3",
  "search_letters_hybrid_batch_v3",
] as const;

export type BatchFunction = (typeof BATCH_FUNCTIONS)[number];

/**
 * Identifies the corpus a cached artefact was built from, so a re-tagged or
 * re-embedded corpus cannot be served from stale entries.
 */
export function searchCorpusVersion(): string {
  return process.env.SEARCH_CORPUS_VERSION || "2026-07-08-tags-v3";
}

/**
 * Bumped whenever anything that changes the SHAPE or CONTENT of a response
 * changes: thresholds, dedup rules, reranker model, prompt, or the response
 * structure itself. It is part of every cache key, so bumping it is how a
 * behaviour change invalidates every stale answer at once.
 */
export function searchConfigVersion(): string {
  return process.env.SEARCH_CONFIG_VERSION || "v3-2026-07-27";
}

/** Pipeline identity in telemetry. There is only one pipeline now. */
export const SEARCH_PIPELINE_VERSION = "v3";

/* ── Provider models. Never NEXT_PUBLIC_* — these sit beside secrets. ── */

export function geminiAngleModel(): string {
  return process.env.GEMINI_ANGLE_MODEL || "gemini-2.5-flash";
}

export function geminiConnectorModel(): string {
  return process.env.GEMINI_CONNECTOR_MODEL || "gemini-2.5-flash";
}

export function cohereRerankModel(): string {
  return process.env.COHERE_RERANK_MODEL || "rerank-v4.0-pro";
}

/**
 * The rerank query shape. The brief mandates the structured block carrying the
 * question and all six angles, and that is the default. But rerank
 * cross-encoders are trained on short queries, so a ~400-character structured
 * query is a genuine quality risk rather than an obvious improvement. Both arms
 * are measurable against the gold set; this exists so the comparison is a
 * config change rather than a code change.
 */
export function rerankQueryShape(): "structured" | "question_only" {
  return process.env.RERANK_QUERY_SHAPE === "question_only" ? "question_only" : "structured";
}
