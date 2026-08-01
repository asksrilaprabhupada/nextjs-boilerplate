/**
 * retrieval.ts — Vocabulary resolution, batched embedding, five concurrent RPCs.
 *
 * This is the whole retrieval stage. Five table-level calls, run concurrently,
 * replacing the ~135-RPC fan-out. Each carries the original question and every
 * approved subquery, so a subquery costs a few milliseconds inside an existing
 * call rather than twelve fresh round trips to Mumbai.
 *
 * Two honesty rules the brief is explicit about, both enforced here:
 *
 *   - A table RPC failing is an INFRASTRUCTURE FAILURE, not a quiet loss of one
 *     source. `rpcOrThrow` propagates; nothing silently drops a corpus.
 *   - Voyage failing is NOT fatal. Without embeddings the semantic channel goes
 *     dark but fts_core, fts_expansion and validated tags still retrieve, so the
 *     search degrades and says so rather than dying.
 *
 * The RPC count reported in telemetry is honest: `tableRpcCount` counts only the
 * five retrieval calls. Vocabulary resolution and context hydration are counted
 * separately, because folding them in would make the "five RPCs" claim a lie.
 */
import { embedQueries } from "@/app/lib/03-embed";
import { rpcOrThrow, rpcOrDegrade, type RpcCapableClient, DegradationLog } from "@/app/lib/search-v2/rpc";
import { SEARCH_V2_CONFIG } from "@/app/lib/search-v2/config";
import type { RetrievedCandidate } from "@/app/lib/search-v2/fusion";
import type { QueryPlan } from "@/app/lib/search-v2/query-plan";
import { getCacheAdapter, cacheKeys, TTL } from "@/app/lib/search-v2/cache";

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
const BATCH_FUNCTIONS = [
  "search_verses_hybrid_batch_v3",
  "search_verse_chunks_hybrid_batch_v3",
  "search_prose_hybrid_batch_v3",
  "search_transcripts_hybrid_batch_v3",
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

/** The two scripture-constrained sources, for the fail-open rule below. */
const SCRIPTURE_FILTERED: BatchFunction[] = [
  "search_verses_hybrid_batch_v3",
  "search_verse_chunks_hybrid_batch_v3",
];

export interface RetrievalResult {
  groups: RetrievedCandidate[][];
  tableRpcCount: number;
  vocabularyRpcCount: number;
  embeddingProviderCalls: number;
  resolvedSlugs: string[];
  semanticAvailable: boolean;
  candidateCount: number;
}

export interface RetrievalInput {
  db: RpcCapableClient;
  original: string;
  plan: QueryPlan;
  requestId: string;
  degraded: DegradationLog;
  perTableLimit?: number;
  /**
   * "Śrīla Prabhupāda's words only" — forwarded to the transcripts RPC as
   * `p_constraints -> 'speaker_only'`. The other RPCs (and a transcripts
   * function that predates the speaker migration) ignore the key.
   */
  speakerOnly?: boolean;
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
    embedPlannedQueries(original, plan),
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
    ...(input.speakerOnly ? { speaker_only: true } : {}),
  };

  const callOne = (fn: BatchFunction, cons: Record<string, unknown>) =>
    rpcOrThrow<RetrievedCandidate[] | null>(
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
      { stage: `retrieval:batch:${fn}`, requestId },
    ).then((rows) => {
      const out = rows ?? [];
      // A table that fills its whole budget probably has more relevant rows
      // waiting behind the cut. Logged so the ceiling is raised from
      // evidence, not from a hunch.
      if (out.length >= limitFor(fn)) {
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
      return out;
    });

  const groups = await Promise.all(toCall.map((fn) => callOne(fn, constraints)));
  let tableRpcCount = toCall.length;

  // ── Fail open, never closed ──
  // A scripture filter that empties BOTH scripture sources while the
  // unconstrained sources found rows has misread the question, not answered it.
  // Re-run only the scripture-filtered calls without the constraint and merge.
  // An empty result set caused by a filter is always a bug, never an answer.
  const hasScriptureConstraint = plan.constraints.scripture_references.length > 0;
  if (hasScriptureConstraint) {
    const scriptureRows = toCall.reduce(
      (n, fn, i) => n + (SCRIPTURE_FILTERED.includes(fn) ? groups[i].length : 0),
      0,
    );
    const otherRows = toCall.reduce(
      (n, fn, i) => n + (SCRIPTURE_FILTERED.includes(fn) ? 0 : groups[i].length),
      0,
    );
    if (scriptureRows === 0 && otherRows > 0) {
      console.info(
        JSON.stringify({
          level: "info",
          event: "search.constraint_failed_open",
          requestId,
          constraint: plan.constraints.scripture_references,
        }),
      );
      const unconstrained = { ...constraints, scripture_references: [] };
      const retried = SCRIPTURE_FILTERED.filter((fn) => toCall.includes(fn));
      const reopened = await Promise.all(retried.map((fn) => callOne(fn, unconstrained)));
      tableRpcCount += retried.length;
      retried.forEach((fn, i) => {
        groups[toCall.indexOf(fn)] = reopened[i];
      });
    }
  }

  return {
    groups,
    tableRpcCount,
    vocabularyRpcCount: plan.vocabulary_candidates.length > 0 ? 1 : 0,
    embeddingProviderCalls: embedded.providerCalls,
    resolvedSlugs: slugs,
    semanticAvailable: embedded.embeddingAvailable,
    candidateCount: groups.reduce((n, g) => n + g.length, 0),
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
