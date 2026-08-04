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
