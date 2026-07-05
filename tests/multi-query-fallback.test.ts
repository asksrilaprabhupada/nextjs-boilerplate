/**
 * multi-query-fallback.test.ts — generateQueryVariants hardening tests
 *
 * The contract: on ANY failure (missing key, HTTP error, malformed JSON,
 * timeout) the expansion degrades to { variants: [], topic: null } and never
 * throws — the search proceeds with the original query alone. Success paths
 * validate dedupe/trim/cap via parseExpansion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateQueryVariants, parseExpansion } from "@/app/lib/16-multi-query";

const geminiPayload = (obj: unknown) => ({
  ok: true,
  json: async () => ({
    candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] } }],
  }),
});

describe("parseExpansion", () => {
  it("accepts a well-formed response and preserves order", () => {
    const out = parseExpansion(
      { variants: ["Why is the mind restless?", "Mind as friend and enemy"], topic: "controlling the mind" },
      "How to control the mind",
      10,
    );
    expect(out.variants).toEqual(["Why is the mind restless?", "Mind as friend and enemy"]);
    expect(out.topic).toBe("controlling the mind");
  });

  it("dedupes case-insensitively against the original and among variants, trims, and caps", () => {
    const out = parseExpansion(
      {
        variants: [
          "  how to control the MIND  ", // dup of original after trim/case
          "Why is the mind restless?",
          "why is the mind RESTLESS?", // dup of previous
          ...Array.from({ length: 12 }, (_, i) => `Angle ${i}`),
        ],
        topic: null,
      },
      "How to control the mind",
      10,
    );
    expect(out.variants[0]).toBe("Why is the mind restless?");
    expect(out.variants).toHaveLength(10);
    expect(new Set(out.variants.map(v => v.toLowerCase())).size).toBe(10);
  });

  it("tolerates a bare array and rejects junk topics", () => {
    expect(parseExpansion(["One", "Two"], "q", 10).variants).toEqual(["One", "Two"]);
    expect(parseExpansion({ variants: ["One"], topic: "x" }, "q", 10).topic).toBeNull(); // too short
    expect(parseExpansion({ variants: ["One"], topic: "a b c d e f g h" }, "q", 10).topic).toBeNull(); // too many words
    expect(parseExpansion({ variants: [1, null, "Real"] }, "q", 10).variants).toEqual(["Real"]);
    expect(parseExpansion("garbage", "q", 10)).toEqual({ variants: [], topic: null });
  });
});

describe("generateQueryVariants (fallback behaviour)", () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    process.env.GEMINI_API_KEY = "test-key";
    delete process.env.MULTIQUERY_ENABLED;
  });
  afterEach(() => {
    global.fetch = realFetch;
    vi.useRealTimers();
  });

  it("returns [] when the key is absent", async () => {
    delete process.env.GEMINI_API_KEY;
    expect(await generateQueryVariants("no key path")).toEqual({ variants: [], topic: null });
  });

  it("returns [] when disabled via MULTIQUERY_ENABLED=false", async () => {
    process.env.MULTIQUERY_ENABLED = "false";
    expect(await generateQueryVariants("disabled path")).toEqual({ variants: [], topic: null });
  });

  it("returns [] on HTTP error", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 })) as unknown as typeof fetch;
    expect(await generateQueryVariants("http 500 path")).toEqual({ variants: [], topic: null });
  });

  it("returns [] on network rejection", async () => {
    global.fetch = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
    expect(await generateQueryVariants("network path")).toEqual({ variants: [], topic: null });
  });

  it("returns [] on malformed JSON", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: "not json {{{" }] } }] }),
    })) as unknown as typeof fetch;
    expect(await generateQueryVariants("malformed path")).toEqual({ variants: [], topic: null });
  });

  it("aborts at the 4s hard timeout and returns []", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted.", "AbortError")),
          );
        }),
    ) as unknown as typeof fetch;
    const pending = generateQueryVariants("timeout path");
    await vi.advanceTimersByTimeAsync(4100);
    expect(await pending).toEqual({ variants: [], topic: null });
  });

  it("returns validated variants on success and caches the result", async () => {
    const fetchMock = vi.fn(async () =>
      geminiPayload({ variants: Array.from({ length: 10 }, (_, i) => `Variant ${i}`), topic: "testing the cache" }),
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const first = await generateQueryVariants("success path");
    expect(first.variants).toHaveLength(10);
    expect(first.topic).toBe("testing the cache");
    const second = await generateQueryVariants("success path");
    expect(second).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 24h cache hit
  });
});
