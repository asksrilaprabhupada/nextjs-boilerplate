/** Provider-boundary tests. Fetch is always mocked; these tests cannot spend money. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COHERE_RERANK_MODEL,
  cohereRerank,
  type CohereRerankUsage,
} from "@/app/lib/08-cohere-rerank";

let previousKey: string | undefined;

beforeEach(() => {
  previousKey = process.env.COHERE_API_KEY;
  process.env.COHERE_API_KEY = "unit-test-placeholder";
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (previousKey === undefined) delete process.env.COHERE_API_KEY;
  else process.env.COHERE_API_KEY = previousKey;
});

describe("Cohere rerank accounting", () => {
  it("reports the exact model and provider-billed search units", async () => {
    const usages: CohereRerankUsage[] = [];
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe(COHERE_RERANK_MODEL);
      expect(body.top_n).toBe(2);
      return new Response(JSON.stringify({
        results: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.5 },
        ],
        meta: { billed_units: { search_units: 3 } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await cohereRerank(
      "test",
      [{ body_text: "first" }, { body_text: "second" }],
      2,
      1_000,
      (usage) => usages.push(usage),
    );

    expect(results.map((result) => result.original_index)).toEqual([1, 0]);
    expect(usages).toEqual([{
      requestAttempted: true,
      responseSucceeded: true,
      billedSearchUnits: 3,
    }]);
  });

  it("marks an HTTP failure unusable and preserves the fallback order", async () => {
    const usages: CohereRerankUsage[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));
    const candidates = [{ body_text: "first" }, { body_text: "second" }];

    const results = await cohereRerank(
      "test",
      candidates,
      2,
      1_000,
      (usage) => usages.push(usage),
    );

    expect(results.map((result) => result.item)).toEqual(candidates);
    expect(usages).toEqual([{
      requestAttempted: true,
      responseSucceeded: false,
      billedSearchUnits: null,
    }]);
  });

  it("marks a partial 2xx result set unusable for comparison accounting", async () => {
    const usages: CohereRerankUsage[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ index: 1, relevance_score: 0.9 }],
      meta: { billed_units: { search_units: 3 } },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await cohereRerank(
      "test",
      [{ body_text: "first" }, { body_text: "second" }],
      2,
      1_000,
      (usage) => usages.push(usage),
    );

    expect(usages).toEqual([{
      requestAttempted: true,
      responseSucceeded: false,
      billedSearchUnits: null,
    }]);
  });

  it("does not let an accounting observer break search", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      results: [{ index: 0, relevance_score: 0.8 }, { index: 1, relevance_score: 0.7 }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(cohereRerank(
      "test",
      [{ body_text: "first" }, { body_text: "second" }],
      2,
      1_000,
      () => { throw new Error("observer failed"); },
    )).resolves.toHaveLength(2);
  });
});
