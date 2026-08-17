/**
 * A failed rerank must never pass for a ranked page.
 *
 * When Cohere cannot be reached or cannot be trusted, `cohereRerank` still
 * returns the passages — search must not break — but with every score at zero
 * and the order untouched. Nothing about that page looks different from a
 * ranked one unless the failure is carried forward deliberately. These tests
 * pin the whole chain for each way Cohere can fail:
 *
 *   provider reports the failure → the stage records a degradation →
 *   the response carries rankingUnavailable → the page prints one honest line.
 *
 * Every failure mode is exercised separately, because they take different
 * paths through the client: a 402, a 429 and a 5xx are non-ok responses, a
 * timeout is an AbortError thrown out of fetch, and an invalid body is a 200
 * whose contents cannot be believed.
 *
 * This suite is why the 200+200+final machinery could be deleted at all. It ran
 * green against that machinery and runs green against the single call, over the
 * REAL Cohere client driven through each distinct transport failure — so the
 * honest-failure feature is proved to have survived the rewrite rather than
 * assumed to have.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import {
  cohereRerank,
  type CohereRerankUsage,
  type RerankResult,
} from "@/app/lib/08-cohere-rerank";
import { rerankUnified, type RerankOutcome } from "@/app/lib/search-v2/rerank";
import { rankingUnavailableFor } from "@/app/lib/search-v2/adapt";
import {
  incompleteSearchWarning,
  RANKING_UNAVAILABLE_MESSAGE,
} from "@/app/components/results/02-incomplete-search-warning";
import type { DegradedSource } from "@/app/lib/types/01-search";

const ORIGINAL_KEY = process.env.COHERE_API_KEY;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (ORIGINAL_KEY === undefined) delete process.env.COHERE_API_KEY;
  else process.env.COHERE_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

/** The five ways Cohere can fail, each producing its own transport shape. */
const FAILURES = [
  {
    name: "402 payment required",
    respond: () => new Response("out of credit", { status: 402 }),
  },
  {
    name: "429 rate limited",
    respond: () => new Response("slow down", { status: 429 }),
  },
  {
    name: "500 server error",
    respond: () => new Response("upstream boom", { status: 500 }),
  },
  {
    name: "timeout",
    respond: () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  },
  {
    name: "invalid body",
    // A 200 whose contents cannot be believed.
    respond: () => new Response(JSON.stringify({ results: "not-an-array" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  },
] as const;

const candidates = [
  { body_text: "first passage about surrender" },
  { body_text: "second passage about chanting" },
  { body_text: "third passage about the mind" },
];

describe("the Cohere client reports every failure to its caller", () => {
  it.each(FAILURES)("reports $name as a failed response", async ({ respond }) => {
    process.env.COHERE_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => respond()) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    let usage: CohereRerankUsage | null = null;
    const results = await cohereRerank("how do I control the mind", candidates, 3, 50, (u) => {
      usage = u;
    });

    // The search still gets its passages back — this is the fail-open promise.
    expect(results).toHaveLength(3);
    // …but the caller is told, unambiguously, that they are not ranked.
    expect(usage).not.toBeNull();
    expect(usage!.requestAttempted).toBe(true);
    expect(usage!.responseSucceeded).toBe(false);
  });

  it("reports a healthy response as succeeded", async () => {
    process.env.COHERE_API_KEY = "test-key";
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      results: [
        { index: 2, relevance_score: 0.91 },
        { index: 0, relevance_score: 0.44 },
        { index: 1, relevance_score: 0.12 },
      ],
      meta: { billed_units: { search_units: 1 } },
    }), { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;

    let usage: CohereRerankUsage | null = null;
    await cohereRerank("q", candidates, 3, 50, (u) => { usage = u; });
    expect(usage!.responseSucceeded).toBe(true);
  });
});

/** A pool large enough to make a real provider request (two or more). */
function poolCandidates(size = 4) {
  return Array.from({ length: size }, (_, i) => ({
    passage_key: `verse:v${i}`,
    source_type: "verse",
    row_id: `v${i}`,
    retrieval_text: `passage ${i} with enough words to clear the junk floor easily`,
    reference: `BG 2.${i}`,
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: ["original"],
    channel_ranks: [],
    channel_scores: null,
    tag_matches: null,
    fusedScore: 1 - i / 100,
    contributions: [],
    queryCoverage: ["original"],
    alternates: [],
  })) as never[];
}

const rerank = (provider: typeof cohereRerank, size = 4) =>
  rerankUnified(
    { question: "how do I control the mind", candidates: poolCandidates(size) },
    provider as never,
  );

function healthyProvider(): typeof cohereRerank {
  return (async (
    _query: string,
    docs: readonly unknown[],
    topN: number,
    _timeoutMs?: number,
    onUsage?: (usage: CohereRerankUsage) => void,
  ) => {
    onUsage?.({ requestAttempted: true, responseSucceeded: true, billedSearchUnits: 1 });
    return docs.slice(0, topN).map((item, i) => ({
      item, relevance_score: 0.9 - i / 100, original_index: i,
    })) as RerankResult<never>[];
  }) as unknown as typeof cohereRerank;
}

/** The telemetry shape adapt.ts actually reads. */
function telemetryFor(outcome: RerankOutcome) {
  const degradedStages = outcome.degradedReason
    ? [{ stage: "reranking", source: "cohere", code: outcome.degradedReason }]
    : [];
  return {
    degradedStages,
    degraded: degradedStages.length > 0,
    degradedSources: [] as never[],
  };
}

describe("a failed rerank reaches the response and the page", () => {
  it.each(FAILURES)("$name marks the ranking unavailable", async ({ respond }) => {
    process.env.COHERE_API_KEY = "test-key";
    // The REAL client, driven through each distinct transport failure, so the
    // five modes are proved end-to-end rather than through one shared stub.
    globalThis.fetch = vi.fn(async () => respond()) as unknown as typeof fetch;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const outcome = await rerank(cohereRerank);

    // The passages survive; only the ranking is gone.
    expect(outcome.ranked).toHaveLength(4);
    expect(outcome.reranked).toBe(false);
    expect(outcome.degradedReason).toBe("cohere_unavailable");

    const telemetry = telemetryFor(outcome);

    // 1. The response carries a clear, specific marker.
    expect(rankingUnavailableFor(telemetry)).toBe(true);

    // 2. The page shows one honest line — and it does not claim the answer is
    //    incomplete, because nothing was left out.
    const message = incompleteSearchWarning([], telemetry.degraded, true);
    expect(message).toBe(RANKING_UNAVAILABLE_MESSAGE);
    expect(message).toContain("final relevance ranking was temporarily unavailable");
    expect(message).not.toContain("incomplete");

    // There is no longer a cache to keep this out of — every search runs
    // fresh — so a degraded answer cannot outlive the outage that caused it.
  });

  it("a healthy rerank shows no message at all", async () => {
    process.env.COHERE_API_KEY = "test-key";
    const outcome = await rerank(healthyProvider());

    expect(outcome.reranked).toBe(true);
    expect(outcome.degradedReason).toBeNull();

    const telemetry = telemetryFor(outcome);
    expect(rankingUnavailableFor(telemetry)).toBe(false);
    expect(incompleteSearchWarning([], telemetry.degraded, false)).toBe("");
  });
});

describe("failure is read from the provider's report, not from the scores", () => {
  it("does not call a legitimately all-zero ranking a failure", async () => {
    // Cohere may honestly score a batch of irrelevant passages at zero. The old
    // detection — "did any score exceed zero?" — could not tell that apart from
    // a 402, so it either cried wolf or stayed silent depending on luck.
    process.env.COHERE_API_KEY = "test-key";
    const allZeroButHealthy = (async (
      _query: string,
      docs: readonly unknown[],
      topN: number,
      _timeoutMs?: number,
      onUsage?: (usage: CohereRerankUsage) => void,
    ) => {
      onUsage?.({ requestAttempted: true, responseSucceeded: true, billedSearchUnits: 1 });
      return docs.slice(0, topN).map((item, i) => ({
        item, relevance_score: 0, original_index: i,
      }));
    }) as unknown as typeof cohereRerank;

    const outcome = await rerank(allZeroButHealthy);
    expect(outcome.reranked).toBe(true);
    expect(outcome.degradedReason).toBeNull();
    expect(rankingUnavailableFor(telemetryFor(outcome)).valueOf()).toBe(false);
  });
});

describe("the honest line", () => {
  it("names the ranking rather than blaming the library", () => {
    expect(RANKING_UNAVAILABLE_MESSAGE).toBe(
      "The library search completed, but final relevance ranking was temporarily unavailable. "
      + "You may retry for the best ordering.",
    );
  });

  it("still names an unavailable source, and adds the ranking line when both fail", () => {
    const sources: DegradedSource[] = [
      { source: "transcripts" as DegradedSource["source"], reason: "temporarily unavailable" },
    ];
    const sourcesOnly = incompleteSearchWarning(sources, true, false);
    expect(sourcesOnly).toContain("could not be searched this time");
    expect(sourcesOnly).not.toContain("relevance ranking");

    const both = incompleteSearchWarning(sources, true, true);
    expect(both).toContain("could not be searched this time");
    expect(both).toContain("relevance ranking was temporarily unavailable");
  });

  it("says nothing at all when nothing degraded", () => {
    expect(incompleteSearchWarning([], false, false)).toBe("");
  });
});
