/**
 * rpc-strict-errors.test.ts — The regression guard for the search outage.
 *
 * Every search_* RPC was dropped from the database. supabase-js RESOLVES rather
 * than rejects on a Postgres error, so `const { data } = await supabase.rpc(...)`
 * produced `undefined`, `data || []` produced `[]`, and a total infrastructure
 * failure was served to devotees as "no passages found" with HTTP 200.
 *
 * These tests assert the one invariant that makes that impossible: a database
 * error must throw, and a successful empty result must NOT. Everything runs
 * against an injected fake client — no network, no database.
 */
import { describe, it, expect, vi } from "vitest";
import {
  rpcOrThrow,
  rpcOrDegrade,
  unwrapOrThrow,
  isMissingFunctionError,
  describeRpcError,
  DegradationLog,
  type RpcCapableClient,
  type RpcResult,
} from "@/app/lib/search-v2/rpc";
import {
  SearchInfrastructureError,
  InvalidSearchInputError,
  isSearchError,
} from "@/app/lib/search-v2/errors";

/** A client that resolves with whatever shape the test wants. */
function fakeClient(result: RpcResult): RpcCapableClient {
  return { rpc: () => Promise.resolve(result) };
}

/** A client that rejects, as a network/abort failure does. */
function rejectingClient(err: unknown): RpcCapableClient {
  return { rpc: () => Promise.reject(err) };
}

const CTX = { stage: "retrieval:verses:fulltext", requestId: "req-1" };

/** The exact shape PostgREST returns when the function is not in its cache. */
const MISSING_FUNCTION_ERROR = {
  code: "PGRST202",
  message:
    "Could not find the function public.search_verses_fulltext_v2(match_count, search_query) in the schema cache",
  details: "Searched for the function public.search_verses_fulltext_v2 with parameters...",
  hint: "Perhaps you meant to call another function",
};

describe("rpcOrThrow — infrastructure failure can never look like emptiness", () => {
  it("returns rows on success", async () => {
    const rows = [{ id: "a" }, { id: "b" }];
    const out = await rpcOrThrow<typeof rows>(fakeClient({ data: rows, error: null }), "fn", {}, CTX);
    expect(out).toEqual(rows);
  });

  it("returns a genuine empty result as an empty array, without throwing", async () => {
    // This is the case that MUST still succeed: retrieval ran, found nothing.
    const out = await rpcOrThrow<unknown[]>(fakeClient({ data: [], error: null }), "fn", {}, CTX);
    expect(out).toEqual([]);
  });

  it("throws SearchInfrastructureError when the function is missing (PGRST202)", async () => {
    const client = fakeClient({ data: null, error: MISSING_FUNCTION_ERROR });
    await expect(rpcOrThrow(client, "search_verses_fulltext_v2", {}, CTX)).rejects.toBeInstanceOf(
      SearchInfrastructureError,
    );
  });

  it("does not return [] for a missing function — the outage behaviour", async () => {
    const client = fakeClient({ data: null, error: MISSING_FUNCTION_ERROR });
    let returned: unknown = "NEVER_ASSIGNED";
    try {
      returned = await rpcOrThrow(client, "search_verses_fulltext_v2", {}, CTX);
    } catch {
      /* expected */
    }
    expect(returned).toBe("NEVER_ASSIGNED");
    expect(returned).not.toEqual([]);
  });

  it("throws on a statement timeout", async () => {
    const client = fakeClient({
      data: null,
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    });
    await expect(rpcOrThrow(client, "fn", {}, CTX)).rejects.toBeInstanceOf(SearchInfrastructureError);
  });

  it("throws on permission denied", async () => {
    const client = fakeClient({
      data: null,
      error: { code: "42501", message: "permission denied for function" },
    });
    await expect(rpcOrThrow(client, "fn", {}, CTX)).rejects.toBeInstanceOf(SearchInfrastructureError);
  });

  it("throws when the client rejects (network / abort)", async () => {
    const client = rejectingClient(new Error("fetch failed"));
    await expect(rpcOrThrow(client, "fn", {}, CTX)).rejects.toBeInstanceOf(SearchInfrastructureError);
  });

  it("carries the request id and stage for correlation", async () => {
    const client = fakeClient({ data: null, error: MISSING_FUNCTION_ERROR });
    await expect(rpcOrThrow(client, "fn", {}, CTX)).rejects.toMatchObject({
      requestId: "req-1",
      stage: "retrieval:verses:fulltext",
    });
  });
});

describe("rpcOrDegrade — optional lanes soften, but visibly", () => {
  it("returns data on success and records nothing", async () => {
    const log = new DegradationLog("req-1");
    const out = await rpcOrDegrade(fakeClient({ data: [1, 2], error: null }), "fn", {}, CTX, [], log);
    expect(out).toEqual([1, 2]);
    expect(log.isEmpty).toBe(true);
  });

  it("returns the fallback and records the degradation on error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new DegradationLog("req-1");
    const out = await rpcOrDegrade(
      fakeClient({ data: null, error: MISSING_FUNCTION_ERROR }),
      "suggest_spelling",
      {},
      { stage: "enrichment:spelling", requestId: "req-1" },
      null,
      log,
    );
    expect(out).toBeNull();
    expect(log.list()).toEqual([
      { stage: "enrichment:spelling", source: "suggest_spelling", code: "PGRST202" },
    ]);
    warn.mockRestore();
  });

  it("records a rejection too, rather than propagating it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new DegradationLog("req-1");
    const out = await rpcOrDegrade(rejectingClient(new Error("boom")), "fn", {}, CTX, "fallback", log);
    expect(out).toBe("fallback");
    expect(log.isEmpty).toBe(false);
    warn.mockRestore();
  });
});

describe("unwrapOrThrow — direct table reads are held to the same rule", () => {
  it("returns data on success", () => {
    expect(unwrapOrThrow<number[]>({ data: [1], error: null }, "verses.ilike", CTX)).toEqual([1]);
  });

  it("throws on error rather than yielding null", () => {
    expect(() =>
      unwrapOrThrow({ data: null, error: { code: "42P01", message: "relation does not exist" } }, "verses.ilike", CTX),
    ).toThrow(SearchInfrastructureError);
  });
});

describe("error classification and redaction", () => {
  it("recognises both missing-function codes", () => {
    expect(isMissingFunctionError(MISSING_FUNCTION_ERROR)).toBe(true);
    expect(isMissingFunctionError({ code: "42883" })).toBe(true);
    expect(isMissingFunctionError({ code: "57014" })).toBe(false);
    expect(isMissingFunctionError(null)).toBe(false);
  });

  it("describes an error by code only — never message, details or hint", () => {
    const described = describeRpcError(MISSING_FUNCTION_ERROR);
    expect(described).toBe("PGRST202");
    expect(described).not.toContain("search_verses_fulltext_v2");
    expect(described).not.toContain("schema cache");
  });

  it("keeps SQL and internals out of the public error body", () => {
    const err = new SearchInfrastructureError(
      "search_verses_fulltext_v2 failed: relation public.verses does not exist",
      { requestId: "req-9", stage: "retrieval:verses:fulltext" },
    );
    const body = JSON.stringify(err.toPublicJSON());
    expect(body).not.toContain("verses");
    expect(body).not.toContain("search_verses_fulltext_v2");
    expect(err.toPublicJSON().code).toBe("search_infrastructure_error");
    expect(err.toPublicJSON().request_id).toBe("req-9");
  });

  it("maps each failure class to its intended HTTP status", () => {
    expect(new InvalidSearchInputError("bad").status).toBe(400);
    expect(new SearchInfrastructureError("db").status).toBe(503);
  });

  it("identifies typed failures so the route can separate them from bugs", () => {
    expect(isSearchError(new SearchInfrastructureError("db"))).toBe(true);
    expect(isSearchError(new Error("ordinary"))).toBe(false);
  });
});
