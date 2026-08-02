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
import { createClient } from "@supabase/supabase-js";
import {
  rpcOrThrow,
  rpcOrThrowMeasured,
  rpcOrDegrade,
  unwrapOrThrow,
  isMissingFunctionError,
  describeRpcError,
  DegradationLog,
  DefiniteSupabaseTransportError,
  RPC_TRANSPORT_RETRY_DELAY_MS,
  type RpcCapableClient,
  type RpcRequest,
  type RpcResult,
} from "@/app/lib/search-v2/rpc";
import {
  SearchInfrastructureError,
  ProviderUnavailableError,
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

type StrictRpcOutcome =
  | { kind: "resolve"; result: RpcResult }
  | { kind: "reject"; error: unknown };

/** A postgrest-like request whose strict path is observable and scriptable. */
function throwOnErrorAwareClient(outcomes: readonly StrictRpcOutcome[]): {
  client: RpcCapableClient;
  rpc: ReturnType<typeof vi.fn>;
  throwOnError: ReturnType<typeof vi.fn>;
} {
  const queue = [...outcomes];
  const throwOnError = vi.fn();
  const rpc = vi.fn((): RpcRequest => {
    const outcome = queue.shift();
    if (!outcome) throw new Error("Unexpected extra RPC attempt");

    // The non-strict PromiseLike must never be awaited by rpcOrThrowMeasured.
    const request = Promise.resolve({ data: null, error: null }) as RpcRequest;
    request.throwOnError = () => {
      throwOnError();
      return outcome.kind === "resolve"
        ? Promise.resolve(outcome.result)
        : Promise.reject(outcome.error);
    };
    return request;
  });

  return { client: { rpc } as RpcCapableClient, rpc, throwOnError };
}

/** Deterministic monotonic test clock: every observation advances by 10 ms. */
function monotonicClock(): () => number {
  let now = 0;
  return () => {
    const observed = now;
    now += 10;
    return observed;
  };
}

async function captureInfrastructureError(promise: Promise<unknown>): Promise<SearchInfrastructureError> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(SearchInfrastructureError);
  return caught as SearchInfrastructureError;
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

describe("rpcOrThrowMeasured — one definite transport retry, never a database retry", () => {
  it.each([
    {
      label: "statement cancellation 57014",
      error: { code: "57014", message: "canceling statement due to statement timeout" },
      databaseCode: "57014",
    },
    {
      label: "permission response",
      error: { code: "42501", message: "permission denied for function" },
      databaseCode: "42501",
    },
    {
      label: "PostgREST response",
      error: MISSING_FUNCTION_ERROR,
      databaseCode: "PGRST202",
    },
    {
      label: "opaque resolved Supabase error",
      error: { message: "an error shape with no stable code" },
      databaseCode: "unknown",
    },
  ])("does not retry a resolved $label", async ({ error, databaseCode }) => {
    const responses: RpcResult[] = [
      { data: null, error },
      { data: [{ id: "must-not-be-used" }], error: null },
    ];
    const rpc = vi.fn(() => Promise.resolve(responses.shift()!));
    const sleep = vi.fn(async () => {});

    const failure = await captureInfrastructureError(
      rpcOrThrowMeasured(
        { rpc } as RpcCapableClient,
        "fn",
        {},
        CTX,
        { sleep, monotonicNow: monotonicClock() },
      ),
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(failure.databaseCode).toBe(databaseCode);
    expect(failure.transportCode).toBeNull();
    expect(failure.attemptCount).toBe(1);
    expect(failure.attempts).toEqual([
      { attempt: 1, durationMs: 10, outcome: "response_error", code: databaseCode },
    ]);
  });

  it("retries one branded pre-response transport failure exactly once through throwOnError", async () => {
    const transport = new DefiniteSupabaseTransportError("ECONNRESET", new Error("socket reset"));
    const { client, rpc, throwOnError } = throwOnErrorAwareClient([
      { kind: "reject", error: transport },
      { kind: "resolve", result: { data: [{ id: "recovered" }], error: null } },
    ]);
    const sleep = vi.fn(async () => {});

    const measured = await rpcOrThrowMeasured<{ id: string }[]>(client, "fn", {}, CTX, {
      sleep,
      monotonicNow: monotonicClock(),
    });

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(throwOnError).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(RPC_TRANSPORT_RETRY_DELAY_MS);
    expect(measured.data).toEqual([{ id: "recovered" }]);
    expect(measured.attempts).toEqual([
      { attempt: 1, durationMs: 10, outcome: "transport_error", code: "ECONNRESET" },
      { attempt: 2, durationMs: 10, outcome: "success", code: null },
    ]);
  });

  it("caps two branded transport failures at two attempts", async () => {
    const { client, rpc, throwOnError } = throwOnErrorAwareClient([
      {
        kind: "reject",
        error: new DefiniteSupabaseTransportError("ECONNRESET", new Error("first reset")),
      },
      {
        kind: "reject",
        error: new DefiniteSupabaseTransportError("EAI_AGAIN", new Error("dns still unavailable")),
      },
    ]);
    const sleep = vi.fn(async () => {});

    const failure = await captureInfrastructureError(
      rpcOrThrowMeasured(client, "fn", {}, CTX, {
        sleep,
        monotonicNow: monotonicClock(),
      }),
    );

    expect(rpc).toHaveBeenCalledTimes(2);
    expect(throwOnError).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(failure.databaseCode).toBeNull();
    expect(failure.transportCode).toBe("EAI_AGAIN");
    expect(failure.attemptCount).toBe(2);
    expect(failure.attempts.map((attempt) => attempt.outcome)).toEqual([
      "transport_error",
      "transport_error",
    ]);
    expect(JSON.stringify(failure.toPublicJSON())).not.toContain("EAI_AGAIN");
  });

  it.each([
    {
      label: "application abort",
      error: Object.assign(new Error("application deadline"), { name: "AbortError" }),
      outcome: "aborted",
    },
    {
      label: "provider failure",
      error: new ProviderUnavailableError("provider timed out", { stage: "embedding" }),
      outcome: "provider_error",
    },
    {
      label: "plain unknown rejection",
      error: new Error("unexpected client failure"),
      outcome: "unknown_error",
    },
    {
      label: "unbranded network-looking rejection",
      error: Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } }),
      outcome: "unknown_error",
    },
  ] as const)("does not retry a $label", async ({ error, outcome }) => {
    const { client, rpc, throwOnError } = throwOnErrorAwareClient([
      { kind: "reject", error },
      { kind: "resolve", result: { data: [{ id: "must-not-be-used" }], error: null } },
    ]);
    const sleep = vi.fn(async () => {});

    const failure = await captureInfrastructureError(
      rpcOrThrowMeasured(client, "fn", {}, CTX, {
        sleep,
        monotonicNow: monotonicClock(),
      }),
    );

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(throwOnError).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(failure.attemptCount).toBe(1);
    expect(failure.attempts[0]).toMatchObject({ attempt: 1, outcome, code: null });
  });

  it("keeps structured failure evidence server-side and redacts the public body", async () => {
    const rawError = {
      code: "57014",
      message: "canceling statement in public.search_transcripts_hybrid_batch_v3",
      details: "select secret_column from private_table",
      hint: "internal operator advice",
    };
    const rpc = vi.fn(() => Promise.resolve({ data: null, error: rawError }));

    const failure = await captureInfrastructureError(
      rpcOrThrowMeasured(
        { rpc } as RpcCapableClient,
        "search_transcripts_hybrid_batch_v3",
        {},
        { stage: "retrieval:batch:transcripts", requestId: "req-structured" },
        { sleep: vi.fn(async () => {}), monotonicNow: monotonicClock() },
      ),
    );

    expect(failure).toMatchObject({
      source: "search_transcripts_hybrid_batch_v3",
      stage: "retrieval:batch:transcripts",
      databaseCode: "57014",
      transportCode: null,
      requestId: "req-structured",
      attemptCount: 1,
      totalDurationMs: 30,
    });
    expect(failure.attempts).toEqual([
      { attempt: 1, durationMs: 10, outcome: "response_error", code: "57014" },
    ]);

    const publicBody = JSON.stringify(failure.toPublicJSON());
    expect(failure.toPublicJSON()).toEqual({
      error: "Search is temporarily unavailable. Please try again shortly.",
      code: "search_infrastructure_error",
      request_id: "req-structured",
    });
    for (const internal of [
      "57014",
      "search_transcripts_hybrid_batch_v3",
      "retrieval:batch:transcripts",
      "secret_column",
      "private_table",
      "operator advice",
    ]) {
      expect(publicBody).not.toContain(internal);
    }
  });
});

describe("installed Supabase strict-mode boundary", () => {
  const sdkClient = (fetcher: typeof fetch): RpcCapableClient =>
    createClient("https://example.supabase.co", "test-service-key", {
      global: { fetch: fetcher },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    }) as unknown as RpcCapableClient;

  it("preserves the branded pre-response rejection and lets the app make exactly one retry", async () => {
    const branded = new DefiniteSupabaseTransportError("ECONNRESET", new Error("socket reset"));
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(branded)
      .mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const sleep = vi.fn(async () => {});

    const measured = await rpcOrThrowMeasured<unknown[]>(sdkClient(fetcher), "search_test", {}, CTX, {
      sleep,
      monotonicNow: monotonicClock(),
    });

    expect(measured.data).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(measured.attempts.map((attempt) => attempt.outcome)).toEqual([
      "transport_error",
      "success",
    ]);
  });

  it("turns an HTTP 57014 response into a non-retryable database failure", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "57014",
          message: "canceling statement due to statement timeout",
          details: null,
          hint: null,
        }),
        { status: 500, statusText: "Internal Server Error" },
      ),
    );
    const sleep = vi.fn(async () => {});

    const failure = await captureInfrastructureError(
      rpcOrThrowMeasured(sdkClient(fetcher), "search_test", {}, CTX, {
        sleep,
        monotonicNow: monotonicClock(),
      }),
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(failure.databaseCode).toBe("57014");
    expect(failure.attempts).toEqual([
      { attempt: 1, durationMs: 10, outcome: "response_error", code: "57014" },
    ]);
  });

  it("does not retry a response-body failure even when its cause looks transient", async () => {
    const responseWithBrokenBody = {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers(),
      text: async () => {
        throw Object.assign(new Error("body socket closed"), { cause: { code: "ECONNRESET" } });
      },
    } as unknown as Response;
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(responseWithBrokenBody);
    const sleep = vi.fn(async () => {});

    const failure = await captureInfrastructureError(
      rpcOrThrowMeasured(sdkClient(fetcher), "search_test", {}, CTX, {
        sleep,
        monotonicNow: monotonicClock(),
      }),
    );

    expect(fetcher).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
    expect(failure.databaseCode).toBeNull();
    expect(failure.transportCode).toBeNull();
    expect(failure.attempts[0]).toMatchObject({ outcome: "unknown_error", code: null });
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
