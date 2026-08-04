/**
 * plan-probe/route.ts — The A1 planner gate, runnable against a Preview build.
 *
 * PREVIEW ONLY. In production, and in any environment that is not a Vercel
 * preview deployment, this route does not exist: it answers 404 before reading
 * a parameter or spending a token.
 *
 * Why it exists at all: the gate for the query-planner fix is a claim about
 * behaviour in the deployed runtime — "five distinct angles, every question,
 * inside 3 s". A laptop measures a different network to Gemini than a Vercel
 * function does, and the 3 s cap is a statement about the function. So the
 * measurement runs where the cap applies.
 *
 * Why it is not an open door: the only questions it will plan are the gold-set
 * questions, selected by id. There is no free-text parameter, so it cannot be
 * turned into an unmetered Gemini proxy, and the work per request is bounded by
 * an explicit cap on questions × runs.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  GATE_QUESTIONS,
  PLANNER_RATE_USD_PER_MTOK,
  runPlannerGate,
  type PlannerGateReport,
} from "@/app/lib/search-v2/planner-gate";

/** 195 planner calls at ~2.3 s, four at a time, is ~2 minutes. */
export const maxDuration = 300;

/** A ceiling on the paid work one request can start. */
const MAX_PLANNER_CALLS_PER_REQUEST = 240;

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * A report a human can read in a browser tab.
 *
 * `?format=text` exists because the person who has to run this gate is not
 * reading raw JSON, and because a preview URL opened in a logged-in browser is
 * the one way to reach a protected deployment without handing anyone a token.
 * Failing questions are printed in full; passing ones get a single line.
 */
function renderText(report: PlannerGateReport & { wallClockMs: number }): string {
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
  lines.push("PLANNING TIME (milliseconds, one planner call each)");
  lines.push(
    `  fastest ${report.durationMs.min}   median ${report.durationMs.median}`
    + `   p95 ${report.durationMs.p95}   slowest ${report.durationMs.max}`,
  );
  lines.push("  the cap is 3000 ms per attempt — p95 is the number that matters");
  lines.push("");
  lines.push("TOKENS AND COST");
  lines.push(`  prompt tokens   ${report.tokens.promptTotal.toLocaleString("en-US")}`);
  lines.push(`  output tokens   ${report.tokens.outputTotal.toLocaleString("en-US")}`);
  lines.push(`  thinking tokens ${report.tokens.thoughtsTotal} (must be 0)`);
  lines.push(
    `  cost per search $${report.costUsd.perSearch.toFixed(6)}`
    + `   this whole run $${report.costUsd.total.toFixed(4)}`,
  );
  lines.push(
    `  at $${PLANNER_RATE_USD_PER_MTOK.input}/M input and `
    + `$${PLANNER_RATE_USD_PER_MTOK.output}/M output — check these against Google's pricing page`,
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

export async function GET(request: NextRequest) {
  if (process.env.VERCEL_ENV !== "preview") return notFound();

  const params = new URL(request.url).searchParams;
  const runs = Math.min(5, positiveInt(params.get("runs"), 3));
  const offset = Math.max(0, Number(params.get("offset")) || 0);
  const limit = Math.min(
    GATE_QUESTIONS.length,
    positiveInt(params.get("limit"), GATE_QUESTIONS.length),
  );

  if (runs * limit > MAX_PLANNER_CALLS_PER_REQUEST) {
    return NextResponse.json(
      {
        error: `runs × limit exceeds ${MAX_PLANNER_CALLS_PER_REQUEST}; page through with offset`,
        questionCount: GATE_QUESTIONS.length,
      },
      { status: 400 },
    );
  }

  const startedAt = Date.now();
  const report = await runPlannerGate({
    runsPerQuestion: runs,
    offset,
    limit,
    concurrency: positiveInt(params.get("concurrency"), 6),
  });
  const withWallClock = { ...report, wallClockMs: Date.now() - startedAt };

  if (params.get("format") === "text") {
    return new Response(renderText(withWallClock), {
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  }
  return NextResponse.json(withWallClock, { headers: { "Cache-Control": "no-store" } });
}
