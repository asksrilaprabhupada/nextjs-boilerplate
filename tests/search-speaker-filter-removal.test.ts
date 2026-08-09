import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const responseCache = new Map<string, unknown>();
  return {
    responseCache,
    runSearchV2: vi.fn(),
    adaptToSearchResults: vi.fn(),
    cacheGet: vi.fn(async (key: string) => responseCache.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: unknown) => {
      responseCache.set(key, value);
    }),
    completeSearchRun: vi.fn(async () => undefined),
    searchLogCounter: 0,
  };
});

vi.mock("@/app/lib/01-supabase", () => ({
  getSupabaseAdmin: vi.fn(() => ({})),
}));

vi.mock("@/app/lib/search-v2/pipeline", () => ({
  runSearchV2: harness.runSearchV2,
}));

vi.mock("@/app/lib/search-v2/adapt", () => ({
  adaptToSearchResults: harness.adaptToSearchResults,
}));

vi.mock("@/app/lib/search-v2/cache", () => ({
  cacheKeys: {
    response: (question: string) =>
      `response:test:${question.trim().toLocaleLowerCase("en").replace(/\s+/g, " ")}`,
  },
  getCacheAdapter: vi.fn(async () => ({
    get: harness.cacheGet,
    set: harness.cacheSet,
  })),
  TTL: { response: 86_400_000 },
}));

vi.mock("@/app/lib/search-v2/search-run-telemetry", () => ({
  allowlistedTechnicalTelemetry: vi.fn(() => ({})),
  beginSearchRun: vi.fn(async () => ({ rowId: `search-log-${++harness.searchLogCounter}` })),
  cacheHitTechnicalTelemetry: vi.fn(() => ({})),
  completeSearchRun: harness.completeSearchRun,
  EMPTY_RESULT_FIELDS: {},
  failureTechnicalTelemetry: vi.fn(() => ({
    failedStage: "unknown",
    errorCode: "unknown",
    sourceDurationsMs: {},
    telemetry: {},
  })),
  resultFieldsForTelemetry: vi.fn(() => ({})),
  sourceDurationsForTelemetry: vi.fn(() => ({})),
  telemetryQuestionHash: vi.fn((question: string) => `hash:${question}`),
}));

vi.mock("@/app/lib/search-v2/preview-verification", () => ({
  markPreviewVerification: vi.fn((telemetry: unknown) => telemetry),
  previewVerificationClient: vi.fn((db: unknown) => db),
  readPreviewVerificationMode: vi.fn(() => null),
}));

vi.mock("@/app/lib/search-v2/diagnostic-session", () => ({
  clearSnapshotSessionCookie: vi.fn(() => "search_snapshot=; Max-Age=0"),
  readSnapshotSession: vi.fn(() => null),
}));

vi.mock("@/app/lib/search-v2/search-snapshot", () => ({
  persistSearchSnapshot: vi.fn(),
}));

import { GET } from "@/app/api/search/route";

const TRANSCRIPT_EVIDENCE = [
  {
    type: "lecture",
    reference: "Conversation · Mixed speakers",
    text: "Śrīla Prabhupāda: The answer remains.\nDevotee: Jaya, Śrīla Prabhupāda.",
    speaker: "Śrīla Prabhupāda · Devotee",
    speakerUnidentified: false,
  },
  {
    type: "lecture",
    reference: "Conversation · Guest",
    text: "Guest: May I ask a careful question?",
    speaker: "Guest",
    speakerUnidentified: false,
  },
  {
    type: "lecture",
    reference: "Conversation · Continuation",
    text: "This continuation has no explicit speaker label.",
    speaker: null,
    speakerUnidentified: true,
  },
] as const;

const PUBLIC_EVIDENCE = {
  passages: TRANSCRIPT_EVIDENCE,
  additional: [],
  additionalCount: 0,
  totalResults: TRANSCRIPT_EVIDENCE.length,
  citations: TRANSCRIPT_EVIDENCE.map((passage) => ({
    ref: passage.reference,
    book: "lecture",
    url: "",
    type: "transcript",
    title: passage.reference,
  })),
  intro: "Complete transcript evidence",
  validated: true,
  degraded: false,
  retrievalStatus: "complete",
};

function pipelineOutput() {
  return {
    passages: [...TRANSCRIPT_EVIDENCE],
    additional: [],
    article: { title: PUBLIC_EVIDENCE.intro },
    evidenceInsufficient: false,
    telemetry: {
      degraded: false,
      degradedSources: [],
      sourceRetrieval: [],
      stageDurationsMs: {},
      totalDurationMs: 1,
      droppedOnRefetch: 0,
    },
  };
}

function withoutPerRequestIds(body: Record<string, unknown>): Record<string, unknown> {
  const { requestId: _requestId, searchLogId: _searchLogId, ...evidence } = body;
  void _requestId;
  void _searchLogId;
  return evidence;
}

function assertCompleteTranscriptEvidence(body: Record<string, unknown>): void {
  expect(body.passages).toEqual(TRANSCRIPT_EVIDENCE);
  expect(body.passages).toEqual(expect.arrayContaining([
    expect.objectContaining({
      text: expect.stringContaining("Śrīla Prabhupāda: The answer remains."),
      speaker: "Śrīla Prabhupāda · Devotee",
    }),
    expect.objectContaining({
      text: "Guest: May I ask a careful question?",
      speaker: "Guest",
    }),
    expect.objectContaining({
      text: "This continuation has no explicit speaker label.",
      speaker: null,
      speakerUnidentified: true,
    }),
  ]));
}

function assertPipelineHasNoSpeakerPolicyInput(): void {
  expect(harness.runSearchV2).toHaveBeenCalledTimes(1);
  const input = harness.runSearchV2.mock.calls[0]?.[0] as Record<string, unknown>;
  expect(input).not.toHaveProperty("speakerOnly");
}

async function jsonSearch(url: string): Promise<Record<string, unknown>> {
  const response = await GET(new NextRequest(url));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json() as Promise<Record<string, unknown>>;
}

async function sseResult(url: string): Promise<Record<string, unknown>> {
  const response = await GET(new NextRequest(url));
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  const frames = (await response.text()).split("\n\n");
  const resultFrame = frames.find((frame) => frame.startsWith("event: result\n"));
  expect(resultFrame).toBeDefined();
  const dataLine = resultFrame?.split("\n").find((line) => line.startsWith("data: "));
  expect(dataLine).toBeDefined();
  return JSON.parse(dataLine!.slice("data: ".length)) as Record<string, unknown>;
}

beforeEach(() => {
  harness.responseCache.clear();
  harness.runSearchV2.mockReset();
  harness.adaptToSearchResults.mockReset();
  harness.cacheGet.mockClear();
  harness.cacheSet.mockClear();
  harness.completeSearchRun.mockClear();
  harness.searchLogCounter = 0;

  harness.runSearchV2.mockResolvedValue(pipelineOutput());
  harness.adaptToSearchResults.mockImplementation((query: string) => ({
    query,
    ...PUBLIC_EVIDENCE,
  }));
});

describe("speaker-filter removal route contract", () => {
  it("serves a legacy URL from the ordinary JSON cache without changing evidence", async () => {
    const question = "speaker filter removal ordinary first";
    const ordinary = await jsonSearch(`https://example.test/api/search?q=${encodeURIComponent(question)}`);
    const legacy = await jsonSearch(
      `https://example.test/api/search?q=${encodeURIComponent(question)}&only_his=1`,
    );

    assertPipelineHasNoSpeakerPolicyInput();
    expect(harness.cacheSet).toHaveBeenCalledTimes(1);
    expect(withoutPerRequestIds(legacy)).toEqual(withoutPerRequestIds(ordinary));
    assertCompleteTranscriptEvidence(legacy);
  });

  it("uses the same cache entry when the legacy URL arrives before the ordinary URL", async () => {
    const question = "speaker filter removal legacy first fresh question";
    const legacy = await jsonSearch(
      `https://example.test/api/search?only_his=1&q=${encodeURIComponent(question)}`,
    );
    const ordinary = await jsonSearch(`https://example.test/api/search?q=${encodeURIComponent(question)}`);

    assertPipelineHasNoSpeakerPolicyInput();
    expect(harness.cacheSet).toHaveBeenCalledTimes(1);
    expect(withoutPerRequestIds(ordinary)).toEqual(withoutPerRequestIds(legacy));
    assertCompleteTranscriptEvidence(ordinary);
  });

  it("returns the same evidence through a legacy SSE request and ordinary JSON", async () => {
    const question = "speaker filter removal stream parity";
    const legacyStream = await sseResult(
      `https://example.test/api/search?q=${encodeURIComponent(question)}&stream=1&only_his=1`,
    );
    const ordinary = await jsonSearch(`https://example.test/api/search?q=${encodeURIComponent(question)}`);

    assertPipelineHasNoSpeakerPolicyInput();
    expect(withoutPerRequestIds(legacyStream)).toEqual(withoutPerRequestIds(ordinary));
    assertCompleteTranscriptEvidence(legacyStream);
  });
});

function runtimeSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return runtimeSourceFiles(path);
    return /\.(?:c|m)?(?:j|t)sx?$/.test(entry.name) ? [path] : [];
  });
}

describe("speaker-filter removal source contract", () => {
  it("leaves no speaker-filter activation token in application or snapshot runtime code", () => {
    const root = process.cwd();
    const files = [
      ...runtimeSourceFiles(resolve(root, "app")),
      resolve(root, "scripts", "verify-search-snapshot.mjs"),
    ];
    const forbidden = [
      "only_his",
      "onlyHis",
      "speakerOnly",
      "speaker_only",
      "prabhupada_segments",
      "projectPrabhupadaSegments",
    ];
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return forbidden
        .filter((token) => source.includes(token))
        .map((token) => `${file}: ${token}`);
    });

    expect(violations).toEqual([]);
  });
});
