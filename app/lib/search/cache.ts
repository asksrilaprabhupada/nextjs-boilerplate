/**
 * cache.ts — Versioned cache with a shared backend and a local-dev adapter.
 *
 * The old per-instance `Map` caches meant a warm Vercel instance answered
 * instantly and every other instance recomputed everything. This exposes one
 * keyspace with an adapter behind it: Vercel's Runtime Cache when the runtime
 * provides one, an in-process LRU otherwise (local dev, tests, and any runtime
 * where the shared cache is unavailable).
 *
 * KEY DISCIPLINE — the rule that matters more than the backend:
 *
 *   A full response is served ONLY for an exact normalised question, under the
 *   same config and corpus version. A *different* question that happens to be
 *   semantically close is a different question, and answering it from another
 *   question's cached evidence would be putting words in Śrīla Prabhupāda's
 *   mouth by accident.
 *
 * WHAT MUST NEVER BE CACHED — enforced by the callers, listed here because this
 * is where someone will look: technical failures, partially completed
 * retrievals, invalid AI plans, unverified passages, and any
 * insufficient-evidence response produced while a stage was degraded. Caching
 * any of those turns a transient outage into a persistent wrong answer.
 *
 * Retrieval candidates may be reused more liberally, because everything
 * downstream — rerank against the original question, threshold selection,
 * exact re-fetch — still runs. That is the only reuse permitted.
 *
 * Keys are never logged. Errors never propagate: a cache is an optimisation,
 * and a failing optimisation must not fail a search.
 */
import { createHash } from "crypto";
import { searchCorpusVersion, searchConfigVersion } from "@/app/lib/search/01-config";

export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  readonly name: string;
}

/** Fallback adapter. Bounded so a long-lived process cannot grow without limit. */
class MemoryCache implements CacheAdapter {
  readonly name = "memory";
  private readonly store = new Map<string, CacheEntry<unknown>>();
  constructor(private readonly maxEntries = 2000) {}

  async get<T>(key: string): Promise<T | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Re-insert for LRU ordering.
    this.store.delete(key);
    this.store.set(key, hit);
    return hit.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    if (this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }
}

/**
 * Vercel's Runtime Cache, when present. Imported lazily and behind a guard so
 * the module stays usable in tests and in local dev without it.
 */
class RuntimeCacheAdapter implements CacheAdapter {
  readonly name = "vercel-runtime-cache";
  constructor(private readonly cache: Record<string, unknown>) {}

  async get<T>(key: string): Promise<T | null> {
    const fn = this.cache.get as ((k: string) => Promise<unknown>) | undefined;
    if (typeof fn !== "function") return null;
    const raw = await fn.call(this.cache, key);
    return (raw ?? null) as T | null;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    const fn = this.cache.set as
      | ((k: string, v: unknown, o?: Record<string, unknown>) => Promise<void>)
      | undefined;
    if (typeof fn !== "function") return;
    await fn.call(this.cache, key, value, { ttl: Math.ceil(ttlMs / 1000) });
  }
}

let adapter: CacheAdapter | null = null;

export async function getCacheAdapter(): Promise<CacheAdapter> {
  if (adapter) return adapter;
  try {
    const mod = (await import("@vercel/functions")) as Record<string, unknown>;
    const getCache = mod.getCache as (() => Record<string, unknown>) | undefined;
    if (typeof getCache === "function") {
      adapter = new RuntimeCacheAdapter(getCache());
      return adapter;
    }
  } catch {
    // Not running on Vercel, or the package is absent. Fall through.
  }
  adapter = new MemoryCache();
  return adapter;
}

/** Test seam. */
export function __setCacheAdapter(a: CacheAdapter | null): void {
  adapter = a;
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 32);
}

/**
 * Question normalisation for cache identity. Deliberately conservative: it
 * folds case, whitespace and trailing punctuation and nothing else. Anything
 * cleverer risks treating two genuinely different questions as one.
 */
export function normalizeQuestion(q: string): string {
  return (q || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
}

export const TTL = {
  angles: 24 * 60 * 60 * 1000,
  embedding: 7 * 24 * 60 * 60 * 1000,
  retrieval: 24 * 60 * 60 * 1000,
  rerank: 24 * 60 * 60 * 1000,
  connector: 24 * 60 * 60 * 1000,
  response: 24 * 60 * 60 * 1000,
} as const;

/**
 * There is no `mode` in any key any more — there is one pipeline, so a mode
 * segment could only ever be a constant pretending to be a dimension.
 *
 * Every key that can affect what a devotee reads carries BOTH the corpus
 * version and the config version. That is what makes a threshold change, a
 * dedup-rule change or a reranker-model change invalidate stale answers
 * wholesale, rather than leaving yesterday's ranking served from cache.
 */
export const cacheKeys = {
  angles: (question: string) =>
    `angles:${searchConfigVersion()}:${sha256(normalizeQuestion(question))}`,
  embedding: (model: string, text: string) =>
    `embedding:${model}:${sha256(normalizeQuestion(text))}`,
  retrieval: (planHash: string) =>
    `retrieval:${searchConfigVersion()}:${searchCorpusVersion()}:${sha256(planHash)}`,
  rerank: (question: string, candidateSetHash: string) =>
    `rerank:${searchConfigVersion()}:${sha256(normalizeQuestion(question))}:${candidateSetHash}`,
  connector: (question: string, selectedIdHash: string) =>
    `connector:${searchConfigVersion()}:${sha256(normalizeQuestion(question))}:${selectedIdHash}`,
  response: (question: string) =>
    `response:${searchConfigVersion()}:${searchCorpusVersion()}:${sha256(normalizeQuestion(question))}`,
} as const;

/**
 * Read-through helper. Any cache failure is swallowed and the producer runs —
 * a broken cache degrades speed, never correctness.
 */
export async function cached<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
  let store: CacheAdapter;
  try {
    store = await getCacheAdapter();
  } catch {
    return produce();
  }

  try {
    const hit = await store.get<T>(key);
    if (hit !== null && hit !== undefined) return hit;
  } catch {
    // fall through and produce
  }

  const value = await produce();
  try {
    await store.set(key, value, ttlMs);
  } catch {
    // Never let a write failure surface.
  }
  return value;
}

/** Stable hash over a candidate set, for rerank keys. */
export function hashKeys(keys: string[]): string {
  return sha256([...keys].sort().join("|"));
}
