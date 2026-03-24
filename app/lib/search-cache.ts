/**
 * Map-based LRU cache for search results.
 * Max 200 entries, 15-minute TTL.
 */

interface CacheEntry<T> {
  value: T;
  timestamp: number;
}

const MAX_ENTRIES = 200;
const TTL_MS = 15 * 60 * 1000; // 15 minutes

const cache = new Map<string, CacheEntry<unknown>>();

function normalizeKey(query: string): string {
  return query.toLowerCase().trim();
}

export function getCached<T>(query: string): T | null {
  const key = normalizeKey(query);
  const entry = cache.get(key);
  if (!entry) return null;

  if (Date.now() - entry.timestamp > TTL_MS) {
    cache.delete(key);
    return null;
  }

  // Move to end for LRU ordering
  cache.delete(key);
  cache.set(key, entry);
  return entry.value as T;
}

export function setCached<T>(query: string, value: T): void {
  const key = normalizeKey(query);

  // Evict oldest if at capacity
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }

  cache.set(key, { value, timestamp: Date.now() });
}
