/**
 * 08-cohere-rerank.ts — Cohere Rerank
 *
 * Reorders RRF-fused search candidates by relevance using Cohere's Rerank v4.0 Pro
 * cross-encoder. Takes the candidates from the fusion step and returns them
 * reordered by relevance. Requires the COHERE_API_KEY environment variable.
 *
 * Usage: const reranked = await cohereRerank(query, candidates, 20);
 */

// ─── Types ───────────────────────────────────────────────────

/**
 * The only fields reranking reads off a candidate. Deliberately NOT an index
 * signature: `[key: string]: unknown` would have forced every concrete hit type
 * (VerseHit, ProseHit, …) to declare one too, and widening them to satisfy it
 * is how a typo in a field name stops being a compile error.
 */
export interface RerankCandidate {
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
  meta?: {
    billed_units?: {
      search_units?: number;
    };
  };
}

function hasCompleteResultSet(
  data: CohereRerankResponse,
  candidateCount: number,
  requestedTopN: number,
): boolean {
  if (!Array.isArray(data.results)) return false;
  const expected = Math.min(candidateCount, Math.max(0, Math.floor(requestedTopN)));
  if (data.results.length !== expected) return false;
  const indices = new Set<number>();
  for (const result of data.results) {
    if (!result || !Number.isSafeInteger(result.index)
      || result.index < 0 || result.index >= candidateCount
      || !Number.isFinite(result.relevance_score)
      || indices.has(result.index)) {
      return false;
    }
    indices.add(result.index);
  }
  return true;
}

export interface CohereRerankUsage {
  requestAttempted: boolean;
  /** Null when no request was needed, otherwise whether a complete 2xx body was parsed. */
  responseSucceeded: boolean | null;
  /** Exact provider-reported units, or null when no usable response arrived. */
  billedSearchUnits: number | null;
}

// ─── Configuration ───────────────────────────────────────────

const COHERE_API_URL = 'https://api.cohere.com/v2/rerank';
/** The exact model placed on the provider request. Exported so reports cannot
 * claim an environment override that this client did not actually send. */
export const COHERE_RERANK_MODEL = 'rerank-v4.0-pro';
const MAX_TOKENS_PER_DOC = 4096;
const DEFAULT_TIMEOUT_MS = 10000; // 10 second timeout; callers may pass more for large single requests

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
 * @param timeoutMs   - Request timeout; the default suits a 200-doc batch, the
 *                      final single-request pass passes a larger budget
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
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  onUsage?: (usage: CohereRerankUsage) => void,
): Promise<RerankResult<T>[]> {
  const apiKey = process.env.COHERE_API_KEY;
  const reportUsage = (usage: CohereRerankUsage): void => {
    try { onUsage?.(usage); } catch { /* accounting is observer-only */ }
  };

  // ── Guard: no API key → return original order ──
  if (!apiKey) {
    reportUsage({ requestAttempted: false, responseSucceeded: null, billedSearchUnits: 0 });
    console.warn('[cohere-rerank] COHERE_API_KEY not set — skipping rerank');
    return candidates.slice(0, topN).map((item, i) => ({
      item,
      relevance_score: 0,
      original_index: i,
    }));
  }

  // ── Guard: empty or tiny candidate list → no point reranking ──
  if (candidates.length <= 1) {
    reportUsage({ requestAttempted: false, responseSucceeded: null, billedSearchUnits: 0 });
    return candidates.map((item, i) => ({
      item,
      relevance_score: 1,
      original_index: i,
    }));
  }

  // ── Extract text from each candidate ──
  const documents = candidates.map(extractText);

  // ── Call Cohere Rerank API ──
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {

    const response = await fetch(COHERE_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: COHERE_RERANK_MODEL,
        query: query,
        documents: documents,
        top_n: topN,
        max_tokens_per_doc: MAX_TOKENS_PER_DOC,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      console.error(
        `[cohere-rerank] API error ${response.status}: ${errorText}`
      );
      reportUsage({ requestAttempted: true, responseSucceeded: false, billedSearchUnits: null });
      // Fallback: return original order
      return candidates.slice(0, topN).map((item, i) => ({
        item,
        relevance_score: 0,
        original_index: i,
      }));
    }

    const data: CohereRerankResponse = await response.json();
    const rawSearchUnits = data.meta?.billed_units?.search_units;
    const completeResultSet = hasCompleteResultSet(data, candidates.length, topN);
    reportUsage({
      requestAttempted: true,
      responseSucceeded: completeResultSet,
      billedSearchUnits: completeResultSet
        && typeof rawSearchUnits === 'number' && Number.isFinite(rawSearchUnits)
        ? rawSearchUnits
        : null,
    });
    if (!completeResultSet) {
      console.error('[cohere-rerank] API returned an incomplete or invalid result set');
      if (!Array.isArray(data.results) || data.results.some((result) =>
        !result || typeof result.index !== 'number' || typeof result.relevance_score !== 'number')) {
        return candidates.slice(0, topN).map((item, i) => ({
          item,
          relevance_score: 0,
          original_index: i,
        }));
      }
    }

    // ── Map Cohere results back to original candidates ──
    return data.results.map((r) => ({
      item: candidates[r.index],
      relevance_score: r.relevance_score,
      original_index: r.index,
    }));

  } catch (error: unknown) {
    reportUsage({ requestAttempted: true, responseSucceeded: false, billedSearchUnits: null });
    const err = error as { name?: string; message?: string };
    if (err.name === 'AbortError') {
      console.error(`[cohere-rerank] Request timed out after ${timeoutMs / 1000}s`);
    } else {
      console.error('[cohere-rerank] Request failed:', err.message);
    }

    // Fallback: return original order — search must never break
    return candidates.slice(0, topN).map((item, i) => ({
      item,
      relevance_score: 0,
      original_index: i,
    }));
  } finally {
    // The timeout covers response-body parsing as well as response headers.
    clearTimeout(timeoutId);
  }
}
