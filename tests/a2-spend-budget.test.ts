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
  A2SpendLedger,
  A2RunLock,
  a2RetryApproval,
  chargeA2Row,
  microusdToUsd,
  reserveA2Row,
  staleLockApproval,
  usdToMicrousdCeiling,
  writeJsonDurably,
  type A2RowCharge,
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

function createLedger(path: string, maxUsd = 25): A2SpendLedger {
  return A2SpendLedger.create(path, {
    runId: "a2-budget-test-run",
    definitionSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    maxMicrousd: usdToMicrousdCeiling(maxUsd),
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("A2 hard spend budget", () => {
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
    const charge = chargeA2Row(reservation, {
      cohereSearchUnits: 11,
      geminiAttempts: 1,
      geminiPromptTokens: 1_000,
      geminiOutputTokens: 500,
      geminiThoughtsTokens: 0,
      voyageProviderCalls: 1,
    });

    expect(charge.completeUsage).toBe(true);
    expect(charge.cohereMicrousd).toBe(27_500);
    expect(charge.geminiMicrousd).toBe(1_550);
    expect(charge.voyageMicrousd).toBe(reservation.voyageMicrousd);
    expect(charge.totalMicrousd).toBeLessThan(reservation.totalMicrousd);
  });

  it("retains each provider reservation whose usage is missing", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const charge = chargeA2Row(reservation, {
      cohereSearchUnits: null,
      geminiAttempts: 1,
      geminiPromptTokens: 1_000,
      geminiOutputTokens: 500,
      geminiThoughtsTokens: 0,
      voyageProviderCalls: null,
    });

    expect(charge.completeUsage).toBe(false);
    expect(charge.cohereMicrousd).toBe(reservation.cohereMicrousd);
    expect(charge.voyageMicrousd).toBe(reservation.voyageMicrousd);
  });

  it("retains the full Gemini reservation whenever two attempts ran", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    const charge = chargeA2Row(reservation, {
      cohereSearchUnits: 11,
      geminiAttempts: 2,
      geminiPromptTokens: 1_000,
      geminiOutputTokens: 500,
      geminiThoughtsTokens: 0,
      voyageProviderCalls: 1,
    });

    expect(charge.completeUsage).toBe(false);
    expect(charge.geminiMicrousd).toBe(reservation.geminiMicrousd);
  });

  it("charges the full reservation for a failed or interrupted row", () => {
    const reservation = reserveA2Row("approved question", 2.50);
    expect(chargeA2Row(reservation, null)).toEqual({
      totalMicrousd: reservation.totalMicrousd,
      cohereMicrousd: reservation.cohereMicrousd,
      geminiMicrousd: reservation.geminiMicrousd,
      voyageMicrousd: reservation.voyageMicrousd,
      completeUsage: false,
    });
  });

  it("refuses the next row before its reservation could cross the cap", () => {
    const ledger = createLedger(temporaryLedgerPath(), 1.5);
    ledger.reserve("q1:1@1", 1_000_000);

    expect(() => ledger.reserve("q2:1@1", 500_001)).toThrow(/approved maximum/u);
    ledger.settle("q1:1@1", {
      totalMicrousd: 100_000,
      cohereMicrousd: 0,
      geminiMicrousd: 0,
      voyageMicrousd: 0,
      completeUsage: true,
    });
    expect(() => ledger.reserve("q2:1@1", 500_001)).not.toThrow();
  });

  it("allows all 264 rows when complete usage stays below the approved cap", () => {
    const ledger = createLedger(temporaryLedgerPath());
    for (let index = 0; index < 264; index += 1) {
      const rowKey = `q${String(index + 1).padStart(3, "0")}:1@1`;
      const reservation = reserveA2Row("x".repeat(257), 2.50);
      ledger.reserve(rowKey, reservation.totalMicrousd);
      ledger.settle(rowKey, chargeA2Row(reservation, {
        cohereSearchUnits: 11,
        geminiAttempts: 1,
        geminiPromptTokens: 7_300,
        geminiOutputTokens: 1_600,
        geminiThoughtsTokens: 0,
        voyageProviderCalls: 1,
      }));
    }

    expect(ledger.openRowKeys()).toEqual([]);
    expect(microusdToUsd(ledger.committedMicrousd())).toBeLessThan(25);
  });

  it("keeps an open reservation charged after a crash and blocks duplicate spend", () => {
    const path = temporaryLedgerPath();
    const ledger = createLedger(path);
    ledger.reserve("q1:1@1", 865_269);

    const reopened = A2SpendLedger.open(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      maxMicrousd: 25_000_000,
    });
    expect(reopened.committedMicrousd()).toBe(865_269);
    expect(reopened.openRowKeys()).toEqual(["q1:1@1"]);
    expect(() => reopened.reserve("q1:1@1", 865_269)).toThrow(/already has/u);
  });

  it("retains every historical attempt charge for the same logical row", () => {
    const ledger = createLedger(temporaryLedgerPath());
    ledger.reserve("q1:1@1", 100);
    ledger.settle("q1:1@1", {
      totalMicrousd: 100,
      cohereMicrousd: 100,
      geminiMicrousd: 0,
      voyageMicrousd: 0,
      completeUsage: false,
    });
    ledger.reserve("q1:1@2", 100);
    ledger.settle("q1:1@2", {
      totalMicrousd: 40,
      cohereMicrousd: 40,
      geminiMicrousd: 0,
      voyageMicrousd: 0,
      completeUsage: true,
    });

    expect(ledger.rowKeys()).toEqual(["q1:1@1", "q1:1@2"]);
    expect(ledger.committedMicrousd()).toBe(140);
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

    expect(() => A2SpendLedger.open(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      maxMicrousd: 25_000_000,
    })).toThrow(/partial final entry/u);
  });

  it("rejects a ledger opened under a different run-manifest digest", () => {
    const path = temporaryLedgerPath();
    createLedger(path);

    expect(() => A2SpendLedger.open(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      manifestSha256: "c".repeat(64),
      maxMicrousd: 25_000_000,
    })).toThrow(/header differs/u);
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

  it("recovers an open attempt without an outcome and replays its journal idempotently", async () => {
    const state = await loadStateModule();
    const preflight = recoveryPreflight(temporaryRunDirectory());
    const manifest = state.buildRunManifest(preflight);
    state.completeInterruptedInitialization(preflight, manifest);
    const ledger = A2SpendLedger.open(join(preflight.runDirectory, "spend-ledger.jsonl"), {
      runId: preflight.runId,
      definitionSha256: preflight.definitionSha256,
      manifestSha256: manifest.manifestSha256,
      maxMicrousd: usdToMicrousdCeiling(preflight.maxTotalUsd),
    });
    const planned = state.plannedRows(preflight)[0];
    const key = `${planned.logicalRowKey}@1`;
    const reservation = reserveA2Row(
      planned.question.question,
      preflight.usdPerThousandSearchUnits,
    );
    ledger.reserve(key, reservation.totalMicrousd);
    const rows: Array<Record<string, unknown>> = [];
    const checkpointPath = join(preflight.runDirectory, "comparison-report.json");

    state.recoverInterruptedRun(
      preflight,
      manifest.manifestSha256,
      ledger,
      checkpointPath,
      rows,
      "paid-run.lock.recovered-first",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("interrupted");
    expect(ledger.rowState(key)?.chargedMicrousd).toBe(reservation.totalMicrousd);
    const completePath = join(preflight.runDirectory, "recovery", "0001-complete.json");
    const firstComplete = JSON.parse(readFileSync(completePath, "utf8"));
    expect(firstComplete.recoveredAttempts).toEqual([key]);

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
    const ledger = A2SpendLedger.open(join(preflight.runDirectory, "spend-ledger.jsonl"), {
      runId: preflight.runId,
      definitionSha256: preflight.definitionSha256,
      manifestSha256: manifest.manifestSha256,
      maxMicrousd: usdToMicrousdCeiling(preflight.maxTotalUsd),
    });
    const planned = state.plannedRows(preflight)[0];
    const key = `${planned.logicalRowKey}@1`;
    const reservation = reserveA2Row(
      planned.question.question,
      preflight.usdPerThousandSearchUnits,
    );
    ledger.reserve(key, reservation.totalMicrousd);
    const rows: Array<Record<string, unknown>> = [{
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
    }];
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

  it("rejects a settled ledger attempt that has no durable outcome", async () => {
    const state = await loadStateModule();
    const preflight = recoveryPreflight(temporaryRunDirectory());
    const manifest = state.buildRunManifest(preflight);
    state.completeInterruptedInitialization(preflight, manifest);
    const ledger = A2SpendLedger.open(join(preflight.runDirectory, "spend-ledger.jsonl"), {
      runId: preflight.runId,
      definitionSha256: preflight.definitionSha256,
      manifestSha256: manifest.manifestSha256,
      maxMicrousd: usdToMicrousdCeiling(preflight.maxTotalUsd),
    });
    const planned = state.plannedRows(preflight)[0];
    const key = `${planned.logicalRowKey}@1`;
    const reservation = reserveA2Row(
      planned.question.question,
      preflight.usdPerThousandSearchUnits,
    );
    ledger.reserve(key, reservation.totalMicrousd);
    ledger.settle(key, chargeA2Row(reservation, null));

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
    const ledger = createLedger(temporaryLedgerPath());
    ledger.reserve("q1:1@1", 10);
    const tooLarge: A2RowCharge = {
      totalMicrousd: 11,
      cohereMicrousd: 11,
      geminiMicrousd: 0,
      voyageMicrousd: 0,
      completeUsage: true,
    };

    expect(() => ledger.settle("q1:1@1", tooLarge)).toThrow(/exceeds its reservation/u);
  });
});
