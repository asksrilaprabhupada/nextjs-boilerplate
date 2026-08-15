/**
 * rerank.ts — Production reranking plus a private, explicit A/B seam.
 *
 * Production continues to use the current method: judge the deduplicated pool
 * in batches of 200, combine those scores, then judge the best 200 once more.
 * A pinned exact-reference passage joins that final pool if it fell outside the
 * best 200, so the edge-case final request contains 201 documents.
 *
 * The proposed comparison arm makes one request over the same prepared pool and
 * asks for its top 20. It is reachable only through exported server-side test
 * helpers. No URL parameter, environment flag, or public route selects it.
 *
 * {@link prepareRerankPool} serialises candidates exactly once. The private
 * comparison runner hands that one in-memory object to both arms and can save
 * the exact documents and stable namespaced passage ids in a local artifact.
 */
import { createHash } from "node:crypto";
import {
  COHERE_RERANK_MODEL,
  cohereRerank,
  type RerankCandidate,
  type RerankResult,
  type CohereRerankUsage,
} from "@/app/lib/08-cohere-rerank";
import type { DedupedCandidate } from "@/app/lib/search-v2/dedup";

/** A candidate carrying the reranker's judgement. Null when it was never judged. */
export interface RankedCandidate extends DedupedCandidate {
  rerankScore: number | null;
}

/** Each current-arm first pass contains at most 200 documents. */
export const RERANK_BATCH_SIZE = 200;

/** The current arm's second pass re-judges the best 200 first-pass results. */
export const RERANK_FINAL_POOL = 200;

/** Both arms are compared on the same final output goal. */
export const RERANK_COMPARISON_TOP_N = 20;

/** A large single request needs more time than one 200-document batch. */
const FINAL_PASS_TIMEOUT_MS = 25_000;
const GLOBAL_PASS_TIMEOUT_MS = 50_000;

export interface RerankOutcome {
  ranked: RankedCandidate[];
  /** True when Cohere ran and produced a genuine ordering. */
  reranked: boolean;
  degradedReason: string | null;
  /** Documents actually submitted to a network-capable provider call. */
  documentCount: number;
  /** Network-capable provider calls attempted, including failed responses. */
  providerCallCount: number;
  /** Exact attempted request shapes for billing and audit evidence. */
  providerRequests: RerankProviderRequest[];
  /** The model the low-level client actually places on the request. */
  model: string;
}

/** The generic provider shape gives tests a no-network request seam. */
export type RerankProvider = <T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topN?: number,
  timeoutMs?: number,
  onUsage?: (usage: CohereRerankUsage) => void,
) => Promise<RerankResult<T>[]>;

export interface RerankProviderRequest {
  documentCount: number;
  topN: number;
  /** Null until the observer sees a complete provider response. */
  responseSucceeded: boolean | null;
  /** Exact value from Cohere response metadata; null when unavailable. */
  billedSearchUnits: number | null;
}

/** The exact document object sent to the provider. */
export interface PreparedRerankDocument {
  body_text: string;
  __key: string;
}

/**
 * One immutable-by-convention input shared by the two comparison arms.
 * `candidates` and `documents` have matching indexes.
 */
export interface PreparedRerankPool {
  question: string;
  candidates: DedupedCandidate[];
  documents: PreparedRerankDocument[];
  model: typeof COHERE_RERANK_MODEL;
  poolSha256: string;
}

export interface RerankInput {
  /** The devotee's ORIGINAL question. Never a subquery, never a canonicalisation. */
  question: string;
  candidates: DedupedCandidate[];
}

export const RERANK_ARMS = {
  current: "current",
  global: "global",
} as const;

export type RerankArm = typeof RERANK_ARMS[keyof typeof RERANK_ARMS];

/** Comparison-only shape: it cannot be returned to the production pipeline. */
export interface ComparisonOnlyRerankOutcome {
  top: RankedCandidate[];
  reranked: boolean;
  degradedReason: string | null;
  documentCount: number;
  providerCallCount: number;
  providerRequests: RerankProviderRequest[];
  model: string;
}

export interface RerankComparisonArmOutcome extends ComparisonOnlyRerankOutcome {
  arm: RerankArm;
  topN: number;
  durationMs: number;
}

export interface RerankComparisonOutcome {
  /** The same object reference was passed to both arm implementations. */
  pool: PreparedRerankPool;
  current: RerankComparisonArmOutcome;
  global: RerankComparisonArmOutcome;
  /** The only comparison result allowed to continue through the pipeline. */
  productionOutcome: RerankOutcome;
}

/** Private artifact shape. It contains corpus text and must never cross the API. */
export interface PrivateRerankPoolArtifact {
  schemaVersion: "a2-rerank-pool-v1";
  question: string;
  model: string;
  poolSha256: string;
  candidateCount: number;
  candidates: Array<{
    passageId: string;
    sourceType: string;
    pinned: boolean;
    reference: string | null;
    recipient: string | null;
    occurredOn: string | null;
    location: string | null;
    alternatePassageIds: string[];
    documentSha256: string;
    documentBytes: number;
    document: string;
  }>;
}

/** Escapes a scalar for a YAML block. */
function yamlScalar(value: string): string {
  return value.replace(/\r/g, "").trim();
}

/** Indents a passage as a YAML literal block, preserving its line structure. */
function yamlBlock(text: string, indent = "  "): string {
  const body = yamlScalar(text) || "(no text)";
  return body
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

/**
 * One document, consistently shaped across source types. Fields that do not
 * apply are omitted rather than emitted empty.
 */
export function serialiseDocument(c: DedupedCandidate, maxChars = 4000): string {
  const lines: string[] = [
    `passage_id: ${yamlScalar(c.passage_key)}`,
    `source_type: ${yamlScalar(c.source_type)}`,
  ];
  if (c.reference) lines.push(`reference: ${yamlScalar(c.reference)}`);
  if (c.occurred_on) lines.push(`date: ${yamlScalar(c.occurred_on)}`);
  if (c.recipient) lines.push(`recipient: ${yamlScalar(c.recipient)}`);
  if (c.location) lines.push(`location: ${yamlScalar(c.location)}`);
  if (c.speaker) lines.push(`speaker: ${yamlScalar(c.speaker)}`);
  lines.push("text: |");
  lines.push(yamlBlock((c.retrieval_text || "").slice(0, maxChars)));
  return lines.join("\n");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Serialise and hash the ordered candidate pool exactly once. */
export function prepareRerankPool(input: RerankInput): PreparedRerankPool {
  const candidates = [...input.candidates];
  const documents = candidates.map((candidate) => ({
    body_text: serialiseDocument(candidate),
    __key: candidate.passage_key,
  }));
  const poolIdentity = JSON.stringify({
    question: input.question,
    model: COHERE_RERANK_MODEL,
    candidates: candidates.map((candidate, index) => ({
      passageId: candidate.passage_key,
      pinned: Boolean(candidate.pinned),
      alternatePassageIds: candidate.alternates.map((alternate) => alternate.passageKey),
      document: documents[index].body_text,
    })),
  });
  for (const document of documents) Object.freeze(document);
  Object.freeze(documents);
  Object.freeze(candidates);
  return Object.freeze({
    question: input.question,
    candidates,
    documents,
    model: COHERE_RERANK_MODEL,
    poolSha256: sha256(poolIdentity),
  });
}

/** Build the exact local-only replay artifact used by the paid comparison. */
export function buildPrivateRerankPoolArtifact(
  pool: PreparedRerankPool,
): PrivateRerankPoolArtifact {
  return {
    schemaVersion: "a2-rerank-pool-v1",
    question: pool.question,
    model: pool.model,
    poolSha256: pool.poolSha256,
    candidateCount: pool.candidates.length,
    candidates: pool.candidates.map((candidate, index) => {
      const document = pool.documents[index].body_text;
      return {
        passageId: candidate.passage_key,
        sourceType: candidate.source_type,
        pinned: Boolean(candidate.pinned),
        reference: candidate.reference,
        recipient: candidate.recipient,
        occurredOn: candidate.occurred_on,
        location: candidate.location,
        alternatePassageIds: candidate.alternates.map((alternate) => alternate.passageKey),
        documentSha256: sha256(document),
        documentBytes: Buffer.byteLength(document, "utf8"),
        document,
      };
    }),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const unranked = (candidates: DedupedCandidate[]): RankedCandidate[] =>
  candidates.map((candidate) => ({ ...candidate, rerankScore: null }));

function scoredCandidates(
  candidates: DedupedCandidate[],
  scoreByKey: Map<string, number>,
): RankedCandidate[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      rerankScore: scoreByKey.has(candidate.passage_key)
        ? scoreByKey.get(candidate.passage_key)!
        : null,
    }))
    .sort(
      (a, b) =>
        (b.rerankScore ?? -1) - (a.rerankScore ?? -1)
        || a.passage_key.localeCompare(b.passage_key),
    );
}

function emptyOutcome(
  candidates: DedupedCandidate[],
  degradedReason: string | null,
): RerankOutcome {
  return {
    ranked: unranked(candidates),
    reranked: false,
    degradedReason,
    documentCount: 0,
    providerCallCount: 0,
    providerRequests: [],
    model: COHERE_RERANK_MODEL,
  };
}

function emptyComparisonOutcome(
  candidates: DedupedCandidate[],
  degradedReason: string | null,
): ComparisonOnlyRerankOutcome {
  return {
    top: unranked(candidates),
    reranked: false,
    degradedReason,
    documentCount: 0,
    providerCallCount: 0,
    providerRequests: [],
    model: COHERE_RERANK_MODEL,
  };
}

/**
 * Arm A: the exact current production method.
 *
 * A singleton remainder batch still goes through the low-level helper so its
 * existing local score behavior is preserved, but it is not counted as a
 * network-capable provider request.
 */
export async function rerankCurrentPool(
  pool: PreparedRerankPool,
  provider: RerankProvider = cohereRerank,
): Promise<RerankOutcome> {
  const { question, candidates, documents } = pool;
  if (candidates.length <= 1) return emptyOutcome(candidates, null);
  if (!process.env.COHERE_API_KEY) return emptyOutcome(candidates, "cohere_api_key_absent");

  let documentCount = 0;
  let providerCallCount = 0;
  const providerRequests: RerankProviderRequest[] = [];
  try {
    const batches = chunk(documents, RERANK_BATCH_SIZE);
    const batchResults = await Promise.all(
      batches.map((batch) => {
        if (batch.length > 1) {
          providerCallCount += 1;
          documentCount += batch.length;
          const request: RerankProviderRequest = {
            documentCount: batch.length,
            topN: batch.length,
            responseSucceeded: null,
            billedSearchUnits: null,
          };
          providerRequests.push(request);
          return provider(
            question,
            batch,
            batch.length,
            undefined,
            (usage) => {
              request.responseSucceeded = usage.responseSucceeded;
              request.billedSearchUnits = usage.billedSearchUnits;
            },
          ).then((results) => ({ request, results }));
        }
        return provider(question, batch, batch.length)
          .then((results) => ({ request: null, results }));
      }),
    );

    const scoreByKey = new Map<string, number>();
    let deadBatches = 0;
    let networkBatches = 0;
    for (const { request, results } of batchResults) {
      // The provider itself reports whether a complete 2xx body was parsed.
      // That signal is authoritative and this code now believes it rather than
      // guessing from the scores: the old test — "did any score exceed zero?"
      // — cannot tell a 402, a 429, a 5xx, a timeout or a malformed body from a
      // batch of passages the cross-encoder honestly judged irrelevant, and it
      // is the only thing standing between a failed rerank and a page that
      // looks ranked.
      if (request) {
        networkBatches += 1;
        if (request.responseSucceeded === false) {
          deadBatches += 1;
          continue;
        }
      }
      for (const result of results) {
        scoreByKey.set(result.item.__key, result.relevance_score);
      }
    }

    // Every request that could have reached Cohere failed. The passages are
    // still real, but their order is arrival order and the answer must say so.
    if (networkBatches > 0 && deadBatches === networkBatches) {
      return {
        ...emptyOutcome(candidates, "cohere_unavailable"),
        documentCount,
        providerCallCount,
        providerRequests,
      };
    }

    if (scoreByKey.size === 0) {
      return {
        ...emptyOutcome(candidates, "cohere_unavailable"),
        documentCount,
        providerCallCount,
        providerRequests,
      };
    }

    const byFirstPass = [...candidates].sort(
      (a, b) =>
        (scoreByKey.get(b.passage_key) ?? -1) - (scoreByKey.get(a.passage_key) ?? -1)
        || a.passage_key.localeCompare(b.passage_key),
    );
    const finalists = byFirstPass.slice(0, RERANK_FINAL_POOL);
    const finalistKeys = new Set(finalists.map((candidate) => candidate.passage_key));
    for (const candidate of candidates) {
      if (candidate.pinned && !finalistKeys.has(candidate.passage_key)) {
        finalists.push(candidate);
        finalistKeys.add(candidate.passage_key);
      }
    }

    if (batches.length > 1 && finalists.length > 1) {
      const documentByKey = new Map(documents.map((document) => [document.__key, document]));
      const finalDocuments = finalists.map((candidate) => documentByKey.get(candidate.passage_key)!);
      providerCallCount += 1;
      documentCount += finalDocuments.length;
      const finalRequest: RerankProviderRequest = {
        documentCount: finalDocuments.length,
        topN: finalDocuments.length,
        responseSucceeded: null,
        billedSearchUnits: null,
      };
      providerRequests.push(finalRequest);
      const finalResults = await provider(
        question,
        finalDocuments,
        finalDocuments.length,
        FINAL_PASS_TIMEOUT_MS,
        (usage) => {
          finalRequest.responseSucceeded = usage.responseSucceeded;
          finalRequest.billedSearchUnits = usage.billedSearchUnits;
        },
      );
      // Same rule as the batches: trust the provider's own report, not the
      // shape of the scores.
      //
      // A failed FINAL pass is deliberately not counted as a dead batch. The
      // pool was still ranked by the first pass, so the page is ordered — just
      // not given its last refinement over the top slice. Calling that "the
      // relevance ranking was unavailable" would overstate it to a devotee,
      // and it would make an otherwise good answer uncacheable. The failure is
      // still recorded on providerRequests, where the spend gate reads it.
      if (finalRequest.responseSucceeded !== false) {
        for (const result of finalResults) {
          scoreByKey.set(result.item.__key, result.relevance_score);
        }
      }
    }

    return {
      ranked: scoredCandidates(candidates, scoreByKey),
      reranked: true,
      degradedReason: deadBatches > 0 ? `cohere_partial_${deadBatches}_batches` : null,
      documentCount,
      providerCallCount,
      providerRequests,
      model: COHERE_RERANK_MODEL,
    };
  } catch {
    return {
      ...emptyOutcome(candidates, "cohere_failed"),
      documentCount,
      providerCallCount,
      providerRequests,
    };
  }
}

/** Arm B: one global request over the prepared pool, returning its direct top N. */
export async function rerankGlobalPool(
  pool: PreparedRerankPool,
  topN = RERANK_COMPARISON_TOP_N,
  provider: RerankProvider = cohereRerank,
): Promise<ComparisonOnlyRerankOutcome> {
  const { question, candidates, documents } = pool;
  const wanted = Math.max(0, Math.min(Math.floor(topN), candidates.length));
  if (candidates.length <= 1 || wanted === 0) {
    return emptyComparisonOutcome(candidates.slice(0, wanted), null);
  }
  if (!process.env.COHERE_API_KEY) {
    return emptyComparisonOutcome(candidates.slice(0, wanted), "cohere_api_key_absent");
  }

  const request: RerankProviderRequest = {
    documentCount: documents.length,
    topN: wanted,
    responseSucceeded: null,
    billedSearchUnits: null,
  };
  try {
    const results = await provider(
      question,
      documents,
      wanted,
      GLOBAL_PASS_TIMEOUT_MS,
      (usage) => {
        request.responseSucceeded = usage.responseSucceeded;
        request.billedSearchUnits = usage.billedSearchUnits;
      },
    );
    if (!results.some((result) => result.relevance_score > 0)) {
      return {
        ...emptyComparisonOutcome(candidates.slice(0, wanted), "cohere_unavailable"),
        documentCount: documents.length,
        providerCallCount: 1,
        providerRequests: [request],
      };
    }
    const candidateByKey = new Map(candidates.map((candidate) => [candidate.passage_key, candidate]));
    const ranked = results.flatMap((result) => {
      const candidate = candidateByKey.get(result.item.__key);
      return candidate ? [{ ...candidate, rerankScore: result.relevance_score }] : [];
    });
    return {
      top: ranked,
      reranked: true,
      degradedReason: null,
      documentCount: documents.length,
      providerCallCount: 1,
      providerRequests: [request],
      model: COHERE_RERANK_MODEL,
    };
  } catch {
    return {
      ...emptyComparisonOutcome(candidates.slice(0, wanted), "cohere_failed"),
      documentCount: documents.length,
      providerCallCount: 1,
      providerRequests: [request],
    };
  }
}

export interface RerankArmImplementations {
  current: (pool: PreparedRerankPool, provider: RerankProvider) => Promise<RerankOutcome>;
  global: (
    pool: PreparedRerankPool,
    topN: number,
    provider: RerankProvider,
  ) => Promise<ComparisonOnlyRerankOutcome>;
}

const DEFAULT_ARM_IMPLEMENTATIONS: RerankArmImplementations = {
  current: rerankCurrentPool,
  global: rerankGlobalPool,
};

function comparisonDegradedReason(outcome: {
  degradedReason: string | null;
  providerRequests: RerankProviderRequest[];
}): string | null {
  const invalidResponses = outcome.providerRequests.filter(
    (request) => request.responseSucceeded !== true,
  ).length;
  if (invalidResponses === 0) return outcome.degradedReason;
  return outcome.degradedReason ?? `cohere_invalid_provider_response_${invalidResponses}`;
}

/** Reject report-label typos rather than silently running the current method. */
export function parseRerankArm(value: string): RerankArm {
  if (value === RERANK_ARMS.current || value === RERANK_ARMS.global) return value;
  throw new Error(`Unknown rerank arm: ${value}`);
}

/** Explicit dispatcher used by tests and the private comparison runner. */
export async function runRerankComparisonArm(
  arm: RerankArm,
  pool: PreparedRerankPool,
  options: {
    topN?: number;
    provider?: RerankProvider;
    implementations?: RerankArmImplementations;
  } = {},
): Promise<RerankComparisonArmOutcome> {
  const topN = options.topN ?? RERANK_COMPARISON_TOP_N;
  const provider = options.provider ?? cohereRerank;
  const implementations = options.implementations ?? DEFAULT_ARM_IMPLEMENTATIONS;
  const started = globalThis.performance.now();
  if (arm === RERANK_ARMS.current) {
    const outcome = await implementations.current(pool, provider);
    return {
      arm,
      topN,
      top: outcome.ranked.slice(0, topN),
      reranked: outcome.reranked,
      degradedReason: comparisonDegradedReason(outcome),
      documentCount: outcome.documentCount,
      providerCallCount: outcome.providerCallCount,
      providerRequests: outcome.providerRequests,
      model: outcome.model,
      durationMs: Math.round((globalThis.performance.now() - started) * 1000) / 1000,
    };
  }
  const outcome = await implementations.global(pool, topN, provider);
  return {
    ...outcome,
    degradedReason: comparisonDegradedReason(outcome),
    arm,
    topN,
    durationMs: Math.round((globalThis.performance.now() - started) * 1000) / 1000,
  };
}

/** Build one pool, then run both explicit arms against that same object. */
export async function compareRerankArms(
  input: RerankInput,
  options: {
    topN?: number;
    provider?: RerankProvider;
    implementations?: RerankArmImplementations;
    /** Alternate this across repeats so latency is not biased by a fixed order. */
    armOrder?: readonly [RerankArm, RerankArm];
    /** Called before either paid arm; used to checkpoint the private pool. */
    onPoolPrepared?: (pool: PreparedRerankPool) => void | Promise<void>;
  } = {},
): Promise<RerankComparisonOutcome> {
  const pool = prepareRerankPool(input);
  await options.onPoolPrepared?.(pool);
  const topN = options.topN ?? RERANK_COMPARISON_TOP_N;
  const provider = options.provider ?? cohereRerank;
  const implementations = options.implementations ?? DEFAULT_ARM_IMPLEMENTATIONS;
  const armOrder = options.armOrder ?? [RERANK_ARMS.current, RERANK_ARMS.global];
  if (new Set(armOrder).size !== 2
    || !armOrder.includes(RERANK_ARMS.current)
    || !armOrder.includes(RERANK_ARMS.global)) {
    throw new Error("A2 comparison order must contain current and global exactly once");
  }

  let productionOutcome: RerankOutcome | null = null;
  let current: RerankComparisonArmOutcome | null = null;
  let global: RerankComparisonArmOutcome | null = null;
  for (const arm of armOrder) {
    if (arm === RERANK_ARMS.current) {
      const currentStarted = globalThis.performance.now();
      productionOutcome = await implementations.current(pool, provider);
      current = {
        arm,
        topN,
        top: productionOutcome.ranked.slice(0, topN),
        reranked: productionOutcome.reranked,
        // Comparison validity uses provider telemetry. The production outcome
        // below remains byte-for-byte the current behavior returned downstream.
        degradedReason: comparisonDegradedReason(productionOutcome),
        documentCount: productionOutcome.documentCount,
        providerCallCount: productionOutcome.providerCallCount,
        providerRequests: productionOutcome.providerRequests,
        model: productionOutcome.model,
        durationMs: Math.round((globalThis.performance.now() - currentStarted) * 1000) / 1000,
      };
    } else {
      global = await runRerankComparisonArm(RERANK_ARMS.global, pool, {
        topN,
        provider,
        implementations,
      });
    }
  }
  if (!productionOutcome || !current || !global) {
    throw new Error("A2 comparison did not execute both arms");
  }
  return { pool, current, global, productionOutcome };
}

/** Production entry point. It remains hard-wired to the current arm. */
export async function rerankUnified(input: RerankInput): Promise<RerankOutcome> {
  return rerankCurrentPool(prepareRerankPool(input));
}
