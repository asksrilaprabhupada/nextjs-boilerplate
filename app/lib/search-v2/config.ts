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

  /** Near-duplicate collapse threshold (cosine). Benchmarked in Phase D. */
  duplicateCosine: 0.95,

  /** Per-table candidate ceiling handed to each batch RPC. */
  perTableLimit: 60,
} as const;

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

/** Reader modes. Quick Answer is the 7am-class case; Guided Study is class prep. */
export type SearchMode = "quick" | "guided";

export const MODE_BUDGETS = {
  quick: { maxSubqueries: 3, maxCandidatesBeforeRerank: 60, maxFinalPassages: 4 },
  guided: { maxSubqueries: 6, maxCandidatesBeforeRerank: 120, maxFinalPassages: 8 },
} as const;

/**
 * Evidence-selector sizing. A range, not a target: the brief is explicit that
 * three Gītā verses and one purport with no letter beats a weak letter dragged
 * in for variety.
 */
export const SELECTION_SIZING = {
  direct: { min: 2, max: 4 },
  ordinary: { min: 4, max: 6 },
  broad: { min: 5, max: 8 },
} as const;

/** MMR is off until the gold set says otherwise. λ is a candidate, not a finding. */
export const MMR_LAMBDA = 0.7;

export function mmrEnabled(): boolean {
  return (process.env.SEARCH_MMR_ENABLED ?? "false").toLowerCase() === "true";
}

/**
 * The V2 flag. The existing pipeline stays in place as the control arm; this
 * decides which one serves a given request.
 *
 * DEFAULTS ON. That is a deliberate, and reversible, decision.
 *
 * V2 has not been executed end to end — the build environment's network policy
 * blocks the deployment host and every AI provider, so it is verified at the
 * database, type and unit-test layers only. Shipping it on is what was asked
 * for, and the failure modes are typed rather than silent: a retrieval failure
 * is a 503 with a request id, and no passage reaches a reader without surviving
 * the exact re-fetch in refetch.ts.
 *
 * ROLLBACK IS ONE ENVIRONMENT VARIABLE, NO DEPLOY:
 *
 *     DEEP_RESEARCH_V2_ENABLED=false
 *
 * That restores the restored-and-verified V1 pipeline immediately.
 */
export function deepResearchV2Enabled(): boolean {
  return (process.env.DEEP_RESEARCH_V2_ENABLED ?? "true").toLowerCase() === "true";
}

export function searchPipelineVersion(): string {
  return process.env.SEARCH_PIPELINE_VERSION || (deepResearchV2Enabled() ? "v2" : "v1");
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
