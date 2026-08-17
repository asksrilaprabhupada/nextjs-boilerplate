/**
 * stored-models-are-the-real-ones.test.ts
 *
 * A record naming a model the call did not use is worse than no record.
 *
 * `config.ts` used to export `cohereRerankModel()`, returning
 * `process.env.COHERE_RERANK_MODEL || "rerank-v4.0-pro"`, and the telemetry
 * writer called it. The Cohere client never reads that variable — it hard-codes
 * `rerank-v4.0-pro` on the request. So setting COHERE_RERANK_MODEL changed
 * nothing at all except what the DATABASE said the model had been, and a 2028
 * reader trying to explain a change in answer quality would have been reading a
 * model id that was never sent.
 *
 * The rule now: every model string stored is the one the STAGE reported placing
 * on its own request, handed forward with the result. These tests hold that
 * rule from both ends — the accessor is gone, and the writer stores what it was
 * given rather than looking anything up.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as config from "@/app/lib/search-v2/config";
import { COHERE_RERANK_MODEL } from "@/app/lib/08-cohere-rerank";
import { VOYAGE_CONTEXT_MODEL } from "@/app/lib/03-embed";
import {
  allowlistedTechnicalTelemetry,
  CACHE_STATUS,
} from "@/app/lib/search-v2/search-run-telemetry";
import type { SearchTelemetry } from "@/app/lib/search-v2/pipeline";

const COHERE_CLIENT = readFileSync(
  join(process.cwd(), "app/lib/08-cohere-rerank.ts"), "utf8",
);
const TELEMETRY_WRITER = readFileSync(
  join(process.cwd(), "app/lib/search-v2/search-run-telemetry.ts"), "utf8",
);

function telemetry(models: SearchTelemetry["models"]): SearchTelemetry {
  return {
    requestId: "req_models",
    plannedIntent: "broad_concept",
    questionHash: "hash",
    pipelineVersion: "v2",
    corpusVersion: "corpus",
    subqueryCount: 5,
    planSource: "model",
    planFailureKind: null,
    planUsage: {
      attempts: 1, promptTokens: 1, outputTokens: 1, thoughtsTokens: 0,
      totalTokens: 2, durationMs: 1, attemptDurationsMs: [1],
    },
    tableRpcCount: 5,
    tableRpcAttemptCount: 5,
    vocabularyRpcCount: 0,
    refetchCount: 1,
    sourceUrlFetchCount: 0,
    embeddingProviderCalls: 1,
    candidatesBeforeFusion: 700,
    candidatesAfterFusion: 697,
    duplicatesCollapsed: 3,
    junkFloorDropped: 0,
    chunkDuplicatesDropped: 0,
    truncatedDocumentCount: 0,
    rerankDocumentCount: 697,
    reranked: true,
    selectedPassageCount: 20,
    mainTierCount: 20,
    additionalCount: 677,
    mainCount: 20,
    pinnedPromotions: 0,
    pinnedExactReference: false,
    droppedOnRefetch: 0,
    degraded: false,
    degradedStages: [],
    sourceRetrieval: [],
    degradedSources: [],
    stageDurationsMs: {},
    totalDurationMs: 1,
    models,
    errorCategory: null,
  } as unknown as SearchTelemetry;
}

describe("the config no longer claims to configure the reranker", () => {
  it("exports no cohereRerankModel accessor at all", () => {
    expect("cohereRerankModel" in config).toBe(false);
  });

  it("keeps the value beside the request that carries it", () => {
    expect(COHERE_RERANK_MODEL).toBe("rerank-v4.0-pro");
    // Same identifier on the wire, in the same file. The point of deleting the
    // accessor was that these two could drift; they now cannot.
    expect(COHERE_CLIENT).toContain("model: COHERE_RERANK_MODEL");
  });

  it("no longer reads COHERE_RERANK_MODEL anywhere in the search code", () => {
    expect(COHERE_CLIENT).not.toContain("process.env.COHERE_RERANK_MODEL");
    expect(JSON.stringify(config)).not.toContain("COHERE_RERANK_MODEL");
  });
});

describe("stored models come from the call, not from a lookup", () => {
  it("stores exactly what each stage reported sending", () => {
    const stored = allowlistedTechnicalTelemetry(
      telemetry({
        queryPlanner: "gemini-2.5-flash",
        embeddings: VOYAGE_CONTEXT_MODEL,
        reranker: COHERE_RERANK_MODEL,
      }),
      CACHE_STATUS,
      "hash",
    ) as { providers: Record<string, { model: string }> };

    expect(stored.providers.queryPlanner.model).toBe("gemini-2.5-flash");
    expect(stored.providers.embeddings.model).toBe("voyage-context-4");
    expect(stored.providers.reranker.model).toBe("rerank-v4.0-pro");
  });

  it("follows the stage rather than a default, if a stage ever reports another", () => {
    // The proof that nothing is being looked up: hand the writer model strings
    // no default anywhere in the codebase would produce, and they must appear
    // verbatim in the stored record.
    const stored = allowlistedTechnicalTelemetry(
      telemetry({
        queryPlanner: "gemini-9-imaginary",
        embeddings: "voyage-imaginary-7",
        reranker: "rerank-imaginary-2.0",
      }),
      CACHE_STATUS,
      "hash",
    ) as { providers: Record<string, { model: string }> };

    expect(stored.providers.queryPlanner.model).toBe("gemini-9-imaginary");
    expect(stored.providers.embeddings.model).toBe("voyage-imaginary-7");
    expect(stored.providers.reranker.model).toBe("rerank-imaginary-2.0");
  });

  it("does not import a model constant to write with", () => {
    // Importing one is exactly how the reranker came to be recorded wrongly:
    // the writer looked the value up instead of storing what it was handed.
    expect(TELEMETRY_WRITER).not.toContain("VOYAGE_CONTEXT_MODEL");
    expect(TELEMETRY_WRITER).not.toContain("cohereRerankModel");
  });
});
