import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { A2Preflight } from "@/tests/a2-rerank-comparison.live";
import {
  A2_BUDGET_DEFINITION,
  A2SpendLedger,
  A2RunLock,
  A2AccountingDefinitionViolation,
  a2RetryApproval,
  assertA2AutomaticRecoveryAllowed,
  bindA2CheckpointRowAccounting,
  chargeA2Row,
  classifyA2RowAccounting,
  microusdToUsd,
  readVerifiedA2CheckpointRowAccounting,
  reserveA2Row,
  sha256CanonicalA2Json,
  staleLockApproval,
  usdToMicrousdCeiling,
  verifyA2CheckpointRowAccounting,
  writeAndVerifyA2CheckpointBeforeSettlement,
  writeJsonDurably,
  type A2KnownRowUsage,
  type A2RowBudgetReservation,
} from "@/tests/a2-spend-budget";

const temporaryDirectories: string[] = [];

function temporaryLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "a2-spend-ledger-"));
  temporaryDirectories.push(directory);
  return join(directory, "spend-ledger.jsonl");
}

function temporaryRunDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "a2-run-state-"));
  temporaryDirectories.push(directory);
  mkdirSync(join(directory, "pools"));
  return directory;
}

function recoveryPreflight(runDirectory: string): A2Preflight {
  return {
    mode: "RECOVER",
    repeats: 4,
    usdPerThousandSearchUnits: 2.50,
    maxTotalUsd: 25,
    runId: "a2-budget-test-run",
    runDirectory,
    definitionSha256: "a".repeat(64),
    supabaseOrigin: "https://wzktlpjtqmjxvragwhqg.supabase.co",
    resumed: true,
  };
}

let stateModulePromise: Promise<typeof import("@/tests/a2-rerank-comparison.live")> | null = null;

function loadStateModule() {
  if (!stateModulePromise) {
    process.env.A2_STATE_UNIT_TEST_ONLY = "1";
    stateModulePromise = import("@/tests/a2-rerank-comparison.live").finally(() => {
      delete process.env.A2_STATE_UNIT_TEST_ONLY;
    });
  }
  return stateModulePromise;
}

function completeComparisonRow(
  candidateCount = 400,
  currentFinalCount = 200,
  embeddingProviderCalls: 0 | 1 = 1,
): Record<string, unknown> {
  const topN = Math.min(20, candidateCount);
  const top = Array.from({ length: topN }, (_, index) => ({ passageId: `p${index}` }));
  const currentDocumentCounts: number[] = [];
  for (let offset = 0; offset < candidateCount; offset += 200) {
    const count = Math.min(200, candidateCount - offset);
    if (count > 1) currentDocumentCounts.push(count);
  }
  if (candidateCount > 200) currentDocumentCounts.push(currentFinalCount);
  const currentRequests = currentDocumentCounts.map((documentCount) => ({
    documentCount,
    topN: documentCount,
    responseSucceeded: true,
    billedSearchUnits: 3,
  }));
  const cohereSearchUnits = currentRequests.length * 3 + 5;
  const usage = oneCallUsage({
    cohereSearchUnits,
    cohereSearchUnitsLowerBound: cohereSearchUnits,
    voyageProviderCalls: embeddingProviderCalls,
  });
  const row: Record<string, unknown> = {
    status: "complete",
    attemptKey: "q001:1@1",
    question: "approved question",
    poolSha256: "d".repeat(64),
    candidateCount,
    armExecutionOrder: ["current", "global"],
    searchToTop20Ms: { current: 1, global: 1 },
    sharedPreparationMs: 1,
    comparisonPipelineTotalMs: 2,
    arms: {
      current: {
        arm: "current",
        topN: 20,
        top,
        reranked: true,
        degradedReason: null,
        documentCount: currentDocumentCounts.reduce((total, count) => total + count, 0),
        providerCallCount: currentRequests.length,
        providerRequests: currentRequests,
        model: "rerank-v4.0-pro",
        durationMs: 1,
      },
      global: {
        arm: "global",
        topN: 20,
        top,
        reranked: true,
        degradedReason: null,
        documentCount: candidateCount,
        providerCallCount: 1,
        providerRequests: [
          { documentCount: candidateCount, topN, responseSucceeded: true, billedSearchUnits: 5 },
        ],
        model: "rerank-v4.0-pro",
        durationMs: 1,
      },
    },
    pipelineDegraded: false,
    invalidArm: false,
    providerUsageComplete: true,
    plannerUsage: {
      attempts: 1,
      promptTokens: usage.geminiPromptTokens,
      outputTokens: usage.geminiOutputTokens,
      thoughtsTokens: usage.geminiThoughtsTokens,
      totalTokens: usage.geminiTotalTokens,
      durationMs: 10,
      attemptDurationsMs: [10],
    },
    plannerCallUsage: usage.geminiCalls,
    embeddingProviderCalls,
  };
  return bindA2CheckpointRowAccounting(
    row,
    reserveA2Row(String(row.question), 2.50),
    usage,
  ).row;
}

function createLedger(path: string, maxUsd = 25): A2SpendLedger {
  const maxMicrousd = usdToMicrousdCeiling(maxUsd);
  return A2SpendLedger.create(path, {
    runId: "a2-budget-test-run",
    definitionSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    carryManifestSha256: "c".repeat(64),
    maxMicrousd,
    priorCommittedMicrousd: 0,
    lifetimeMaxMicrousd: maxMicrousd,
  });
}

function ledgerIdentity(maxUsd = 25) {
  const maxMicrousd = usdToMicrousdCeiling(maxUsd);
  return {
    runId: "a2-budget-test-run",
    definitionSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    carryManifestSha256: "c".repeat(64),
    maxMicrousd,
    priorCommittedMicrousd: 0,
    lifetimeMaxMicrousd: maxMicrousd,
  };
}

function recoveryLedgerIdentity(preflight: A2Preflight, manifestSha256: string) {
  const maxMicrousd = usdToMicrousdCeiling(preflight.maxTotalUsd);
  return {
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256,
    carryManifestSha256: preflight.carryManifestSha256 ?? "0".repeat(64),
    maxMicrousd,
    priorCommittedMicrousd: 0,
    lifetimeMaxMicrousd: maxMicrousd,
  };
}

function oneCallUsage(overrides: Partial<A2KnownRowUsage> = {}): A2KnownRowUsage {
  return {
    cohereSearchUnits: 11,
    cohereSearchUnitsLowerBound: 11,
    cohereUsageComplete: true,
    geminiAttempts: 1,
    geminiPromptTokens: 1_000,
    geminiOutputTokens: 500,
    geminiThoughtsTokens: 0,
    geminiTotalTokens: 1_500,
    geminiAttemptDurationsMs: [10],
    geminiCalls: [{
      attempt: 1,
      responseReceived: true,
      promptTokens: 1_000,
      candidateTokens: 500,
      thoughtsTokens: 0,
      toolUsePromptTokens: null,
      totalTokens: 1_500,
    }],
    voyageProviderCalls: 1,
    ...overrides,
  };
}

function twoCallUsage(overrides: Partial<A2KnownRowUsage> = {}): A2KnownRowUsage {
  return {
    cohereSearchUnits: 11,
    cohereSearchUnitsLowerBound: 11,
    cohereUsageComplete: true,
    geminiAttempts: 2,
    geminiPromptTokens: 1_800,
    geminiOutputTokens: 700,
    geminiThoughtsTokens: 0,
    geminiTotalTokens: 2_500,
    geminiAttemptDurationsMs: [10, 12],
    geminiCalls: [
      {
        attempt: 1,
        responseReceived: true,
        promptTokens: 1_000,
        candidateTokens: 400,
        thoughtsTokens: 0,
        toolUsePromptTokens: null,
        totalTokens: 1_400,
      },
      {
        attempt: 2,
        responseReceived: true,
        promptTokens: 800,
        candidateTokens: 300,
        thoughtsTokens: 0,
        toolUsePromptTokens: 0,
        totalTokens: 1_100,
      },
    ],
    voyageProviderCalls: 1,
    ...overrides,
  };
}

function syntheticReservation(
  totalMicrousd: number,
  components = { cohere: totalMicrousd, gemini: 0, voyage: 0 },
): A2RowBudgetReservation {
  if (components.cohere + components.gemini + components.voyage !== totalMicrousd) {
    throw new Error("synthetic reservation components must sum");
  }
  return {
    totalMicrousd,
    cohereMicrousd: components.cohere,
    geminiMicrousd: components.gemini,
    voyageMicrousd: components.voyage,
    cohereSearchUnitsCeiling: 1_000_000,
    cohereUsdPerThousandSearchUnits: 0,
    questionUtf8Bytes: 1,
  };
}

function settleLedgerFromUsage(
  ledger: A2SpendLedger,
  rowKey: string,
  reservation: A2RowBudgetReservation,
  usage: A2KnownRowUsage | null,
) {
  const checkpointPath = join(
    ledger.path,
    "..",
    `checkpoint-${rowKey.replace(/[^a-z0-9]+/giu, "-")}.json`,
  );
  const bound = bindA2CheckpointRowAccounting({
    attemptKey: rowKey,
    status: usage === null ? "interrupted" : "complete",
  }, reservation, usage);
  const verified = writeAndVerifyA2CheckpointBeforeSettlement(
    checkpointPath,
    { attemptHistory: [bound.row] },
    rowKey,
    reservation,
    true,
  );
  ledger.settleVerified(rowKey, verified);
  return verified;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("A2 hard spend budget", () => {
  it("binds paid approval to the exact run, definition, manifest, and cap", async () => {
    const { paidRunApproval } = await loadStateModule();
    const preflight = recoveryPreflight("C:/private/a2-run");
    const manifestSha256 = "b".repeat(64);
    const approval = paidRunApproval(preflight, manifestSha256);

    expect(approval).toMatch(/^I_APPROVE_PAID_A2:[0-9a-f]{64}$/u);
    expect(paidRunApproval({ ...preflight, runId: "another-run" }, manifestSha256))
      .not.toBe(approval);
    expect(paidRunApproval({ ...preflight, definitionSha256: "c".repeat(64) }, manifestSha256))
      .not.toBe(approval);
    expect(paidRunApproval(preflight, "d".repeat(64))).not.toBe(approval);
    expect(paidRunApproval({ ...preflight, maxTotalUsd: 24 }, manifestSha256))
      .not.toBe(approval);
  }, 15_000);

  it("allows recovery from the prior-lock-only crash window", async () => {
    const { recoveryStateAvailable } = await loadStateModule();
    const directory = mkdtempSync(join(tmpdir(), "a2-prior-lock-only-"));
    temporaryDirectories.push(directory);
    const priorLockPath = join(directory, "paid-run.lock");
    const priorInput = {
      runId: "prior-a2-run",
      definitionSha256: "a".repeat(64),
    };
    const stalePrior = `${JSON.stringify({
      schemaVersion: "a2-run-lock-v2",
      ...priorInput,
      lockId: "33333333-3333-4333-8333-333333333333",
      pid: 999_999,
      hostname: hostname(),
      startedAt: "2026-08-08T00:00:00.000Z",
    })}\n`;

    expect(recoveryStateAvailable(false, priorLockPath)).toBe(false);
    writeFileSync(priorLockPath, stalePrior);
    expect(recoveryStateAvailable(false, priorLockPath)).toBe(true);
    expect(recoveryStateAvailable(true, join(directory, "missing.lock"))).toBe(true);

    const priorLock = A2RunLock.acquire(priorLockPath, {
      ...priorInput,
      mode: "recover",
      staleLockApproval: staleLockApproval(stalePrior),
    });
    const restartLock = A2RunLock.acquire(join(directory, "restart.lock"), {
      runId: "restart-a2-run",
      definitionSha256: "b".repeat(64),
      mode: "recover",
    });
    expect(priorLock.recoveredArchivePath).not.toBeNull();
    expect(restartLock.recoveredArchivePath).toBeNull();
    restartLock.release();
    priorLock.release();
  });

  it("reserves a strict upper bound for every paid provider in one row", () => {
    const reservation = reserveA2Row("x".repeat(257), 2.50);

    expect(reservation.cohereSearchUnitsCeiling).toBe(181);
    expect(reservation.cohereMicrousd).toBe(452_500);
    expect(reservation.geminiMicrousd).toBe(637_146);
    expect(reservation.voyageMicrousd).toBe(21_600);
    expect(reservation.totalMicrousd).toBe(1_111_246);
    expect(microusdToUsd(reservation.totalMicrousd)).toBeLessThan(1.2);
  });

  it("reserves Voyage's whole endpoint token allowance, including provider-added query prompts", () => {
    const short = reserveA2Row("short", 2.50);
    const long = reserveA2Row("x".repeat(257), 2.50);

    expect(short.voyageMicrousd).toBe(21_600);
    expect(long.voyageMicrousd).toBe(21_600);
    expect(long.cohereSearchUnitsCeiling).toBeGreaterThan(short.cohereSearchUnitsCeiling);
  });

  it("reconciles only complete provider usage and keeps Voyage at its request ceiling", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const charge = chargeA2Row(reservation, oneCallUsage());

    expect(charge.completeUsage).toBe(true);
    expect(charge.settlementKind).toBe("usage_proved");
    expect(charge.cohereMicrousd).toBe(27_500);
    expect(charge.geminiMicrousd).toBe(1_550);
    expect(charge.voyageMicrousd).toBe(reservation.voyageMicrousd);
    expect(charge.totalMicrousd).toBeLessThan(reservation.totalMicrousd);
  });

  it("retains the entire row reservation when any ordinary usage is incomplete", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const charge = chargeA2Row(reservation, oneCallUsage({
      cohereSearchUnits: null,
      voyageProviderCalls: null,
    }));

    expect(charge.completeUsage).toBe(false);
    expect(charge.settlementKind).toBe("entire_row_reservation");
    expect(charge).toEqual({
      totalMicrousd: reservation.totalMicrousd,
      cohereMicrousd: reservation.cohereMicrousd,
      geminiMicrousd: reservation.geminiMicrousd,
      voyageMicrousd: reservation.voyageMicrousd,
      completeUsage: false,
      settlementKind: "entire_row_reservation",
    });
  });

  it("proves exact Gemini usage across two ordered calls", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const charge = chargeA2Row(reservation, twoCallUsage());

    expect(charge.completeUsage).toBe(true);
    expect(charge.settlementKind).toBe("usage_proved");
    expect(charge.geminiMicrousd).toBeLessThan(reservation.geminiMicrousd);
  });

  it("charges the full reservation for a failed or interrupted row", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    expect(chargeA2Row(reservation, null)).toEqual({
      totalMicrousd: reservation.totalMicrousd,
      cohereMicrousd: reservation.cohereMicrousd,
      geminiMicrousd: reservation.geminiMicrousd,
      voyageMicrousd: reservation.voyageMicrousd,
      completeUsage: false,
      settlementKind: "entire_row_reservation",
    });
  });

  it("refuses the next row before its reservation could cross the cap", () => {
    const ledger = createLedger(temporaryLedgerPath(), 1.5);
    const firstReservation = syntheticReservation(1_000_000, {
      cohere: 500_000,
      gemini: 400_000,
      voyage: 100_000,
    });
    ledger.reserve("q1:1@1", firstReservation);

    expect(() => ledger.reserve("q2:1@1", syntheticReservation(500_001)))
      .toThrow(/approved maximum/u);
    settleLedgerFromUsage(ledger, "q1:1@1", firstReservation, oneCallUsage({
      voyageProviderCalls: 0,
    }));
    expect(() => ledger.reserve("q2:1@1", syntheticReservation(500_001))).not.toThrow();
  });

  it("allows all 264 rows when complete usage stays below the approved cap", () => {
    const ledger = createLedger(temporaryLedgerPath());
    for (let index = 0; index < 264; index += 1) {
      const rowKey = `q${String(index + 1).padStart(3, "0")}:1@1`;
      const reservation = reserveA2Row("x".repeat(257), 2.50);
      ledger.reserve(rowKey, reservation);
      settleLedgerFromUsage(ledger, rowKey, reservation, oneCallUsage({
        geminiPromptTokens: 7_300,
        geminiOutputTokens: 1_600,
        geminiTotalTokens: 8_900,
        geminiCalls: [{
          attempt: 1,
          responseReceived: true,
          promptTokens: 7_300,
          candidateTokens: 1_600,
          thoughtsTokens: 0,
          toolUsePromptTokens: null,
          totalTokens: 8_900,
        }],
      }));
    }

    expect(ledger.openRowKeys()).toEqual([]);
    expect(microusdToUsd(ledger.committedMicrousd())).toBeLessThan(25);
  }, 15_000);

  it("keeps an open reservation charged after a crash and blocks duplicate spend", () => {
    const path = temporaryLedgerPath();
    const ledger = createLedger(path);
    ledger.reserve("q1:1@1", syntheticReservation(865_269));

    const reopened = A2SpendLedger.open(path, ledgerIdentity());
    expect(reopened.committedMicrousd()).toBe(865_269);
    expect(reopened.openRowKeys()).toEqual(["q1:1@1"]);
    expect(() => reopened.reserve("q1:1@1", syntheticReservation(865_269))).toThrow(/already has/u);
  });

  it("retains every historical attempt charge for the same logical row", () => {
    const ledger = createLedger(temporaryLedgerPath());
    const firstReservation = syntheticReservation(100);
    ledger.reserve("q1:1@1", firstReservation);
    settleLedgerFromUsage(ledger, "q1:1@1", firstReservation, null);
    const secondReservation = reserveA2Row("approved question", 2.50);
    const secondCharge = chargeA2Row(secondReservation, oneCallUsage());
    ledger.reserve("q1:1@2", secondReservation);
    settleLedgerFromUsage(ledger, "q1:1@2", secondReservation, oneCallUsage());

    expect(ledger.rowKeys()).toEqual(["q1:1@1", "q1:1@2"]);
    expect(ledger.committedMicrousd()).toBe(100 + secondCharge.totalMicrousd);
  });

  it("holds one exclusive run lock for the whole evaluator process", () => {
    const path = join(temporaryLedgerPath(), "..", "run.lock");
    const input = {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      mode: "run" as const,
    };
    const first = A2RunLock.acquire(path, input);
    expect(() => A2RunLock.acquire(path, input)).toThrow(/run lock already exists/u);
    first.release();
    const next = A2RunLock.acquire(path, input);
    next.release();
  });

  it("recovers a stale same-host lock only with its exact one-time digest", () => {
    const path = join(temporaryLedgerPath(), "..", "run.lock");
    const raw = `${JSON.stringify({
      schemaVersion: "a2-run-lock-v2",
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      lockId: "11111111-1111-4111-8111-111111111111",
      pid: 999_999,
      hostname: hostname(),
      startedAt: "2026-08-08T00:00:00.000Z",
    })}\n`;
    writeFileSync(path, raw, "utf8");

    expect(() => A2RunLock.acquire(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      mode: "recover",
      staleLockApproval: "wrong",
    })).toThrow(/I_APPROVE_STALE_LOCK_RECOVERY/u);

    const recovered = A2RunLock.acquire(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      mode: "recover",
      staleLockApproval: staleLockApproval(raw),
    });
    expect(recovered.recovered).toBe(true);
    expect(recovered.recoveredArchivePath).not.toBeNull();
    expect(existsSync(recovered.recoveredArchivePath!)).toBe(true);
    recovered.release();
  });

  it("refuses stale-lock recovery while the recorded owner process is alive", () => {
    const path = join(temporaryLedgerPath(), "..", "run.lock");
    const input = {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      mode: "run" as const,
    };
    const owner = A2RunLock.acquire(path, input);
    const raw = readFileSync(path, "utf8");
    expect(() => A2RunLock.acquire(path, {
      ...input,
      mode: "recover",
      staleLockApproval: staleLockApproval(raw),
    })).toThrow(/owner is still alive/u);
    owner.release();
  });

  it("retains an interrupted run lock for explicit recovery", () => {
    const path = join(temporaryLedgerPath(), "..", "run.lock");
    const input = {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      mode: "run" as const,
    };
    const owner = A2RunLock.acquire(path, input);
    owner.retainForRecovery();

    expect(existsSync(path)).toBe(true);
    expect(() => A2RunLock.acquire(path, input)).toThrow(/recovery-only mode/u);
  });

  it("restores the original stale lock when recovery cannot finish", () => {
    const path = join(temporaryLedgerPath(), "..", "run.lock");
    const raw = `${JSON.stringify({
      schemaVersion: "a2-run-lock-v2",
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      lockId: "22222222-2222-4222-8222-222222222222",
      pid: 999_999,
      hostname: hostname(),
      startedAt: "2026-08-08T00:00:00.000Z",
    })}\n`;
    writeFileSync(path, raw, "utf8");
    const recovered = A2RunLock.acquire(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      mode: "recover",
      staleLockApproval: staleLockApproval(raw),
    });
    const archive = recovered.recoveredArchivePath!;
    recovered.restoreRecoveredLock();

    expect(readFileSync(path, "utf8")).toBe(raw);
    expect(existsSync(archive)).toBe(false);
  });

  it("atomically replaces durable JSON and leaves a parseable target", () => {
    const path = temporaryLedgerPath();
    writeJsonDurably(path, { generation: 1 }, true);
    writeJsonDurably(path, { generation: 2 });

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ generation: 2 });
    expect(readdirSync(join(path, "..")).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("binds paid retry approval to the exact immutable retry manifest", () => {
    const manifest = {
      schemaVersion: "a2-retry-manifest-v1",
      runId: "a2-budget-test-run",
      committedMicrousd: 123,
      retries: [{ attemptKey: "q1:1@2" }],
    };
    const approval = a2RetryApproval(manifest);

    expect(approval).toMatch(/^I_APPROVE_PAID_A2_RETRY:[0-9a-f]{64}$/u);
    expect(a2RetryApproval({ ...manifest, committedMicrousd: 124 })).not.toBe(approval);
    expect(a2RetryApproval({
      ...manifest,
      retries: [{ attemptKey: "q1:1@3" }],
    })).not.toBe(approval);
  });

  it("rejects a partial durable entry instead of guessing after a crash", () => {
    const path = temporaryLedgerPath();
    createLedger(path);
    appendFileSync(path, "{\"type\":\"reserve\"", "utf8");

    expect(() => A2SpendLedger.open(path, ledgerIdentity())).toThrow(/partial final entry/u);
  });

  it("rejects a ledger opened under a different run-manifest digest", () => {
    const path = temporaryLedgerPath();
    createLedger(path);

    expect(() => A2SpendLedger.open(path, {
      ...ledgerIdentity(),
      manifestSha256: "d".repeat(64),
    })).toThrow(/header differs/u);
  });

  it("classifies known provider ceiling breaches before ordinary incompleteness", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const cases: Array<[string, A2KnownRowUsage]> = [
      ["tool use", oneCallUsage({
        geminiTotalTokens: 1_501,
        geminiCalls: [{
          ...oneCallUsage().geminiCalls[0],
          toolUsePromptTokens: 1,
          totalTokens: 1_501,
        }],
      })],
      ["too many calls", twoCallUsage({
        geminiAttempts: 3,
        geminiPromptTokens: 2_000,
        geminiOutputTokens: 800,
        geminiTotalTokens: 2_800,
        geminiAttemptDurationsMs: [1, 1, 1],
        geminiCalls: [
          ...twoCallUsage().geminiCalls,
          {
            attempt: 3,
            responseReceived: true,
            promptTokens: 200,
            candidateTokens: 100,
            thoughtsTokens: 0,
            toolUsePromptTokens: 0,
            totalTokens: 300,
          },
        ],
      })],
      ["prompt ceiling", oneCallUsage({
        geminiPromptTokens: 1_048_577,
        geminiTotalTokens: 1_049_077,
        geminiCalls: [{
          ...oneCallUsage().geminiCalls[0],
          promptTokens: 1_048_577,
          totalTokens: 1_049_077,
        }],
      })],
      ["output ceiling", oneCallUsage({
        geminiOutputTokens: 1_601,
        geminiTotalTokens: 2_601,
        geminiCalls: [{
          ...oneCallUsage().geminiCalls[0],
          candidateTokens: 1_601,
          totalTokens: 2_601,
        }],
      })],
      ["known output lower bound with missing candidate metadata", oneCallUsage({
        geminiOutputTokens: null,
        geminiThoughtsTokens: 2_000,
        geminiTotalTokens: null,
        geminiCalls: [{
          attempt: 1,
          responseReceived: true,
          promptTokens: 1_000,
          candidateTokens: null,
          thoughtsTokens: 2_000,
          toolUsePromptTokens: null,
          totalTokens: null,
        }],
      })],
      ["aggregate prompt ceiling with missing call proof", oneCallUsage({
        geminiPromptTokens: A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt + 1,
        geminiOutputTokens: null,
        geminiThoughtsTokens: null,
        geminiTotalTokens: null,
        geminiCalls: [],
      })],
      ["aggregate two-call output ceiling with missing call proof", twoCallUsage({
        geminiPromptTokens: null,
        geminiOutputTokens: 2 * A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt + 1,
        geminiThoughtsTokens: 0,
        geminiTotalTokens: null,
        geminiCalls: [],
      })],
      ["aggregate total ceiling with missing components", twoCallUsage({
        geminiPromptTokens: null,
        geminiOutputTokens: null,
        geminiThoughtsTokens: null,
        geminiTotalTokens: 2 * (
          A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt
            + A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt
        ) + 1,
        geminiCalls: [],
      })],
      ["per-call total ceiling with missing components", oneCallUsage({
        geminiPromptTokens: null,
        geminiOutputTokens: null,
        geminiThoughtsTokens: null,
        geminiTotalTokens: null,
        geminiCalls: [{
          attempt: 1,
          responseReceived: true,
          promptTokens: null,
          candidateTokens: null,
          thoughtsTokens: null,
          toolUsePromptTokens: null,
          totalTokens: A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt
            + A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt + 1,
        }],
      })],
      ["derived per-call output ceiling with missing output components", oneCallUsage({
        geminiOutputTokens: null,
        geminiThoughtsTokens: null,
        geminiTotalTokens: 2_601,
        geminiCalls: [{
          attempt: 1,
          responseReceived: true,
          promptTokens: 1_000,
          candidateTokens: null,
          thoughtsTokens: null,
          toolUsePromptTokens: null,
          totalTokens: 2_601,
        }],
      })],
      ["Cohere ceiling", oneCallUsage({
        cohereSearchUnits: reservation.cohereSearchUnitsCeiling + 1,
        geminiCalls: [],
      })],
      ["Voyage call ceiling", oneCallUsage({
        voyageProviderCalls: 2,
        geminiCalls: [],
      })],
    ];
    for (const [label, usage] of cases) {
      const decision = classifyA2RowAccounting(reservation, usage);
      expect(decision.kind, label).toBe("definition_violation");
      expect(() => chargeA2Row(reservation, usage), label)
        .toThrow(A2AccountingDefinitionViolation);
    }
  });

  it("treats a known aggregate Gemini price above its provider reservation as a violation", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const reducedGeminiReservation = {
      ...reservation,
      cohereMicrousd: reservation.cohereMicrousd + reservation.geminiMicrousd - 1_549,
      geminiMicrousd: 1_549,
    };
    const decision = classifyA2RowAccounting(reducedGeminiReservation, oneCallUsage({
      geminiCalls: [],
    }));
    expect(decision.kind).toBe("definition_violation");
    if (decision.kind === "definition_violation") {
      expect(decision.violationCodes).toContain("gemini_provider_charge_ceiling_exceeded");
    }
  });

  it("uses partial Cohere units as a lower bound before completeness", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const overage = classifyA2RowAccounting(reservation, oneCallUsage({
      cohereSearchUnits: null,
      cohereSearchUnitsLowerBound: reservation.cohereSearchUnitsCeiling + 1,
      cohereUsageComplete: false,
    }));
    expect(overage.kind).toBe("definition_violation");
    if (overage.kind === "definition_violation") {
      expect(overage.violationCodes).toContain("cohere_search_units_ceiling_exceeded");
    }

    const incomplete = classifyA2RowAccounting(reservation, oneCallUsage({
      cohereSearchUnits: null,
      cohereSearchUnitsLowerBound: reservation.cohereSearchUnitsCeiling - 1,
      cohereUsageComplete: false,
    }));
    expect(incomplete.kind).toBe("ordinary_incomplete");
    if (incomplete.kind === "ordinary_incomplete") {
      expect(incomplete.charge).toMatchObject({
        totalMicrousd: reservation.totalMicrousd,
        settlementKind: "entire_row_reservation",
      });
    }
  });

  it("never offsets one provider's known overage with another provider's unused reservation", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const decision = classifyA2RowAccounting(reservation, oneCallUsage({
      cohereSearchUnits: reservation.cohereSearchUnitsCeiling + 1,
      voyageProviderCalls: 0,
    }));
    expect(decision.kind).toBe("definition_violation");
    if (decision.kind === "definition_violation") {
      expect(decision.violationCodes).toContain("cohere_search_units_ceiling_exceeded");
    }
  });

  it("charges the entire row for every ordinary two-call proof defect", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const cases: Array<[string, A2KnownRowUsage]> = [
      ["missing second call", twoCallUsage({ geminiCalls: [twoCallUsage().geminiCalls[0]] })],
      ["wrong order", twoCallUsage({
        geminiCalls: [...twoCallUsage().geminiCalls].reverse(),
      })],
      ["missing response", twoCallUsage({
        geminiCalls: [
          twoCallUsage().geminiCalls[0],
          { ...twoCallUsage().geminiCalls[1], responseReceived: false },
        ],
      })],
      ["duration mismatch", twoCallUsage({ geminiAttemptDurationsMs: [1] })],
      ["per-call arithmetic", twoCallUsage({
        geminiCalls: [
          { ...twoCallUsage().geminiCalls[0], totalTokens: 1_401 },
          twoCallUsage().geminiCalls[1],
        ],
      })],
      ["aggregate mismatch", twoCallUsage({ geminiTotalTokens: 2_501 })],
      ["negative optional metadata", oneCallUsage({
        geminiCalls: [{ ...oneCallUsage().geminiCalls[0], thoughtsTokens: -1 }],
      })],
    ];
    for (const [label, usage] of cases) {
      const charge = chargeA2Row(reservation, usage);
      expect(charge, label).toEqual({
        totalMicrousd: reservation.totalMicrousd,
        cohereMicrousd: reservation.cohereMicrousd,
        geminiMicrousd: reservation.geminiMicrousd,
        voyageMicrousd: reservation.voyageMicrousd,
        completeUsage: false,
        settlementKind: "entire_row_reservation",
      });
    }
  });

  it("canonically binds proof and the exact checkpoint row", () => {
    expect(sha256CanonicalA2Json({ b: 2, a: { d: 4, c: 3 } }))
      .toBe(sha256CanonicalA2Json({ a: { c: 3, d: 4 }, b: 2 }));
    const reservation = reserveA2Row("approved question", 2.50);
    const bound = bindA2CheckpointRowAccounting({
      attemptKey: "q1:1@1",
      status: "complete",
      nested: { b: 2, a: 1 },
    }, reservation, twoCallUsage());
    const verified = verifyA2CheckpointRowAccounting(bound.row, reservation);
    expect(verified.decision.kind).toBe("usage_proved");
    expect(verified.proofSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(verified.checkpointRowSha256).toMatch(/^[0-9a-f]{64}$/u);

    const changedRow = JSON.parse(JSON.stringify(bound.row)) as Record<string, unknown>;
    changedRow.status = "invalid";
    expect(() => verifyA2CheckpointRowAccounting(changedRow, reservation)).toThrow(/digest differs/u);

    const changedProof = JSON.parse(JSON.stringify(bound.row)) as Record<string, unknown>;
    const accounting = changedProof.accounting as Record<string, unknown>;
    const proof = accounting.proof as Record<string, unknown>;
    proof.cohereSearchUnits = 12;
    expect(() => verifyA2CheckpointRowAccounting(changedProof, reservation)).toThrow(/digest differs/u);
  });

  it("cross-binds every reservation field into the checkpoint accounting", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const sameTotalDifferentProviders = {
      ...reservation,
      cohereMicrousd: reservation.cohereMicrousd - 1,
      geminiMicrousd: reservation.geminiMicrousd + 1,
    };
    const bound = bindA2CheckpointRowAccounting({
      attemptKey: "q1:1@1",
      status: "complete",
    }, reservation, oneCallUsage());
    const accounting = bound.row.accounting as Record<string, unknown>;
    expect(accounting.reservation).toEqual(reservation);
    expect(() => verifyA2CheckpointRowAccounting(bound.row, sameTotalDifferentProviders))
      .toThrow(/reservation differs/u);
  });

  it("freezes durable reservation proof and rejects a same-total ledger component swap", () => {
    const path = temporaryLedgerPath();
    const checkpointPath = join(path, "..", "comparison-report.json");
    const ledger = createLedger(path);
    const reservation = reserveA2Row("approved question", 2.50);
    const ledgerReservation = {
      ...reservation,
      cohereMicrousd: reservation.cohereMicrousd - 1,
      geminiMicrousd: reservation.geminiMicrousd + 1,
    };
    const key = "q1:1@1";
    ledger.reserve(key, ledgerReservation);
    const bound = bindA2CheckpointRowAccounting({ attemptKey: key, status: "complete" },
      reservation, oneCallUsage());
    const verified = writeAndVerifyA2CheckpointBeforeSettlement(
      checkpointPath,
      { attemptHistory: [bound.row] },
      key,
      reservation,
      true,
    );

    expect(Object.isFrozen(verified)).toBe(true);
    expect(Object.isFrozen(verified.reservation)).toBe(true);
    expect(Reflect.set(verified.reservation, "cohereMicrousd", 0)).toBe(false);
    expect(Reflect.set(verified, "reservation", ledgerReservation)).toBe(false);
    expect(() => ledger.settleVerified(key, verified)).toThrow(/ledger reservation/u);
    expect(ledger.openRowKeys()).toEqual([key]);
  });

  it("rejects a same-component ledger reservation with a changed Cohere rate", () => {
    const path = temporaryLedgerPath();
    const checkpointPath = join(path, "..", "comparison-report.json");
    const ledger = createLedger(path);
    const reservation = reserveA2Row("approved question", 2.50);
    const changedRateReservation = {
      ...reservation,
      cohereUsdPerThousandSearchUnits: 0,
    };
    const key = "q1:1@1";
    ledger.reserve(key, changedRateReservation);
    const bound = bindA2CheckpointRowAccounting({ attemptKey: key, status: "complete" },
      reservation, oneCallUsage());
    const verified = writeAndVerifyA2CheckpointBeforeSettlement(
      checkpointPath,
      { attemptHistory: [bound.row] },
      key,
      reservation,
      true,
    );

    const reopened = A2SpendLedger.open(path, ledgerIdentity());
    expect(reopened.rowState(key)).toMatchObject({
      cohereSearchUnitsCeiling: changedRateReservation.cohereSearchUnitsCeiling,
      cohereUsdPerThousandSearchUnits: 0,
      questionUtf8Bytes: changedRateReservation.questionUtf8Bytes,
    });
    expect(() => reopened.settleVerified(key, verified)).toThrow(/ledger reservation/u);
    expect(reopened.openRowKeys()).toEqual([key]);
  });

  it("returns an immutable row-state snapshot instead of its live accounting map value", () => {
    const path = temporaryLedgerPath();
    const ledger = createLedger(path);
    const reservation = reserveA2Row("approved question", 2.50);
    const key = "q1:1@1";
    ledger.reserve(key, reservation);
    const snapshot = ledger.rowState(key)!;

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Reflect.set(snapshot, "chargedMicrousd", 0)).toBe(false);
    expect(ledger.rowState(key)?.chargedMicrousd).toBeNull();
    expect(ledger.committedMicrousd()).toBe(reservation.totalMicrousd);
  });

  it("settles a reserve-only crash at the entire row reservation after a durable bound checkpoint", () => {
    const path = temporaryLedgerPath();
    const checkpointPath = join(path, "..", "comparison-report.json");
    const ledger = createLedger(path);
    const reservation = reserveA2Row("approved question", 2.50);
    const key = "q1:1@1";
    ledger.reserve(key, reservation);
    const bound = bindA2CheckpointRowAccounting({
      attemptKey: key,
      status: "interrupted",
      kind: "process_interrupted_before_durable_outcome",
    }, reservation, null);
    const verified = writeAndVerifyA2CheckpointBeforeSettlement(
      checkpointPath,
      { attemptHistory: [bound.row], budgetOpenAttempts: [key] },
      key,
      reservation,
      true,
    );
    expect(verified.decision.kind).toBe("ordinary_incomplete");
    ledger.settleVerified(key, verified);
    expect(ledger.rowState(key)).toMatchObject({
      chargedMicrousd: reservation.totalMicrousd,
      settlementKind: "entire_row_reservation",
      proofSha256: verified.proofSha256,
      checkpointRowSha256: verified.checkpointRowSha256,
    });
  });

  it("recovers after proof write and before settlement without losing exact two-call usage", () => {
    const path = temporaryLedgerPath();
    const checkpointPath = join(path, "..", "comparison-report.json");
    const reservation = reserveA2Row("approved question", 2.50);
    const key = "q1:1@1";
    const ledger = createLedger(path);
    ledger.reserve(key, reservation);
    const bound = bindA2CheckpointRowAccounting({ attemptKey: key, status: "complete" },
      reservation, twoCallUsage());
    writeJsonDurably(checkpointPath, { attemptHistory: [bound.row], budgetOpenAttempts: [key] });

    const reopened = A2SpendLedger.open(path, ledgerIdentity());
    const verified = readVerifiedA2CheckpointRowAccounting(checkpointPath, key, reservation);
    expect(verified.decision.kind).toBe("usage_proved");
    reopened.settleVerified(key, verified);
    expect(reopened.rowState(key)?.chargedMicrousd).toBe(verified.decision.charge!.totalMicrousd);
    expect(reopened.rowState(key)?.chargedMicrousd).toBeLessThan(reservation.totalMicrousd);
  });

  it("rereads the durable checkpoint inside settleVerified and refuses a stale verification", () => {
    const path = temporaryLedgerPath();
    const checkpointPath = join(path, "..", "comparison-report.json");
    const reservation = reserveA2Row("approved question", 2.50);
    const key = "q1:1@1";
    const ledger = createLedger(path);
    ledger.reserve(key, reservation);
    const bound = bindA2CheckpointRowAccounting({ attemptKey: key, status: "complete" },
      reservation, oneCallUsage());
    const verified = writeAndVerifyA2CheckpointBeforeSettlement(
      checkpointPath,
      { attemptHistory: [bound.row] },
      key,
      reservation,
      true,
    );
    const changed = JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, unknown>;
    const history = changed.attemptHistory as Array<Record<string, unknown>>;
    history[0].status = "altered-after-verification";
    writeJsonDurably(checkpointPath, changed);

    expect(() => ledger.settleVerified(key, verified)).toThrow(/digest differs/u);
    expect(ledger.openRowKeys()).toEqual([key]);
  });

  it("replays a settlement that became durable before the final report rewrite", () => {
    const path = temporaryLedgerPath();
    const checkpointPath = join(path, "..", "comparison-report.json");
    const reservation = reserveA2Row("approved question", 2.50);
    const key = "q1:1@1";
    const ledger = createLedger(path);
    ledger.reserve(key, reservation);
    const bound = bindA2CheckpointRowAccounting({ attemptKey: key, status: "complete" },
      reservation, oneCallUsage());
    const verified = writeAndVerifyA2CheckpointBeforeSettlement(
      checkpointPath,
      { attemptHistory: [bound.row], budgetOpenAttempts: [key] },
      key,
      reservation,
      true,
    );
    ledger.settleVerified(key, verified);
    const settledSha = ledger.sha256();

    const reopened = A2SpendLedger.open(path, ledgerIdentity());
    const durable = readVerifiedA2CheckpointRowAccounting(checkpointPath, key, reservation);
    expect(reopened.openRowKeys()).toEqual([]);
    expect(reopened.rowState(key)?.proofSha256).toBe(durable.proofSha256);
    expect(() => reopened.settleVerified(key, durable)).toThrow(/cannot be settled/u);
    expect(reopened.sha256()).toBe(settledSha);
  });

  it("rejects a replayed same-total settlement whose provider components do not match its proof", async () => {
    const { assertLedgerBijection } = await loadStateModule();
    const gold = JSON.parse(readFileSync(join(process.cwd(), "tests/gold/gold-set-v1.json"), "utf8")) as {
      questions: Array<{ id: string; question: string }>;
    };
    const question = gold.questions.find((candidate) => candidate.id === "q001")!;
    const path = temporaryLedgerPath();
    const ledger = createLedger(path);
    const reservation = reserveA2Row(question.question, 2.50);
    const key = "q001:1@1";
    ledger.reserve(key, reservation);
    const bound = bindA2CheckpointRowAccounting({
      attemptKey: key,
      logicalRowKey: "q001:1",
      questionId: question.id,
      status: "complete",
    }, reservation, oneCallUsage());
    const verification = verifyA2CheckpointRowAccounting(bound.row, reservation);
    expect(verification.decision.kind).toBe("usage_proved");
    if (verification.decision.kind !== "usage_proved") throw new Error("expected exact usage");
    const charge = verification.decision.charge;
    appendFileSync(path, `${JSON.stringify({
      type: "settle",
      rowKey: key,
      chargedMicrousd: charge.totalMicrousd,
      cohereMicrousd: charge.cohereMicrousd + 1,
      geminiMicrousd: charge.geminiMicrousd - 1,
      voyageMicrousd: charge.voyageMicrousd,
      completeUsage: true,
      settlementKind: "usage_proved",
      proofSha256: verification.proofSha256,
      checkpointRowSha256: verification.checkpointRowSha256,
    })}\n`, "utf8");
    const reopened = A2SpendLedger.open(path, ledgerIdentity());

    expect(() => assertLedgerBijection(
      recoveryPreflight(join(path, "..")),
      [bound.row],
      reopened,
      false,
    )).toThrow(/wrong spend settlement/u);
  });

  it("persists a definition violation in the bound row and refuses automatic recovery", () => {
    const path = temporaryLedgerPath();
    const checkpointPath = join(path, "..", "comparison-report.json");
    const reservation = reserveA2Row("approved question", 2.50);
    const key = "q1:1@1";
    const ledger = createLedger(path);
    ledger.reserve(key, reservation);
    const usage = oneCallUsage({
      geminiTotalTokens: 1_501,
      geminiCalls: [{
        ...oneCallUsage().geminiCalls[0],
        toolUsePromptTokens: 1,
        totalTokens: 1_501,
      }],
    });
    const bound = bindA2CheckpointRowAccounting({
      attemptKey: key,
      status: "accounting_definition_violation",
    }, reservation, usage);
    writeJsonDurably(checkpointPath, { attemptHistory: [bound.row] }, true);
    const verified = readVerifiedA2CheckpointRowAccounting(checkpointPath, key, reservation);
    expect(verified.decision.kind).toBe("definition_violation");
    expect(() => assertA2AutomaticRecoveryAllowed(verified))
      .toThrow(A2AccountingDefinitionViolation);
    expect(ledger.openRowKeys()).toEqual([key]);
  });

  it("opens v3 evidence strictly read-only without changing a byte", () => {
    const path = temporaryLedgerPath();
    const body = [
      JSON.stringify({
        type: "header",
        schemaVersion: "a2-spend-ledger-v3",
        runId: "legacy-run",
        definitionSha256: "1".repeat(64),
        manifestSha256: "2".repeat(64),
        maxMicrousd: 1_000,
      }),
      JSON.stringify({ type: "reserve", rowKey: "q1:1@1", reservedMicrousd: 100 }),
      JSON.stringify({
        type: "settle",
        rowKey: "q1:1@1",
        chargedMicrousd: 70,
        completeUsage: true,
      }),
      "",
    ].join("\n");
    writeFileSync(path, body, "utf8");
    const before = readFileSync(path);
    const legacy = A2SpendLedger.openLegacyReadOnly(path, {
      runId: "legacy-run",
      definitionSha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      maxMicrousd: 1_000,
    });
    expect(legacy.rowState("q1:1@1")?.chargedMicrousd).toBe(70);
    expect(() => legacy.reserve("q2:1@1", syntheticReservation(10))).toThrow(/read-only/u);
    expect(readFileSync(path)).toEqual(before);
  });

  it("opens v4 evidence through an immutable query-only surface without changing a byte", () => {
    const path = temporaryLedgerPath();
    const ledger = createLedger(path);
    const reservation = reserveA2Row("approved question", 2.50);
    const key = "q1:1@1";
    ledger.reserve(key, reservation);
    const verified = settleLedgerFromUsage(ledger, key, reservation, oneCallUsage());
    const before = readFileSync(path);

    const readOnly = A2SpendLedger.openV4ReadOnly(path, ledgerIdentity());
    const surface = readOnly as unknown as Record<string, unknown>;
    const keys = readOnly.rowKeys();
    const state = readOnly.rowState(key)!;

    expect(Object.isFrozen(readOnly)).toBe(true);
    expect("reserve" in surface).toBe(false);
    expect("settleVerified" in surface).toBe(false);
    expect(surface.reserve).toBeUndefined();
    expect(surface.settleVerified).toBeUndefined();
    expect(Object.isFrozen(keys)).toBe(true);
    expect(Reflect.set(keys, "0", "q2:1@1")).toBe(false);
    expect(readOnly.rowKeys()).toEqual([key]);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Reflect.set(state, "chargedMicrousd", 0)).toBe(false);
    expect(readOnly.rowState(key)).toMatchObject({
      reservedMicrousd: reservation.totalMicrousd,
      chargedMicrousd: verified.decision.charge!.totalMicrousd,
      cohereChargedMicrousd: verified.decision.charge!.cohereMicrousd,
      geminiChargedMicrousd: verified.decision.charge!.geminiMicrousd,
      voyageChargedMicrousd: verified.decision.charge!.voyageMicrousd,
      proofSha256: verified.proofSha256,
      checkpointRowSha256: verified.checkpointRowSha256,
    });
    expect(readOnly.openRowKeys()).toEqual([]);
    expect(readOnly.committedMicrousd()).toBe(verified.decision.charge!.totalMicrousd);
    expect(readOnly.sha256()).toBe(ledger.sha256());
    expect(readFileSync(path)).toEqual(before);
  });

  it("keeps each v4 settlement's components and digests cross-bound to its row snapshot", () => {
    const path = temporaryLedgerPath();
    const ledger = createLedger(path);
    const firstReservation = reserveA2Row("first approved question", 2.50);
    const secondReservation = reserveA2Row("second approved question", 2.50);
    ledger.reserve("q1:1@1", firstReservation);
    const first = settleLedgerFromUsage(
      ledger,
      "q1:1@1",
      firstReservation,
      oneCallUsage({ cohereSearchUnits: 9, cohereSearchUnitsLowerBound: 9 }),
    );
    ledger.reserve("q2:1@1", secondReservation);
    const second = settleLedgerFromUsage(
      ledger,
      "q2:1@1",
      secondReservation,
      oneCallUsage({ cohereSearchUnits: 12, cohereSearchUnitsLowerBound: 12 }),
    );

    const readOnly = A2SpendLedger.openV4ReadOnly(path, ledgerIdentity());

    expect(readOnly.rowState("q1:1@1")).toMatchObject({
      chargedMicrousd: first.decision.charge!.totalMicrousd,
      cohereChargedMicrousd: first.decision.charge!.cohereMicrousd,
      geminiChargedMicrousd: first.decision.charge!.geminiMicrousd,
      voyageChargedMicrousd: first.decision.charge!.voyageMicrousd,
      proofSha256: first.proofSha256,
      checkpointRowSha256: first.checkpointRowSha256,
    });
    expect(readOnly.rowState("q2:1@1")).toMatchObject({
      chargedMicrousd: second.decision.charge!.totalMicrousd,
      cohereChargedMicrousd: second.decision.charge!.cohereMicrousd,
      geminiChargedMicrousd: second.decision.charge!.geminiMicrousd,
      voyageChargedMicrousd: second.decision.charge!.voyageMicrousd,
      proofSha256: second.proofSha256,
      checkpointRowSha256: second.checkpointRowSha256,
    });
    expect(first.proofSha256).not.toBe(second.proofSha256);
    expect(first.checkpointRowSha256).not.toBe(second.checkpointRowSha256);
  });

  it("strictly rejects malformed v4 fields, provider components, and digests without writes", () => {
    const sourcePath = temporaryLedgerPath();
    const ledger = createLedger(sourcePath);
    const reservation = reserveA2Row("approved question", 2.50);
    ledger.reserve("q1:1@1", reservation);
    settleLedgerFromUsage(ledger, "q1:1@1", reservation, null);
    const entries = readFileSync(sourcePath, "utf8").trimEnd().split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const variants: Array<{
      label: string;
      mutate: (copy: Array<Record<string, unknown>>) => void;
      pattern: RegExp;
    }> = [
      {
        label: "extra header field",
        mutate: (copy) => { copy[0].unexpected = true; },
        pattern: /header has malformed fields/u,
      },
      {
        label: "extra reservation field",
        mutate: (copy) => {
          (copy[1].reservation as Record<string, unknown>).unexpected = true;
        },
        pattern: /reserve entry 2 is malformed/u,
      },
      {
        label: "same-total provider component swap",
        mutate: (copy) => {
          copy[2].cohereMicrousd = Number(copy[2].cohereMicrousd) - 1;
          copy[2].geminiMicrousd = Number(copy[2].geminiMicrousd) + 1;
        },
        pattern: /settlement is invalid/u,
      },
      {
        label: "non-canonical proof digest",
        mutate: (copy) => { copy[2].proofSha256 = "A".repeat(64); },
        pattern: /settlement is invalid/u,
      },
      {
        label: "missing checkpoint digest",
        mutate: (copy) => { delete copy[2].checkpointRowSha256; },
        pattern: /settlement entry 3 has malformed fields/u,
      },
    ];

    for (const variant of variants) {
      const path = temporaryLedgerPath();
      const copy = structuredClone(entries);
      variant.mutate(copy);
      const body = `${copy.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
      writeFileSync(path, body, "utf8");
      const before = readFileSync(path);

      expect(
        () => A2SpendLedger.openV4ReadOnly(path, ledgerIdentity()),
        variant.label,
      ).toThrow(variant.pattern);
      expect(readFileSync(path), variant.label).toEqual(before);
    }
  });

  it("keeps PRECHECK and RECOVER returns ahead of external client construction", () => {
    const source = readFileSync(join(process.cwd(), "tests", "a2-rerank-comparison.live.ts"), "utf8");
    const precheck = source.indexOf('if (preflight.mode === "PRECHECK")');
    const recover = source.indexOf('if (preflight.mode === "RECOVER")', precheck);
    const externalClient = source.indexOf("const db = getSupabaseAdmin()");

    expect(precheck).toBeGreaterThan(-1);
    expect(recover).toBeGreaterThan(precheck);
    expect(externalClient).toBeGreaterThan(recover);
    expect(source.slice(precheck, externalClient).match(/return;/gu)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the full reservation when the live planner duration array is malformed", async () => {
    const state = await loadStateModule();
    const exact = oneCallUsage();
    const usage = state.knownUsageForBudget({
      status: "complete",
      arms: {
        current: {
          providerRequests: [{ responseSucceeded: true, billedSearchUnits: 5 }],
        },
        global: {
          providerRequests: [{ responseSucceeded: true, billedSearchUnits: 6 }],
        },
      },
      plannerUsage: {
        attempts: exact.geminiAttempts,
        promptTokens: exact.geminiPromptTokens,
        outputTokens: exact.geminiOutputTokens,
        thoughtsTokens: exact.geminiThoughtsTokens,
        totalTokens: exact.geminiTotalTokens,
        attemptDurationsMs: [Number.NaN, 5],
      },
      plannerCallUsage: exact.geminiCalls,
      embeddingProviderCalls: exact.voyageProviderCalls,
    });
    expect(usage?.geminiAttemptDurationsMs).toBeNull();

    const reservation = reserveA2Row("approved question", 2.50);
    const decision = classifyA2RowAccounting(reservation, usage);
    expect(decision.kind).toBe("ordinary_incomplete");
    if (decision.kind !== "ordinary_incomplete") throw new Error("expected conservative usage");
    expect(decision.incompleteReasons).toContain("gemini_attempt_duration_mismatch");
    expect(decision.charge).toMatchObject({
      totalMicrousd: reservation.totalMicrousd,
      cohereMicrousd: reservation.cohereMicrousd,
      geminiMicrousd: reservation.geminiMicrousd,
      voyageMicrousd: reservation.voyageMicrousd,
      completeUsage: false,
      settlementKind: "entire_row_reservation",
    });
  });

  it("validates cumulative current-arm submissions separately from the unique shared pool", async () => {
    const state = await loadStateModule();

    expect(() => state.assertCompleteRow(completeComparisonRow(), "q001:1@1")).not.toThrow();
    expect(() => state.assertCompleteRow(completeComparisonRow(400, 200, 0), "q001:1@1"))
      .not.toThrow();
    expect(() => state.assertCompleteRow(completeComparisonRow(400, 201), "q001:1@1")).not.toThrow();

    for (let candidateCount = 2; candidateCount <= 400; candidateCount += 1) {
      state.assertCompleteRow(completeComparisonRow(candidateCount), "q001:1@1");
      if (candidateCount > 200) {
        state.assertCompleteRow(
          completeComparisonRow(candidateCount, 201),
          "q001:1@1",
        );
      }
    }

    const inconsistentCurrent = completeComparisonRow();
    (inconsistentCurrent.arms as Record<string, Record<string, unknown>>).current.documentCount = 400;
    expect(() => state.assertCompleteRow(inconsistentCurrent, "q001:1@1"))
      .toThrow(/inconsistent current document accounting/u);

    const incompleteFirstPass = completeComparisonRow();
    const current = (incompleteFirstPass.arms as Record<string, Record<string, unknown>>).current;
    const currentRequests = current.providerRequests as Array<Record<string, unknown>>;
    currentRequests[1].documentCount = 199;
    currentRequests[1].topN = 199;
    current.documentCount = 599;
    expect(() => state.assertCompleteRow(incompleteFirstPass, "q001:1@1"))
      .toThrow(/invalid current Cohere request shape/u);

    const incompleteGlobal = completeComparisonRow();
    const global = (incompleteGlobal.arms as Record<string, Record<string, unknown>>).global;
    const globalRequest = (global.providerRequests as Array<Record<string, unknown>>)[0];
    globalRequest.documentCount = 399;
    global.documentCount = 399;
    expect(() => state.assertCompleteRow(incompleteGlobal, "q001:1@1"))
      .toThrow(/invalid global Cohere request shape/u);

    const truncatedTop = completeComparisonRow();
    const truncatedCurrent = (truncatedTop.arms as Record<string, Record<string, unknown>>).current;
    (truncatedCurrent.top as unknown[]).pop();
    expect(() => state.assertCompleteRow(truncatedTop, "q001:1@1"))
      .toThrow(/invalid current outcome/u);

    const wrongGlobalTopN = completeComparisonRow();
    const wrongGlobal = (wrongGlobalTopN.arms as Record<string, Record<string, unknown>>).global;
    const wrongGlobalRequest = (wrongGlobal.providerRequests as Array<Record<string, unknown>>)[0];
    wrongGlobalRequest.topN = 19;
    expect(() => state.assertCompleteRow(wrongGlobalTopN, "q001:1@1"))
      .toThrow(/invalid global Cohere request shape/u);
  }, 10_000);

  it("recovers an open attempt without an outcome and replays its journal idempotently", async () => {
    const state = await loadStateModule();
    const preflight = recoveryPreflight(temporaryRunDirectory());
    const manifest = state.buildRunManifest(preflight);
    state.completeInterruptedInitialization(preflight, manifest);
    const ledger = A2SpendLedger.open(
      join(preflight.runDirectory, "spend-ledger.jsonl"),
      recoveryLedgerIdentity(preflight, manifest.manifestSha256),
    );
    const planned = state.plannedRows(preflight)[0];
    const key = `${planned.logicalRowKey}@1`;
    const reservation = reserveA2Row(
      planned.question.question,
      preflight.usdPerThousandSearchUnits,
    );
    ledger.reserve(key, reservation);
    const rows: Array<Record<string, unknown>> = [];
    const checkpointPath = join(preflight.runDirectory, "comparison-report.json");

    state.recoverInterruptedRun(
      preflight,
      manifest.manifestSha256,
      ledger,
      checkpointPath,
      rows,
      [
        "prior-paid-run.lock.recovered-first",
        "restart-paid-run.lock.recovered-first",
      ],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("interrupted");
    expect(ledger.rowState(key)?.chargedMicrousd).toBe(reservation.totalMicrousd);
    const completePath = join(preflight.runDirectory, "recovery", "0001-complete.json");
    const firstComplete = JSON.parse(readFileSync(completePath, "utf8"));
    expect(firstComplete.recoveredAttempts).toEqual([key]);
    expect(firstComplete.recoveredLockArchives).toEqual([
      "prior-paid-run.lock.recovered-first",
      "restart-paid-run.lock.recovered-first",
    ]);

    rmSync(completePath);
    state.recoverInterruptedRun(
      preflight,
      manifest.manifestSha256,
      ledger,
      checkpointPath,
      rows,
      "paid-run.lock.recovered-replay",
    );
    const replayedComplete = JSON.parse(readFileSync(completePath, "utf8"));
    expect(replayedComplete.recoveredAttempts).toEqual([key]);
    expect(replayedComplete.settledThisInvocation).toEqual([]);
    expect(ledger.committedMicrousd()).toBe(reservation.totalMicrousd);

    state.recoverInterruptedRun(
      preflight,
      manifest.manifestSha256,
      ledger,
      checkpointPath,
      rows,
      "paid-run.lock.recovered-next",
    );
    expect(existsSync(join(preflight.runDirectory, "recovery", "0002-complete.json"))).toBe(true);
  }, 15_000);

  it("settles a matching durable failed outcome during recovery", async () => {
    const state = await loadStateModule();
    const preflight = recoveryPreflight(temporaryRunDirectory());
    const manifest = state.buildRunManifest(preflight);
    state.completeInterruptedInitialization(preflight, manifest);
    const ledger = A2SpendLedger.open(
      join(preflight.runDirectory, "spend-ledger.jsonl"),
      recoveryLedgerIdentity(preflight, manifest.manifestSha256),
    );
    const planned = state.plannedRows(preflight)[0];
    const key = `${planned.logicalRowKey}@1`;
    const reservation = reserveA2Row(
      planned.question.question,
      preflight.usdPerThousandSearchUnits,
    );
    ledger.reserve(key, reservation);
    const failedRow: Record<string, unknown> = {
      status: "failed",
      logicalRowKey: planned.logicalRowKey,
      attempt: 1,
      attemptKey: key,
      questionId: planned.question.id,
      category: planned.question.category,
      question: planned.question.question,
      supplemental: planned.question.id.startsWith("supplemental-"),
      repeat: planned.repeat,
      armExecutionOrder: planned.armExecutionOrder,
      models: manifest.models,
      kind: "search_failed",
      failure: { name: "SyntheticFailure" },
      providerUsageComplete: false,
      budgetReservationUsd: microusdToUsd(reservation.totalMicrousd),
    };
    const rows: Array<Record<string, unknown>> = [
      bindA2CheckpointRowAccounting(failedRow, reservation, null).row,
    ];
    const checkpointPath = join(preflight.runDirectory, "comparison-report.json");
    writeJsonDurably(
      checkpointPath,
      state.checkpointDocument(preflight, manifest.manifestSha256, ledger, rows),
    );

    state.recoverInterruptedRun(
      preflight,
      manifest.manifestSha256,
      ledger,
      checkpointPath,
      rows,
      "paid-run.lock.recovered-outcome",
    );
    expect(ledger.rowState(key)?.chargedMicrousd).toBe(reservation.totalMicrousd);
  }, 15_000);

  it("refuses a durable definition violation before creating a recovery journal", async () => {
    const state = await loadStateModule();
    const preflight = recoveryPreflight(temporaryRunDirectory());
    const manifest = state.buildRunManifest(preflight);
    state.completeInterruptedInitialization(preflight, manifest);
    const ledger = A2SpendLedger.open(
      join(preflight.runDirectory, "spend-ledger.jsonl"),
      recoveryLedgerIdentity(preflight, manifest.manifestSha256),
    );
    const planned = state.plannedRows(preflight)[0];
    const key = `${planned.logicalRowKey}@1`;
    const reservation = reserveA2Row(
      planned.question.question,
      preflight.usdPerThousandSearchUnits,
    );
    ledger.reserve(key, reservation);
    const violationUsage = oneCallUsage({
      geminiTotalTokens: 1_501,
      geminiCalls: [{
        ...oneCallUsage().geminiCalls[0],
        toolUsePromptTokens: 1,
        totalTokens: 1_501,
      }],
    });
    const violationRow: Record<string, unknown> = {
      status: "failed",
      logicalRowKey: planned.logicalRowKey,
      attempt: 1,
      attemptKey: key,
      questionId: planned.question.id,
      category: planned.question.category,
      question: planned.question.question,
      supplemental: planned.question.id.startsWith("supplemental-"),
      repeat: planned.repeat,
      armExecutionOrder: planned.armExecutionOrder,
      models: manifest.models,
      kind: "accounting_definition_violation",
      providerUsageComplete: false,
      budgetReservationUsd: microusdToUsd(reservation.totalMicrousd),
    };
    const rows = [
      bindA2CheckpointRowAccounting(violationRow, reservation, violationUsage).row,
    ];
    const checkpointPath = join(preflight.runDirectory, "comparison-report.json");
    writeJsonDurably(
      checkpointPath,
      state.checkpointDocument(preflight, manifest.manifestSha256, ledger, rows),
    );
    const recoveryDirectory = join(preflight.runDirectory, "recovery");

    expect(() => state.assertLedgerBijection(preflight, rows, ledger, true))
      .toThrow(A2AccountingDefinitionViolation);
    expect(() => state.recoverInterruptedRun(
      preflight,
      manifest.manifestSha256,
      ledger,
      checkpointPath,
      rows,
      "paid-run.lock.recovered-violation",
    )).toThrow(A2AccountingDefinitionViolation);
    expect(ledger.openRowKeys()).toEqual([key]);
    expect(existsSync(recoveryDirectory)).toBe(false);
  }, 15_000);

  it("rejects a settled ledger attempt that has no durable outcome", async () => {
    const state = await loadStateModule();
    const preflight = recoveryPreflight(temporaryRunDirectory());
    const manifest = state.buildRunManifest(preflight);
    state.completeInterruptedInitialization(preflight, manifest);
    const ledger = A2SpendLedger.open(
      join(preflight.runDirectory, "spend-ledger.jsonl"),
      recoveryLedgerIdentity(preflight, manifest.manifestSha256),
    );
    const planned = state.plannedRows(preflight)[0];
    const key = `${planned.logicalRowKey}@1`;
    const reservation = reserveA2Row(
      planned.question.question,
      preflight.usdPerThousandSearchUnits,
    );
    ledger.reserve(key, reservation);
    settleLedgerFromUsage(ledger, key, reservation, null);

    expect(() => state.recoverInterruptedRun(
      preflight,
      manifest.manifestSha256,
      ledger,
      join(preflight.runDirectory, "comparison-report.json"),
      [],
      "paid-run.lock.recovered-invalid",
    )).toThrow(/settled ledger attempt has no durable outcome/u);
  }, 15_000);

  it("rejects a settlement larger than the money reserved before the call", () => {
    const path = temporaryLedgerPath();
    const ledger = createLedger(path);
    ledger.reserve("q1:1@1", syntheticReservation(10));
    appendFileSync(path, `${JSON.stringify({
      type: "settle",
      rowKey: "q1:1@1",
      chargedMicrousd: 11,
      cohereMicrousd: 11,
      geminiMicrousd: 0,
      voyageMicrousd: 0,
      completeUsage: true,
      settlementKind: "usage_proved",
      proofSha256: "d".repeat(64),
      checkpointRowSha256: "e".repeat(64),
    })}\n`, "utf8");

    expect(() => A2SpendLedger.open(path, ledgerIdentity()))
      .toThrow(/settlement is invalid/u);
  });
});
