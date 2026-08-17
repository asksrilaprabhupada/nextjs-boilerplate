/**
 * rerank.ts — ONE Cohere call over the whole deduplicated pool.
 *
 * What this replaces: a first pass in concurrent batches of 200, the scores
 * combined, then a second pass re-judging the best 200 — about 600 documents
 * of paid reading per search, and two orderings that had to be reconciled.
 * Alongside it sat an A/B seam built for a comparison that was cancelled by
 * preference rather than by test. All of it is gone.
 *
 * The pool is about 700 documents, not thousands: the five `_v3` functions cap
 * their own output regardless of how many query variants are batched into them
 * (200 + 150 + 120 + 150 + 80). That is comfortably inside Cohere's guidance of
 * staying under 1,000 documents in one request, so no production cap is needed.
 * {@link RERANK_POOL_CEILING} is a defensive ceiling, not an operating size —
 * reaching it means an assumption above has broken, so it is logged loudly and
 * recorded as a degradation rather than trimming the pool in silence.
 *
 * THE WHOLE RANKED POOL COMES BACK, not a top 20. Dig Deeper is built from the
 * same ranking as the main list, so asking for 20 results would leave every
 * other passage unordered — and there would be no honest way to say the second
 * tier is "in the same rerank order" when nothing had ranked it.
 */
import {
  COHERE_RERANK_MODEL,
  cohereRerank,
  type RerankCandidate,
  type RerankResult,
  type CohereRerankUsage,
} from "@/app/lib/08-cohere-rerank";
import type { DedupedCandidate } from "@/app/lib/search-v2/dedup";

/** A candidate carrying the reranker's judgement. Null when it was never judged. */
export interface RankedCandidate extends DedupedCandidate {
  rerankScore: number | null;
}

/**
 * A defensive ceiling, NOT an operating size. The pool is ~700 by construction.
 * Hitting 1,000 means one of the five per-source caps stopped holding, and that
 * is a bug report, not a busy day.
 */
export const RERANK_POOL_CEILING = 1000;

/**
 * How many characters of a passage are serialised into its document.
 *
 * This — not Cohere — is the binding truncation. Cohere's `max_tokens_per_doc`
 * is 4,096 TOKENS, which no 4,000-CHARACTER document can reach, so the silent
 * provider-side truncation the limit exists to warn about cannot happen here.
 * Ours can, and does, so the number is named and counted rather than buried.
 */
export const DOCUMENT_MAX_CHARS = 4000;

/** One request over ~700 documents needs far more than a 200-document batch. */
const SINGLE_PASS_TIMEOUT_MS = 50_000;

export interface RerankOutcome {
  /** EVERY candidate, in Cohere's order. Never a top-N slice. */
  ranked: RankedCandidate[];
  /** True when Cohere ran and produced a genuine ordering. */
  reranked: boolean;
  degradedReason: string | null;
  /** Documents actually submitted to a network-capable provider call. */
  documentCount: number;
  /** Network-capable provider calls attempted, including failed responses. */
  providerCallCount: number;
  /** Exact attempted request shapes for billing and audit evidence. */
  providerRequests: RerankProviderRequest[];
  /** The model the low-level client actually places on the request. */
  model: string;
  /** Documents whose text was cut at DOCUMENT_MAX_CHARS before being sent. */
  truncatedDocumentCount: number;
}

/** The generic provider shape gives tests a no-network request seam. */
export type RerankProvider = <T extends RerankCandidate>(
  query: string,
  candidates: T[],
  topN?: number,
  timeoutMs?: number,
  onUsage?: (usage: CohereRerankUsage) => void,
) => Promise<RerankResult<T>[]>;

export interface RerankProviderRequest {
  documentCount: number;
  topN: number;
  /** Null until the observer sees a complete provider response. */
  responseSucceeded: boolean | null;
  /** Exact value from Cohere response metadata; null when unavailable. */
  billedSearchUnits: number | null;
}

/** The exact document object sent to the provider. */
export interface PreparedRerankDocument {
  body_text: string;
  __key: string;
}

export interface RerankInput {
  /** The devotee's ORIGINAL question. Never a subquery, never a canonicalisation. */
  question: string;
  candidates: DedupedCandidate[];
  /** Correlates the pool-size and truncation logs with the request. */
  requestId?: string;
}

/** Escapes a scalar for a YAML block. */
function yamlScalar(value: string): string {
  return value.replace(/\r/g, "").trim();
}

/** Indents a passage as a YAML literal block, preserving its line structure. */
function yamlBlock(text: string, indent = "  "): string {
  const body = yamlScalar(text) || "(no text)";
  return body
    .split("\n")
    .map((line) => indent + line)
    .join("\n");
}

/**
 * One document, consistently shaped across source types. Fields that do not
 * apply are omitted rather than emitted empty.
 */
export function serialiseDocument(c: DedupedCandidate, maxChars = DOCUMENT_MAX_CHARS): string {
  const lines: string[] = [
    `passage_id: ${yamlScalar(c.passage_key)}`,
    `source_type: ${yamlScalar(c.source_type)}`,
  ];
  if (c.reference) lines.push(`reference: ${yamlScalar(c.reference)}`);
  if (c.occurred_on) lines.push(`date: ${yamlScalar(c.occurred_on)}`);
  if (c.recipient) lines.push(`recipient: ${yamlScalar(c.recipient)}`);
  if (c.location) lines.push(`location: ${yamlScalar(c.location)}`);
  if (c.speaker) lines.push(`speaker: ${yamlScalar(c.speaker)}`);
  lines.push("text: |");
  lines.push(yamlBlock((c.retrieval_text || "").slice(0, maxChars)));
  return lines.join("\n");
}

const unranked = (candidates: DedupedCandidate[]): RankedCandidate[] =>
  candidates.map((candidate) => ({ ...candidate, rerankScore: null }));

function emptyOutcome(
  candidates: DedupedCandidate[],
  degradedReason: string | null,
  truncatedDocumentCount = 0,
): RerankOutcome {
  return {
    ranked: unranked(candidates),
    reranked: false,
    degradedReason,
    documentCount: 0,
    providerCallCount: 0,
    providerRequests: [],
    model: COHERE_RERANK_MODEL,
    truncatedDocumentCount,
  };
}

/**
 * Judges the whole pool against the ORIGINAL question in a single request.
 *
 * Never throws. Every failure path returns the candidates in arrival order with
 * `reranked: false` and a named reason, which is what makes the page able to
 * say "the ranking did not complete" instead of quietly looking ranked.
 */
export async function rerankUnified(
  input: RerankInput,
  provider: RerankProvider = cohereRerank,
): Promise<RerankOutcome> {
  const { question, requestId } = input;
  const all = input.candidates;

  const overCeiling = all.length > RERANK_POOL_CEILING;
  if (overCeiling) {
    // Never a silent cap. The five per-source caps make ~700 the arithmetic
    // maximum, so arriving here means one of them stopped holding.
    console.error(JSON.stringify({
      level: "error",
      event: "search.rerank_pool_ceiling_hit",
      requestId: requestId ?? null,
      poolSize: all.length,
      ceiling: RERANK_POOL_CEILING,
      dropped: all.length - RERANK_POOL_CEILING,
    }));
  }
  const candidates = overCeiling ? all.slice(0, RERANK_POOL_CEILING) : all;

  const documents: PreparedRerankDocument[] = candidates.map((candidate) => ({
    body_text: serialiseDocument(candidate),
    __key: candidate.passage_key,
  }));
  const truncatedDocumentCount = candidates.filter(
    (candidate) => (candidate.retrieval_text || "").length > DOCUMENT_MAX_CHARS,
  ).length;

  const ceilingReason = overCeiling ? `rerank_pool_ceiling_${all.length}` : null;
  if (candidates.length <= 1) return emptyOutcome(candidates, ceilingReason, truncatedDocumentCount);
  if (!process.env.COHERE_API_KEY) {
    return emptyOutcome(candidates, "cohere_api_key_absent", truncatedDocumentCount);
  }

  const request: RerankProviderRequest = {
    documentCount: documents.length,
    // The WHOLE pool back, so Dig Deeper shares the main list's one ordering.
    topN: documents.length,
    responseSucceeded: null,
    billedSearchUnits: null,
  };
  try {
    const results = await provider(
      question,
      documents,
      documents.length,
      SINGLE_PASS_TIMEOUT_MS,
      (usage) => {
        request.responseSucceeded = usage.responseSucceeded;
        request.billedSearchUnits = usage.billedSearchUnits;
      },
    );

    // The provider itself reports whether a complete 2xx body was parsed. That
    // signal is authoritative and this code believes it rather than guessing
    // from the scores: "did any score exceed zero?" cannot tell a 402, a 429, a
    // 5xx, a timeout or a malformed body from a pool the cross-encoder honestly
    // judged irrelevant, and it is the only thing standing between a failed
    // rerank and a page that looks ranked.
    if (request.responseSucceeded === false) {
      return {
        ...emptyOutcome(candidates, "cohere_unavailable", truncatedDocumentCount),
        documentCount: documents.length,
        providerCallCount: 1,
        providerRequests: [request],
      };
    }

    const candidateByKey = new Map(candidates.map((c) => [c.passage_key, c]));
    const ranked: RankedCandidate[] = [];
    const seen = new Set<string>();
    for (const result of results) {
      const candidate = candidateByKey.get(result.item.__key);
      if (!candidate || seen.has(candidate.passage_key)) continue;
      seen.add(candidate.passage_key);
      ranked.push({ ...candidate, rerankScore: result.relevance_score });
    }
    if (ranked.length === 0) {
      return {
        ...emptyOutcome(candidates, "cohere_unavailable", truncatedDocumentCount),
        documentCount: documents.length,
        providerCallCount: 1,
        providerRequests: [request],
      };
    }
    // A short result set is a partial answer, not a licence to lose passages.
    // Anything Cohere did not return keeps its place after the judged ones,
    // scoreless, so no passage disappears because the provider was terse.
    for (const candidate of candidates) {
      if (!seen.has(candidate.passage_key)) ranked.push({ ...candidate, rerankScore: null });
    }

    return {
      ranked,
      reranked: true,
      degradedReason: ceilingReason
        ?? (ranked.length > seen.size ? `cohere_partial_${ranked.length - seen.size}` : null),
      documentCount: documents.length,
      providerCallCount: 1,
      providerRequests: [request],
      model: COHERE_RERANK_MODEL,
      truncatedDocumentCount,
    };
  } catch {
    return {
      ...emptyOutcome(candidates, "cohere_failed", truncatedDocumentCount),
      documentCount: documents.length,
      providerCallCount: 1,
      providerRequests: [request],
    };
  }
}
