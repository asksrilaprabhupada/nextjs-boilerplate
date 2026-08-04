/**
 * planner-gate.test.ts — The gate harness itself, checked offline.
 *
 * The gate's verdict is the thing a merge decision rests on, so the harness
 * must not be able to report a pass it did not measure. With no API key every
 * planner call falls back, and the report must say so in every field rather
 * than quietly counting a fallback as a plan.
 */
import { describe, it, expect } from "vitest";
import { GATE_QUESTIONS, runPlannerGate } from "@/app/lib/search-v2/planner-gate";
import { REQUIRED_SUBQUERIES } from "@/app/lib/search-v2/query-plan";

describe("planner gate harness", () => {
  it("covers the whole gold set, in gold-set order", () => {
    expect(GATE_QUESTIONS.length).toBeGreaterThanOrEqual(60);
    expect(GATE_QUESTIONS[0].id).toBe("q001");
    expect(GATE_QUESTIONS.every((q) => q.question.trim().length > 0)).toBe(true);
  });

  it("never reports a pass when every plan fell back", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const report = await runPlannerGate({ runsPerQuestion: 2, limit: 3 });
      expect(report.requiredAngles).toBe(REQUIRED_SUBQUERIES);
      expect(report.totalRuns).toBe(6);
      expect(report.acceptedRuns).toBe(0);
      expect(report.passedQuestions).toBe(0);
      expect(report.failedQuestionIds).toHaveLength(3);
      expect(report.failureKindCounts).toEqual({ api_key_absent: 6 });
      // A run that never reached the provider spent nothing, and the report
      // must not invent a price for it.
      expect(report.tokens.promptTotal).toBe(0);
      expect(report.costUsd.total).toBe(0);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });

  it("pages through the question list rather than always starting at the top", async () => {
    const saved = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const report = await runPlannerGate({ runsPerQuestion: 1, offset: 2, limit: 2 });
      expect(report.results.map((r) => r.id)).toEqual([
        GATE_QUESTIONS[2].id,
        GATE_QUESTIONS[3].id,
      ]);
    } finally {
      if (saved !== undefined) process.env.GEMINI_API_KEY = saved;
    }
  });
});
