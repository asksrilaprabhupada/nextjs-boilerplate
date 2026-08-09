import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { COHERE_RERANK_MODEL } from "@/app/lib/08-cohere-rerank";
import {
  RERANK_ARMS,
  RERANK_BATCH_SIZE,
  RERANK_COMPARISON_TOP_N,
  RERANK_FINAL_POOL,
} from "@/app/lib/search-v2/rerank";
import goldSetJson from "@/tests/gold/gold-set-v1.json";
import suggestionSetJson from "@/tests/gold/gold-set-v1-suggestions.json";
import {
  A2_BUDGET_DEFINITION,
  reserveA2Row,
  usdToMicrousdCeiling,
  writeJsonDurably,
} from "@/tests/a2-spend-budget";

type JsonRecord = Record<string, unknown>;

interface GradedPassage {
  passage_id: string;
  grade: number;
}

interface RequiredMetadata {
  source_type?: string;
  recipient_required?: boolean;
  recipient_contains?: string;
  occurred_on_required?: boolean;
  occurred_year?: number;
  location_contains?: string;
  reference_contains?: string;
}

interface SuggestedReview {
  status: "suggested_pending_owner_review";
  evaluation_kind: "passage_ids" | "metadata" | "manual";
  candidate_passage_ids: string[];
  unacceptable_passage_ids: string[];
  required_metadata: RequiredMetadata[];
  notes: string;
}

interface GoldQuestion {
  id: string;
  category: string;
  question: string;
  must_find_passage_ids: string[];
  relevant_passages: GradedPassage[];
  unacceptable_passage_ids: string[];
  direct_answer_exists: boolean;
  needs_human_review: boolean;
}

interface SuggestedQuestion extends SuggestedReview {
  question_id: string;
}

interface SupplementalCase extends SuggestedReview {
  id: string;
  question: string;
}

interface ActiveLabels {
  status: "owner_approved" | "suggested_pending_owner_review";
  evaluationKind: "passage_ids" | "metadata" | "manual";
  expectedIds: string[];
  unacceptableIds: string[];
  requiredMetadata: RequiredMetadata[];
  notes: string | null;
}

interface RankedPrivatePassage {
  passageId: string;
  alternatePassageIds: string[];
  sourceType: string;
  reference: string | null;
  recipient: string | null;
  occurredOn: string | null;
  location: string | null;
  rerankScore: number | null;
}

export interface FrozenA2EvidenceDescriptor {
  role: "original_spend_only" | "stopped_quality_source";
  runId: string;
  reportSchemaVersion: string;
  manifestSchemaVersion: string;
  runSchemaVersion: string;
  definitionSha256: string;
  manifestSha256: string;
  maxMicrousd: number;
  committedMicrousd: number;
  stableTreeSha256: string;
  stableFileCount: number;
  stableBytes: number;
  pinnedFiles: Readonly<Record<string, string>>;
}

export const A2_ORIGINAL_EVIDENCE = Object.freeze<FrozenA2EvidenceDescriptor>({
  role: "original_spend_only",
  runId: "a2-20260808-owner-approved-25usd",
  reportSchemaVersion: "a2-rerank-comparison-v4",
  manifestSchemaVersion: "a2-run-manifest-v1",
  runSchemaVersion: "a2-rerank-comparison-v4",
  definitionSha256: "3481a216f29568a71e3004d294492331407eff3d61ad0139c7318315abe63b14",
  manifestSha256: "b8026c4d6df6a46c9b931ab39e3ea4d34df80b47cc74f4b4a89b8d35769f70c7",
  maxMicrousd: 25_000_000,
  committedMicrousd: 2_716_439,
  stableTreeSha256: "ee7726c4067e94e4403cd49919df991b14864b5891b5c46c9dcf4e93afc358b8",
  stableFileCount: 5,
  stableBytes: 625_739,
  pinnedFiles: Object.freeze({
    "comparison-report.json": "3df3f0989a91b220dc8bbf7213972611c96725f864cda3c143b0b44a133bac8c",
    "retry-manifest.json": "406747da0cb5c9aba32f9bb6fdfb4dc0b76a5a3f01e8937e6e875b2882083528",
    "run-manifest.json": "aef81cde3265aa125801b1f9dc8c6c39487993d3420b71f251bd170ca28950c8",
    "spend-ledger.jsonl": "c1e68fcc6c3d6a609c8fc43795b78e048bee9922ddf9d6145d4aa55e149f833a",
    "pools/q001-r01-a02.json": "ba9776edf7ad3e9fbb935c3fc619ca232cd2b72c03f6806d2e06ce56a842aee5",
  }),
});

export const A2_STOPPED_EVIDENCE = Object.freeze<FrozenA2EvidenceDescriptor>({
  role: "stopped_quality_source",
  runId: "a2-20260808-validator-restart",
  reportSchemaVersion: "a2-rerank-comparison-v5",
  manifestSchemaVersion: "a2-run-manifest-v2",
  runSchemaVersion: "a2-rerank-comparison-v5",
  definitionSha256: "5427ecbb177fabe368ace1603acc76e3ecd74b27a2d76a9738df660988c44873",
  manifestSha256: "4a24b993d1e5e775abf508912399df59dbe03ab211750082c669dae21c65fb0f",
  maxMicrousd: 22_283_561,
  committedMicrousd: 7_677_592,
  stableTreeSha256: "699538c5e0d2cc905cef921f80b7437bde5e153f6e023a13551a0614e631890c",
  stableFileCount: 55,
  stableBytes: 22_821_782,
  pinnedFiles: Object.freeze({
    "comparison-report.json": "57a4fce777dde347001f7ba35755d0b306a3790de0c93aae25a9ee5b4c6a71ce",
    "retry-manifest.json": "d77e8014517bb10c5de02b8302a32ef3d22f80842d4993cea422c11cce711135",
    "run-manifest.json": "63a91ef19c732adc118a6fa259fff65bb286319fe6ad4fbd96899eb755d7806b",
    "spend-ledger.jsonl": "40884853e93372f6e61186c6f93c10c0af05ea4ba0413ba2bf51a915dd90f786",
    "recovery/0001-intent.json": "dbc9ce1603f88ad17b3d2f0ca0600958aa69d1c7177fe3f2a54c7a88852ca77b",
    "recovery/0001-complete.json": "ccca14c8038d2ca6cf0f1e7aeae968e184933b34561d29472aa7f2a3ac973361",
  }),
});

export const A2_QUALITY_CARRY_SCHEMA_VERSION = "a2-quality-carry-v1";
export const A2_QUALITY_CARRY_FILE = "a2-quality-carry-v1.json";
export const A2_CONTINUATION_RUN_ID = "a2-20260808-quality-continuation";
export const A2_PRIOR_COMMITTED_MICROUSD = 10_394_031;
export const A2_LIFETIME_MAX_MICROUSD = 25_000_000;
export const A2_CONTINUATION_MAX_MICROUSD = 14_605_969;

export type A2CarryClass =
  | "strict"
  | "quality_only"
  | "source_degraded_retry"
  | "untouched";

export interface A2CarryCounts {
  strict: number;
  quality_only: number;
  source_degraded_retry: number;
  untouched: number;
  carriedQualityRows: number;
  pendingPaidRows: number;
  totalLogicalRows: number;
}

export interface A2CarryClassificationFacts {
  status: string | null;
  kind: string | null;
  pipelineDegraded: boolean | null;
  invalidArm: boolean | null;
  providerUsageComplete: boolean | null;
  plannerAttempts: number | null;
  plannerDurationCount: number | null;
  embeddingProviderCalls: number | null;
  armsHealthy: boolean;
  settlementCompleteUsage: boolean;
  settlementIsFullReservation: boolean;
}

interface LegacyLedgerSettlement {
  rowKey: string;
  reservedMicrousd: number;
  chargedMicrousd: number;
  completeUsage: boolean;
  settlementSha256: string;
}

interface VerifiedEvidence {
  descriptor: FrozenA2EvidenceDescriptor;
  directory: string;
  report: JsonRecord;
  manifest: JsonRecord;
  settlements: Map<string, LegacyLedgerSettlement>;
  rows: JsonRecord[];
  stableTree: A2StableEvidenceTree;
}

interface CarrySourceBinding {
  sourceRunId: string;
  sourceAttemptKey: string;
  sourceRowSha256: string;
  sourceSettlementSha256: string;
  poolArtifactSha256: string;
  poolSha256: string;
  poolIdentitySha256: string;
  rankingsMetadataSha256: string;
  costAccounting: "exact_legacy_single_call" | "conservative_pre_call_reservation";
  geminiUsage: "exact_legacy_single_call" | "observed_not_proven_complete";
}

interface CarryLogicalRow {
  logicalRowKey: string;
  questionId: string;
  repeat: number;
  armExecutionOrder: unknown;
  class: A2CarryClass;
  source?: CarrySourceBinding;
}

export interface A2QualityCarryManifest {
  schemaVersion: typeof A2_QUALITY_CARRY_SCHEMA_VERSION;
  definitionSha256: string;
  sourceEvidence: {
    original: {
      runId: string;
      role: "original_spend_only";
      definitionSha256: string;
      manifestSha256: string;
      contentTreeSha256: string;
      pinnedFiles: Readonly<Record<string, string>>;
      committedMicrousd: number;
    };
    stopped: {
      runId: string;
      role: "stopped_quality_source";
      definitionSha256: string;
      manifestSha256: string;
      contentTreeSha256: string;
      pinnedFiles: Readonly<Record<string, string>>;
      committedMicrousd: number;
    };
  };
  experiment: {
    questionsSha256: string;
    logicalRowsSha256: string;
    runtimeSha256: string;
    repeats: number;
    totalLogicalRows: number;
  };
  counts: A2CarryCounts;
  logicalRows: CarryLogicalRow[];
}

export interface A2QualityCarryState {
  manifest: A2QualityCarryManifest;
  manifestSha256: string;
  counts: A2CarryCounts;
  carriedLogicalKeys: ReadonlySet<string>;
  pendingPaidLogicalKeys: ReadonlySet<string>;
  sourceDegradedRetryLogicalKeys: ReadonlySet<string>;
  untouchedLogicalKeys: ReadonlySet<string>;
  carriedQualityRows: ReadonlyArray<JsonRecord>;
  sourceReliabilityRows: ReadonlyArray<JsonRecord>;
}

export interface A2StableEvidenceTree {
  sha256: string;
  fileCount: number;
  bytes: number;
  entries: Array<{ path: string; bytes: number; sha256: string }>;
}

export function assertA2ContinuationLedgerAttemptKeys(
  carry: Pick<A2QualityCarryState, "carriedLogicalKeys" | "pendingPaidLogicalKeys">,
  attemptKeys: readonly string[],
): void {
  for (const attemptKey of attemptKeys) {
    const match = /^(.*)@([1-9]\d*)$/u.exec(attemptKey);
    const logicalKey = match?.[1];
    if (!logicalKey
      || carry.carriedLogicalKeys.has(logicalKey)
      || !carry.pendingPaidLogicalKeys.has(logicalKey)) {
      throw new Error("A2 continuation ledger contains a carried or unapproved logical row");
    }
  }
}

export function deriveA2FrozenCarryCounts(
  classifications: readonly A2CarryClass[],
): A2CarryCounts {
  const count = (classification: A2CarryClass): number => classifications.filter(
    (candidate) => candidate === classification,
  ).length;
  const counts: A2CarryCounts = {
    strict: count("strict"),
    quality_only: count("quality_only"),
    source_degraded_retry: count("source_degraded_retry"),
    untouched: count("untouched"),
    carriedQualityRows: count("strict") + count("quality_only"),
    pendingPaidRows: count("source_degraded_retry") + count("untouched"),
    totalLogicalRows: classifications.length,
  };
  if (counts.strict !== 43 || counts.quality_only !== 5
    || counts.source_degraded_retry !== 1 || counts.untouched !== 215
    || counts.carriedQualityRows !== 48 || counts.pendingPaidRows !== 216
    || counts.totalLogicalRows !== 264) {
    throw new Error("A2 frozen quality coverage is not exactly 43/5/1/215");
  }
  return counts;
}

const goldSet = goldSetJson as { questions: GoldQuestion[] };
const suggestionSet = suggestionSetJson as {
  suggestions: SuggestedQuestion[];
  supplemental_cases: SupplementalCase[];
};
const suggestionByQuestionId = new Map<string, SuggestedReview>([
  ...suggestionSet.suggestions.map((suggestion) => [suggestion.question_id, suggestion] as const),
  ...suggestionSet.supplemental_cases.map((supplemental) => [supplemental.id, supplemental] as const),
]);
const supplementalQuestions: GoldQuestion[] = suggestionSet.supplemental_cases.map((supplemental) => ({
  id: supplemental.id,
  category: "supplemental_difficult",
  question: supplemental.question,
  must_find_passage_ids: [],
  relevant_passages: [],
  unacceptable_passage_ids: [],
  direct_answer_exists: true,
  needs_human_review: true,
}));
const experimentQuestions = [...goldSet.questions, ...supplementalQuestions];
const questionById = new Map(experimentQuestions.map((question) => [question.id, question]));

function activeLabels(question: GoldQuestion): ActiveLabels {
  if (!question.needs_human_review) {
    const expectedIds = [...new Set([
      ...question.must_find_passage_ids,
      ...question.relevant_passages.map((passage) => passage.passage_id),
    ])];
    return {
      status: "owner_approved",
      evaluationKind: expectedIds.length > 0 ? "passage_ids" : "manual",
      expectedIds,
      unacceptableIds: question.unacceptable_passage_ids,
      requiredMetadata: [],
      notes: null,
    };
  }
  const suggestion = suggestionByQuestionId.get(question.id);
  if (!suggestion || suggestion.status !== "suggested_pending_owner_review") {
    throw new Error("A2 carry question has no complete owner-review suggestion");
  }
  return {
    status: suggestion.status,
    evaluationKind: suggestion.evaluation_kind,
    expectedIds: [...new Set(suggestion.candidate_passage_ids)],
    unacceptableIds: suggestion.unacceptable_passage_ids,
    requiredMetadata: suggestion.required_metadata,
    notes: suggestion.notes,
  };
}

function canonicalJsonValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("A2 canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJsonValue).join(",")}]`;
  if (typeof value === "object") {
    const record = value as JsonRecord;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJsonValue(record[key])}`).join(",")}}`;
  }
  throw new Error("A2 canonical JSON contains an unsupported value");
}

export function canonicalA2Json(value: unknown): string {
  return canonicalJsonValue(value);
}

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256A2Canonical(value: unknown): string {
  return sha256Bytes(canonicalA2Json(value));
}

function isTransientA2Lock(root: string, path: string): boolean {
  const name = relative(root, path).replaceAll("\\", "/");
  return name === "paid-run.lock" || /^paid-run\.lock\.recovered-[^/]+$/u.test(name);
}

function stableFilesBelow(directory: string, root = directory): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("A2 evidence tree may not contain symbolic links");
    if (entry.isDirectory()) return stableFilesBelow(path, root);
    if (!entry.isFile()) throw new Error("A2 evidence tree contains a non-file entry");
    return isTransientA2Lock(root, path) ? [] : [path];
  });
}

export function hashA2StableEvidenceTree(directoryInput: string): A2StableEvidenceTree {
  const directory = resolve(directoryInput);
  if (!existsSync(directory)) throw new Error("A2 frozen evidence directory is missing");
  const entries = stableFilesBelow(directory).map((path) => {
    const bytes = readFileSync(path);
    return {
      path: relative(directory, path).replaceAll("\\", "/"),
      bytes: bytes.length,
      sha256: sha256Bytes(bytes),
    };
  }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  return {
    sha256: sha256Bytes(JSON.stringify(entries)),
    fileCount: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
    entries,
  };
}

function readJson(path: string): JsonRecord {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("A2 evidence JSON has the wrong root shape");
  }
  return value as JsonRecord;
}

function safeInteger(value: unknown, minimum = 0): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : null;
}

function parseLegacyLedger(
  path: string,
  descriptor: FrozenA2EvidenceDescriptor,
): Map<string, LegacyLedgerSettlement> {
  const body = readFileSync(path, "utf8");
  if (!body.endsWith("\n")) throw new Error("A2 frozen ledger has a partial final entry");
  const rawLines = body.split("\n").filter(Boolean);
  const entries = rawLines.map((line) => JSON.parse(line) as JsonRecord);
  const header = entries[0];
  if (!header || header.type !== "header"
    || header.schemaVersion !== "a2-spend-ledger-v3"
    || header.runId !== descriptor.runId
    || header.definitionSha256 !== descriptor.definitionSha256
    || header.manifestSha256 !== descriptor.manifestSha256
    || header.maxMicrousd !== descriptor.maxMicrousd) {
    throw new Error("A2 frozen ledger header differs from its pinned descriptor");
  }
  const reservations = new Map<string, number>();
  const settlements = new Map<string, LegacyLedgerSettlement>();
  entries.slice(1).forEach((entry, index) => {
    const rowKey = typeof entry.rowKey === "string" ? entry.rowKey : null;
    if (!rowKey || !/^.+:[1-9]\d*@[1-9]\d*$/u.test(rowKey)) {
      throw new Error("A2 frozen ledger has an invalid row identity");
    }
    if (entry.type === "reserve") {
      const reserved = safeInteger(entry.reservedMicrousd, 1);
      if (reserved === null || reservations.has(rowKey)) {
        throw new Error("A2 frozen ledger has an invalid reservation");
      }
      reservations.set(rowKey, reserved);
      return;
    }
    if (entry.type !== "settle") throw new Error("A2 frozen ledger has an unknown entry type");
    const reserved = reservations.get(rowKey);
    const charged = safeInteger(entry.chargedMicrousd);
    if (reserved === undefined || charged === null || charged > reserved || settlements.has(rowKey)
      || typeof entry.completeUsage !== "boolean") {
      throw new Error("A2 frozen ledger has an invalid settlement");
    }
    settlements.set(rowKey, {
      rowKey,
      reservedMicrousd: reserved,
      chargedMicrousd: charged,
      completeUsage: entry.completeUsage,
      settlementSha256: sha256Bytes(rawLines[index + 1]),
    });
  });
  if (reservations.size !== settlements.size
    || [...reservations.keys()].some((key) => !settlements.has(key))) {
    throw new Error("A2 frozen ledger has an open reservation");
  }
  const committed = [...settlements.values()].reduce(
    (total, settlement) => total + settlement.chargedMicrousd,
    0,
  );
  if (committed !== descriptor.committedMicrousd) {
    throw new Error("A2 frozen ledger commitment differs from its pinned descriptor");
  }
  return settlements;
}

function verifyFrozenEvidence(
  evidenceRoot: string,
  descriptor: FrozenA2EvidenceDescriptor,
): VerifiedEvidence {
  const directory = resolve(evidenceRoot, descriptor.runId);
  const stableTree = hashA2StableEvidenceTree(directory);
  if (stableTree.sha256 !== descriptor.stableTreeSha256
    || stableTree.fileCount !== descriptor.stableFileCount
    || stableTree.bytes !== descriptor.stableBytes) {
    throw new Error(`A2 ${descriptor.role} content tree differs from the frozen evidence`);
  }
  for (const [relativePath, expectedSha256] of Object.entries(descriptor.pinnedFiles)) {
    const path = join(directory, ...relativePath.split("/"));
    if (!existsSync(path) || sha256Bytes(readFileSync(path)) !== expectedSha256) {
      throw new Error(`A2 ${descriptor.role} differs at a pinned file`);
    }
  }
  const report = readJson(join(directory, "comparison-report.json"));
  const manifest = readJson(join(directory, "run-manifest.json"));
  if (report.schemaVersion !== descriptor.reportSchemaVersion
    || report.runId !== descriptor.runId
    || report.definitionSha256 !== descriptor.definitionSha256
    || report.manifestSha256 !== descriptor.manifestSha256
    || usdToMicrousdCeiling(Number(report.maxTotalUsd)) !== descriptor.maxMicrousd
    || usdToMicrousdCeiling(Number(report.budgetCommittedUsd)) !== descriptor.committedMicrousd
    || !Array.isArray(report.budgetOpenAttempts) || report.budgetOpenAttempts.length !== 0
    || !Array.isArray(report.attemptHistory)) {
    throw new Error(`A2 ${descriptor.role} report differs from the frozen run identity`);
  }
  if (manifest.schemaVersion !== descriptor.manifestSchemaVersion
    || manifest.runSchemaVersion !== descriptor.runSchemaVersion
    || manifest.runId !== descriptor.runId
    || manifest.definitionSha256 !== descriptor.definitionSha256
    || manifest.manifestSha256 !== descriptor.manifestSha256
    || !Array.isArray(manifest.questions)
    || !Array.isArray(manifest.logicalRows)) {
    throw new Error(`A2 ${descriptor.role} manifest differs from the frozen run identity`);
  }
  const { manifestSha256: ignoredManifestSha256, ...manifestBody } = manifest;
  if (ignoredManifestSha256 !== sha256Bytes(JSON.stringify(manifestBody))) {
    throw new Error(`A2 ${descriptor.role} embedded manifest hash is invalid`);
  }
  const settlements = parseLegacyLedger(join(directory, "spend-ledger.jsonl"), descriptor);
  return {
    descriptor,
    directory,
    report,
    manifest,
    settlements,
    rows: report.attemptHistory as JsonRecord[],
    stableTree,
  };
}

function includesFolded(value: string | null, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const fold = (input: string): string => input.normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en-US");
  return fold(value ?? "").includes(fold(expected));
}

function candidateMatchesId(candidate: RankedPrivatePassage, passageId: string): boolean {
  return candidate.passageId === passageId || candidate.alternatePassageIds.includes(passageId);
}

function candidateMatchesMetadata(
  candidate: RankedPrivatePassage,
  rule: RequiredMetadata,
): boolean {
  return (rule.source_type === undefined || candidate.sourceType === rule.source_type)
    && (rule.recipient_required !== true || Boolean(candidate.recipient?.trim()))
    && includesFolded(candidate.recipient, rule.recipient_contains)
    && (rule.occurred_on_required !== true || Boolean(candidate.occurredOn?.trim()))
    && includesFolded(candidate.location, rule.location_contains)
    && includesFolded(candidate.reference, rule.reference_contains)
    && (rule.occurred_year === undefined
      || candidate.occurredOn?.slice(0, 4) === String(rule.occurred_year));
}

function scorePrivateTop(top: RankedPrivatePassage[], labels: ActiveLabels) {
  const expectedPositions = labels.expectedIds.map((passageId) => ({
    passageId,
    position: (() => {
      const index = top.findIndex((candidate) => candidateMatchesId(candidate, passageId));
      return index < 0 ? null : index + 1;
    })(),
  }));
  const unacceptableHits = labels.unacceptableIds.flatMap((passageId) => {
    const index = top.findIndex((candidate) => candidateMatchesId(candidate, passageId));
    return index < 0 ? [] : [{ passageId, position: index + 1 }];
  });
  const metadataPositions = labels.requiredMetadata.map((rule) => {
    const index = top.findIndex((candidate) => candidateMatchesMetadata(candidate, rule));
    return { rule, position: index < 0 ? null : index + 1 };
  });
  const foundExpected = expectedPositions.filter((item) => item.position !== null);
  const foundMetadata = metadataPositions.filter((item) => item.position !== null);
  const noUnacceptable = unacceptableHits.length === 0;
  return {
    automaticPass: labels.evaluationKind === "passage_ids"
      ? foundExpected.length > 0 && noUnacceptable
      : labels.evaluationKind === "metadata"
        ? foundMetadata.length > 0 && noUnacceptable
        : null,
    expectedPassageAppears: labels.expectedIds.length > 0 ? foundExpected.length > 0 : null,
    firstExpectedPosition: foundExpected.length > 0
      ? Math.min(...foundExpected.map((item) => item.position!))
      : null,
    expectedPassagesFound: foundExpected.length,
    expectedPassagesTotal: labels.expectedIds.length,
    expectedPositions,
    metadataPositions,
    unacceptableHits,
  };
}

function jaccard(left: string[], right: string[]): number {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  const union = new Set([...leftSet, ...rightSet]);
  if (union.size === 0) return 1;
  return [...leftSet].filter((value) => rightSet.has(value)).length / union.size;
}

function changesForPrivateTop(
  currentTop: RankedPrivatePassage[],
  globalTop: RankedPrivatePassage[],
  labels: ActiveLabels,
  currentScore: ReturnType<typeof scorePrivateTop>,
  globalScore: ReturnType<typeof scorePrivateTop>,
) {
  const currentIds = currentTop.map((candidate) => candidate.passageId);
  const globalIds = globalTop.map((candidate) => candidate.passageId);
  const firstPositionDelta = currentScore.firstExpectedPosition !== null
    && globalScore.firstExpectedPosition !== null
    ? globalScore.firstExpectedPosition - currentScore.firstExpectedPosition
    : null;
  const unacceptableRankRegression = globalScore.unacceptableHits.some((globalHit) => {
    const currentHit = currentScore.unacceptableHits.find(
      (item) => item.passageId === globalHit.passageId,
    );
    return currentHit !== undefined && globalHit.position < currentHit.position;
  });
  const overlap = jaccard(currentIds, globalIds);
  return {
    top20Jaccard: overlap,
    removedFromCurrent: currentIds.filter((passageId) => !globalIds.includes(passageId)),
    appearedInGlobal: globalIds.filter((passageId) => !currentIds.includes(passageId)),
    importantDisappeared: labels.expectedIds.filter((passageId) =>
      currentTop.some((candidate) => candidateMatchesId(candidate, passageId))
      && !globalTop.some((candidate) => candidateMatchesId(candidate, passageId))),
    importantAppeared: labels.expectedIds.filter((passageId) =>
      !currentTop.some((candidate) => candidateMatchesId(candidate, passageId))
      && globalTop.some((candidate) => candidateMatchesId(candidate, passageId))),
    firstExpectedPositionDelta: firstPositionDelta,
    unacceptableRankRegression,
    materialChange: currentScore.automaticPass !== globalScore.automaticPass
      || (firstPositionDelta !== null && Math.abs(firstPositionDelta) >= 5)
      || currentScore.unacceptableHits.length !== globalScore.unacceptableHits.length
      || unacceptableRankRegression
      || overlap < 0.75,
    globalQualityRegression: (
      currentScore.automaticPass === true && globalScore.automaticPass !== true
    ) || globalScore.unacceptableHits.length > currentScore.unacceptableHits.length
      || unacceptableRankRegression,
  };
}

function armRequestHealth(row: JsonRecord): boolean {
  const arms = row.arms as JsonRecord | undefined;
  return [RERANK_ARMS.current, RERANK_ARMS.global].every((arm) => {
    const outcome = arms?.[arm] as JsonRecord | undefined;
    const requests = outcome?.providerRequests;
    return outcome?.reranked === true
      && outcome.degradedReason === null
      && Array.isArray(requests)
      && requests.length > 0
      && requests.every((request) => (request as JsonRecord).responseSucceeded === true);
  });
}

export function carryClassificationFacts(
  row: JsonRecord,
  settlement: {
    reservedMicrousd: number;
    chargedMicrousd: number;
    completeUsage: boolean;
  },
): A2CarryClassificationFacts {
  const planner = row.plannerUsage as JsonRecord | undefined;
  return {
    status: typeof row.status === "string" ? row.status : null,
    kind: typeof row.kind === "string" ? row.kind : null,
    pipelineDegraded: typeof row.pipelineDegraded === "boolean" ? row.pipelineDegraded : null,
    invalidArm: typeof row.invalidArm === "boolean" ? row.invalidArm : null,
    providerUsageComplete: typeof row.providerUsageComplete === "boolean"
      ? row.providerUsageComplete
      : null,
    plannerAttempts: safeInteger(planner?.attempts, 1),
    plannerDurationCount: Array.isArray(planner?.attemptDurationsMs)
      ? planner.attemptDurationsMs.length
      : null,
    embeddingProviderCalls: safeInteger(row.embeddingProviderCalls),
    armsHealthy: armRequestHealth(row),
    settlementCompleteUsage: settlement.completeUsage,
    settlementIsFullReservation: settlement.chargedMicrousd === settlement.reservedMicrousd,
  };
}

export function classifyA2SourceRow(facts: A2CarryClassificationFacts): A2CarryClass {
  const sharedHealthy = facts.invalidArm === false
    && facts.embeddingProviderCalls === 1
    && facts.armsHealthy;
  if (facts.status === "complete"
    && facts.kind === null
    && facts.pipelineDegraded === false
    && facts.providerUsageComplete === true
    && facts.plannerAttempts === 1
    && facts.plannerDurationCount === 1
    && facts.settlementCompleteUsage === true
    && !facts.settlementIsFullReservation
    && sharedHealthy) {
    return "strict";
  }
  if (facts.status === "invalid"
    && facts.kind === "provider_usage_incomplete"
    && facts.pipelineDegraded === false
    && facts.providerUsageComplete === false
    && facts.plannerAttempts === 2
    && facts.plannerDurationCount === 2
    && facts.settlementCompleteUsage === false
    && facts.settlementIsFullReservation
    && sharedHealthy) {
    return "quality_only";
  }
  if (facts.status === "invalid"
    && facts.kind === "pipeline_degraded"
    && facts.pipelineDegraded === true
    && facts.providerUsageComplete === false
    && facts.settlementCompleteUsage === false
    && facts.settlementIsFullReservation
    && sharedHealthy) {
    return "source_degraded_retry";
  }
  throw new Error("A2 stopped source row has no approved structural carry class");
}

function expectedPoolPath(row: JsonRecord): string {
  if (typeof row.questionId !== "string"
    || safeInteger(row.repeat, 1) === null
    || safeInteger(row.attempt, 1) === null) {
    throw new Error("A2 source row has an invalid attempt identity");
  }
  return `pools/${row.questionId}-r${String(row.repeat).padStart(2, "0")}-a${String(row.attempt).padStart(2, "0")}.json`;
}

function validateProviderRequestShape(row: JsonRecord): void {
  const candidateCount = safeInteger(row.candidateCount, 2);
  const order = row.armExecutionOrder;
  const timing = row.searchToTop20Ms as JsonRecord | undefined;
  const arms = row.arms as JsonRecord | undefined;
  if (candidateCount === null || candidateCount > 400 || !Array.isArray(order)
    || order.length !== 2 || new Set(order).size !== 2
    || !order.includes(RERANK_ARMS.current) || !order.includes(RERANK_ARMS.global)
    || !timing || !arms) {
    throw new Error("A2 source row has invalid comparison structure");
  }
  for (const arm of [RERANK_ARMS.current, RERANK_ARMS.global]) {
    const outcome = arms[arm] as JsonRecord | undefined;
    const requests = outcome?.providerRequests;
    const top = outcome?.top;
    if (!outcome || outcome.reranked !== true || outcome.degradedReason !== null
      || outcome.arm !== arm || outcome.model !== COHERE_RERANK_MODEL
      || outcome.topN !== RERANK_COMPARISON_TOP_N
      || safeInteger(outcome.documentCount, 2) === null
      || safeInteger(outcome.providerCallCount, 1) === null
      || typeof outcome.durationMs !== "number" || !Number.isFinite(outcome.durationMs)
      || outcome.durationMs < 0
      || typeof timing[arm] !== "number" || !Number.isFinite(timing[arm] as number)
      || (timing[arm] as number) < 0
      || !Array.isArray(top) || top.length !== Math.min(RERANK_COMPARISON_TOP_N, candidateCount)
      || !Array.isArray(requests) || requests.length !== outcome.providerCallCount) {
      throw new Error("A2 source row has an invalid rerank arm");
    }
    const documentCounts = requests.map((request) => {
      const value = request as JsonRecord;
      if (value.responseSucceeded !== true
        || safeInteger(value.documentCount, 2) === null
        || safeInteger(value.topN, 1) === null
        || safeInteger(value.billedSearchUnits) === null) {
        throw new Error("A2 source row has an invalid Cohere response record");
      }
      return Number(value.documentCount);
    });
    const requestTopNs = requests.map((request) => Number((request as JsonRecord).topN));
    if (documentCounts.reduce((total, count) => total + count, 0) !== outcome.documentCount) {
      throw new Error("A2 source row has inconsistent Cohere document accounting");
    }
    if (arm === RERANK_ARMS.global) {
      if (documentCounts.length !== 1 || documentCounts[0] !== candidateCount
        || requestTopNs[0] !== Math.min(RERANK_COMPARISON_TOP_N, candidateCount)) {
        throw new Error("A2 source row has an invalid global Cohere request shape");
      }
      continue;
    }
    const firstPassCounts: number[] = [];
    for (let offset = 0; offset < candidateCount; offset += RERANK_BATCH_SIZE) {
      const count = Math.min(RERANK_BATCH_SIZE, candidateCount - offset);
      if (count > 1) firstPassCounts.push(count);
    }
    const hasFinalPass = candidateCount > RERANK_BATCH_SIZE;
    const expectedRequests = firstPassCounts.length + (hasFinalPass ? 1 : 0);
    const firstPassExact = firstPassCounts.every((count, index) =>
      documentCounts[index] === count && requestTopNs[index] === count);
    const finalCount = hasFinalPass ? documentCounts.at(-1) : null;
    const finalTopN = hasFinalPass ? requestTopNs.at(-1) : null;
    if (documentCounts.length !== expectedRequests || !firstPassExact
      || (hasFinalPass && (
        (finalCount !== RERANK_FINAL_POOL && finalCount !== RERANK_FINAL_POOL + 1)
        || finalTopN !== finalCount
      ))) {
      throw new Error("A2 source row has an invalid current Cohere request shape");
    }
  }
}

function validatePlannerAndSettlement(
  row: JsonRecord,
  classification: A2CarryClass,
  settlement: LegacyLedgerSettlement,
): void {
  const planner = row.plannerUsage as JsonRecord | undefined;
  const durations = planner?.attemptDurationsMs;
  const attempts = safeInteger(planner?.attempts, 1);
  const prompt = safeInteger(planner?.promptTokens, 1);
  const output = safeInteger(planner?.outputTokens, 1);
  const thoughts = safeInteger(planner?.thoughtsTokens);
  const total = safeInteger(planner?.totalTokens, 1);
  if (!planner || !Array.isArray(durations) || attempts === null
    || durations.length !== attempts
    || durations.some((duration) => typeof duration !== "number"
      || !Number.isFinite(duration) || duration < 0)
    || prompt === null || output === null || thoughts === null || total === null
    || total !== prompt + output + thoughts) {
    throw new Error("A2 source row has incoherent planner aggregate usage");
  }
  const requestRecords = Object.values(row.arms as JsonRecord).flatMap((outcome) => {
    const requests = (outcome as JsonRecord).providerRequests;
    return Array.isArray(requests) ? requests as JsonRecord[] : [];
  });
  const cohereUnits = requestRecords.reduce((sum, request) => {
    const units = safeInteger(request.billedSearchUnits);
    if (units === null) throw new Error("A2 source row has incomplete Cohere usage");
    return sum + units;
  }, 0);
  const question = typeof row.question === "string" ? row.question : null;
  if (!question) throw new Error("A2 source row has no question for its reservation");
  const reservation = reserveA2Row(question, 2.50);
  if (settlement.reservedMicrousd !== reservation.totalMicrousd
    || cohereUnits > reservation.cohereSearchUnitsCeiling
    || safeInteger(row.embeddingProviderCalls) !== 1) {
    throw new Error("A2 source row exceeds or differs from its frozen reservation");
  }
  if (classification === "strict") {
    if (attempts !== 1
      || prompt > A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt
      || output + thoughts > A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt) {
      throw new Error("A2 strict source row cannot synthesize its legacy one-call proof");
    }
    const cohereMicrousd = usdToMicrousdCeiling(
      cohereUnits * reservation.cohereUsdPerThousandSearchUnits / 1_000,
    );
    const geminiMicrousd = usdToMicrousdCeiling(
      prompt * A2_BUDGET_DEFINITION.geminiInputUsdPerMillionTokens / 1_000_000,
    ) + usdToMicrousdCeiling(
      (output + thoughts) * A2_BUDGET_DEFINITION.geminiOutputUsdPerMillionTokens / 1_000_000,
    );
    if (cohereMicrousd > reservation.cohereMicrousd
      || geminiMicrousd > reservation.geminiMicrousd
      || settlement.chargedMicrousd
        !== cohereMicrousd + geminiMicrousd + reservation.voyageMicrousd
      || settlement.completeUsage !== true) {
      throw new Error("A2 strict source settlement is not exact");
    }
    return;
  }
  if (classification === "quality_only") {
    if (attempts !== 2
      || prompt > 2 * A2_BUDGET_DEFINITION.geminiMaxInputTokensPerAttempt
      || output + thoughts > 2 * A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt) {
      throw new Error("A2 quality-only source row has incoherent aggregate usage");
    }
  }
  if (settlement.chargedMicrousd !== reservation.totalMicrousd
    || settlement.completeUsage !== false) {
    throw new Error("A2 non-strict source row did not retain its full reservation");
  }
}

function validateSourceRow(
  source: VerifiedEvidence,
  row: JsonRecord,
  expectedLogical: JsonRecord,
  classification: A2CarryClass,
  settlement: LegacyLedgerSettlement,
): CarrySourceBinding {
  const question = typeof row.questionId === "string" ? questionById.get(row.questionId) : undefined;
  if (!question || row.logicalRowKey !== expectedLogical.logicalRowKey
    || row.questionId !== expectedLogical.questionId
    || row.repeat !== expectedLogical.repeat
    || JSON.stringify(row.armExecutionOrder) !== JSON.stringify(expectedLogical.armExecutionOrder)
    || row.question !== question.question
    || row.category !== question.category
    || JSON.stringify(row.models) !== JSON.stringify(source.manifest.models)) {
    throw new Error("A2 source row differs from the frozen logical manifest");
  }
  validateProviderRequestShape(row);
  validatePlannerAndSettlement(row, classification, settlement);
  const relativePoolPath = expectedPoolPath(row);
  if (row.poolArtifact !== relativePoolPath) {
    throw new Error("A2 source row points to the wrong pool artifact");
  }
  const poolPath = join(source.directory, ...relativePoolPath.split("/"));
  if (!existsSync(poolPath)) throw new Error("A2 source row pool artifact is missing");
  const artifact = readJson(poolPath);
  const candidates = artifact.candidates;
  const candidateCount = safeInteger(row.candidateCount, 2);
  if (artifact.schemaVersion !== "a2-rerank-pool-v1"
    || artifact.question !== row.question
    || artifact.model !== COHERE_RERANK_MODEL
    || artifact.poolSha256 !== row.poolSha256
    || artifact.candidateCount !== candidateCount
    || !Array.isArray(candidates) || candidates.length !== candidateCount
    || candidateCount === null || candidateCount > 400) {
    throw new Error("A2 source row pool artifact has an invalid identity");
  }
  const candidateRecords = candidates as JsonRecord[];
  const candidateIds = candidateRecords.map((candidate) => String(candidate.passageId));
  if (new Set(candidateIds).size !== candidateIds.length
    || candidateRecords.filter((candidate) => candidate.pinned === true).length > 1) {
    throw new Error("A2 source row pool artifact has invalid candidate identities");
  }
  for (const candidate of candidateRecords) {
    if (typeof candidate.document !== "string"
      || candidate.documentSha256 !== sha256Bytes(candidate.document)
      || candidate.documentBytes !== Buffer.byteLength(candidate.document, "utf8")) {
      throw new Error("A2 source row pool document digest is invalid");
    }
  }
  const poolIdentity = JSON.stringify({
    question: artifact.question,
    model: artifact.model,
    candidates: candidateRecords.map((candidate) => ({
      passageId: candidate.passageId,
      pinned: candidate.pinned,
      alternatePassageIds: candidate.alternatePassageIds,
      document: candidate.document,
    })),
  });
  const poolIdentitySha256 = sha256Bytes(poolIdentity);
  if (poolIdentitySha256 !== artifact.poolSha256) {
    throw new Error("A2 source row pool identity digest is invalid");
  }
  const candidateById = new Map(candidateRecords.map((candidate) => [candidate.passageId, candidate]));
  const arms = row.arms as JsonRecord;
  for (const arm of [RERANK_ARMS.current, RERANK_ARMS.global]) {
    const outcome = arms[arm] as JsonRecord;
    const top = outcome.top as RankedPrivatePassage[];
    if (new Set(top.map((candidate) => candidate.passageId)).size !== top.length
      || top.some((candidate) => !candidateById.has(candidate.passageId))) {
      throw new Error("A2 source ranking contains an invalid candidate identity");
    }
    for (const candidate of top) {
      const sourceCandidate = candidateById.get(candidate.passageId)!;
      if (candidate.sourceType !== sourceCandidate.sourceType
        || candidate.reference !== sourceCandidate.reference
        || candidate.recipient !== sourceCandidate.recipient
        || candidate.occurredOn !== sourceCandidate.occurredOn
        || candidate.location !== sourceCandidate.location
        || JSON.stringify(candidate.alternatePassageIds)
          !== JSON.stringify(sourceCandidate.alternatePassageIds)) {
        throw new Error("A2 source ranking metadata differs from its pool");
      }
    }
  }
  const labels = activeLabels(question);
  const currentTop = (arms[RERANK_ARMS.current] as JsonRecord).top as RankedPrivatePassage[];
  const globalTop = (arms[RERANK_ARMS.global] as JsonRecord).top as RankedPrivatePassage[];
  const currentScore = scorePrivateTop(currentTop, labels);
  const globalScore = scorePrivateTop(globalTop, labels);
  const scores = { current: currentScore, global: globalScore };
  const changes = changesForPrivateTop(
    currentTop,
    globalTop,
    labels,
    currentScore,
    globalScore,
  );
  if (JSON.stringify(row.scores) !== JSON.stringify(scores)
    || JSON.stringify(row.changes) !== JSON.stringify(changes)) {
    throw new Error("A2 source scores or change flags do not match the saved rankings");
  }
  return {
    sourceRunId: source.descriptor.runId,
    sourceAttemptKey: String(row.attemptKey),
    sourceRowSha256: sha256A2Canonical(row),
    sourceSettlementSha256: settlement.settlementSha256,
    poolArtifactSha256: sha256Bytes(readFileSync(poolPath)),
    poolSha256: String(row.poolSha256),
    poolIdentitySha256,
    rankingsMetadataSha256: sha256A2Canonical({
      arms: {
        current: currentTop,
        global: globalTop,
      },
      scores,
      changes,
    }),
    costAccounting: classification === "strict"
      ? "exact_legacy_single_call"
      : "conservative_pre_call_reservation",
    geminiUsage: classification === "strict"
      ? "exact_legacy_single_call"
      : "observed_not_proven_complete",
  };
}

function verifyCurrentQuestionManifest(manifest: JsonRecord): void {
  const questions = manifest.questions;
  if (!Array.isArray(questions) || questions.length !== experimentQuestions.length) {
    throw new Error("A2 frozen manifest does not contain the complete question key");
  }
  questions.forEach((entry, index) => {
    const record = entry as JsonRecord;
    const question = experimentQuestions[index];
    if (record.id !== question.id || record.category !== question.category
      || record.questionSha256 !== sha256Bytes(question.question)
      || record.labelsSha256 !== sha256Bytes(JSON.stringify(activeLabels(question)))
      || record.supplemental !== question.id.startsWith("supplemental-")) {
      throw new Error("A2 frozen manifest question differs from the current approved key");
    }
  });
}

function evidenceBinding(descriptor: FrozenA2EvidenceDescriptor) {
  return {
    runId: descriptor.runId,
    role: descriptor.role,
    definitionSha256: descriptor.definitionSha256,
    manifestSha256: descriptor.manifestSha256,
    contentTreeSha256: descriptor.stableTreeSha256,
    pinnedFiles: descriptor.pinnedFiles,
    committedMicrousd: descriptor.committedMicrousd,
  };
}

export function buildA2QualityCarryState(input: {
  evidenceRoot: string;
  definitionSha256: string;
  originalDescriptor?: FrozenA2EvidenceDescriptor;
  stoppedDescriptor?: FrozenA2EvidenceDescriptor;
}): A2QualityCarryState {
  if (!/^[0-9a-f]{64}$/u.test(input.definitionSha256)) {
    throw new Error("A2 continuation definition digest is invalid");
  }
  const original = verifyFrozenEvidence(
    input.evidenceRoot,
    input.originalDescriptor ?? A2_ORIGINAL_EVIDENCE,
  );
  const stopped = verifyFrozenEvidence(
    input.evidenceRoot,
    input.stoppedDescriptor ?? A2_STOPPED_EVIDENCE,
  );
  if (original.descriptor.committedMicrousd + stopped.descriptor.committedMicrousd
      !== A2_PRIOR_COMMITTED_MICROUSD
    || A2_PRIOR_COMMITTED_MICROUSD + A2_CONTINUATION_MAX_MICROUSD
      !== A2_LIFETIME_MAX_MICROUSD) {
    throw new Error("A2 continuation lifetime budget arithmetic is invalid");
  }
  verifyCurrentQuestionManifest(stopped.manifest);
  if (sha256A2Canonical(original.manifest.questions)
      !== sha256A2Canonical(stopped.manifest.questions)
    || sha256A2Canonical(original.manifest.logicalRows)
      !== sha256A2Canonical(stopped.manifest.logicalRows)) {
    throw new Error("A2 frozen runs do not share the same experiment key");
  }
  const logicalRows = stopped.manifest.logicalRows as JsonRecord[];
  if (logicalRows.length !== 264
    || new Set(logicalRows.map((row) => row.logicalRowKey)).size !== logicalRows.length) {
    throw new Error("A2 stopped manifest does not contain 264 unique logical rows");
  }
  const expectedByKey = new Map(logicalRows.map((row) => [String(row.logicalRowKey), row]));
  const sourceByLogicalKey = new Map<string, {
    row: JsonRecord;
    classification: A2CarryClass;
    binding: CarrySourceBinding;
  }>();
  for (const row of stopped.rows) {
    const logicalKey = typeof row.logicalRowKey === "string" ? row.logicalRowKey : null;
    const attemptKey = typeof row.attemptKey === "string" ? row.attemptKey : null;
    if (!logicalKey || !attemptKey || sourceByLogicalKey.has(logicalKey)) {
      throw new Error("A2 stopped report has a duplicate or invalid logical identity");
    }
    const expected = expectedByKey.get(logicalKey);
    const settlement = stopped.settlements.get(attemptKey);
    if (!expected || !settlement) {
      throw new Error("A2 stopped report row is outside its manifest or ledger");
    }
    const classification = classifyA2SourceRow(carryClassificationFacts(row, settlement));
    const binding = validateSourceRow(stopped, row, expected, classification, settlement);
    sourceByLogicalKey.set(logicalKey, { row, classification, binding });
  }
  if (stopped.settlements.size !== stopped.rows.length) {
    throw new Error("A2 stopped ledger and report are not a complete bijection");
  }
  const privateLogicalRows: CarryLogicalRow[] = logicalRows.map((logical) => {
    const logicalKey = String(logical.logicalRowKey);
    const source = sourceByLogicalKey.get(logicalKey);
    return {
      logicalRowKey: logicalKey,
      questionId: String(logical.questionId),
      repeat: Number(logical.repeat),
      armExecutionOrder: logical.armExecutionOrder,
      class: source?.classification ?? "untouched",
      ...(source ? { source: source.binding } : {}),
    };
  });
  const counts = deriveA2FrozenCarryCounts(privateLogicalRows.map((row) => row.class));
  const runtime = {
    corpusVersion: stopped.manifest.corpusVersion,
    pipelineVersion: stopped.manifest.pipelineVersion,
    configVersion: stopped.manifest.configVersion,
    models: stopped.manifest.models,
    cohereUsdPerThousandSearchUnits: stopped.manifest.cohereUsdPerThousandSearchUnits,
  };
  const manifest: A2QualityCarryManifest = {
    schemaVersion: A2_QUALITY_CARRY_SCHEMA_VERSION,
    definitionSha256: input.definitionSha256,
    sourceEvidence: {
      original: evidenceBinding(original.descriptor) as A2QualityCarryManifest["sourceEvidence"]["original"],
      stopped: evidenceBinding(stopped.descriptor) as A2QualityCarryManifest["sourceEvidence"]["stopped"],
    },
    experiment: {
      questionsSha256: sha256A2Canonical(stopped.manifest.questions),
      logicalRowsSha256: sha256A2Canonical(stopped.manifest.logicalRows),
      runtimeSha256: sha256A2Canonical(runtime),
      repeats: Number(stopped.manifest.repeats),
      totalLogicalRows: logicalRows.length,
    },
    counts,
    logicalRows: privateLogicalRows,
  };
  const carriedEntries = [...sourceByLogicalKey.values()].filter((entry) =>
    entry.classification === "strict" || entry.classification === "quality_only");
  const carriedLogicalKeys = new Set(privateLogicalRows.filter((row) =>
    row.class === "strict" || row.class === "quality_only").map((row) => row.logicalRowKey));
  const pendingPaidLogicalKeys = new Set(privateLogicalRows.filter((row) =>
    row.class === "source_degraded_retry" || row.class === "untouched").map((row) => row.logicalRowKey));
  const sourceDegradedRetryLogicalKeys = new Set(privateLogicalRows.filter((row) =>
    row.class === "source_degraded_retry").map((row) => row.logicalRowKey));
  const untouchedLogicalKeys = new Set(privateLogicalRows.filter((row) =>
    row.class === "untouched").map((row) => row.logicalRowKey));
  return {
    manifest,
    manifestSha256: sha256A2Canonical(manifest),
    counts,
    carriedLogicalKeys,
    pendingPaidLogicalKeys,
    sourceDegradedRetryLogicalKeys,
    untouchedLogicalKeys,
    carriedQualityRows: carriedEntries.map((entry) => entry.row),
    sourceReliabilityRows: stopped.rows,
  };
}

export function a2QualityCarryPath(evidenceRoot: string): string {
  return resolve(evidenceRoot, A2_QUALITY_CARRY_FILE);
}

export function assertStoredA2QualityCarryManifest(
  path: string,
  state: A2QualityCarryState,
): void {
  if (!existsSync(path)) throw new Error("A2 ignored quality-carry manifest is missing");
  const saved = readJson(path);
  if (sha256A2Canonical(saved) !== state.manifestSha256
    || canonicalA2Json(saved) !== canonicalA2Json(state.manifest)) {
    throw new Error("A2 ignored quality-carry manifest differs from the frozen evidence");
  }
}

export function createStoredA2QualityCarryManifest(
  path: string,
  state: A2QualityCarryState,
): void {
  if (existsSync(path)) {
    assertStoredA2QualityCarryManifest(path, state);
    return;
  }
  writeJsonDurably(path, state.manifest, true);
  assertStoredA2QualityCarryManifest(path, state);
}

export function redactedA2CarrySummary(state: A2QualityCarryState) {
  return {
    schemaVersion: state.manifest.schemaVersion,
    carryManifestSha256: state.manifestSha256,
    counts: state.counts,
    priorCommittedMicrousd: A2_PRIOR_COMMITTED_MICROUSD,
    continuationMaxMicrousd: A2_CONTINUATION_MAX_MICROUSD,
    lifetimeMaxMicrousd: A2_LIFETIME_MAX_MICROUSD,
  };
}

export function assertA2EvidenceAuditEnvironment(): void {
  const forbiddenModes = [
    "A2_MODE",
    "A2_PAID_RUN_APPROVED",
    "A2_RETRY_APPROVAL",
  ];
  const present = Object.entries(process.env).flatMap(([name, value]) => {
    const liveCredentialOrUrl = /^(?:GEMINI|VOYAGE|COHERE|SUPABASE|NEXT_PUBLIC_SUPABASE)_/u
      .test(name);
    return value && (forbiddenModes.includes(name) || liveCredentialOrUrl) ? [name] : [];
  });
  if (present.length > 0) {
    throw new Error("A2 local evidence audit requires all live credentials, URLs, and modes to be cleared");
  }
}
