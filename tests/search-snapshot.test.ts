import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import {
  SNAPSHOT_NONCE_HEADER,
  SNAPSHOT_SESSION_COOKIE,
  SNAPSHOT_SIGNATURE_HEADER,
  SNAPSHOT_TIMESTAMP_HEADER,
  SnapshotAuthorizationRejectedError,
  authorizeSnapshotSession,
  mintSnapshotSession,
  readSnapshotSession,
  snapshotAuthorizationSignature,
  snapshotSessionCookie,
} from "@/app/lib/search-v2/diagnostic-session";
import {
  buildSearchSnapshotArtifact,
  persistSearchSnapshot,
  type SnapshotPersistence,
} from "@/app/lib/search-v2/search-snapshot";
import type { PipelineDiagnostics, SearchTelemetry } from "@/app/lib/search-v2/pipeline";
import { prepareSuccessfulResponse } from "@/app/api/search/route";

const secret = "0123456789abcdef0123456789abcdef";
const nowSeconds = 1785686400;
const timestamp = String(nowSeconds);
const nonce = "snapshot-session-nonce-0001";
const url = "https://preview.example/api/search/diagnostic-session";
const target = { query: "a private spiritual question", speakerOnly: true };
const authorization = { timestamp, nonce };

function signedAuthorization() {
  const request = { method: "POST", url };
  const signature = snapshotAuthorizationSignature({ request, target, timestamp, nonce, secret });
  return {
    ...request,
    headers: new Headers({
      [SNAPSHOT_TIMESTAMP_HEADER]: timestamp,
      [SNAPSHOT_NONCE_HEADER]: nonce,
      [SNAPSHOT_SIGNATURE_HEADER]: signature,
    }),
  };
}

describe("snapshot diagnostic session", () => {
  it("accepts an exact preview signature and binds the cookie to target", () => {
    const request = signedAuthorization();
    expect(authorizeSnapshotSession(request, target, {
      environment: "preview",
      secret,
      nowSeconds,
    })).toEqual(authorization);

    const { session, token } = mintSnapshotSession(target, authorization, {
      environment: "preview",
      secret,
      nowSeconds,
    });
    const replay = mintSnapshotSession(target, authorization, {
      environment: "preview",
      secret,
      nowSeconds,
    });
    expect(replay.session.captureId).toBe(session.captureId);
    expect(replay.token).toBe(token);
    const cookie = snapshotSessionCookie(token);
    expect(cookie).toContain(`${SNAPSHOT_SESSION_COOKIE}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/api/search");
    expect(Buffer.from(token.split(".")[0], "base64url").toString("utf8"))
      .not.toContain(target.query);

    const read = readSnapshotSession({
      method: "GET",
      url: "https://preview.example/api/search?q=a%20private%20spiritual%20question&only_his=1",
      headers: new Headers({ cookie }),
    }, target, { environment: "preview", secret, nowSeconds: nowSeconds + 1 });
    expect(read).toMatchObject(session);
  });

  it("does nothing without a cookie and rejects production, tampering, or a changed target", () => {
    expect(readSnapshotSession({ method: "GET", url, headers: new Headers() }, target, {
      environment: "production",
      secret: "",
      nowSeconds,
    })).toBeNull();
    expect(() => authorizeSnapshotSession(signedAuthorization(), target, {
      environment: "production",
      secret,
      nowSeconds,
    })).toThrow(SnapshotAuthorizationRejectedError);

    const { token } = mintSnapshotSession(target, authorization, { environment: "preview", secret, nowSeconds });
    const request = {
      method: "GET",
      url,
      headers: new Headers({ cookie: snapshotSessionCookie(token) }),
    };
    expect(() => readSnapshotSession(request, { ...target, query: "different question" }, {
      environment: "preview",
      secret,
      nowSeconds,
    })).toThrow(SnapshotAuthorizationRejectedError);
    expect(() => readSnapshotSession(request, target, {
      environment: "preview",
      secret,
      nowSeconds: nowSeconds + 301,
    })).toThrow(SnapshotAuthorizationRejectedError);
  });
});

function telemetry(questionHash: string): SearchTelemetry {
  return {
    requestId: "11111111-1111-4111-8111-111111111111",
    plannedIntent: "practical_how",
    questionHash,
    pipelineVersion: "v2",
    corpusVersion: "corpus-v1",
    subqueryCount: 0,
    planSource: "fallback_original_only",
    planFailureKind: "timeout",
    planUsage: {
      attempts: 1,
      promptTokens: 0,
      outputTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      durationMs: 3000,
    },
    tableRpcCount: 5,
    tableRpcAttemptCount: 5,
    vocabularyRpcCount: 0,
    refetchCount: 1,
    embeddingProviderCalls: 1,
    candidatesBeforeFusion: 1,
    candidatesAfterFusion: 1,
    duplicatesCollapsed: 0,
    junkFloorDropped: 0,
    prefilterPassed: 1,
    prefilterSetAside: 0,
    rerankDocumentCount: 1,
    reranked: true,
    selectedPassageCount: 1,
    mainTierCount: 1,
    additionalCount: 0,
    cutIndex: 1,
    cutGap: 0,
    pinnedExactReference: false,
    droppedOnRefetch: 0,
    speakerFilter: {
      mode: "prabhupada_segments",
      rawTranscriptRows: 1,
      retainedTranscriptRows: 1,
      droppedTranscriptRows: 0,
      keptSegments: 1,
      guestSegmentsRemoved: 0,
      unknownSegmentsRemoved: 0,
      additionalTranscriptRowsVerified: 0,
      additionalTranscriptRowsDropped: 0,
    },
    degraded: false,
    degradedStages: [],
    sourceRetrieval: [],
    degradedSources: [],
    stageDurationsMs: { retrieving: 10 },
    totalDurationMs: 20,
    models: { queryPlanner: null, reranker: "rerank", articlePlanner: null },
    errorCategory: null,
  };
}

const diagnostics: PipelineDiagnostics = {
  queryPlan: {
    plan: {
      schema_version: "query-plan-v1",
      intent: "practical_how",
      canonical_query: "a private spiritual question",
      preserve_terms: [],
      lexical_phrases: [],
      vocabulary_candidates: [],
      subqueries: [],
      constraints: {
        scripture_references: [],
        source_types: [],
        recipient: null,
        speaker: null,
        location: null,
        date_from: null,
        date_to: null,
      },
      exact_reference: null,
      possible_false_assumption: false,
    },
    source: "fallback_original_only",
    rejections: ["planner deadline"],
    failureKind: "timeout",
    usage: {
      attempts: 1,
      promptTokens: 0,
      outputTokens: 0,
      thoughtsTokens: 0,
      totalTokens: 0,
      durationMs: 3000,
    },
  },
  retrieval: { sources: [], candidates: [] },
  junkFloor: { droppedPassageKeys: [] },
  fusion: { candidates: [] },
  deduplication: {
    stats: { input: 0, exactCollapsed: 0, containedCollapsed: 0, output: 0 },
    decisions: [],
    candidates: [],
  },
  prefilter: { stats: {}, passedPassageKeys: [], setAsidePassageKeys: [] },
  rerank: {
    model: "rerank",
    reranked: true,
    degradedReason: null,
    documentCount: 0,
    candidates: [],
  },
  tiering: {
    cutIndex: 0,
    cutGap: 0,
    uncoveredQueryIds: [],
    evidenceInsufficient: false,
    selected: [],
    additionalPassageKeys: [],
  },
  verification: { verifiedPassageKeys: [], mainDrops: [], additionalTranscriptDrops: [] },
  articlePlan: { plan: null, source: "deterministic_fallback", rejections: [] },
};

function snapshotInput() {
  const { session } = mintSnapshotSession(target, authorization, { environment: "preview", secret, nowSeconds });
  const response = { requestId: "11111111-1111-4111-8111-111111111111", query: target.query };
  return {
    session,
    searchLogId: "22222222-2222-4222-8222-222222222222",
    requestId: "11111111-1111-4111-8111-111111111111",
    question: target.query,
    telemetry: telemetry(session.questionHash),
    diagnostics,
    internalResponse: response,
    guardedResponse: response,
    guardedResponseJson: JSON.stringify(response),
    capturedAt: new Date("2026-08-03T12:00:00.000Z"),
    environment: "preview",
    deploymentSha: "a".repeat(40),
  };
}

describe("private snapshot artifact", () => {
  it("hashes exact compressed bytes and reproduces the delivered guarded JSON", () => {
    const artifact = buildSearchSnapshotArtifact(snapshotInput());
    expect(createHash("sha256").update(artifact.compressed).digest("hex"))
      .toBe(artifact.objectSha256);
    expect(artifact.objectBytes).toBe(artifact.compressed.byteLength);
    expect(JSON.stringify(artifact.metadata)).not.toContain(target.query);
    expect(artifact.objectPath).toMatch(/^v1\/2026\/08\/03\/[0-9a-f-]{36}\.json\.gz$/);

    const envelope = JSON.parse(gunzipSync(artifact.compressed).toString("utf8"));
    const payloadJson = JSON.stringify(envelope.payload);
    expect(envelope.payload.question).toBe(target.query);
    expect(envelope.payload.responses.guardedJson).toBe(JSON.stringify(envelope.payload.responses.guarded));
    expect(envelope.payloadIntegrity.bytes).toBe(Buffer.byteLength(payloadJson, "utf8"));
    expect(envelope.payloadIntegrity.sha256)
      .toBe(createHash("sha256").update(payloadJson).digest("hex"));
  });

  it("uploads once, inserts metadata, and removes the object if metadata fails", async () => {
    const success: SnapshotPersistence = {
      upload: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    };
    await expect(persistSearchSnapshot(snapshotInput(), success)).resolves.toBeTruthy();
    expect(success.upload).toHaveBeenCalledOnce();
    expect(success.insert).toHaveBeenCalledOnce();
    expect(success.remove).not.toHaveBeenCalled();

    const failure: SnapshotPersistence = {
      upload: vi.fn(async () => undefined),
      insert: vi.fn(async () => { throw new Error("metadata down"); }),
      remove: vi.fn(async () => undefined),
    };
    await expect(persistSearchSnapshot(snapshotInput(), failure)).rejects.toThrow("metadata down");
    expect(failure.remove).toHaveBeenCalledOnce();
  });

  it("returns the exact guarded response when optional persistence fails", async () => {
    const input = snapshotInput();
    const writer = vi.fn(async () => { throw new Error("storage unavailable"); });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await prepareSuccessfulResponse({
      result: input.internalResponse,
      fromCache: false,
      diagnostics: input.diagnostics,
      telemetry: input.telemetry,
      searchLogId: input.searchLogId,
    }, input.question, input.requestId, input.session, writer);

    expect(result.guarded).toEqual(input.internalResponse);
    expect(result.guardedJson).toBe(JSON.stringify(input.internalResponse));
    expect(writer).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("search.snapshot_failed"));
    errorSpy.mockRestore();
  });
  it("removes corpus ids at the final JSON/SSE boundary but keeps the private snapshot trace", async () => {
    const input = snapshotInput();
    const internalResponse = {
      ...input.internalResponse,
      articleVerseIds: ["verse-row-1"],
      passages: [{ id: "verse:verse-row-1", reference: "BG 18.66", text: "exact words" }],
      additional: [{ id: "lecture:talk-row-1", reference: "Lecture", snippet: "exact words" }],
    };
    const writer = vi.fn(async (
      _snapshot: Parameters<typeof persistSearchSnapshot>[0],
    ) => ({ objectBytes: 1, objectSha256: "abc" }) as never);
    const result = await prepareSuccessfulResponse({
      result: internalResponse,
      fromCache: false,
      diagnostics: input.diagnostics,
      telemetry: input.telemetry,
      searchLogId: input.searchLogId,
    }, input.question, input.requestId, input.session, writer);

    expect(result.guarded).not.toHaveProperty("articleVerseIds");
    expect(result.guarded.passages).toEqual([{ reference: "BG 18.66", text: "exact words" }]);
    expect(result.guarded.additional).toEqual([{ reference: "Lecture", snippet: "exact words" }]);
    expect(result.guardedJson).not.toContain("verse-row-1");
    expect(result.guardedJson).not.toContain("talk-row-1");
    expect(writer.mock.calls[0][0].internalResponse).toEqual(internalResponse);
    expect(writer.mock.calls[0][0].guardedResponse).toEqual(result.guarded);
  });

});
