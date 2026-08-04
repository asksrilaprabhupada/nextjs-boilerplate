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
import { GATE_QUESTIONS, runPlannerGate } from "@/app/lib/search-v2/planner-gate";

/** 195 planner calls at ~2.3 s, four at a time, is ~2 minutes. */
export const maxDuration = 300;

/** A ceiling on the paid work one request can start. */
const MAX_PLANNER_CALLS_PER_REQUEST = 240;

const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404 });

function positiveInt(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
    concurrency: positiveInt(params.get("concurrency"), 4),
  });

  return NextResponse.json(
    { ...report, wallClockMs: Date.now() - startedAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
