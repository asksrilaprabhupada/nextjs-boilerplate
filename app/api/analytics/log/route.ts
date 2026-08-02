/**
 * route.ts — Analytics Log Route
 *
 * Retired raw-query logger.
 *
 * Search lifecycle telemetry is written server-side by `/api/search`. Keeping
 * this unauthenticated service-role proxy active would let any caller bypass the
 * owner's hash-only policy and persist arbitrary raw questions and identifiers.
 */
import { NextResponse } from "next/server";

export async function POST() {
  return NextResponse.json(
    { error: "Legacy raw search logging is disabled." },
    { status: 410 },
  );
}
