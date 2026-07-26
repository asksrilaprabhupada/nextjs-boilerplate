/**
 * search-v2-cache.test.ts — Cache key discipline.
 *
 * The backend barely matters here. What matters is the keyspace, because the
 * failure mode of a search cache is not a slow page — it is answering one
 * devotee's question with the evidence gathered for a different one.
 *
 * So: an exact normalised question in the same mode and corpus version may be
 * served from cache. Anything else must miss.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  cacheKeys,
  normalizeQuestion,
  sha256,
  hashKeys,
  cached,
  __setCacheAdapter,
  type CacheAdapter,
} from "@/app/lib/search-v2/cache";

function memoryAdapter() {
  const store = new Map<string, unknown>();
  const adapter: CacheAdapter & { store: Map<string, unknown>; gets: string[] } = {
    name: "test",
    store,
    gets: [],
    async get<T>(k: string) {
      adapter.gets.push(k);
      return (store.get(k) ?? null) as T | null;
    },
    async set<T>(k: string, v: T) {
      store.set(k, v);
    },
  };
  return adapter;
}

afterEach(() => __setCacheAdapter(null));

describe("question normalisation", () => {
  it("folds case, whitespace and trailing punctuation only", () => {
    expect(normalizeQuestion("  How Do I  Control My Mind??  ")).toBe("how do i control my mind");
    expect(normalizeQuestion("What is bhakti.")).toBe("what is bhakti");
  });

  it("does NOT conflate two genuinely different questions", () => {
    expect(normalizeQuestion("what is the soul")).not.toBe(normalizeQuestion("what is the mind"));
    // Word order carries meaning; normalisation must not sort or stem it away.
    expect(normalizeQuestion("krsna loves the devotee")).not.toBe(
      normalizeQuestion("the devotee loves krsna"),
    );
  });
});

describe("response key discipline", () => {
  it("is stable for the same question in the same mode", () => {
    expect(cacheKeys.response("guided", "How do I control my mind?")).toBe(
      cacheKeys.response("guided", "  how do i control my MIND  "),
    );
  });

  it("separates modes", () => {
    expect(cacheKeys.response("guided", "what is bhakti")).not.toBe(
      cacheKeys.response("quick", "what is bhakti"),
    );
  });

  it("separates different questions", () => {
    expect(cacheKeys.response("guided", "what is the soul")).not.toBe(
      cacheKeys.response("guided", "what is the mind"),
    );
  });

  it("carries the corpus version, so a re-tagged corpus cannot serve stale answers", () => {
    const before = cacheKeys.response("guided", "what is bhakti");
    const saved = process.env.SEARCH_CORPUS_VERSION;
    process.env.SEARCH_CORPUS_VERSION = "2099-01-01-rebuilt";
    try {
      expect(cacheKeys.response("guided", "what is bhakti")).not.toBe(before);
    } finally {
      if (saved === undefined) delete process.env.SEARCH_CORPUS_VERSION;
      else process.env.SEARCH_CORPUS_VERSION = saved;
    }
  });

  it("never embeds the raw question in the key", () => {
    const key = cacheKeys.response("guided", "a very distinctive private question");
    expect(key).not.toContain("distinctive");
    expect(key).not.toContain("private");
  });
});

describe("other keyspaces", () => {
  it("keys embeddings by model, so a model change cannot reuse old vectors", () => {
    expect(cacheKeys.embedding("voyage-context-4", "x")).not.toBe(
      cacheKeys.embedding("voyage-3", "x"),
    );
  });

  it("keys reranks by question AND candidate set", () => {
    const a = cacheKeys.rerank("q", hashKeys(["verse:1", "verse:2"]));
    const b = cacheKeys.rerank("q", hashKeys(["verse:1", "verse:3"]));
    expect(a).not.toBe(b);
  });

  it("hashes candidate sets order-independently", () => {
    expect(hashKeys(["b", "a"])).toBe(hashKeys(["a", "b"]));
  });

  it("produces a stable short digest", () => {
    expect(sha256("x")).toMatch(/^[0-9a-f]{32}$/);
    expect(sha256("x")).toBe(sha256("x"));
  });
});

describe("read-through helper", () => {
  it("produces on a miss and serves on the next hit", async () => {
    const adapter = memoryAdapter();
    __setCacheAdapter(adapter);
    let produced = 0;
    const produce = async () => {
      produced += 1;
      return { v: produced };
    };

    expect(await cached("k", 1000, produce)).toEqual({ v: 1 });
    expect(await cached("k", 1000, produce)).toEqual({ v: 1 });
    expect(produced).toBe(1);
  });

  it("still produces when the cache throws — a broken cache is never a broken search", async () => {
    __setCacheAdapter({
      name: "broken",
      async get() {
        throw new Error("cache down");
      },
      async set() {
        throw new Error("cache down");
      },
    });
    await expect(cached("k", 1000, async () => "value")).resolves.toBe("value");
  });
});
