/**
 * route.ts — Search API Route
 *
 * ONE ENGINE, ONE ROAD. This file used to be ~3,200 lines, almost all of it a
 * second, older search engine that ran when a flag said so, plus a `mode=`
 * parameter that split the newer engine into two more paths. Four roads, one
 * question, and no way to tell from an answer which road had produced it. Every
 * one of them is gone. What is left is the request boundary and nothing else:
 * validate, read the cache, call the pipeline, log, respond.
 *
 * Two response shapes, one pipeline behind both:
 *   GET /api/search?q=…            → single JSON response
 *   GET /api/search?q=…&stream=1   → SSE: `stage` events as the pipeline
 *                                    advances, then `result` with the exact same
 *                                    JSON payload, then `done`.
 *
 * A `mode=` parameter is ignored, silently. Old links and bookmarks carrying one
 * still work; they simply get the answer, because there is only one answer to
 * get.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";
import type { SearchStageKey } from "@/app/lib/types/01-search";
import type { RpcCapableClient } from "@/app/lib/search-v2/rpc";
import {
  InvalidSearchInputError,
  isSearchError,
  newRequestId,
} from "@/app/lib/search-v2/errors";
import {
  runSearchV2,
  type PipelineStage,
  type PipelineStageInfo,
  type PipelineOutput,
  type SearchTelemetry,
} from "@/app/lib/search-v2/pipeline";
import { adaptToSearchResults } from "@/app/lib/search-v2/adapt";
import {
  cacheKeys,
  getCacheAdapter,
  TTL,
} from "@/app/lib/search-v2/cache";
import {
  allowlistedTechnicalTelemetry,
  beginSearchRun,
  cacheHitTechnicalTelemetry,
  completeSearchRun,
  EMPTY_RESULT_FIELDS,
  failureTechnicalTelemetry,
  resultFieldsForTelemetry,
  sourceDurationsForTelemetry,
  telemetryQuestionHash,
} from "@/app/lib/search-v2/search-run-telemetry";
import {
  markPreviewVerification,
  previewVerificationClient,
  readPreviewVerificationMode,
  type PreviewVerificationMode,
} from "@/app/lib/search-v2/preview-verification";

// With no candidate caps, a cold search embeds, runs five large RPCs, and
// reranks the whole pool in Cohere batches — minutes, not seconds, on a broad
// question. If the plan refuses this number, enable Fluid compute
// (Vercel → project → Settings → Functions); then it is allowed.
export const maxDuration = 300;

/**
 * Upper bound on `q`. Without one, a single unauthenticated request drives the
 * full paid fan-out (Gemini + Voyage + Cohere + RPCs) with an arbitrarily large
 * query.
 */
const MAX_QUERY_CHARS = 2000;

/**
 * The payload tripwire. Vercel caps a function response at 4.5 MB; with the
 * main tier capped and `additional` carrying one line per passage, a response
 * is ~60–120 KB and this can never fire. If it ever does, the additional array
 * is truncated, the response says so, and `search.payload_truncated` puts the
 * evidence in the logs — a log line instead of a blank page.
 */
const MAX_PAYLOAD_BYTES = 3 * 1024 * 1024;

function guardPayloadSize(
  result: Record<string, unknown>,
  requestId: string,
): Record<string, unknown> {
  if (JSON.stringify(result).length <= MAX_PAYLOAD_BYTES) return result;
  const additional = Array.isArray(result.additional) ? [...result.additional] : [];
  const originalCount = additional.length;
  const guarded: Record<string, unknown> = { ...result, additionalTruncated: true };
  // Halve until it fits. Counts (`additionalCount`, `totalResults`) keep their
  // honest values — the flag tells the page that the tail is missing.
  let keep = additional.length;
  do {
    keep = Math.floor(keep / 2);
    guarded.additional = additional.slice(0, keep);
  } while (keep > 0 && JSON.stringify(guarded).length > MAX_PAYLOAD_BYTES);
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "search.payload_truncated",
      requestId,
      originalAdditionalCount: originalCount,
      keptAdditionalCount: keep,
    }),
  );
  return guarded;
}

/** Pipeline progress hook — drives the SSE `stage` events. A stage may be
 *  reported more than once as live counts arrive; the loader shows the latest. */
type OnStage = (stage: SearchStageKey, labelOverride?: string, found?: number) => void;

const STAGE_META: Record<SearchStageKey, { pct: number; label: string }> = {
  understood: { pct: 12, label: "Reading your question…" },
  expanding: { pct: 22, label: "Exploring several angles of your question…" },
  searching: { pct: 45, label: "Searching 244,148 passages…" },
  reranking: { pct: 70, label: "Selecting his words…" },
  weaving: { pct: 90, label: "Weaving the essay…" },
};
const STAGE_ORDER: SearchStageKey[] = ["understood", "expanding", "searching", "reranking", "weaving"];

/**
 * Bridges the pipeline's stage vocabulary onto the SSE events the mandala loader
 * was built against. The pipeline names are the honest ones and are what
 * telemetry records; these are the wire names.
 *
 * Terminal states emit nothing — `complete` is signalled by the `result` and
 * `done` events, and a failure by the existing `failure` event.
 */
const STAGE_TO_WIRE: Partial<Record<PipelineStage, SearchStageKey>> = {
  planning: "understood",
  retrieving: "searching",
  fusing: "searching",
  reranking: "reranking",
  selecting: "reranking",
  organizing: "weaving",
};

/** Live labels: a two-minute search must read as work, so once the pipeline
 *  knows how many passages it is holding, the label says so. */
function liveLabel(stage: PipelineStage, info?: PipelineStageInfo): string | undefined {
  const n = (v: number) => v.toLocaleString("en-US");
  if (info?.found !== undefined) {
    if (stage === "fusing") return `Found ${n(info.found)} passages — weighing them…`;
    if (stage === "reranking") return `Weighing ${n(info.found)} passages against your question…`;
    if (stage === "selecting") return `Keeping every passage that answers — of ${n(info.found)} found…`;
  }
  if (info?.kept !== undefined && stage === "organizing") {
    return `Weaving ${n(info.kept)} passages…`;
  }
  return undefined;
}

function toWireStage(onStage: OnStage): (stage: PipelineStage, info?: PipelineStageInfo) => void {
  return (stage, info) => {
    const wire = STAGE_TO_WIRE[stage];
    if (wire) onStage(wire, liveLabel(stage, info), info?.found ?? info?.kept);
  };
}

// =====================================================
// RESPONSE CACHE
// =====================================================

/**
 * Shared-cache read. Never throws: a cache that is down or misconfigured must
 * cost latency, never a search. The per-request fields (searchLogId, requestId)
 * are deliberately absent from the stored value — each serving logs its own row
 * and carries its own correlation id.
 */
async function readCache(key: string): Promise<Record<string, unknown> | null> {
  try {
    const store = await getCacheAdapter();
    return await store.get<Record<string, unknown>>(key);
  } catch {
    return null;
  }
}

async function writeCache(key: string, value: Record<string, unknown>): Promise<void> {
  try {
    const store = await getCacheAdapter();
    const { searchLogId: _perRequest, requestId: _rid, ...cacheable } = value;
    void _perRequest;
    void _rid;
    await store.set(key, cacheable, TTL.response);
  } catch {
    // A failed cache write is not a failed search.
  }
}

type CacheAdmissionResult = Pick<PipelineOutput, "evidenceInsufficient"> & {
  telemetry: Pick<SearchTelemetry, "degraded" | "degradedSources">;
};

export function shouldCacheSearchResult(out: CacheAdmissionResult): boolean {
  return !out.telemetry.degraded
    && out.telemetry.degradedSources.length === 0
    && !out.evidenceInsufficient;
}

/** Production cache gate with an injected-writer seam for policy tests. */
export async function writeResponseCacheIfEligible(
  key: string,
  value: Record<string, unknown>,
  out: CacheAdmissionResult,
  writer: (cacheKey: string, cacheValue: Record<string, unknown>) => Promise<void> = writeCache,
): Promise<boolean> {
  if (!shouldCacheSearchResult(out)) return false;
  await writer(key, value);
  return true;
}

/**
 * Cache-aware pipeline entry — both handlers go through here.
 *
 * Two invariants: only a completed, non-degraded result is ever cached (an error
 * or an outage-weakened answer must never become a 24 h cached truth), and
 * correlation ids are attached AFTER the cache read so a cached body never
 * replays another request's id.
 *
 * Failures are caught only long enough to await the terminal telemetry update,
 * then rethrown unchanged. An all-source failure still reaches the handler and
 * becomes a 503; partial source failure stays explicit on the successful result.
 */
async function getOrComputeResult(
  query: string,
  requestId: string,
  onStage?: OnStage,
  speakerOnly = false,
  verificationMode: PreviewVerificationMode | null = null,
): Promise<{ result: Record<string, unknown>; fromCache: boolean }> {
  const now = (): number => globalThis.performance.now();
  const elapsed = (since: number): number =>
    Math.round(Math.max(0, now() - since) * 1000) / 1000;
  const questionHash = telemetryQuestionHash(query);
  const searchRun = await beginSearchRun({ requestId, questionHash });
  const workStartedAt = now();
  const partialStageDurationsMs: Record<string, number> = {};

  try {
    // Keyed on the EXACT normalised question plus corpus version (and the
    // speaker filter, which changes what retrieval may return). A semantically
    // close but different question is a different question and never reuses this
    // entry — answering one devotee's question with another's evidence is how
    // words get put in Śrīla Prabhupāda's mouth by accident.
    const key = cacheKeys.response(query, speakerOnly ? "sp-only" : undefined);
    const cacheStartedAt = now();
    // Controlled preview verification must exercise the pipeline, never replay
    // or populate an ordinary response-cache entry.
    const cached = verificationMode === null ? await readCache(key) : null;
    const cacheDurationMs = elapsed(cacheStartedAt);
    if (cached) {
      await completeSearchRun(searchRun, {
        status: "success",
        query,
        searchMethod: "cache",
        totalDurationMs: cacheDurationMs,
        result: resultFieldsForTelemetry(cached),
        stageDurationsMs: { cache: cacheDurationMs },
        sourceDurationsMs: {},
        telemetry: markPreviewVerification(
          cacheHitTechnicalTelemetry(questionHash),
          verificationMode,
        ),
      });
      onStage?.("weaving");
      return {
        result: { ...cached, searchLogId: searchRun?.rowId ?? null, requestId },
        fromCache: true,
      };
    }

    const baseDb = getSupabaseAdmin() as unknown as RpcCapableClient;
    const out = await runSearchV2({
      db: previewVerificationClient(baseDb, verificationMode),
      query,
      requestId,
      onStage: onStage ? toWireStage(onStage) : undefined,
      onStageDuration: (stage, durationMs) => {
        partialStageDurationsMs[stage] = durationMs;
      },
      speakerOnly,
    });
    const adapted = adaptToSearchResults(query, out) as unknown as Record<string, unknown>;

    // Only a clean, non-degraded answer is cached. A response produced while
    // Voyage or Cohere was down is correct but weaker, and caching it for 24
    // hours would outlive the outage that caused it.
    if (verificationMode === null) {
      await writeResponseCacheIfEligible(key, adapted, out);
    }

    const status = out.telemetry.degraded || out.telemetry.degradedSources.length > 0
      ? "degraded"
      : "success";
    await completeSearchRun(searchRun, {
      status,
      query,
      searchMethod: "pipeline",
      totalDurationMs: out.telemetry.totalDurationMs,
      result: resultFieldsForTelemetry(adapted),
      stageDurationsMs: out.telemetry.stageDurationsMs,
      sourceDurationsMs: sourceDurationsForTelemetry(out.telemetry.sourceRetrieval),
      telemetry: markPreviewVerification(
        allowlistedTechnicalTelemetry(out.telemetry, "miss", questionHash),
        verificationMode,
      ),
    });

    return {
      result: { ...adapted, searchLogId: searchRun?.rowId ?? null, requestId },
      fromCache: false,
    };
  } catch (err) {
    const failure = failureTechnicalTelemetry(questionHash, err);
    const stageDurationsMs = { ...partialStageDurationsMs };
    if (!(failure.failedStage in stageDurationsMs)) {
      const observedFailureMs = isSearchError(err) && err.totalDurationMs !== null
        ? err.totalDurationMs
        : elapsed(workStartedAt);
      stageDurationsMs[failure.failedStage] = observedFailureMs;
    }

    await completeSearchRun(searchRun, {
      status: "failed",
      query: null,
      searchMethod: "pipeline",
      totalDurationMs: elapsed(workStartedAt),
      result: EMPTY_RESULT_FIELDS,
      failedStage: failure.failedStage,
      errorCode: failure.errorCode,
      stageDurationsMs,
      sourceDurationsMs: failure.sourceDurationsMs,
      telemetry: markPreviewVerification(failure.telemetry, verificationMode),
    });
    throw err;
  }
}

// =====================================================
// HANDLERS — plain JSON (default) and SSE (?stream=1)
// =====================================================
/**
 * Maps a thrown pipeline failure to its wire form.
 *
 * Typed failures carry a stable code, an appropriate status (400 for bad input,
 * 503 for infrastructure and required providers) and the correlation id.
 * Everything else is an unexpected 500. No message, SQL or stack ever crosses
 * the boundary — those live in the server logs, joined by request id.
 */
export function failureResponseBody(err: unknown, requestId: string): {
  status: number;
  body: Record<string, unknown>;
} {
  if (isSearchError(err)) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "search.failed",
        requestId,
        code: err.code,
        stage: err.stage ?? null,
        source: err.source ?? null,
        databaseCode: err.databaseCode,
        transportCode: err.transportCode,
        internalCode: err.internalCode,
        attemptCount: err.attemptCount,
        totalDurationMs: err.totalDurationMs,
        sourceFailures: err.sourceFailures,
        name: err.name,
      }),
    );
    return { status: err.status, body: { ...err.toPublicJSON(), request_id: requestId } };
  }
  console.error(
    JSON.stringify({ level: "error", event: "search.unexpected_error", requestId }),
    err,
  );
  return {
    status: 500,
    body: { error: "An error occurred.", code: "internal_error", request_id: requestId },
  };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const rawQuery = url.searchParams.get("q");
  const wantStream = url.searchParams.get("stream") === "1";
  // "Śrīla Prabhupāda's words only" — restricts the transcripts RPC to
  // paragraphs whose deterministic speaker label is his. Any other value is
  // ignored, like the legacy `mode=` parameter: old links keep working.
  const speakerOnly = url.searchParams.get("only_his") === "1";
  let verificationMode: PreviewVerificationMode | null;
  try {
    verificationMode = readPreviewVerificationMode(request);
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "search.preview_verification_rejected" }));
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const requestId = newRequestId();

  // Input validation happens before any paid work. Without a length cap one
  // unauthenticated request drives the full Gemini + Voyage + Cohere + RPC
  // fan-out with an arbitrarily large query.
  const query = (rawQuery ?? "").trim();
  let inputError: InvalidSearchInputError | null = null;
  if (!query) {
    inputError = new InvalidSearchInputError("Query 'q' required", { requestId });
  } else if (query.length > MAX_QUERY_CHARS) {
    inputError = new InvalidSearchInputError(
      `Query exceeds ${MAX_QUERY_CHARS} characters`,
      { requestId },
    );
  }
  if (inputError && !wantStream) {
    const { status, body } = failureResponseBody(inputError, requestId);
    return NextResponse.json(body, { status });
  }

  if (!wantStream) {
    try {
      const { result } = await getOrComputeResult(
        query,
        requestId,
        undefined,
        speakerOnly,
        verificationMode,
      );
      return NextResponse.json(guardPayloadSize(result, requestId));
    } catch (err) {
      const { status, body } = failureResponseBody(err, requestId);
      return NextResponse.json(body, { status });
    }
  }

  // ── SSE stream: stage events as the pipeline advances, then the full result. ──
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { closed = true; }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Comment heartbeat defeats proxy buffering and keeps the connection alive
      // through the long cold path.
      const heartbeat = setInterval(() => write(`: ping\n\n`), 15000);

      // A stage re-emits when its label gains information (live counts), so
      // the waiting screen keeps moving through a long rerank instead of
      // freezing on a two-minute-old message.
      const lastLabel = new Map<SearchStageKey, string>();
      const onStage: OnStage = (stage, labelOverride, found) => {
        const meta = STAGE_META[stage];
        const label = labelOverride ?? meta.label;
        if (lastLabel.get(stage) === label) return;
        lastLabel.set(stage, label);
        send("stage", { stage, pct: meta.pct, label, ...(found !== undefined ? { found } : {}) });
      };

      try {
        if (inputError) throw inputError;
        const { result, fromCache } = await getOrComputeResult(
          query,
          requestId,
          onStage,
          speakerOnly,
          verificationMode,
        );
        if (fromCache) {
          // Cached answer: replay the stages in fast succession so the loader
          // still arcs rather than snapping to a finished result.
          for (const s of STAGE_ORDER) {
            onStage(s);
            await new Promise((r) => setTimeout(r, 120));
          }
        }
        send("result", guardPayloadSize(result, requestId));
        // The explicit terminal frame: the client closes on it, so the browser
        // never auto-reconnects and silently re-runs the whole search.
        send("done", {});
      } catch (err) {
        // Headers are already streamed, so the status code is spent. Emit the
        // typed failure the client listens for — never a fabricated empty
        // `result`, which is what made the outage invisible.
        const { body } = failureResponseBody(err, requestId);
        send("failure", body);
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
