/**
 * hash.ts — Question hashing and stable digests.
 *
 * These four helpers used to live in cache.ts. The cache is gone: it made
 * measurement meaningless, because the second run of a question could be a
 * saved copy rather than a real search. The hashing had nothing to do with
 * caching, though — retrieval, the pipeline, durable telemetry and the
 * diagnostic session all still need it — so it moved here rather than dying
 * with the machinery it happened to share a file with.
 *
 * `normalizeQuestion` is deliberately conservative. It folds case, whitespace
 * and trailing punctuation and nothing else. Anything cleverer risks treating
 * two genuinely different questions as one, and a question hash is how a bad
 * answer is traced back without ever storing what was asked.
 */
import { createHash } from "crypto";

/** Short digest. Used where a full 64 hex characters buys nothing. */
export function sha256(input: string): string {
  return fullSha256(input).slice(0, 32);
}

/** Full digest, for durable telemetry. */
export function fullSha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * Question normalisation for hash identity. Folds case, collapses whitespace
 * and strips trailing `?`, `!` and `.` — nothing more.
 */
export function normalizeQuestion(q: string): string {
  return (q || "").trim().toLowerCase().replace(/\s+/g, " ").replace(/[?!.]+$/, "");
}

/** Stable hash over a set of passage keys, independent of their order. */
export function hashKeys(keys: string[]): string {
  return sha256([...keys].sort().join("|"));
}
