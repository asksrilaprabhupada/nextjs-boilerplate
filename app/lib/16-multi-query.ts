/**
 * 16-multi-query.ts — Multi-Query Expansion (RAG-Fusion)
 *
 * Expands a devotee's question into up to 10 Gemini-generated variant
 * questions plus a short gerund `topic` phrase for framing. The original
 * query and every variant are searched across all three channels (semantic,
 * full-text, tags); the ranked lists are fused with Reciprocal Rank Fusion
 * (fuseRankedLists) before the existing Cohere reranker judges relevance
 * against the ORIGINAL question only — variants widen recall, never redefine
 * intent.
 *
 * Hardening: 4 s hard timeout, strict JSON validation, case-insensitive
 * dedupe (against each other and the original), and on ANY failure an empty
 * expansion — the pipeline proceeds with the original query alone.
 *
 * Env toggles: MULTIQUERY_ENABLED (default true), MULTIQUERY_VARIANTS
 * (default 10), MULTIQUERY_CHANNELS ("all" or a comma list of
 * semantic,fulltext,tags), GEMINI_MODEL (default gemini-2.5-flash).
 */

export interface QueryExpansion {
  variants: string[];
  topic: string | null;
}

export type MultiQueryChannel = "semantic" | "fulltext" | "tags";

const EMPTY_EXPANSION: QueryExpansion = { variants: [], topic: null };
const GEMINI_TIMEOUT_MS = 4000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;

export function multiQueryEnabled(): boolean {
  return (process.env.MULTIQUERY_ENABLED ?? "true").toLowerCase() !== "false";
}

export function multiQueryVariantCount(): number {
  const n = parseInt(process.env.MULTIQUERY_VARIANTS || "10", 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10) : 10;
}

export function multiQueryChannels(): Set<MultiQueryChannel> {
  const raw = (process.env.MULTIQUERY_CHANNELS || "all").toLowerCase().trim();
  if (raw === "all" || raw === "") return new Set(["semantic", "fulltext", "tags"]);
  const valid: MultiQueryChannel[] = ["semantic", "fulltext", "tags"];
  const picked = raw.split(",").map((s) => s.trim()).filter((s): s is MultiQueryChannel => (valid as string[]).includes(s));
  return new Set(picked.length > 0 ? picked : valid);
}

/**
 * Validates and hardens a raw Gemini response into a QueryExpansion.
 * Exported pure for unit tests. Accepts either {variants, topic} or a bare
 * string array (model drift tolerance).
 */
export function parseExpansion(parsed: unknown, originalQuery: string, max: number): QueryExpansion {
  const rawList: unknown = Array.isArray(parsed)
    ? parsed
    : (parsed as Record<string, unknown> | null)?.variants;
  if (!Array.isArray(rawList)) return EMPTY_EXPANSION;

  const seen = new Set<string>([originalQuery.toLowerCase().trim()]);
  const variants: string[] = [];
  for (const item of rawList) {
    if (typeof item !== "string") continue;
    const v = item.trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    variants.push(v);
    if (variants.length >= max) break;
  }

  let topic: string | null = null;
  const rawTopic = (parsed as Record<string, unknown> | null)?.topic;
  if (typeof rawTopic === "string") {
    const t = rawTopic.trim().replace(/[.?!]+$/, "");
    const words = t.split(/\s+/).length;
    if (t.length >= 3 && t.length <= 60 && words >= 1 && words <= 6) topic = t;
  }

  return { variants, topic };
}

function buildPrompt(query: string, n: number): string {
  return `You expand a devotee's question into search variants for a library of Śrīla Prabhupāda's books, lectures and letters.

Given the question, produce EXACTLY ${n} distinct reformulations and closely related angles — e.g. for "How to control the mind": "Why is the mind so difficult to control?", "What does Kṛṣṇa say about the restless mind?", "Is chanting the way to control the mind?", "Mind as friend and enemy", "How did Arjuna's doubt about the mind get answered?"

Rules: same language as the input; 12 words or fewer each; questions or noun-phrases; no duplicates; no answers; no numbering; may use Sanskrit terms (Kṛṣṇa consciousness, manaḥ, vairāgya).

Also produce "topic": a 2-5 word gerund phrase naming the question's subject (e.g. "controlling the mind").

Question: "${query}"

Return ONLY valid JSON, no markdown:
{"variants": ["...", "..."], "topic": "..."}`;
}

// 24 h in-memory cache so repeat questions and example-chip taps skip Gemini.
const variantCache = new Map<string, { at: number; value: QueryExpansion }>();

/**
 * Generates the variant questions + topic for a query. Never throws — any
 * failure (missing key, HTTP error, timeout, malformed JSON) degrades to an
 * empty expansion and the search proceeds with the original query alone.
 */
export async function generateQueryVariants(query: string): Promise<QueryExpansion> {
  if (!multiQueryEnabled()) return EMPTY_EXPANSION;
  const geminiKey = process.env.GEMINI_API_KEY || "";
  if (!geminiKey) {
    console.warn("[multi-query] GEMINI_API_KEY not set — searching directly");
    return EMPTY_EXPANSION;
  }

  const cacheKey = query.toLowerCase().trim();
  const hit = variantCache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

  const max = multiQueryVariantCount();
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          contents: [{ parts: [{ text: buildPrompt(query, max) }] }],
          generationConfig: {
            responseMimeType: "application/json",
            temperature: 0.8,
            maxOutputTokens: 800,
          },
        }),
      },
    );
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
    const value = parseExpansion(JSON.parse(text), query, max);

    if (variantCache.size >= MAX_CACHE_ENTRIES) {
      const oldest = variantCache.keys().next().value;
      if (oldest !== undefined) variantCache.delete(oldest);
    }
    variantCache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch (err) {
    console.warn("[multi-query] variant generation failed — searching directly:", err);
    return EMPTY_EXPANSION;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Reciprocal Rank Fusion across any number of ranked lists.
 * rrf(id) = Σ_lists 1 / (k + rank_in_list). The canonical row for an id is
 * taken from the FIRST list that contains it — callers pass the original
 * query's (metadata-enriched) list first so its similarity/matchedChunkText
 * survive fusion. Pure; exported for unit tests.
 */
export function fuseRankedLists<T extends { id: string }>(
  lists: T[][],
  k = 60,
  cap = Number.POSITIVE_INFINITY,
): (T & { score: number })[] {
  const scores = new Map<string, number>();
  const canonical = new Map<string, T>();
  for (const list of lists) {
    list.forEach((item, rank) => {
      if (!item?.id) return;
      scores.set(item.id, (scores.get(item.id) || 0) + 1 / (k + rank));
      if (!canonical.has(item.id)) canonical.set(item.id, item);
    });
  }
  const fused = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => ({ ...(canonical.get(id) as T), score }));
  return Number.isFinite(cap) ? fused.slice(0, cap) : fused;
}
