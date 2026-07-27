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
  SearchInfrastructureError,
  type SearchErrorContext,
} from "@/app/lib/search/errors";

/** The shape supabase-js resolves to. Kept structural so tests can fake it. */
export interface RpcResult {
  data: unknown;
  error: unknown;
}

export interface RpcCapableClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<RpcResult>;
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
  let result: RpcResult;
  try {
    result = await client.rpc(fn, args);
  } catch (cause) {
    // Network/abort failures do reject, unlike Postgres errors.
    throw new SearchInfrastructureError(`${fn} threw during ${ctx.stage}`, {
      ...ctx,
      cause,
    });
  }

  if (result.error) {
    throw new SearchInfrastructureError(
      `${fn} failed during ${ctx.stage} (code ${describeRpcError(result.error)})`,
      { ...ctx, cause: result.error },
    );
  }

  return result.data as T;
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
    throw new SearchInfrastructureError(
      `${source} failed during ${ctx.stage} (code ${describeRpcError(result.error)})`,
      { ...ctx, cause: result.error },
    );
  }
  return result.data as T;
}
