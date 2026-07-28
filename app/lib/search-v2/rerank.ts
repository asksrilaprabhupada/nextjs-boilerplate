/**
 * rerank.ts — ONE unified rerank, against the ORIGINAL question.
 *
 * One candidate list spanning every source type, judged once. Not per source
 * type, and emphatically not per subquery followed by another fusion: the
 * subqueries were recall scaffolding, and reranking against them would let the
 * scaffolding decide what the devotee is shown.
 *
 * Documents are serialised as YAML so the cross-encoder sees the same shape for
 * every source, with metadata that actually bears on relevance (a letter's
 * recipient and date change what the passage means) and nothing that does not.
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

export interface RerankOutcome {
  ranked: DedupedCandidate[];
  /** True when Cohere ran and reordered. False means fused order stands. */
  reranked: boolean;
  degradedReason: string | null;
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

export interface RerankInput {
  /** The devotee's ORIGINAL question. Never a subquery, never a canonicalisation. */
  question: string;
  candidates: DedupedCandidate[];
  /** Ceiling on documents sent to the provider. */
  maxCandidates: number;
}

/**
 * EVERY question is reranked. There used to be a bypass for questions that
 * looked like a bare scripture reference, which meant "BG 18.66" and "what does
 * BG 18.66 mean" were ordered by two different mechanisms. Reranking a single
 * obvious answer costs one provider call and is never wrong; guessing which
 * questions deserve it was.
 */
export async function rerankUnified(input: RerankInput): Promise<RerankOutcome> {
  const model = cohereRerankModel();
  const { question, candidates, maxCandidates } = input;

  if (candidates.length <= 1) {
    return { ranked: candidates, reranked: false, degradedReason: null, documentCount: candidates.length, model };
  }

  const pool = candidates.slice(0, maxCandidates);
  const byKey = new Map(pool.map((c) => [c.passage_key, c]));
  const docs: RerankDoc[] = pool.map((c) => ({ body_text: serialiseDocument(c), __key: c.passage_key }));

  if (!process.env.COHERE_API_KEY) {
    return {
      ranked: candidates,
      reranked: false,
      degradedReason: "cohere_api_key_absent",
      documentCount: docs.length,
      model,
    };
  }

  try {
    const results = await cohereRerank(question, docs, pool.length);

    // `cohereRerank` returns the original order with score 0 when it could not
    // reach the provider. Treat an all-zero result as a degradation rather than
    // as a genuine ranking in which every passage is equally irrelevant.
    const scored = results.filter((r) => r.relevance_score > 0);
    if (scored.length === 0) {
      return {
        ranked: candidates,
        reranked: false,
        degradedReason: "cohere_unavailable",
        documentCount: docs.length,
        model,
      };
    }

    const ordered: DedupedCandidate[] = [];
    for (const r of results) {
      const key = (r.item as RerankDoc).__key;
      const c = byKey.get(key);
      if (c) {
        ordered.push(c);
        byKey.delete(key);
      }
    }
    // Anything the provider did not return keeps its fused position, appended.
    for (const c of pool) if (byKey.has(c.passage_key)) ordered.push(c);
    // Candidates beyond the provider budget were never judged; they follow.
    const beyond = candidates.slice(maxCandidates);

    return {
      ranked: [...ordered, ...beyond],
      reranked: true,
      degradedReason: null,
      documentCount: docs.length,
      model,
    };
  } catch {
    return {
      ranked: candidates,
      reranked: false,
      degradedReason: "cohere_failed",
      documentCount: docs.length,
      model,
    };
  }
}
