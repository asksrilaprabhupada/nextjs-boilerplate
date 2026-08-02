/**
 * errors.ts — Typed failure taxonomy for the search pipeline.
 *
 * The incident this exists to prevent: every search_* RPC was dropped from the
 * database, and because supabase-js RESOLVES rather than rejects on a Postgres
 * error, `{ data: null, error }` was read as `.data || []`. A total
 * infrastructure failure was rendered to devotees as "no passages found",
 * HTTP 200, validated: true.
 *
 * The invariant these types enforce: an infrastructure failure is never
 * representable as an empty result. "No direct evidence" may only be returned
 * after retrieval actually completed.
 *
 * Phase B/C add InvalidQueryPlanError, InvalidArticlePlanError and
 * EvidenceInsufficient. They are documented in docs/deep-research-v2.md rather
 * than declared here, so this module carries no unused surface.
 */

/** Stable, non-sensitive codes. These reach the client; messages do not. */
export type SearchErrorCode =
  | "invalid_input"
  | "search_infrastructure_error"
  | "provider_unavailable";

export interface SearchErrorContext {
  /** Correlates the client response with server logs. Never sensitive. */
  requestId?: string;
  /** Pipeline stage that failed, e.g. "retrieval:verses:semantic". */
  stage?: string;
  /** Internal source identity. Server-side only; never serialised to clients. */
  source?: string;
  /** Safe Postgres/PostgREST code, when a database response supplied one. */
  databaseCode?: string | null;
  /** Safe network code from a branded pre-response fetch rejection. */
  transportCode?: string | null;
  /** Stable server-only classification for non-database contract failures. */
  internalCode?: string | null;
  /** Number of actual upstream attempts made before the failure. */
  attemptCount?: number;
  /** Safe per-attempt evidence. Messages, arguments and stacks are excluded. */
  attempts?: SearchUpstreamAttempt[];
  /** Monotonic elapsed time across every attempt and any retry delay. */
  totalDurationMs?: number;
  /** Safe per-source summaries when an all-source fan-out fails. */
  sourceFailures?: SearchSourceFailureSummary[];
  cause?: unknown;
}

export interface SearchUpstreamAttempt {
  attempt: number;
  durationMs: number;
  outcome:
    | "success"
    | "response_error"
    | "transport_error"
    | "aborted"
    | "provider_error"
    | "invalid_response"
    | "unknown_error";
  code: string | null;
}

export interface SearchSourceFailureSummary {
  source: string;
  stage: string;
  databaseCode: string | null;
  transportCode: string | null;
  internalCode: string | null;
  attemptCount: number;
  durationMs: number;
}

export abstract class SearchError extends Error {
  abstract readonly code: SearchErrorCode;
  /** HTTP status the route should map this to. */
  abstract readonly status: number;
  readonly requestId?: string;
  readonly stage: string | null;
  readonly source: string | null;
  readonly databaseCode: string | null;
  readonly transportCode: string | null;
  readonly internalCode: string | null;
  readonly attemptCount: number;
  readonly attempts: SearchUpstreamAttempt[];
  readonly totalDurationMs: number | null;
  readonly sourceFailures: SearchSourceFailureSummary[];

  protected constructor(message: string, context: SearchErrorContext = {}) {
    super(message, context.cause !== undefined ? { cause: context.cause } : undefined);
    this.name = new.target.name;
    this.requestId = context.requestId;
    this.stage = context.stage ?? null;
    this.source = context.source ?? null;
    this.databaseCode = context.databaseCode ?? null;
    this.transportCode = context.transportCode ?? null;
    this.internalCode = context.internalCode ?? null;
    this.attemptCount = context.attemptCount ?? 0;
    this.attempts = context.attempts ? [...context.attempts] : [];
    this.totalDurationMs = context.totalDurationMs ?? null;
    this.sourceFailures = context.sourceFailures ? [...context.sourceFailures] : [];
  }

  /**
   * The only shape allowed to cross the network. Deliberately excludes the
   * message, the cause and any stack — those carry SQL, argument values and
   * internal structure.
   */
  toPublicJSON(): { error: string; code: SearchErrorCode; request_id?: string } {
    return { error: PUBLIC_MESSAGE[this.code], code: this.code, request_id: this.requestId };
  }
}

const PUBLIC_MESSAGE: Record<SearchErrorCode, string> = {
  invalid_input: "That search request was not valid.",
  search_infrastructure_error: "Search is temporarily unavailable. Please try again shortly.",
  provider_unavailable: "Search is temporarily unavailable. Please try again shortly.",
};

/** The request itself was malformed — missing, empty, over-long or unknown mode. */
export class InvalidSearchInputError extends SearchError {
  readonly code = "invalid_input" as const;
  readonly status = 400;
  constructor(message: string, context: SearchErrorContext = {}) {
    super(message, context);
  }
}

/**
 * The database could not answer: missing function, stale PostgREST schema cache
 * (PGRST202), timeout, permission denied, connection failure, or missing
 * server credentials. Never a synonym for "zero rows".
 */
export class SearchInfrastructureError extends SearchError {
  readonly code = "search_infrastructure_error" as const;
  readonly status = 503;
  constructor(message: string, context: SearchErrorContext = {}) {
    super(message, context);
  }
}

/** A required external provider (embeddings, reranking) failed. */
export class ProviderUnavailableError extends SearchError {
  readonly code = "provider_unavailable" as const;
  readonly status = 503;
  constructor(message: string, context: SearchErrorContext = {}) {
    super(message, context);
  }
}

export function isSearchError(err: unknown): err is SearchError {
  return err instanceof SearchError;
}

/** Correlation id returned to the client and stamped on every server log line. */
export function newRequestId(): string {
  return globalThis.crypto.randomUUID();
}
