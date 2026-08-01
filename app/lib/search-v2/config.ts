/**
 * config.ts — Every tunable number in the V2 pipeline, in one typed place.
 *
 * These are BENCHMARK CANDIDATES, not truth. The brief is explicit that the
 * starting weights are a place to begin measuring from, and Phase D's gold set
 * decides whether they survive. Keeping them here — rather than inlined at the
 * call sites or smeared across five SQL bodies — is what makes an experiment
 * arm a one-line change instead of an archaeology exercise.
 *
 * Nothing in this file reads a provider secret. Flags are read through helpers
 * so a deploy can flip behaviour without a rebuild, and so tests can assert the
 * default rather than whatever the ambient environment happens to hold.
 */

/** Fusion and channel weighting. One weighted RRF pass consumes all of this. */
export const SEARCH_V2_CONFIG = {
  /** RRF damping. Benchmarked against 20/40/60 in Phase D. */
  rrfK: 50,

  /**
   * How much a ranking is worth by WHICH query produced it. The original
   * question outranks every subquery by construction: subqueries are recall
   * scaffolding and must never outvote the thing the devotee actually asked.
   */
  queryWeights: {
    original: 1.0,
    primary: 0.75,
    supporting: 0.6,
    exploratory: 0.4,
  },

  /**
   * How much a ranking is worth by WHICH channel produced it.
   * fts_core leads because exact phrases, quotations, references and names are
   * the highest-precision signal in this corpus. fts_expansion is deliberately
   * below semantic — it is an alias/transliteration net, not a relevance
   * judgement. Tags are a nudge and a coverage aid, never a filter.
   */
  channelWeights: {
    ftsCore: 1.2,
    semantic: 1.0,
    ftsExpansion: 0.65,
    lexical: 1.1,
    controlledTags: 0.35,
  },

  /**
   * DEPRECATED — the old equal-per-table ceiling, kept only so a caller that
   * missed the per-source shape below does not break. Retrieval no longer
   * reads it; it reads `perSourceLimit`.
   */
  perTableLimit: 400,

  /**
   * Per-source candidate ceilings. NOT equal: an equal budget is not fairness, it
   * is flooding. Letters are personal correspondence and there are 19,468 of them;
   * given the same 400 seats as verses they crowd out the scripture a devotee came
   * for. These are starting values to be tuned from the gold set, not truth.
   */
  perSourceLimit: {
    search_verses_hybrid_batch_v3: 200,
    search_verse_chunks_hybrid_batch_v3: 150,
    search_prose_hybrid_batch_v3: 120,
    search_transcripts_hybrid_batch_v3: 150,
    search_letters_hybrid_batch_v3: 80,
  },
  /** Semantic lane ceiling per source. Clamped to ef_search (400) by the RPC. */
  perSourceSemanticLimit: 300,
} as const;

/** How many candidates earn a cross-encoder reading. The rest are still shown
 *  as citations — this is a spending decision, not a relevance verdict. */
export const PREFILTER_POOL = 400;

export type QueryPriority = keyof typeof SEARCH_V2_CONFIG.queryWeights;
export type ChannelName =
  | "fts_core"
  | "fts_expansion"
  | "semantic"
  | "lexical"
  | "controlled_tags";

/** Maps the DB's channel strings onto the weight table. */
export const CHANNEL_WEIGHT_KEY: Record<ChannelName, keyof typeof SEARCH_V2_CONFIG.channelWeights> = {
  fts_core: "ftsCore",
  fts_expansion: "ftsExpansion",
  semantic: "semantic",
  lexical: "lexical",
  controlled_tags: "controlledTags",
};

/**
 * There is ONE pipeline. There is no flag, no environment variable and no query
 * parameter that selects a different one, because there is no different one left
 * to select. A question that reaches this codebase travels exactly one road.
 */
export function searchPipelineVersion(): string {
  return process.env.SEARCH_PIPELINE_VERSION || "v2";
}

/**
 * Identifies the corpus a cached artefact was built from. Cache keys carry it
 * so a re-tagged or re-embedded corpus cannot be served from stale entries.
 */
export function searchCorpusVersion(): string {
  return process.env.SEARCH_CORPUS_VERSION || "2026-07-08-tags-v3";
}

/** Provider model IDs. Never `NEXT_PUBLIC_*` — these sit beside secrets. */
export function geminiQueryPlannerModel(): string {
  return process.env.GEMINI_QUERY_PLANNER_MODEL || "gemini-2.5-flash";
}

export function geminiArticlePlannerModel(): string {
  return process.env.GEMINI_ARTICLE_PLANNER_MODEL || "gemini-2.5-flash";
}

export function cohereRerankModel(): string {
  return process.env.COHERE_RERANK_MODEL || "rerank-v4.0-pro";
}
