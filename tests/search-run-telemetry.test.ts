import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allowlistedTechnicalTelemetry,
  beginSearchRun,
  completeSearchRun,
  failureTechnicalTelemetry,
  resultFieldsForTelemetry,
  sourceDurationsForTelemetry,
  telemetryQuestionHash,
  type SearchRunCompletionInput,
  type SearchRunWriteAdapter,
} from "@/app/lib/search-v2/search-run-telemetry";
import { SearchInfrastructureError } from "@/app/lib/search-v2/errors";
import type { SearchTelemetry } from "@/app/lib/search-v2/pipeline";

const startInput = {
  requestId: "req-telemetry",
  questionHash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  environment: "preview" as const,
  deploymentSha: "abc123",
};

const completionInput: SearchRunCompletionInput = {
  status: "success",
  query: "How to control the mind?",
  searchMethod: "pipeline",
  totalDurationMs: 1234,
  result: {
    totalResults: 2,
    verseIds: [],
    proseIds: [],
    booksReturned: [],
    queryVariants: [],
  },
  stageDurationsMs: { retrieving: 500 },
  sourceDurationsMs: { search_transcripts_hybrid_batch_v3: [500] },
  telemetry: { questionHash: startInput.questionHash },
};

function adapter(overrides: Partial<SearchRunWriteAdapter> = {}): SearchRunWriteAdapter {
  return {
    begin: async () => "00000000-0000-4000-8000-000000000001",
    complete: async () => undefined,
    ...overrides,
  };
}

function telemetryFixture(): SearchTelemetry {
  return {
    requestId: "req-private",
    plannedIntent: "verbatim private question content",
    questionHash: startInput.questionHash,
    pipelineVersion: "v2",
    corpusVersion: "corpus-v1",
    subqueryCount: 2,
    planSource: "gemini",
    tableRpcCount: 1,
    tableRpcAttemptCount: 1,
    vocabularyRpcCount: 0,
    refetchCount: 2,
    embeddingProviderCalls: 1,
    candidatesBeforeFusion: 3,
    candidatesAfterFusion: 2,
    duplicatesCollapsed: 1,
    junkFloorDropped: 0,
    prefilterPassed: 2,
    prefilterSetAside: 0,
    rerankDocumentCount: 2,
    reranked: true,
    selectedPassageCount: 1,
    mainTierCount: 1,
    additionalCount: 1,
    cutIndex: 1,
    cutGap: 0.2,
    pinnedExactReference: false,
    droppedOnRefetch: 0,
    degraded: false,
    degradedStages: [],
    sourceRetrieval: [{
      source: "Lectures and conversations",
      internalFunction: "search_transcripts_hybrid_batch_v3",
      stage: "retrieval:batch:search_transcripts_hybrid_batch_v3",
      operation: "initial",
      durationMs: 500,
      success: true,
      code: null,
      candidateCount: 150,
      outerLimit: 150,
      semanticLimit: 300,
      attemptCount: 1,
      attempts: [{ attempt: 1, durationMs: 499, outcome: "success", code: null }],
    }],
    degradedSources: [],
    stageDurationsMs: { retrieving: 500 },
    totalDurationMs: 1234,
    models: {
      queryPlanner: "gemini-2.5-flash",
      reranker: "rerank-v4.0-pro",
      articlePlanner: "gemini-2.5-flash",
    },
    errorCategory: null,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("search telemetry lifecycle writes", () => {
  it("awaits the running-row insert", async () => {
    let release: ((id: string) => void) | undefined;
    const begin = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const pending = beginSearchRun(startInput, { adapter: adapter({ begin }), deadlineMs: 1_000 });
    let settled = false;
    void pending.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    release?.("00000000-0000-4000-8000-000000000002");

    await expect(pending).resolves.toEqual({
      rowId: "00000000-0000-4000-8000-000000000002",
      requestId: startInput.requestId,
      questionHash: startInput.questionHash,
    });
  });

  it("awaits the final update instead of firing and forgetting", async () => {
    let release: (() => void) | undefined;
    const complete = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const handle = await beginSearchRun(startInput, { adapter: adapter() });
    const pending = completeSearchRun(handle, completionInput, {
      adapter: adapter({ complete }),
      deadlineMs: 1_000,
    });
    let settled = false;
    void pending.then(() => { settled = true; });

    await Promise.resolve();
    expect(settled).toBe(false);
    release?.();

    await expect(pending).resolves.toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  });

  it("fails open and aborts a write that exceeds its deadline", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let observedSignal: AbortSignal | undefined;
    const begin = vi.fn((_input, signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
      observedSignal = signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));

    await expect(beginSearchRun(startInput, {
      adapter: adapter({ begin }),
      deadlineMs: 5,
    })).resolves.toBeNull();
    expect(observedSignal?.aborted).toBe(true);
  });

  it("never lets a terminal telemetry error replace the search result", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const complete = vi.fn(async () => {
      throw Object.assign(new Error("private database response"), { code: "PGRST204" });
    });
    const handle = await beginSearchRun(startInput, { adapter: adapter() });

    await expect(completeSearchRun(handle, completionInput, {
      adapter: adapter({ complete }),
    })).resolves.toBe(false);
  });
});

describe("technical telemetry minimization", () => {
  it("uses a full normalized SHA-256 digest for durable correlation", () => {
    const hash = telemetryQuestionHash("  How   to control the mind?!  ");

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(telemetryQuestionHash("how to control the mind"));
  });

  it("serializes only the explicit technical allowlist", () => {
    const oversized = {
      ...telemetryFixture(),
      rawQuestion: "private spiritual question",
      providerResponse: { answer: "provider prose" },
      arbitraryError: new Error("SELECT secret_table"),
    } as SearchTelemetry;

    const stored = allowlistedTechnicalTelemetry(oversized, "miss", startInput.questionHash);
    const serialized = JSON.stringify(stored);

    expect(serialized).toContain("voyage-context-4");
    expect(serialized).toContain('"semanticLimit":300');
    expect(serialized).not.toContain("req-private");
    expect(serialized).not.toContain("verbatim private question content");
    expect(serialized).not.toContain("private spiritual question");
    expect(serialized).not.toContain("provider prose");
    expect(serialized).not.toContain("secret_table");
  });

  it("keeps every duration when one source has a fail-open second invocation", () => {
    const first = telemetryFixture().sourceRetrieval[0];
    const second = { ...first, operation: "constraint_fail_open" as const, durationMs: 275 };

    expect(sourceDurationsForTelemetry([first, second])).toEqual({
      search_transcripts_hybrid_batch_v3: [500, 275],
    });
  });

  it("extracts result ids and counts without passage text", () => {
    const stored = resultFieldsForTelemetry({
      totalResults: 2,
      articleVerseIds: ["11111111-1111-4111-8111-111111111111"],
      queryVariants: ["mind control"],
      passages: [{
        type: "book",
        id: "book:22222222-2222-4222-8222-222222222222",
        reference: "Bhagavad-gita chapter",
        text: "exact corpus passage must not be logged here",
      }],
    });

    expect(stored).toEqual({
      totalResults: 2,
      verseIds: ["11111111-1111-4111-8111-111111111111"],
      proseIds: ["22222222-2222-4222-8222-222222222222"],
      booksReturned: ["Bhagavad-gita"],
      queryVariants: ["mind control"],
    });
    expect(JSON.stringify(stored)).not.toContain("exact corpus passage");
  });

  it("reduces a typed failure to safe codes and numeric timings", () => {
    const err = new SearchInfrastructureError("raw SQL SELECT private_table", {
      stage: "retrieval:batch:search_transcripts_hybrid_batch_v3",
      source: "search_transcripts_hybrid_batch_v3",
      databaseCode: "57014",
      totalDurationMs: 8123,
      sourceFailures: [{
        source: "search_transcripts_hybrid_batch_v3",
        stage: "retrieval:batch:search_transcripts_hybrid_batch_v3",
        databaseCode: "57014",
        transportCode: null,
        internalCode: null,
        attemptCount: 1,
        durationMs: 8123,
      }],
      cause: new Error("stack contains a secret"),
    });

    const stored = failureTechnicalTelemetry(startInput.questionHash, err);
    const serialized = JSON.stringify(stored);

    expect(stored.errorCode).toBe("search_infrastructure_error");
    expect(stored.sourceDurationsMs).toEqual({
      search_transcripts_hybrid_batch_v3: [8123],
    });
    expect(serialized).toContain("57014");
    expect(serialized).not.toContain("private_table");
    expect(serialized).not.toContain("stack contains a secret");
  });
});
