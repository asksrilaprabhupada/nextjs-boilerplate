/**
 * Durable, fail-open lifecycle telemetry for one search request.
 *
 * The database row is created before planning and finalised before JSON/SSE is
 * closed. Both writes have a short aborting deadline; a telemetry outage is
 * visible in server logs but can never change the search result.
 */
import { getSupabaseAdmin } from "@/app/lib/01-supabase";
import { VOYAGE_CONTEXT_MODEL } from "@/app/lib/03-embed";
import { fullSha256, normalizeQuestion } from "@/app/lib/search-v2/cache";
import {
  cohereRerankModel,
  geminiArticlePlannerModel,
  geminiQueryPlannerModel,
  searchConfigVersion,
  searchCorpusVersion,
  searchPipelineVersion,
} from "@/app/lib/search-v2/config";
import { isSearchError } from "@/app/lib/search-v2/errors";
import type { SearchTelemetry } from "@/app/lib/search-v2/pipeline";
import type { RetrievalSourceTelemetry } from "@/app/lib/search-v2/retrieval";

export type SearchRunStatus = "success" | "degraded" | "failed" | "abandoned";
export type SearchEnvironment = "preview" | "production";

const DEFAULT_WRITE_DEADLINE_MS = 2_000;

export interface SearchRunStartInput {
  requestId: string;
  questionHash: string;
  environment?: SearchEnvironment;
  deploymentSha?: string | null;
}

export interface SearchRunHandle {
  rowId: string;
  requestId: string;
  questionHash: string;
}

export interface SearchRunResultFields {
  totalResults: number;
  verseIds: string[];
  proseIds: string[];
  booksReturned: string[];
  queryVariants: string[];
}

export interface SearchRunCompletionInput {
  status: SearchRunStatus;
  /**
   * Raw capture is off by default. It may only be enabled by a future,
   * owner-authenticated diagnostic session; ordinary searches stay hash-only.
   */
  captureRaw?: boolean;
  query: string | null;
  visitorId?: string | null;
  userAgent?: string | null;
  referrer?: string | null;
  searchMethod: "pipeline" | "cache";
  totalDurationMs: number;
  result: SearchRunResultFields;
  failedStage?: string | null;
  errorCode?: string | null;
  stageDurationsMs: Record<string, number>;
  sourceDurationsMs: Record<string, number[]>;
  telemetry: Record<string, unknown>;
}

export interface SearchRunWriteAdapter {
  begin(input: Required<Omit<SearchRunStartInput, "deploymentSha">> & {
    deploymentSha: string | null;
  }, signal: AbortSignal): Promise<string>;
  complete(
    handle: SearchRunHandle,
    input: SearchRunCompletionInput,
    signal: AbortSignal,
  ): Promise<void>;
}

export interface SearchRunWriteOptions {
  adapter?: SearchRunWriteAdapter;
  deadlineMs?: number;
}

/** Full SHA-256 for durable telemetry; cache keys deliberately use a shorter prefix. */
export function telemetryQuestionHash(query: string): string {
  return fullSha256(normalizeQuestion(query));
}

class TelemetryWriteDeadlineError extends Error {
  constructor() {
    super("telemetry write deadline exceeded");
    this.name = "TelemetryWriteDeadlineError";
  }
}

function deploymentEnvironment(): SearchEnvironment {
  return process.env.VERCEL_ENV === "production" ? "production" : "preview";
}

function deploymentSha(): string | null {
  return process.env.VERCEL_GIT_COMMIT_SHA?.trim() || null;
}

function safeWriteErrorCode(err: unknown): string {
  if (err instanceof TelemetryWriteDeadlineError) return "deadline_exceeded";
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = String((err as { code?: unknown }).code ?? "");
    if (/^[A-Za-z0-9_-]{1,40}$/.test(code)) return code;
  }
  return "write_failed";
}

export function isExpectedSearchRunId(data: unknown, expected: string): data is string {
  return typeof data === "string" && data === expected;
}

async function withinDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new TelemetryWriteDeadlineError());
    }, deadlineMs);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const supabaseAdapter: SearchRunWriteAdapter = {
  async begin(input, signal) {
    const { data, error } = await getSupabaseAdmin()
      .rpc("begin_search_run", {
        p_request_id: input.requestId,
        p_question_hash: input.questionHash,
        p_environment: input.environment,
        p_deployment_sha: input.deploymentSha,
      })
      .abortSignal(signal);
    if (error) throw error;
    if (typeof data !== "string" || data.length === 0) {
      throw Object.assign(new Error("begin_search_run returned no id"), { code: "invalid_response" });
    }
    return data;
  },

  async complete(handle, input, signal) {
    const { data, error } = await getSupabaseAdmin()
      .rpc("complete_search_run", {
        p_request_id: handle.requestId,
        p_status: input.status,
        p_query: input.query,
        p_visitor_id: input.visitorId ?? null,
        p_total_results: input.result.totalResults,
        p_verse_ids: input.result.verseIds,
        p_prose_ids: input.result.proseIds,
        p_books_returned: input.result.booksReturned,
        p_search_method: input.searchMethod,
        p_total_duration_ms: Math.max(0, Math.round(input.totalDurationMs)),
        p_source: "web",
        p_user_agent: input.userAgent ?? null,
        p_referrer: input.referrer ?? null,
        p_query_variants: input.result.queryVariants,
        p_failed_stage: input.failedStage ?? null,
        p_error_code: input.errorCode ?? null,
        p_stage_durations_ms: input.stageDurationsMs,
        p_source_durations_ms: input.sourceDurationsMs,
        p_telemetry: input.telemetry,
        p_capture_raw: input.captureRaw === true,
      })
      .abortSignal(signal);
    if (error) throw error;
    if (!isExpectedSearchRunId(data, handle.rowId)) {
      throw Object.assign(new Error("complete_search_run returned an unexpected id"), {
        code: "invalid_response",
      });
    }
  },
};

export async function beginSearchRun(
  input: SearchRunStartInput,
  options: SearchRunWriteOptions = {},
): Promise<SearchRunHandle | null> {
  const adapter = options.adapter ?? supabaseAdapter;
  const deadlineMs = options.deadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
  const resolved = {
    requestId: input.requestId,
    questionHash: input.questionHash,
    environment: input.environment ?? deploymentEnvironment(),
    deploymentSha: input.deploymentSha === undefined ? deploymentSha() : input.deploymentSha,
  };

  try {
    const rowId = await withinDeadline((signal) => adapter.begin(resolved, signal), deadlineMs);
    return { rowId, requestId: input.requestId, questionHash: input.questionHash };
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "search.telemetry_begin_failed",
      requestId: input.requestId,
      code: safeWriteErrorCode(err),
    }));
    return null;
  }
}

export async function completeSearchRun(
  handle: SearchRunHandle | null,
  input: SearchRunCompletionInput,
  options: SearchRunWriteOptions = {},
): Promise<boolean> {
  if (!handle) return false;
  const adapter = options.adapter ?? supabaseAdapter;
  const deadlineMs = options.deadlineMs ?? DEFAULT_WRITE_DEADLINE_MS;
  // Privacy is enforced at the shared write boundary, not at each route call.
  // A future diagnostic path must opt in only after authenticating the owner.
  const minimizedInput: SearchRunCompletionInput = input.captureRaw === true
    ? input
    : {
        ...input,
        captureRaw: false,
        query: null,
        visitorId: null,
        userAgent: null,
        referrer: null,
        result: { ...input.result, queryVariants: [] },
      };

  try {
    await withinDeadline((signal) => adapter.complete(handle, minimizedInput, signal), deadlineMs);
    return true;
  } catch (err) {
    console.warn(JSON.stringify({
      level: "warn",
      event: "search.telemetry_complete_failed",
      requestId: handle.requestId,
      code: safeWriteErrorCode(err),
    }));
    return false;
  }
}

/** Existing successful-search fields, without passage text. */
export function resultFieldsForTelemetry(
  result: Record<string, unknown>,
  internalPassages: readonly {
    passageKey: string;
    sourceType: string;
    reference: string | null;
  }[] = [],
): SearchRunResultFields {
  const passages = Array.isArray(result.passages)
    ? result.passages.filter((item): item is Record<string, unknown> => (
        typeof item === "object" && item !== null
      ))
    : [];
  const rowId = (namespaced: unknown): string | null => {
    if (typeof namespaced !== "string" || namespaced.length === 0) return null;
    const separator = namespaced.indexOf(":");
    return separator >= 0 ? namespaced.slice(separator + 1) : namespaced;
  };
  const books = passages
    .map((passage) => (
      passage.type === "lecture"
        ? "Lectures"
        : passage.type === "letter"
          ? "Letters"
          : typeof passage.reference === "string"
            ? passage.reference.split(/[\s.]/)[0]
            : ""
    ))
    .filter((value): value is string => Boolean(value));
  // Database identifiers stay server-side. They are taken from the verified
  // pipeline passages, never copied into the browser response merely so the
  // telemetry writer can recover them later.
  const verseIds = internalPassages
    .filter((passage) => passage.sourceType === "verse")
    .map((passage) => rowId(passage.passageKey))
    .filter((value): value is string => Boolean(value));
  const proseIds = internalPassages
    .filter((passage) => passage.sourceType === "book")
    .map((passage) => rowId(passage.passageKey))
    .filter((value): value is string => Boolean(value));

  return {
    totalResults: Math.max(0, Number(result.totalResults) || 0),
    verseIds,
    proseIds,
    booksReturned: [...new Set(books)],
    // Ordinary lifecycle telemetry never stores generated query variants. A
    // future owner-controlled snapshot path can capture them separately.
    queryVariants: [],
  };
}

export function sourceDurationsForTelemetry(
  sources: readonly Pick<RetrievalSourceTelemetry, "internalFunction" | "durationMs">[],
): Record<string, number[]> {
  const durations: Record<string, number[]> = {};
  for (const source of sources) {
    (durations[source.internalFunction] ??= []).push(source.durationMs);
  }
  return durations;
}

/**
 * Strict technical allowlist. Passing a larger SearchTelemetry object here can
 * never persist its request id, planned intent, raw question, or future fields.
 */
export function allowlistedTechnicalTelemetry(
  telemetry: SearchTelemetry,
  cache: "hit" | "miss",
  questionHash: string,
): Record<string, unknown> {
  return {
    questionHash,
    cache,
    plan: {
      source: telemetry.planSource,
      subqueryCount: telemetry.subqueryCount,
    },
    providers: {
      queryPlanner: {
        model: geminiQueryPlannerModel(),
        outcome: telemetry.models.queryPlanner !== null ? "accepted" : "fallback",
      },
      embeddings: {
        model: VOYAGE_CONTEXT_MODEL,
        providerCalls: telemetry.embeddingProviderCalls,
        outcome: telemetry.degradedStages.some((item) => item.code === "embeddings_unavailable")
          ? "unavailable"
          : telemetry.embeddingProviderCalls > 0
            ? "used"
            : "not_called",
      },
      reranker: {
        model: cohereRerankModel(),
        outcome: telemetry.reranked
          ? "used"
          : telemetry.degradedStages.some((item) => item.stage === "reranking")
            ? "unavailable"
            : "not_called",
      },
      articlePlanner: {
        model: geminiArticlePlannerModel(),
        outcome: telemetry.models.articlePlanner !== null ? "accepted" : "fallback",
      },
    },
    rpcCounts: {
      table: telemetry.tableRpcCount,
      tableAttempts: telemetry.tableRpcAttemptCount,
      vocabulary: telemetry.vocabularyRpcCount,
      refetch: telemetry.refetchCount,
    },
    candidates: {
      beforeFusion: telemetry.candidatesBeforeFusion,
      afterFusion: telemetry.candidatesAfterFusion,
      duplicatesCollapsed: telemetry.duplicatesCollapsed,
      junkFloorDropped: telemetry.junkFloorDropped,
      prefilterPassed: telemetry.prefilterPassed,
      prefilterSetAside: telemetry.prefilterSetAside,
      rerankDocuments: telemetry.rerankDocumentCount,
      selectedPassages: telemetry.selectedPassageCount,
      mainTier: telemetry.mainTierCount,
      additional: telemetry.additionalCount,
      droppedOnRefetch: telemetry.droppedOnRefetch,
    },
    selection: {
      cutIndex: telemetry.cutIndex,
      cutGap: telemetry.cutGap,
      pinnedExactReference: telemetry.pinnedExactReference,
    },
    speakerFilter: {
      mode: telemetry.speakerFilter.mode,
      rawTranscriptRows: telemetry.speakerFilter.rawTranscriptRows,
      retainedTranscriptRows: telemetry.speakerFilter.retainedTranscriptRows,
      droppedTranscriptRows: telemetry.speakerFilter.droppedTranscriptRows,
      keptSegments: telemetry.speakerFilter.keptSegments,
      guestSegmentsRemoved: telemetry.speakerFilter.guestSegmentsRemoved,
      unknownSegmentsRemoved: telemetry.speakerFilter.unknownSegmentsRemoved,
      additionalTranscriptRowsVerified: telemetry.speakerFilter.additionalTranscriptRowsVerified,
      additionalTranscriptRowsDropped: telemetry.speakerFilter.additionalTranscriptRowsDropped,
    },
    sources: telemetry.sourceRetrieval.map((source) => ({
      internalFunction: source.internalFunction,
      operation: source.operation,
      success: source.success,
      code: source.code,
      candidateCount: source.candidateCount,
      rawCandidateCount: source.rawCandidateCount ?? source.candidateCount,
      outerLimit: source.outerLimit,
      semanticLimit: source.semanticLimit,
      attemptCount: source.attemptCount,
    })),
    degradation: telemetry.degradedStages.map((item) => ({
      stage: item.stage,
      source: item.source,
      code: item.code,
    })),
    versions: {
      pipeline: telemetry.pipelineVersion,
      corpus: telemetry.corpusVersion,
      config: searchConfigVersion(),
    },
  };
}

export function cacheHitTechnicalTelemetry(
  questionHash: string,
  speakerFilterMode: "all" | "prabhupada_segments" = "all",
): Record<string, unknown> {
  return {
    questionHash,
    cache: "hit",
    providers: {},
    rpcCounts: { table: 0, tableAttempts: 0, vocabulary: 0, refetch: 0 },
    candidates: {},
    selection: {},
    speakerFilter: { mode: speakerFilterMode },
    sources: [],
    degradation: [],
    versions: {
      pipeline: searchPipelineVersion(),
      corpus: searchCorpusVersion(),
      config: searchConfigVersion(),
    },
  };
}

export function failureTechnicalTelemetry(
  questionHash: string,
  err: unknown,
  speakerFilterMode: "all" | "prabhupada_segments" = "all",
): {
  failedStage: string;
  errorCode: string;
  sourceDurationsMs: Record<string, number[]>;
  telemetry: Record<string, unknown>;
} {
  if (!isSearchError(err)) {
    return {
      failedStage: "pipeline",
      errorCode: "internal_error",
      sourceDurationsMs: {},
      telemetry: {
        questionHash,
        cache: "miss",
        providers: {},
        speakerFilter: { mode: speakerFilterMode },
        sources: [],
        degradation: [{ stage: "pipeline", code: "internal_error" }],
        versions: {
          pipeline: searchPipelineVersion(),
          corpus: searchCorpusVersion(),
          config: searchConfigVersion(),
        },
      },
    };
  }

  const sourceDurationsMs: Record<string, number[]> = {};
  const sources = err.sourceFailures.map((source) => {
    (sourceDurationsMs[source.source] ??= []).push(source.durationMs);
    return {
      internalFunction: source.source,
      stage: source.stage,
      success: false,
      code: source.databaseCode ?? source.transportCode ?? source.internalCode ?? "unknown",
      attemptCount: source.attemptCount,
    };
  });

  return {
    failedStage: err.stage ?? "pipeline",
    errorCode: err.code,
    sourceDurationsMs,
    telemetry: {
      questionHash,
      cache: "miss",
      providers: {},
      speakerFilter: { mode: speakerFilterMode },
      sources,
      degradation: [{ stage: err.stage ?? "pipeline", code: err.code }],
      versions: {
        pipeline: searchPipelineVersion(),
        corpus: searchCorpusVersion(),
        config: searchConfigVersion(),
      },
    },
  };
}

export const EMPTY_RESULT_FIELDS: SearchRunResultFields = {
  totalResults: 0,
  verseIds: [],
  proseIds: [],
  booksReturned: [],
  queryVariants: [],
};
