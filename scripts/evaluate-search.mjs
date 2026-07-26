#!/usr/bin/env node
/**
 * evaluate-search.mjs — Run the gold set against a deployment and score it.
 *
 *   SITE=https://asksrilaprabhupada.vercel.app node scripts/evaluate-search.mjs
 *   SITE=... ARM=original-only node scripts/evaluate-search.mjs
 *   SITE=... LIMIT=20 CATEGORY=exact_verse node scripts/evaluate-search.mjs
 *
 * Deliberately NOT a vitest test. A test that skips itself when SITE is absent
 * reports green while proving nothing, which is the same false reassurance that
 * let the outage run.
 *
 * WHAT IT REFUSES TO DO
 *
 * It will not report Recall/MRR/nDCG over rows whose labels a human has not
 * reviewed. Those questions still run — latency, degradation, evidence-
 * insufficient behaviour and citation integrity are all measurable without a
 * relevance judgement — but they are excluded from the ranking metrics and the
 * exclusion is printed. A recall number computed from model-suggested labels is
 * a number about the model that produced the labels.
 */
import { readFileSync } from "node:fs";

const SITE = process.env.SITE;
if (!SITE) {
  console.error("FAIL: SITE is required, e.g. SITE=https://asksrilaprabhupada.vercel.app");
  process.exit(1);
}

const LIMIT = Number(process.env.LIMIT || 0);
const CATEGORY = process.env.CATEGORY || "";
const MODE = process.env.MODE || "article";
const ARM = process.env.ARM || "default";
const CONCURRENCY = Number(process.env.CONCURRENCY || 2);

const gold = JSON.parse(readFileSync(new URL("../tests/gold/gold-set-v1.json", import.meta.url), "utf8"));

let questions = gold.questions;
if (CATEGORY) questions = questions.filter((q) => q.category === CATEGORY);
if (LIMIT > 0) questions = questions.slice(0, LIMIT);

/** Passage keys the response actually surfaced, in rank order. */
function retrievedKeys(body) {
  const flow = Array.isArray(body?.mainFlowItems) ? body.mainFlowItems : [];
  const keys = flow.map((f) => f.id).filter(Boolean);
  if (keys.length > 0) return keys;
  // V1 shape: citations carry refs rather than namespaced keys.
  return (Array.isArray(body?.citations) ? body.citations : []).map((c) => c.ref).filter(Boolean);
}

function recallAt(retrieved, must, k) {
  if (must.length === 0) return null;
  const top = new Set(retrieved.slice(0, k));
  return must.filter((m) => top.has(m)).length / must.length;
}

function reciprocalRank(retrieved, must) {
  if (must.length === 0) return null;
  for (let i = 0; i < retrieved.length; i++) {
    if (must.includes(retrieved[i])) return 1 / (i + 1);
  }
  return 0;
}

function ndcgAt(retrieved, graded, k) {
  if (!graded || graded.length === 0) return null;
  const gradeOf = new Map(graded.map((g) => [g.passage_id, g.grade]));
  let dcg = 0;
  for (let i = 0; i < Math.min(k, retrieved.length); i++) {
    const g = gradeOf.get(retrieved[i]) ?? 0;
    dcg += (Math.pow(2, g) - 1) / Math.log2(i + 2);
  }
  const ideal = [...graded].sort((a, b) => b.grade - a.grade).slice(0, k);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) {
    idcg += (Math.pow(2, ideal[i].grade) - 1) / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : null;
}

function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function runOne(q) {
  const url = `${SITE.replace(/\/$/, "")}/api/search?q=${encodeURIComponent(q.question)}&mode=${MODE}`;
  const t0 = Date.now();
  let res, body, error = null;
  try {
    res = await fetch(url, { headers: { accept: "application/json" } });
    body = await res.json();
  } catch (e) {
    error = e instanceof Error ? e.message : "request failed";
  }
  const ms = Date.now() - t0;

  if (error || !res?.ok) {
    return {
      id: q.id, category: q.category, ms, ok: false,
      status: res?.status ?? 0,
      errorCode: body?.code ?? error ?? "unknown",
      requestId: body?.request_id ?? body?.requestId ?? null,
    };
  }

  const retrieved = retrievedKeys(body);
  const unacceptableHit = q.unacceptable_passage_ids.filter((id) => retrieved.includes(id));

  // Citation integrity: every citation must carry a reference. A citation with
  // no ref is exactly the invented-citation failure the pipeline guards against.
  const citations = Array.isArray(body?.citations) ? body.citations : [];
  const citationsWithoutRef = citations.filter((c) => !c.ref || !String(c.ref).trim()).length;

  return {
    id: q.id,
    category: q.category,
    ms,
    ok: true,
    status: res.status,
    requestId: body?.requestId ?? null,
    scorable: !q.needs_human_review,
    retrievedCount: retrieved.length,
    recall10: recallAt(retrieved, q.must_find_passage_ids, 10),
    recall20: recallAt(retrieved, q.must_find_passage_ids, 20),
    recall50: recallAt(retrieved, q.must_find_passage_ids, 50),
    mrr: reciprocalRank(retrieved, q.must_find_passage_ids),
    ndcg10: ndcgAt(retrieved, q.relevant_passages, 10),
    directAnswerPresent: q.must_find_passage_ids.length > 0 ? retrieved.slice(0, 3).some((r) => q.must_find_passage_ids.includes(r)) : null,
    duplicateRate: retrieved.length > 0 ? 1 - new Set(retrieved).size / retrieved.length : 0,
    unacceptableHit: unacceptableHit.length,
    citationsWithoutRef,
    validated: body?.validated === true,
    droppedBlocks: body?.droppedBlocks ?? 0,
    degraded: Array.isArray(body?.degradedStages) ? body.degradedStages.length : 0,
    // An out-of-domain question must NOT produce a confident answer.
    respectedInsufficient:
      q.category === "no_direct_corpus_answer"
        ? String(body?.narrative ?? "").includes("No passage in the library directly answers") ||
          (body?.totalResults ?? 0) === 0
        : null,
  };
}

async function pool(items, n, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
        process.stderr.write(`  ${out.filter(Boolean).length}/${items.length}\r`);
      }
    }),
  );
  return out;
}

function mean(values) {
  const v = values.filter((x) => typeof x === "number" && !Number.isNaN(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
}

function fmt(x, digits = 3) {
  return x === null || x === undefined ? "—" : typeof x === "number" ? x.toFixed(digits) : String(x);
}

const started = Date.now();
console.error(`Running ${questions.length} questions against ${SITE} (arm=${ARM}, mode=${MODE})…`);
const results = await pool(questions, CONCURRENCY, runOne);
process.stderr.write("\n");

const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const scorable = ok.filter((r) => r.scorable);
const latencies = ok.map((r) => r.ms);

const report = {
  arm: ARM,
  site: SITE,
  mode: MODE,
  questionsRun: results.length,
  succeeded: ok.length,
  failed: failed.length,
  scoredForRanking: scorable.length,
  excludedPendingHumanReview: ok.length - scorable.length,
  metrics: {
    recall_at_10: mean(scorable.map((r) => r.recall10)),
    recall_at_20: mean(scorable.map((r) => r.recall20)),
    recall_at_50: mean(scorable.map((r) => r.recall50)),
    mrr: mean(scorable.map((r) => r.mrr)),
    ndcg_at_10: mean(scorable.map((r) => r.ndcg10)),
    direct_answer_presence: mean(scorable.map((r) => (r.directAnswerPresent === null ? null : r.directAnswerPresent ? 1 : 0))),
    duplicate_rate: mean(ok.map((r) => r.duplicateRate)),
  },
  safety: {
    citation_faithfulness: ok.length ? 1 - ok.filter((r) => r.citationsWithoutRef > 0).length / ok.length : null,
    unacceptable_passage_hits: ok.reduce((n, r) => n + r.unacceptableHit, 0),
    validated_rate: ok.length ? ok.filter((r) => r.validated).length / ok.length : null,
    dropped_blocks_total: ok.reduce((n, r) => n + r.droppedBlocks, 0),
    out_of_domain_handled: (() => {
      const rows = ok.filter((r) => r.respectedInsufficient !== null);
      return rows.length ? rows.filter((r) => r.respectedInsufficient).length / rows.length : null;
    })(),
  },
  latency_ms: {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    max: latencies.length ? Math.max(...latencies) : null,
  },
  degraded_responses: ok.filter((r) => r.degraded > 0).length,
  wall_clock_s: Math.round((Date.now() - started) / 1000),
};

console.log("\n" + "=".repeat(66));
console.log(`ARM: ${report.arm}    ${report.succeeded}/${report.questionsRun} succeeded`);
console.log("=".repeat(66));
console.log(`Ranking metrics scored on ${report.scoredForRanking} verified questions.`);
console.log(`${report.excludedPendingHumanReview} excluded pending human review — NOT counted.\n`);
for (const [k, v] of Object.entries(report.metrics)) console.log(`  ${k.padEnd(26)} ${fmt(v)}`);
console.log("\nSafety");
for (const [k, v] of Object.entries(report.safety)) console.log(`  ${k.padEnd(26)} ${fmt(v)}`);
console.log("\nLatency (ms)");
for (const [k, v] of Object.entries(report.latency_ms)) console.log(`  ${k.padEnd(26)} ${fmt(v, 0)}`);
console.log(`\n  degraded_responses         ${report.degraded_responses}`);

if (failed.length > 0) {
  console.log("\nFailures");
  for (const f of failed) console.log(`  ${f.id} [${f.category}] status=${f.status} code=${f.errorCode} req=${f.requestId ?? "—"}`);
}

console.log("\n--- JSON ---");
console.log(JSON.stringify({ report, results }, null, 2));

// Gate: any unacceptable passage surfaced, or any citation without a reference,
// is a hard failure regardless of how good the ranking metrics look.
const hardFail = report.safety.unacceptable_passage_hits > 0 || (report.safety.citation_faithfulness ?? 1) < 1;
process.exit(hardFail ? 1 : 0);
