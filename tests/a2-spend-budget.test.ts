import {
  appendFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  A2SpendLedger,
  A2RunLock,
  chargeA2Row,
  microusdToUsd,
  reserveA2Row,
  usdToMicrousdCeiling,
  type A2RowCharge,
} from "@/tests/a2-spend-budget";

const temporaryDirectories: string[] = [];

function temporaryLedgerPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "a2-spend-ledger-"));
  temporaryDirectories.push(directory);
  return join(directory, "spend-ledger.jsonl");
}

function createLedger(path: string, maxUsd = 25): A2SpendLedger {
  return A2SpendLedger.create(path, {
    runId: "a2-budget-test-run",
    definitionSha256: "a".repeat(64),
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

    expect(reservation.cohereSearchUnitsCeiling).toBe(91);
    expect(reservation.cohereMicrousd).toBe(227_500);
    expect(reservation.geminiMicrousd).toBe(637_146);
    expect(reservation.voyageMicrousd).toBe(623);
    expect(reservation.totalMicrousd).toBe(865_269);
    expect(microusdToUsd(reservation.totalMicrousd)).toBeLessThan(1);
  });

  it("reconciles only complete provider usage and keeps Voyage at its byte ceiling", () => {
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
    ledger.reserve("q1:1", 1_000_000);

    expect(() => ledger.reserve("q2:1", 500_001)).toThrow(/approved maximum/u);
    ledger.settle("q1:1", {
      totalMicrousd: 100_000,
      cohereMicrousd: 0,
      geminiMicrousd: 0,
      voyageMicrousd: 0,
      completeUsage: true,
    });
    expect(() => ledger.reserve("q2:1", 500_001)).not.toThrow();
  });

  it("allows all 264 rows when complete usage stays below the approved cap", () => {
    const ledger = createLedger(temporaryLedgerPath());
    for (let index = 0; index < 264; index += 1) {
      const rowKey = `q${String(index + 1).padStart(3, "0")}:1`;
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
    ledger.reserve("q1:1", 865_269);

    const reopened = A2SpendLedger.open(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      maxMicrousd: 25_000_000,
    });
    expect(reopened.committedMicrousd()).toBe(865_269);
    expect(reopened.openRowKeys()).toEqual(["q1:1"]);
    expect(() => reopened.reserve("q1:1", 865_269)).toThrow(/already has/u);
  });

  it("holds one exclusive run lock for the whole evaluator process", () => {
    const path = join(temporaryLedgerPath(), "..", "run.lock");
    const first = A2RunLock.acquire(path);
    expect(() => A2RunLock.acquire(path)).toThrow(/run lock already exists/u);
    first.release();
    const next = A2RunLock.acquire(path);
    next.release();
  });

  it("rejects a partial durable entry instead of guessing after a crash", () => {
    const path = temporaryLedgerPath();
    createLedger(path);
    appendFileSync(path, "{\"type\":\"reserve\"", "utf8");

    expect(() => A2SpendLedger.open(path, {
      runId: "a2-budget-test-run",
      definitionSha256: "a".repeat(64),
      maxMicrousd: 25_000_000,
    })).toThrow(/partial final entry/u);
  });

  it("rejects a settlement larger than the money reserved before the call", () => {
    const ledger = createLedger(temporaryLedgerPath());
    ledger.reserve("q1:1", 10);
    const tooLarge: A2RowCharge = {
      totalMicrousd: 11,
      cohereMicrousd: 11,
      geminiMicrousd: 0,
      voyageMicrousd: 0,
      completeUsage: true,
    };

    expect(() => ledger.settle("q1:1", tooLarge)).toThrow(/exceeds its reservation/u);
  });
});
