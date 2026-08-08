import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export const A2_SPEND_LEDGER_SCHEMA_VERSION = "a2-spend-ledger-v4";
export const A2_LEGACY_SPEND_LEDGER_SCHEMA_VERSION = "a2-spend-ledger-v3";
export const A2_ROW_ACCOUNTING_SCHEMA_VERSION = "a2-row-accounting-v1";
export const A2_ROW_USAGE_PROOF_SCHEMA_VERSION = "a2-row-usage-proof-v1";

const MICRO_USD_PER_USD = 1_000_000;
const TOKENS_PER_COHERE_BILLING_CHUNK = 500;

/**
 * These ceilings make the comparison fail closed before a paid row starts.
 * They are deliberately much larger than the observed query-planner and
 * embedding payloads. The ledger later releases only spend proved by complete
 * provider usage metadata; an unknown response keeps its full reservation.
 */
export const A2_BUDGET_DEFINITION = Object.freeze({
  geminiModel: "gemini-2.5-flash",
  geminiInputUsdPerMillionTokens: 0.30,
  geminiOutputUsdPerMillionTokens: 2.50,
  geminiMaxAttemptsPerRow: 2,
  geminiMaxInputTokensPerAttempt: 1_048_576,
  geminiMaxOutputTokensPerAttempt: 1_600,
  voyageModel: "voyage-context-4",
  voyageUsdPerMillionTokensCeiling: 0.18,
  // The contextual-embeddings endpoint permits at most 120K tokens in one
  // request. Reserve that full provider limit: `input_type: "query"` adds a
  // server-side instruction to every input, so raw client bytes alone are not
  // a complete billing ceiling.
  voyageRequestTokenCeiling: 120_000,
  cohereModel: "rerank-v4.0-pro",
  cohereMaxTokensPerDocument: 4_096,
  cohereSearchUnitDocumentLimit: 100,
  cohereRequestDocumentCeilings: [200, 200, 201, 400] as const,
  cohereTokensPerBillingChunk: TOKENS_PER_COHERE_BILLING_CHUNK,
  // Rerank v4 documents use four reserved tokens. Keeping them out of each
  // 500-token billing chunk is conservative even if billing excludes them.
  cohereReservedTokensPerBillingChunk: 4,
});

export interface A2RowBudgetReservation {
  totalMicrousd: number;
  cohereMicrousd: number;
  geminiMicrousd: number;
  voyageMicrousd: number;
  cohereSearchUnitsCeiling: number;
  cohereUsdPerThousandSearchUnits: number;
  questionUtf8Bytes: number;
}

export interface A2KnownRowUsage {
  /** Exact provider total, present only when every expected response is known. */
  cohereSearchUnits: number | null;
  /** Sum of every known successful response, even when another is missing. */
  cohereSearchUnitsLowerBound: number | null;
  cohereUsageComplete: boolean;
  geminiAttempts: number | null;
  geminiPromptTokens: number | null;
  geminiOutputTokens: number | null;
  geminiThoughtsTokens: number | null;
  geminiTotalTokens: number | null;
  geminiAttemptDurationsMs: number[] | null;
  geminiCalls: A2GeminiCallProof[];
  voyageProviderCalls: number | null;
}

/**
 * Evaluator-private accounting returned once for each attempted planner call.
 * It deliberately contains no query, response body, model text, request id,
 * corpus identity, or provider response identifier.
 */
export interface A2GeminiCallProof {
  attempt: number | null;
  responseReceived: boolean;
  promptTokens: number | null;
  candidateTokens: number | null;
  thoughtsTokens: number | null;
  toolUsePromptTokens: number | null;
  totalTokens: number | null;
}

export type A2AccountingViolationCode =
  | "cohere_search_units_ceiling_exceeded"
  | "gemini_call_count_exceeded"
  | "gemini_output_ceiling_exceeded"
  | "gemini_prompt_ceiling_exceeded"
  | "gemini_provider_charge_ceiling_exceeded"
  | "gemini_total_ceiling_exceeded"
  | "gemini_tool_use_nonzero"
  | "voyage_call_count_exceeded";

export type A2AccountingIncompleteReason =
  | "cohere_usage_incomplete"
  | "gemini_aggregate_incomplete"
  | "gemini_attempt_count_mismatch"
  | "gemini_attempt_duration_mismatch"
  | "gemini_call_metadata_incomplete"
  | "gemini_call_order_mismatch"
  | "gemini_response_missing"
  | "gemini_token_arithmetic_mismatch"
  | "gemini_usage_aggregate_mismatch"
  | "usage_unavailable"
  | "voyage_usage_incomplete";

export interface A2RowUsageProof {
  schemaVersion: typeof A2_ROW_USAGE_PROOF_SCHEMA_VERSION;
  cohereSearchUnits: number | null;
  cohereSearchUnitsLowerBound: number | null;
  cohereUsageComplete: boolean;
  gemini: {
    attempts: number | null;
    promptTokens: number | null;
    candidateTokens: number | null;
    thoughtsTokens: number | null;
    totalTokens: number | null;
    attemptDurationsMs: number[] | null;
    calls: A2GeminiCallProof[];
  };
  voyageProviderCalls: number | null;
  validationIssues: A2AccountingIncompleteReason[];
}

export interface A2RowCharge {
  totalMicrousd: number;
  cohereMicrousd: number;
  geminiMicrousd: number;
  voyageMicrousd: number;
  completeUsage: boolean;
  settlementKind: "usage_proved" | "entire_row_reservation";
}

export type A2AccountingDecision =
  | {
    kind: "usage_proved";
    proof: A2RowUsageProof;
    charge: A2RowCharge;
    violationCodes: [];
    incompleteReasons: [];
  }
  | {
    kind: "ordinary_incomplete";
    proof: A2RowUsageProof;
    charge: A2RowCharge;
    violationCodes: [];
    incompleteReasons: A2AccountingIncompleteReason[];
  }
  | {
    kind: "definition_violation";
    proof: A2RowUsageProof;
    charge: null;
    violationCodes: A2AccountingViolationCode[];
    incompleteReasons: A2AccountingIncompleteReason[];
  };

export interface A2CheckpointAccounting {
  schemaVersion: typeof A2_ROW_ACCOUNTING_SCHEMA_VERSION;
  reservation: A2RowBudgetReservation;
  kind: A2AccountingDecision["kind"];
  violationCodes: A2AccountingViolationCode[];
  incompleteReasons: A2AccountingIncompleteReason[];
  proof: A2RowUsageProof;
  proofSha256: string;
  checkpointRowSha256: string;
}

export interface A2CheckpointAccountingVerification {
  row: Record<string, unknown>;
  reservation: Readonly<A2RowBudgetReservation>;
  decision: A2AccountingDecision;
  proofSha256: string;
  checkpointRowSha256: string;
}

const A2_DURABLY_VERIFIED_CHECKPOINT = Symbol("a2-durably-verified-checkpoint");

/** Opaque proof that the final checkpoint path was reread and verified. */
export interface A2VerifiedCheckpointAccounting extends A2CheckpointAccountingVerification {
  readonly checkpointPath: string;
  readonly attemptKey: string;
  readonly [A2_DURABLY_VERIFIED_CHECKPOINT]: true;
}

export interface A2SettlementBinding {
  proofSha256: string;
  checkpointRowSha256: string;
}

export class A2AccountingDefinitionViolation extends Error {
  constructor(readonly violationCodes: A2AccountingViolationCode[]) {
    super(`A2 accounting-definition violation: ${violationCodes.join(", ")}`);
    this.name = "A2AccountingDefinitionViolation";
  }
}

export interface A2RunLockMetadata {
  schemaVersion: "a2-run-lock-v2";
  runId: string;
  definitionSha256: string;
  lockId: string;
  pid: number;
  hostname: string;
  startedAt: string;
}

interface LegacyLedgerHeader {
  type: "header";
  schemaVersion: typeof A2_LEGACY_SPEND_LEDGER_SCHEMA_VERSION;
  runId: string;
  definitionSha256: string;
  manifestSha256: string;
  maxMicrousd: number;
}

interface LedgerHeader {
  type: "header";
  schemaVersion: typeof A2_SPEND_LEDGER_SCHEMA_VERSION;
  runId: string;
  definitionSha256: string;
  manifestSha256: string;
  carryManifestSha256: string;
  maxMicrousd: number;
  priorCommittedMicrousd: number;
  lifetimeMaxMicrousd: number;
}

interface LegacyLedgerReserve {
  type: "reserve";
  rowKey: string;
  reservedMicrousd: number;
}

interface LedgerReserve {
  type: "reserve";
  rowKey: string;
  reservation: A2RowBudgetReservation;
}

interface LegacyLedgerSettle {
  type: "settle";
  rowKey: string;
  chargedMicrousd: number;
  completeUsage: boolean;
}

interface LedgerSettle {
  type: "settle";
  rowKey: string;
  chargedMicrousd: number;
  cohereMicrousd: number;
  geminiMicrousd: number;
  voyageMicrousd: number;
  completeUsage: boolean;
  settlementKind: A2RowCharge["settlementKind"];
  proofSha256: string;
  checkpointRowSha256: string;
}

type LegacyLedgerEntry = LegacyLedgerHeader | LegacyLedgerReserve | LegacyLedgerSettle;
type LedgerEntry = LedgerHeader | LedgerReserve | LedgerSettle;
type AnyLedgerEntry = LegacyLedgerEntry | LedgerEntry;

interface LedgerRowState {
  reservedMicrousd: number;
  cohereReservedMicrousd: number | null;
  geminiReservedMicrousd: number | null;
  voyageReservedMicrousd: number | null;
  cohereSearchUnitsCeiling: number | null;
  cohereUsdPerThousandSearchUnits: number | null;
  questionUtf8Bytes: number | null;
  chargedMicrousd: number | null;
  cohereChargedMicrousd: number | null;
  geminiChargedMicrousd: number | null;
  voyageChargedMicrousd: number | null;
  completeUsage: boolean | null;
  settlementKind: A2RowCharge["settlementKind"] | null;
  proofSha256: string | null;
  checkpointRowSha256: string | null;
}

function assertSafeMicrousd(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

export function usdToMicrousdCeiling(usd: number): number {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("USD value must be finite and non-negative");
  const value = Math.ceil(usd * MICRO_USD_PER_USD);
  assertSafeMicrousd(value, "micro-USD value");
  return value;
}

export function microusdToUsd(microusd: number): number {
  assertSafeMicrousd(microusd, "micro-USD value");
  return microusd / MICRO_USD_PER_USD;
}

function pricedMicrousd(tokens: number, usdPerMillionTokens: number): number {
  if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error("token count is invalid");
  return usdToMicrousdCeiling(tokens * usdPerMillionTokens / 1_000_000);
}

export function reserveA2Row(
  question: string,
  cohereUsdPerThousandSearchUnits: number,
): A2RowBudgetReservation {
  if (!Number.isFinite(cohereUsdPerThousandSearchUnits) || cohereUsdPerThousandSearchUnits < 0) {
    throw new Error("Cohere search-unit rate is invalid");
  }
  const questionUtf8Bytes = Buffer.byteLength(question, "utf8");
  // Cohere bills each query plus up-to-100 documents as one search unit while
  // query-document pairs above 500 tokens are split into additional billable
  // chunks. The query is repeated in every chunk. UTF-8 bytes are a safe token
  // ceiling, so reserve document capacity after subtracting the whole query
  // and v4's four reserved tokens from every 500-token chunk.
  const documentTokensPerBillingChunk = TOKENS_PER_COHERE_BILLING_CHUNK
    - questionUtf8Bytes
    - A2_BUDGET_DEFINITION.cohereReservedTokensPerBillingChunk;
  if (documentTokensPerBillingChunk <= 0) {
    throw new Error("A2 question is too long for the conservative Cohere billing ceiling");
  }
  const chunksPerDocument = Math.ceil(
    A2_BUDGET_DEFINITION.cohereMaxTokensPerDocument / documentTokensPerBillingChunk,
  );
  const cohereSearchUnitsCeiling = A2_BUDGET_DEFINITION.cohereRequestDocumentCeilings
    .reduce((total, documentCount) => total + Math.ceil(
      documentCount * chunksPerDocument
        / A2_BUDGET_DEFINITION.cohereSearchUnitDocumentLimit,
    ), 0);
  const cohereMicrousd = usdToMicrousdCeiling(
    cohereSearchUnitsCeiling * cohereUsdPerThousandSearchUnits / 1_000,
  );
  const geminiMicrousd = pricedMicrousd(
    A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow
      * A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt,
    A2_BUDGET_DEFINITION.geminiInputUsdPerMillionTokens,
  ) + pricedMicrousd(
    A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow
      * A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt,
    A2_BUDGET_DEFINITION.geminiOutputUsdPerMillionTokens,
  );
  const voyageMicrousd = pricedMicrousd(
    A2_BUDGET_DEFINITION.voyageRequestTokenCeiling,
    A2_BUDGET_DEFINITION.voyageUsdPerMillionTokensCeiling,
  );
  return {
    totalMicrousd: cohereMicrousd + geminiMicrousd + voyageMicrousd,
    cohereMicrousd,
    geminiMicrousd,
    voyageMicrousd,
    cohereSearchUnitsCeiling,
    cohereUsdPerThousandSearchUnits,
    questionUtf8Bytes,
  };
}

function isKnownCount(value: unknown, minimum = 0): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= minimum;
}

function normalizedCount(value: unknown): number | null {
  return isKnownCount(value) ? value : null;
}

function uniqueSorted<T extends string>(values: T[]): T[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

const A2_RESERVATION_FIELDS = [
  "cohereMicrousd",
  "cohereSearchUnitsCeiling",
  "cohereUsdPerThousandSearchUnits",
  "geminiMicrousd",
  "questionUtf8Bytes",
  "totalMicrousd",
  "voyageMicrousd",
] as const;

function cloneA2RowBudgetReservation(value: unknown): A2RowBudgetReservation {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || JSON.stringify(Object.keys(value as Record<string, unknown>).sort())
      !== JSON.stringify([...A2_RESERVATION_FIELDS].sort())) {
    throw new Error("A2 row reservation binding is malformed");
  }
  const reservation = value as A2RowBudgetReservation;
  for (const [label, component] of Object.entries({
    total: reservation.totalMicrousd,
    cohere: reservation.cohereMicrousd,
    gemini: reservation.geminiMicrousd,
    voyage: reservation.voyageMicrousd,
  })) {
    assertSafeMicrousd(component, `A2 ${label} row reservation`);
  }
  if (reservation.totalMicrousd === 0
    || reservation.totalMicrousd !== reservation.cohereMicrousd
      + reservation.geminiMicrousd + reservation.voyageMicrousd
    || !isKnownCount(reservation.cohereSearchUnitsCeiling)
    || !Number.isFinite(reservation.cohereUsdPerThousandSearchUnits)
    || reservation.cohereUsdPerThousandSearchUnits < 0
    || !isKnownCount(reservation.questionUtf8Bytes)) {
    throw new Error("A2 row reservation binding is malformed");
  }
  return {
    totalMicrousd: reservation.totalMicrousd,
    cohereMicrousd: reservation.cohereMicrousd,
    geminiMicrousd: reservation.geminiMicrousd,
    voyageMicrousd: reservation.voyageMicrousd,
    cohereSearchUnitsCeiling: reservation.cohereSearchUnitsCeiling,
    cohereUsdPerThousandSearchUnits: reservation.cohereUsdPerThousandSearchUnits,
    questionUtf8Bytes: reservation.questionUtf8Bytes,
  };
}

function immutableA2RowBudgetReservation(
  value: unknown,
): Readonly<A2RowBudgetReservation> {
  return Object.freeze(cloneA2RowBudgetReservation(value));
}

function sameA2RowBudgetReservation(
  left: Readonly<A2RowBudgetReservation>,
  right: Readonly<A2RowBudgetReservation>,
): boolean {
  return A2_RESERVATION_FIELDS.every((field) => left[field] === right[field]);
}

function entireRowReservationCharge(reservation: A2RowBudgetReservation): A2RowCharge {
  return {
    totalMicrousd: reservation.totalMicrousd,
    cohereMicrousd: reservation.cohereMicrousd,
    geminiMicrousd: reservation.geminiMicrousd,
    voyageMicrousd: reservation.voyageMicrousd,
    completeUsage: false,
    settlementKind: "entire_row_reservation",
  };
}

function buildA2RowUsageProof(usage: A2KnownRowUsage | null): A2RowUsageProof {
  if (usage === null) {
    return {
      schemaVersion: A2_ROW_USAGE_PROOF_SCHEMA_VERSION,
      cohereSearchUnits: null,
      cohereSearchUnitsLowerBound: 0,
      cohereUsageComplete: false,
      gemini: {
        attempts: null,
        promptTokens: null,
        candidateTokens: null,
        thoughtsTokens: null,
        totalTokens: null,
        attemptDurationsMs: null,
        calls: [],
      },
      voyageProviderCalls: null,
      validationIssues: ["usage_unavailable"],
    };
  }

  const validationIssues: A2AccountingIncompleteReason[] = [];
  const rawCalls = Array.isArray(usage.geminiCalls) ? usage.geminiCalls : [];
  const calls = rawCalls.map((raw): A2GeminiCallProof => {
    const attempt = normalizedCount(raw?.attempt);
    const promptTokens = normalizedCount(raw?.promptTokens);
    const candidateTokens = normalizedCount(raw?.candidateTokens);
    const totalTokens = normalizedCount(raw?.totalTokens);
    const thoughtsTokens = raw?.thoughtsTokens === null
      ? null
      : normalizedCount(raw?.thoughtsTokens);
    const toolUsePromptTokens = raw?.toolUsePromptTokens === null
      ? null
      : normalizedCount(raw?.toolUsePromptTokens);
    if ((raw?.attempt !== null && attempt === null)
      || (raw?.promptTokens !== null && promptTokens === null)
      || (raw?.candidateTokens !== null && candidateTokens === null)
      || (raw?.thoughtsTokens !== null && thoughtsTokens === null)
      || (raw?.toolUsePromptTokens !== null && toolUsePromptTokens === null)
      || (raw?.totalTokens !== null && totalTokens === null)
      || typeof raw?.responseReceived !== "boolean") {
      validationIssues.push("gemini_call_metadata_incomplete");
    }
    return {
      attempt,
      responseReceived: raw?.responseReceived === true,
      promptTokens,
      candidateTokens,
      thoughtsTokens,
      toolUsePromptTokens,
      totalTokens,
    };
  });
  const rawDurations = usage.geminiAttemptDurationsMs;
  const attemptDurationsMs = Array.isArray(rawDurations)
    && rawDurations.every((value) => typeof value === "number"
      && Number.isFinite(value) && value >= 0)
    ? [...rawDurations]
    : null;
  if (rawDurations !== null && attemptDurationsMs === null) {
    validationIssues.push("gemini_attempt_duration_mismatch");
  }
  return {
    schemaVersion: A2_ROW_USAGE_PROOF_SCHEMA_VERSION,
    cohereSearchUnits: normalizedCount(usage.cohereSearchUnits),
    cohereSearchUnitsLowerBound: normalizedCount(usage.cohereSearchUnitsLowerBound),
    cohereUsageComplete: usage.cohereUsageComplete === true,
    gemini: {
      attempts: normalizedCount(usage.geminiAttempts),
      promptTokens: normalizedCount(usage.geminiPromptTokens),
      candidateTokens: normalizedCount(usage.geminiOutputTokens),
      thoughtsTokens: normalizedCount(usage.geminiThoughtsTokens),
      totalTokens: normalizedCount(usage.geminiTotalTokens),
      attemptDurationsMs,
      calls,
    },
    voyageProviderCalls: normalizedCount(usage.voyageProviderCalls),
    validationIssues: uniqueSorted(validationIssues),
  };
}

function assertA2RowUsageProof(proof: A2RowUsageProof): void {
  const allowedIncompleteReasons = new Set<A2AccountingIncompleteReason>([
    "cohere_usage_incomplete",
    "gemini_aggregate_incomplete",
    "gemini_attempt_count_mismatch",
    "gemini_attempt_duration_mismatch",
    "gemini_call_metadata_incomplete",
    "gemini_call_order_mismatch",
    "gemini_response_missing",
    "gemini_token_arithmetic_mismatch",
    "gemini_usage_aggregate_mismatch",
    "usage_unavailable",
    "voyage_usage_incomplete",
  ]);
  if (!proof || proof.schemaVersion !== A2_ROW_USAGE_PROOF_SCHEMA_VERSION
    || !Array.isArray(proof.validationIssues)
    || proof.validationIssues.some((reason) => !allowedIncompleteReasons.has(reason))
    || JSON.stringify(proof.validationIssues) !== JSON.stringify(uniqueSorted(proof.validationIssues))
    || !proof.gemini || !Array.isArray(proof.gemini.calls)
    || (proof.cohereSearchUnits !== null && !isKnownCount(proof.cohereSearchUnits))
    || (proof.cohereSearchUnitsLowerBound !== null
      && !isKnownCount(proof.cohereSearchUnitsLowerBound))
    || typeof proof.cohereUsageComplete !== "boolean"
    || (proof.voyageProviderCalls !== null && !isKnownCount(proof.voyageProviderCalls))
    || (proof.gemini.attempts !== null && !isKnownCount(proof.gemini.attempts))
    || (proof.gemini.promptTokens !== null && !isKnownCount(proof.gemini.promptTokens))
    || (proof.gemini.candidateTokens !== null && !isKnownCount(proof.gemini.candidateTokens))
    || (proof.gemini.thoughtsTokens !== null && !isKnownCount(proof.gemini.thoughtsTokens))
    || (proof.gemini.totalTokens !== null && !isKnownCount(proof.gemini.totalTokens))
    || (proof.gemini.attemptDurationsMs !== null
      && (!Array.isArray(proof.gemini.attemptDurationsMs)
        || proof.gemini.attemptDurationsMs.some((duration) =>
          typeof duration !== "number" || !Number.isFinite(duration) || duration < 0)))) {
    throw new Error("A2 checkpoint usage proof is malformed");
  }
  for (const call of proof.gemini.calls) {
    if (!call || (call.attempt !== null && !isKnownCount(call.attempt, 1))
      || typeof call.responseReceived !== "boolean"
      || (call.promptTokens !== null && !isKnownCount(call.promptTokens))
      || (call.candidateTokens !== null && !isKnownCount(call.candidateTokens))
      || (call.thoughtsTokens !== null && !isKnownCount(call.thoughtsTokens))
      || (call.toolUsePromptTokens !== null && !isKnownCount(call.toolUsePromptTokens))
      || (call.totalTokens !== null && !isKnownCount(call.totalTokens))) {
      throw new Error("A2 checkpoint planner-call proof is malformed");
    }
  }
}

function decisionFromA2RowUsageProof(
  reservation: A2RowBudgetReservation,
  proof: A2RowUsageProof,
): A2AccountingDecision {
  assertA2RowUsageProof(proof);
  const violations: A2AccountingViolationCode[] = [];
  const incomplete = [...proof.validationIssues];
  const gemini = proof.gemini;

  const cohereKnownLowerBound = Math.max(
    proof.cohereSearchUnits ?? 0,
    proof.cohereSearchUnitsLowerBound ?? 0,
  );
  if (cohereKnownLowerBound > reservation.cohereSearchUnitsCeiling) {
    violations.push("cohere_search_units_ceiling_exceeded");
  }
  if (proof.voyageProviderCalls !== null && proof.voyageProviderCalls > 1) {
    violations.push("voyage_call_count_exceeded");
  }
  if ((gemini.attempts !== null && gemini.attempts > A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow)
    || gemini.calls.length > A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow
    || gemini.calls.some((call) => call.attempt !== null
      && call.attempt > A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow)) {
    violations.push("gemini_call_count_exceeded");
  }
  const maxPromptPerCall = A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt;
  const maxOutputPerCall = A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt;
  for (const call of gemini.calls) {
    if (call.toolUsePromptTokens !== null && call.toolUsePromptTokens > 0) {
      violations.push("gemini_tool_use_nonzero");
    }
    if (call.promptTokens !== null && call.promptTokens > maxPromptPerCall) {
      violations.push("gemini_prompt_ceiling_exceeded");
    }
    if (call.candidateTokens !== null || call.thoughtsTokens !== null
      || call.toolUsePromptTokens !== null) {
      // A missing component cannot hide a known lower-bound breach. For
      // example, thoughts=2000 is already outside the 1600-token ceiling even
      // when candidate metadata is absent.
      const outputTokens = (call.candidateTokens ?? 0)
        + (call.thoughtsTokens ?? 0)
        + (call.toolUsePromptTokens ?? 0);
      if (outputTokens > maxOutputPerCall) {
        violations.push("gemini_output_ceiling_exceeded");
      }
    }
    if (call.totalTokens !== null) {
      if (call.totalTokens > maxPromptPerCall + maxOutputPerCall) {
        violations.push("gemini_total_ceiling_exceeded");
      }
      if (call.promptTokens !== null && call.totalTokens >= call.promptTokens
        && call.totalTokens - call.promptTokens > maxOutputPerCall) {
        violations.push("gemini_output_ceiling_exceeded");
      }
      if (call.promptTokens === null && call.candidateTokens !== null) {
        const knownOutputTokens = call.candidateTokens
          + (call.thoughtsTokens ?? 0) + (call.toolUsePromptTokens ?? 0);
        if (call.totalTokens >= knownOutputTokens
          && call.totalTokens - knownOutputTokens > maxPromptPerCall) {
          violations.push("gemini_prompt_ceiling_exceeded");
        }
      }
    }
  }

  // Aggregate metadata can prove a breach even when the ordered call proof is
  // incomplete. Use a one-call ceiling only when the aggregate count is known
  // and no observed call contradicts it; otherwise retain the absolute
  // two-call ceiling to avoid turning inconsistent metadata into a false
  // per-call conclusion.
  const aggregateAttemptCeiling = gemini.attempts !== null
    && gemini.attempts >= 1
    && gemini.attempts <= A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow
    && gemini.calls.length <= gemini.attempts
    ? gemini.attempts
    : A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow;
  const aggregatePromptCeiling = aggregateAttemptCeiling * maxPromptPerCall;
  const aggregateOutputCeiling = aggregateAttemptCeiling * maxOutputPerCall;
  if (gemini.promptTokens !== null && gemini.promptTokens > aggregatePromptCeiling) {
    violations.push("gemini_prompt_ceiling_exceeded");
  }
  const aggregateOutputLowerBound = (gemini.candidateTokens ?? 0)
    + (gemini.thoughtsTokens ?? 0);
  if ((gemini.candidateTokens !== null || gemini.thoughtsTokens !== null)
    && aggregateOutputLowerBound > aggregateOutputCeiling) {
    violations.push("gemini_output_ceiling_exceeded");
  }
  if (gemini.totalTokens !== null) {
    if (gemini.totalTokens > aggregatePromptCeiling + aggregateOutputCeiling) {
      violations.push("gemini_total_ceiling_exceeded");
    }
    if (gemini.promptTokens !== null && gemini.totalTokens >= gemini.promptTokens
      && gemini.totalTokens - gemini.promptTokens > aggregateOutputCeiling) {
      violations.push("gemini_output_ceiling_exceeded");
    }
  }
  if (gemini.promptTokens !== null || gemini.candidateTokens !== null
    || gemini.thoughtsTokens !== null) {
    const promptChargeLowerBound = Math.ceil(
      (gemini.promptTokens ?? 0) * A2_BUDGET_DEFINITION.geminiInputUsdPerMillionTokens,
    );
    const outputChargeLowerBound = Math.ceil(
      aggregateOutputLowerBound * A2_BUDGET_DEFINITION.geminiOutputUsdPerMillionTokens,
    );
    if (!Number.isSafeInteger(promptChargeLowerBound)
      || !Number.isSafeInteger(outputChargeLowerBound)
      || promptChargeLowerBound + outputChargeLowerBound > reservation.geminiMicrousd) {
      violations.push("gemini_provider_charge_ceiling_exceeded");
    }
  }

  if (!proof.cohereUsageComplete || proof.cohereSearchUnits === null
    || proof.cohereSearchUnitsLowerBound === null
    || proof.cohereSearchUnits !== proof.cohereSearchUnitsLowerBound) {
    incomplete.push("cohere_usage_incomplete");
  }
  if (proof.voyageProviderCalls === null) incomplete.push("voyage_usage_incomplete");
  if (gemini.attempts === null || gemini.promptTokens === null
    || gemini.candidateTokens === null || gemini.thoughtsTokens === null
    || gemini.totalTokens === null || gemini.promptTokens < 1
    || gemini.candidateTokens < 1 || gemini.totalTokens < 1) {
    incomplete.push("gemini_aggregate_incomplete");
  }
  if (gemini.attempts === null || gemini.attempts < 1
    || gemini.attempts > A2_BUDGET_DEFINITION.geminiMaxAttemptsPerRow
    || gemini.calls.length !== gemini.attempts) {
    incomplete.push("gemini_attempt_count_mismatch");
  }
  if (gemini.attemptDurationsMs === null || gemini.attempts === null
    || gemini.attemptDurationsMs.length !== gemini.attempts) {
    incomplete.push("gemini_attempt_duration_mismatch");
  }
  if (gemini.calls.some((call, index) => call.attempt !== index + 1)) {
    incomplete.push("gemini_call_order_mismatch");
  }
  if (gemini.calls.some((call) => !call.responseReceived)) {
    incomplete.push("gemini_response_missing");
  }
  if (gemini.calls.some((call) => call.promptTokens === null || call.promptTokens < 1
    || call.candidateTokens === null || call.candidateTokens < 1
    || call.totalTokens === null || call.totalTokens < 1)) {
    incomplete.push("gemini_call_metadata_incomplete");
  }
  if (gemini.calls.some((call) => call.promptTokens !== null
    && call.candidateTokens !== null && call.totalTokens !== null
    && call.totalTokens !== call.promptTokens + call.candidateTokens
      + (call.thoughtsTokens ?? 0) + (call.toolUsePromptTokens ?? 0))) {
    incomplete.push("gemini_token_arithmetic_mismatch");
  }
  if (gemini.promptTokens !== null && gemini.candidateTokens !== null
    && gemini.thoughtsTokens !== null && gemini.totalTokens !== null) {
    const promptSum = gemini.calls.reduce((total, call) => total + (call.promptTokens ?? 0), 0);
    const candidateSum = gemini.calls.reduce((total, call) => total + (call.candidateTokens ?? 0), 0);
    const thoughtsSum = gemini.calls.reduce((total, call) => total + (call.thoughtsTokens ?? 0), 0);
    const totalSum = gemini.calls.reduce((total, call) => total + (call.totalTokens ?? 0), 0);
    if (promptSum !== gemini.promptTokens || candidateSum !== gemini.candidateTokens
      || thoughtsSum !== gemini.thoughtsTokens || totalSum !== gemini.totalTokens) {
      incomplete.push("gemini_usage_aggregate_mismatch");
    }
  }

  const violationCodes = uniqueSorted(violations);
  const incompleteReasons = uniqueSorted(incomplete);
  if (violationCodes.length > 0) {
    return {
      kind: "definition_violation",
      proof,
      charge: null,
      violationCodes,
      incompleteReasons,
    };
  }
  if (incompleteReasons.length > 0) {
    return {
      kind: "ordinary_incomplete",
      proof,
      charge: entireRowReservationCharge(reservation),
      violationCodes: [],
      incompleteReasons,
    };
  }

  const cohereMicrousd = usdToMicrousdCeiling(
    proof.cohereSearchUnits! * reservation.cohereUsdPerThousandSearchUnits / 1_000,
  );
  const geminiMicrousd = pricedMicrousd(
    gemini.promptTokens!,
    A2_BUDGET_DEFINITION.geminiInputUsdPerMillionTokens,
  ) + pricedMicrousd(
    gemini.candidateTokens! + gemini.thoughtsTokens!,
    A2_BUDGET_DEFINITION.geminiOutputUsdPerMillionTokens,
  );
  const voyageMicrousd = proof.voyageProviderCalls === 0 ? 0 : reservation.voyageMicrousd;
  if (geminiMicrousd > reservation.geminiMicrousd) {
    return {
      kind: "definition_violation",
      proof,
      charge: null,
      violationCodes: ["gemini_provider_charge_ceiling_exceeded"],
      incompleteReasons: [],
    };
  }
  if (cohereMicrousd > reservation.cohereMicrousd) {
    return {
      kind: "definition_violation",
      proof,
      charge: null,
      violationCodes: ["cohere_search_units_ceiling_exceeded"],
      incompleteReasons: [],
    };
  }
  const totalMicrousd = cohereMicrousd + geminiMicrousd + voyageMicrousd;
  if (totalMicrousd > reservation.totalMicrousd) {
    throw new Error("A2 provider usage exceeded its pre-call reservation");
  }
  return {
    kind: "usage_proved",
    proof,
    charge: {
      totalMicrousd,
      cohereMicrousd,
      geminiMicrousd,
      voyageMicrousd,
      completeUsage: true,
      settlementKind: "usage_proved",
    },
    violationCodes: [],
    incompleteReasons: [],
  };
}

export function classifyA2RowAccounting(
  reservation: A2RowBudgetReservation,
  usage: A2KnownRowUsage | null,
): A2AccountingDecision {
  return decisionFromA2RowUsageProof(reservation, buildA2RowUsageProof(usage));
}

export function chargeA2Row(
  reservation: A2RowBudgetReservation,
  usage: A2KnownRowUsage | null,
): A2RowCharge {
  const decision = classifyA2RowAccounting(reservation, usage);
  if (decision.kind === "definition_violation") {
    throw new A2AccountingDefinitionViolation(decision.violationCodes);
  }
  return decision.charge;
}

function canonicalA2Json(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("A2 canonical JSON value is undefined");
  const persisted = JSON.parse(serialized) as unknown;
  const stable = (item: unknown): string => {
    if (item === null || typeof item === "boolean" || typeof item === "number"
      || typeof item === "string") {
      return JSON.stringify(item);
    }
    if (Array.isArray(item)) return `[${item.map(stable).join(",")}]`;
    if (typeof item !== "object") throw new Error("A2 canonical JSON contains an unsupported value");
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
  };
  return stable(persisted);
}

export function sha256CanonicalA2Json(value: unknown): string {
  return createHash("sha256").update(canonicalA2Json(value)).digest("hex");
}

function checkpointRowDigest(row: Record<string, unknown>): string {
  const accounting = row.accounting as Record<string, unknown> | undefined;
  if (!accounting) throw new Error("A2 checkpoint row has no accounting binding");
  const accountingWithoutSelf = { ...accounting };
  delete accountingWithoutSelf.checkpointRowSha256;
  return sha256CanonicalA2Json({ ...row, accounting: accountingWithoutSelf });
}

export function bindA2CheckpointRowAccounting(
  row: Record<string, unknown>,
  reservation: A2RowBudgetReservation,
  usage: A2KnownRowUsage | null,
): { row: Record<string, unknown>; decision: A2AccountingDecision } {
  if (Object.hasOwn(row, "accounting")) {
    throw new Error("A2 checkpoint row already has an accounting binding");
  }
  const boundReservation = cloneA2RowBudgetReservation(reservation);
  const decision = classifyA2RowAccounting(boundReservation, usage);
  const proofSha256 = sha256CanonicalA2Json(decision.proof);
  const withoutRowDigest: Record<string, unknown> = {
    ...row,
    accounting: {
      schemaVersion: A2_ROW_ACCOUNTING_SCHEMA_VERSION,
      reservation: boundReservation,
      kind: decision.kind,
      violationCodes: decision.violationCodes,
      incompleteReasons: decision.incompleteReasons,
      proof: decision.proof,
      proofSha256,
    },
  };
  const checkpointRowSha256 = checkpointRowDigest(withoutRowDigest);
  return {
    row: {
      ...withoutRowDigest,
      accounting: {
        ...(withoutRowDigest.accounting as Record<string, unknown>),
        checkpointRowSha256,
      },
    },
    decision,
  };
}

function sameStringArray(left: unknown, right: string[]): boolean {
  return Array.isArray(left)
    && left.every((value) => typeof value === "string")
    && JSON.stringify(left) === JSON.stringify(right);
}

export function verifyA2CheckpointRowAccounting(
  row: Record<string, unknown>,
  reservation: A2RowBudgetReservation,
): A2CheckpointAccountingVerification {
  const accounting = row.accounting as A2CheckpointAccounting | undefined;
  if (!accounting || accounting.schemaVersion !== A2_ROW_ACCOUNTING_SCHEMA_VERSION
    || !/^[0-9a-f]{64}$/u.test(accounting.proofSha256 ?? "")
    || !/^[0-9a-f]{64}$/u.test(accounting.checkpointRowSha256 ?? "")) {
    throw new Error("A2 checkpoint row accounting binding is malformed");
  }
  let boundReservation: A2RowBudgetReservation;
  try {
    boundReservation = cloneA2RowBudgetReservation(accounting.reservation);
  } catch {
    throw new Error("A2 checkpoint row accounting reservation is malformed");
  }
  const expectedReservation = cloneA2RowBudgetReservation(reservation);
  assertA2RowUsageProof(accounting.proof);
  const proofSha256 = sha256CanonicalA2Json(accounting.proof);
  const checkpointRowSha256 = checkpointRowDigest(row);
  if (proofSha256 !== accounting.proofSha256
    || checkpointRowSha256 !== accounting.checkpointRowSha256) {
    throw new Error("A2 checkpoint row accounting digest differs from its durable proof");
  }
  if (!sameA2RowBudgetReservation(boundReservation, expectedReservation)) {
    throw new Error("A2 checkpoint row accounting reservation differs from the expected reservation");
  }
  const decision = decisionFromA2RowUsageProof(expectedReservation, accounting.proof);
  if (accounting.kind !== decision.kind
    || !sameStringArray(accounting.violationCodes, decision.violationCodes)
    || !sameStringArray(accounting.incompleteReasons, decision.incompleteReasons)) {
    throw new Error("A2 checkpoint row accounting decision differs from its proof");
  }
  return {
    row,
    reservation: immutableA2RowBudgetReservation(expectedReservation),
    decision,
    proofSha256,
    checkpointRowSha256,
  };
}

export function assertA2AutomaticRecoveryAllowed(
  verification: A2CheckpointAccountingVerification,
): asserts verification is A2CheckpointAccountingVerification & {
  decision: Exclude<A2AccountingDecision, { kind: "definition_violation" }>;
} {
  if (verification.decision.kind === "definition_violation") {
    throw new A2AccountingDefinitionViolation(verification.decision.violationCodes);
  }
}

export function readVerifiedA2CheckpointRowAccounting(
  checkpointPath: string,
  attemptKey: string,
  reservation: A2RowBudgetReservation,
): A2VerifiedCheckpointAccounting {
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, unknown>;
  const history = checkpoint.attemptHistory;
  if (!Array.isArray(history)) throw new Error("A2 checkpoint has no attempt history");
  const matches = history.filter((candidate) => candidate
    && typeof candidate === "object"
    && (candidate as Record<string, unknown>).attemptKey === attemptKey);
  if (matches.length !== 1) {
    throw new Error(`A2 checkpoint must contain exactly one bound row for ${attemptKey}`);
  }
  const verification = verifyA2CheckpointRowAccounting(
    matches[0] as Record<string, unknown>,
    reservation,
  );
  return Object.freeze({
    ...verification,
    checkpointPath,
    attemptKey,
    [A2_DURABLY_VERIFIED_CHECKPOINT]: true as const,
  });
}

export function writeAndVerifyA2CheckpointBeforeSettlement(
  checkpointPath: string,
  checkpoint: unknown,
  attemptKey: string,
  reservation: A2RowBudgetReservation,
  exclusive = false,
): A2VerifiedCheckpointAccounting {
  writeJsonDurably(checkpointPath, checkpoint, exclusive);
  return readVerifiedA2CheckpointRowAccounting(checkpointPath, attemptKey, reservation);
}

export class A2RunLock {
  private released = false;

  private constructor(
    readonly path: string,
    private readonly descriptor: number,
    readonly recovered: boolean,
    readonly recoveredArchivePath: string | null,
  ) {}

  static acquire(
    path: string,
    input: {
      runId: string;
      definitionSha256: string;
      mode: "run" | "recover";
      staleLockApproval?: string;
    },
  ): A2RunLock {
    let recovered = false;
    let recoveredArchivePath: string | null = null;
    let descriptor: number;
    try {
      descriptor = openSync(path, "wx");
    } catch (error) {
      if (!existsSync(path)) throw error;
      const raw = readFileSync(path, "utf8");
      const requiredApproval = staleLockApproval(raw);
      let prior: A2RunLockMetadata;
      try {
        prior = JSON.parse(raw) as A2RunLockMetadata;
      } catch {
        throw new Error("A2 run lock is malformed; manual audit is required");
      }
      if (prior.schemaVersion !== "a2-run-lock-v2"
        || prior.runId !== input.runId
        || prior.definitionSha256 !== input.definitionSha256
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(prior.lockId)
        || !Number.isSafeInteger(prior.pid)
        || prior.pid <= 0
        || typeof prior.hostname !== "string"
        || typeof prior.startedAt !== "string"
        || !Number.isFinite(Date.parse(prior.startedAt))) {
        throw new Error("A2 run lock does not match this run; manual audit is required");
      }
      if (input.mode !== "recover" || input.staleLockApproval !== requiredApproval) {
        throw new Error(
          `A2 run lock already exists; use recovery-only mode with ${requiredApproval}`,
        );
      }
      if (prior.hostname !== hostname()) {
        throw new Error("A2 run lock belongs to another host; automatic recovery is refused");
      }
      if (processIsAlive(prior.pid)) {
        throw new Error("A2 run lock owner is still alive; recovery is refused");
      }
      recoveredArchivePath = `${path}.recovered-${prior.lockId}`;
      if (existsSync(recoveredArchivePath)) {
        throw new Error("A2 recovered-lock archive already exists; manual audit is required");
      }
      renameSync(path, recoveredArchivePath);
      recovered = true;
      try {
        descriptor = openSync(path, "wx");
      } catch (recoveryError) {
        try { renameSync(recoveredArchivePath, path); } catch { /* preserve both clues */ }
        throw recoveryError;
      }
    }
    try {
      const metadata: A2RunLockMetadata = {
        schemaVersion: "a2-run-lock-v2",
        runId: input.runId,
        definitionSha256: input.definitionSha256,
        lockId: randomUUID(),
        pid: process.pid,
        hostname: hostname(),
        startedAt: new Date().toISOString(),
      };
      const body = Buffer.from(`${JSON.stringify(metadata)}\n`, "utf8");
      let written = 0;
      while (written < body.length) {
        written += writeSync(descriptor, body, written, body.length - written);
      }
      fsyncSync(descriptor);
      return new A2RunLock(path, descriptor, recovered, recoveredArchivePath);
    } catch (error) {
      closeSync(descriptor);
      try { unlinkSync(path); } catch { /* fail closed on the original error */ }
      if (recoveredArchivePath) {
        try { renameSync(recoveredArchivePath, path); } catch { /* manual audit remains fail closed */ }
      }
      throw error;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
    unlinkSync(this.path);
  }

  retainForRecovery(): void {
    if (this.released) return;
    this.released = true;
    closeSync(this.descriptor);
  }

  restoreRecoveredLock(): void {
    if (this.released) return;
    if (!this.recovered || !this.recoveredArchivePath) {
      throw new Error("A2 cannot restore a lock that was not recovered");
    }
    this.released = true;
    closeSync(this.descriptor);
    unlinkSync(this.path);
    renameSync(this.recoveredArchivePath, this.path);
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

export function staleLockApproval(rawLock: string): string {
  const digest = createHash("sha256").update(rawLock).digest("hex");
  return `I_APPROVE_STALE_LOCK_RECOVERY:${digest}`;
}

export function a2RetryApproval(retryManifest: unknown): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(retryManifest))
    .digest("hex");
  return `I_APPROVE_PAID_A2_RETRY:${digest}`;
}

export function writeJsonDurably(path: string, value: unknown, exclusive = false): void {
  if (exclusive && existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  const body = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
  let descriptor: number | null = null;
  try {
    descriptor = openSync(temporaryPath, "wx");
    let written = 0;
    while (written < body.length) {
      written += writeSync(descriptor, body, written, body.length - written);
    }
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    if (exclusive && existsSync(path)) throw new Error(`Refusing to overwrite ${path}`);
    renameSync(temporaryPath, path);
    // Reopen and parse the target so a successful return proves a complete JSON
    // generation is now visible at the final path.
    JSON.parse(readFileSync(path, "utf8"));
    try {
      const directory = openSync(dirname(path), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch {
      // Windows can reject directory handles. The file itself is already fsynced.
    }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    if (existsSync(temporaryPath)) {
      try { unlinkSync(temporaryPath); } catch { /* retain the original failure */ }
    }
  }
}

function appendDurably(path: string, entry: AnyLedgerEntry, exclusive = false): void {
  const descriptor = openSync(path, exclusive ? "wx" : "a");
  try {
    const body = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
    let written = 0;
    while (written < body.length) {
      written += writeSync(descriptor, body, written, body.length - written);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function parseLedger(path: string): AnyLedgerEntry[] {
  const body = readFileSync(path, "utf8");
  if (!body.endsWith("\n")) throw new Error("A2 spend ledger has a partial final entry");
  return body.split("\n").filter(Boolean).map((line, index) => {
    try {
      return JSON.parse(line) as AnyLedgerEntry;
    } catch {
      throw new Error(`A2 spend ledger entry ${index + 1} is invalid JSON`);
    }
  });
}

export interface A2SpendLedgerIdentity {
  runId: string;
  definitionSha256: string;
  manifestSha256: string;
  carryManifestSha256: string;
  maxMicrousd: number;
  priorCommittedMicrousd: number;
  lifetimeMaxMicrousd: number;
}

export interface A2LegacySpendLedgerIdentity {
  runId: string;
  definitionSha256: string;
  manifestSha256: string;
  maxMicrousd: number;
}

function assertSha256(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase SHA-256`);
}

function assertLedgerIdentity(input: A2SpendLedgerIdentity): void {
  if (!input.runId.trim()) throw new Error("A2 run id must not be empty");
  assertSha256(input.definitionSha256, "A2 definition digest");
  assertSha256(input.manifestSha256, "A2 run-manifest digest");
  assertSha256(input.carryManifestSha256, "A2 carry-manifest digest");
  assertSafeMicrousd(input.maxMicrousd, "A2 continuation maximum spend");
  assertSafeMicrousd(input.priorCommittedMicrousd, "A2 prior committed spend");
  assertSafeMicrousd(input.lifetimeMaxMicrousd, "A2 lifetime maximum spend");
  if (input.maxMicrousd === 0 || input.lifetimeMaxMicrousd === 0
    || input.priorCommittedMicrousd + input.maxMicrousd !== input.lifetimeMaxMicrousd) {
    throw new Error("A2 continuation and prior commitments must exactly equal the lifetime maximum");
  }
}

function reservationSnapshot(reservation: A2RowBudgetReservation): LedgerReserve["reservation"] {
  try {
    return cloneA2RowBudgetReservation(reservation);
  } catch {
    throw new Error("A2 provider reservations do not sum to the row reservation");
  }
}

export class A2SpendLedger {
  private readonly rows = new Map<string, LedgerRowState>();

  private constructor(
    readonly path: string,
    readonly runId: string,
    readonly definitionSha256: string,
    readonly manifestSha256: string,
    readonly maxMicrousd: number,
    readonly carryManifestSha256: string | null,
    readonly priorCommittedMicrousd: number,
    readonly lifetimeMaxMicrousd: number,
    readonly schemaVersion: typeof A2_SPEND_LEDGER_SCHEMA_VERSION
      | typeof A2_LEGACY_SPEND_LEDGER_SCHEMA_VERSION,
    private readonly writable: boolean,
  ) {}

  static create(path: string, input: A2SpendLedgerIdentity): A2SpendLedger {
    if (existsSync(path)) throw new Error("A2 spend ledger already exists");
    assertLedgerIdentity(input);
    const header: LedgerHeader = {
      type: "header",
      schemaVersion: A2_SPEND_LEDGER_SCHEMA_VERSION,
      ...input,
    };
    appendDurably(path, header, true);
    return new A2SpendLedger(
      path,
      input.runId,
      input.definitionSha256,
      input.manifestSha256,
      input.maxMicrousd,
      input.carryManifestSha256,
      input.priorCommittedMicrousd,
      input.lifetimeMaxMicrousd,
      A2_SPEND_LEDGER_SCHEMA_VERSION,
      true,
    );
  }

  static open(path: string, expected: A2SpendLedgerIdentity): A2SpendLedger {
    assertLedgerIdentity(expected);
    const entries = parseLedger(path);
    const header = entries[0];
    if (!header || header.type !== "header"
      || header.schemaVersion !== A2_SPEND_LEDGER_SCHEMA_VERSION
      || header.runId !== expected.runId
      || header.definitionSha256 !== expected.definitionSha256
      || header.manifestSha256 !== expected.manifestSha256
      || header.carryManifestSha256 !== expected.carryManifestSha256
      || header.maxMicrousd !== expected.maxMicrousd
      || header.priorCommittedMicrousd !== expected.priorCommittedMicrousd
      || header.lifetimeMaxMicrousd !== expected.lifetimeMaxMicrousd) {
      throw new Error("A2 spend ledger header differs from this approved continuation");
    }
    const ledger = new A2SpendLedger(
      path,
      header.runId,
      header.definitionSha256,
      header.manifestSha256,
      header.maxMicrousd,
      header.carryManifestSha256,
      header.priorCommittedMicrousd,
      header.lifetimeMaxMicrousd,
      A2_SPEND_LEDGER_SCHEMA_VERSION,
      true,
    );
    for (const entry of entries.slice(1)) ledger.replay(entry as LedgerEntry);
    return ledger;
  }

  static openLegacyReadOnly(
    path: string,
    expected: A2LegacySpendLedgerIdentity,
  ): A2SpendLedger {
    const entries = parseLedger(path);
    const header = entries[0];
    if (!header || header.type !== "header"
      || header.schemaVersion !== A2_LEGACY_SPEND_LEDGER_SCHEMA_VERSION
      || header.runId !== expected.runId
      || header.definitionSha256 !== expected.definitionSha256
      || header.manifestSha256 !== expected.manifestSha256
      || header.maxMicrousd !== expected.maxMicrousd) {
      throw new Error("A2 legacy spend ledger header differs from its pinned evidence");
    }
    assertSafeMicrousd(header.maxMicrousd, "A2 legacy maximum spend");
    const ledger = new A2SpendLedger(
      path,
      header.runId,
      header.definitionSha256,
      header.manifestSha256,
      header.maxMicrousd,
      null,
      0,
      header.maxMicrousd,
      A2_LEGACY_SPEND_LEDGER_SCHEMA_VERSION,
      false,
    );
    for (const entry of entries.slice(1)) ledger.replayLegacy(entry as LegacyLedgerEntry);
    return ledger;
  }

  private assertAttemptKey(rowKey: string): void {
    if (!/^.+:[1-9]\d*@[1-9]\d*$/u.test(rowKey)) {
      throw new Error("A2 spend ledger attempt key is invalid");
    }
  }

  private assertWithinMaximum(): void {
    if (this.committedMicrousd() > this.maxMicrousd
      || this.lifetimeCommittedMicrousd() > this.lifetimeMaxMicrousd) {
      throw new Error("A2 spend ledger exceeds its approved maximum");
    }
  }

  private replayLegacy(entry: LegacyLedgerEntry): void {
    if (entry.type === "header") throw new Error("A2 legacy spend ledger has more than one header");
    this.assertAttemptKey(entry.rowKey);
    if (entry.type === "reserve") {
      assertSafeMicrousd(entry.reservedMicrousd, "A2 legacy row reservation");
      if (entry.reservedMicrousd === 0 || this.rows.has(entry.rowKey)) {
        throw new Error(`A2 legacy spend ledger has a duplicate or empty reservation: ${entry.rowKey}`);
      }
      this.rows.set(entry.rowKey, {
        reservedMicrousd: entry.reservedMicrousd,
        cohereReservedMicrousd: null,
        geminiReservedMicrousd: null,
        voyageReservedMicrousd: null,
        cohereSearchUnitsCeiling: null,
        cohereUsdPerThousandSearchUnits: null,
        questionUtf8Bytes: null,
        chargedMicrousd: null,
        cohereChargedMicrousd: null,
        geminiChargedMicrousd: null,
        voyageChargedMicrousd: null,
        completeUsage: null,
        settlementKind: null,
        proofSha256: null,
        checkpointRowSha256: null,
      });
    } else if (entry.type === "settle") {
      assertSafeMicrousd(entry.chargedMicrousd, "A2 legacy row charge");
      const row = this.rows.get(entry.rowKey);
      if (!row || row.chargedMicrousd !== null || entry.chargedMicrousd > row.reservedMicrousd
        || typeof entry.completeUsage !== "boolean") {
        throw new Error(`A2 legacy spend ledger settlement is invalid: ${entry.rowKey}`);
      }
      row.chargedMicrousd = entry.chargedMicrousd;
      row.completeUsage = entry.completeUsage;
    } else {
      throw new Error("A2 legacy spend ledger has an unknown entry type");
    }
    this.assertWithinMaximum();
  }

  private replay(entry: LedgerEntry): void {
    if (entry.type === "header") throw new Error("A2 spend ledger has more than one header");
    this.assertAttemptKey(entry.rowKey);
    if (entry.type === "reserve") {
      if (this.rows.has(entry.rowKey)) {
        throw new Error(`A2 spend ledger has a duplicate or malformed reservation: ${entry.rowKey}`);
      }
      let reservation: A2RowBudgetReservation;
      try {
        reservation = cloneA2RowBudgetReservation(entry.reservation);
      } catch {
        throw new Error(`A2 spend ledger reservation components are invalid: ${entry.rowKey}`);
      }
      this.rows.set(entry.rowKey, {
        reservedMicrousd: reservation.totalMicrousd,
        cohereReservedMicrousd: reservation.cohereMicrousd,
        geminiReservedMicrousd: reservation.geminiMicrousd,
        voyageReservedMicrousd: reservation.voyageMicrousd,
        cohereSearchUnitsCeiling: reservation.cohereSearchUnitsCeiling,
        cohereUsdPerThousandSearchUnits: reservation.cohereUsdPerThousandSearchUnits,
        questionUtf8Bytes: reservation.questionUtf8Bytes,
        chargedMicrousd: null,
        cohereChargedMicrousd: null,
        geminiChargedMicrousd: null,
        voyageChargedMicrousd: null,
        completeUsage: null,
        settlementKind: null,
        proofSha256: null,
        checkpointRowSha256: null,
      });
    } else if (entry.type === "settle") {
      const row = this.rows.get(entry.rowKey);
      for (const [label, value] of Object.entries({
        total: entry.chargedMicrousd,
        cohere: entry.cohereMicrousd,
        gemini: entry.geminiMicrousd,
        voyage: entry.voyageMicrousd,
      })) {
        assertSafeMicrousd(value, `A2 ${label} row charge`);
      }
      if (!row || row.chargedMicrousd !== null
        || entry.chargedMicrousd !== entry.cohereMicrousd
          + entry.geminiMicrousd + entry.voyageMicrousd
        || entry.chargedMicrousd > row.reservedMicrousd
        || entry.cohereMicrousd > row.cohereReservedMicrousd!
        || entry.geminiMicrousd > row.geminiReservedMicrousd!
        || entry.voyageMicrousd > row.voyageReservedMicrousd!
        || !/^[0-9a-f]{64}$/u.test(entry.proofSha256 ?? "")
        || !/^[0-9a-f]{64}$/u.test(entry.checkpointRowSha256 ?? "")
        || (entry.settlementKind === "usage_proved" && entry.completeUsage !== true)
        || (entry.settlementKind === "entire_row_reservation" && (
          entry.completeUsage !== false
          || entry.chargedMicrousd !== row.reservedMicrousd
          || entry.cohereMicrousd !== row.cohereReservedMicrousd
          || entry.geminiMicrousd !== row.geminiReservedMicrousd
          || entry.voyageMicrousd !== row.voyageReservedMicrousd
        ))
        || (entry.settlementKind !== "usage_proved"
          && entry.settlementKind !== "entire_row_reservation")) {
        throw new Error(`A2 spend ledger settlement is invalid: ${entry.rowKey}`);
      }
      row.chargedMicrousd = entry.chargedMicrousd;
      row.cohereChargedMicrousd = entry.cohereMicrousd;
      row.geminiChargedMicrousd = entry.geminiMicrousd;
      row.voyageChargedMicrousd = entry.voyageMicrousd;
      row.completeUsage = entry.completeUsage;
      row.settlementKind = entry.settlementKind;
      row.proofSha256 = entry.proofSha256;
      row.checkpointRowSha256 = entry.checkpointRowSha256;
    } else {
      throw new Error("A2 spend ledger has an unknown entry type");
    }
    this.assertWithinMaximum();
  }

  reserve(rowKey: string, reservation: A2RowBudgetReservation): void {
    if (!this.writable) throw new Error("A2 legacy spend ledger is strictly read-only");
    this.assertAttemptKey(rowKey);
    const snapshot = reservationSnapshot(reservation);
    if (this.rows.has(rowKey)) throw new Error(`A2 paid row already has a ledger entry: ${rowKey}`);
    if (this.committedMicrousd() + snapshot.totalMicrousd > this.maxMicrousd) {
      throw new Error("A2 stopped before the next paid row because its reservation would exceed the approved maximum");
    }
    const entry: LedgerReserve = { type: "reserve", rowKey, reservation: snapshot };
    appendDurably(this.path, entry);
    this.replay(entry);
  }

  private settle(
    rowKey: string,
    charge: A2RowCharge,
    binding?: A2SettlementBinding,
  ): void {
    if (!this.writable) throw new Error("A2 legacy spend ledger is strictly read-only");
    const row = this.rows.get(rowKey);
    if (!row || row.chargedMicrousd !== null) {
      throw new Error(`A2 paid row cannot be settled: ${rowKey}`);
    }
    if (!binding || !/^[0-9a-f]{64}$/u.test(binding.proofSha256)
      || !/^[0-9a-f]{64}$/u.test(binding.checkpointRowSha256)) {
      throw new Error("A2 v4 settlement requires durable proof and checkpoint-row digests");
    }
    const entry: LedgerSettle = {
      type: "settle",
      rowKey,
      chargedMicrousd: charge.totalMicrousd,
      cohereMicrousd: charge.cohereMicrousd,
      geminiMicrousd: charge.geminiMicrousd,
      voyageMicrousd: charge.voyageMicrousd,
      completeUsage: charge.completeUsage,
      settlementKind: charge.settlementKind,
      proofSha256: binding.proofSha256,
      checkpointRowSha256: binding.checkpointRowSha256,
    };
    // Validate in memory before making the append durable, then replay the same
    // entry after fsync. A failed validation can never leave a bad line behind.
    const probe = new Map(
      [...this.rows.entries()].map(([key, value]) => [key, { ...value }] as const),
    );
    try {
      this.replay(entry);
    } catch (error) {
      this.rows.clear();
      for (const [key, value] of probe) this.rows.set(key, value);
      throw error;
    }
    // Restore the open state while the durable append is made. If the process
    // dies after fsync, reopening the append-only ledger replays the settlement.
    this.rows.clear();
    for (const [key, value] of probe) this.rows.set(key, { ...value });
    appendDurably(this.path, entry);
    this.replay(entry);
  }

  settleVerified(rowKey: string, verification: A2VerifiedCheckpointAccounting): void {
    if (verification[A2_DURABLY_VERIFIED_CHECKPOINT] !== true
      || verification.attemptKey !== rowKey
      || verification.row.attemptKey !== rowKey) {
      throw new Error("A2 verified checkpoint row does not match its ledger attempt");
    }
    const expectedReservation = cloneA2RowBudgetReservation(verification.reservation);
    const ledgerRow = this.rows.get(rowKey);
    if (!ledgerRow
      || ledgerRow.reservedMicrousd !== expectedReservation.totalMicrousd
      || ledgerRow.cohereReservedMicrousd !== expectedReservation.cohereMicrousd
      || ledgerRow.geminiReservedMicrousd !== expectedReservation.geminiMicrousd
      || ledgerRow.voyageReservedMicrousd !== expectedReservation.voyageMicrousd
      || ledgerRow.cohereSearchUnitsCeiling !== expectedReservation.cohereSearchUnitsCeiling
      || ledgerRow.cohereUsdPerThousandSearchUnits
        !== expectedReservation.cohereUsdPerThousandSearchUnits
      || ledgerRow.questionUtf8Bytes !== expectedReservation.questionUtf8Bytes) {
      throw new Error("A2 verified checkpoint reservation differs from its ledger reservation");
    }
    // Reread immediately before the append. A once-valid object cannot settle
    // after its durable checkpoint was deleted or altered.
    const current = readVerifiedA2CheckpointRowAccounting(
      verification.checkpointPath,
      rowKey,
      expectedReservation,
    );
    if (current.proofSha256 !== verification.proofSha256
      || current.checkpointRowSha256 !== verification.checkpointRowSha256) {
      throw new Error("A2 durable checkpoint changed before settlement");
    }
    assertA2AutomaticRecoveryAllowed(current);
    this.settle(rowKey, current.decision.charge, {
      proofSha256: current.proofSha256,
      checkpointRowSha256: current.checkpointRowSha256,
    });
  }

  committedMicrousd(): number {
    return [...this.rows.values()].reduce(
      (total, row) => total + (row.chargedMicrousd ?? row.reservedMicrousd),
      0,
    );
  }

  lifetimeCommittedMicrousd(): number {
    return this.priorCommittedMicrousd + this.committedMicrousd();
  }

  openRowKeys(): string[] {
    return [...this.rows.entries()]
      .filter(([, row]) => row.chargedMicrousd === null)
      .map(([rowKey]) => rowKey);
  }

  rowKeys(): string[] {
    return [...this.rows.keys()];
  }

  hasRow(rowKey: string): boolean {
    return this.rows.has(rowKey);
  }

  rowState(rowKey: string): Readonly<LedgerRowState> | null {
    const row = this.rows.get(rowKey);
    return row ? Object.freeze({ ...row }) : null;
  }

  sha256(): string {
    return createHash("sha256").update(readFileSync(this.path)).digest("hex");
  }
}
