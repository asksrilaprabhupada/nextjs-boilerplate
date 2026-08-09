/**
 * retrieval.ts — Vocabulary resolution, batched embedding, five ordered RPCs.
 *
 * This is the whole retrieval stage. Five table-level calls, run serially in a
 * measured heaviest-first order, replace the ~135-RPC fan-out. Each carries the
 * original question and every approved subquery, so a subquery costs a few
 * milliseconds inside an existing call rather than twelve fresh round trips to
 * Mumbai.
 *
 * Two honesty rules the brief is explicit about, both enforced here:
 *
 *   - A table RPC failing is never mistaken for an empty source. If another
 *     requested source succeeds, the answer continues but is explicitly marked
 *     incomplete; if all requested sources fail, infrastructure failure wins.
 *   - Voyage failing is NOT fatal. Without embeddings the semantic channel goes
 *     dark but fts_core, fts_expansion and validated tags still retrieve, so the
 *     search degrades and says so rather than dying.
 *
 * The RPC counts reported in telemetry are honest: `tableRpcCount` counts
 * logical source invocations, while `tableRpcAttemptCount` also includes a
 * definite-transport retry. Vocabulary and hydration remain separate.
 */
import { embedQueries } from "@/app/lib/03-embed";
import {
  rpcOrThrowMeasured,
  rpcOrDegrade,
  type RpcCapableClient,
  DegradationLog,
} from "@/app/lib/search-v2/rpc";
import {
  SearchInfrastructureError,
  type SearchUpstreamAttempt,
} from "@/app/lib/search-v2/errors";
import { SEARCH_V2_CONFIG } from "@/app/lib/search-v2/config";
import type { RetrievedCandidate } from "@/app/lib/search-v2/fusion";
import type { QueryPlan } from "@/app/lib/search-v2/query-plan";
import { getCacheAdapter, cacheKeys, TTL } from "@/app/lib/search-v2/cache";
import type { FriendlyRetrievalSource } from "@/app/lib/types/01-search";
import { transcriptSpeakerAttribution } from "@/app/lib/15-transcript-speakers";

/** The id reserved for the devotee's actual question. */
export const ORIGINAL_QUERY_ID = "q_original";

export interface ResolvedVocabTerm {
  candidate: string;
  slug: string;
  term: string;
  facet: string | null;
  match_kind: string;
  confidence: number;
}

/**
 * Resolves model-suggested concepts to canonical slugs, server-side.
 *
 * Degrades rather than throws: tags are a modest ranking signal, so losing them
 * costs a little recall. Treating that as fatal would be disproportionate.
 */
export async function resolveVocabulary(
  db: RpcCapableClient,
  candidates: string[],
  ctx: { requestId: string },
  degraded: DegradationLog,
): Promise<ResolvedVocabTerm[]> {
  const cleaned = [...new Set(candidates.map((c) => c.trim()).filter(Boolean))].slice(0, 10);
  if (cleaned.length === 0) return [];

  const rows = await rpcOrDegrade<ResolvedVocabTerm[] | null>(
    db,
    "resolve_vocabulary_terms_v1",
    { p_candidates: cleaned, p_limit_per_candidate: 2 },
    { stage: "retrieval:vocabulary", requestId: ctx.requestId },
    [],
    degraded,
  );
  return rows ?? [];
}

export interface EmbeddedQuery {
  id: string;
  text: string;
  embedding: number[];
}

/**
 * Embeds the original question and every approved subquery in ONE Voyage call,
 * preserving ids. Entries are cached individually by model + normalised text, so
 * a repeated question or a recurring subquery skips the provider entirely.
 */
export async function embedPlannedQueries(
  original: string,
  plan: QueryPlan,
): Promise<{ queries: EmbeddedQuery[]; embeddingAvailable: boolean; providerCalls: number }> {
  const wanted: { id: string; text: string }[] = [
    { id: ORIGINAL_QUERY_ID, text: original },
    ...plan.subqueries.map((s) => ({ id: s.id, text: s.text })),
  ];

  const model = "voyage-context-4";
  const resolved = new Map<string, number[]>();
  const missing: { id: string; text: string }[] = [];

  // Read-only lookup. Deliberately NOT the `cached()` read-through helper:
  // its producer runs on a miss, so a producer returning null would write a
  // null into the keyspace for every query text the pipeline has never seen.
  // That is never served as a hit, but it fills the shared cache with entries
  // that mean "we once failed to find this", which is not worth storing.
  let store: Awaited<ReturnType<typeof getCacheAdapter>> | null = null;
  try {
    store = await getCacheAdapter();
  } catch {
    store = null; // no cache available; every query is a miss
  }

  for (const w of wanted) {
    let hit: number[] | null = null;
    if (store) {
      try {
        hit = await store.get<number[]>(cacheKeys.embedding(model, w.text));
      } catch {
        hit = null;
      }
    }
    if (hit && hit.length > 0) resolved.set(w.id, hit);
    else missing.push(w);
  }

  let providerCalls = 0;
  if (missing.length > 0) {
    // One batched call for every query the cache did not already hold.
    providerCalls = 1;
    const vectors = await embedQueries(missing.map((m) => m.text));
    for (let i = 0; i < missing.length; i++) {
      const v = vectors[i] ?? [];
      if (v.length === 0) continue; // provider failed for this entry
      resolved.set(missing[i].id, v);
      if (!store) continue;
      try {
        await store.set(cacheKeys.embedding(model, missing[i].text), v, TTL.embedding);
      } catch {
        // Cache write failures never affect the search.
      }
    }
  }

  const queries: EmbeddedQuery[] = wanted.map((w) => ({
    id: w.id,
    text: w.text,
    embedding: resolved.get(w.id) ?? [],
  }));

  // Semantic is available only if the ORIGINAL question embedded. A pipeline
  // running semantic on subqueries but not the question would weight the
  // scaffolding above the thing actually asked.
  const embeddingAvailable = (resolved.get(ORIGINAL_QUERY_ID) ?? []).length > 0;
  return { queries, embeddingAvailable, providerCalls };
}

// v3, not v2: v2 pinned hnsw.ef_search to 100, so its semantic lane silently
// returned at most 100 rows however many were asked for. v3 raises ef_search to
// 400 and clamps p_semantic_limit to it, so the truncation that could not be
// detected also cannot be requested (migration 20260727120000).
/**
 * Medium-compute execution order, measured 2026-08-02.
 *
 * These calls are deliberately serialized below. On the permanent Medium
 * serving tier every source completes below the eight-second Data API timeout
 * when run alone, while transcripts reached 10.61 s with only two calls in
 * flight. The measured heaviest-first order puts the highest timeout risk first
 * without changing any source, limit, query, ef_search, or candidate semantics.
 */
const BATCH_FUNCTIONS = [
  "search_transcripts_hybrid_batch_v3",
  "search_verses_hybrid_batch_v3",
  "search_prose_hybrid_batch_v3",
  "search_verse_chunks_hybrid_batch_v3",
  "search_letters_hybrid_batch_v3",
] as const;

export type BatchFunction = (typeof BATCH_FUNCTIONS)[number];

/** Table-level source filtering, so a `source_types` constraint can skip a call. */
const FUNCTION_SOURCES: Record<BatchFunction, string[]> = {
  search_verses_hybrid_batch_v3: ["verse"],
  search_verse_chunks_hybrid_batch_v3: ["purport"],
  search_prose_hybrid_batch_v3: ["book"],
  search_transcripts_hybrid_batch_v3: ["lecture", "conversation"],
  search_letters_hybrid_batch_v3: ["letter"],
};

export const FRIENDLY_SOURCE_BY_FUNCTION: Record<BatchFunction, FriendlyRetrievalSource> = {
  search_verses_hybrid_batch_v3: "Scripture verses",
  search_verse_chunks_hybrid_batch_v3: "Purports",
  search_prose_hybrid_batch_v3: "Books",
  search_transcripts_hybrid_batch_v3: "Lectures and conversations",
  search_letters_hybrid_batch_v3: "Letters",
};

/** The two scripture-constrained sources, for the fail-open rule below. */
const SCRIPTURE_FILTERED: BatchFunction[] = [
  "search_verses_hybrid_batch_v3",
  "search_verse_chunks_hybrid_batch_v3",
];

export interface RetrievalResult {
  groups: RetrievedCandidate[][];
  tableRpcCount: number;
  tableRpcAttemptCount: number;
  vocabularyRpcCount: number;
  embeddingProviderCalls: number;
  resolvedSlugs: string[];
  semanticAvailable: boolean;
  candidateCount: number;
  sourceRetrieval: RetrievalSourceTelemetry[];
  degradedSources: FriendlyRetrievalSource[];
}

export interface RetrievalSourceTelemetry {
  source: FriendlyRetrievalSource;
  internalFunction: BatchFunction;
  stage: string;
  operation: "initial" | "constraint_fail_open";
  durationMs: number;
  success: boolean;
  code: string | null;
  candidateCount: number | null;
  /** Rows returned by the RPC before the application speaker postcondition. */
  rawCandidateCount?: number | null;
  outerLimit: number;
  semanticLimit: number;
  attemptCount: number;
  attempts: SearchUpstreamAttempt[];
}

export interface RetrievalInput {
  db: RpcCapableClient;
  original: string;
  plan: QueryPlan;
  requestId: string;
  degraded: DegradationLog;
  perTableLimit?: number;
  /** Private evaluator bookkeeping; observer failures never affect retrieval. */
  onEmbeddingUsage?: (providerCalls: number) => void;
}

/**
 * Runs the retrieval stage.
 *
 * Queries whose embedding is missing are still sent — their text drives the
 * lexical channels inside the RPC, which is exactly the Voyage-unavailable
 * fallback the brief specifies.
 */
export async function retrieveCandidates(input: RetrievalInput): Promise<RetrievalResult> {
  const { db, original, plan, requestId, degraded } = input;

  const [vocab, embedded] = await Promise.all([
    resolveVocabulary(db, plan.vocabulary_candidates, { requestId }, degraded),
    embedPlannedQueries(original, plan).then((result) => {
      try { input.onEmbeddingUsage?.(result.providerCalls); } catch { /* bookkeeping only */ }
      return result;
    }),
  ]);

  const slugs = [...new Set(vocab.map((v) => v.slug))];

  const payload = embedded.queries.map((q) => ({
    id: q.id,
    text: q.text,
    // The SQL side reads `embedding` as a JSON array; an empty array means
    // "no semantic channel for this query" rather than an error.
    embedding: q.embedding.length > 0 ? q.embedding : null,
  }));

  const wantedSources = plan.constraints.source_types;
  const active = BATCH_FUNCTIONS.filter(
    (fn) => wantedSources.length === 0 || FUNCTION_SOURCES[fn].some((s) => wantedSources.includes(s as never)),
  );
  // A constraint that excludes every table is a misread plan, not an instruction
  // to search nothing.
  const toCall = active.length > 0 ? active : [...BATCH_FUNCTIONS];

  const limitFor = (fn: BatchFunction): number =>
    input.perTableLimit ?? SEARCH_V2_CONFIG.perSourceLimit[fn] ?? SEARCH_V2_CONFIG.perTableLimit;

  const constraints: Record<string, unknown> = {
    scripture_references: plan.constraints.scripture_references,
    recipient: plan.constraints.recipient,
    location: plan.constraints.location,
    date_from: plan.constraints.date_from,
    date_to: plan.constraints.date_to,
  };

  const callOne = async (
    fn: BatchFunction,
    cons: Record<string, unknown>,
    operation: RetrievalSourceTelemetry["operation"],
  ): Promise<{ rows: RetrievedCandidate[]; telemetry: RetrievalSourceTelemetry }> => {
    const stage = `retrieval:batch:${fn}`;
    const measured = await rpcOrThrowMeasured<RetrievedCandidate[] | null>(
      db,
      fn,
      {
        p_queries: payload,
        p_lexical_phrases: plan.lexical_phrases,
        p_tag_slugs: slugs,
        p_constraints: cons,
        p_limit: limitFor(fn),
        p_semantic_limit: SEARCH_V2_CONFIG.perSourceSemanticLimit,
      },
      { stage, requestId },
    );
    if (!Array.isArray(measured.data)) {
      const attempts = measured.attempts.map((attempt, index) =>
        index === measured.attempts.length - 1
          ? { ...attempt, outcome: "invalid_response" as const, code: "invalid_response" }
          : attempt);
      throw new SearchInfrastructureError(`${fn} returned an invalid response during ${stage}`, {
        requestId,
        stage,
        source: fn,
        internalCode: "invalid_response",
        attemptCount: attempts.length,
        attempts,
        totalDurationMs: measured.totalDurationMs,
      });
    }
    const rawRows = measured.data;
    let rows = rawRows;
    if (fn === "search_transcripts_hybrid_batch_v3") {
      rows = rawRows.map((row) => {
        const attribution = transcriptSpeakerAttribution(row.retrieval_text || "");
        return {
          ...row,
          speaker: attribution.displaySpeaker,
          speakerUnidentified: attribution.unidentified,
        };
      });
    }
    // A table that fills its whole budget probably has more relevant rows
    // waiting behind the cut. Logged so the ceiling is raised from evidence,
    // not from a hunch.
    if (rawRows.length >= limitFor(fn)) {
      console.info(
        JSON.stringify({
          level: "info",
          event: "search.table_at_limit",
          requestId,
          table: fn,
          limit: limitFor(fn),
        }),
      );
    }
    return {
      rows,
      telemetry: {
        source: FRIENDLY_SOURCE_BY_FUNCTION[fn],
        internalFunction: fn,
        stage,
        operation,
        durationMs: measured.totalDurationMs,
        success: true,
        code: null,
        candidateCount: rows.length,
        rawCandidateCount: rawRows.length,
        outerLimit: limitFor(fn),
        semanticLimit: SEARCH_V2_CONFIG.perSourceSemanticLimit,
        attemptCount: measured.attempts.length,
        attempts: measured.attempts,
      },
    };
  };

  const sourceRetrieval: RetrievalSourceTelemetry[] = [];
  const degradedSourceSet = new Set<FriendlyRetrievalSource>();
  const groupsByFunction = new Map<BatchFunction, RetrievedCandidate[]>();

  const recordSource = (telemetry: RetrievalSourceTelemetry): void => {
    sourceRetrieval.push(telemetry);
    const entry = JSON.stringify({
      level: telemetry.success ? "info" : "warn",
      event: "search.retrieval_source",
      requestId,
      ...telemetry,
    });
    if (telemetry.success) console.info(entry);
    else console.warn(entry);
  };

  const failureTelemetry = (
    fn: BatchFunction,
    operation: RetrievalSourceTelemetry["operation"],
    reason: unknown,
  ): { error: SearchInfrastructureError; telemetry: RetrievalSourceTelemetry } => {
    const stage = `retrieval:batch:${fn}`;
    const error = reason instanceof SearchInfrastructureError
      ? reason
      : new SearchInfrastructureError(`${fn} failed unexpectedly during ${stage}`, {
          requestId,
          stage,
          source: fn,
          attemptCount: 1,
          cause: reason,
        });
    const attempts = error.attempts;
    return {
      error,
      telemetry: {
        source: FRIENDLY_SOURCE_BY_FUNCTION[fn],
        internalFunction: fn,
        stage,
        operation,
        durationMs: error.totalDurationMs ?? attempts.reduce((n, attempt) => n + attempt.durationMs, 0),
        success: false,
        code: error.databaseCode ?? error.transportCode ?? error.internalCode,
        candidateCount: null,
        rawCandidateCount: null,
        outerLimit: limitFor(fn),
        semanticLimit: SEARCH_V2_CONFIG.perSourceSemanticLimit,
        attemptCount: error.attemptCount || attempts.length,
        attempts,
      },
    };
  };

  const settleCalls = async (
    functions: BatchFunction[],
    cons: Record<string, unknown>,
    operation: RetrievalSourceTelemetry["operation"],
  ): Promise<SearchInfrastructureError[]> => {
    const failures: SearchInfrastructureError[] = [];

    // Preserve Phase 1's all-settled contract while removing overlap: every
    // requested source is attempted, every result is recorded, and failure is
    // evaluated only after the whole ordered list has settled. The singleton
    // allSettled keeps rejection handling scoped to callOne; bookkeeping bugs
    // must not be relabelled as source failures.
    for (const fn of functions) {
      const [result] = await Promise.allSettled([callOne(fn, cons, operation)]);
      if (result.status === "fulfilled") {
        groupsByFunction.set(fn, result.value.rows);
        recordSource(result.value.telemetry);
        continue;
      }
      const failure = failureTelemetry(fn, operation, result.reason);
      recordSource(failure.telemetry);
      failures.push(failure.error);
      degradedSourceSet.add(failure.telemetry.source);
      degraded.record("retrieving", fn, { code: failure.telemetry.code ?? "unknown" });
    }

    return failures;
  };

  const retrievalStarted = globalThis.performance.now();
  const firstFailures = await settleCalls(toCall, constraints, "initial");
  if (firstFailures.length === toCall.length) {
    // All identities and timings have been recorded before the typed failure
    // escapes. A total outage can therefore never become an empty answer.
    const failureBySource = new Map(firstFailures.map((error) => [error.source, error]));
    const sourceFailures = sourceRetrieval.map((source) => ({
      source: source.internalFunction,
      stage: source.stage,
      databaseCode: failureBySource.get(source.internalFunction)?.databaseCode ?? null,
      transportCode: failureBySource.get(source.internalFunction)?.transportCode ?? null,
      internalCode: failureBySource.get(source.internalFunction)?.internalCode ?? null,
      attemptCount: source.attemptCount,
      durationMs: source.durationMs,
    }));
    const sharedCode = (
      field: "databaseCode" | "transportCode" | "internalCode",
    ): string | null => {
      const codes = [...new Set(sourceFailures.map((failure) => failure[field]).filter(Boolean))];
      return codes.length === 1 ? codes[0] : null;
    };
    throw new SearchInfrastructureError("All requested retrieval sources failed", {
      requestId,
      stage: "retrieval:batch",
      source: "all_requested_sources",
      databaseCode: sharedCode("databaseCode"),
      transportCode: sharedCode("transportCode"),
      internalCode: sharedCode("internalCode"),
      attemptCount: sourceRetrieval.reduce((n, source) => n + source.attemptCount, 0),
      totalDurationMs: Math.round((globalThis.performance.now() - retrievalStarted) * 1000) / 1000,
      sourceFailures,
      cause: new AggregateError(firstFailures, "All requested retrieval sources failed"),
    });
  }

  // ── Fail open, never closed ──
  // A scripture filter that empties BOTH scripture sources while the
  // unconstrained sources found rows has misread the question, not answered it.
  // Re-run only the scripture-filtered calls without the constraint and merge.
  // An empty result set caused by a filter is always a bug, never an answer.
  const hasScriptureConstraint = plan.constraints.scripture_references.length > 0;
  if (hasScriptureConstraint) {
    const successfulScripture = SCRIPTURE_FILTERED.filter(
      (fn) => toCall.includes(fn) && groupsByFunction.has(fn),
    );
    const scriptureRows = toCall.reduce((n, fn) =>
      n + (SCRIPTURE_FILTERED.includes(fn) ? (groupsByFunction.get(fn)?.length ?? 0) : 0), 0);
    const otherRows = toCall.reduce((n, fn) =>
      n + (SCRIPTURE_FILTERED.includes(fn) ? 0 : (groupsByFunction.get(fn)?.length ?? 0)), 0);
    if (successfulScripture.length > 0 && scriptureRows === 0 && otherRows > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          event: "search.constraint_failed_open",
          requestId,
          constraint: plan.constraints.scripture_references,
        }),
      );
      const unconstrained = { ...constraints, scripture_references: [] };
      // Reopen only scripture sources whose constrained call completed. A
      // failed call is not retried under the guise of constraint recovery.
      await settleCalls(successfulScripture, unconstrained, "constraint_fail_open");
    }
  }

  const groups = toCall
    .filter((fn) => groupsByFunction.has(fn))
    .map((fn) => groupsByFunction.get(fn) ?? []);

  return {
    groups,
    tableRpcCount: sourceRetrieval.length,
    tableRpcAttemptCount: sourceRetrieval.reduce((n, source) => n + source.attemptCount, 0),
    vocabularyRpcCount: plan.vocabulary_candidates.length > 0 ? 1 : 0,
    embeddingProviderCalls: embedded.providerCalls,
    resolvedSlugs: slugs,
    semanticAvailable: embedded.embeddingAvailable,
    candidateCount: groups.reduce((n, g) => n + g.length, 0),
    sourceRetrieval,
    degradedSources: [...degradedSourceSet],
  };
}

/** Hash of the approved plan, for the retrieval cache key. */
export function planHash(plan: QueryPlan): string {
  const stable = JSON.stringify({
    q: plan.canonical_query,
    s: plan.subqueries.map((x) => [x.id, x.text, x.priority]).sort(),
    l: [...plan.lexical_phrases].sort(),
    v: [...plan.vocabulary_candidates].sort(),
    c: plan.constraints,
  });
  return stable;
}
