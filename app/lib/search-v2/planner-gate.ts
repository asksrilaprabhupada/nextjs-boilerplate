/**
 * planner-gate.ts — Measures the query planner, and nothing else.
 *
 * The A1 acceptance gate is a claim about the planner: every gold-set question
 * must produce five valid, genuinely distinct angles, repeatably, inside the
 * 3 s cap. Proving that by running whole searches would cost five database
 * fan-outs, a Voyage batch and ~600 Cohere documents per question — minutes and
 * real money per run, to measure a stage that finishes in two seconds. So this
 * runs the planner alone: same module, same prompt, same schema, same timeout.
 *
 * It is a MEASUREMENT, not a search. It reads no passage, touches no database
 * and returns no teaching. What it returns is timings, token counts, and which
 * angles came back — the evidence for a merge decision.
 *
 * The question list is the gold set, imported directly so the gate can never
 * drift from the evaluation set it claims to cover.
 */
import goldSet from "@/tests/gold/gold-set-v1.json";
import {
  planQuery,
  REQUIRED_SUBQUERIES,
  type PlanFailureKind,
} from "@/app/lib/search-v2/query-plan";

interface GoldQuestion {
  id: string;
  question: string;
  category: string;
}

export const GATE_QUESTIONS: GoldQuestion[] = (goldSet.questions as GoldQuestion[]).map((q) => ({
  id: q.id,
  question: q.question,
  category: q.category,
}));

/**
 * Published rates for the planner model, in US dollars per million tokens.
 * These are an INPUT to the report, not a measurement: the token counts are
 * observed, the money is arithmetic on top of a rate that should be checked
 * against Google's current pricing page before being quoted to anyone.
 */
export const PLANNER_RATE_USD_PER_MTOK = { input: 0.3, output: 2.5 };

export interface PlannerGateRun {
  runIndex: number;
  accepted: boolean;
  failureKind: PlanFailureKind | null;
  angleCount: number;
  attempts: number;
  durationMs: number;
  /** Each individual planner call. The cap is judged against these, not totals. */
  attemptDurationsMs: number[];
  promptTokens: number;
  outputTokens: number;
  thoughtsTokens: number;
  /** The angles themselves, so "distinct" can be judged by eye, not asserted. */
  angles: { role: string; priority: string; text: string }[];
  rejections: string[];
}

export interface PlannerGateQuestionResult {
  id: string;
  category: string;
  question: string;
  runs: PlannerGateRun[];
  /** Passes only when EVERY run produced the required number of valid angles. */
  passed: boolean;
}

export interface PlannerGateReport {
  requiredAngles: number;
  questionCount: number;
  runsPerQuestion: number;
  totalRuns: number;
  acceptedRuns: number;
  passedQuestions: number;
  failedQuestionIds: string[];
  failureKindCounts: Record<string, number>;
  /**
   * Latency of a SINGLE planner call — the quantity PLANNER_TIMEOUT_MS bounds.
   * Totals that span a retry are reported separately and must never be used to
   * set the cap.
   */
  attemptDurationMs: { count: number; min: number; median: number; p95: number; max: number };
  durationMs: { min: number; median: number; p95: number; max: number };
  tokens: { promptTotal: number; outputTotal: number; thoughtsTotal: number };
  /** Per accepted search, at the rates above. */
  costUsd: { perSearch: number; total: number };
  results: PlannerGateQuestionResult[];
}

function quantile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

const round = (value: number, places = 3): number => {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
};

/** Runs `pool` tasks at a time. Concurrency keeps a 195-call gate inside one
 *  function invocation; it does not change what any single call measures. */
async function mapPooled<T, R>(
  items: T[],
  pool: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(pool, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export interface PlannerGateOptions {
  runsPerQuestion?: number;
  offset?: number;
  limit?: number;
  concurrency?: number;
}

export async function runPlannerGate(options: PlannerGateOptions = {}): Promise<PlannerGateReport> {
  const runsPerQuestion = Math.min(5, Math.max(1, options.runsPerQuestion ?? 3));
  const offset = Math.max(0, options.offset ?? 0);
  const limit = Math.max(1, options.limit ?? GATE_QUESTIONS.length);
  const concurrency = Math.min(8, Math.max(1, options.concurrency ?? 4));
  const questions = GATE_QUESTIONS.slice(offset, offset + limit);

  // Every (question, run) pair is one unit of work, so the pool stays busy
  // instead of draining between questions.
  const units = questions.flatMap((question) =>
    Array.from({ length: runsPerQuestion }, (_, runIndex) => ({ question, runIndex })),
  );

  const measured = await mapPooled(units, concurrency, async ({ question, runIndex }) => {
    const planned = await planQuery(question.question, REQUIRED_SUBQUERIES);
    const run: PlannerGateRun = {
      runIndex,
      accepted: planned.source === "model",
      failureKind: planned.failureKind,
      angleCount: planned.plan.subqueries.length,
      attempts: planned.usage.attempts,
      durationMs: round(planned.usage.durationMs),
      attemptDurationsMs: planned.usage.attemptDurationsMs.map((d) => round(d)),
      promptTokens: planned.usage.promptTokens,
      outputTokens: planned.usage.outputTokens,
      thoughtsTokens: planned.usage.thoughtsTokens,
      angles: planned.plan.subqueries.map((s) => ({
        role: s.role,
        priority: s.priority,
        text: s.text,
      })),
      rejections: planned.rejections,
    };
    return { questionId: question.id, run };
  });

  const runsById = new Map<string, PlannerGateRun[]>();
  for (const { questionId, run } of measured) {
    const existing = runsById.get(questionId);
    if (existing) existing.push(run);
    else runsById.set(questionId, [run]);
  }

  const results: PlannerGateQuestionResult[] = questions.map((question) => {
    const runs = (runsById.get(question.id) ?? []).sort((a, b) => a.runIndex - b.runIndex);
    return {
      id: question.id,
      category: question.category,
      question: question.question,
      runs,
      passed:
        runs.length === runsPerQuestion
        && runs.every((r) => r.accepted && r.angleCount === REQUIRED_SUBQUERIES),
    };
  });

  const allRuns = results.flatMap((r) => r.runs);
  const durations = allRuns.map((r) => r.durationMs).sort((a, b) => a - b);
  const attemptDurations = allRuns
    .flatMap((r) => r.attemptDurationsMs)
    .sort((a, b) => a - b);
  const failureKindCounts: Record<string, number> = {};
  for (const run of allRuns) {
    if (run.failureKind === null) continue;
    failureKindCounts[run.failureKind] = (failureKindCounts[run.failureKind] ?? 0) + 1;
  }
  const promptTotal = allRuns.reduce((n, r) => n + r.promptTokens, 0);
  const outputTotal = allRuns.reduce((n, r) => n + r.outputTokens, 0);
  const totalCost =
    (promptTotal / 1_000_000) * PLANNER_RATE_USD_PER_MTOK.input
    + (outputTotal / 1_000_000) * PLANNER_RATE_USD_PER_MTOK.output;

  return {
    requiredAngles: REQUIRED_SUBQUERIES,
    questionCount: results.length,
    runsPerQuestion,
    totalRuns: allRuns.length,
    acceptedRuns: allRuns.filter((r) => r.accepted).length,
    passedQuestions: results.filter((r) => r.passed).length,
    failedQuestionIds: results.filter((r) => !r.passed).map((r) => r.id),
    failureKindCounts,
    attemptDurationMs: {
      count: attemptDurations.length,
      min: attemptDurations[0] ?? 0,
      median: quantile(attemptDurations, 0.5),
      p95: quantile(attemptDurations, 0.95),
      max: attemptDurations[attemptDurations.length - 1] ?? 0,
    },
    durationMs: {
      min: durations[0] ?? 0,
      median: quantile(durations, 0.5),
      p95: quantile(durations, 0.95),
      max: durations[durations.length - 1] ?? 0,
    },
    tokens: {
      promptTotal,
      outputTotal,
      thoughtsTotal: allRuns.reduce((n, r) => n + r.thoughtsTokens, 0),
    },
    costUsd: {
      perSearch: allRuns.length > 0 ? round(totalCost / allRuns.length, 6) : 0,
      total: round(totalCost, 6),
    },
    results,
  };
}

/**
 * A report a human can read in a browser tab.
 *
 * `?format=text` exists because the person who has to run this gate is not
 * reading raw JSON, and because a preview URL opened in a logged-in browser is
 * the one way to reach a protected deployment without handing anyone a token.
 * Failing questions are printed in full; passing ones get a single line.
 */
export function renderPlannerGateText(
  report: PlannerGateReport & { wallClockMs: number },
): string {
  const lines: string[] = [];
  const pct = (n: number, of: number) => (of === 0 ? "0%" : `${Math.round((n / of) * 100)}%`);

  lines.push("QUERY PLANNER GATE");
  lines.push("==================");
  lines.push("");
  lines.push(`Questions:        ${report.questionCount}`);
  lines.push(`Runs per question:${String(report.runsPerQuestion).padStart(2)}`);
  lines.push(`Angles required:  ${report.requiredAngles}`);
  lines.push("");
  lines.push(
    `PASSED ${report.passedQuestions} of ${report.questionCount} questions `
    + `(${pct(report.passedQuestions, report.questionCount)})`,
  );
  lines.push(
    `Plans accepted: ${report.acceptedRuns} of ${report.totalRuns} runs `
    + `(${pct(report.acceptedRuns, report.totalRuns)})`,
  );
  lines.push("");
  lines.push(`ONE PLANNER CALL, milliseconds (${report.attemptDurationMs.count} calls)`);
  lines.push(
    `  fastest ${report.attemptDurationMs.min}   median ${report.attemptDurationMs.median}`
    + `   p95 ${report.attemptDurationMs.p95}   slowest ${report.attemptDurationMs.max}`,
  );
  lines.push("  THIS is what the per-attempt cap must clear. p95 + 1 s sets it.");
  lines.push("");
  lines.push("WHOLE PLANNING STAGE, milliseconds (a retry makes this two calls)");
  lines.push(
    `  fastest ${report.durationMs.min}   median ${report.durationMs.median}`
    + `   p95 ${report.durationMs.p95}   slowest ${report.durationMs.max}`,
  );
  lines.push("");
  lines.push("TOKENS AND COST");
  lines.push(`  prompt tokens   ${report.tokens.promptTotal.toLocaleString("en-US")}`);
  lines.push(`  output tokens   ${report.tokens.outputTotal.toLocaleString("en-US")}`);
  lines.push(`  thinking tokens ${report.tokens.thoughtsTotal} (must be 0)`);
  lines.push(
    `  cost per search $${report.costUsd.perSearch.toFixed(6)}`
    + `   this whole run $${report.costUsd.total.toFixed(4)}`,
  );
  // ONE template, not two joined by `+`.
  //
  // Both rates are compile-time constants, and when every interpolation folds
  // to a constant the production minifier merges the two templates and DROPS
  // the left one's trailing text: this line built as "at $0.3$2.5/M output",
  // silently losing "/M input and". Verified on a clean `next build`, and only
  // in the minified build — the source is correct and Node prints it correctly,
  // which is what makes it worth a comment instead of a shrug. Lines above that
  // interpolate runtime values are unaffected, because nothing folds.
  lines.push(
    `  at $${PLANNER_RATE_USD_PER_MTOK.input}/M input and $${PLANNER_RATE_USD_PER_MTOK.output}/M output — check these against Google's pricing page`,
  );
  lines.push("");
  const kinds = Object.entries(report.failureKindCounts);
  lines.push(`FAILURES BY KIND: ${kinds.length === 0 ? "none" : ""}`);
  for (const [kind, count] of kinds.sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${kind.padEnd(24)} ${count}`);
  }
  lines.push("");
  lines.push(`Wall clock for this run: ${(report.wallClockMs / 1000).toFixed(1)} s`);
  lines.push("");

  const failed = report.results.filter((r) => !r.passed);
  if (failed.length > 0) {
    lines.push("QUESTIONS THAT DID NOT PASS");
    lines.push("---------------------------");
    for (const result of failed) {
      lines.push(`${result.id} [${result.category}] ${result.question}`);
      for (const run of result.runs) {
        lines.push(
          `  run ${run.runIndex + 1}: ${run.accepted ? "accepted" : "FELL BACK"} `
          + `· ${run.angleCount} angles · ${run.attempts} attempt(s) · ${run.durationMs} ms`
          + (run.failureKind ? ` · ${run.failureKind}` : ""),
        );
        for (const reason of run.rejections.slice(0, 4)) lines.push(`      ${reason}`);
      }
      lines.push("");
    }
  }

  lines.push("EVERY QUESTION, AND THE ANGLES ITS FIRST RUN PRODUCED");
  lines.push("----------------------------------------------------");
  for (const result of report.results) {
    const first = result.runs[0];
    const times = result.runs.map((r) => `${r.durationMs}ms`).join(" / ");
    lines.push(`${result.passed ? "PASS" : "FAIL"} ${result.id}  ${result.question}`);
    lines.push(`     ${times}`);
    for (const angle of first?.angles ?? []) {
      lines.push(`     · [${angle.role}] ${angle.text}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
