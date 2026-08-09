#!/usr/bin/env node
/**
 * rerank-batch-sanity.mjs — Is a Cohere score comparable across batch sizes?
 *
 * The capped final rerank pass (RERANK_FINAL_POOL in app/lib/search-v2/rerank.ts)
 * chooses its finalists by FIRST-PASS scores that came from different batches.
 * That is only sound if a pointwise cross-encoder really does score a
 * (query, document) pair the same whether the request holds 5 documents or 200.
 * This script measures exactly that:
 *
 *   COHERE_API_KEY=... node scripts/rerank-batch-sanity.mjs
 *
 * It scores the same 5 documents (a) alone and (b) buried inside a 200-document
 * request, same query, and prints both scores side by side. If they match (tiny
 * float noise aside), cross-batch comparability holds and the cap is safe. If
 * they differ materially, raise RERANK_FINAL_POOL to 400 and say so in the PR.
 */

const apiKey = process.env.COHERE_API_KEY;
if (!apiKey) {
  console.error("FAIL: COHERE_API_KEY is required. This measures the live model and cannot be skipped.");
  process.exit(1);
}

const MODEL = process.env.COHERE_RERANK_MODEL || "rerank-v4.0-pro";
const QUERY = "How can I control my restless mind?";

const PROBES = [
  "The mind is restless, turbulent, obstinate and very strong, O Krsna, and to subdue it, I think, is more difficult than controlling the wind.",
  "For him who has conquered the mind, the mind is the best of friends; but for one who has failed to do so, his mind will remain the greatest enemy.",
  "It is undoubtedly very difficult to curb the restless mind, but it is possible by suitable practice and by detachment.",
  "One must deliver himself with the help of his mind, and not degrade himself. The mind is the friend of the conditioned soul, and his enemy as well.",
  "From wherever the mind wanders due to its flickering and unsteady nature, one must certainly withdraw it and bring it back under the control of the Self.",
];

// 195 fillers on unrelated subjects so the probes sit inside a full batch.
const FILLERS = Array.from({ length: 195 }, (_, i) =>
  `Filler passage number ${i + 1}: prasadam distribution, temple construction, book printing schedules, ` +
  `travel arrangements between centres, and the management of daily correspondence were discussed at length.`,
);

async function rerank(documents) {
  const res = await fetch("https://api.cohere.com/v2/rerank", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, query: QUERY, documents, top_n: documents.length }),
  });
  if (!res.ok) throw new Error(`Cohere ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const byIndex = new Map(data.results.map((r) => [r.index, r.relevance_score]));
  return documents.map((_, i) => byIndex.get(i) ?? null);
}

const small = await rerank(PROBES);
const large = (await rerank([...PROBES, ...FILLERS])).slice(0, PROBES.length);

console.log(`model: ${MODEL}\nquery: ${QUERY}\n`);
console.log("probe | batch-of-5 | batch-of-200 | delta");
let maxDelta = 0;
PROBES.forEach((_, i) => {
  const d = Math.abs((small[i] ?? 0) - (large[i] ?? 0));
  maxDelta = Math.max(maxDelta, d);
  console.log(`  #${i + 1}  | ${small[i]?.toFixed(6)} | ${large[i]?.toFixed(6)} | ${d.toFixed(6)}`);
});
console.log(`\nmax delta: ${maxDelta.toFixed(6)}`);
console.log(
  maxDelta < 0.01
    ? "VERDICT: scores are batch-independent — the capped final pass (C1) is safe."
    : "VERDICT: scores shift with batch size — raise RERANK_FINAL_POOL to 400 and note it in the PR.",
);
