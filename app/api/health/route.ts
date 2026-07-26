/**
 * route.ts — Dependency health check.
 *
 * GET /api/health
 *
 * Answers one question: can this deployment actually serve a search? During the
 * outage the answer was no, but every probe you could run said yes — the search
 * endpoint returned HTTP 200 with an empty result. This endpoint reads the
 * database's own contract manifest (search_rpc_contract_v1) so a missing or
 * signature-drifted RPC is visible without waiting for a devotee to notice.
 *
 * The public body carries status, search availability and a request id, and
 * nothing else. Which functions are missing, and why, goes to the server log
 * joined by that id — a health endpoint must not hand an unauthenticated caller
 * a map of the schema.
 *
 * Calls no paid provider.
 */
import { NextResponse } from "next/server";
import { getSupabaseAdmin, hasSupabaseCredentials } from "@/app/lib/01-supabase";
import { newRequestId } from "@/app/lib/search-v2/errors";
import { describeRpcError, type RpcCapableClient } from "@/app/lib/search-v2/rpc";

export const dynamic = "force-dynamic";

interface ContractRow {
  rpc_name: string;
  present: boolean;
  overloads: number;
  security_definer: boolean | null;
}

type SearchHealth = "available" | "unavailable";

export async function GET() {
  const requestId = newRequestId();

  if (!hasSupabaseCredentials()) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "health.config_missing",
        requestId,
        detail: "SUPABASE_URL or SUPABASE_SERVICE_KEY absent",
      }),
    );
    return healthResponse("unavailable", requestId);
  }

  let rows: ContractRow[] | null = null;
  try {
    const db = getSupabaseAdmin() as unknown as RpcCapableClient;
    const { data, error } = await db.rpc("search_rpc_contract_v1", {});
    if (error) {
      console.error(
        JSON.stringify({
          level: "error",
          event: "health.contract_rpc_failed",
          requestId,
          code: describeRpcError(error),
        }),
      );
      return healthResponse("unavailable", requestId);
    }
    rows = (data ?? []) as ContractRow[];
  } catch (err) {
    console.error(
      JSON.stringify({ level: "error", event: "health.contract_threw", requestId }),
      err,
    );
    return healthResponse("unavailable", requestId);
  }

  const missing = rows.filter(r => !r.present).map(r => r.rpc_name);
  const ambiguous = rows.filter(r => r.overloads > 1).map(r => r.rpc_name);

  if (missing.length > 0 || ambiguous.length > 0) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "health.contract_broken",
        requestId,
        missing,
        ambiguous,
      }),
    );
    return healthResponse("unavailable", requestId);
  }

  return healthResponse("available", requestId);
}

function healthResponse(search: SearchHealth, requestId: string) {
  return NextResponse.json(
    {
      status: search === "available" ? "healthy" : "degraded",
      search,
      request_id: requestId,
    },
    {
      status: search === "available" ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
