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
  result_matches: boolean;
  security_invoker: boolean;
  search_path_pinned: boolean;
  ef_search_pinned: boolean;
  service_role_executable: boolean;
  publicly_executable: boolean;
  /** Everything above, ANDed. The only field the decision actually needs. */
  compatible: boolean;
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

  // `compatible` is the real question, and it subsumes presence. A function can
  // exist and still be unusable: a drifted return type breaks the caller's
  // column mapping, a lost service_role grant makes every call fail, and a
  // semantic lane without a pinned ef_search silently loses recall.
  //
  // Checking only `present` would let this endpoint report healthy in exactly
  // those cases — the same shape of false reassurance that let the original
  // outage run for a day.
  const incompatible = rows.filter(r => !r.compatible);

  if (incompatible.length > 0) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "health.contract_broken",
        requestId,
        // Reasons, not just names, so the log alone explains the failure.
        broken: incompatible.map(r => ({
          rpc: r.rpc_name,
          why: [
            !r.present && "absent",
            r.overloads > 1 && `${r.overloads} overloads`,
            !r.result_matches && "return type drift",
            !r.security_invoker && "security definer",
            !r.search_path_pinned && "search_path unpinned",
            !r.ef_search_pinned && "ef_search unpinned",
            !r.service_role_executable && "service_role cannot execute",
            r.publicly_executable && "publicly executable",
          ].filter(Boolean),
        })),
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
