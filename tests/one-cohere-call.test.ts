/**
 * one-cohere-call.test.ts — one request, the whole pool, the whole ranking back.
 *
 * Three things this pins, each of which was a real hazard in the rewrite:
 *
 *   - ONE request. Not batches of 200, not a second pass over the best 200.
 *   - The pool is whatever was retrieved, not a hard-coded 6 or 7 lanes' worth.
 *   - `top_n` is the POOL SIZE. Asking for 20 would return 20 results and leave
 *     every other passage unranked, and then "Dig Deeper, in the same rerank
 *     order" would be a sentence with nothing behind it.
 *
 * And the ceiling: 1,000 is a defensive bound, not an operating size. The five
 * per-source caps make ~700 the arithmetic maximum, so reaching it is a bug
 * report. It must be loud, and it must never be a silent trim.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  rerankUnified,
  RERANK_POOL_CEILING,
  DOCUMENT_MAX_CHARS,
  type RerankProvider,
} from "@/app/lib/search-v2/rerank";

const ORIGINAL_KEY = process.env.COHERE_API_KEY;
afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.COHERE_API_KEY;
  else process.env.COHERE_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

function candidates(size: number, textLength = 60) {
  return Array.from({ length: size }, (_, i) => ({
    passage_key: `verse:v${i}`,
    source_type: "verse",
    row_id: `v${i}`,
    retrieval_text: "x".repeat(textLength),
    reference: `BG 2.${i}`,
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: ["original"],
    channel_ranks: [],
    channel_scores: null,
    tag_matches: null,
    fusedScore: 1 - i / 1000,
    contributions: [],
    queryCoverage: ["original"],
    alternates: [],
  })) as never[];
}

/** Records every call, and reverses the order so a real ranking is visible. */
function recordingProvider() {
  const calls: Array<{ documentCount: number; topN: number }> = [];
  const provider = (async (
    _q: string,
    docs: readonly { __key: string }[],
    topN: number,
    _timeoutMs?: number,
    onUsage?: (u: { requestAttempted: boolean; responseSucceeded: boolean; billedSearchUnits: number | null }) => void,
  ) => {
    calls.push({ documentCount: docs.length, topN });
    onUsage?.({ requestAttempted: true, responseSucceeded: true, billedSearchUnits: 1 });
    return [...docs].reverse().map((item, i) => ({
      item, relevance_score: 1 - i / 10_000, original_index: i,
    }));
  }) as unknown as RerankProvider;
  return { calls, provider };
}

describe("one request over the whole pool", () => {
  it("makes exactly one call, carrying every candidate", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const { calls, provider } = recordingProvider();
    const out = await rerankUnified(
      { question: "how do I control my mind", candidates: candidates(700) },
      provider,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].documentCount).toBe(700);
    expect(out.providerCallCount).toBe(1);
    expect(out.documentCount).toBe(700);
    expect(out.reranked).toBe(true);
  });

  it("asks for the whole ranked pool, never a top 20", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const { calls, provider } = recordingProvider();
    const out = await rerankUnified({ question: "q", candidates: candidates(431) }, provider);

    expect(calls[0].topN).toBe(431);
    // Every passage comes back ranked, which is the only way Dig Deeper can
    // honestly be "in the same rerank order" as the main list.
    expect(out.ranked).toHaveLength(431);
    expect(out.ranked.every((c) => c.rerankScore !== null)).toBe(true);
  });

  it("returns Cohere's order, not the order it was handed", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const { provider } = recordingProvider(); // reverses
    const out = await rerankUnified({ question: "q", candidates: candidates(5) }, provider);
    expect(out.ranked.map((c) => c.passage_key)).toEqual([
      "verse:v4", "verse:v3", "verse:v2", "verse:v1", "verse:v0",
    ]);
  });

  it("keeps a passage Cohere did not return, scoreless, at the back", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const terse = (async (
      _q: string,
      docs: readonly { __key: string }[],
      _topN: number,
      _t?: number,
      onUsage?: (u: { requestAttempted: boolean; responseSucceeded: boolean; billedSearchUnits: number | null }) => void,
    ) => {
      onUsage?.({ requestAttempted: true, responseSucceeded: true, billedSearchUnits: 1 });
      return docs.slice(0, 3).map((item, i) => ({ item, relevance_score: 0.9 - i / 10, original_index: i }));
    }) as unknown as RerankProvider;

    const out = await rerankUnified({ question: "q", candidates: candidates(5) }, terse);
    expect(out.ranked).toHaveLength(5);
    expect(out.ranked.slice(3).every((c) => c.rerankScore === null)).toBe(true);
    expect(out.degradedReason).toBe("cohere_partial_2");
  });
});

describe("the defensive ceiling is a bug report, never a silent trim", () => {
  it("says so loudly, in telemetry and in the log", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((line) => { errors.push(String(line)); });
    const { calls, provider } = recordingProvider();

    const over = RERANK_POOL_CEILING + 37;
    const out = await rerankUnified(
      { question: "q", candidates: candidates(over), requestId: "req_ceiling" },
      provider,
    );

    expect(calls[0].documentCount).toBe(RERANK_POOL_CEILING);
    expect(out.degradedReason).toBe(`rerank_pool_ceiling_${over}`);
    const logged = errors.join(" ");
    expect(logged).toContain("rerank_pool_ceiling_hit");
    expect(logged).toContain(`"dropped":37`);
  });

  it("does not fire at the real operating size of about 700", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const { provider } = recordingProvider();
    const out = await rerankUnified({ question: "q", candidates: candidates(700) }, provider);
    expect(out.degradedReason).toBeNull();
  });
});

describe("truncation is counted, not assumed", () => {
  it("counts documents cut at our own character limit", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const { provider } = recordingProvider();
    const pool = [
      ...candidates(3, DOCUMENT_MAX_CHARS + 1),
      ...candidates(2, DOCUMENT_MAX_CHARS),
    ].map((c, i) => ({ ...(c as object), passage_key: `verse:x${i}` })) as never[];

    const out = await rerankUnified({ question: "q", candidates: pool }, provider);
    // Exactly the three over the limit. Cohere's own max_tokens_per_doc is
    // 4,096 TOKENS, which a 4,000-CHARACTER document cannot reach — ours is
    // the binding cut, so ours is the one that gets counted.
    expect(out.truncatedDocumentCount).toBe(3);
  });
});
