/**
 * Preview-only owner endpoint that mints one exact-search snapshot session.
 *
 * The HMAC is supplied by an owner-side tool, never page JavaScript. The
 * resulting cookie is HttpOnly and bound to the normalized question plus the
 * speaker-filter mode so EventSource can carry it without exposing a secret.
 */
import { NextRequest } from "next/server";
import {
  authorizeSnapshotSession,
  mintSnapshotSession,
  snapshotSessionCookie,
  type SnapshotTarget,
} from "@/app/lib/search-v2/diagnostic-session";

export const runtime = "nodejs";

const MAX_QUERY_CHARS = 2000;

export async function POST(request: NextRequest): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.q === "string" ? record.q.trim() : "";
  if (!query || query.length > MAX_QUERY_CHARS || typeof record.onlyHis !== "boolean") {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  const target: SnapshotTarget = { query, speakerOnly: record.onlyHis };

  try {
    const authorization = authorizeSnapshotSession(request, target);
    const { token } = mintSnapshotSession(target, authorization);
    return new Response(null, {
      status: 204,
      headers: {
        "Cache-Control": "private, no-store",
        "Set-Cookie": snapshotSessionCookie(token),
      },
    });
  } catch {
    console.warn(JSON.stringify({ level: "warn", event: "search.snapshot_authorization_rejected" }));
    return Response.json({ error: "Not found." }, { status: 404 });
  }
}
