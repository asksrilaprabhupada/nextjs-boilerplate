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
  writeFileSync,
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
import type { PlannerUsage } from "@/app/lib/search-v2/query-plan";
import {
  RERANK_ARMS,
  buildPrivateRerankPoolArtifact,
  compareRerankArms,
  type RankedCandidate,
  type RerankComparisonArmOutcome,
  type RerankComparisonOutcome,
} from "@/app/lib/search-v2/rerank";
import type { RpcCapableClient } from "@/app/lib/search-v2/rpc";
import goldSetJson from "@/tests/gold/gold-set-v1.json";
import suggestionSetJson from "@/tests/gold/gold-set-v1-suggestions.json";

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
const A2_SCHEMA_VERSION = "a2-rerank-comparison-v2";

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

function runDefinitionSha256(repeats: number, usdPerThousandSearchUnits: number): string {
  const root = resolve(".");
  const files = [
    ...sourceFilesBelow(resolve("app/lib")),
    resolve("tests/a2-rerank-comparison.live.ts"),
    resolve("tests/gold/gold-set-v1.json"),
    resolve("tests/gold/gold-set-v1-suggestions.json"),
    resolve("package.json"),
    resolve("package-lock.json"),
  ].sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    schemaVersion: A2_SCHEMA_VERSION,
    repeats,
    usdPerThousandSearchUnits,
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
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    ...(exclusive ? { flag: "wx" as const } : {}),
  });
}

function assertPreflight(): {
  repeats: number;
  usdPerThousandSearchUnits: number;
  runId: string;
  runDirectory: string;
  definitionSha256: string;
  resumed: boolean;
  initialRows: Array<Record<string, unknown>>;
  initialFailures: Array<Record<string, unknown>>;
} {
  if (process.env.A2_PAID_RUN_APPROVED !== "I_APPROVE_PAID_A2") {
    throw new Error("A2 paid run is blocked without the exact approval marker");
  }
  const required = ["VOYAGE_API_KEY", "GEMINI_API_KEY", "COHERE_API_KEY", "SUPABASE_SERVICE_KEY"];
  const missing = required.filter((name) => !process.env[name]);
  if (!(process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL)) missing.push("SUPABASE_URL");
  if (missing.length > 0) throw new Error(`A2 paid run is missing ${missing.join(", ")}`);

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
  if (!Number.isSafeInteger(repeats) || repeats < 3 || repeats > 5) {
    throw new Error("A2_REPEATS must be an integer from 3 through 5");
  }
  const priceText = process.env.A2_COHERE_USD_PER_1000_SEARCH_UNITS;
  const usdPerThousandSearchUnits = Number(priceText);
  if (priceText === undefined || !Number.isFinite(usdPerThousandSearchUnits) || usdPerThousandSearchUnits < 0) {
    throw new Error("A2_COHERE_USD_PER_1000_SEARCH_UNITS must be the current account rate");
  }
  const definitionSha256 = runDefinitionSha256(repeats, usdPerThousandSearchUnits);

  const runId = process.env.A2_RUN_ID
    ?? new Date().toISOString().replace(/[:.]/g, "-");
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(runId)) throw new Error("A2_RUN_ID is malformed");
  // Private corpus text is allowed only in this gitignored, repository-local directory.
  const outputRoot = resolve("work/a2-rerank-comparison");
  const runDirectory = join(outputRoot, runId);
  if (existsSync(runDirectory)) {
    if (process.env.A2_RESUME_RUN !== "I_APPROVE_RESUME_A2") {
      throw new Error("A2 run directory exists; use the exact resume marker instead of paying twice");
    }
    const checkpointPath = join(runDirectory, "comparison-report.json");
    if (!existsSync(checkpointPath)) throw new Error("A2 resume checkpoint is missing");
    const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8")) as Record<string, unknown>;
    if (checkpoint.schemaVersion !== A2_SCHEMA_VERSION) {
      throw new Error("A2 resume checkpoint schema differs from this runner");
    }
    if (checkpoint.runId !== runId) throw new Error("A2 resume checkpoint run id does not match");
    if (checkpoint.definitionSha256 !== definitionSha256) {
      throw new Error("A2 resume definition differs from the checkpointed code, corpus, labels, models, or cost inputs");
    }
    if (checkpoint.repeatsPlanned !== undefined && checkpoint.repeatsPlanned !== repeats) {
      throw new Error("A2 resume repeat count differs from the checkpoint");
    }
    if (checkpoint.questionsPlanned !== undefined && checkpoint.questionsPlanned !== runQuestions.length) {
      throw new Error("A2 resume question count differs from the checkpoint");
    }
    const initialRows = Array.isArray(checkpoint.rows)
      ? checkpoint.rows as Array<Record<string, unknown>>
      : [];
    const initialFailures = Array.isArray(checkpoint.failures)
      ? checkpoint.failures as Array<Record<string, unknown>>
      : [];
    return {
      repeats,
      usdPerThousandSearchUnits,
      runId,
      runDirectory,
      definitionSha256,
      resumed: true,
      initialRows,
      initialFailures,
    };
  }
  mkdirSync(join(runDirectory, "pools"), { recursive: true });
  return {
    repeats,
    usdPerThousandSearchUnits,
    runId,
    runDirectory,
    definitionSha256,
    resumed: false,
    initialRows: [],
    initialFailures: [],
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

function assertCompleteRow(row: Record<string, unknown>, key: string): void {
  if (typeof row.poolSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(row.poolSha256)) {
    throw new Error(`A2 completed row has no valid pool hash: ${key}`);
  }
  const timing = row.searchToTop20Ms as Record<string, unknown> | undefined;
  const order = Array.isArray(row.armExecutionOrder) ? row.armExecutionOrder : [];
  const arms = row.arms as Record<string, Record<string, unknown>> | undefined;
  if (!timing || !arms
    || order.length !== 2 || new Set(order).size !== 2
    || !order.includes(RERANK_ARMS.current) || !order.includes(RERANK_ARMS.global)) {
    throw new Error(`A2 completed row is missing comparison structure: ${key}`);
  }
  for (const arm of [RERANK_ARMS.current, RERANK_ARMS.global]) {
    const outcome = arms[arm];
    const duration = timing[arm];
    const requests = outcome?.providerRequests;
    if (!outcome || outcome.reranked !== true || outcome.degradedReason !== null
      || !Array.isArray(outcome.top)
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
  }
}

describe("paid A2 rerank comparison", () => {
  it("runs the complete key with repeated shared-pool comparisons", async () => {
    const preflight = assertPreflight();
    const db = getSupabaseAdmin() as unknown as RpcCapableClient;
    const rows: Array<Record<string, unknown>> = [...preflight.initialRows];
    const failures: Array<Record<string, unknown>> = [...preflight.initialFailures];
    const plannedRowKeys = new Set(runQuestions.flatMap((question) =>
      Array.from({ length: preflight.repeats }, (_, index) => `${question.id}:${index + 1}`)));
    for (const row of rows) {
      const key = `${String(row.questionId)}:${String(row.repeat)}`;
      if (!plannedRowKeys.has(key)) throw new Error(`A2 resume row is outside this run: ${key}`);
      if (row.status === "complete") assertCompleteRow(row, key);
      else if (row.status !== "invalid" && row.status !== "failed") {
        throw new Error(`A2 resume row has an unknown status: ${key}`);
      }
    }
    const completeRows = rows.filter((row) => row.status === "complete");
    const completedRowKeys = new Set(completeRows.map(
      (row) => `${String(row.questionId)}:${String(row.repeat)}`,
    ));
    if (completedRowKeys.size !== completeRows.length) {
      throw new Error("A2 resume checkpoint contains duplicate completed row keys");
    }
    const checkpointPath = join(preflight.runDirectory, "comparison-report.json");
    if (!existsSync(checkpointPath)) {
      writeJson(checkpointPath, {
        schemaVersion: A2_SCHEMA_VERSION,
        runId: preflight.runId,
        definitionSha256: preflight.definitionSha256,
        resumed: false,
        repeatsPlanned: preflight.repeats,
        questionsPlanned: runQuestions.length,
        completedRows: 0,
        attempts: 0,
        failures: [],
        rows: [],
      }, true);
    }
    let consecutiveSystemFailures = 0;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].status === "complete") break;
      consecutiveSystemFailures += 1;
    }
    if (consecutiveSystemFailures >= 3) {
      if (process.env.A2_RETRY_AFTER_FAILURES !== "I_APPROVE_PAID_RETRY_AFTER_FAILURES") {
        throw new Error("A2 resume is blocked after three failures without the paid-retry approval marker");
      }
      consecutiveSystemFailures = 0;
    }

    for (let repeat = 1; repeat <= preflight.repeats; repeat += 1) {
      for (const [questionIndex, question] of runQuestions.entries()) {
        const rowKey = `${question.id}:${repeat}`;
        if (completedRowKeys.has(rowKey)) continue;
        const labels = activeLabels(question);
        // Every question sees both positions by its second repeat. With the
        // even 66-question key this is also exactly balanced in aggregate.
        const armOrder = (questionIndex + repeat - 1) % 2 === 0
          ? [RERANK_ARMS.current, RERANK_ARMS.global] as const
          : [RERANK_ARMS.global, RERANK_ARMS.current] as const;
        const requestId = `a2-${question.id}-r${repeat}-${randomUUID()}`;
        const started = globalThis.performance.now();
        let sharedPreparationMs: number | null = null;
        let comparison: RerankComparisonOutcome | null = null;
        let plannerUsage: PlannerUsage | null = null;
        let embeddingProviderCalls: number | null = null;
        const poolPath = join(
          preflight.runDirectory,
          "pools",
          `${question.id}-r${String(repeat).padStart(2, "0")}.json`,
        );

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
                  const artifact = buildPrivateRerankPoolArtifact(pool);
                  if (existsSync(poolPath)) {
                    const saved = JSON.parse(readFileSync(poolPath, "utf8")) as { poolSha256?: string };
                    if (saved.poolSha256 !== artifact.poolSha256) {
                      throw new Error("A2 resume pool differs from the checkpointed private pool");
                    }
                  } else {
                    writeJson(poolPath, artifact, true);
                  }
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

          const row = {
            status: rowValid ? "complete" : "invalid",
            questionId: question.id,
            category: question.category,
            question: question.question,
            supplemental: question.id.startsWith("supplemental-"),
            repeat,
            requestId,
            armExecutionOrder: armOrder,
            labelStatus: labels.status,
            evaluationKind: labels.evaluationKind,
            reviewNotes: labels.notes,
            poolSha256: observed.pool.poolSha256,
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
          };
          rows.push(row);
          if (!rowValid) {
            consecutiveSystemFailures += 1;
            failures.push({
              questionId: question.id,
              repeat,
              kind: invalidArm ? "rerank_degraded" : "pipeline_degraded",
            });
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
          failures.push(failure);
          const observed = comparison as RerankComparisonOutcome | null;
          rows.push({
            status: "failed",
            ...failure,
            armExecutionOrder: armOrder,
            plannerUsage,
            embeddingProviderCalls,
            ...(observed ? {
              poolSha256: observed.pool.poolSha256,
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

        const checkpoint = {
          schemaVersion: A2_SCHEMA_VERSION,
          runId: preflight.runId,
          definitionSha256: preflight.definitionSha256,
          resumed: preflight.resumed,
          repeatsPlanned: preflight.repeats,
          questionsPlanned: runQuestions.length,
          completedRows: completedRowKeys.size,
          attempts: rows.length,
          failures,
          rows,
        };
        writeJson(checkpointPath, checkpoint);
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
    const currentTotals = armTotals(rows, "current");
    const globalTotals = armTotals(rows, "global");
    const knownUnits = currentTotals.billedSearchUnits !== null
      && globalTotals.billedSearchUnits !== null
      ? currentTotals.billedSearchUnits + globalTotals.billedSearchUnits
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
      resumed: preflight.resumed,
      repeats: preflight.repeats,
      repeatsPlanned: preflight.repeats,
      questionsPlanned: runQuestions.length,
      runtime: {
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
      attempts: rows.length,
      labelState: {
        ownerApproved: goldSet.questions.filter((question) => !question.needs_human_review).length,
        suggestedPendingOwnerReview: goldSet.questions.filter((question) => question.needs_human_review).length,
        supplementalSuggestedPendingOwnerReview: supplementalQuestions.length,
      },
      timingDefinition: "shared planning/retrieval/fusion plus that arm's rerank; downstream rendering is not compared",
      totals: { current: currentTotals, global: globalTotals },
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
      failures,
      rows,
    };
    writeJson(checkpointPath, finalReport);

    expect(completedRowKeys.size).toBe(preflight.repeats * runQuestions.length);
  });
});
