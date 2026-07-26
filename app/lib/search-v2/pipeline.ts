/**
 * pipeline.ts — The V2 orchestrator, and the only place the stages are joined.
 *
 *   route → plan → embed → 5 batched RPCs → fuse → dedupe → rerank →
 *   select → re-fetch → article plan → render
 *
 * Every degradation is recorded and surfaced in the response. The two rules
 * that govern the failure paths:
 *
 *   - A retrieval RPC failing is fatal. It propagates as
 *     SearchInfrastructureError → HTTP 503. It never becomes "no teachings
 *     found", because a devotee cannot tell those apart and the second is a lie.
 *   - Everything else degrades and says so: no planner, no embeddings, no
 *     reranker and no article planner each produce a worse but honest answer.
 *
 * Telemetry carries a hash of the question, never the question itself, plus the
 * counts that let a bad result be diagnosed without re-running it.
 */
import { routeQuery } from "@/app/lib/search-v2/intent";
import { planQuery } from "@/app/lib/search-v2/query-plan";
import { retrieveCandidates, ORIGINAL_QUERY_ID } from "@/app/lib/search-v2/retrieval";
import { fuseWeighted, buildPriorityMap } from "@/app/lib/search-v2/fusion";
import { dedupeCandidates } from "@/app/lib/search-v2/dedup";
import { rerankUnified } from "@/app/lib/search-v2/rerank";
import { selectEvidence } from "@/app/lib/search-v2/select";
import { refetchAndVerify } from "@/app/lib/search-v2/refetch";
import { planArticle } from "@/app/lib/search-v2/article-plan";
import { renderArticle, type RenderedArticle } from "@/app/lib/search-v2/render";
import { DegradationLog, type RpcCapableClient } from "@/app/lib/search-v2/rpc";
import { MODE_BUDGETS, searchPipelineVersion, searchCorpusVersion, type SearchMode } from "@/app/lib/search-v2/config";
import { sha256, normalizeQuestion } from "@/app/lib/search-v2/cache";
import type { DegradedStage } from "@/app/lib/search-v2/rpc";

export type PipelineStage =
  | "planning"
  | "retrieving"
  | "fusing"
  | "reranking"
  | "selecting"
  | "organizing"
  | "complete"
  | "degraded"
  | "error";

export type OnPipelineStage = (stage: PipelineStage) => void;

/** Per-request diagnostics. No secrets, no raw question. */
export interface SearchTelemetry {
  requestId: string;
  mode: SearchMode;
  intent: string;
  questionHash: string;
  pipelineVersion: string;
  corpusVersion: string;
  subqueryCount: number;
  planSource: string;
  tableRpcCount: number;
  vocabularyRpcCount: number;
  refetchCount: number;
  embeddingProviderCalls: number;
  candidatesBeforeFusion: number;
  candidatesAfterFusion: number;
  duplicatesCollapsed: number;
  rerankDocumentCount: number;
  reranked: boolean;
  selectedPassageCount: number;
  droppedOnRefetch: number;
  degraded: boolean;
  degradedStages: DegradedStage[];
  stageDurationsMs: Record<string, number>;
  totalDurationMs: number;
  models: { queryPlanner: string | null; reranker: string; articlePlanner: string | null };
  errorCategory: string | null;
  flagCohort: string;
}

export interface PipelineOutput {
  article: RenderedArticle;
  telemetry: SearchTelemetry;
  uncoveredQueryIds: string[];
  evidenceInsufficient: boolean;
}

export interface PipelineInput {
  db: RpcCapableClient;
  query: string;
  mode: SearchMode;
  requestId: string;
  onStage?: OnPipelineStage;
}

export async function runSearchV2(input: PipelineInput): Promise<PipelineOutput> {
  const { db, query, mode, requestId, onStage } = input;
  const budgets = MODE_BUDGETS[mode];
  const degraded = new DegradationLog(requestId);
  const durations: Record<string, number> = {};
  const started = Date.now();

  const time = async <T>(stage: string, fn: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      durations[stage] = Date.now() - t0;
    }
  };

  // ── plan ──
  onStage?.("planning");
  const routed = routeQuery(query);
  const routedForMode = { ...routed, maxSubqueries: Math.min(routed.maxSubqueries, budgets.maxSubqueries) };
  const planned = await time("planning", () => planQuery(query, routedForMode));
  if (planned.source === "fallback_original_only" && planned.rejections.length > 0) {
    degraded.record("planning", "gemini_query_planner", { code: "plan_rejected" });
  }

  // ── retrieve ──
  onStage?.("retrieving");
  const retrieved = await time("retrieving", () =>
    retrieveCandidates({ db, original: query, plan: planned.plan, requestId, degraded }),
  );
  if (!retrieved.semanticAvailable) {
    degraded.record("retrieving", "voyage", { code: "embeddings_unavailable" });
  }

  // ── fuse ──
  onStage?.("fusing");
  const priorities = buildPriorityMap(
    ORIGINAL_QUERY_ID,
    planned.plan.subqueries.map((s) => ({ id: s.id, priority: s.priority })),
  );
  const fused = fuseWeighted(retrieved.groups, priorities);

  const deduped = dedupeCandidates(fused);
  durations.fusing = durations.fusing ?? 0;

  // ── rerank ──
  onStage?.("reranking");
  const rerank = await time("reranking", () =>
    rerankUnified({
      question: query, // the ORIGINAL question, never the canonicalisation
      candidates: deduped.candidates,
      maxCandidates: budgets.maxCandidatesBeforeRerank,
      bypass: routed.bypassRerank,
    }),
  );
  if (rerank.degradedReason) {
    degraded.record("reranking", "cohere", { code: rerank.degradedReason });
  }

  // ── select ──
  onStage?.("selecting");
  const approvedIds = [ORIGINAL_QUERY_ID, ...planned.plan.subqueries.map((s) => s.id)];
  const selection = selectEvidence({
    ranked: rerank.ranked,
    intent: routed.intent,
    approvedQueryIds: approvedIds,
    maxFinalPassages: budgets.maxFinalPassages,
  });

  // ── verify: the hard stop ──
  const refetched = await time("verifying", () =>
    refetchAndVerify(db as never, selection.selected, { requestId }),
  );
  if (refetched.dropped.length > 0) {
    degraded.record("verifying", "refetch", { code: `dropped_${refetched.dropped.length}` });
  }

  // ── organise ──
  onStage?.("organizing");
  // Quick Answer skips the article planner whenever the sources speak for
  // themselves: a devotee fifteen minutes before class does not need an AI to
  // arrange three passages.
  const skipPlanner = mode === "quick" && refetched.verified.length <= 3;
  const article = await time("organizing", async () => {
    const plan = skipPlanner
      ? { plan: null, source: "deterministic_fallback" as const, rejections: [] }
      : await planArticle(query, refetched.verified, budgets.maxFinalPassages);
    if (plan.plan === null && !skipPlanner && plan.rejections.length > 0) {
      degraded.record("organizing", "gemini_article_planner", { code: "plan_rejected" });
    }
    return renderArticle({ question: query, passages: refetched.verified, plan: plan.plan, mode });
  });

  const degradedStages = degraded.list();
  onStage?.(degradedStages.length > 0 ? "degraded" : "complete");

  const telemetry: SearchTelemetry = {
    requestId,
    mode,
    intent: routed.intent,
    questionHash: sha256(normalizeQuestion(query)),
    pipelineVersion: searchPipelineVersion(),
    corpusVersion: searchCorpusVersion(),
    subqueryCount: planned.plan.subqueries.length,
    planSource: planned.source,
    tableRpcCount: retrieved.tableRpcCount,
    vocabularyRpcCount: retrieved.vocabularyRpcCount,
    refetchCount: refetched.fetchCount,
    embeddingProviderCalls: retrieved.embeddingProviderCalls,
    candidatesBeforeFusion: retrieved.candidateCount,
    candidatesAfterFusion: fused.length,
    duplicatesCollapsed: deduped.stats.exactCollapsed + deduped.stats.nearCollapsed,
    rerankDocumentCount: rerank.documentCount,
    reranked: rerank.reranked,
    selectedPassageCount: article.sections.reduce((n, s) => n + s.blocks.length, 0),
    droppedOnRefetch: refetched.dropped.length,
    degraded: degradedStages.length > 0,
    degradedStages,
    stageDurationsMs: durations,
    totalDurationMs: Date.now() - started,
    models: {
      queryPlanner: planned.source === "fallback_original_only" ? null : "gemini",
      reranker: rerank.model,
      articlePlanner: article.planned ? "gemini" : null,
    },
    errorCategory: null,
    flagCohort: "v2",
  };

  console.info(JSON.stringify({ level: "info", event: "search.v2_complete", ...telemetry }));

  return {
    article,
    telemetry,
    uncoveredQueryIds: selection.uncoveredQueryIds,
    evidenceInsufficient: article.evidenceInsufficient || selection.evidenceInsufficient,
  };
}
