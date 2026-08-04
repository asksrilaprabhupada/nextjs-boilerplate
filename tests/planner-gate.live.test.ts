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
const runs = Number(process.env.PLANNER_GATE_RUNS ?? 3);
const limit = Number(process.env.PLANNER_GATE_LIMIT ?? GATE_QUESTIONS.length);

describe.skipIf(!enabled)("live planner gate", () => {
  it(
    "plans five distinct angles for every gold-set question, on every run",
    async () => {
      const startedAt = Date.now();
      const report = await runPlannerGate({ runsPerQuestion: runs, limit, concurrency: 6 });
      console.log(renderPlannerGateText({ ...report, wallClockMs: Date.now() - startedAt }));

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
