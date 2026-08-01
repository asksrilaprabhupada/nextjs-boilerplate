/**
 * pipeline.ts — The orchestrator, and the only place the stages are joined.
 *
 *   plan → embed → 5 batched RPCs (+ pinned exact-reference lookup) →
 *   junk floor → fuse → dedupe → pre-filter → rerank → tier →
 *   re-fetch (main tier) → article plan → render
 *
 * ONE ROAD. Every question that reaches this function is planned, fanned out,
 * fused, reranked, tiered, re-fetched and rendered by the same code with the
 * same budgets. There is no classifier deciding that this question deserves six
 * angles and that one deserves two, no mode deciding that this reader gets four
 * passages and that one gets eight, and no shortcut that skips the reranker
 * because a question looked like a bare reference. Those switches are why the
 * same question could produce four different answers and nobody could say which
 * path had produced the one in front of them.
 *
 * THE CASCADE IS A SPENDING PLAN, NOT A FILTER. Retrieval is wide; the junk
 * floor and the pre-filter decide who earns the expensive cross-encoder
 * reading; the tier cut decides who is rendered in full. Every passage that
 * survives retrieval reaches the response — in `passages` with its verified
 * words, or in `additional` as a citation with a sentence-safe snippet.
 * Nothing is silently dropped from what a devotee can see.
 *
 * Every degradation is recorded and surfaced in the response. The two rules
 * that govern the failure paths:
 *
 *   - If every requested retrieval source fails, SearchInfrastructureError
 *     propagates as HTTP 503. If at least one source succeeds, successful
 *     evidence continues with an explicit incomplete-answer warning; failure
 *     can never become a silent empty source.
 *   - Everything else degrades and says so: no planner, no embeddings, no
 *     reranker, no exact-reference lookup and no article planner each produce a
 *     worse but honest answer.
 *
 * Telemetry carries a hash of the question, never the question itself, plus the
 * counts that let a bad result be diagnosed without re-running it.
 */
import { planQuery } from "@/app/lib/search-v2/query-plan";
import {
  retrieveCandidates,
  ORIGINAL_QUERY_ID,
  type RetrievalSourceTelemetry,
} from "@/app/lib/search-v2/retrieval";
import type { FriendlyRetrievalSource } from "@/app/lib/types/01-search";
import {
  fuseWeighted,
  buildPriorityMap,
  applyJunkFloor,
  type FusedCandidate,
  type RetrievedCandidate,
} from "@/app/lib/search-v2/fusion";
import { dedupeCandidates } from "@/app/lib/search-v2/dedup";
import { prefilterCandidates } from "@/app/lib/search-v2/prefilter";
import { rerankUnified, type RankedCandidate } from "@/app/lib/search-v2/rerank";
import { selectEvidence } from "@/app/lib/search-v2/select";
import { refetchAndVerify, type VerifiedPassage } from "@/app/lib/search-v2/refetch";
import { planArticle } from "@/app/lib/search-v2/article-plan";
import { renderArticle, type RenderedArticle } from "@/app/lib/search-v2/render";
import { DegradationLog, rpcOrDegrade, type RpcCapableClient } from "@/app/lib/search-v2/rpc";
import { searchPipelineVersion, searchCorpusVersion } from "@/app/lib/search-v2/config";
import { formatVerseReference } from "@/app/lib/search-v2/citation";
import { makeSnippet } from "@/app/lib/search-v2/snippet";
import { sha256, normalizeQuestion } from "@/app/lib/search-v2/cache";
import { extractQueryTerms } from "@/app/lib/10-passage-fold";
import type { DegradedStage } from "@/app/lib/search-v2/rpc";

/**
 * Six angles is the design of the query plan, not a limit on the answer: each
 * approved angle serves a different retrieval purpose, and past six they stop
 * being different purposes.
 */
const MAX_SUBQUERIES = 6;

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

/** Live counts for the waiting screen — how much has been found so far. */
export interface PipelineStageInfo {
  /** Candidates retrieved from the library (pre-dedup). */
  found?: number;
  /** Passages that cleared selection and are being woven. */
  kept?: number;
}

export type OnPipelineStage = (stage: PipelineStage, info?: PipelineStageInfo) => void;

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
  tableRpcAttemptCount: number;
  vocabularyRpcCount: number;
  refetchCount: number;
  embeddingProviderCalls: number;
  candidatesBeforeFusion: number;
  candidatesAfterFusion: number;
  duplicatesCollapsed: number;
  junkFloorDropped: number;
  prefilterPassed: number;
  prefilterSetAside: number;
  rerankDocumentCount: number;
  reranked: boolean;
  selectedPassageCount: number;
  mainTierCount: number;
  additionalCount: number;
  cutIndex: number;
  cutGap: number;
  pinnedExactReference: boolean;
  droppedOnRefetch: number;
  degraded: boolean;
  degradedStages: DegradedStage[];
  /** Detailed server-only evidence for each actual retrieval RPC invocation. */
  sourceRetrieval: RetrievalSourceTelemetry[];
  /** Allowlisted source labels safe to map onto the public response. */
  degradedSources: FriendlyRetrievalSource[];
  stageDurationsMs: Record<string, number>;
  totalDurationMs: number;
  models: { queryPlanner: string | null; reranker: string; articlePlanner: string | null };
  errorCategory: string | null;
}

/**
 * One second-tier passage: citation, who-and-when, and a sentence-safe snippet
 * — built from RETRIEVAL data only. Deliberately not re-fetched: verification
 * exists so that displayed teaching text is provably the source text, and a
 * citation line that shows no body text has nothing to verify. That is what
 * takes the verify step from ~1,000 rows back to ~20.
 */
export interface AdditionalPassage {
  passageKey: string;
  sourceType: string;
  reference: string | null;
  speaker: string | null;
  recipient: string | null;
  occurredOn: string | null;
  location: string | null;
  rerankScore: number | null;
  /** Never cut mid-sentence — see snippet.ts for the rule and its reason. */
  snippet: string;
}

export interface PipelineOutput {
  article: RenderedArticle;
  /**
   * The verified MAIN-TIER passages, in selection order (the reranker's
   * order). This is what the article is built from — the full words,
   * never just names for the page to look up.
   */
  passages: VerifiedPassage[];
  /**
   * Every other passage that survived retrieval, as citations. The response
   * carries all of them; the page shows them collapsed. Nothing is dropped.
   */
  additional: AdditionalPassage[];
  telemetry: SearchTelemetry;
  uncoveredQueryIds: string[];
  evidenceInsufficient: boolean;
}

export interface PipelineInput {
  db: RpcCapableClient;
  query: string;
  requestId: string;
  onStage?: OnPipelineStage;
  /** "Śrīla Prabhupāda's words only" — a transcripts-RPC constraint. */
  speakerOnly?: boolean;
}

/** Row shape of public.direct_verse_lookup — the exact-reference short-circuit. */
interface DirectVerseRow {
  id: string;
  scripture: string | null;
  verse_number: string | null;
  translation: string | null;
  vedabase_url: string | null;
  chapter_number: number | null;
  canto_or_division: string | null;
}

/**
 * Turns a direct_verse_lookup row into a pinned candidate the rest of the
 * cascade carries through untouched. `retrieval_text` is the stored translation
 * verbatim, so the main-tier re-fetch verifies it like any other passage.
 */
function pinnedCandidateFrom(row: DirectVerseRow): RetrievedCandidate {
  return {
    passage_key: `verse:${row.id}`,
    source_type: "verse",
    row_id: row.id,
    retrieval_text: row.translation ?? "",
    reference: formatVerseReference({
      scripture: row.scripture,
      division: row.canto_or_division,
      chapterNumber: row.chapter_number,
      verseNumber: row.verse_number,
      vedabaseUrl: row.vedabase_url,
    }),
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: [ORIGINAL_QUERY_ID],
    channel_ranks: [],
    channel_scores: null,
    tag_matches: null,
    pinned: true,
  };
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

  // ── retrieve, with the exact-reference lookup riding alongside ──
  // When the devotee wrote a reference ("BG 18.66"), the verse itself is
  // fetched directly and PINNED: first in the main tier, immune to every cut.
  // The lookup degrades rather than throws — a failed pin must not kill the
  // search that would have found the verse anyway.
  onStage?.("retrieving");
  const [retrieved, directRows] = await time("retrieving", () =>
    Promise.all([
      retrieveCandidates({
        db,
        original: query,
        plan: planned.plan,
        requestId,
        degraded,
        speakerOnly: input.speakerOnly,
      }),
      planned.plan.exact_reference
        ? rpcOrDegrade<DirectVerseRow[] | null>(
            db,
            "direct_verse_lookup",
            { ref_query: planned.plan.exact_reference },
            { stage: "retrieval:direct_verse_lookup", requestId },
            [],
            degraded,
          )
        : Promise.resolve<DirectVerseRow[] | null>([]),
    ]),
  );
  if (!retrieved.semanticAvailable) {
    degraded.record("retrieving", "voyage", { code: "embeddings_unavailable" });
  }
  const directRow = (directRows ?? []).find((r) => r?.id && (r.translation ?? "").trim());
  const pinnedCandidate = directRow ? pinnedCandidateFrom(directRow) : null;

  // ── junk floor → fuse → dedupe → pre-filter ──
  onStage?.("fusing", { found: retrieved.candidateCount });
  const priorities = buildPriorityMap(
    ORIGINAL_QUERY_ID,
    planned.plan.subqueries.map((s) => ({ id: s.id, priority: s.priority })),
  );
  // Fusion, dedup and the pre-filter are pure and fast, but they are also where
  // a bad ranking is created, so they get their own timing rather than
  // disappearing into the gap between stages.
  const fuseStart = Date.now();
  const floored = applyJunkFloor(retrieved.groups);
  if (floored.dropped > 0) {
    console.info(
      JSON.stringify({ level: "info", event: "search.junk_floor", requestId, dropped: floored.dropped }),
    );
  }
  const fused = fuseWeighted(floored.groups, priorities);
  if (pinnedCandidate) {
    // Pin the fused entry when retrieval also found the verse; otherwise the
    // lookup row joins the pool itself, carrying no fusion score and needing
    // none — pinned candidates skip every cut.
    const existing = fused.find((c) => c.passage_key === pinnedCandidate.passage_key);
    if (existing) {
      existing.pinned = true;
    } else {
      fused.push({
        ...pinnedCandidate,
        fusedScore: 0,
        contributions: [],
        queryCoverage: [ORIGINAL_QUERY_ID],
      } as FusedCandidate);
    }
  }
  const deduped = dedupeCandidates(fused);
  const prefiltered = prefilterCandidates(deduped.candidates);
  durations.fusing = Date.now() - fuseStart;
  console.info(
    JSON.stringify({
      level: "info",
      event: "search.prefilter",
      requestId,
      before: prefiltered.stats.before,
      after: prefiltered.stats.after,
      setAside: prefiltered.stats.setAside,
      perSource: prefiltered.stats.perSource,
    }),
  );

  // ── rerank: the pre-filtered pool judged against the original question ──
  onStage?.("reranking", { found: deduped.candidates.length });
  const rerank = await time("reranking", () =>
    rerankUnified({
      question: query, // the ORIGINAL question, never the canonicalisation
      candidates: prefiltered.passed,
    }),
  );
  if (rerank.degradedReason) {
    degraded.record("reranking", "cohere", { code: rerank.degradedReason });
  }

  // ── tier: main rendered in full, everything else kept as citations ──
  onStage?.("selecting", { found: deduped.candidates.length });
  const approvedIds = [ORIGINAL_QUERY_ID, ...planned.plan.subqueries.map((s) => s.id)];
  const selection = selectEvidence({
    ranked: rerank.ranked,
    approvedQueryIds: approvedIds,
    rerankAvailable: rerank.reranked,
    requestId,
  });

  // The second tier: rerank-judged passages below the cut first, then the
  // pre-filter's set-asides in fused order. Snippets aim at the question's own
  // terms and never end mid-sentence.
  const queryTerms = extractQueryTerms(query);
  const toAdditional = (c: RankedCandidate | FusedCandidate): AdditionalPassage => ({
    passageKey: c.passage_key,
    sourceType: c.source_type,
    reference: c.reference,
    speaker: c.speaker,
    recipient: c.recipient,
    occurredOn: c.occurred_on,
    location: c.location,
    rerankScore: "rerankScore" in c ? (c as RankedCandidate).rerankScore : null,
    snippet: makeSnippet(c.retrieval_text, 220, queryTerms),
  });
  const additional: AdditionalPassage[] = [
    ...selection.additional.map(toAdditional),
    ...prefiltered.setAside.map(toAdditional),
  ];

  // ── verify: the hard stop — for everything shown in full ──
  // Only the main tier is re-fetched. Verification exists so displayed teaching
  // text is provably the source text; a citation line shows no body text, so
  // there is nothing to verify and no reason to re-read ~1,000 rows for it.
  const refetched = await time("verifying", () =>
    refetchAndVerify(db as never, selection.selected, { requestId }),
  );
  if (refetched.dropped.length > 0) {
    degraded.record("verifying", "refetch", { code: `dropped_${refetched.dropped.length}` });
  }

  // ── organise ──
  // The planner contributes arrangement only, and receives ONLY the main tier
  // (≤ MAIN_TIER_MAX + pins, comfortably inside its schema's capacity). When it
  // fails, the deterministic renderer orders the passages — and in both cases
  // every verified passage is shown: the renderer appends whatever a plan
  // leaves unplaced.
  onStage?.("organizing", { kept: refetched.verified.length });
  const article = await time("organizing", async () => {
    const plan = await planArticle(query, refetched.verified); // main tier only, ≤ 20 + pins
    if (plan.plan === null && plan.rejections.length > 0) {
      degraded.record("organizing", "gemini_article_planner", { code: "plan_rejected" });
    }
    return renderArticle({ question: query, passages: refetched.verified, plan: plan.plan });
  });

  const degradedStages = degraded.list();
  const responseDegraded = degradedStages.length > 0 || retrieved.degradedSources.length > 0;
  onStage?.(responseDegraded ? "degraded" : "complete");

  const mainTierCount = refetched.verified.length;
  const telemetry: SearchTelemetry = {
    requestId,
    plannedIntent: planned.plan.intent,
    questionHash: sha256(normalizeQuestion(query)),
    pipelineVersion: searchPipelineVersion(),
    corpusVersion: searchCorpusVersion(),
    subqueryCount: planned.plan.subqueries.length,
    planSource: planned.source,
    tableRpcCount: retrieved.tableRpcCount,
    tableRpcAttemptCount: retrieved.tableRpcAttemptCount,
    vocabularyRpcCount: retrieved.vocabularyRpcCount,
    refetchCount: refetched.fetchCount,
    embeddingProviderCalls: retrieved.embeddingProviderCalls,
    candidatesBeforeFusion: retrieved.candidateCount,
    candidatesAfterFusion: fused.length,
    duplicatesCollapsed: deduped.stats.exactCollapsed + deduped.stats.containedCollapsed,
    junkFloorDropped: floored.dropped,
    prefilterPassed: prefiltered.stats.after,
    prefilterSetAside: prefiltered.stats.setAside,
    rerankDocumentCount: rerank.documentCount,
    reranked: rerank.reranked,
    selectedPassageCount: article.sections.reduce((n, s) => n + s.blocks.length, 0),
    mainTierCount,
    additionalCount: additional.length,
    cutIndex: selection.cutIndex,
    cutGap: Math.round(selection.cutGap * 1000) / 1000,
    pinnedExactReference: Boolean(pinnedCandidate),
    droppedOnRefetch: refetched.dropped.length,
    degraded: responseDegraded,
    degradedStages,
    sourceRetrieval: retrieved.sourceRetrieval,
    degradedSources: retrieved.degradedSources,
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
    passages: refetched.verified,
    additional,
    telemetry,
    uncoveredQueryIds: selection.uncoveredQueryIds,
    evidenceInsufficient: article.evidenceInsufficient || selection.evidenceInsufficient,
  };
}
