import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  advanceSearchStage,
  parseSearchStageEvent,
  SEARCH_STAGE_ORDER,
  SEARCH_STAGE_PERCENT,
} from "@/app/lib/25-search-stage-events";

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

vi.mock("@/app/lib/search-v2/search-run-telemetry", () => ({
  allowlistedTechnicalTelemetry: vi.fn(() => ({})),
  CACHE_STATUS: "disabled",
  beginSearchRun: vi.fn(async () => ({ rowId: `search-log-${++harness.searchLogCounter}` })),
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

interface SseFrame {
  event: string;
  data: unknown;
}

function parseSseFrames(body: string): SseFrame[] {
  return body.split("\n\n").flatMap((frame) => {
    const lines = frame.split("\n");
    const event = lines.find((line) => line.startsWith("event: "))?.slice(7);
    const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
    if (!event || data === undefined) return [];
    return [{ event, data: JSON.parse(data) as unknown }];
  });
}

function stageFrames(frames: SseFrame[]): Array<Record<string, unknown>> {
  return frames
    .filter((frame) => frame.event === "stage")
    .map((frame) => frame.data as Record<string, unknown>);
}

function firstStageAppearances(stages: Array<Record<string, unknown>>): string[] {
  const seen = new Set<string>();
  return stages.flatMap((stage) => {
    const key = String(stage.stage);
    if (seen.has(key)) return [];
    seen.add(key);
    return [key];
  });
}

function cleanPipelineOutput() {
  return {
    passages: [],
    additional: [],
    article: { title: "Evidence" },
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

beforeEach(() => {
  harness.responseCache.clear();
  harness.runSearchV2.mockReset();
  harness.adaptToSearchResults.mockReset();
  harness.cacheGet.mockClear();
  harness.cacheSet.mockClear();
  harness.completeSearchRun.mockClear();
  harness.searchLogCounter = 0;

  harness.runSearchV2.mockImplementation(async (input: {
    onStage?: (stage: string, info?: { found?: number; kept?: number }) => void;
  }) => {
    input.onStage?.("planning");
    input.onStage?.("retrieving");
    input.onStage?.("fusing", { found: 24 });
    input.onStage?.("reranking", { found: 12 });
    input.onStage?.("selecting", { found: 12 });
    input.onStage?.("verifying", { kept: 7 });
    input.onStage?.("organizing", { kept: 6 });
    input.onStage?.("complete");
    return cleanPipelineOutput();
  });
  harness.adaptToSearchResults.mockImplementation((query: string) => ({
    query,
    passages: [],
    additional: [],
    additionalCount: 0,
    totalResults: 0,
    citations: [],
    validated: true,
    degraded: false,
  }));
});

describe("search stage event model", () => {
  it("defines the real five-stage order and treats completion as result-only", () => {
    expect(SEARCH_STAGE_ORDER).toEqual([
      "understood",
      "searching",
      "reranking",
      "verifying",
      "weaving",
    ]);
    expect(SEARCH_STAGE_ORDER.map((stage) => SEARCH_STAGE_PERCENT[stage])).toEqual([
      12,
      45,
      70,
      84,
      90,
    ]);
    expect(parseSearchStageEvent({
      stage: "verifying",
      pct: 100,
      label: "Verifying",
      found: 6.4,
    })).toEqual({ stage: "verifying", pct: 99, label: "Verifying", found: 6 });
    expect(parseSearchStageEvent({
      stage: "expanding",
      pct: 22,
      label: "Legacy fabricated stage",
    })).toBeNull();
  });

  it("accepts live updates without allowing stage or percentage regression", () => {
    const current = { stage: "verifying", pct: 84, label: "Verifying" } as const;
    expect(advanceSearchStage(current, {
      stage: "reranking",
      pct: 70,
      label: "Old replay",
    })).toBe(current);
    expect(advanceSearchStage(current, {
      stage: "verifying",
      pct: 80,
      label: "Verified 6 passages",
      found: 6,
    })).toEqual({
      stage: "verifying",
      pct: 84,
      label: "Verified 6 passages",
      found: 6,
    });
  });
});

describe("search progress SSE", () => {
  it("emits a genuine verifying stage before weaving on a cold search", async () => {
    const response = await GET(new NextRequest(
      "https://example.test/api/search?q=truthful%20progress&stream=1",
    ));
    const frames = parseSseFrames(await response.text());
    const stages = stageFrames(frames);

    expect(firstStageAppearances(stages)).toEqual([...SEARCH_STAGE_ORDER]);
    expect(stages.some((stage) => stage.stage === "expanding")).toBe(false);
    expect(stages.find((stage) => stage.stage === "verifying")).toMatchObject({
      pct: 84,
      found: 7,
    });
    expect(stages.map((stage) => Number(stage.pct))).toEqual(
      [...stages.map((stage) => Number(stage.pct))].sort((a, b) => a - b),
    );
    expect(stages.every((stage) => Number(stage.pct) < 100)).toBe(true);
    expect(frames.map((frame) => frame.event).slice(-2)).toEqual(["result", "done"]);
  });

});
