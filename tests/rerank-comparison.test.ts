/**
 * rerank-comparison.test.ts — Proof that A2 is a real two-arm comparison.
 *
 * Provider calls are fully injected. These tests spend no money and make no
 * network or database request.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CohereRerankUsage,
  RerankCandidate,
  RerankResult,
} from "@/app/lib/08-cohere-rerank";
import { dedupeCandidates, type DedupedCandidate } from "@/app/lib/search-v2/dedup";
import { fuseWeighted, type RetrievedCandidate } from "@/app/lib/search-v2/fusion";
import {
  RERANK_ARMS,
  buildPrivateRerankPoolArtifact,
  compareRerankArms,
  parseRerankArm,
  prepareRerankPool,
  rerankCurrentPool,
  runRerankComparisonArm,
  type PreparedRerankDocument,
  type ComparisonOnlyRerankOutcome,
  type RerankArmImplementations,
  type RerankOutcome,
  type RerankProvider,
} from "@/app/lib/search-v2/rerank";

function retrieved(index: number, pinned = false): RetrievedCandidate {
  const suffix = String(index).padStart(3, "0");
  return {
    passage_key: `lecture:${suffix}`,
    source_type: "lecture",
    row_id: suffix,
    retrieval_text: `Distinct stored corpus passage number ${suffix}, long enough to be a real candidate.`,
    reference: `Lecture ${suffix}`,
    speaker: "Prabhupada",
    recipient: null,
    occurred_on: "1972-01-01",
    location: "Test location",
    matched_query_ids: ["q_orig"],
    channel_ranks: [{ query_id: "q_orig", channel: "semantic", rank: index + 1 }],
    channel_scores: { semantic: 1 - index / 1000 },
    tag_matches: 0,
    pinned,
  };
}

function candidates(count: number, pinnedIndex = -1): DedupedCandidate[] {
  return dedupeCandidates(
    fuseWeighted(
      [Array.from({ length: count }, (_, index) => retrieved(index, index === pinnedIndex))],
      { q_orig: "original" },
    ),
  ).candidates;
}

interface ProviderCall {
  query: string;
  documents: PreparedRerankDocument[];
  topN: number;
  timeoutMs: number | undefined;
}

function recordingProvider(calls: ProviderCall[]): RerankProvider {
  return async <T extends RerankCandidate>(
    query: string,
    documents: T[],
    topN = 20,
    timeoutMs?: number,
    onUsage?: (usage: CohereRerankUsage) => void,
  ): Promise<RerankResult<T>[]> => {
    calls.push({
      query,
      documents: documents.map((document) => ({
        body_text: String(document.body_text ?? ""),
        __key: String((document as T & { __key?: string }).__key ?? ""),
      })),
      topN,
      timeoutMs,
    });
    onUsage?.({
      requestAttempted: true,
      responseSucceeded: true,
      billedSearchUnits: Math.ceil(documents.length / 100),
    });
    return documents
      .map((item, originalIndex) => {
        const key = String((item as T & { __key?: string }).__key ?? "");
        const numeric = Number(key.split(":")[1] ?? originalIndex);
        return {
          item,
          relevance_score: Math.max(0.001, 1 - numeric / 1000),
          original_index: originalIndex,
        };
      })
      .sort((a, b) => b.relevance_score - a.relevance_score)
      .slice(0, topN);
  };
}

const noResult = (ranked: DedupedCandidate[] = []): RerankOutcome => ({
  ranked: ranked.map((candidate) => ({ ...candidate, rerankScore: null })),
  reranked: false,
  degradedReason: null,
  documentCount: 0,
  providerCallCount: 0,
  providerRequests: [],
  model: "rerank-v4.0-pro",
});

const noComparisonResult = (top: DedupedCandidate[] = []): ComparisonOnlyRerankOutcome => ({
  top: top.map((candidate) => ({ ...candidate, rerankScore: null })),
  reranked: false,
  degradedReason: null,
  documentCount: 0,
  providerCallCount: 0,
  providerRequests: [],
  model: "rerank-v4.0-pro",
});

let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env.COHERE_API_KEY;
  process.env.COHERE_API_KEY = "unit-test-placeholder";
});

afterEach(() => {
  if (previousKey === undefined) delete process.env.COHERE_API_KEY;
  else process.env.COHERE_API_KEY = previousKey;
});

describe("A2 rerank arms", () => {
  it("uses one prepared 400-document pool for two real call graphs", async () => {
    const calls: ProviderCall[] = [];
    const inputCandidates = candidates(400);
    const inputIdentity = inputCandidates.map((candidate) => ({
      passageId: candidate.passage_key,
      text: candidate.retrieval_text,
    }));
    const outcome = await compareRerankArms(
      { question: "What is devotional service?", candidates: inputCandidates },
      { provider: recordingProvider(calls) },
    );

    expect(calls.map((call) => call.documents.length)).toEqual([200, 200, 200, 400]);
    expect(calls.map((call) => call.topN)).toEqual([200, 200, 200, 20]);
    expect(outcome.current.providerCallCount).toBe(3);
    expect(outcome.current.documentCount).toBe(600);
    expect(outcome.current.providerRequests).toEqual([
      { documentCount: 200, topN: 200, responseSucceeded: true, billedSearchUnits: 2 },
      { documentCount: 200, topN: 200, responseSucceeded: true, billedSearchUnits: 2 },
      { documentCount: 200, topN: 200, responseSucceeded: true, billedSearchUnits: 2 },
    ]);
    expect(outcome.global.providerCallCount).toBe(1);
    expect(outcome.global.documentCount).toBe(400);
    expect(outcome.global.providerRequests).toEqual([
      { documentCount: 400, topN: 20, responseSucceeded: true, billedSearchUnits: 4 },
    ]);
    expect(outcome.current.top).toHaveLength(20);
    expect(outcome.global.top).toHaveLength(20);

    const firstPassDocuments = [...calls[0].documents, ...calls[1].documents];
    expect(firstPassDocuments).toEqual(calls[3].documents);
    expect(calls.every((call) => call.query === outcome.pool.question)).toBe(true);
    expect(outcome.pool.documents).toEqual(calls[3].documents);
    expect(inputCandidates.map((candidate) => ({
      passageId: candidate.passage_key,
      text: candidate.retrieval_text,
    }))).toEqual(inputIdentity);
  });

  it("keeps the current arm's pinned-outside-200 edge exactly", async () => {
    const calls: ProviderCall[] = [];
    const pool = prepareRerankPool({
      question: "BG 18.66",
      candidates: candidates(400, 399),
    });
    const outcome = await rerankCurrentPool(pool, recordingProvider(calls));

    expect(calls.map((call) => call.documents.length)).toEqual([200, 200, 201]);
    expect(calls[2].documents.some((document) => document.__key === "lecture:399")).toBe(true);
    expect(outcome.providerCallCount).toBe(3);
    expect(outcome.documentCount).toBe(601);
  });

  it("dispatches current and global labels to different implementations", async () => {
    const pool = prepareRerankPool({ question: "test", candidates: candidates(2) });
    const current = vi.fn(async (receivedPool: typeof pool) => noResult(receivedPool.candidates));
    const global = vi.fn(async (receivedPool: typeof pool) => noComparisonResult(receivedPool.candidates.slice(0, 1)));
    const implementations: RerankArmImplementations = { current, global };
    const provider = recordingProvider([]);

    await runRerankComparisonArm(RERANK_ARMS.current, pool, { implementations, provider });
    expect(current).toHaveBeenCalledOnce();
    expect(global).not.toHaveBeenCalled();

    await runRerankComparisonArm(RERANK_ARMS.global, pool, { implementations, provider });
    expect(global).toHaveBeenCalledOnce();
    expect(current).toHaveBeenCalledOnce();
    expect(current.mock.calls[0][0]).toBe(pool);
    expect(global.mock.calls[0][0]).toBe(pool);
  });

  it("rejects an unknown arm instead of relabeling the current path", () => {
    expect(() => parseRerankArm("original-only")).toThrow("Unknown rerank arm");
  });

  it("builds a stable private replay artifact with exact ids and documents", () => {
    const pool = prepareRerankPool({ question: "test", candidates: candidates(3) });
    const first = buildPrivateRerankPoolArtifact(pool);
    const second = buildPrivateRerankPoolArtifact(pool);

    expect(first).toEqual(second);
    expect(first.poolSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.candidates.map((candidate) => candidate.passageId)).toEqual([
      "lecture:000",
      "lecture:001",
      "lecture:002",
    ]);
    expect(first.candidates.every((candidate) => candidate.document.includes(candidate.passageId))).toBe(true);
  });

  it("includes the pinned state in the replay identity", () => {
    const plain = candidates(2);
    const withPin = plain.map((candidate, index) => ({
      ...candidate,
      pinned: index === 1,
    }));
    expect(prepareRerankPool({ question: "test", candidates: plain }).poolSha256)
      .not.toBe(prepareRerankPool({ question: "test", candidates: withPin }).poolSha256);
  });

  it("can alternate arm order without changing which outcome is production", async () => {
    const order: string[] = [];
    const poolCandidates = candidates(2);
    const implementations: RerankArmImplementations = {
      current: async () => {
        order.push("current");
        return noResult(poolCandidates);
      },
      global: async () => {
        order.push("global");
        return noComparisonResult(poolCandidates.slice(0, 1));
      },
    };
    const outcome = await compareRerankArms(
      { question: "test", candidates: poolCandidates },
      {
        implementations,
        provider: recordingProvider([]),
        armOrder: [RERANK_ARMS.global, RERANK_ARMS.current],
      },
    );
    expect(order).toEqual(["global", "current"]);
    expect(outcome.productionOutcome.ranked).toHaveLength(2);
    expect(outcome.global.top).toHaveLength(1);
  });

  it("records a failed final provider response for the paid-run validity gate", async () => {
    const failingFinalProvider = (): RerankProvider => {
      let call = 0;
      const successful = recordingProvider([]);
      return async (query, documents, topN, timeoutMs, onUsage) => {
        call += 1;
        if (call < 3) return successful(query, documents, topN, timeoutMs, onUsage);
        onUsage?.({ requestAttempted: true, responseSucceeded: false, billedSearchUnits: null });
        return documents.slice(0, topN).map((item, original_index) => ({
          item,
          original_index,
          relevance_score: 0,
        }));
      };
    };
    const pool = prepareRerankPool({ question: "test", candidates: candidates(400) });
    const outcome = await rerankCurrentPool(
      pool,
      failingFinalProvider(),
    );
    expect(outcome.providerRequests.map((request) => request.responseSucceeded))
      .toEqual([true, true, false]);
    expect(outcome.degradedReason).toBeNull();

    const comparisonView = await runRerankComparisonArm(RERANK_ARMS.current, pool, {
      provider: failingFinalProvider(),
    });
    expect(comparisonView.degradedReason).toBe("cohere_invalid_provider_response_1");
  });
});
