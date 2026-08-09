import { describe, expect, it } from "vitest";
import { COHERE_RERANK_MODEL } from "@/app/lib/08-cohere-rerank";
import {
  RERANK_ARMS,
  RERANK_COMPARISON_TOP_N,
} from "@/app/lib/search-v2/rerank";
import {
  assertA2CompleteRowEvidence,
  assertA2CompleteRowSettlementEvidence,
  type A2CompleteRowSettlementEvidence,
} from "@/tests/a2-row-evidence";
import {
  bindA2CheckpointRowAccounting,
  reserveA2Row,
  type A2CheckpointAccounting,
  type A2GeminiCallProof,
  type A2KnownRowUsage,
} from "@/tests/a2-spend-budget";

const ATTEMPT_KEY = "q001:1@1";
const QUESTION = "approved question";

interface CompleteFixtureOptions {
  rowVoyageProviderCalls?: unknown;
  proofVoyageProviderCalls?: 0 | 1;
  proofPromptTokens?: number;
  proofCohereSearchUnits?: number;
}

interface CompleteFixture {
  row: Record<string, unknown>;
  settlement: A2CompleteRowSettlementEvidence;
}

function completeFixture(options: CompleteFixtureOptions = {}): CompleteFixture {
  const proofVoyageProviderCalls = options.proofVoyageProviderCalls ?? 1;
  const rowVoyageProviderCalls = Object.hasOwn(options, "rowVoyageProviderCalls")
    ? options.rowVoyageProviderCalls
    : proofVoyageProviderCalls;
  const plannerCall: A2GeminiCallProof = {
    attempt: 1,
    responseReceived: true,
    promptTokens: 100,
    candidateTokens: 50,
    thoughtsTokens: null,
    toolUsePromptTokens: null,
    totalTokens: 150,
  };
  const top = [{ passageId: "p1" }, { passageId: "p2" }];
  const currentRequest = {
    documentCount: 2,
    topN: 2,
    responseSucceeded: true,
    billedSearchUnits: 3,
  };
  const globalRequest = {
    documentCount: 2,
    topN: 2,
    responseSucceeded: true,
    billedSearchUnits: 5,
  };
  const row: Record<string, unknown> = {
    status: "complete",
    attemptKey: ATTEMPT_KEY,
    question: QUESTION,
    poolSha256: "d".repeat(64),
    candidateCount: 2,
    armExecutionOrder: [RERANK_ARMS.current, RERANK_ARMS.global],
    searchToTop20Ms: { current: 1, global: 1 },
    sharedPreparationMs: 1,
    comparisonPipelineTotalMs: 2,
    arms: {
      current: {
        arm: RERANK_ARMS.current,
        topN: RERANK_COMPARISON_TOP_N,
        top,
        reranked: true,
        degradedReason: null,
        documentCount: 2,
        providerCallCount: 1,
        providerRequests: [currentRequest],
        model: COHERE_RERANK_MODEL,
        durationMs: 1,
      },
      global: {
        arm: RERANK_ARMS.global,
        topN: RERANK_COMPARISON_TOP_N,
        top,
        reranked: true,
        degradedReason: null,
        documentCount: 2,
        providerCallCount: 1,
        providerRequests: [globalRequest],
        model: COHERE_RERANK_MODEL,
        durationMs: 1,
      },
    },
    pipelineDegraded: false,
    invalidArm: false,
    providerUsageComplete: true,
    plannerUsage: {
      attempts: 1,
      promptTokens: 100,
      outputTokens: 50,
      thoughtsTokens: 0,
      totalTokens: 150,
      durationMs: 1,
      attemptDurationsMs: [1],
    },
    plannerCallUsage: [plannerCall],
    embeddingProviderCalls: rowVoyageProviderCalls,
  };
  const cohereSearchUnits = options.proofCohereSearchUnits ?? 8;
  const proofPromptTokens = options.proofPromptTokens ?? 100;
  const proofCall = {
    ...plannerCall,
    promptTokens: proofPromptTokens,
    totalTokens: proofPromptTokens + 50,
  };
  const usage: A2KnownRowUsage = {
    cohereSearchUnits,
    cohereSearchUnitsLowerBound: cohereSearchUnits,
    cohereUsageComplete: true,
    geminiAttempts: 1,
    geminiPromptTokens: proofPromptTokens,
    geminiOutputTokens: 50,
    geminiThoughtsTokens: 0,
    geminiTotalTokens: proofPromptTokens + 50,
    geminiAttemptDurationsMs: [1],
    geminiCalls: [proofCall],
    voyageProviderCalls: proofVoyageProviderCalls,
  };
  const reservation = reserveA2Row(QUESTION, 2.50);
  const bound = bindA2CheckpointRowAccounting(row, reservation, usage);
  if (bound.decision.kind !== "usage_proved") {
    throw new Error("fixture must have exact provider usage");
  }
  const accounting = bound.row.accounting as A2CheckpointAccounting;
  return {
    row: bound.row,
    settlement: {
      rowKey: ATTEMPT_KEY,
      reservation: { ...reservation },
      chargedMicrousd: bound.decision.charge.totalMicrousd,
      cohereMicrousd: bound.decision.charge.cohereMicrousd,
      geminiMicrousd: bound.decision.charge.geminiMicrousd,
      voyageMicrousd: bound.decision.charge.voyageMicrousd,
      completeUsage: bound.decision.charge.completeUsage,
      settlementKind: bound.decision.charge.settlementKind,
      proofSha256: accounting.proofSha256,
      checkpointRowSha256: accounting.checkpointRowSha256,
    },
  };
}

function cloneSettlement(
  settlement: A2CompleteRowSettlementEvidence,
): A2CompleteRowSettlementEvidence {
  return {
    ...settlement,
    reservation: { ...settlement.reservation },
  };
}

describe("A2 complete-row evidence", () => {
  it.each([0, 1] as const)(
    "accepts exactly %i Voyage provider calls when every binding agrees",
    (voyageProviderCalls) => {
      const fixture = completeFixture({
        rowVoyageProviderCalls: voyageProviderCalls,
        proofVoyageProviderCalls: voyageProviderCalls,
      });
      expect(() => assertA2CompleteRowEvidence(fixture.row, ATTEMPT_KEY)).not.toThrow();
      expect(() => assertA2CompleteRowSettlementEvidence(
        fixture.row,
        ATTEMPT_KEY,
        fixture.settlement,
      )).not.toThrow();
      expect(fixture.settlement.voyageMicrousd).toBe(
        voyageProviderCalls === 0 ? 0 : fixture.settlement.reservation.voyageMicrousd,
      );
    },
  );

  it.each([
    ["missing", undefined],
    ["null", null],
    ["negative", -1],
    ["fractional", 0.5],
    ["too many", 2],
    ["NaN", Number.NaN],
    ["infinite", Number.POSITIVE_INFINITY],
    ["string", "1"],
  ])("rejects a %s Voyage provider-call count", (_label, rowVoyageProviderCalls) => {
    const fixture = completeFixture({ rowVoyageProviderCalls });
    expect(() => assertA2CompleteRowEvidence(fixture.row, ATTEMPT_KEY))
      .toThrow(/Voyage provider-call count/u);
  });

  it("rejects an otherwise-valid row whose Voyage count differs from its proof", () => {
    const fixture = completeFixture({
      rowVoyageProviderCalls: 1,
      proofVoyageProviderCalls: 0,
    });
    expect(() => assertA2CompleteRowEvidence(fixture.row, ATTEMPT_KEY))
      .toThrow(/row and accounting proof differ/u);
  });

  it("rejects planner and Cohere row-proof mismatches", () => {
    const plannerMismatch = completeFixture({ proofPromptTokens: 101 });
    expect(() => assertA2CompleteRowEvidence(plannerMismatch.row, ATTEMPT_KEY))
      .toThrow(/row and accounting proof differ/u);

    const cohereMismatch = completeFixture({ proofCohereSearchUnits: 9 });
    expect(() => assertA2CompleteRowEvidence(cohereMismatch.row, ATTEMPT_KEY))
      .toThrow(/row and accounting proof differ/u);
  });

  it("rejects every full-reservation snapshot mismatch", () => {
    const fixture = completeFixture();
    const fields = [
      "totalMicrousd",
      "cohereMicrousd",
      "geminiMicrousd",
      "voyageMicrousd",
      "cohereSearchUnitsCeiling",
      "cohereUsdPerThousandSearchUnits",
      "questionUtf8Bytes",
    ] as const;
    for (const field of fields) {
      const settlement = cloneSettlement(fixture.settlement);
      settlement.reservation[field] += 1;
      expect(() => assertA2CompleteRowSettlementEvidence(
        fixture.row,
        ATTEMPT_KEY,
        settlement,
      ), field).toThrow(/ledger reservations differ/u);
    }
  });

  it("rejects every settlement charge mismatch", () => {
    const fixture = completeFixture();
    for (const field of [
      "chargedMicrousd",
      "cohereMicrousd",
      "geminiMicrousd",
      "voyageMicrousd",
    ] as const) {
      const settlement = cloneSettlement(fixture.settlement);
      settlement[field] += 1;
      expect(() => assertA2CompleteRowSettlementEvidence(
        fixture.row,
        ATTEMPT_KEY,
        settlement,
      ), field).toThrow(/ledger charges differ/u);
    }

    const incomplete = cloneSettlement(fixture.settlement);
    incomplete.completeUsage = false;
    expect(() => assertA2CompleteRowSettlementEvidence(
      fixture.row,
      ATTEMPT_KEY,
      incomplete,
    )).toThrow(/ledger charges differ/u);

    const wrongKind = cloneSettlement(fixture.settlement);
    wrongKind.settlementKind = "entire_row_reservation";
    expect(() => assertA2CompleteRowSettlementEvidence(
      fixture.row,
      ATTEMPT_KEY,
      wrongKind,
    )).toThrow(/ledger charges differ/u);
  });

  it("rejects settlement identity, proof-digest, and checkpoint-digest mismatches", () => {
    const fixture = completeFixture();

    const wrongIdentity = cloneSettlement(fixture.settlement);
    wrongIdentity.rowKey = "q001:1@2";
    expect(() => assertA2CompleteRowSettlementEvidence(
      fixture.row,
      ATTEMPT_KEY,
      wrongIdentity,
    )).toThrow(/settlement identities differ/u);

    for (const field of ["proofSha256", "checkpointRowSha256"] as const) {
      const settlement = cloneSettlement(fixture.settlement);
      settlement[field] = "f".repeat(64);
      expect(() => assertA2CompleteRowSettlementEvidence(
        fixture.row,
        ATTEMPT_KEY,
        settlement,
      ), field).toThrow(/ledger accounting digests differ/u);
    }
  });

  it("rejects a changed checkpoint row even when its old accounting object remains", () => {
    const fixture = completeFixture();
    fixture.row.sharedPreparationMs = 2;
    expect(() => assertA2CompleteRowEvidence(fixture.row, ATTEMPT_KEY))
      .toThrow(/accounting digest differs/u);
  });
});
