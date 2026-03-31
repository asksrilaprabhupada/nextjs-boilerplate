/**
 * Cohere Rerank — Drop-in replacement for llmReRank
 * ===================================================
 * File: app/lib/06-cohere-rerank.ts
 *
 * This module replaces the Gemini-based llmReRank function with
 * Cohere's Rerank v3.5 cross-encoder. It takes candidates from
 * the RRF fusion step and returns them reordered by relevance.
 *
 * Environment variable required:
 *   COHERE_API_KEY — your Cohere API key (add to Vercel env vars)
 *
 * Usage in search/route.ts:
 *   import { cohereRerank } from '@/app/lib/06-cohere-rerank';
 *   const reranked = await cohereRerank(query, candidates, 20);
 */

// ─── Types ───────────────────────────────────────────────────

export interface RerankCandidate {
  /** Any search result object — we only read body_text/translation/purport for reranking */
  [key: string]: any;
  body_text?: string;
  translation?: string;
  purport?: string;
}

export interface RerankResult<T> {
  /** Original candidate, preserved exactly as-is */
  item: T;
  /** Cohere relevance score (0-1, higher = more relevant) */
  relevance_score: number;
  /** Original index in the input array */
  original_index: number;
}

interface CohereRerankResponse {
  results: Array<{
    index: number;
    relevance_score: number;
  }>;
}

// ─── Configuration ───────────────────────────────────────────

const COHERE_API_URL = 'https://api.cohere.com/v2/rerank';
const COHERE_MODEL = 'rerank-v3.5';
const MAX_TOKENS_PER_DOC = 4096;
const TIMEOUT_MS = 10000; // 10 second timeout

// ─── Helper: Extract searchable text from a candidate ────────

function extractText(candidate: RerankCandidate): string {
  // Verses have translation + purport
  if (candidate.translation || candidate.purport) {
    const parts: string[] = [];
    if (candidate.translation) parts.push(candidate.translation);
    if (candidate.purport) parts.push(candidate.purport);
    return parts.join('\n\n');
  }

  // Transcripts, letters, prose all use body_text
  if (candidate.body_text) {
    return candidate.body_text;
  }

  // Fallback: stringify the object (shouldn't happen, but safe)
  return JSON.stringify(candidate);
}

// ─── Main rerank function ────────────────────────────────────

/**
 * Rerank candidates using Cohere's cross-encoder.
 *
 * @param query       - The user's search query
 * @param candidates  - Array of search result objects from RRF fusion
 * @param topN        - Number of top results to return (default: 20)
 * @returns           - Candidates reordered by relevance, with scores
 *
 * If Cohere API fails (network error, timeout, rate limit),
 * returns candidates in original order with score = 0.
 * Search should never break because reranking failed.
 */
export async function cohereRerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topN: number = 20,
): Promise<RerankResult<T>[]> {
  const apiKey = process.env.COHERE_API_KEY;

  // ── Guard: no API key → return original order ──
  if (!apiKey) {
    console.warn('[cohere-rerank] COHERE_API_KEY not set — skipping rerank');
    return candidates.slice(0, topN).map((item, i) => ({
      item,
      relevance_score: 0,
      original_index: i,
    }));
  }

  // ── Guard: empty or tiny candidate list → no point reranking ──
  if (candidates.length <= 1) {
    return candidates.map((item, i) => ({
      item,
      relevance_score: 1,
      original_index: i,
    }));
  }

  // ── Extract text from each candidate ──
  const documents = candidates.map(extractText);

  // ── Call Cohere Rerank API ──
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

    const response = await fetch(COHERE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: COHERE_MODEL,
        query: query,
        documents: documents,
        top_n: topN,
        max_tokens_per_doc: MAX_TOKENS_PER_DOC,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      console.error(
        `[cohere-rerank] API error ${response.status}: ${errorText}`
      );
      // Fallback: return original order
      return candidates.slice(0, topN).map((item, i) => ({
        item,
        relevance_score: 0,
        original_index: i,
      }));
    }

    const data: CohereRerankResponse = await response.json();

    // ── Map Cohere results back to original candidates ──
    return data.results.map((r) => ({
      item: candidates[r.index],
      relevance_score: r.relevance_score,
      original_index: r.index,
    }));

  } catch (error: any) {
    if (error.name === 'AbortError') {
      console.error('[cohere-rerank] Request timed out after 10s');
    } else {
      console.error('[cohere-rerank] Request failed:', error.message);
    }

    // Fallback: return original order — search must never break
    return candidates.slice(0, topN).map((item, i) => ({
      item,
      relevance_score: 0,
      original_index: i,
    }));
  }
}
