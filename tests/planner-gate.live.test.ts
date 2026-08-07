/**
 * planner-gate.live.test.ts — The A1 gate, run for real.
 *
 * SKIPPED unless PLANNER_GATE_LIVE=1 and a GEMINI_API_KEY is present, so `npm
 * test` stays offline, free and deterministic. When it does run it makes
 * questionCount × runs real planner calls and asserts the merge condition:
 * every gold-set question produces the required number of valid, distinct
 * angles on every run.
 *
 * The full report is printed rather than summarised. A gate that says only
 * "passed" is a gate nobody can check.
 */
import { describe, it, expect } from "vitest";
import {
  GATE_QUESTIONS,
  renderPlannerGateText,
  runPlannerGate,
} from "@/app/lib/search-v2/planner-gate";

const enabled = process.env.PLANNER_GATE_LIVE === "1" && Boolean(process.env.GEMINI_API_KEY);

/**
 * An unset workflow input arrives as "", not as undefined, so `??` does not
 * catch it and Number("") is 0 — which the harness clamps to 1. That is how a
 * run measured ONE question out of sixty-five and still reported green. Read
 * the value only when it is a usable positive number.
 */
function envCount(name: string, fallback: number): number {
  const raw = process.env[name];
  const parsed = Number(raw);
  return raw !== undefined && raw !== "" && Number.isFinite(parsed) && parsed > 0
    ? parsed
    : fallback;
}

const runs = envCount("PLANNER_GATE_RUNS", 3);
const limit = envCount("PLANNER_GATE_LIMIT", GATE_QUESTIONS.length);

describe.skipIf(!enabled)("live planner gate", () => {
  it(
    "plans five distinct angles for every gold-set question, on every run",
    async () => {
      const startedAt = Date.now();
      // ONE AT A TIME. A search makes exactly one planner call, so latency
      // measured six-in-flight is not the latency the 3 s cap applies to: the
      // first gate run read a p95 of 4,459 ms and blamed the planner for its
      // own harness. Serial is slower to run and is the only honest number.
      const report = await runPlannerGate({
        runsPerQuestion: runs,
        limit,
        concurrency: Number(process.env.PLANNER_GATE_CONCURRENCY) || 1,
      });
      console.log(renderPlannerGateText({ ...report, wallClockMs: Date.now() - startedAt }));

      // COVERAGE FIRST. A gate that measured one question out of sixty-five
      // and reported green is worse than no gate, because it is believed.
      expect(report.questionCount).toBe(limit);
      expect(report.runsPerQuestion).toBe(runs);
      expect(report.totalRuns).toBe(limit * runs);

      // The gate is "every one of them", not "most of them".
      expect(report.failedQuestionIds).toEqual([]);
      expect(report.passedQuestions).toBe(report.questionCount);
      expect(report.acceptedRuns).toBe(report.totalRuns);
      // Thinking must stay off — it is what broke the planner in the first place.
      expect(report.tokens.thoughtsTotal).toBe(0);
    },
    30 * 60 * 1000,
  );
});
