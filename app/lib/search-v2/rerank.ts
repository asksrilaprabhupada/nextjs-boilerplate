/**
 * rerank.ts — EVERY candidate judged, against the ORIGINAL question.
 *
 * One candidate list spanning every source type, and no cap on how many are
 * judged: the reranker's job is to sort the pool, and a pool the database was
 * told to keep large is exactly the pool it must see all of. Cohere cannot take
 * thousands of documents in one request, so the pool is split into batches of
 * {@link RERANK_BATCH_SIZE}, sent CONCURRENTLY, and then everything scoring at
 * or above the relevance line is reranked once more as a single shortlist —
 * so the final order is one true order, not several batch-local ones stitched
 * together.
 *
 * The score is KEPT. It rides on every candidate as `rerankScore`, because
 * selection now works by relevance ("keep everything above the line") rather
 * than by counting, and that is impossible if the score is used to sort and
 * then thrown away.
 *
 * Cohere's relevance scores are RANKING SIGNALS. They are never surfaced as
 * "confidence percentages" — a 0.83 means this passage outranked that one, not
 * that the teaching is 83% likely to be correct.
 *
 * If Cohere is unavailable the fused order stands and the response is marked
 * degraded. That is a worse ordering, not a wrong one.
 */
import { cohereRerank } from "@/app/lib/08-cohere-rerank";
import { cohereRerankModel } from "@/app/lib/search-v2/config";
import type { DedupedCandidate } from "@/app/lib/search-v2/dedup";

/** A candidate carrying the reranker's judgement. Null when it was never judged. */
export interface RankedCandidate extends DedupedCandidate {
  rerankScore: number | null;
}

/** Cohere's documented per-request document ceiling is well above this; 200 keeps
 *  each request comfortably inside token limits with 4k-char documents. */
export const RERANK_BATCH_SIZE = 200;

/**
 * The final pass exists to produce ONE true order, not to re-judge everything.
 * Cohere Rerank is a pointwise cross-encoder — each (query, document) pair is
 * scored independently — so first-pass scores from different batches ARE
 * comparable and are trustworthy enough to choose the finalists. Only the
 * finalists need a single-request ordering.
 */
export const RERANK_FINAL_POOL = 200;

/** A 200-document final pass with long purports needs more than the default
 *  10 s; a dead final pass already falls back to batch scores honestly. */
const FINAL_PASS_TIMEOUT_MS = 25000;

export interface RerankOutcome {
  ranked: RankedCandidate[];
  /** True when Cohere ran and produced a genuine ordering. */
  reranked: boolean;
  degradedReason: string | null;
  /** Documents actually sent to the provider (all batches + the final pass). */
  documentCount: number;
  model: string;
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
 * apply are omitted rather than emitted empty, so the model never sees
 * `recipient: ` on a verse and infers something from the blank.
 */
export function serialiseDocument(c: DedupedCandidate, maxChars = 4000): string {
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

/** Shape `cohereRerank` reads. The YAML document is the only text it scores. */
interface RerankDoc {
  body_text: string;
  __key: string;
}

function toDocs(pool: DedupedCandidate[]): RerankDoc[] {
  return pool.map((c) => ({ body_text: serialiseDocument(c), __key: c.passage_key }));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const unranked = (candidates: DedupedCandidate[]): RankedCandidate[] =>
  candidates.map((c) => ({ ...c, rerankScore: null }));

export interface RerankInput {
  /** The devotee's ORIGINAL question. Never a subquery, never a canonicalisation. */
  question: string;
  candidates: DedupedCandidate[];
}

export async function rerankUnified(input: RerankInput): Promise<RerankOutcome> {
  const model = cohereRerankModel();
  const { question, candidates } = input;

  if (candidates.length <= 1) {
    return {
      ranked: unranked(candidates),
      reranked: false,
      degradedReason: null,
      documentCount: candidates.length,
      model,
    };
  }

  if (!process.env.COHERE_API_KEY) {
    return {
      ranked: unranked(candidates),
      reranked: false,
      degradedReason: "cohere_api_key_absent",
      documentCount: 0,
      model,
    };
  }

  try {
    // ── Pass 1: every batch, concurrently. Every candidate gets a score. ──
    const batches = chunk(candidates, RERANK_BATCH_SIZE);
    let documentCount = 0;
    const batchResults = await Promise.all(
      batches.map((batch) => {
        const docs = toDocs(batch);
        documentCount += docs.length;
        return cohereRerank(question, docs, docs.length);
      }),
    );

    const scoreByKey = new Map<string, number>();
    let deadBatches = 0;
    for (const results of batchResults) {
      // `cohereRerank` returns the original order with score 0 when it could
      // not reach the provider — an all-zero batch means unjudged, not
      // uniformly irrelevant.
      const alive = results.some((r) => r.relevance_score > 0);
      if (!alive) {
        deadBatches += 1;
        continue;
      }
      for (const r of results) {
        scoreByKey.set((r.item as RerankDoc).__key, r.relevance_score);
      }
    }

    if (scoreByKey.size === 0) {
      return {
        ranked: unranked(candidates),
        reranked: false,
        degradedReason: "cohere_unavailable",
        documentCount,
        model,
      };
    }

    // ── Pass 2: one true order over a FIXED pool of finalists. ──
    // The old shape re-sent everything above a threshold that almost nothing
    // fell below, which meant the entire pool travelled twice. The finalists
    // are the top RERANK_FINAL_POOL by first-pass score — comparable across
    // batches, see above — plus every pinned candidate, which is never allowed
    // to miss the single-judgement ordering. One batch means the first pass
    // already is that single judgement.
    const byFirstPass = [...candidates].sort(
      (a, b) =>
        (scoreByKey.get(b.passage_key) ?? -1) - (scoreByKey.get(a.passage_key) ?? -1) ||
        a.passage_key.localeCompare(b.passage_key),
    );
    const finalists = byFirstPass.slice(0, RERANK_FINAL_POOL);
    const finalistKeys = new Set(finalists.map((c) => c.passage_key));
    for (const c of candidates) {
      if (c.pinned && !finalistKeys.has(c.passage_key)) {
        finalists.push(c);
        finalistKeys.add(c.passage_key);
      }
    }
    if (batches.length > 1 && finalists.length > 1) {
      const finalDocs = toDocs(finalists);
      documentCount += finalDocs.length;
      const finalResults = await cohereRerank(question, finalDocs, finalDocs.length, FINAL_PASS_TIMEOUT_MS);
      if (finalResults.some((r) => r.relevance_score > 0)) {
        for (const r of finalResults) {
          scoreByKey.set((r.item as RerankDoc).__key, r.relevance_score);
        }
      }
      // A dead final pass keeps the batch scores — a coarser but honest order.
    }

    // A candidate whose batch died was never judged — it carries null, not 0.
    // Zero is a verdict; null is an absence of one.
    const ranked: RankedCandidate[] = candidates
      .map((c) => ({
        ...c,
        rerankScore: scoreByKey.has(c.passage_key) ? scoreByKey.get(c.passage_key)! : null,
      }))
      .sort(
        (a, b) =>
          (b.rerankScore ?? -1) - (a.rerankScore ?? -1) || a.passage_key.localeCompare(b.passage_key),
      );

    return {
      ranked,
      reranked: true,
      degradedReason: deadBatches > 0 ? `cohere_partial_${deadBatches}_batches` : null,
      documentCount,
      model,
    };
  } catch {
    return {
      ranked: unranked(candidates),
      reranked: false,
      degradedReason: "cohere_failed",
      documentCount: candidates.length,
      model,
    };
  }
}
