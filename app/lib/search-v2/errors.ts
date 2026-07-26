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
  cause?: unknown;
}

export abstract class SearchError extends Error {
  abstract readonly code: SearchErrorCode;
  /** HTTP status the route should map this to. */
  abstract readonly status: number;
  readonly requestId?: string;
  readonly stage?: string;

  protected constructor(message: string, context: SearchErrorContext = {}) {
    super(message, context.cause !== undefined ? { cause: context.cause } : undefined);
    this.name = new.target.name;
    this.requestId = context.requestId;
    this.stage = context.stage;
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
