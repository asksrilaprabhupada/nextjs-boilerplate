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
import { runSearchV2, type PipelineStage } from "@/app/lib/search-v2/pipeline";
import { adaptToSearchResults } from "@/app/lib/search-v2/adapt";
import {
  cacheKeys,
  getCacheAdapter,
  TTL,
} from "@/app/lib/search-v2/cache";

// The cold pipeline (embeddings + RPCs + Cohere) can take 25–50 s; give the
// function room on Vercel. If the plan rejects 90, drop to 60.
export const maxDuration = 90;

/**
 * Upper bound on `q`. Without one, a single unauthenticated request drives the
 * full paid fan-out (Gemini + Voyage + Cohere + RPCs) with an arbitrarily large
 * query.
 */
const MAX_QUERY_CHARS = 2000;

/** Pipeline progress hook — drives the SSE `stage` events. */
type OnStage = (stage: SearchStageKey) => void;

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

function toWireStage(onStage: OnStage): (stage: PipelineStage) => void {
  return (stage) => {
    const wire = STAGE_TO_WIRE[stage];
    if (wire) onStage(wire);
  };
}

// =====================================================
// TELEMETRY
// =====================================================

/** Request metadata threaded into telemetry (never used for retrieval). */
interface SearchRequestContext {
  userAgent?: string | null;
  referrer?: string | null;
  visitorId?: string | null;
}

interface SearchDurations {
  totalMs?: number;
}

/**
 * Writes one search_logs row via the log_search RPC and returns its id.
 * Shared by the fresh-pipeline path and the cache-hit path (method: "cache").
 * Telemetry never blocks or breaks a search — failures log and return null.
 */
async function logSearchRow(
  query: string,
  result: Record<string, unknown>,
  method: string,
  durations: SearchDurations,
  ctx: SearchRequestContext,
): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin();
    const mainFlowItems = (result.mainFlowItems as { type: string; id: string }[] | undefined) || [];
    const { data, error } = await supabase.rpc("log_search", {
      p_query: query,
      p_visitor_id: ctx.visitorId ?? null,
      p_total_results: (result.totalResults as number) ?? 0,
      p_verse_ids: (result.articleVerseIds as string[] | undefined) || [],
      p_prose_ids: mainFlowItems.filter(i => i.type === "prose").map(i => i.id),
      p_books_returned: ((result.books as { name: string }[] | undefined) || []).map(b => b.name),
      p_search_method: method,
      p_search_duration_ms: null,
      p_embedding_duration_ms: null,
      p_synthesis_duration_ms: null,
      p_total_duration_ms: durations.totalMs ?? null,
      p_narrative_length: typeof result.narrative === "string" ? result.narrative.length : null,
      p_source: "web",
      p_user_agent: ctx.userAgent ?? null,
      p_referrer: ctx.referrer ?? null,
      p_query_variants: (result.queryVariants as string[] | undefined) || [],
    });
    if (error) throw error;
    return (data as string) ?? null;
  } catch (err) {
    console.error("[log_search] failed (search unaffected):", err);
    return null;
  }
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

/**
 * Cache-aware pipeline entry — both handlers go through here.
 *
 * Two invariants: only a completed, non-degraded result is ever cached (an error
 * or an outage-weakened answer must never become a 24 h cached truth), and
 * correlation ids are attached AFTER the cache read so a cached body never
 * replays another request's id.
 *
 * Failures are NOT caught here. A retrieval RPC failure must reach the handler
 * as a SearchInfrastructureError and become a 503; swallowing it would rebuild
 * the disguise that made the last outage invisible.
 */
async function getOrComputeResult(
  query: string,
  requestId: string,
  onStage?: OnStage,
  ctx: SearchRequestContext = {},
): Promise<{ result: Record<string, unknown>; fromCache: boolean }> {
  // Keyed on the EXACT normalised question plus corpus version. A semantically
  // close but different question is a different question and never reuses this
  // entry — answering one devotee's question with another's evidence is how
  // words get put in Śrīla Prabhupāda's mouth by accident.
  const key = cacheKeys.response(query);
  const cached = await readCache(key);
  if (cached) {
    // A cached answer still logs its own row so feedback attributes correctly.
    const searchLogId = await logSearchRow(query, cached, "cache", { totalMs: 0 }, ctx);
    onStage?.("weaving");
    return { result: { ...cached, searchLogId, requestId }, fromCache: true };
  }

  const out = await runSearchV2({
    db: getSupabaseAdmin() as unknown as RpcCapableClient,
    query,
    requestId,
    onStage: onStage ? toWireStage(onStage) : undefined,
  });
  const adapted = adaptToSearchResults(query, out) as unknown as Record<string, unknown>;
  const searchLogId = await logSearchRow(
    query,
    adapted,
    "pipeline",
    { totalMs: out.telemetry.totalDurationMs },
    ctx,
  );

  // Only a clean, non-degraded answer is cached. A response produced while
  // Voyage or Cohere was down is correct but weaker, and caching it for 24
  // hours would outlive the outage that caused it.
  if (!out.telemetry.degraded && !out.evidenceInsufficient) {
    await writeCache(key, adapted);
  }

  return { result: { ...adapted, searchLogId, requestId }, fromCache: false };
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
function failureResponseBody(err: unknown, requestId: string): {
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

  const ctx: SearchRequestContext = {
    userAgent: request.headers.get("user-agent"),
    referrer: request.headers.get("referer"),
    visitorId: request.cookies.get("asp_vid")?.value ?? null,
  };

  if (!wantStream) {
    try {
      const { result } = await getOrComputeResult(query, requestId, undefined, ctx);
      return NextResponse.json(result);
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

      const emitted = new Set<SearchStageKey>();
      const onStage: OnStage = (stage) => {
        if (emitted.has(stage)) return;
        emitted.add(stage);
        const meta = STAGE_META[stage];
        send("stage", { stage, pct: meta.pct, label: meta.label });
      };

      try {
        if (inputError) throw inputError;
        const { result, fromCache } = await getOrComputeResult(query, requestId, onStage, ctx);
        if (fromCache) {
          // Cached answer: replay the stages in fast succession so the loader
          // still arcs rather than snapping to a finished result.
          for (const s of STAGE_ORDER) {
            onStage(s);
            await new Promise((r) => setTimeout(r, 120));
          }
        }
        send("result", result);
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
