/**
 * a2-rerank-comparison.live.ts — Approval-gated paid A2 comparison.
 *
 * This is intentionally excluded from ordinary `npm test`. It calls the real
 * query planner, Voyage embeddings, read-only Supabase retrieval, and Cohere.
 * For each question/repeat, runSearchV2 prepares retrieval once. Its private
 * executor checkpoints the exact rerank pool before any Cohere call, runs both
 * arms on that same object, and returns only current Arm A to the pipeline.
 * It runs the fixed 65-question key plus the separately labeled Śrāddha case
 * required by the replacement gate, because the fixed key contains no such row.
 *
 * Artifacts contain corpus text and stable internal passage ids. They are saved
 * only below the ignored local `work/a2-rerank-comparison/` directory and must
 * never be copied into the public API or committed.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";
import { VOYAGE_CONTEXT_MODEL } from "@/app/lib/03-embed";
import { COHERE_RERANK_MODEL } from "@/app/lib/08-cohere-rerank";
import {
  geminiQueryPlannerModel,
  searchConfigVersion,
  searchCorpusVersion,
  searchPipelineVersion,
} from "@/app/lib/search-v2/config";
import { runSearchV2 } from "@/app/lib/search-v2/pipeline";
import {
  QUERY_PLANNER_MAX_OUTPUT_TOKENS,
  QUERY_PLANNER_THINKING_BUDGET,
  type PlannerUsage,
} from "@/app/lib/search-v2/query-plan";
import {
  RERANK_ARMS,
  RERANK_BATCH_SIZE,
  RERANK_COMPARISON_TOP_N,
  RERANK_FINAL_POOL,
  buildPrivateRerankPoolArtifact,
  compareRerankArms,
  type PrivateRerankPoolArtifact,
  type PreparedRerankPool,
  type RankedCandidate,
  type RerankComparisonArmOutcome,
  type RerankComparisonOutcome,
} from "@/app/lib/search-v2/rerank";
import type { RpcCapableClient } from "@/app/lib/search-v2/rpc";
import goldSetJson from "@/tests/gold/gold-set-v1.json";
import suggestionSetJson from "@/tests/gold/gold-set-v1-suggestions.json";
import {
  A2_BUDGET_DEFINITION,
  A2_SPEND_LEDGER_SCHEMA_VERSION,
  A2RunLock,
  A2SpendLedger,
  a2RetryApproval,
  chargeA2Row,
  microusdToUsd,
  reserveA2Row,
  usdToMicrousdCeiling,
  writeJsonDurably,
  type A2KnownRowUsage,
} from "@/tests/a2-spend-budget";

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

const goldSet = goldSetJson as {
  schema_version: string;
  corpus_version: string;
  questions: GoldQuestion[];
};
const suggestionSet = suggestionSetJson as {
  schema_version: string;
  gold_set_schema_version: string;
  gold_set_fingerprint_sha256: string;
  corpus_version: string;
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
const runQuestions = [...goldSet.questions, ...supplementalQuestions];
const A2_SCHEMA_VERSION = "a2-rerank-comparison-v5";
const A2_MANIFEST_SCHEMA_VERSION = "a2-run-manifest-v2";
const A2_RETRY_MANIFEST_SCHEMA_VERSION = "a2-retry-manifest-v1";
const A2_APPROVED_RUN_ID = "a2-20260808-validator-restart";
const A2_SUPABASE_PROJECT_REF = "wzktlpjtqmjxvragwhqg";
const A2_LIFETIME_MAX_MICROUSD = 25_000_000;
const A2_PRIOR_COMMITTED_MICROUSD = 2_716_439;
const A2_RESTART_MAX_MICROUSD = A2_LIFETIME_MAX_MICROUSD - A2_PRIOR_COMMITTED_MICROUSD;
const A2_PRIOR_EVIDENCE = Object.freeze({
  runId: "a2-20260808-owner-approved-25usd",
  definitionSha256: "3481a216f29568a71e3004d294492331407eff3d61ad0139c7318315abe63b14",
  manifestSha256: "b8026c4d6df6a46c9b931ab39e3ea4d34df80b47cc74f4b4a89b8d35769f70c7",
  files: Object.freeze({
    "comparison-report.json": "3df3f0989a91b220dc8bbf7213972611c96725f864cda3c143b0b44a133bac8c",
    "retry-manifest.json": "406747da0cb5c9aba32f9bb6fdfb4dc0b76a5a3f01e8937e6e875b2882083528",
    "run-manifest.json": "aef81cde3265aa125801b1f9dc8c6c39487993d3420b71f251bd170ca28950c8",
    "spend-ledger.jsonl": "c1e68fcc6c3d6a609c8fc43795b78e048bee9922ddf9d6145d4aa55e149f833a",
    "pools/q001-r01-a02.json": "ba9776edf7ad3e9fbb935c3fc619ca232cd2b72c03f6806d2e06ce56a842aee5",
  }),
});
const A2_LIFETIME_BUDGET = Object.freeze({
  lifetimeMaxTotalUsd: microusdToUsd(A2_LIFETIME_MAX_MICROUSD),
  priorRunId: A2_PRIOR_EVIDENCE.runId,
  priorCommittedUsd: microusdToUsd(A2_PRIOR_COMMITTED_MICROUSD),
  currentRunMaxTotalUsd: microusdToUsd(A2_RESTART_MAX_MICROUSD),
  priorEvidence: A2_PRIOR_EVIDENCE,
});

type A2Mode = "PRECHECK" | "RUN" | "RECOVER";

export interface A2Preflight {
  mode: A2Mode;
  repeats: number;
  usdPerThousandSearchUnits: number;
  maxTotalUsd: number;
  runId: string;
  runDirectory: string;
  definitionSha256: string;
  supabaseOrigin: string;
  resumed: boolean;
}

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
    throw new Error(`${question.id} has no complete owner-review suggestion`);
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

function privateTop(candidate: RankedCandidate): RankedPrivatePassage {
  return {
    passageId: candidate.passage_key,
    alternatePassageIds: candidate.alternates.map((alternate) => alternate.passageKey),
    sourceType: candidate.source_type,
    reference: candidate.reference,
    recipient: candidate.recipient,
    occurredOn: candidate.occurred_on,
    location: candidate.location,
    rerankScore: candidate.rerankScore,
  };
}

function candidateMatchesId(candidate: RankedCandidate, passageId: string): boolean {
  return candidate.passage_key === passageId
    || candidate.alternates.some((alternate) => alternate.passageKey === passageId);
}

function includesFolded(value: string | null, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  return (value ?? "").toLocaleLowerCase("en").includes(expected.toLocaleLowerCase("en"));
}

function candidateMatchesMetadata(candidate: RankedCandidate, rule: RequiredMetadata): boolean {
  return (rule.source_type === undefined || candidate.source_type === rule.source_type)
    && (rule.recipient_required !== true || Boolean(candidate.recipient?.trim()))
    && includesFolded(candidate.recipient, rule.recipient_contains)
    && (rule.occurred_on_required !== true || Boolean(candidate.occurred_on?.trim()))
    && includesFolded(candidate.location, rule.location_contains)
    && includesFolded(candidate.reference, rule.reference_contains)
    && (
      rule.occurred_year === undefined
      || candidate.occurred_on?.slice(0, 4) === String(rule.occurred_year)
    );
}

function scoreTop(top: RankedCandidate[], labels: ActiveLabels) {
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
  const hasNoUnacceptableEvidence = unacceptableHits.length === 0;
  const automaticPass = labels.evaluationKind === "passage_ids"
    ? foundExpected.length > 0 && hasNoUnacceptableEvidence
    : labels.evaluationKind === "metadata"
      ? foundMetadata.length > 0 && hasNoUnacceptableEvidence
      : null;
  return {
    automaticPass,
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

function jaccard(a: string[], b: string[]): number {
  const left = new Set(a);
  const right = new Set(b);
  const union = new Set([...left, ...right]);
  if (union.size === 0) return 1;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / union.size;
}

function safeFailure(error: unknown): Record<string, unknown> {
  if (!error || typeof error !== "object") return { name: "UnknownFailure" };
  const value = error as Record<string, unknown>;
  return {
    name: typeof value.name === "string" ? value.name : "Error",
    code: typeof value.code === "string" ? value.code : null,
    stage: typeof value.stage === "string" ? value.stage : null,
    source: typeof value.source === "string" ? value.source : null,
  };
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileValue / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sourceFilesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFilesBelow(path);
    return /\.(?:[cm]?[jt]sx?|json)$/u.test(entry.name) ? [path] : [];
  });
}

function runDefinitionSha256(
  repeats: number,
  usdPerThousandSearchUnits: number,
  maxTotalUsd: number,
): string {
  const root = resolve(".");
  const files = [
    ...sourceFilesBelow(resolve("app/lib")),
    resolve("tests/a2-spend-budget.ts"),
    resolve("tests/a2-rerank-comparison.live.ts"),
    resolve("tests/gold/gold-set-v1.json"),
    resolve("tests/gold/gold-set-v1-suggestions.json"),
    resolve("package.json"),
    resolve("package-lock.json"),
    resolve("vitest.a2.config.ts"),
  ].sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    schemaVersion: A2_SCHEMA_VERSION,
    repeats,
    usdPerThousandSearchUnits,
    maxTotalUsd,
    budgetDefinition: A2_BUDGET_DEFINITION,
    lifetimeBudget: A2_LIFETIME_BUDGET,
    approvedRunId: A2_APPROVED_RUN_ID,
    supabaseProjectRef: A2_SUPABASE_PROJECT_REF,
    runtime: {
      pipelineVersion: searchPipelineVersion(),
      corpusVersion: searchCorpusVersion(),
      configVersion: searchConfigVersion(),
      geminiQueryPlannerModel: geminiQueryPlannerModel(),
      voyageEmbeddingModel: VOYAGE_CONTEXT_MODEL,
      cohereRerankModel: COHERE_RERANK_MODEL,
    },
  }));
  for (const path of files) {
    hash.update("\0");
    hash.update(relative(root, path).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(path));
  }
  return hash.digest("hex");
}

function writeJson(path: string, value: unknown, exclusive = false): void {
  writeJsonDurably(path, value, exclusive);
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function assertPriorRunEvidence(): void {
  const directory = resolve("work/a2-rerank-comparison", A2_PRIOR_EVIDENCE.runId);
  for (const [relativePath, expectedSha256] of Object.entries(A2_PRIOR_EVIDENCE.files)) {
    const path = join(directory, ...relativePath.split("/"));
    if (!existsSync(path) || sha256File(path) !== expectedSha256) {
      throw new Error(`A2 prior-run evidence differs at ${relativePath}`);
    }
  }
  const poolFiles = readdirSync(join(directory, "pools")).sort();
  if (JSON.stringify(poolFiles) !== JSON.stringify(["q001-r01-a02.json"])) {
    throw new Error("A2 prior-run pool evidence differs from the carry-forward definition");
  }
  const checkpoint = JSON.parse(
    readFileSync(join(directory, "comparison-report.json"), "utf8"),
  ) as Record<string, unknown>;
  if (checkpoint.runId !== A2_PRIOR_EVIDENCE.runId
    || checkpoint.definitionSha256 !== A2_PRIOR_EVIDENCE.definitionSha256
    || checkpoint.manifestSha256 !== A2_PRIOR_EVIDENCE.manifestSha256
    || checkpoint.maxTotalUsd !== A2_LIFETIME_BUDGET.lifetimeMaxTotalUsd
    || checkpoint.budgetCommittedUsd !== A2_LIFETIME_BUDGET.priorCommittedUsd
    || checkpoint.completedRows !== 1
    || checkpoint.attempts !== 4
    || !Array.isArray(checkpoint.budgetOpenAttempts)
    || checkpoint.budgetOpenAttempts.length !== 0) {
    throw new Error("A2 prior-run checkpoint does not prove the carry-forward amount");
  }
}

export function recoveryStateAvailable(
  restartStateExists: boolean,
  priorLockPath: string,
): boolean {
  return restartStateExists || existsSync(priorLockPath);
}

function logicalRowKey(questionId: string, repeat: number): string {
  return `${questionId}:${repeat}`;
}

function attemptKey(logicalKey: string, attempt: number): string {
  return `${logicalKey}@${attempt}`;
}

function armOrderFor(questionIndex: number, repeat: number) {
  return (questionIndex + repeat - 1) % 2 === 0
    ? [RERANK_ARMS.current, RERANK_ARMS.global] as const
    : [RERANK_ARMS.global, RERANK_ARMS.current] as const;
}

export function buildRunManifest(preflight: A2Preflight) {
  const manifest = {
    schemaVersion: A2_MANIFEST_SCHEMA_VERSION,
    runSchemaVersion: A2_SCHEMA_VERSION,
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    supabaseOrigin: preflight.supabaseOrigin,
    corpusVersion: searchCorpusVersion(),
    pipelineVersion: searchPipelineVersion(),
    configVersion: searchConfigVersion(),
    nodeVersion: process.version,
    repeats: preflight.repeats,
    maxTotalUsd: preflight.maxTotalUsd,
    lifetimeBudget: A2_LIFETIME_BUDGET,
    cohereUsdPerThousandSearchUnits: preflight.usdPerThousandSearchUnits,
    budgetDefinition: A2_BUDGET_DEFINITION,
    models: {
      gemini: geminiQueryPlannerModel(),
      voyage: VOYAGE_CONTEXT_MODEL,
      cohere: COHERE_RERANK_MODEL,
    },
    questions: runQuestions.map((question) => ({
      id: question.id,
      category: question.category,
      questionSha256: createHash("sha256").update(question.question).digest("hex"),
      labelsSha256: sha256Json(activeLabels(question)),
      supplemental: question.id.startsWith("supplemental-"),
    })),
    logicalRows: Array.from({ length: preflight.repeats }, (_, repeatIndex) =>
      runQuestions.map((question, questionIndex) => ({
        logicalRowKey: logicalRowKey(question.id, repeatIndex + 1),
        questionId: question.id,
        repeat: repeatIndex + 1,
        armExecutionOrder: armOrderFor(questionIndex, repeatIndex + 1),
      }))).flat(),
  };
  return { ...manifest, manifestSha256: sha256Json(manifest) };
}

export function paidRunApproval(
  preflight: A2Preflight,
  manifestSha256: string,
): string {
  const digest = sha256Json({
    schemaVersion: "a2-paid-run-approval-v2",
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256,
    maxMicrousd: usdToMicrousdCeiling(preflight.maxTotalUsd),
    lifetimeBudget: A2_LIFETIME_BUDGET,
  });
  return `I_APPROVE_PAID_A2:${digest}`;
}

function assertPreflight(): A2Preflight {
  const mode = process.env.A2_MODE;
  if (mode !== "PRECHECK" && mode !== "RUN" && mode !== "RECOVER") {
    throw new Error("A2_MODE must be exactly PRECHECK, RUN, or RECOVER");
  }
  if (goldSet.questions.length !== 65) {
    throw new Error(`A2 expected exactly 65 questions, found ${goldSet.questions.length}`);
  }
  const goldFingerprint = createHash("sha256")
    .update(JSON.stringify(goldSetJson))
    .digest("hex");
  if (suggestionSet.schema_version !== "gold-set-suggestions-v1"
    || suggestionSet.gold_set_schema_version !== goldSet.schema_version
    || suggestionSet.gold_set_fingerprint_sha256 !== goldFingerprint
    || suggestionSet.corpus_version !== goldSet.corpus_version
    || searchCorpusVersion() !== goldSet.corpus_version) {
    throw new Error("A2 gold, suggestions, and runtime corpus versions are not compatible");
  }
  for (const question of runQuestions) activeLabels(question);
  if (supplementalQuestions.length !== 1
    || !/(?:śrāddha|sraddha|shraddha)/iu.test(supplementalQuestions[0].question)) {
    throw new Error("A2 requires one explicit supplemental Śrāddha difficult case");
  }

  const repeats = Number(process.env.A2_REPEATS ?? "4");
  if (repeats !== 4) {
    throw new Error("A2_REPEATS must equal the owner-approved value of 4");
  }
  const priceText = process.env.A2_COHERE_USD_PER_1000_SEARCH_UNITS;
  const usdPerThousandSearchUnits = Number(priceText);
  if (priceText === undefined || usdPerThousandSearchUnits !== 2.50) {
    throw new Error("A2_COHERE_USD_PER_1000_SEARCH_UNITS must equal the owner-approved rate of 2.50");
  }
  for (const question of runQuestions) {
    reserveA2Row(question.question, usdPerThousandSearchUnits);
  }
  const maxTotalText = process.env.A2_MAX_TOTAL_USD;
  const maxTotalUsd = Number(maxTotalText);
  if (maxTotalText === undefined
    || !Number.isFinite(maxTotalUsd)
    || maxTotalUsd !== A2_LIFETIME_BUDGET.currentRunMaxTotalUsd) {
    throw new Error(
      `A2_MAX_TOTAL_USD must equal the remaining lifetime allowance of ${A2_LIFETIME_BUDGET.currentRunMaxTotalUsd}`,
    );
  }
  assertPriorRunEvidence();
  if (geminiQueryPlannerModel() !== A2_BUDGET_DEFINITION.geminiModel
    || VOYAGE_CONTEXT_MODEL !== A2_BUDGET_DEFINITION.voyageModel
    || COHERE_RERANK_MODEL !== A2_BUDGET_DEFINITION.cohereModel) {
    throw new Error("A2 provider model differs from the owner-approved budget definition");
  }
  if (RERANK_BATCH_SIZE !== 200
    || RERANK_FINAL_POOL !== 200
    || RERANK_COMPARISON_TOP_N !== 20) {
    throw new Error("A2 Cohere request constants differ from the approved spend ceiling");
  }
  if (QUERY_PLANNER_MAX_OUTPUT_TOKENS
      !== A2_BUDGET_DEFINITION.geminiMaxOutputTokensPerAttempt
    || QUERY_PLANNER_THINKING_BUDGET !== 0) {
    throw new Error("A2 Gemini request constants differ from the approved spend ceiling");
  }
  const plannerSource = readFileSync(resolve("app/lib/search-v2/query-plan.ts"), "utf8");
  const voyageSource = readFileSync(resolve("app/lib/03-embed.ts"), "utf8");
  const cohereSource = readFileSync(resolve("app/lib/08-cohere-rerank.ts"), "utf8");
  if (!plannerSource.includes("for (let attempt = 1; attempt <= 2; attempt += 1)")
    || (plannerSource.match(/models\.generateContent\(/gu) ?? []).length !== 1
    || (voyageSource.match(/await fetch\(/gu) ?? []).length !== 1
    || !voyageSource.includes('input_type: "query"')
    || (cohereSource.match(/await fetch\(/gu) ?? []).length !== 1
    || !cohereSource.includes("const MAX_TOKENS_PER_DOC = 4096;")) {
    throw new Error("A2 provider call shape differs from the approved spend ceiling");
  }

  const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!supabaseUrl) throw new Error("A2 requires the exact owner-approved SUPABASE_URL");
  let parsedSupabaseUrl: URL;
  try {
    parsedSupabaseUrl = new URL(supabaseUrl);
  } catch {
    throw new Error("A2 Supabase URL is malformed");
  }
  const supabaseOrigin = `https://${A2_SUPABASE_PROJECT_REF}.supabase.co`;
  if (parsedSupabaseUrl.origin !== supabaseOrigin
    || parsedSupabaseUrl.protocol !== "https:"
    || parsedSupabaseUrl.pathname !== "/"
    || parsedSupabaseUrl.search !== ""
    || parsedSupabaseUrl.hash !== ""
    || parsedSupabaseUrl.username !== ""
    || parsedSupabaseUrl.password !== "") {
    throw new Error("A2 Supabase URL is not the exact HTTPS origin of the owner-approved corpus project");
  }

  const definitionSha256 = runDefinitionSha256(
    repeats,
    usdPerThousandSearchUnits,
    maxTotalUsd,
  );

  const runId = process.env.A2_RUN_ID;
  if (runId !== A2_APPROVED_RUN_ID) {
    throw new Error(`A2_RUN_ID must equal the single owner-approved id ${A2_APPROVED_RUN_ID}`);
  }
  // Private corpus text is allowed only in this gitignored, repository-local directory.
  const outputRoot = resolve("work/a2-rerank-comparison");
  const runDirectory = join(outputRoot, runId);
  let resumed = existsSync(runDirectory);
  if (resumed) {
    const entries = readdirSync(runDirectory);
    const poolsDirectory = join(runDirectory, "pools");
    if (entries.length === 1 && entries[0] === "pools"
      && existsSync(poolsDirectory) && readdirSync(poolsDirectory).length === 0) {
      // A process can stop after creating the empty private directory but
      // before acquiring the lock. No ledger or client can exist yet, so this
      // exact empty shape is safe to initialize as a fresh run.
      resumed = false;
    }
  }
  if (mode === "RUN") {
    const required = ["VOYAGE_API_KEY", "GEMINI_API_KEY", "COHERE_API_KEY", "SUPABASE_SERVICE_KEY"];
    const missing = required.filter((name) => !process.env[name]);
    if (missing.length > 0) throw new Error(`A2 paid run is missing ${missing.join(", ")}`);
    if (resumed && process.env.A2_RESUME_RUN !== "I_APPROVE_RESUME_A2") {
      throw new Error("A2 run directory exists; use the exact resume marker instead of paying twice");
    }
    if (!resumed && process.env.A2_RESUME_RUN) {
      throw new Error("A2 resume marker was supplied but no approved run directory exists");
    }
  } else if (mode === "RECOVER") {
    const priorLockPath = join(
      resolve("work/a2-rerank-comparison", A2_PRIOR_EVIDENCE.runId),
      "paid-run.lock",
    );
    if (!recoveryStateAvailable(resumed, priorLockPath)) {
      throw new Error("A2 recovery requires restart state or the prior lifetime lock");
    }
    if (process.env.A2_RESUME_RUN !== "I_APPROVE_RESUME_A2") {
      throw new Error("A2 recovery requires the exact approved-run resume marker");
    }
  }

  return {
    mode,
    repeats,
    usdPerThousandSearchUnits,
    maxTotalUsd,
    runId,
    runDirectory,
    definitionSha256,
    supabaseOrigin,
    resumed,
  };
}

function armTotals(rows: Array<Record<string, unknown>>, arm: "current" | "global") {
  const outcomes = rows.flatMap((row) => {
    const arms = row.arms as Record<string, RerankComparisonArmOutcome> | undefined;
    return arms?.[arm] ? [arms[arm]] : [];
  });
  const requests = outcomes.flatMap((outcome) => outcome.providerRequests);
  const allUnitsKnown = requests.length > 0 && requests.every((request) =>
    request.responseSucceeded === true && request.billedSearchUnits !== null);
  const timingSamples = rows.flatMap((row) => {
    const timing = row.searchToTop20Ms as Record<string, number> | undefined;
    const value = timing?.[arm];
    const order = Array.isArray(row.armExecutionOrder)
      ? row.armExecutionOrder as string[]
      : [];
    const position = order.indexOf(arm);
    return value === undefined || position < 0 ? [] : [{ value, position: position + 1 }];
  });
  const timingSummary = (position?: number) => {
    const values = timingSamples
      .filter((sample) => position === undefined || sample.position === position)
      .map((sample) => sample.value);
    return {
      samples: values.length,
      medianMs: percentile(values, 50),
      slowestMs: values.length > 0 ? Math.max(...values) : null,
    };
  };
  return {
    calls: sum(outcomes.map((outcome) => outcome.providerCallCount)),
    documentSubmissions: sum(outcomes.map((outcome) => outcome.documentCount)),
    failedOrUnknownProviderResponses: requests.filter((request) => request.responseSucceeded !== true).length,
    billedSearchUnits: allUnitsKnown
      ? sum(requests.map((request) => request.billedSearchUnits!))
      : null,
    searchToTop20Ms: timingSummary(),
    searchToTop20MsByExecutionPosition: {
      first: timingSummary(1),
      second: timingSummary(2),
    },
  };
}

export function assertCompleteRow(row: Record<string, unknown>, key: string): void {
  if (typeof row.poolSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.poolSha256)) {
    throw new Error(`A2 completed row has no valid pool hash: ${key}`);
  }
  const timing = row.searchToTop20Ms as Record<string, unknown> | undefined;
  const order = Array.isArray(row.armExecutionOrder) ? row.armExecutionOrder : [];
  const arms = row.arms as Record<string, Record<string, unknown>> | undefined;
  const candidateCount = finiteCount(row.candidateCount);
  const sharedPreparationMs = row.sharedPreparationMs;
  const pipelineTotalMs = row.comparisonPipelineTotalMs;
  if (!timing || !arms || candidateCount === null || candidateCount < 2 || candidateCount > 400
    || order.length !== 2 || new Set(order).size !== 2
    || !order.includes(RERANK_ARMS.current) || !order.includes(RERANK_ARMS.global)
    || typeof sharedPreparationMs !== "number" || !Number.isFinite(sharedPreparationMs)
    || sharedPreparationMs < 0
    || typeof pipelineTotalMs !== "number" || !Number.isFinite(pipelineTotalMs)
    || pipelineTotalMs < 0) {
    throw new Error(`A2 completed row is missing comparison structure: ${key}`);
  }
  for (const arm of [RERANK_ARMS.current, RERANK_ARMS.global]) {
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
        const value = request as Record<string, unknown>;
        return value.responseSucceeded !== true
          || typeof value.documentCount !== "number"
          || !Number.isSafeInteger(value.documentCount) || value.documentCount < 2
          || typeof value.topN !== "number"
          || !Number.isSafeInteger(value.topN) || value.topN < 1;
      })) {
      throw new Error(`A2 completed row has an invalid ${arm} outcome: ${key}`);
    }
    const documentCounts = (requests as Array<Record<string, unknown>>)
      .map((request) => Number(request.documentCount));
    const requestTopNs = (requests as Array<Record<string, unknown>>)
      .map((request) => Number(request.topN));
    if (sum(documentCounts) !== outcome.documentCount) {
      throw new Error(`A2 completed row has inconsistent ${arm} document accounting: ${key}`);
    }
    if (arm === RERANK_ARMS.global) {
      if (documentCounts.length !== 1
        || documentCounts[0] !== candidateCount
        || requestTopNs[0] !== Math.min(RERANK_COMPARISON_TOP_N, candidateCount)) {
        throw new Error(`A2 completed row has an invalid global Cohere request shape: ${key}`);
      }
      continue;
    }

    const expectedFirstPassCounts: number[] = [];
    for (let offset = 0; offset < candidateCount; offset += RERANK_BATCH_SIZE) {
      const count = Math.min(RERANK_BATCH_SIZE, candidateCount - offset);
      // The low-level helper handles a singleton locally, without a network request.
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
      throw new Error(`A2 completed row has an invalid current Cohere request shape: ${key}`);
    }
  }
  if (row.pipelineDegraded !== false || row.providerUsageComplete !== true) {
    throw new Error(`A2 completed row is degraded or lacks complete provider usage: ${key}`);
  }
  const planner = row.plannerUsage as Record<string, unknown> | undefined;
  const attemptDurations = planner?.attemptDurationsMs;
  if (!planner || planner.attempts !== 1
    || !Array.isArray(attemptDurations) || attemptDurations.length !== 1
    || attemptDurations.some((value) => typeof value !== "number"
      || !Number.isFinite(value) || value < 0)
    || typeof planner.durationMs !== "number" || !Number.isFinite(planner.durationMs)
    || planner.durationMs < 0
    || finiteCount(row.embeddingProviderCalls) !== 1) {
    throw new Error(`A2 completed row has invalid paid-provider timing or call counts: ${key}`);
  }
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function knownUsageForBudget(row: Record<string, unknown>): A2KnownRowUsage | null {
  if (row.status !== "complete") return null;
  const arms = row.arms as Record<string, RerankComparisonArmOutcome> | undefined;
  const requests = arms
    ? [...arms.current.providerRequests, ...arms.global.providerRequests]
    : [];
  const cohereSearchUnits = requests.length > 0 && requests.every((request) =>
    request.responseSucceeded === true
      && finiteCount(request.billedSearchUnits) !== null)
    ? sum(requests.map((request) => request.billedSearchUnits!))
    : null;
  const planner = row.plannerUsage as Record<string, unknown> | undefined;
  return {
    cohereSearchUnits,
    geminiAttempts: finiteCount(planner?.attempts),
    geminiPromptTokens: finiteCount(planner?.promptTokens),
    geminiOutputTokens: finiteCount(planner?.outputTokens),
    geminiThoughtsTokens: finiteCount(planner?.thoughtsTokens),
    voyageProviderCalls: finiteCount(row.embeddingProviderCalls),
  };
}

function assertBudgetedCoherePool(pool: PreparedRerankPool): void {
  const pinnedCount = pool.candidates.filter((candidate) => candidate.pinned).length;
  if (pool.candidates.length > 400 || pool.documents.length !== pool.candidates.length) {
    throw new Error("A2 candidate pool exceeds the approved Cohere budget shape");
  }
  if (pinnedCount > 1) {
    throw new Error("A2 candidate pool has more than one pinned passage; Cohere budget is invalid");
  }
}

function runtimeModels() {
  return {
    gemini: geminiQueryPlannerModel(),
    voyage: VOYAGE_CONTEXT_MODEL,
    cohere: COHERE_RERANK_MODEL,
  };
}

function poolArtifactPath(questionId: string, repeat: number, attempt: number): string {
  return `pools/${questionId}-r${String(repeat).padStart(2, "0")}-a${String(attempt).padStart(2, "0")}.json`;
}

export function plannedRows(preflight: A2Preflight) {
  return Array.from({ length: preflight.repeats }, (_, repeatIndex) =>
    runQuestions.map((question, questionIndex) => ({
      logicalRowKey: logicalRowKey(question.id, repeatIndex + 1),
      question,
      questionIndex,
      repeat: repeatIndex + 1,
      armExecutionOrder: armOrderFor(questionIndex, repeatIndex + 1),
    }))).flat();
}

function privateCandidateMatchesId(
  candidate: RankedPrivatePassage,
  passageId: string,
): boolean {
  return candidate.passageId === passageId
    || candidate.alternatePassageIds.includes(passageId);
}

function privateCandidateMatchesMetadata(
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
      const index = top.findIndex((candidate) => privateCandidateMatchesId(candidate, passageId));
      return index < 0 ? null : index + 1;
    })(),
  }));
  const unacceptableHits = labels.unacceptableIds.flatMap((passageId) => {
    const index = top.findIndex((candidate) => privateCandidateMatchesId(candidate, passageId));
    return index < 0 ? [] : [{ passageId, position: index + 1 }];
  });
  const metadataPositions = labels.requiredMetadata.map((rule) => {
    const index = top.findIndex((candidate) => privateCandidateMatchesMetadata(candidate, rule));
    return { rule, position: index < 0 ? null : index + 1 };
  });
  const foundExpected = expectedPositions.filter((item) => item.position !== null);
  const foundMetadata = metadataPositions.filter((item) => item.position !== null);
  const hasNoUnacceptableEvidence = unacceptableHits.length === 0;
  return {
    automaticPass: labels.evaluationKind === "passage_ids"
      ? foundExpected.length > 0 && hasNoUnacceptableEvidence
      : labels.evaluationKind === "metadata"
        ? foundMetadata.length > 0 && hasNoUnacceptableEvidence
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
      currentTop.some((candidate) => privateCandidateMatchesId(candidate, passageId))
      && !globalTop.some((candidate) => privateCandidateMatchesId(candidate, passageId))),
    importantAppeared: labels.expectedIds.filter((passageId) =>
      !currentTop.some((candidate) => privateCandidateMatchesId(candidate, passageId))
      && globalTop.some((candidate) => privateCandidateMatchesId(candidate, passageId))),
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

function assertPoolArtifact(
  preflight: A2Preflight,
  row: Record<string, unknown>,
  key: string,
): void {
  const expectedRelativePath = poolArtifactPath(
    String(row.questionId),
    Number(row.repeat),
    Number(row.attempt),
  );
  if (row.poolArtifact !== expectedRelativePath) {
    throw new Error(`A2 completed row points to the wrong pool artifact: ${key}`);
  }
  const path = join(preflight.runDirectory, ...expectedRelativePath.split("/"));
  if (!existsSync(path)) throw new Error(`A2 completed row pool artifact is missing: ${key}`);
  const artifact = JSON.parse(readFileSync(path, "utf8")) as PrivateRerankPoolArtifact;
  if (artifact.schemaVersion !== "a2-rerank-pool-v1"
    || artifact.question !== row.question
    || artifact.model !== COHERE_RERANK_MODEL
    || artifact.poolSha256 !== row.poolSha256
    || artifact.candidateCount !== row.candidateCount
    || artifact.candidateCount !== artifact.candidates.length
    || artifact.candidateCount > 400
    || artifact.candidates.filter((candidate) => candidate.pinned).length > 1) {
    throw new Error(`A2 completed row pool artifact is invalid: ${key}`);
  }
  const candidateIds = artifact.candidates.map((candidate) => candidate.passageId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    throw new Error(`A2 completed row pool contains duplicate ids: ${key}`);
  }
  for (const candidate of artifact.candidates) {
    if (candidate.documentSha256 !== createHash("sha256").update(candidate.document).digest("hex")
      || candidate.documentBytes !== Buffer.byteLength(candidate.document, "utf8")) {
      throw new Error(`A2 completed row pool document hash is invalid: ${key}`);
    }
  }
  const poolIdentity = JSON.stringify({
    question: artifact.question,
    model: artifact.model,
    candidates: artifact.candidates.map((candidate) => ({
      passageId: candidate.passageId,
      pinned: candidate.pinned,
      alternatePassageIds: candidate.alternatePassageIds,
      document: candidate.document,
    })),
  });
  if (createHash("sha256").update(poolIdentity).digest("hex") !== artifact.poolSha256) {
    throw new Error(`A2 completed row pool identity hash is invalid: ${key}`);
  }
  const arms = row.arms as Record<string, { top: RankedPrivatePassage[] }>;
  const artifactById = new Map(artifact.candidates.map((candidate) => [candidate.passageId, candidate]));
  for (const arm of [RERANK_ARMS.current, RERANK_ARMS.global]) {
    const ids = arms[arm].top.map((candidate) => candidate.passageId);
    if (new Set(ids).size !== ids.length || ids.some((id) => !candidateIds.includes(id))) {
      throw new Error(`A2 completed row ${arm} top ids do not belong to its pool: ${key}`);
    }
    for (const candidate of arms[arm].top) {
      const source = artifactById.get(candidate.passageId);
      if (!source
        || candidate.sourceType !== source.sourceType
        || candidate.reference !== source.reference
        || candidate.recipient !== source.recipient
        || candidate.occurredOn !== source.occurredOn
        || candidate.location !== source.location
        || JSON.stringify(candidate.alternatePassageIds)
          !== JSON.stringify(source.alternatePassageIds)) {
        throw new Error(`A2 completed row ${arm} top metadata differs from its pool: ${key}`);
      }
    }
  }
}

export function validateAttemptHistory(
  preflight: A2Preflight,
  rows: Array<Record<string, unknown>>,
) {
  const planned = plannedRows(preflight);
  const plannedByKey = new Map(planned.map((row) => [row.logicalRowKey, row]));
  const attemptsByLogical = new Map<string, Array<Record<string, unknown>>>();
  const seenAttempts = new Set<string>();
  const completedRowKeys = new Set<string>();
  for (const row of rows) {
    const questionId = row.questionId;
    const repeat = row.repeat;
    const attempt = row.attempt;
    if (typeof questionId !== "string" || !Number.isSafeInteger(repeat)
      || !Number.isSafeInteger(attempt) || Number(attempt) < 1) {
      throw new Error("A2 checkpoint contains an invalid attempt identity");
    }
    const logicalKey = logicalRowKey(questionId, Number(repeat));
    const key = attemptKey(logicalKey, Number(attempt));
    const expected = plannedByKey.get(logicalKey);
    if (!expected || row.logicalRowKey !== logicalKey || row.attemptKey !== key) {
      throw new Error(`A2 checkpoint attempt is outside this run: ${key}`);
    }
    if (seenAttempts.has(key)) throw new Error(`A2 checkpoint has a duplicate attempt: ${key}`);
    seenAttempts.add(key);
    if (row.question !== expected.question.question
      || row.category !== expected.question.category
      || JSON.stringify(row.armExecutionOrder) !== JSON.stringify(expected.armExecutionOrder)
      || JSON.stringify(row.models) !== JSON.stringify(runtimeModels())) {
      throw new Error(`A2 checkpoint attempt differs from its run manifest: ${key}`);
    }
    const status = row.status;
    if (status !== "complete" && status !== "invalid"
      && status !== "failed" && status !== "interrupted") {
      throw new Error(`A2 checkpoint attempt has an unknown status: ${key}`);
    }
    if (status === "complete") {
      assertCompleteRow(row, key);
      assertPoolArtifact(preflight, row, key);
      const reservation = reserveA2Row(
        expected.question.question,
        preflight.usdPerThousandSearchUnits,
      );
      if (!chargeA2Row(reservation, knownUsageForBudget(row)).completeUsage) {
        throw new Error(`A2 completed row cannot be reconciled from provider usage: ${key}`);
      }
      const arms = row.arms as Record<string, { top: RankedPrivatePassage[] }>;
      const recomputedScores = {
        current: scorePrivateTop(arms.current.top, activeLabels(expected.question)),
        global: scorePrivateTop(arms.global.top, activeLabels(expected.question)),
      };
      if (JSON.stringify(row.scores) !== JSON.stringify(recomputedScores)) {
        throw new Error(`A2 completed row scores do not match its saved rankings: ${key}`);
      }
      const recomputedChanges = changesForPrivateTop(
        arms.current.top,
        arms.global.top,
        activeLabels(expected.question),
        recomputedScores.current,
        recomputedScores.global,
      );
      if (JSON.stringify(row.changes) !== JSON.stringify(recomputedChanges)) {
        throw new Error(`A2 completed row changes do not match its saved rankings: ${key}`);
      }
      if (completedRowKeys.has(logicalKey)) {
        throw new Error(`A2 checkpoint has more than one completed attempt: ${logicalKey}`);
      }
      completedRowKeys.add(logicalKey);
    }
    attemptsByLogical.set(logicalKey, [...(attemptsByLogical.get(logicalKey) ?? []), row]);
  }
  for (const [logicalKey, attempts] of attemptsByLogical) {
    attempts.sort((left, right) => Number(left.attempt) - Number(right.attempt));
    attempts.forEach((row, index) => {
      if (row.attempt !== index + 1) {
        throw new Error(`A2 checkpoint attempt sequence has a gap: ${logicalKey}`);
      }
      if (row.status === "complete" && index !== attempts.length - 1) {
        throw new Error(`A2 checkpoint contains an attempt after completion: ${logicalKey}`);
      }
    });
  }
  return { attemptsByLogical, completedRowKeys };
}

function failureSummaries(rows: Array<Record<string, unknown>>) {
  return rows.filter((row) => row.status !== "complete").map((row) => ({
    logicalRowKey: row.logicalRowKey,
    attemptKey: row.attemptKey,
    questionId: row.questionId,
    repeat: row.repeat,
    attempt: row.attempt,
    kind: row.kind,
    failure: row.failure,
  }));
}

export function checkpointDocument(
  preflight: A2Preflight,
  manifestSha256: string,
  spendLedger: A2SpendLedger,
  rows: Array<Record<string, unknown>>,
) {
  const completedRows = rows.filter((row) => row.status === "complete").length;
  return {
    schemaVersion: A2_SCHEMA_VERSION,
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256,
    repeatsPlanned: preflight.repeats,
    questionsPlanned: runQuestions.length,
    maxTotalUsd: preflight.maxTotalUsd,
    budgetCommittedUsd: microusdToUsd(spendLedger.committedMicrousd()),
    budgetOpenAttempts: spendLedger.openRowKeys(),
    completedRows,
    attempts: rows.length,
    failures: failureSummaries(rows),
    attemptHistory: rows,
  };
}

function loadCheckpoint(
  preflight: A2Preflight,
  manifestSha256: string,
): Array<Record<string, unknown>> {
  const path = join(preflight.runDirectory, "comparison-report.json");
  if (!existsSync(path)) throw new Error("A2 resume checkpoint is missing");
  const checkpoint = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  if (checkpoint.schemaVersion !== A2_SCHEMA_VERSION
    || checkpoint.runId !== preflight.runId
    || checkpoint.definitionSha256 !== preflight.definitionSha256
    || checkpoint.manifestSha256 !== manifestSha256
    || checkpoint.repeatsPlanned !== preflight.repeats
    || checkpoint.questionsPlanned !== runQuestions.length
    || checkpoint.maxTotalUsd !== preflight.maxTotalUsd
    || !Array.isArray(checkpoint.attemptHistory)) {
    throw new Error("A2 resume checkpoint differs from the approved run manifest");
  }
  return checkpoint.attemptHistory as Array<Record<string, unknown>>;
}

function assertLedgerBijection(
  preflight: A2Preflight,
  rows: Array<Record<string, unknown>>,
  spendLedger: A2SpendLedger,
  allowOpenWithoutOutcome: boolean,
): void {
  const rowsByAttempt = new Map(rows.map((row) => [String(row.attemptKey), row]));
  for (const row of rows) {
    const state = spendLedger.rowState(String(row.attemptKey));
    const planned = runQuestions.find((question) => question.id === row.questionId);
    const expectedReservation = planned
      ? reserveA2Row(planned.question, preflight.usdPerThousandSearchUnits)
      : null;
    if (!state) {
      throw new Error(`A2 checkpoint attempt has no durable spend reservation: ${String(row.attemptKey)}`);
    }
    if (!expectedReservation || state.reservedMicrousd !== expectedReservation.totalMicrousd) {
      throw new Error(`A2 checkpoint attempt has the wrong spend reservation: ${String(row.attemptKey)}`);
    }
    if (state.chargedMicrousd !== null) {
      const expectedCharge = chargeA2Row(expectedReservation, knownUsageForBudget(row));
      if (state.chargedMicrousd !== expectedCharge.totalMicrousd
        || state.completeUsage !== expectedCharge.completeUsage) {
        throw new Error(`A2 checkpoint attempt has the wrong spend settlement: ${String(row.attemptKey)}`);
      }
    }
  }
  for (const key of spendLedger.rowKeys()) {
    const row = rowsByAttempt.get(key);
    const state = spendLedger.rowState(key)!;
    if (!row && state.chargedMicrousd !== null) {
      throw new Error(`A2 settled ledger attempt has no durable outcome; manual audit required: ${key}`);
    }
    if (!row && !allowOpenWithoutOutcome) {
      throw new Error(`A2 open ledger attempt requires recovery-only mode: ${key}`);
    }
  }
  if (!allowOpenWithoutOutcome && spendLedger.openRowKeys().length > 0) {
    throw new Error("A2 ledger has an open attempt; use recovery-only mode");
  }
}

function buildRetryManifest(
  preflight: A2Preflight,
  manifestSha256: string,
  spendLedger: A2SpendLedger,
  rows: Array<Record<string, unknown>>,
) {
  const { attemptsByLogical, completedRowKeys } = validateAttemptHistory(preflight, rows);
  const retries = plannedRows(preflight).flatMap((planned) => {
    const attempts = attemptsByLogical.get(planned.logicalRowKey) ?? [];
    if (attempts.length === 0 || completedRowKeys.has(planned.logicalRowKey)) return [];
    const latest = attempts[attempts.length - 1];
    const nextAttempt = attempts.length + 1;
    return [{
      logicalRowKey: planned.logicalRowKey,
      lastAttemptKey: latest.attemptKey,
      lastStatus: latest.status,
      nextAttempt,
      nextAttemptKey: attemptKey(planned.logicalRowKey, nextAttempt),
    }];
  });
  return {
    schemaVersion: A2_RETRY_MANIFEST_SCHEMA_VERSION,
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256,
    ledgerSha256: spendLedger.sha256(),
    committedMicrousd: spendLedger.committedMicrousd(),
    remainingMicrousd: usdToMicrousdCeiling(preflight.maxTotalUsd)
      - spendLedger.committedMicrousd(),
    retries,
  };
}

function persistRetryManifest(
  preflight: A2Preflight,
  manifestSha256: string,
  spendLedger: A2SpendLedger,
  rows: Array<Record<string, unknown>>,
) {
  const manifest = buildRetryManifest(preflight, manifestSha256, spendLedger, rows);
  const requiredApproval = a2RetryApproval(manifest);
  writeJson(join(preflight.runDirectory, "retry-manifest.json"), {
    ...manifest,
    requiredApproval,
  });
  return { manifest, requiredApproval };
}

function initializeOrOpenRun(preflight: A2Preflight) {
  const currentManifest = buildRunManifest(preflight);
  const manifestPath = join(preflight.runDirectory, "run-manifest.json");
  if (preflight.resumed) {
    if (!existsSync(manifestPath)) throw new Error("A2 run manifest is missing");
    const savedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (JSON.stringify(savedManifest) !== JSON.stringify(currentManifest)) {
      throw new Error("A2 run manifest differs from the current code, corpus, labels, runtime, or approvals");
    }
  } else {
    writeJson(manifestPath, currentManifest, true);
  }
  const ledgerPath = join(preflight.runDirectory, "spend-ledger.jsonl");
  const ledgerInput = {
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256: currentManifest.manifestSha256,
    maxMicrousd: usdToMicrousdCeiling(preflight.maxTotalUsd),
  };
  const spendLedger = preflight.resumed
    ? A2SpendLedger.open(ledgerPath, ledgerInput)
    : A2SpendLedger.create(ledgerPath, ledgerInput);
  const checkpointPath = join(preflight.runDirectory, "comparison-report.json");
  let rows: Array<Record<string, unknown>> = [];
  if (preflight.resumed) {
    if (!existsSync(checkpointPath)
      && preflight.mode === "RECOVER"
      && spendLedger.rowKeys().length === 0) {
      writeJson(
        checkpointPath,
        checkpointDocument(preflight, currentManifest.manifestSha256, spendLedger, rows),
        true,
      );
    }
    rows = loadCheckpoint(preflight, currentManifest.manifestSha256);
  }
  if (!preflight.resumed) {
    writeJson(
      checkpointPath,
      checkpointDocument(preflight, currentManifest.manifestSha256, spendLedger, rows),
      true,
    );
  }
  return { currentManifest, spendLedger, checkpointPath, rows };
}

export function completeInterruptedInitialization(
  preflight: A2Preflight,
  currentManifest: ReturnType<typeof buildRunManifest>,
): void {
  const ledgerPath = join(preflight.runDirectory, "spend-ledger.jsonl");
  if (existsSync(ledgerPath)) return;
  const poolsDirectory = join(preflight.runDirectory, "pools");
  const checkpointPath = join(preflight.runDirectory, "comparison-report.json");
  const retryPath = join(preflight.runDirectory, "retry-manifest.json");
  if (!existsSync(poolsDirectory)
    || readdirSync(poolsDirectory).length > 0
    || existsSync(checkpointPath)
    || existsSync(retryPath)) {
    throw new Error("A2 initialization recovery found paid-state artifacts without a ledger; manual audit required");
  }
  const intentPath = join(preflight.runDirectory, "initialization-recovery-intent.json");
  const intent = {
    schemaVersion: "a2-initialization-recovery-v1",
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256: currentManifest.manifestSha256,
    reason: "stale lock existed before the spend ledger; provider construction occurs only after ledger initialization",
    externalCallsMade: 0,
  };
  if (existsSync(intentPath)) {
    const savedIntent = JSON.parse(readFileSync(intentPath, "utf8"));
    if (JSON.stringify(savedIntent) !== JSON.stringify(intent)) {
      throw new Error("A2 initialization recovery intent differs from this approved run");
    }
  } else {
    writeJson(intentPath, intent, true);
  }
  const manifestPath = join(preflight.runDirectory, "run-manifest.json");
  if (existsSync(manifestPath)) {
    const savedManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (JSON.stringify(savedManifest) !== JSON.stringify(currentManifest)) {
      throw new Error("A2 interrupted initialization manifest differs from this approved run");
    }
  } else {
    writeJson(manifestPath, currentManifest, true);
  }
  const spendLedger = A2SpendLedger.create(ledgerPath, {
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256: currentManifest.manifestSha256,
    maxMicrousd: usdToMicrousdCeiling(preflight.maxTotalUsd),
  });
  writeJson(
    checkpointPath,
    checkpointDocument(preflight, currentManifest.manifestSha256, spendLedger, []),
    true,
  );
}

export function recoverInterruptedRun(
  preflight: A2Preflight,
  manifestSha256: string,
  spendLedger: A2SpendLedger,
  checkpointPath: string,
  rows: Array<Record<string, unknown>>,
  recoveredArchivePathInput: string | string[],
): void {
  const recoveredArchivePaths = [...new Set(
    (Array.isArray(recoveredArchivePathInput)
      ? recoveredArchivePathInput
      : [recoveredArchivePathInput])
      .filter((path) => typeof path === "string" && path.length > 0),
  )];
  if (recoveredArchivePaths.length === 0) {
    throw new Error("A2 recovery requires at least one recovered lock archive");
  }
  validateAttemptHistory(preflight, rows);
  assertLedgerBijection(preflight, rows, spendLedger, true);
  const recoveryDirectory = join(preflight.runDirectory, "recovery");
  mkdirSync(recoveryDirectory, { recursive: true });
  const journalNames = readdirSync(recoveryDirectory);
  const intentNumbers = journalNames.flatMap((name) => {
    const match = /^(\d{4})-intent\.json$/u.exec(name);
    return match ? [Number(match[1])] : [];
  });
  const completeNumbers = new Set(journalNames.flatMap((name) => {
    const match = /^(\d{4})-complete\.json$/u.exec(name);
    return match ? [Number(match[1])] : [];
  }));
  if ([...completeNumbers].some((number) => !intentNumbers.includes(number))) {
    throw new Error("A2 recovery journal has a completion without an intent; manual audit required");
  }
  const incompleteNumbers = intentNumbers.filter((number) => !completeNumbers.has(number));
  if (incompleteNumbers.length > 1) {
    throw new Error("A2 recovery journal has multiple incomplete intents; manual audit required");
  }
  const generation = incompleteNumbers[0]
    ?? (intentNumbers.length > 0 ? Math.max(...intentNumbers) + 1 : 1);
  const generationText = String(generation).padStart(4, "0");
  const intentPath = join(recoveryDirectory, `${generationText}-intent.json`);
  const completePath = join(recoveryDirectory, `${generationText}-complete.json`);
  const currentlyOpenAttempts = spendLedger.openRowKeys();
  if (currentlyOpenAttempts.length > 1) {
    throw new Error("A2 recovery found multiple open attempts; manual audit is required");
  }
  let intent: Record<string, unknown>;
  if (incompleteNumbers.length === 1) {
    intent = JSON.parse(readFileSync(intentPath, "utf8")) as Record<string, unknown>;
    if (intent.schemaVersion !== "a2-recovery-intent-v2"
      || intent.generation !== generation
      || intent.runId !== preflight.runId
      || intent.definitionSha256 !== preflight.definitionSha256
      || intent.manifestSha256 !== manifestSha256
      || !Array.isArray(intent.openAttempts)
      || !Array.isArray(intent.recoveredLockArchives)
      || intent.recoveredLockArchives.some((path) => typeof path !== "string")) {
      throw new Error("A2 recovery intent differs from this approved run; manual audit required");
    }
  } else {
    intent = {
      schemaVersion: "a2-recovery-intent-v2",
      generation,
      runId: preflight.runId,
      definitionSha256: preflight.definitionSha256,
      manifestSha256,
      ledgerSha256Before: spendLedger.sha256(),
      committedMicrousdBefore: spendLedger.committedMicrousd(),
      openAttempts: currentlyOpenAttempts,
      recoveredLockArchives: recoveredArchivePaths,
      startedAt: new Date().toISOString(),
    };
    writeJson(intentPath, intent, true);
  }
  const intendedAttempts = (intent.openAttempts as unknown[]).map(String);
  if (new Set(intendedAttempts).size !== intendedAttempts.length
    || currentlyOpenAttempts.some((key) => !intendedAttempts.includes(key))) {
    throw new Error("A2 recovery ledger has drifted beyond its durable intent; manual audit required");
  }
  const settledThisInvocation: string[] = [];
  for (const openAttemptKey of intendedAttempts) {
    const ledgerStateBefore = spendLedger.rowState(openAttemptKey);
    if (!ledgerStateBefore) {
      throw new Error(`A2 recovery intent references a missing ledger attempt: ${openAttemptKey}`);
    }
    if (ledgerStateBefore.chargedMicrousd !== null) {
      if (!rows.some((candidate) => candidate.attemptKey === openAttemptKey)) {
        throw new Error(`A2 recovered settlement has no durable outcome: ${openAttemptKey}`);
      }
      continue;
    }
    let row = rows.find((candidate) => candidate.attemptKey === openAttemptKey);
    if (!row) {
      const match = /^(.*)@(\d+)$/u.exec(openAttemptKey);
      if (!match) throw new Error("A2 open ledger attempt key is malformed; manual audit required");
      const logicalKey = match[1];
      const attempt = Number(match[2]);
      const planned = plannedRows(preflight).find((candidate) => candidate.logicalRowKey === logicalKey);
      const priorAttempts = rows.filter((candidate) => candidate.logicalRowKey === logicalKey);
      if (!planned || attempt !== priorAttempts.length + 1
        || priorAttempts.some((candidate) => candidate.status === "complete")) {
        throw new Error(`A2 open ledger attempt cannot be reconciled; manual audit required: ${openAttemptKey}`);
      }
      const reservation = reserveA2Row(
        planned.question.question,
        preflight.usdPerThousandSearchUnits,
      );
      const ledgerState = spendLedger.rowState(openAttemptKey)!;
      if (ledgerState.reservedMicrousd !== reservation.totalMicrousd) {
        throw new Error(`A2 open ledger reservation differs from its approved row: ${openAttemptKey}`);
      }
      row = {
        status: "interrupted",
        logicalRowKey: logicalKey,
        attempt,
        attemptKey: openAttemptKey,
        questionId: planned.question.id,
        category: planned.question.category,
        question: planned.question.question,
        supplemental: planned.question.id.startsWith("supplemental-"),
        repeat: planned.repeat,
        armExecutionOrder: planned.armExecutionOrder,
        models: runtimeModels(),
        kind: "process_interrupted_before_durable_outcome",
        budgetReservationUsd: microusdToUsd(reservation.totalMicrousd),
      };
      rows.push(row);
      validateAttemptHistory(preflight, rows);
      writeJson(
        checkpointPath,
        checkpointDocument(preflight, manifestSha256, spendLedger, rows),
      );
    }
    const question = runQuestions.find((candidate) => candidate.id === row!.questionId);
    if (!question) throw new Error(`A2 recovery cannot identify ${openAttemptKey}`);
    const reservation = reserveA2Row(question.question, preflight.usdPerThousandSearchUnits);
    spendLedger.settle(
      openAttemptKey,
      chargeA2Row(reservation, knownUsageForBudget(row)),
    );
    settledThisInvocation.push(openAttemptKey);
    writeJson(
      checkpointPath,
      checkpointDocument(preflight, manifestSha256, spendLedger, rows),
    );
  }
  writeJson(
    checkpointPath,
    checkpointDocument(preflight, manifestSha256, spendLedger, rows),
  );
  validateAttemptHistory(preflight, rows);
  assertLedgerBijection(preflight, rows, spendLedger, false);
  const retry = persistRetryManifest(preflight, manifestSha256, spendLedger, rows);
  writeJson(completePath, {
    schemaVersion: "a2-recovery-complete-v1",
    generation,
    runId: preflight.runId,
    definitionSha256: preflight.definitionSha256,
    manifestSha256,
    recoveredAt: new Date().toISOString(),
    recoveredLockArchives: [...new Set([
      ...(intent.recoveredLockArchives as string[]),
      ...recoveredArchivePaths,
    ])],
    recoveredAttempts: intendedAttempts,
    settledThisInvocation,
    committedUsd: microusdToUsd(spendLedger.committedMicrousd()),
    retryCount: retry.manifest.retries.length,
    requiredRetryApproval: retry.manifest.retries.length > 0
      ? retry.requiredApproval
      : null,
    externalCallsMade: 0,
  }, true);
}

// Local state-machine unit tests import the recovery helpers with this flag.
// The ordinary paid runner never sets it, so this cannot authorize a live call.
if (process.env.A2_STATE_UNIT_TEST_ONLY !== "1") {
describe("paid A2 rerank comparison", () => {
  it("runs the complete key with repeated shared-pool comparisons", async () => {
    const preflight = assertPreflight();
    const sanitizedManifest = buildRunManifest(preflight);
    const requiredPaidRunApproval = paidRunApproval(
      preflight,
      sanitizedManifest.manifestSha256,
    );
    if (preflight.mode === "PRECHECK") {
      process.stderr.write(`${JSON.stringify({
        mode: preflight.mode,
        runId: preflight.runId,
        definitionSha256: preflight.definitionSha256,
        manifestSha256: sanitizedManifest.manifestSha256,
        questions: runQuestions.length,
        repeats: preflight.repeats,
        rows: runQuestions.length * preflight.repeats,
        maxTotalUsd: preflight.maxTotalUsd,
        lifetimeBudget: A2_LIFETIME_BUDGET,
        requiredPaidRunApproval,
        externalCallsMade: 0,
        artifactsWritten: 0,
      })}\n`);
      expect(runQuestions).toHaveLength(66);
      return;
    }
    if (preflight.mode === "RUN"
      && process.env.A2_PAID_RUN_APPROVED !== requiredPaidRunApproval) {
      throw new Error(`A2 paid run requires the exact marker ${requiredPaidRunApproval}`);
    }
    let priorRunLock: A2RunLock | null = null;
    let runLock: A2RunLock | null = null;
    let activeSpendLedger: A2SpendLedger | null = null;
    let priorLockDisposed = false;
    let runLockDisposed = false;
    try {
    const lockMode = preflight.mode === "RECOVER" ? "recover" : "run";
    const priorRunDirectory = resolve("work/a2-rerank-comparison", A2_PRIOR_EVIDENCE.runId);
    // Hold the immutable prior run closed before taking the restart lock. This
    // makes the carried-forward $2.716439 and the restart ledger one canonical-
    // worktree critical section instead of two independently spendable runs.
    priorRunLock = A2RunLock.acquire(join(priorRunDirectory, "paid-run.lock"), {
      runId: A2_PRIOR_EVIDENCE.runId,
      definitionSha256: A2_PRIOR_EVIDENCE.definitionSha256,
      mode: lockMode,
      staleLockApproval: process.env.A2_PRIOR_STALE_LOCK_APPROVAL,
    });
    // Close the check/acquire race: the pinned prior files must still be the
    // exact evidence used for the carry-forward after we own its lock.
    assertPriorRunEvidence();

    if (!preflight.resumed) {
      mkdirSync(join(preflight.runDirectory, "pools"), { recursive: true });
    }
    runLock = A2RunLock.acquire(join(preflight.runDirectory, "paid-run.lock"), {
      runId: preflight.runId,
      definitionSha256: preflight.definitionSha256,
      mode: lockMode,
      staleLockApproval: process.env.A2_STALE_LOCK_APPROVAL,
    });
    const recoveredArchivePaths = [
      priorRunLock.recoveredArchivePath,
      runLock.recoveredArchivePath,
    ].filter((path): path is string => path !== null);
    if (preflight.mode === "RECOVER" && recoveredArchivePaths.length === 0) {
      throw new Error("A2 RECOVER requires a stale prior or restart lock with its exact approval");
    }
    if (preflight.mode === "RECOVER" && preflight.resumed) {
      completeInterruptedInitialization(preflight, sanitizedManifest);
    }
    const {
      currentManifest,
      spendLedger,
      checkpointPath,
      rows,
    } = initializeOrOpenRun(preflight);
    activeSpendLedger = spendLedger;
    if (preflight.mode === "RECOVER") {
      recoverInterruptedRun(
        preflight,
        currentManifest.manifestSha256,
        spendLedger,
        checkpointPath,
        rows,
        recoveredArchivePaths,
      );
      expect(spendLedger.openRowKeys()).toEqual([]);
      return;
    }
    const history = validateAttemptHistory(preflight, rows);
    const completedRowKeys = history.completedRowKeys;
    assertLedgerBijection(preflight, rows, spendLedger, false);
    const retryState = persistRetryManifest(
      preflight,
      currentManifest.manifestSha256,
      spendLedger,
      rows,
    );
    if (retryState.manifest.retries.length > 0
      && process.env.A2_RETRY_APPROVAL !== retryState.requiredApproval) {
      throw new Error(`A2 paid retries require the exact current marker ${retryState.requiredApproval}`);
    }
    const approvedRetryAttempts = new Set(
      retryState.manifest.retries.map((retry) => retry.nextAttemptKey),
    );
    const db = getSupabaseAdmin() as unknown as RpcCapableClient;
    let consecutiveSystemFailures = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].status === "complete") break;
      consecutiveSystemFailures += 1;
    }
    if (consecutiveSystemFailures >= 3) {
      consecutiveSystemFailures = 0;
    }

    for (let repeat = 1; repeat <= preflight.repeats; repeat += 1) {
      for (const [questionIndex, question] of runQuestions.entries()) {
        const rowKey = logicalRowKey(question.id, repeat);
        if (completedRowKeys.has(rowKey)) continue;
        const priorAttempts = rows.filter((row) => row.logicalRowKey === rowKey);
        const attempt = priorAttempts.length + 1;
        const paidAttemptKey = attemptKey(rowKey, attempt);
        if (priorAttempts.length > 0 && !approvedRetryAttempts.has(paidAttemptKey)) {
          throw new Error(`A2 paid attempt is not covered by the current retry approval: ${paidAttemptKey}`);
        }
        const budgetReservation = reserveA2Row(
          question.question,
          preflight.usdPerThousandSearchUnits,
        );
        const labels = activeLabels(question);
        // Every question sees both positions by its second repeat. With the
        // even 66-question key this is also exactly balanced in aggregate.
        const armOrder = armOrderFor(questionIndex, repeat);
        const requestId = `a2-${question.id}-r${repeat}-a${attempt}-${randomUUID()}`;
        const started = globalThis.performance.now();
        let sharedPreparationMs: number | null = null;
        let comparison: RerankComparisonOutcome | null = null;
        let plannerUsage: PlannerUsage | null = null;
        let embeddingProviderCalls: number | null = null;
        const poolRelativePath = poolArtifactPath(question.id, repeat, attempt);
        const poolPath = join(preflight.runDirectory, ...poolRelativePath.split("/"));

        spendLedger.reserve(paidAttemptKey, budgetReservation.totalMicrousd);
        try {
          const output = await runSearchV2({
            db,
            query: question.question,
            requestId,
            captureDiagnostics: true,
            privatePaidUsageObserver: (event) => {
              if (event.stage === "query_planner") {
                plannerUsage = {
                  ...event.usage,
                  attemptDurationsMs: [...event.usage.attemptDurationsMs],
                };
              } else {
                embeddingProviderCalls = event.providerCalls;
              }
            },
            privateArticlePlanner: async () => ({
              plan: null,
              source: "deterministic_fallback",
              rejections: ["A2 comparison omits the unrelated paid article-planning step"],
            }),
            privateRerankExecutor: async (rerankInput) => {
              sharedPreparationMs = Math.round(
                (globalThis.performance.now() - started) * 1000,
              ) / 1000;
              comparison = await compareRerankArms(rerankInput, {
                armOrder,
                onPoolPrepared: (pool) => {
                  assertBudgetedCoherePool(pool);
                  const artifact = buildPrivateRerankPoolArtifact(pool);
                  if (existsSync(poolPath)) {
                    throw new Error("A2 attempt pool already exists without a durable outcome; recovery is required");
                  }
                  writeJson(poolPath, artifact, true);
                },
              });
              return comparison.productionOutcome;
            },
          });
          if (!comparison || sharedPreparationMs === null || !output.diagnostics) {
            throw new Error("A2 comparison did not capture its private pool and diagnostics");
          }

          const observed = comparison as RerankComparisonOutcome;
          const currentScore = scoreTop(observed.current.top, labels);
          const globalScore = scoreTop(observed.global.top, labels);
          const currentIds = observed.current.top.map((candidate) => candidate.passage_key);
          const globalIds = observed.global.top.map((candidate) => candidate.passage_key);
          const removed = currentIds.filter((passageId) => !globalIds.includes(passageId));
          const appeared = globalIds.filter((passageId) => !currentIds.includes(passageId));
          const overlap = jaccard(currentIds, globalIds);
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
          const materialChange = currentScore.automaticPass !== globalScore.automaticPass
            || (firstPositionDelta !== null && Math.abs(firstPositionDelta) >= 5)
            || currentScore.unacceptableHits.length !== globalScore.unacceptableHits.length
            || unacceptableRankRegression
            || overlap < 0.75;
          const globalQualityRegression = (
            currentScore.automaticPass === true && globalScore.automaticPass !== true
          ) || globalScore.unacceptableHits.length > currentScore.unacceptableHits.length
            || unacceptableRankRegression;
          const invalidArm = !observed.current.reranked
            || !observed.global.reranked
            || observed.current.degradedReason !== null
            || observed.global.degradedReason !== null
            || [...observed.current.providerRequests, ...observed.global.providerRequests]
              .some((request) => request.responseSucceeded !== true);
          const rowValid = !invalidArm && !output.telemetry.degraded;

          const row: Record<string, unknown> = {
            status: "complete",
            logicalRowKey: rowKey,
            attempt,
            attemptKey: paidAttemptKey,
            questionId: question.id,
            category: question.category,
            question: question.question,
            supplemental: question.id.startsWith("supplemental-"),
            repeat,
            requestId,
            armExecutionOrder: armOrder,
            models: runtimeModels(),
            labelStatus: labels.status,
            evaluationKind: labels.evaluationKind,
            reviewNotes: labels.notes,
            poolSha256: observed.pool.poolSha256,
            poolArtifact: poolRelativePath,
            candidateCount: observed.pool.candidates.length,
            sharedPreparationMs,
            searchToTop20Ms: {
              current: sharedPreparationMs + observed.current.durationMs,
              global: sharedPreparationMs + observed.global.durationMs,
            },
            comparisonPipelineTotalMs: output.telemetry.totalDurationMs,
            planSource: output.telemetry.planSource,
            planFailureKind: output.telemetry.planFailureKind,
            subqueryCount: output.telemetry.subqueryCount,
            embeddingProviderCalls: embeddingProviderCalls ?? output.telemetry.embeddingProviderCalls,
            plannerUsage: plannerUsage ?? output.diagnostics.queryPlan.usage,
            tableRpcCount: output.telemetry.tableRpcCount,
            pipelineDegraded: output.telemetry.degraded,
            degradedStages: output.telemetry.degradedStages,
            arms: {
              current: { ...observed.current, top: observed.current.top.map(privateTop) },
              global: { ...observed.global, top: observed.global.top.map(privateTop) },
            },
            scores: { current: currentScore, global: globalScore },
            changes: {
              top20Jaccard: overlap,
              removedFromCurrent: removed,
              appearedInGlobal: appeared,
              importantDisappeared: labels.expectedIds.filter((passageId) =>
                observed.current.top.some((candidate) => candidateMatchesId(candidate, passageId))
                && !observed.global.top.some((candidate) => candidateMatchesId(candidate, passageId))),
              importantAppeared: labels.expectedIds.filter((passageId) =>
                !observed.current.top.some((candidate) => candidateMatchesId(candidate, passageId))
                && observed.global.top.some((candidate) => candidateMatchesId(candidate, passageId))),
              firstExpectedPositionDelta: firstPositionDelta,
              unacceptableRankRegression,
              materialChange,
              globalQualityRegression,
            },
            invalidArm,
            budgetReservationUsd: microusdToUsd(budgetReservation.totalMicrousd),
          };
          const reconciledCharge = chargeA2Row(
            budgetReservation,
            knownUsageForBudget(row),
          );
          const providerUsageComplete = reconciledCharge.completeUsage;
          const complete = rowValid && providerUsageComplete;
          row.status = complete ? "complete" : "invalid";
          row.providerUsageComplete = providerUsageComplete;
          if (!complete) {
            row.kind = !rowValid
              ? invalidArm ? "rerank_degraded" : "pipeline_degraded"
              : "provider_usage_incomplete";
          }
          rows.push(row);
          if (!complete) {
            consecutiveSystemFailures += 1;
          } else {
            completedRowKeys.add(rowKey);
            consecutiveSystemFailures = 0;
          }
        } catch (error) {
          const failure = {
            questionId: question.id,
            repeat,
            kind: "search_failed",
            failure: safeFailure(error),
          };
          const observed = comparison as RerankComparisonOutcome | null;
          rows.push({
            status: "failed",
            logicalRowKey: rowKey,
            attempt,
            attemptKey: paidAttemptKey,
            ...failure,
            category: question.category,
            question: question.question,
            supplemental: question.id.startsWith("supplemental-"),
            armExecutionOrder: armOrder,
            models: runtimeModels(),
            plannerUsage,
            embeddingProviderCalls,
            providerUsageComplete: false,
            budgetReservationUsd: microusdToUsd(budgetReservation.totalMicrousd),
            ...(observed ? {
              poolSha256: observed.pool.poolSha256,
              poolArtifact: poolRelativePath,
              candidateCount: observed.pool.candidates.length,
              arms: {
                current: { ...observed.current, top: observed.current.top.map(privateTop) },
                global: { ...observed.global, top: observed.global.top.map(privateTop) },
              },
              invalidArm: true,
            } : {}),
          });
          consecutiveSystemFailures += 1;
        }

        writeJson(
          checkpointPath,
          checkpointDocument(
            preflight,
            currentManifest.manifestSha256,
            spendLedger,
            rows,
          ),
        );
        const savedRow = rows[rows.length - 1];
        if (!savedRow || savedRow.attemptKey !== paidAttemptKey) {
          throw new Error(`A2 paid attempt was not checkpointed: ${paidAttemptKey}`);
        }
        spendLedger.settle(
          paidAttemptKey,
          chargeA2Row(budgetReservation, knownUsageForBudget(savedRow)),
        );
        writeJson(
          checkpointPath,
          checkpointDocument(
            preflight,
            currentManifest.manifestSha256,
            spendLedger,
            rows,
          ),
        );
        persistRetryManifest(
          preflight,
          currentManifest.manifestSha256,
          spendLedger,
          rows,
        );
        process.stderr.write(
          `A2 ${completedRowKeys.size}/${preflight.repeats * runQuestions.length}\r`,
        );
        if (consecutiveSystemFailures >= 3) {
          throw new Error("A2 stopped after three consecutive system failures; checkpoint preserved");
        }
      }
    }
    process.stderr.write("\n");

    const completedRows = rows.filter((row) => row.status === "complete");
    validateAttemptHistory(preflight, rows);
    assertLedgerBijection(preflight, rows, spendLedger, false);
    const currentTotals = armTotals(completedRows, "current");
    const globalTotals = armTotals(completedRows, "global");
    const allAttemptCurrentTotals = armTotals(rows, "current");
    const allAttemptGlobalTotals = armTotals(rows, "global");
    const knownUnits = allAttemptCurrentTotals.billedSearchUnits !== null
      && allAttemptGlobalTotals.billedSearchUnits !== null
      ? allAttemptCurrentTotals.billedSearchUnits + allAttemptGlobalTotals.billedSearchUnits
      : null;
    const stability = runQuestions.flatMap((question) => {
      const questionRows = completedRows.filter((row) => row.questionId === question.id && row.arms);
      return (["current", "global"] as const).map((arm) => {
        const rankingsByPool = new Map<string, string[]>();
        for (const row of questionRows) {
          const arms = row.arms as Record<string, { top: RankedPrivatePassage[] }>;
          const ranking = JSON.stringify(arms[arm].top.map((passage) => passage.passageId));
          const poolSha256 = String(row.poolSha256);
          rankingsByPool.set(poolSha256, [...(rankingsByPool.get(poolSha256) ?? []), ranking]);
        }
        const comparableGroups = [...rankingsByPool.entries()]
          .filter(([, rankings]) => rankings.length >= 2);
        const unstableGroups = comparableGroups.filter(([, rankings]) =>
          new Set(rankings).size > 1);
        const assessment = comparableGroups.length === 0
          ? "not_assessable_without_repeated_identical_pool"
          : unstableGroups.length > 0
            ? "reranker_unstable_on_identical_pool"
            : "reranker_stable_on_identical_pool";
        return {
          questionId: question.id,
          arm,
          assessment,
          distinctPoolHashes: rankingsByPool.size,
          upstreamPoolStableAcrossRepeats: rankingsByPool.size === 1,
          comparableIdenticalPoolGroups: comparableGroups.length,
          unstablePoolHashes: unstableGroups.map(([poolSha256]) => poolSha256),
        };
      });
    });
    const plannerUsages = rows.flatMap((row) => {
      const usage = row.plannerUsage as Record<string, number> | undefined;
      return usage ? [usage] : [];
    });
    const finalReport = {
      schemaVersion: A2_SCHEMA_VERSION,
      runId: preflight.runId,
      definitionSha256: preflight.definitionSha256,
      manifestSha256: currentManifest.manifestSha256,
      resumed: preflight.resumed,
      repeats: preflight.repeats,
      repeatsPlanned: preflight.repeats,
      questionsPlanned: runQuestions.length,
      maxTotalUsd: preflight.maxTotalUsd,
      budgetCommittedUsd: microusdToUsd(spendLedger.committedMicrousd()),
      budgetOpenAttempts: spendLedger.openRowKeys(),
      runtime: {
        supabaseProjectRef: A2_SUPABASE_PROJECT_REF,
        pipelineVersion: searchPipelineVersion(),
        corpusVersion: searchCorpusVersion(),
        configVersion: searchConfigVersion(),
        geminiQueryPlannerModel: geminiQueryPlannerModel(),
        voyageEmbeddingModel: VOYAGE_CONTEXT_MODEL,
        cohereRerankModel: COHERE_RERANK_MODEL,
      },
      questions: {
        fixedGoldKey: goldSet.questions.length,
        supplementalDifficultCases: supplementalQuestions.length,
        totalRun: runQuestions.length,
      },
      rowsExpected: preflight.repeats * runQuestions.length,
      rowsCompleted: completedRowKeys.size,
      completedRows: completedRowKeys.size,
      attempts: rows.length,
      labelState: {
        ownerApproved: goldSet.questions.filter((question) => !question.needs_human_review).length,
        suggestedPendingOwnerReview: goldSet.questions.filter((question) => question.needs_human_review).length,
        supplementalSuggestedPendingOwnerReview: supplementalQuestions.length,
      },
      timingDefinition: "shared planning/retrieval/fusion plus that arm's rerank; downstream rendering is not compared",
      budget: {
        maxTotalUsd: preflight.maxTotalUsd,
        committedUsd: microusdToUsd(spendLedger.committedMicrousd()),
        lifetimeMaxTotalUsd: A2_LIFETIME_BUDGET.lifetimeMaxTotalUsd,
        priorRunId: A2_LIFETIME_BUDGET.priorRunId,
        priorCommittedUsd: A2_LIFETIME_BUDGET.priorCommittedUsd,
        aggregateCommittedUsd: microusdToUsd(
          A2_PRIOR_COMMITTED_MICROUSD + spendLedger.committedMicrousd(),
        ),
        aggregateRemainingUsd: microusdToUsd(
          A2_LIFETIME_MAX_MICROUSD
            - A2_PRIOR_COMMITTED_MICROUSD
            - spendLedger.committedMicrousd(),
        ),
        openRows: spendLedger.openRowKeys(),
        ledgerSchemaVersion: A2_SPEND_LEDGER_SCHEMA_VERSION,
        definition: A2_BUDGET_DEFINITION,
        policy: "reserve before every paid row; retain the full provider reservation whenever usage is missing; refuse any request that would exceed the cap",
      },
      totals: { current: currentTotals, global: globalTotals },
      allAttemptTotals: { current: allAttemptCurrentTotals, global: allAttemptGlobalTotals },
      cost: {
        usdPerThousandSearchUnits: preflight.usdPerThousandSearchUnits,
        cohereProviderReportedSearchUnits: knownUnits,
        cohereEstimatedUsd: knownUnits === null
          ? null
          : knownUnits * preflight.usdPerThousandSearchUnits / 1000,
        otherPaidProviderUsage: {
          geminiPlannerAttempts: sum(plannerUsages.map((usage) => usage.attempts ?? 0)),
          geminiPromptTokens: sum(plannerUsages.map((usage) => usage.promptTokens ?? 0)),
          geminiOutputTokens: sum(plannerUsages.map((usage) => usage.outputTokens ?? 0)),
          voyageEmbeddingCalls: sum(rows.map((row) => Number(row.embeddingProviderCalls ?? 0))),
        },
        note: knownUnits === null
          ? "Cohere metadata was incomplete, so no dollar total is claimed. Gemini and Voyage are reported separately and are never included in the Cohere estimate."
          : "Cohere-only estimate uses provider-reported units and the supplied account rate. Gemini and Voyage usage is reported separately and is not included in this dollar value.",
      },
      materialChanges: completedRows.filter((row) => {
        const changes = row.changes as { materialChange?: boolean } | undefined;
        return changes?.materialChange === true;
      }).map((row) => ({
        questionId: row.questionId,
        repeat: row.repeat,
        changes: row.changes,
        scores: row.scores,
      })),
      proposedArmQualityRegressions: completedRows.filter((row) => {
        const changes = row.changes as { globalQualityRegression?: boolean } | undefined;
        return changes?.globalQualityRegression === true;
      }).map((row) => ({
        questionId: row.questionId,
        repeat: row.repeat,
        changes: row.changes,
        scores: row.scores,
      })),
      stability,
      rerankerInstability: stability.filter((row) =>
        row.assessment === "reranker_unstable_on_identical_pool"),
      upstreamPoolChanges: stability.filter((row) => !row.upstreamPoolStableAcrossRepeats),
      failures: failureSummaries(rows),
      attemptHistory: rows,
    };
    writeJson(checkpointPath, finalReport);

    expect(spendLedger.openRowKeys()).toEqual([]);
    expect(spendLedger.committedMicrousd()).toBeLessThanOrEqual(
      usdToMicrousdCeiling(preflight.maxTotalUsd),
    );
    expect(completedRowKeys.size).toBe(preflight.repeats * runQuestions.length);
    } catch (error) {
      if (preflight.mode === "RECOVER") {
        const restorationErrors: string[] = [];
        if (runLock !== null) {
          runLockDisposed = true;
          try {
            if (runLock.recovered) runLock.restoreRecoveredLock();
            else runLock.release();
          } catch (lockError) {
            restorationErrors.push(
              lockError instanceof Error ? lockError.message : "restart lock restoration failed",
            );
          }
        }
        if (priorRunLock !== null) {
          priorLockDisposed = true;
          try {
            if (priorRunLock.recovered) priorRunLock.restoreRecoveredLock();
            else priorRunLock.release();
          } catch (lockError) {
            restorationErrors.push(
              lockError instanceof Error ? lockError.message : "prior lock restoration failed",
            );
          }
        }
        if (restorationErrors.length > 0) {
          throw new Error(
            `A2 recovery failed and lock restoration was incomplete: ${restorationErrors.join("; ")}`,
          );
        }
      } else if (preflight.mode === "RUN"
        && activeSpendLedger !== null
        && activeSpendLedger.openRowKeys().length > 0) {
        // Preserve both JSON locks if an unexpected local failure leaves money
        // reserved without a settled outcome. A later RECOVER invocation must
        // reconcile that attempt before either lifetime-budget run can proceed.
        const retentionErrors: string[] = [];
        if (runLock !== null) {
          runLockDisposed = true;
          try { runLock.retainForRecovery(); } catch (lockError) {
            retentionErrors.push(
              lockError instanceof Error ? lockError.message : "restart lock retention failed",
            );
          }
        }
        if (priorRunLock !== null) {
          priorLockDisposed = true;
          try { priorRunLock.retainForRecovery(); } catch (lockError) {
            retentionErrors.push(
              lockError instanceof Error ? lockError.message : "prior lock retention failed",
            );
          }
        }
        if (retentionErrors.length > 0) {
          throw new Error(
            `A2 failed with an open reservation and lock retention was incomplete: ${retentionErrors.join("; ")}`,
          );
        }
      }
      throw error;
    } finally {
      const releaseErrors: string[] = [];
      if (runLock !== null && !runLockDisposed) {
        runLockDisposed = true;
        try { runLock.release(); } catch (lockError) {
          releaseErrors.push(
            lockError instanceof Error ? lockError.message : "restart lock release failed",
          );
        }
      }
      if (priorRunLock !== null && !priorLockDisposed) {
        priorLockDisposed = true;
        try { priorRunLock.release(); } catch (lockError) {
          releaseErrors.push(
            lockError instanceof Error ? lockError.message : "prior lock release failed",
          );
        }
      }
      if (releaseErrors.length > 0) {
        throw new Error(`A2 lock release was incomplete: ${releaseErrors.join("; ")}`);
      }
    }
  });
});
}
