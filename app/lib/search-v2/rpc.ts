/**
 * rpc.ts — The strict Supabase boundary.
 *
 * supabase-js resolves rather than rejects when Postgres returns an error, so
 * `const { data } = await supabase.rpc(...)` turns a dropped function, a stale
 * PostgREST schema cache, a statement timeout or a permission denial into
 * `undefined`, and then `data || []` turns it into "no results". Every
 * evidence-bearing call must go through `rpcOrThrow` (fatal) or `rpcOrDegrade`
 * (explicitly optional, and recorded), never through a bare destructure.
 *
 * The client is injected so provider-failure paths are unit-testable without a
 * network or a database.
 */
import {
  ProviderUnavailableError,
  SearchInfrastructureError,
  type SearchErrorContext,
  type SearchUpstreamAttempt,
} from "@/app/lib/search-v2/errors";

/** The shape supabase-js resolves to. Kept structural so tests can fake it. */
export interface RpcResult {
  data: unknown;
  error: unknown;
}

export interface RpcRequest extends PromiseLike<RpcResult> {
  /** postgrest-js strict mode: preserves rejected fetch evidence. */
  throwOnError?: () => PromiseLike<RpcResult>;
}

export interface RpcCapableClient {
  rpc(fn: string, args?: Record<string, unknown>): RpcRequest;
}

/** PostgREST/Postgres error fields we are willing to read. */
interface PostgrestLikeError {
  message?: unknown;
  code?: unknown;
  details?: unknown;
  hint?: unknown;
}

function asPostgrestError(error: unknown): PostgrestLikeError | null {
  return error && typeof error === "object" ? (error as PostgrestLikeError) : null;
}

function errorCode(error: unknown): string | undefined {
  const code = asPostgrestError(error)?.code;
  return typeof code === "string" ? code : undefined;
}

function thrownPostgrestCode(error: unknown): string | null {
  const item = asPostgrestError(error);
  const code = typeof item?.code === "string" ? item.code : null;
  if (!code) return null;
  // SQLSTATE is five alphanumerics (e.g. 57014, 42501, 22P02); PostgREST uses
  // PGRSTnnn. Network codes are deliberately excluded from this response lane.
  return /^[0-9A-Z]{5}$/.test(code) || /^PGRST\d{3}$/.test(code) ? code : null;
}

function rejectedOutcome(error: unknown): SearchUpstreamAttempt["outcome"] {
  if (definiteTransientTransportCode(error)) return "transport_error";
  const item = asErrorLike(error);
  if (item?.name === "AbortError" || item?.name === "TimeoutError" || item?.code === "ABORT_ERR") {
    return "aborted";
  }
  if (error instanceof ProviderUnavailableError) return "provider_error";
  if (thrownPostgrestCode(error)) return "response_error";
  return "unknown_error";
}

const DEFINITE_TRANSIENT_TRANSPORT_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

interface ErrorLike {
  name?: unknown;
  code?: unknown;
  cause?: unknown;
}

function asErrorLike(error: unknown): ErrorLike | null {
  return error && typeof error === "object" ? (error as ErrorLike) : null;
}

/**
 * Classifies a native fetch rejection. This helper is intentionally used only
 * at the fetch boundary, where rejection proves no Response was received.
 */
export function transientTransportCodeFromFetchRejection(error: unknown): string | null {
  let current: unknown = error;
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 4 && current && !seen.has(current); depth += 1) {
    seen.add(current);
    const item = asErrorLike(current);
    if (!item) return null;
    if (item.name === "AbortError" || item.name === "TimeoutError") return null;
    if (typeof item.code === "string" && DEFINITE_TRANSIENT_TRANSPORT_CODES.has(item.code)) {
      return item.code;
    }
    current = item.cause;
  }
  return null;
}

/**
 * Brand applied by the Supabase client's custom fetch only when native fetch
 * rejected before an HTTP Response existed. RPC code never guesses from an
 * ordinary Error message or network-looking cause.
 */
export class DefiniteSupabaseTransportError extends Error {
  readonly kind = "supabase_transport" as const;
  readonly responseReceived = false as const;
  readonly transient = true as const;

  constructor(readonly transportCode: string, cause: unknown) {
    super("Supabase request failed before receiving an HTTP response", { cause });
    this.name = "DefiniteSupabaseTransportError";
  }
}

/** A rejected RPC is retryable only when the actual fetch boundary branded it. */
export function definiteTransientTransportCode(error: unknown): string | null {
  return error instanceof DefiniteSupabaseTransportError ? error.transportCode : null;
}

export const RPC_TRANSPORT_RETRY_DELAY_MS = 250;

export interface RpcExecutionOptions {
  /** Test seam; production uses approximately 250 ms. */
  retryDelayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
  monotonicNow?: () => number;
}

export interface MeasuredRpcResult<T> {
  data: T;
  attempts: SearchUpstreamAttempt[];
  totalDurationMs: number;
}

const roundDuration = (durationMs: number): number => Math.round(Math.max(0, durationMs) * 1000) / 1000;

/**
 * PGRST202 — PostgREST could not find the function. This is exactly the failure
 * mode that caused the outage: it must be classified as infrastructure, never
 * as an empty result. 42883 is the Postgres-level equivalent.
 */
export function isMissingFunctionError(error: unknown): boolean {
  const code = errorCode(error);
  return code === "PGRST202" || code === "42883";
}

/**
 * A log-safe rendering of a database error. Deliberately drops `message`,
 * `details` and `hint`, which can echo query text, argument values and SQL.
 */
export function describeRpcError(error: unknown): string {
  return errorCode(error) ?? "unknown";
}

export interface RpcContext extends SearchErrorContext {
  /** Pipeline stage, e.g. "retrieval:verses:semantic". Appears in logs. */
  stage: string;
  requestId?: string;
}

/**
 * Required lane. Any database error throws — the caller must not be able to
 * mistake failure for emptiness. A successful empty array is returned as-is
 * and means genuinely no evidence.
 */
export async function rpcOrThrow<T>(
  client: RpcCapableClient,
  fn: string,
  args: Record<string, unknown>,
  ctx: RpcContext,
): Promise<T> {
  return (await rpcOrThrowMeasured<T>(client, fn, args, ctx)).data;
}

/**
 * Strict required RPC with monotonic per-attempt timing. At most one retry is
 * allowed, and only for a rejected call carrying a definite transient network
 * code. A resolved PostgREST/Postgres response is never retried, including
 * statement cancellation 57014.
 */
export async function rpcOrThrowMeasured<T>(
  client: RpcCapableClient,
  fn: string,
  args: Record<string, unknown>,
  ctx: RpcContext,
  options: RpcExecutionOptions = {},
): Promise<MeasuredRpcResult<T>> {
  const now = options.monotonicNow ?? (() => globalThis.performance.now());
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const retryDelayMs = options.retryDelayMs ?? RPC_TRANSPORT_RETRY_DELAY_MS;
  const attempts: SearchUpstreamAttempt[] = [];
  const totalStarted = now();

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptStarted = now();
    let result: RpcResult;
    try {
      const request = client.rpc(fn, args);
      result = await (typeof request.throwOnError === "function" ? request.throwOnError() : request);
    } catch (cause) {
      const transportCode = definiteTransientTransportCode(cause);
      const responseCode = thrownPostgrestCode(cause);
      const outcome = rejectedOutcome(cause);
      attempts.push({
        attempt,
        durationMs: roundDuration(now() - attemptStarted),
        outcome,
        code: transportCode ?? responseCode,
      });

      if (attempt === 1 && outcome === "transport_error" && transportCode) {
        await sleep(retryDelayMs);
        continue;
      }

      const totalDurationMs = roundDuration(now() - totalStarted);
      throw new SearchInfrastructureError(`${fn} threw during ${ctx.stage}`, {
        ...ctx,
        source: fn,
        databaseCode: responseCode,
        transportCode,
        attemptCount: attempts.length,
        attempts,
        totalDurationMs,
        cause,
      });
    }

    if (result.error) {
      const databaseCode = describeRpcError(result.error);
      attempts.push({
        attempt,
        durationMs: roundDuration(now() - attemptStarted),
        outcome: "response_error",
        code: databaseCode,
      });
      const totalDurationMs = roundDuration(now() - totalStarted);
      throw new SearchInfrastructureError(
        `${fn} failed during ${ctx.stage} (code ${databaseCode})`,
        {
          ...ctx,
          source: fn,
          databaseCode,
          attemptCount: attempts.length,
          attempts,
          totalDurationMs,
          cause: result.error,
        },
      );
    }

    attempts.push({
      attempt,
      durationMs: roundDuration(now() - attemptStarted),
      outcome: "success",
      code: null,
    });
    return {
      data: result.data as T,
      attempts,
      totalDurationMs: roundDuration(now() - totalStarted),
    };
  }

  throw new SearchInfrastructureError(`${fn} exhausted its transport retry`, {
    ...ctx,
    source: fn,
    attemptCount: attempts.length,
    attempts,
    totalDurationMs: roundDuration(now() - totalStarted),
  });
}

/** One recorded softening, surfaced in the response and in telemetry. */
export interface DegradedStage {
  stage: string;
  /** Non-sensitive: an RPC name or provider name. */
  source: string;
  code: string;
}

/**
 * Collects optional-lane failures so the response can admit what it did not
 * manage to do. A response with a non-empty list is still honest; a response
 * that silently dropped a lane is not.
 */
export class DegradationLog {
  private readonly entries: DegradedStage[] = [];

  constructor(private readonly requestId?: string) {}

  record(stage: string, source: string, error: unknown): void {
    const code = describeRpcError(error);
    this.entries.push({ stage, source, code });
    console.warn(
      JSON.stringify({
        level: "warn",
        event: "search.stage_degraded",
        requestId: this.requestId,
        stage,
        source,
        code,
      }),
    );
  }

  list(): DegradedStage[] {
    return [...this.entries];
  }

  get isEmpty(): boolean {
    return this.entries.length === 0;
  }
}

/**
 * Optional lane. Returns `fallback` on failure and records the degradation.
 * Only legitimate where core retrieval independently succeeded — spelling
 * suggestions, chapter-context enrichment, telemetry.
 */
export async function rpcOrDegrade<T>(
  client: RpcCapableClient,
  fn: string,
  args: Record<string, unknown>,
  ctx: RpcContext,
  fallback: T,
  log: DegradationLog,
): Promise<T> {
  try {
    const result = await client.rpc(fn, args);
    if (result.error) {
      log.record(ctx.stage, fn, result.error);
      return fallback;
    }
    return result.data as T;
  } catch (cause) {
    log.record(ctx.stage, fn, cause);
    return fallback;
  }
}

/**
 * Same strictness for direct table queries (the legacy `ilike` fallbacks),
 * which return the identical `{ data, error }` shape and were being destructured
 * just as unsafely.
 */
export function unwrapOrThrow<T>(result: RpcResult, source: string, ctx: RpcContext): T {
  if (result.error) {
    const databaseCode = describeRpcError(result.error);
    throw new SearchInfrastructureError(
      `${source} failed during ${ctx.stage} (code ${databaseCode})`,
      { ...ctx, source, databaseCode, attemptCount: 1, cause: result.error },
    );
  }
  return result.data as T;
}
