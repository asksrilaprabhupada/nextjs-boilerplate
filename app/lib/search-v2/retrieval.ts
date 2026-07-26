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
import { cached, cacheKeys, TTL } from "@/app/lib/search-v2/cache";

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

  for (const w of wanted) {
    const hit = await cached<number[] | null>(cacheKeys.embedding(model, w.text), TTL.embedding, async () => null);
    if (hit && hit.length > 0) resolved.set(w.id, hit);
    else missing.push(w);
  }

  let providerCalls = 0;
  if (missing.length > 0) {
    providerCalls = 1;
    const vectors = await embedQueries(missing.map((m) => m.text));
    for (let i = 0; i < missing.length; i++) {
      const v = vectors[i] ?? [];
      if (v.length > 0) {
        resolved.set(missing[i].id, v);
        const { getCacheAdapter } = await import("@/app/lib/search-v2/cache");
        try {
          const store = await getCacheAdapter();
          await store.set(cacheKeys.embedding(model, missing[i].text), v, TTL.embedding);
        } catch {
          // Cache write failures never affect the search.
        }
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

const BATCH_FUNCTIONS = [
  "search_verses_hybrid_batch_v2",
  "search_verse_chunks_hybrid_batch_v2",
  "search_prose_hybrid_batch_v2",
  "search_transcripts_hybrid_batch_v2",
  "search_letters_hybrid_batch_v2",
] as const;

export type BatchFunction = (typeof BATCH_FUNCTIONS)[number];

/** Table-level source filtering, so a `source_types` constraint can skip a call. */
const FUNCTION_SOURCES: Record<BatchFunction, string[]> = {
  search_verses_hybrid_batch_v2: ["verse"],
  search_verse_chunks_hybrid_batch_v2: ["purport"],
  search_prose_hybrid_batch_v2: ["book"],
  search_transcripts_hybrid_batch_v2: ["lecture", "conversation"],
  search_letters_hybrid_batch_v2: ["letter"],
};

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
  const perTableLimit = input.perTableLimit ?? SEARCH_V2_CONFIG.perTableLimit;

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

  const constraints = {
    scripture_references: plan.constraints.scripture_references,
    recipient: plan.constraints.recipient,
    location: plan.constraints.location,
    date_from: plan.constraints.date_from,
    date_to: plan.constraints.date_to,
  };

  const groups = await Promise.all(
    toCall.map((fn) =>
      rpcOrThrow<RetrievedCandidate[] | null>(
        db,
        fn,
        {
          p_queries: payload,
          p_lexical_phrases: plan.lexical_phrases,
          p_tag_slugs: slugs,
          p_constraints: constraints,
          p_limit: perTableLimit,
        },
        { stage: `retrieval:batch:${fn}`, requestId },
      ).then((rows) => rows ?? []),
    ),
  );

  return {
    groups,
    tableRpcCount: toCall.length,
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
