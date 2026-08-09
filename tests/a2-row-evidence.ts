/**
 * Evaluator-only validation for a completed A2 comparison row.
 *
 * This module is deliberately independent of the paid runner so frozen
 * evidence can be checked without importing provider clients or constructing
 * any external service. It validates the row's structural result, rebuilds
 * provider usage from the row, verifies the durable accounting binding, and
 * can cross-bind that result to a read-only ledger settlement.
 */
import { COHERE_RERANK_MODEL } from "@/app/lib/08-cohere-rerank";
import {
  RERANK_ARMS,
  RERANK_BATCH_SIZE,
  RERANK_COMPARISON_TOP_N,
  RERANK_FINAL_POOL,
} from "@/app/lib/search-v2/rerank";
import {
  classifyA2RowAccounting,
  reserveA2Row,
  sha256CanonicalA2Json,
  verifyA2CheckpointRowAccounting,
  type A2CheckpointAccountingVerification,
  type A2GeminiCallProof,
  type A2KnownRowUsage,
  type A2RowBudgetReservation,
  type A2RowCharge,
} from "@/tests/a2-spend-budget";

type JsonRecord = Record<string, unknown>;

const A2_APPROVED_COHERE_USD_PER_THOUSAND_SEARCH_UNITS = 2.50;

const RESERVATION_FIELDS = [
  "totalMicrousd",
  "cohereMicrousd",
  "geminiMicrousd",
  "voyageMicrousd",
  "cohereSearchUnitsCeiling",
  "cohereUsdPerThousandSearchUnits",
  "questionUtf8Bytes",
] as const satisfies readonly (keyof A2RowBudgetReservation)[];

const CHARGE_FIELDS = [
  "totalMicrousd",
  "cohereMicrousd",
  "geminiMicrousd",
  "voyageMicrousd",
  "completeUsage",
  "settlementKind",
] as const satisfies readonly (keyof A2RowCharge)[];

export interface A2CompleteRowSettlementEvidence {
  rowKey: string;
  reservation: A2RowBudgetReservation;
  chargedMicrousd: number;
  cohereMicrousd: number;
  geminiMicrousd: number;
  voyageMicrousd: number;
  completeUsage: boolean;
  settlementKind: A2RowCharge["settlementKind"];
  proofSha256: string;
  checkpointRowSha256: string;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function fail(message: string, key: string): never {
  throw new Error(`A2 complete row ${message}: ${key}`);
}

function expectedReservation(row: JsonRecord, key: string): A2RowBudgetReservation {
  if (typeof row.question !== "string") fail("has no reservation input", key);
  return reserveA2Row(
    row.question,
    A2_APPROVED_COHERE_USD_PER_THOUSAND_SEARCH_UNITS,
  );
}

function sameReservation(left: unknown, right: A2RowBudgetReservation): boolean {
  return isRecord(left) && RESERVATION_FIELDS.every((field) => left[field] === right[field]);
}

function usageFromCompleteRow(
  row: JsonRecord,
  key: string,
  voyageProviderCalls: 0 | 1,
): A2KnownRowUsage {
  const arms = row.arms as Record<string, JsonRecord>;
  const requests = [RERANK_ARMS.current, RERANK_ARMS.global].flatMap((arm) => {
    const providerRequests = arms[arm].providerRequests;
    if (!Array.isArray(providerRequests)) fail("has no provider request evidence", key);
    return providerRequests as JsonRecord[];
  });
  const billedSearchUnits = requests.map((request) => {
    const units = finiteCount(request.billedSearchUnits);
    if (request.responseSucceeded !== true || units === null) {
      fail("has incomplete Cohere usage evidence", key);
    }
    return units;
  });
  const planner = row.plannerUsage as JsonRecord;
  if (!Array.isArray(row.plannerCallUsage)) {
    fail("has no planner-call proof", key);
  }
  const rawAttemptDurations = planner.attemptDurationsMs;
  const attemptDurationsMs = Array.isArray(rawAttemptDurations)
    && rawAttemptDurations.every((duration) => typeof duration === "number"
      && Number.isFinite(duration) && duration >= 0)
    ? [...rawAttemptDurations] as number[]
    : null;
  return {
    cohereSearchUnits: sum(billedSearchUnits),
    cohereSearchUnitsLowerBound: sum(billedSearchUnits),
    cohereUsageComplete: true,
    geminiAttempts: finiteCount(planner.attempts),
    geminiPromptTokens: finiteCount(planner.promptTokens),
    geminiOutputTokens: finiteCount(planner.outputTokens),
    geminiThoughtsTokens: finiteCount(planner.thoughtsTokens),
    geminiTotalTokens: finiteCount(planner.totalTokens),
    geminiAttemptDurationsMs: attemptDurationsMs,
    geminiCalls: row.plannerCallUsage as A2GeminiCallProof[],
    voyageProviderCalls,
  };
}

function assertArmStructure(
  arms: Record<string, JsonRecord>,
  timing: JsonRecord,
  candidateCount: number,
  arm: string,
  key: string,
): void {
  const outcome = arms[arm];
  const duration = timing[arm];
  const requests = outcome?.providerRequests;
  if (!outcome || outcome.reranked !== true || outcome.degradedReason !== null
    || !Array.isArray(outcome.top)
    || outcome.top.length !== Math.min(RERANK_COMPARISON_TOP_N, candidateCount)
    || outcome.arm !== arm
    || outcome.model !== COHERE_RERANK_MODEL
    || outcome.topN !== RERANK_COMPARISON_TOP_N
    || typeof outcome.documentCount !== "number"
    || !Number.isSafeInteger(outcome.documentCount) || outcome.documentCount < 2
    || typeof outcome.durationMs !== "number"
    || !Number.isFinite(outcome.durationMs) || outcome.durationMs < 0
    || typeof duration !== "number" || !Number.isFinite(duration) || duration < 0
    || typeof outcome.providerCallCount !== "number"
    || !Number.isSafeInteger(outcome.providerCallCount)
    || outcome.providerCallCount < 1
    || !Array.isArray(requests)
    || requests.length !== outcome.providerCallCount
    || requests.some((request) => {
      if (!isRecord(request)) return true;
      return request.responseSucceeded !== true
        || finiteCount(request.billedSearchUnits) === null
        || typeof request.documentCount !== "number"
        || !Number.isSafeInteger(request.documentCount) || request.documentCount < 2
        || typeof request.topN !== "number"
        || !Number.isSafeInteger(request.topN) || request.topN < 1;
    })) {
    fail(`has an invalid ${arm} outcome`, key);
  }

  const requestRecords = requests as JsonRecord[];
  const documentCounts = requestRecords.map((request) => Number(request.documentCount));
  const requestTopNs = requestRecords.map((request) => Number(request.topN));
  if (sum(documentCounts) !== outcome.documentCount) {
    fail(`has inconsistent ${arm} document accounting`, key);
  }
  if (arm === RERANK_ARMS.global) {
    if (documentCounts.length !== 1
      || documentCounts[0] !== candidateCount
      || requestTopNs[0] !== Math.min(RERANK_COMPARISON_TOP_N, candidateCount)) {
      fail("has an invalid global Cohere request shape", key);
    }
    return;
  }

  const expectedFirstPassCounts: number[] = [];
  for (let offset = 0; offset < candidateCount; offset += RERANK_BATCH_SIZE) {
    const count = Math.min(RERANK_BATCH_SIZE, candidateCount - offset);
    // The low-level helper handles a singleton locally without a provider call.
    if (count > 1) expectedFirstPassCounts.push(count);
  }
  const hasFinalPass = candidateCount > RERANK_BATCH_SIZE;
  const expectedRequestCount = expectedFirstPassCounts.length + (hasFinalPass ? 1 : 0);
  const firstPassIsExact = expectedFirstPassCounts.every((count, index) =>
    documentCounts[index] === count && requestTopNs[index] === count);
  const finalCount = hasFinalPass ? documentCounts.at(-1) : null;
  const finalTopN = hasFinalPass ? requestTopNs.at(-1) : null;
  if (documentCounts.length !== expectedRequestCount || !firstPassIsExact
    || (hasFinalPass && (
      (finalCount !== RERANK_FINAL_POOL && finalCount !== RERANK_FINAL_POOL + 1)
      || finalTopN !== finalCount
    ))) {
    fail("has an invalid current Cohere request shape", key);
  }
}

function verifyCompleteRowAccounting(
  row: JsonRecord,
  key: string,
  reservation: A2RowBudgetReservation,
  voyageProviderCalls: 0 | 1,
): A2CheckpointAccountingVerification {
  const verification = verifyA2CheckpointRowAccounting(row, reservation);
  if (verification.decision.kind !== "usage_proved") {
    fail("lacks proved provider accounting", key);
  }
  const derivedDecision = classifyA2RowAccounting(
    reservation,
    usageFromCompleteRow(row, key, voyageProviderCalls),
  );
  if (derivedDecision.kind !== "usage_proved"
    || sha256CanonicalA2Json(derivedDecision.proof) !== verification.proofSha256) {
    fail("provider row and accounting proof differ", key);
  }
  return verification;
}

/**
 * Validates one completed evaluator row without reading a ledger or filesystem.
 * A full embedding-cache hit is valid and is represented by exactly zero
 * Voyage provider calls; a cache miss is exactly one call.
 */
export function assertA2CompleteRowEvidence(row: JsonRecord, key: string): void {
  if (row.status !== "complete" || row.attemptKey !== key) {
    fail("identity or status differs", key);
  }
  if (typeof row.poolSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.poolSha256)) {
    fail("has no valid pool hash", key);
  }
  const timing = row.searchToTop20Ms;
  const order = Array.isArray(row.armExecutionOrder) ? row.armExecutionOrder : [];
  const arms = row.arms;
  const candidateCount = finiteCount(row.candidateCount);
  const sharedPreparationMs = row.sharedPreparationMs;
  const pipelineTotalMs = row.comparisonPipelineTotalMs;
  if (!isRecord(timing) || !isRecord(arms)
    || candidateCount === null || candidateCount < 2 || candidateCount > 400
    || order.length !== 2 || new Set(order).size !== 2
    || !order.includes(RERANK_ARMS.current) || !order.includes(RERANK_ARMS.global)
    || typeof sharedPreparationMs !== "number" || !Number.isFinite(sharedPreparationMs)
    || sharedPreparationMs < 0
    || typeof pipelineTotalMs !== "number" || !Number.isFinite(pipelineTotalMs)
    || pipelineTotalMs < 0) {
    fail("is missing comparison structure", key);
  }
  assertArmStructure(arms as Record<string, JsonRecord>, timing, candidateCount, RERANK_ARMS.current, key);
  assertArmStructure(arms as Record<string, JsonRecord>, timing, candidateCount, RERANK_ARMS.global, key);

  if (row.pipelineDegraded !== false || row.providerUsageComplete !== true
    || row.invalidArm !== false) {
    fail("is degraded or lacks complete provider usage", key);
  }
  if (!isRecord(row.plannerUsage)) fail("has invalid planner timing", key);
  const planner = row.plannerUsage;
  const attemptDurations = planner.attemptDurationsMs;
  const plannerAttempts = finiteCount(planner.attempts);
  if (plannerAttempts === null || plannerAttempts < 1 || plannerAttempts > 2
    || !Array.isArray(attemptDurations) || attemptDurations.length !== plannerAttempts
    || attemptDurations.some((value) => typeof value !== "number"
      || !Number.isFinite(value) || value < 0)
    || typeof planner.durationMs !== "number" || !Number.isFinite(planner.durationMs)
    || planner.durationMs < 0) {
    fail("has invalid planner timing", key);
  }
  const voyageProviderCalls = finiteCount(row.embeddingProviderCalls);
  if (voyageProviderCalls === null || voyageProviderCalls > 1) {
    fail("has an invalid Voyage provider-call count", key);
  }
  const reservation = expectedReservation(row, key);
  verifyCompleteRowAccounting(
    row,
    key,
    reservation,
    voyageProviderCalls as 0 | 1,
  );
}

/** Cross-binds a structurally valid row to its immutable v4 ledger evidence. */
export function assertA2CompleteRowSettlementEvidence(
  row: JsonRecord,
  key: string,
  settlement: A2CompleteRowSettlementEvidence,
): void {
  assertA2CompleteRowEvidence(row, key);
  if (!isRecord(settlement) || settlement.rowKey !== key) {
    fail("and ledger settlement identities differ", key);
  }
  const reservation = expectedReservation(row, key);
  if (!sameReservation(settlement.reservation, reservation)) {
    fail("and ledger reservations differ", key);
  }
  const voyageProviderCalls = row.embeddingProviderCalls as 0 | 1;
  const verification = verifyCompleteRowAccounting(
    row,
    key,
    reservation,
    voyageProviderCalls,
  );
  if (verification.decision.kind !== "usage_proved") {
    fail("lacks a chargeable accounting decision", key);
  }
  const expectedCharge = verification.decision.charge;
  const settlementCharge: A2RowCharge = {
    totalMicrousd: settlement.chargedMicrousd,
    cohereMicrousd: settlement.cohereMicrousd,
    geminiMicrousd: settlement.geminiMicrousd,
    voyageMicrousd: settlement.voyageMicrousd,
    completeUsage: settlement.completeUsage,
    settlementKind: settlement.settlementKind,
  };
  if (!CHARGE_FIELDS.every((field) => settlementCharge[field] === expectedCharge[field])) {
    fail("and ledger charges differ", key);
  }
  if (settlement.proofSha256 !== verification.proofSha256
    || settlement.checkpointRowSha256 !== verification.checkpointRowSha256) {
    fail("and ledger accounting digests differ", key);
  }
}
