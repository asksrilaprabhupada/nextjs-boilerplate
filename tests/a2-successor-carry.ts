import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  assertA2CompleteRowSettlementEvidence,
  type A2CompleteRowSettlementEvidence,
} from "@/tests/a2-row-evidence";
import {
  A2SpendLedger,
  reserveA2Row,
  usdToMicrousdCeiling,
  verifyA2CheckpointRowAccounting,
  writeJsonDurably,
  type A2RowBudgetReservation,
  type A2SpendLedgerRowState,
} from "@/tests/a2-spend-budget";
import {
  A2_ORIGINAL_EVIDENCE as FROZEN_A2_ORIGINAL_EVIDENCE,
  A2_STOPPED_EVIDENCE as FROZEN_A2_STOPPED_EVIDENCE,
  a2QualityCarryPath,
  assertA2ContinuationLedgerAttemptKeys,
  assertStoredA2QualityCarryManifest,
  buildA2QualityCarryState,
  canonicalA2Json,
  hashA2StableEvidenceTree,
  sha256A2Canonical,
  type A2CarryClass,
  type A2QualityCarryState,
  type FrozenA2EvidenceDescriptor,
} from "@/tests/a2-quality-carry";

type JsonRecord = Record<string, unknown>;

export const A2_SUCCESSOR_CARRY_SCHEMA_VERSION = "a2-successor-carry-v1";
export const A2_SUCCESSOR_CARRY_FILE = "a2-successor-carry-v1.json";
export const A2_SUCCESSOR_RUN_ID = "a2-20260809-quality-successor";
export const A2_PRIOR_COMMITTED_MICROUSD = 16_690_960;
export const A2_SUCCESSOR_MAX_MICROUSD = 8_309_040;
export const A2_LIFETIME_MAX_MICROUSD = 25_000_000;

export const A2_SUCCESSOR_DEFINITION_CRITICAL_FILES = Object.freeze([
  "tests/a2-row-evidence.ts",
  "tests/a2-successor-carry.ts",
  "tests/a2-successor-evidence.local.ts",
  "vitest.a2-successor.config.ts",
] as const);

export const A2_ORIGINAL_EVIDENCE = FROZEN_A2_ORIGINAL_EVIDENCE;
export const A2_STOPPED_EVIDENCE = FROZEN_A2_STOPPED_EVIDENCE;

export interface FrozenA2ContinuationEvidenceDescriptor {
  role: "continuation_quality_source";
  runId: string;
  reportSchemaVersion: string;
  manifestSchemaVersion: string;
  runSchemaVersion: string;
  definitionSha256: string;
  manifestSha256: string;
  carryManifestSha256: string;
  maxMicrousd: number;
  priorCommittedMicrousd: number;
  lifetimeMaxMicrousd: number;
  committedMicrousd: number;
  stableTreeSha256: string;
  stableFileCount: number;
  stableBytes: number;
  pinnedFiles: Readonly<Record<string, string>>;
}

export const A2_CONTINUATION_EVIDENCE = Object.freeze<FrozenA2ContinuationEvidenceDescriptor>({
  role: "continuation_quality_source",
  runId: "a2-20260808-quality-continuation",
  reportSchemaVersion: "a2-rerank-comparison-v6",
  manifestSchemaVersion: "a2-run-manifest-v3",
  runSchemaVersion: "a2-rerank-comparison-v6",
  definitionSha256: "c4ba613cac88a46d02f0361c907a621169aa67524614a9f1de89c068b9e3495a",
  manifestSha256: "d1ed6fb9709d9734a178d35963cb8ce7ce5e9bef0bd30c2eb8f8182f8e7ba364",
  carryManifestSha256: "b2f352af9cf56c8b187a9437689d418f38d3ce9bf225aadecbd56fa14d278152",
  maxMicrousd: 14_605_969,
  priorCommittedMicrousd: 10_394_031,
  lifetimeMaxMicrousd: 25_000_000,
  committedMicrousd: 6_296_929,
  stableTreeSha256: "23e34a07635814f9da75ae4e37ffe6a0e90120df3a55bfa1cd463640e5f89efa",
  stableFileCount: 72,
  stableBytes: 32_486_939,
  pinnedFiles: Object.freeze({
    "comparison-report.json": "d4ffcaf03fe7ec08ca7213977a59cbb74a8455c636b5b46916807a524ca4c4c0",
    "run-manifest.json": "5ab8b6862e4b1858c65df0a2e379961f7c19c252751f154cadb006e2809f09b8",
    "spend-ledger.jsonl": "5a4a8e0c175975e5d1e175f7a350e535063cec5b28748218cd5f8577338be446",
    "retry-manifest.json": "b20859c601e2e6f07bb240e6dfa266a967e808e3dd6364c3bd65475e14baf3a5",
  }),
});

const OLD_CARRY_MANIFEST_SHA256 = A2_CONTINUATION_EVIDENCE.carryManifestSha256;
const STALE_RETRY_LEDGER_SHA256 = "a981924321ca7f771b845b342d5baf9d85db6e44858082dae354def6f4228ca0";
const STALE_RETRY_COMMITTED_MICROUSD = 6_261_038;
const STALE_RETRY_REMAINING_MICROUSD = 8_344_931;
const STALE_RETRY_APPROVAL_DIGEST = "c7d18c512bdb0baada29c9523221d7b4eccc12519443a37c9f3afebcacbb1c56";

export type A2SuccessorCarryClass =
  | "old_strict"
  | "old_quality_only"
  | "continuation_complete"
  | "pending_invalid"
  | "pending_unattempted";

export interface A2SuccessorCarryCounts {
  oldStrict: number;
  oldQualityOnly: number;
  oldCarriedQualityRows: number;
  continuationComplete: number;
  carriedQualityRows: number;
  pendingInvalid: number;
  pendingUnattempted: number;
  pendingPaidRows: number;
  totalLogicalRows: number;
  continuationVoyageOneCall: number;
  continuationVoyageZeroCall: number;
  pendingNextLineageOne: number;
  pendingNextLineageThree: number;
}

export interface A2SuccessorCoverageInput {
  classes: readonly A2SuccessorCarryClass[];
  continuationVoyageProviderCalls: readonly (0 | 1)[];
  pendingNextLineageAttempts: readonly (1 | 3)[];
}

export function deriveA2SuccessorFrozenCoverage(
  input: A2SuccessorCoverageInput,
): A2SuccessorCarryCounts {
  const count = (candidate: A2SuccessorCarryClass): number => input.classes.filter(
    (value) => value === candidate,
  ).length;
  const counts: A2SuccessorCarryCounts = {
    oldStrict: count("old_strict"),
    oldQualityOnly: count("old_quality_only"),
    oldCarriedQualityRows: count("old_strict") + count("old_quality_only"),
    continuationComplete: count("continuation_complete"),
    carriedQualityRows: count("old_strict") + count("old_quality_only")
      + count("continuation_complete"),
    pendingInvalid: count("pending_invalid"),
    pendingUnattempted: count("pending_unattempted"),
    pendingPaidRows: count("pending_invalid") + count("pending_unattempted"),
    totalLogicalRows: input.classes.length,
    continuationVoyageOneCall: input.continuationVoyageProviderCalls.filter((value) => value === 1).length,
    continuationVoyageZeroCall: input.continuationVoyageProviderCalls.filter((value) => value === 0).length,
    pendingNextLineageOne: input.pendingNextLineageAttempts.filter((value) => value === 1).length,
    pendingNextLineageThree: input.pendingNextLineageAttempts.filter((value) => value === 3).length,
  };
  if (counts.oldStrict !== 43 || counts.oldQualityOnly !== 5
    || counts.oldCarriedQualityRows !== 48 || counts.continuationComplete !== 67
    || counts.carriedQualityRows !== 115 || counts.pendingInvalid !== 1
    || counts.pendingUnattempted !== 148 || counts.pendingPaidRows !== 149
    || counts.totalLogicalRows !== 264 || counts.continuationVoyageOneCall !== 66
    || counts.continuationVoyageZeroCall !== 1 || counts.pendingNextLineageOne !== 148
    || counts.pendingNextLineageThree !== 1
    || input.continuationVoyageProviderCalls.length !== counts.continuationComplete
    || input.pendingNextLineageAttempts.length !== counts.pendingPaidRows) {
    throw new Error("A2 successor frozen coverage is not exactly 43/5 + 67 + 1/148 with Voyage 66/1 and lineage 148@1 + 1@3");
  }
  return counts;
}

interface A2SuccessorSourceBinding {
  sourceRunId: string;
  sourceAttemptKey?: string;
  sourceRowSha256: string;
  sourceLedgerRowSha256?: string;
  proofSha256?: string;
  checkpointRowSha256?: string;
  poolArtifactSha256?: string;
  poolSha256?: string;
  voyageProviderCalls?: 0 | 1;
}

interface A2SuccessorLogicalRow {
  logicalRowKey: string;
  questionId: string;
  repeat: number;
  armExecutionOrder: unknown;
  class: A2SuccessorCarryClass;
  nextLineageAttempt?: 1 | 3;
  source?: A2SuccessorSourceBinding;
}

export interface A2StaleRetryBinding {
  rawSha256: string;
  authoritative: false;
  staleLedgerSha256: string;
  currentLedgerSha256: string;
  staleCommittedMicrousd: number;
  currentCommittedMicrousd: number;
  lagMicrousd: number;
  staleRemainingMicrousd: number;
  currentRemainingMicrousd: number;
  entries: 1;
  historicalNextLineageAttempt: 3;
  approvalDigest: string;
}

export interface A2SuccessorCarryManifest {
  schemaVersion: typeof A2_SUCCESSOR_CARRY_SCHEMA_VERSION;
  definitionSha256: string;
  successor: {
    runId: typeof A2_SUCCESSOR_RUN_ID;
    priorCommittedMicrousd: number;
    maxMicrousd: number;
    lifetimeMaxMicrousd: number;
  };
  sourceEvidence: {
    oldCarry: {
      schemaVersion: string;
      manifestSha256: string;
      originalTreeSha256: string;
      stoppedTreeSha256: string;
      carriedQualityRows: number;
    };
    continuation: {
      runId: string;
      role: "continuation_quality_source";
      definitionSha256: string;
      manifestSha256: string;
      carryManifestSha256: string;
      contentTreeSha256: string;
      pinnedFiles: Readonly<Record<string, string>>;
      committedMicrousd: number;
      ledgerSha256: string;
      staleRetry: A2StaleRetryBinding;
    };
  };
  experiment: {
    questionsSha256: string;
    logicalRowsSha256: string;
    runtimeSha256: string;
    repeats: number;
    totalLogicalRows: number;
  };
  counts: A2SuccessorCarryCounts;
  logicalRows: A2SuccessorLogicalRow[];
}

export interface A2SuccessorCarryState {
  manifest: A2SuccessorCarryManifest;
  manifestSha256: string;
  counts: A2SuccessorCarryCounts;
  carriedLogicalKeys: ReadonlySet<string>;
  pendingPaidLogicalKeys: ReadonlySet<string>;
  pendingInvalidLogicalKeys: ReadonlySet<string>;
  pendingUnattemptedLogicalKeys: ReadonlySet<string>;
  nextLineageAttemptByLogicalKey: ReadonlyMap<string, number>;
  carriedQualityRows: ReadonlyArray<JsonRecord>;
  sourceReliabilityRows: ReadonlyArray<JsonRecord>;
}

export function assertA2SuccessorLedgerAttemptKeys(
  carry: Pick<A2SuccessorCarryState,
    "carriedLogicalKeys" | "pendingPaidLogicalKeys" | "nextLineageAttemptByLogicalKey">,
  attemptKeys: readonly string[],
): void {
  const attemptsByLogicalKey = new Map<string, number[]>();
  const seen = new Set<string>();
  for (const attemptKey of attemptKeys) {
    const match = /^(.*)@([1-9]\d*)$/u.exec(attemptKey);
    const logicalKey = match?.[1];
    const attempt = match ? Number(match[2]) : Number.NaN;
    if (!logicalKey || !Number.isSafeInteger(attempt) || seen.has(attemptKey)
      || carry.carriedLogicalKeys.has(logicalKey)
      || !carry.pendingPaidLogicalKeys.has(logicalKey)
      || !carry.nextLineageAttemptByLogicalKey.has(logicalKey)) {
      throw new Error("A2 successor ledger contains a carried, duplicate, or unapproved logical row");
    }
    seen.add(attemptKey);
    attemptsByLogicalKey.set(logicalKey, [
      ...(attemptsByLogicalKey.get(logicalKey) ?? []),
      attempt,
    ]);
  }
  for (const [logicalKey, attempts] of attemptsByLogicalKey) {
    const first = carry.nextLineageAttemptByLogicalKey.get(logicalKey);
    if (!Number.isSafeInteger(first) || first === undefined) {
      throw new Error("A2 successor ledger has no approved attempt lineage");
    }
    attempts.sort((left, right) => left - right).forEach((attempt, index) => {
      if (attempt !== first + index) {
        throw new Error("A2 successor ledger attempt lineage has a gap or wrong starting attempt");
      }
    });
  }
}

export interface A2FrozenSuccessorDirectoryDescriptor {
  label?: string;
  stableTreeSha256: string;
  stableFileCount: number;
  stableBytes: number;
  pinnedFiles: Readonly<Record<string, string>>;
}

export interface A2FrozenSuccessorDirectoryOptions {
  /**
   * The stable-tree hash deliberately excludes the transient root lock. The
   * ordinary verifier must still reject that lock; callers may opt in only
   * while they hold the corresponding source lock themselves.
   */
  allowHeldRootLock?: boolean;
}

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertLowerSha256(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} is not a lowercase SHA-256`);
  }
}

function assertRegularDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a real directory, not a symlink or non-directory`);
  }
}

function assertRegularFile(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} is missing`);
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file, not a symlink or non-file`);
  }
}

export function assertA2FrozenSuccessorEvidenceDirectory(
  directoryInput: string,
  descriptor: A2FrozenSuccessorDirectoryDescriptor,
  options: A2FrozenSuccessorDirectoryOptions = {},
): void {
  const directory = resolve(directoryInput);
  assertRegularDirectory(directory, `A2 ${descriptor.label ?? "frozen source"}`);
  const rootLockPath = join(directory, "paid-run.lock");
  const assertRootLockPolicy = (): void => {
    if (existsSync(rootLockPath)) {
      assertRegularFile(rootLockPath, "A2 frozen source active paid-run.lock");
      if (options.allowHeldRootLock !== true) {
        throw new Error("A2 frozen source has an active paid-run.lock");
      }
    }
  };
  assertRootLockPolicy();
  const before = hashA2StableEvidenceTree(directory);
  if (before.sha256 !== descriptor.stableTreeSha256
    || before.fileCount !== descriptor.stableFileCount
    || before.bytes !== descriptor.stableBytes) {
    throw new Error(`A2 ${descriptor.label ?? "frozen source"} content tree drifted`);
  }
  for (const [relativePath, expectedSha256] of Object.entries(descriptor.pinnedFiles)) {
    assertLowerSha256(expectedSha256, "A2 pinned file digest");
    if (isAbsolute(relativePath) || relativePath.includes("\\")
      || relativePath.split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("A2 pinned evidence path is unsafe");
    }
    const path = join(directory, ...relativePath.split("/"));
    assertRegularFile(path, `A2 pinned evidence file ${relativePath}`);
    if (sha256Bytes(readFileSync(path)) !== expectedSha256) {
      throw new Error(`A2 pinned evidence file drifted: ${relativePath}`);
    }
  }
  const after = hashA2StableEvidenceTree(directory);
  assertRootLockPolicy();
  if (canonicalA2Json(after) !== canonicalA2Json(before)) {
    throw new Error("A2 frozen evidence changed while it was being verified");
  }
}

function readJsonObject(path: string): JsonRecord {
  assertRegularFile(path, "A2 evidence JSON");
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("A2 evidence JSON is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A2 evidence JSON has the wrong root shape");
  }
  return value as JsonRecord;
}

function exactObjectKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function safeInteger(value: unknown, minimum = 0): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function sameReservation(
  reservation: A2RowBudgetReservation,
  state: Readonly<A2SpendLedgerRowState>,
): boolean {
  return state.reservedMicrousd === reservation.totalMicrousd
    && state.cohereReservedMicrousd === reservation.cohereMicrousd
    && state.geminiReservedMicrousd === reservation.geminiMicrousd
    && state.voyageReservedMicrousd === reservation.voyageMicrousd
    && state.cohereSearchUnitsCeiling === reservation.cohereSearchUnitsCeiling
    && state.cohereUsdPerThousandSearchUnits === reservation.cohereUsdPerThousandSearchUnits
    && state.questionUtf8Bytes === reservation.questionUtf8Bytes;
}

function assertLedgerCheckpointBinding(
  row: JsonRecord,
  attemptKey: string,
  reservation: A2RowBudgetReservation,
  ledgerState: Readonly<A2SpendLedgerRowState>,
): ReturnType<typeof verifyA2CheckpointRowAccounting> {
  if (!sameReservation(reservation, ledgerState)) {
    throw new Error("A2 continuation ledger reservation differs from its checkpoint row");
  }
  const verification = verifyA2CheckpointRowAccounting(row, reservation);
  if (verification.decision.kind === "definition_violation") {
    throw new Error("A2 continuation contains a durable accounting-definition violation");
  }
  const charge = verification.decision.charge;
  if (ledgerState.chargedMicrousd !== charge.totalMicrousd
    || ledgerState.cohereChargedMicrousd !== charge.cohereMicrousd
    || ledgerState.geminiChargedMicrousd !== charge.geminiMicrousd
    || ledgerState.voyageChargedMicrousd !== charge.voyageMicrousd
    || ledgerState.completeUsage !== charge.completeUsage
    || ledgerState.settlementKind !== charge.settlementKind
    || ledgerState.proofSha256 !== verification.proofSha256
    || ledgerState.checkpointRowSha256 !== verification.checkpointRowSha256) {
    throw new Error(`A2 continuation ledger settlement differs from its checkpoint row: ${attemptKey}`);
  }
  return verification;
}

function settlementEvidence(
  attemptKey: string,
  reservation: A2RowBudgetReservation,
  state: Readonly<A2SpendLedgerRowState>,
): A2CompleteRowSettlementEvidence {
  if (state.chargedMicrousd === null || state.cohereChargedMicrousd === null
    || state.geminiChargedMicrousd === null || state.voyageChargedMicrousd === null
    || state.completeUsage === null || state.settlementKind === null
    || state.proofSha256 === null || state.checkpointRowSha256 === null) {
    throw new Error("A2 continuation complete row has no settled ledger evidence");
  }
  return {
    rowKey: attemptKey,
    reservation,
    chargedMicrousd: state.chargedMicrousd,
    cohereMicrousd: state.cohereChargedMicrousd,
    geminiMicrousd: state.geminiChargedMicrousd,
    voyageMicrousd: state.voyageChargedMicrousd,
    completeUsage: state.completeUsage,
    settlementKind: state.settlementKind,
    proofSha256: state.proofSha256,
    checkpointRowSha256: state.checkpointRowSha256,
  };
}

export interface A2StaleRetryVerificationFacts {
  rawSha256: string;
  expectedRawSha256: string;
  currentLedgerSha256: string;
  currentCommittedMicrousd: number;
  continuationMaxMicrousd: number;
  expectedPendingInvalidLogicalKey: string;
  expectedNextLineageAttempt: number;
}

export function verifyA2StaleRetryEvidence(
  retry: JsonRecord,
  facts: A2StaleRetryVerificationFacts,
): A2StaleRetryBinding {
  assertLowerSha256(facts.rawSha256, "A2 retry-manifest digest");
  assertLowerSha256(facts.expectedRawSha256, "A2 expected retry-manifest digest");
  assertLowerSha256(facts.currentLedgerSha256, "A2 current ledger digest");
  if (facts.rawSha256 !== facts.expectedRawSha256) {
    throw new Error("A2 stale retry wrapper differs from its pinned bytes");
  }
  exactObjectKeys(retry, [
    "schemaVersion",
    "runId",
    "definitionSha256",
    "manifestSha256",
    "ledgerSha256",
    "committedMicrousd",
    "remainingMicrousd",
    "retries",
    "requiredApproval",
  ], "A2 stale retry wrapper");
  if (retry.schemaVersion !== "a2-retry-manifest-v1"
    || retry.runId !== A2_CONTINUATION_EVIDENCE.runId
    || retry.definitionSha256 !== A2_CONTINUATION_EVIDENCE.definitionSha256
    || retry.manifestSha256 !== A2_CONTINUATION_EVIDENCE.manifestSha256
    || retry.ledgerSha256 !== STALE_RETRY_LEDGER_SHA256
    || retry.committedMicrousd !== STALE_RETRY_COMMITTED_MICROUSD
    || retry.remainingMicrousd !== STALE_RETRY_REMAINING_MICROUSD
    || retry.requiredApproval !== `I_APPROVE_PAID_A2_RETRY:${STALE_RETRY_APPROVAL_DIGEST}`
    || !Array.isArray(retry.retries) || retry.retries.length !== 1) {
    throw new Error("A2 stale retry wrapper differs from its frozen historical state");
  }
  const entry = retry.retries[0] as JsonRecord;
  exactObjectKeys(entry, [
    "logicalRowKey",
    "lastAttemptKey",
    "lastStatus",
    "nextAttempt",
    "nextAttemptKey",
  ], "A2 stale retry entry");
  const logicalKey = facts.expectedPendingInvalidLogicalKey;
  if (!logicalKey || facts.expectedNextLineageAttempt !== 3
    || entry.logicalRowKey !== logicalKey
    || entry.lastAttemptKey !== `${logicalKey}@2`
    || entry.lastStatus !== "invalid"
    || entry.nextAttempt !== 3
    || entry.nextAttemptKey !== `${logicalKey}@3`
    || facts.currentLedgerSha256 !== A2_CONTINUATION_EVIDENCE.pinnedFiles["spend-ledger.jsonl"]
    || facts.currentCommittedMicrousd !== A2_CONTINUATION_EVIDENCE.committedMicrousd
    || facts.continuationMaxMicrousd !== A2_CONTINUATION_EVIDENCE.maxMicrousd) {
    throw new Error("A2 stale retry wrapper does not describe the frozen invalid lineage");
  }
  const lagMicrousd = facts.currentCommittedMicrousd - STALE_RETRY_COMMITTED_MICROUSD;
  const currentRemainingMicrousd = facts.continuationMaxMicrousd
    - facts.currentCommittedMicrousd;
  if (lagMicrousd !== 35_891 || currentRemainingMicrousd !== A2_SUCCESSOR_MAX_MICROUSD) {
    throw new Error("A2 stale retry wrapper lag differs from the frozen continuation ledger");
  }
  return {
    rawSha256: facts.rawSha256,
    authoritative: false,
    staleLedgerSha256: STALE_RETRY_LEDGER_SHA256,
    currentLedgerSha256: facts.currentLedgerSha256,
    staleCommittedMicrousd: STALE_RETRY_COMMITTED_MICROUSD,
    currentCommittedMicrousd: facts.currentCommittedMicrousd,
    lagMicrousd,
    staleRemainingMicrousd: STALE_RETRY_REMAINING_MICROUSD,
    currentRemainingMicrousd,
    entries: 1,
    historicalNextLineageAttempt: 3,
    approvalDigest: STALE_RETRY_APPROVAL_DIGEST,
  };
}

function assertNoActiveSourceLocks(
  evidenceRoot: string,
  allowActiveSourceLocks: boolean,
): void {
  for (const descriptor of [A2_ORIGINAL_EVIDENCE, A2_STOPPED_EVIDENCE, A2_CONTINUATION_EVIDENCE]) {
    const path = resolve(evidenceRoot, descriptor.runId, "paid-run.lock");
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error("A2 immutable source lock is a symlink or non-file");
      }
      if (!allowActiveSourceLocks) {
        throw new Error("A2 immutable source has an active paid-run lock");
      }
    }
  }
}

export function assertA2SuccessorFreshDestination(evidenceRoot: string): void {
  const root = resolve(evidenceRoot);
  assertRegularDirectory(root, "A2 evidence root");
  const destination = resolve(root, A2_SUCCESSOR_RUN_ID);
  if (existsSync(destination)) {
    throw new Error("A2 fresh successor directory already exists");
  }
}

function safePoolArtifactPath(directory: string, value: unknown): string {
  if (typeof value !== "string" || !value || isAbsolute(value) || value.includes("\\")
    || value.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("A2 continuation row has an unsafe pool-artifact path");
  }
  const path = resolve(directory, ...value.split("/"));
  const prefix = `${resolve(directory)}${sep}`;
  if (!path.startsWith(prefix)) throw new Error("A2 pool artifact escapes its frozen source");
  assertRegularFile(path, "A2 continuation pool artifact");
  return path;
}

function validatePoolArtifact(directory: string, row: JsonRecord): string {
  const path = safePoolArtifactPath(directory, row.poolArtifact);
  const artifact = readJsonObject(path);
  if (artifact.schemaVersion !== "a2-rerank-pool-v1"
    || artifact.question !== row.question
    || artifact.poolSha256 !== row.poolSha256
    || artifact.candidateCount !== row.candidateCount
    || !Array.isArray(artifact.candidates)
    || artifact.candidates.length !== row.candidateCount) {
    throw new Error("A2 continuation pool artifact differs from its checkpoint row");
  }
  return sha256Bytes(readFileSync(path));
}

interface VerifiedContinuation {
  directory: string;
  report: JsonRecord;
  manifest: JsonRecord;
  rows: JsonRecord[];
  terminalByLogicalKey: Map<string, JsonRecord>;
  completeRows: JsonRecord[];
  sourceByLogicalKey: Map<string, A2SuccessorSourceBinding>;
  voyageProviderCalls: Array<0 | 1>;
  staleRetry: A2StaleRetryBinding;
  ledgerSha256: string;
}

function verifyContinuationEvidence(
  evidenceRoot: string,
  oldCarry: A2QualityCarryState,
  allowHeldSourceLocks: boolean,
): VerifiedContinuation {
  const descriptor = A2_CONTINUATION_EVIDENCE;
  const directory = resolve(evidenceRoot, descriptor.runId);
  assertA2FrozenSuccessorEvidenceDirectory(directory, {
    label: descriptor.role,
    stableTreeSha256: descriptor.stableTreeSha256,
    stableFileCount: descriptor.stableFileCount,
    stableBytes: descriptor.stableBytes,
    pinnedFiles: descriptor.pinnedFiles,
  }, { allowHeldRootLock: allowHeldSourceLocks });
  const report = readJsonObject(join(directory, "comparison-report.json"));
  const manifest = readJsonObject(join(directory, "run-manifest.json"));
  if (report.schemaVersion !== descriptor.reportSchemaVersion
    || report.runId !== descriptor.runId
    || report.definitionSha256 !== descriptor.definitionSha256
    || report.manifestSha256 !== descriptor.manifestSha256
    || report.carryManifestSha256 !== descriptor.carryManifestSha256
    || usdToMicrousdCeiling(Number(report.maxTotalUsd)) !== descriptor.maxMicrousd
    || usdToMicrousdCeiling(Number(report.budgetCommittedUsd)) !== descriptor.committedMicrousd
    || !Array.isArray(report.budgetOpenAttempts) || report.budgetOpenAttempts.length !== 0
    || report.completedRows !== 67 || report.carriedQualityRows !== 48
    || report.qualityRowsCovered !== 115 || report.attempts !== 71
    || !Array.isArray(report.attemptHistory) || report.attemptHistory.length !== 71) {
    throw new Error("A2 continuation report differs from its frozen run identity");
  }
  if (manifest.schemaVersion !== descriptor.manifestSchemaVersion
    || manifest.runSchemaVersion !== descriptor.runSchemaVersion
    || manifest.runId !== descriptor.runId
    || manifest.definitionSha256 !== descriptor.definitionSha256
    || manifest.manifestSha256 !== descriptor.manifestSha256
    || manifest.carryManifestSha256 !== descriptor.carryManifestSha256
    || manifest.repeats !== 4
    || usdToMicrousdCeiling(Number(manifest.maxTotalUsd)) !== descriptor.maxMicrousd
    || manifest.cohereUsdPerThousandSearchUnits !== 2.50
    || !Array.isArray(manifest.questions) || !Array.isArray(manifest.logicalRows)
    || manifest.logicalRows.length !== 264) {
    throw new Error("A2 continuation manifest differs from its frozen run identity");
  }
  const { manifestSha256: embeddedSha256, ...manifestBody } = manifest;
  if (embeddedSha256 !== sha256Bytes(JSON.stringify(manifestBody))) {
    throw new Error("A2 continuation embedded run-manifest digest is invalid");
  }
  if (sha256A2Canonical(manifest.questions) !== oldCarry.manifest.experiment.questionsSha256
    || sha256A2Canonical(manifest.logicalRows) !== oldCarry.manifest.experiment.logicalRowsSha256) {
    throw new Error("A2 continuation experiment key differs from the frozen old carry");
  }
  const runtime = {
    corpusVersion: manifest.corpusVersion,
    pipelineVersion: manifest.pipelineVersion,
    configVersion: manifest.configVersion,
    models: manifest.models,
    cohereUsdPerThousandSearchUnits: manifest.cohereUsdPerThousandSearchUnits,
  };
  if (sha256A2Canonical(runtime) !== oldCarry.manifest.experiment.runtimeSha256) {
    throw new Error("A2 continuation runtime identity differs from the frozen old carry");
  }

  const logicalRows = manifest.logicalRows as JsonRecord[];
  const logicalByKey = new Map<string, JsonRecord>();
  for (const logical of logicalRows) {
    const key = typeof logical.logicalRowKey === "string" ? logical.logicalRowKey : null;
    if (!key || logicalByKey.has(key) || typeof logical.questionId !== "string"
      || safeInteger(logical.repeat, 1) === null || !Array.isArray(logical.armExecutionOrder)) {
      throw new Error("A2 continuation manifest has an invalid or duplicate logical row");
    }
    logicalByKey.set(key, logical);
  }
  const questions = new Map<string, JsonRecord>();
  for (const raw of manifest.questions as unknown[]) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("A2 continuation manifest has an invalid question key");
    }
    const question = raw as JsonRecord;
    if (typeof question.id !== "string" || questions.has(question.id)) {
      throw new Error("A2 continuation manifest has a duplicate question key");
    }
    questions.set(question.id, question);
  }

  const ledgerPath = join(directory, "spend-ledger.jsonl");
  const ledger = A2SpendLedger.openV4ReadOnly(ledgerPath, {
    runId: descriptor.runId,
    definitionSha256: descriptor.definitionSha256,
    manifestSha256: descriptor.manifestSha256,
    carryManifestSha256: descriptor.carryManifestSha256,
    maxMicrousd: descriptor.maxMicrousd,
    priorCommittedMicrousd: descriptor.priorCommittedMicrousd,
    lifetimeMaxMicrousd: descriptor.lifetimeMaxMicrousd,
  });
  if (ledger.sha256() !== descriptor.pinnedFiles["spend-ledger.jsonl"]
    || ledger.committedMicrousd() !== descriptor.committedMicrousd
    || ledger.lifetimeCommittedMicrousd() !== A2_PRIOR_COMMITTED_MICROUSD
    || ledger.openRowKeys().length !== 0 || ledger.rowKeys().length !== 71) {
    throw new Error("A2 continuation ledger differs from its frozen aggregate state");
  }
  assertA2ContinuationLedgerAttemptKeys(oldCarry, ledger.rowKeys());

  const attemptsByLogical = new Map<string, JsonRecord[]>();
  const rowsByAttempt = new Map<string, JsonRecord>();
  const rows = report.attemptHistory as JsonRecord[];
  for (const row of rows) {
    const logicalKey = typeof row.logicalRowKey === "string" ? row.logicalRowKey : null;
    const attempt = safeInteger(row.attempt, 1);
    const attemptKey = typeof row.attemptKey === "string" ? row.attemptKey : null;
    const logical = logicalKey ? logicalByKey.get(logicalKey) : undefined;
    const question = typeof row.questionId === "string" ? questions.get(row.questionId) : undefined;
    if (!logicalKey || attempt === null || !attemptKey || attemptKey !== `${logicalKey}@${attempt}`
      || rowsByAttempt.has(attemptKey) || !logical || !question
      || row.questionId !== logical.questionId || row.repeat !== logical.repeat
      || JSON.stringify(row.armExecutionOrder) !== JSON.stringify(logical.armExecutionOrder)
      || typeof row.question !== "string"
      || question.questionSha256 !== sha256Bytes(row.question)
      || row.category !== question.category || row.supplemental !== question.supplemental
      || JSON.stringify(row.models) !== JSON.stringify(manifest.models)
      || !["complete", "invalid", "failed"].includes(String(row.status))) {
      throw new Error("A2 continuation checkpoint has an invalid attempt identity");
    }
    const reservation = reserveA2Row(row.question, Number(manifest.cohereUsdPerThousandSearchUnits));
    const state = ledger.rowState(attemptKey);
    if (!state) throw new Error("A2 continuation checkpoint has no ledger row");
    assertLedgerCheckpointBinding(row, attemptKey, reservation, state);
    if (row.status === "complete") {
      assertA2CompleteRowSettlementEvidence(
        row,
        attemptKey,
        settlementEvidence(attemptKey, reservation, state),
      );
    }
    rowsByAttempt.set(attemptKey, row);
    attemptsByLogical.set(logicalKey, [...(attemptsByLogical.get(logicalKey) ?? []), row]);
  }
  if (rowsByAttempt.size !== ledger.rowKeys().length
    || ledger.rowKeys().some((key) => !rowsByAttempt.has(key))) {
    throw new Error("A2 continuation checkpoint and ledger are not a complete bijection");
  }

  const terminalByLogicalKey = new Map<string, JsonRecord>();
  const completeRows: JsonRecord[] = [];
  const sourceByLogicalKey = new Map<string, A2SuccessorSourceBinding>();
  const voyageProviderCalls: Array<0 | 1> = [];
  let failedAttempts = 0;
  for (const [logicalKey, attempts] of attemptsByLogical) {
    attempts.sort((left, right) => Number(left.attempt) - Number(right.attempt));
    attempts.forEach((row, index) => {
      if (row.attempt !== index + 1 || (row.status === "complete" && index !== attempts.length - 1)
        || (index < attempts.length - 1 && row.status !== "failed")) {
        throw new Error("A2 continuation attempt lineage has a gap or post-terminal attempt");
      }
      if (row.status === "failed") failedAttempts += 1;
    });
    const terminal = attempts.at(-1);
    if (!terminal || (terminal.status !== "complete" && terminal.status !== "invalid")) {
      throw new Error("A2 continuation logical row has no frozen terminal state");
    }
    terminalByLogicalKey.set(logicalKey, terminal);
    const poolArtifactSha256 = validatePoolArtifact(directory, terminal);
    const state = ledger.rowState(String(terminal.attemptKey));
    if (!state || state.proofSha256 === null || state.checkpointRowSha256 === null) {
      throw new Error("A2 continuation terminal row lacks immutable ledger binding");
    }
    const binding: A2SuccessorSourceBinding = {
      sourceRunId: descriptor.runId,
      sourceAttemptKey: String(terminal.attemptKey),
      sourceRowSha256: sha256A2Canonical(terminal),
      sourceLedgerRowSha256: sha256A2Canonical(state),
      proofSha256: state.proofSha256,
      checkpointRowSha256: state.checkpointRowSha256,
      poolArtifactSha256,
      poolSha256: String(terminal.poolSha256),
    };
    if (terminal.status === "complete") {
      const voyage = safeInteger(terminal.embeddingProviderCalls);
      if (voyage !== 0 && voyage !== 1) {
        throw new Error("A2 continuation complete row has invalid Voyage call evidence");
      }
      binding.voyageProviderCalls = voyage;
      voyageProviderCalls.push(voyage);
      completeRows.push(terminal);
    }
    sourceByLogicalKey.set(logicalKey, binding);
  }
  const invalidTerminals = [...terminalByLogicalKey.values()].filter((row) => row.status === "invalid");
  if (terminalByLogicalKey.size !== 68 || completeRows.length !== 67
    || invalidTerminals.length !== 1 || failedAttempts !== 3
    || invalidTerminals[0].kind !== "pipeline_degraded"
    || invalidTerminals[0].attempt !== 2) {
    throw new Error("A2 continuation terminal structure is not exactly 67 complete plus one invalid");
  }
  const invalidLogicalKey = String(invalidTerminals[0].logicalRowKey);
  const retryPath = join(directory, "retry-manifest.json");
  const retryBytes = readFileSync(retryPath);
  const staleRetry = verifyA2StaleRetryEvidence(readJsonObject(retryPath), {
    rawSha256: sha256Bytes(retryBytes),
    expectedRawSha256: descriptor.pinnedFiles["retry-manifest.json"],
    currentLedgerSha256: ledger.sha256(),
    currentCommittedMicrousd: ledger.committedMicrousd(),
    continuationMaxMicrousd: descriptor.maxMicrousd,
    expectedPendingInvalidLogicalKey: invalidLogicalKey,
    expectedNextLineageAttempt: 3,
  });
  assertA2FrozenSuccessorEvidenceDirectory(directory, {
    label: descriptor.role,
    stableTreeSha256: descriptor.stableTreeSha256,
    stableFileCount: descriptor.stableFileCount,
    stableBytes: descriptor.stableBytes,
    pinnedFiles: descriptor.pinnedFiles,
  }, { allowHeldRootLock: allowHeldSourceLocks });
  return {
    directory,
    report,
    manifest,
    rows,
    terminalByLogicalKey,
    completeRows,
    sourceByLogicalKey,
    voyageProviderCalls,
    staleRetry,
    ledgerSha256: ledger.sha256(),
  };
}

function oldCarryRows(state: A2QualityCarryState): JsonRecord[] {
  return state.manifest.logicalRows as unknown as JsonRecord[];
}

function oldCarriedRowByKey(state: A2QualityCarryState): Map<string, JsonRecord> {
  return new Map(state.carriedQualityRows.map((row) => [String(row.logicalRowKey), row]));
}

export function buildA2SuccessorCarryState(input: {
  evidenceRoot: string;
  definitionSha256: string;
  allowActiveSourceLocks?: boolean;
}): A2SuccessorCarryState {
  assertLowerSha256(input.definitionSha256, "A2 successor definition digest");
  const evidenceRoot = resolve(input.evidenceRoot);
  assertRegularDirectory(evidenceRoot, "A2 evidence root");
  const allowHeldSourceLocks = input.allowActiveSourceLocks === true;
  assertNoActiveSourceLocks(evidenceRoot, allowHeldSourceLocks);
  for (const descriptor of [A2_ORIGINAL_EVIDENCE, A2_STOPPED_EVIDENCE]) {
    assertA2FrozenSuccessorEvidenceDirectory(resolve(evidenceRoot, descriptor.runId), {
      label: descriptor.role,
      stableTreeSha256: descriptor.stableTreeSha256,
      stableFileCount: descriptor.stableFileCount,
      stableBytes: descriptor.stableBytes,
      pinnedFiles: descriptor.pinnedFiles,
    }, { allowHeldRootLock: allowHeldSourceLocks });
  }
  const oldCarry = buildA2QualityCarryState({
    evidenceRoot,
    definitionSha256: A2_CONTINUATION_EVIDENCE.definitionSha256,
  });
  if (oldCarry.manifestSha256 !== OLD_CARRY_MANIFEST_SHA256) {
    throw new Error("A2 old quality-carry digest differs from the frozen continuation binding");
  }
  assertStoredA2QualityCarryManifest(a2QualityCarryPath(evidenceRoot), oldCarry);
  const continuation = verifyContinuationEvidence(
    evidenceRoot,
    oldCarry,
    allowHeldSourceLocks,
  );

  const oldRows = oldCarryRows(oldCarry);
  const oldByKey = new Map<string, JsonRecord>();
  for (const row of oldRows) {
    const key = typeof row.logicalRowKey === "string" ? row.logicalRowKey : null;
    if (!key || oldByKey.has(key)) throw new Error("A2 old carry has an invalid logical partition");
    oldByKey.set(key, row);
  }
  if (oldByKey.size !== 264) throw new Error("A2 old carry is missing logical rows");
  const oldCarriedRows = oldCarriedRowByKey(oldCarry);
  const logicalRows: A2SuccessorLogicalRow[] = [];
  const carriedLogicalKeys = new Set<string>();
  const pendingPaidLogicalKeys = new Set<string>();
  const pendingInvalidLogicalKeys = new Set<string>();
  const pendingUnattemptedLogicalKeys = new Set<string>();
  const nextLineageAttemptByLogicalKey = new Map<string, number>();
  const classes: A2SuccessorCarryClass[] = [];
  for (const old of oldRows) {
    const logicalKey = String(old.logicalRowKey);
    const oldClass = old.class as A2CarryClass;
    const terminal = continuation.terminalByLogicalKey.get(logicalKey);
    let successorClass: A2SuccessorCarryClass;
    let nextLineageAttempt: 1 | 3 | undefined;
    let source: A2SuccessorSourceBinding | undefined;
    if (oldClass === "strict" || oldClass === "quality_only") {
      if (terminal || !oldCarriedRows.has(logicalKey)) {
        throw new Error("A2 continuation attempted or lost an already-carried old quality row");
      }
      successorClass = oldClass === "strict" ? "old_strict" : "old_quality_only";
      source = {
        sourceRunId: A2_STOPPED_EVIDENCE.runId,
        sourceRowSha256: sha256A2Canonical(old),
      };
      carriedLogicalKeys.add(logicalKey);
    } else if (terminal?.status === "complete") {
      if (oldClass !== "untouched") {
        throw new Error("A2 continuation complete row did not come from the approved untouched partition");
      }
      successorClass = "continuation_complete";
      source = continuation.sourceByLogicalKey.get(logicalKey);
      if (!source) throw new Error("A2 continuation complete row has no immutable source binding");
      carriedLogicalKeys.add(logicalKey);
    } else if (terminal?.status === "invalid") {
      if (oldClass !== "source_degraded_retry" || terminal.attempt !== 2) {
        throw new Error("A2 continuation invalid row is not the exact degraded retry lineage");
      }
      successorClass = "pending_invalid";
      nextLineageAttempt = 3;
      source = continuation.sourceByLogicalKey.get(logicalKey);
      pendingPaidLogicalKeys.add(logicalKey);
      pendingInvalidLogicalKeys.add(logicalKey);
      nextLineageAttemptByLogicalKey.set(logicalKey, nextLineageAttempt);
    } else {
      if (terminal || oldClass !== "untouched") {
        throw new Error("A2 successor has an unapproved unattempted logical row");
      }
      successorClass = "pending_unattempted";
      nextLineageAttempt = 1;
      pendingPaidLogicalKeys.add(logicalKey);
      pendingUnattemptedLogicalKeys.add(logicalKey);
      nextLineageAttemptByLogicalKey.set(logicalKey, nextLineageAttempt);
    }
    classes.push(successorClass);
    logicalRows.push({
      logicalRowKey: logicalKey,
      questionId: String(old.questionId),
      repeat: Number(old.repeat),
      armExecutionOrder: old.armExecutionOrder,
      class: successorClass,
      ...(nextLineageAttempt === undefined ? {} : { nextLineageAttempt }),
      ...(source === undefined ? {} : { source }),
    });
  }
  if (continuation.terminalByLogicalKey.size
      !== [...continuation.terminalByLogicalKey.keys()].filter((key) => oldByKey.has(key)).length
    || carriedLogicalKeys.size + pendingPaidLogicalKeys.size !== 264
    || [...carriedLogicalKeys].some((key) => pendingPaidLogicalKeys.has(key))) {
    throw new Error("A2 successor coverage is overlapping or incomplete");
  }
  const counts = deriveA2SuccessorFrozenCoverage({
    classes,
    continuationVoyageProviderCalls: continuation.voyageProviderCalls,
    pendingNextLineageAttempts: [...nextLineageAttemptByLogicalKey.values()] as Array<1 | 3>,
  });
  if (A2_ORIGINAL_EVIDENCE.committedMicrousd + A2_STOPPED_EVIDENCE.committedMicrousd
      + A2_CONTINUATION_EVIDENCE.committedMicrousd !== A2_PRIOR_COMMITTED_MICROUSD
    || A2_PRIOR_COMMITTED_MICROUSD + A2_SUCCESSOR_MAX_MICROUSD
      !== A2_LIFETIME_MAX_MICROUSD) {
    throw new Error("A2 successor lifetime budget arithmetic is invalid");
  }
  const manifest: A2SuccessorCarryManifest = {
    schemaVersion: A2_SUCCESSOR_CARRY_SCHEMA_VERSION,
    definitionSha256: input.definitionSha256,
    successor: {
      runId: A2_SUCCESSOR_RUN_ID,
      priorCommittedMicrousd: A2_PRIOR_COMMITTED_MICROUSD,
      maxMicrousd: A2_SUCCESSOR_MAX_MICROUSD,
      lifetimeMaxMicrousd: A2_LIFETIME_MAX_MICROUSD,
    },
    sourceEvidence: {
      oldCarry: {
        schemaVersion: oldCarry.manifest.schemaVersion,
        manifestSha256: oldCarry.manifestSha256,
        originalTreeSha256: A2_ORIGINAL_EVIDENCE.stableTreeSha256,
        stoppedTreeSha256: A2_STOPPED_EVIDENCE.stableTreeSha256,
        carriedQualityRows: oldCarry.counts.carriedQualityRows,
      },
      continuation: {
        runId: A2_CONTINUATION_EVIDENCE.runId,
        role: A2_CONTINUATION_EVIDENCE.role,
        definitionSha256: A2_CONTINUATION_EVIDENCE.definitionSha256,
        manifestSha256: A2_CONTINUATION_EVIDENCE.manifestSha256,
        carryManifestSha256: A2_CONTINUATION_EVIDENCE.carryManifestSha256,
        contentTreeSha256: A2_CONTINUATION_EVIDENCE.stableTreeSha256,
        pinnedFiles: A2_CONTINUATION_EVIDENCE.pinnedFiles,
        committedMicrousd: A2_CONTINUATION_EVIDENCE.committedMicrousd,
        ledgerSha256: continuation.ledgerSha256,
        staleRetry: continuation.staleRetry,
      },
    },
    experiment: {
      questionsSha256: oldCarry.manifest.experiment.questionsSha256,
      logicalRowsSha256: oldCarry.manifest.experiment.logicalRowsSha256,
      runtimeSha256: oldCarry.manifest.experiment.runtimeSha256,
      repeats: oldCarry.manifest.experiment.repeats,
      totalLogicalRows: oldCarry.manifest.experiment.totalLogicalRows,
    },
    counts,
    logicalRows,
  };
  return {
    manifest,
    manifestSha256: sha256A2Canonical(manifest),
    counts,
    carriedLogicalKeys,
    pendingPaidLogicalKeys,
    pendingInvalidLogicalKeys,
    pendingUnattemptedLogicalKeys,
    nextLineageAttemptByLogicalKey,
    carriedQualityRows: [...oldCarry.carriedQualityRows, ...continuation.completeRows],
    sourceReliabilityRows: [...oldCarry.sourceReliabilityRows, ...continuation.rows],
  };
}

export function a2SuccessorCarryPath(evidenceRoot: string): string {
  return resolve(evidenceRoot, A2_SUCCESSOR_CARRY_FILE);
}

export function assertStoredA2SuccessorCarryManifest(
  path: string,
  state: A2SuccessorCarryState,
): void {
  if (!existsSync(path)) throw new Error("A2 ignored successor-carry manifest is missing");
  const saved = readJsonObject(path);
  if (sha256A2Canonical(saved) !== state.manifestSha256
    || canonicalA2Json(saved) !== canonicalA2Json(state.manifest)) {
    throw new Error("A2 ignored successor-carry manifest differs from the frozen evidence");
  }
}

export function createStoredA2SuccessorCarryManifest(
  path: string,
  state: A2SuccessorCarryState,
): void {
  if (existsSync(path)) {
    assertStoredA2SuccessorCarryManifest(path, state);
    return;
  }
  writeJsonDurably(path, state.manifest, true);
  assertStoredA2SuccessorCarryManifest(path, state);
}

export function redactedA2SuccessorCarrySummary(state: A2SuccessorCarryState) {
  return {
    schemaVersion: state.manifest.schemaVersion,
    carryManifestSha256: state.manifestSha256,
    sourceTrees: {
      original: A2_ORIGINAL_EVIDENCE.stableTreeSha256,
      stopped: A2_STOPPED_EVIDENCE.stableTreeSha256,
      continuation: A2_CONTINUATION_EVIDENCE.stableTreeSha256,
    },
    counts: state.counts,
    priorCommittedMicrousd: A2_PRIOR_COMMITTED_MICROUSD,
    successorMaxMicrousd: A2_SUCCESSOR_MAX_MICROUSD,
    lifetimeMaxMicrousd: A2_LIFETIME_MAX_MICROUSD,
    staleRetryAuthoritative: false,
  };
}

export function assertA2SuccessorEvidenceAuditEnvironment(): void {
  const forbiddenExact = new Set([
    "A2_MODE",
    "A2_PAID_RUN_APPROVED",
    "A2_RETRY_APPROVAL",
    "A2_RESUME_RUN",
    "A2_PRIOR_STALE_LOCK_APPROVAL",
    "A2_STOPPED_STALE_LOCK_APPROVAL",
    "A2_STALE_LOCK_APPROVAL",
    "A2_CONTINUATION_STALE_LOCK_APPROVAL",
    "A2_SUCCESSOR_STALE_LOCK_APPROVAL",
  ]);
  const present = Object.entries(process.env).flatMap(([name, value]) => {
    const liveCredentialOrUrl = /^(?:GEMINI|VOYAGE|COHERE|SUPABASE|NEXT_PUBLIC_SUPABASE)_/u
      .test(name);
    return value && (forbiddenExact.has(name) || liveCredentialOrUrl) ? [name] : [];
  });
  if (present.length > 0) {
    throw new Error("A2 successor evidence audit requires every live credential, URL, resume, retry, approval, and stale-lock marker to be cleared");
  }
}

export type { FrozenA2EvidenceDescriptor };
