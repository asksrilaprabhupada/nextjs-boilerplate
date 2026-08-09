import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyA2RowAccounting,
  reserveA2Row,
} from "@/tests/a2-spend-budget";
import {
  A2_CONTINUATION_MAX_MICROUSD,
  A2_LIFETIME_MAX_MICROUSD,
  A2_PRIOR_COMMITTED_MICROUSD,
  assertA2ContinuationLedgerAttemptKeys,
  assertA2EvidenceAuditEnvironment,
  canonicalA2Json,
  carryClassificationFacts,
  classifyA2SourceRow,
  deriveA2FrozenCarryCounts,
  hashA2StableEvidenceTree,
  sha256A2Canonical,
  type A2CarryClassificationFacts,
} from "@/tests/a2-quality-carry";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const strictFacts = (): A2CarryClassificationFacts => ({
  status: "complete",
  kind: null,
  pipelineDegraded: false,
  invalidArm: false,
  providerUsageComplete: true,
  plannerAttempts: 1,
  plannerDurationCount: 1,
  embeddingProviderCalls: 1,
  armsHealthy: true,
  settlementCompleteUsage: true,
  settlementIsFullReservation: false,
});

describe("A2 frozen quality carry", () => {
  it("uses canonical object-key ordering for private evidence digests", () => {
    const left = { z: [3, { b: 2, a: 1 }], a: true };
    const right = { a: true, z: [3, { a: 1, b: 2 }] };
    expect(canonicalA2Json(left)).toBe(canonicalA2Json(right));
    expect(sha256A2Canonical(left)).toBe(sha256A2Canonical(right));
  });

  it("excludes only transient run locks from the stable evidence tree", () => {
    const directory = temporaryDirectory("a2-tree-");
    mkdirSync(join(directory, "pools"));
    writeFileSync(join(directory, "report.json"), "one", "utf8");
    writeFileSync(join(directory, "pools", "row.json"), "two", "utf8");
    writeFileSync(join(directory, "spend-ledger.jsonl"), "three", "utf8");
    const baseline = hashA2StableEvidenceTree(directory);

    writeFileSync(join(directory, "paid-run.lock"), "transient", "utf8");
    writeFileSync(join(directory, "paid-run.lock.recovered-deadbeef"), "archive", "utf8");
    expect(hashA2StableEvidenceTree(directory)).toEqual(baseline);

    writeFileSync(join(directory, "pools", "paid-run.lock"), "stable nested evidence", "utf8");
    expect(hashA2StableEvidenceTree(directory).sha256).not.toBe(baseline.sha256);
    unlinkSync(join(directory, "pools", "paid-run.lock"));
    writeFileSync(join(directory, "paid-run.lock.backup"), "not transient", "utf8");
    expect(hashA2StableEvidenceTree(directory).sha256).not.toBe(baseline.sha256);
    unlinkSync(join(directory, "paid-run.lock.backup"));
    writeFileSync(join(directory, "report.json"), "changed", "utf8");
    expect(hashA2StableEvidenceTree(directory).sha256).not.toBe(baseline.sha256);
    writeFileSync(join(directory, "report.json"), "one", "utf8");
    writeFileSync(join(directory, "pools", "row.json"), "changed pool/ranking", "utf8");
    expect(hashA2StableEvidenceTree(directory).sha256).not.toBe(baseline.sha256);
    writeFileSync(join(directory, "pools", "row.json"), "two", "utf8");
    writeFileSync(join(directory, "spend-ledger.jsonl"), "changed settlement", "utf8");
    expect(hashA2StableEvidenceTree(directory).sha256).not.toBe(baseline.sha256);
  });

  it("classifies only the frozen structural states", () => {
    expect(classifyA2SourceRow(strictFacts())).toBe("strict");
    expect(classifyA2SourceRow({
      ...strictFacts(),
      status: "invalid",
      kind: "provider_usage_incomplete",
      providerUsageComplete: false,
      plannerAttempts: 2,
      plannerDurationCount: 2,
      settlementCompleteUsage: false,
      settlementIsFullReservation: true,
    })).toBe("quality_only");
    expect(classifyA2SourceRow({
      ...strictFacts(),
      status: "invalid",
      kind: "pipeline_degraded",
      pipelineDegraded: true,
      providerUsageComplete: false,
      plannerAttempts: 2,
      plannerDurationCount: 2,
      settlementCompleteUsage: false,
      settlementIsFullReservation: true,
    })).toBe("source_degraded_retry");
    expect(() => classifyA2SourceRow({
      ...strictFacts(),
      status: "invalid",
      kind: "provider_usage_incomplete",
      providerUsageComplete: false,
      plannerAttempts: 2,
      plannerDurationCount: 2,
      settlementCompleteUsage: false,
      settlementIsFullReservation: false,
    })).toThrow(/no approved structural carry class/u);
  });

  it("accepts only the exact 43/5/1/215 frozen coverage partition", () => {
    const exact = [
      ...Array(43).fill("strict"),
      ...Array(5).fill("quality_only"),
      "source_degraded_retry",
      ...Array(215).fill("untouched"),
    ] as const;
    expect(deriveA2FrozenCarryCounts(exact)).toEqual({
      strict: 43,
      quality_only: 5,
      source_degraded_retry: 1,
      untouched: 215,
      carriedQualityRows: 48,
      pendingPaidRows: 216,
      totalLogicalRows: 264,
    });
    expect(() => deriveA2FrozenCarryCounts([...exact.slice(0, -1), "strict"]))
      .toThrow(/exactly 43\/5\/1\/215/u);
  });

  it("does not expose outcome values to the carry classifier", () => {
    const baseRow = {
      status: "invalid",
      kind: "provider_usage_incomplete",
      pipelineDegraded: false,
      invalidArm: false,
      providerUsageComplete: false,
      plannerUsage: { attempts: 2, attemptDurationsMs: [1, 2] },
      embeddingProviderCalls: 1,
      arms: {
        current: {
          reranked: true,
          degradedReason: null,
          providerRequests: [{ responseSucceeded: true }],
          top: [{ passageId: "winner-a", rerankScore: 1 }],
        },
        global: {
          reranked: true,
          degradedReason: null,
          providerRequests: [{ responseSucceeded: true }],
          top: [{ passageId: "winner-b", rerankScore: 0 }],
        },
      },
      scores: { current: { automaticPass: true }, global: { automaticPass: false } },
      changes: { top20Jaccard: 0, globalQualityRegression: true },
    };
    const oppositeOutcome = {
      ...baseRow,
      arms: {
        ...baseRow.arms,
        current: { ...baseRow.arms.current, top: [{ passageId: "winner-b", rerankScore: 0 }] },
        global: { ...baseRow.arms.global, top: [{ passageId: "winner-a", rerankScore: 1 }] },
      },
      scores: { current: { automaticPass: false }, global: { automaticPass: true } },
      changes: { top20Jaccard: 1, globalQualityRegression: false },
    };
    const settlement = {
      reservedMicrousd: 100,
      chargedMicrousd: 100,
      completeUsage: false,
    };
    const first = carryClassificationFacts(baseRow, settlement);
    const second = carryClassificationFacts(oppositeOutcome, settlement);
    expect(first).toEqual(second);
    expect(classifyA2SourceRow(first)).toBe("quality_only");
    expect(classifyA2SourceRow.toString()).not.toMatch(
      /scores|changes|automaticPass|winner|jaccard|regression|rerankScore/iu,
    );
  });

  it("fixes the fresh continuation cap without carrying charges into its ledger", () => {
    expect(A2_PRIOR_COMMITTED_MICROUSD).toBe(10_394_031);
    expect(A2_CONTINUATION_MAX_MICROUSD).toBe(14_605_969);
    expect(A2_PRIOR_COMMITTED_MICROUSD + A2_CONTINUATION_MAX_MICROUSD)
      .toBe(A2_LIFETIME_MAX_MICROUSD);
  });

  it("allows only the frozen pending set to appear in the continuation ledger", () => {
    const partition = {
      carriedLogicalKeys: new Set(["q-carried:1"]),
      pendingPaidLogicalKeys: new Set(["q-pending:1"]),
    };
    expect(() => assertA2ContinuationLedgerAttemptKeys(partition, ["q-pending:1@1"]))
      .not.toThrow();
    expect(() => assertA2ContinuationLedgerAttemptKeys(partition, ["q-carried:1@1"]))
      .toThrow(/carried or unapproved/u);
    expect(() => assertA2ContinuationLedgerAttemptKeys(partition, ["q-unknown:1@1"]))
      .toThrow(/carried or unapproved/u);
    expect(() => assertA2ContinuationLedgerAttemptKeys(partition, ["q-pending:1@0"]))
      .toThrow(/carried or unapproved/u);
  });

  it("refuses a local evidence audit when any live-provider credential remains", () => {
    const prior = process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.SUPABASE_SERVICE_ROLE_KEY = "synthetic-never-used";
    try {
      expect(() => assertA2EvidenceAuditEnvironment()).toThrow(/credentials, URLs, and modes/u);
    } finally {
      if (prior === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      else process.env.SUPABASE_SERVICE_ROLE_KEY = prior;
    }
  });

  it("preserves partial known Cohere units as a lower bound for accounting", async () => {
    const priorStateOnly = process.env.A2_STATE_UNIT_TEST_ONLY;
    process.env.A2_STATE_UNIT_TEST_ONLY = "1";
    const state = await (async () => {
      try {
        return await import("@/tests/a2-rerank-comparison.live");
      } finally {
        if (priorStateOnly === undefined) delete process.env.A2_STATE_UNIT_TEST_ONLY;
        else process.env.A2_STATE_UNIT_TEST_ONLY = priorStateOnly;
      }
    })();
    const reservation = reserveA2Row("approved question", 2.50);
    const partialRow = (knownSearchUnits: number) => ({
      status: "invalid",
      arms: {
        current: {
          providerRequests: [
            { responseSucceeded: true, billedSearchUnits: knownSearchUnits },
            { responseSucceeded: false, billedSearchUnits: null },
          ],
        },
        global: { providerRequests: [] },
      },
    });

    const over = state.knownUsageForBudget(
      partialRow(reservation.cohereSearchUnitsCeiling + 1),
    );
    expect(over).toMatchObject({
      cohereSearchUnits: null,
      cohereSearchUnitsLowerBound: reservation.cohereSearchUnitsCeiling + 1,
      cohereUsageComplete: false,
    });
    expect(classifyA2RowAccounting(reservation, over).kind).toBe("definition_violation");

    const below = state.knownUsageForBudget(partialRow(1));
    expect(classifyA2RowAccounting(reservation, below)).toMatchObject({
      kind: "ordinary_incomplete",
      charge: {
        totalMicrousd: reservation.totalMicrousd,
        settlementKind: "entire_row_reservation",
      },
    });
  });
});
