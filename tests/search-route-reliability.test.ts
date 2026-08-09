import { afterEach, describe, expect, it, vi } from "vitest";
import {
  failureResponseBody,
  writeResponseCacheIfEligible,
} from "@/app/api/search/route";
import { SearchInfrastructureError } from "@/app/lib/search-v2/errors";
import type { DegradedSource } from "@/app/lib/types/01-search";

const degradedSource: DegradedSource = {
  source: "Lectures and conversations",
  reason: "temporarily unavailable",
};

function cacheAdmission({
  degraded = false,
  degradedSources = [],
  evidenceInsufficient = false,
}: {
  degraded?: boolean;
  degradedSources?: DegradedSource[];
  evidenceInsufficient?: boolean;
} = {}) {
  return {
    evidenceInsufficient,
    telemetry: { degraded, degradedSources: degradedSources.map((item) => item.source) },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("search failure response redaction", () => {
  it("returns only the stable public error, code, and request id", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const error = new SearchInfrastructureError(
      "search_transcripts_hybrid_batch_v3 failed for private question text",
      {
        requestId: "internal-request-id",
        stage: "retrieval:batch:search_transcripts_hybrid_batch_v3",
        source: "search_transcripts_hybrid_batch_v3",
        databaseCode: "57014",
        attemptCount: 1,
        attempts: [
          { attempt: 1, durationMs: 8123, outcome: "response_error", code: "57014" },
        ],
        totalDurationMs: 8123,
        sourceFailures: [
          {
            source: "search_transcripts_hybrid_batch_v3",
            stage: "retrieval:batch:search_transcripts_hybrid_batch_v3",
            databaseCode: "57014",
            transportCode: null,
            internalCode: null,
            attemptCount: 1,
            durationMs: 8123,
          },
        ],
        cause: new Error("raw postgres message with SELECT secret_table"),
      },
    );

    const response = failureResponseBody(error, "public-request-id");

    expect(response).toEqual({
      status: 503,
      body: {
        error: "Search is temporarily unavailable. Please try again shortly.",
        code: "search_infrastructure_error",
        request_id: "public-request-id",
      },
    });
    const wire = JSON.stringify(response.body);
    expect(wire).not.toContain("search_transcripts_hybrid_batch_v3");
    expect(wire).not.toContain("57014");
    expect(wire).not.toContain("private question text");
    expect(wire).not.toContain("raw postgres message");
    expect(wire).not.toContain("secret_table");
  });

  it("redacts an unexpected error to a fixed internal-error body", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = failureResponseBody(
      new Error("stack and SQL SELECT * FROM private_table"),
      "public-request-id",
    );

    expect(response).toEqual({
      status: 500,
      body: {
        error: "An error occurred.",
        code: "internal_error",
        request_id: "public-request-id",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("private_table");
  });
});

describe("response cache admission", () => {
  it("never writes a response marked degraded", async () => {
    const writer = vi.fn(async () => undefined);
    const wrote = await writeResponseCacheIfEligible(
      "response:key",
      { degraded: true },
      cacheAdmission({ degraded: true }),
      writer,
    );

    expect(wrote).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it("never writes when any degraded source is present, even if the aggregate flag is false", async () => {
    const writer = vi.fn(async () => undefined);
    const wrote = await writeResponseCacheIfEligible(
      "response:key",
      { degraded: false, degradedSources: [degradedSource] },
      cacheAdmission({ degradedSources: [degradedSource] }),
      writer,
    );

    expect(wrote).toBe(false);
    expect(writer).not.toHaveBeenCalled();
  });

  it("writes one clean, evidence-bearing response through the injected writer", async () => {
    const writer = vi.fn(async () => undefined);
    const value = { degraded: false, degradedSources: [], totalResults: 3 };
    const wrote = await writeResponseCacheIfEligible(
      "response:key",
      value,
      cacheAdmission(),
      writer,
    );

    expect(wrote).toBe(true);
    expect(writer).toHaveBeenCalledOnce();
    expect(writer).toHaveBeenCalledWith("response:key", value);
  });
});
