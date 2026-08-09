import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  A2_CONTINUATION_RUN_ID,
  a2QualityCarryPath,
  assertA2EvidenceAuditEnvironment,
  assertStoredA2QualityCarryManifest,
  buildA2QualityCarryState,
  createStoredA2QualityCarryManifest,
  redactedA2CarrySummary,
} from "@/tests/a2-quality-carry";

const AUDIT_MARKER = "I_APPROVE_LOCAL_A2_EVIDENCE_AUDIT";
const WRITE_MARKER = "I_APPROVE_LOCAL_A2_CARRY_MANIFEST";

describe("local frozen A2 carry-evidence audit", () => {
  it("derives only the redacted 43/5/1/215 continuation state with zero live access", async () => {
    expect(process.env.A2_LOCAL_EVIDENCE_AUDIT).toBe(AUDIT_MARKER);
    expect(process.env.A2_WRITE_QUALITY_CARRY).toBe(WRITE_MARKER);
    assertA2EvidenceAuditEnvironment();
    const evidenceRoot = resolve("work/a2-rerank-comparison");
    const continuationDirectory = resolve(evidenceRoot, A2_CONTINUATION_RUN_ID);
    expect(existsSync(continuationDirectory)).toBe(false);

    process.env.A2_STATE_UNIT_TEST_ONLY = "1";
    const stateModule = await (async () => {
      try {
        return await import("@/tests/a2-rerank-comparison.live");
      } finally {
        delete process.env.A2_STATE_UNIT_TEST_ONLY;
      }
    })();
    const definitionSha256 = stateModule.computeA2RunDefinitionSha256(4, 2.50, 14.605969);
    const state = buildA2QualityCarryState({ evidenceRoot, definitionSha256 });
    const carryPath = a2QualityCarryPath(evidenceRoot);
    createStoredA2QualityCarryManifest(carryPath, state);
    assertStoredA2QualityCarryManifest(carryPath, state);
    const revalidated = buildA2QualityCarryState({ evidenceRoot, definitionSha256 });
    expect(revalidated.manifestSha256).toBe(state.manifestSha256);
    process.stderr.write(`${JSON.stringify({
      ...redactedA2CarrySummary(state),
      externalCallsMade: 0,
      continuationArtifactsWritten: 0,
      carryManifestWritten: 1,
    })}\n`);
    expect(state.counts).toMatchObject({
      strict: 43,
      quality_only: 5,
      source_degraded_retry: 1,
      untouched: 215,
      carriedQualityRows: 48,
      pendingPaidRows: 216,
      totalLogicalRows: 264,
    });
    expect(existsSync(continuationDirectory)).toBe(false);
  });
});
