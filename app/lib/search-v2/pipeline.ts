/**
 * pipeline.ts — The orchestrator, and the only place the stages are joined.
 *
 *   plan → embed → 5 batched RPCs → fuse → dedupe → rerank →
 *   select → re-fetch → article plan → render
 *
 * ONE ROAD. Every question that reaches this function is planned, fanned out,
 * fused, reranked, selected, re-fetched and rendered by the same code with the
 * same budgets. There is no classifier deciding that this question deserves six
 * angles and that one deserves two, no mode deciding that this reader gets four
 * passages and that one gets eight, and no shortcut that skips the reranker
 * because a question looked like a bare reference. Those switches are why the
 * same question could produce four different answers and nobody could say which
 * path had produced the one in front of them.
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
import { searchPipelineVersion, searchCorpusVersion } from "@/app/lib/search-v2/config";
import { sha256, normalizeQuestion } from "@/app/lib/search-v2/cache";
import type { DegradedStage } from "@/app/lib/search-v2/rpc";

/**
 * The budgets, as plain fixed values. These are the numbers the wider of the two
 * retired modes carried; they are held here, at the one place that spends them,
 * rather than in a table keyed by something that no longer exists.
 *
 * They are provisional. Deciding how many passages a devotee should actually be
 * shown is the next piece of work, and it will replace these outright.
 */
const MAX_SUBQUERIES = 6;
const MAX_CANDIDATES_BEFORE_RERANK = 120;
const MAX_FINAL_PASSAGES = 8;

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
  /**
   * The planner's own description of the question. Recorded so a bad result can
   * be diagnosed; it selects nothing and changes no budget.
   */
  plannedIntent: string;
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
  requestId: string;
  onStage?: OnPipelineStage;
}

export async function runSearchV2(input: PipelineInput): Promise<PipelineOutput> {
  const { db, query, requestId, onStage } = input;
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
  const planned = await time("planning", () => planQuery(query, MAX_SUBQUERIES));
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
  // Fusion and dedup are pure and fast, but they are also where a bad ranking
  // is created, so they get their own timing rather than disappearing into the
  // gap between stages.
  const fuseStart = Date.now();
  const fused = fuseWeighted(retrieved.groups, priorities);
  const deduped = dedupeCandidates(fused);
  durations.fusing = Date.now() - fuseStart;

  // ── rerank ──
  onStage?.("reranking");
  const rerank = await time("reranking", () =>
    rerankUnified({
      question: query, // the ORIGINAL question, never the canonicalisation
      candidates: deduped.candidates,
      maxCandidates: MAX_CANDIDATES_BEFORE_RERANK,
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
    approvedQueryIds: approvedIds,
    maxFinalPassages: MAX_FINAL_PASSAGES,
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
  const article = await time("organizing", async () => {
    const plan = await planArticle(query, refetched.verified, MAX_FINAL_PASSAGES);
    if (plan.plan === null && plan.rejections.length > 0) {
      degraded.record("organizing", "gemini_article_planner", { code: "plan_rejected" });
    }
    return renderArticle({ question: query, passages: refetched.verified, plan: plan.plan });
  });

  const degradedStages = degraded.list();
  onStage?.(degradedStages.length > 0 ? "degraded" : "complete");

  const telemetry: SearchTelemetry = {
    requestId,
    plannedIntent: planned.plan.intent,
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
  };

  console.info(JSON.stringify({ level: "info", event: "search.complete", ...telemetry }));

  return {
    article,
    telemetry,
    uncoveredQueryIds: selection.uncoveredQueryIds,
    evidenceInsufficient: article.evidenceInsufficient || selection.evidenceInsufficient,
  };
}
