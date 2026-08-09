import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  A2_SUCCESSOR_RUN_ID,
  a2SuccessorCarryPath,
  assertA2SuccessorEvidenceAuditEnvironment,
  assertStoredA2SuccessorCarryManifest,
  buildA2SuccessorCarryState,
  createStoredA2SuccessorCarryManifest,
  redactedA2SuccessorCarrySummary,
} from "@/tests/a2-successor-carry";

const AUDIT_MARKER = "I_APPROVE_LOCAL_A2_SUCCESSOR_EVIDENCE_AUDIT";
const WRITE_MARKER = "I_APPROVE_LOCAL_A2_SUCCESSOR_CARRY_MANIFEST";

describe("local frozen A2 successor carry-evidence audit", () => {
  it("derives only the redacted 115/149 successor state with zero live access", async () => {
    expect(process.env.A2_LOCAL_SUCCESSOR_EVIDENCE_AUDIT).toBe(AUDIT_MARKER);
    expect(process.env.A2_WRITE_SUCCESSOR_CARRY).toBe(WRITE_MARKER);
    assertA2SuccessorEvidenceAuditEnvironment();
    const evidenceRoot = resolve("work/a2-rerank-comparison");
    const successorDirectory = resolve(evidenceRoot, A2_SUCCESSOR_RUN_ID);
    expect(existsSync(successorDirectory)).toBe(false);

    process.env.A2_STATE_UNIT_TEST_ONLY = "1";
    const stateModule = await (async () => {
      try {
        return await import("@/tests/a2-rerank-comparison.live");
      } finally {
        delete process.env.A2_STATE_UNIT_TEST_ONLY;
      }
    })();
    const definitionSha256 = stateModule.computeA2RunDefinitionSha256(4, 2.50, 8.30904);
    const state = buildA2SuccessorCarryState({ evidenceRoot, definitionSha256 });
    const carryPath = a2SuccessorCarryPath(evidenceRoot);
    const carryExistedBefore = existsSync(carryPath);
    createStoredA2SuccessorCarryManifest(carryPath, state);
    assertStoredA2SuccessorCarryManifest(carryPath, state);
    const revalidated = buildA2SuccessorCarryState({ evidenceRoot, definitionSha256 });
    expect(revalidated.manifestSha256).toBe(state.manifestSha256);
    process.stderr.write(`${JSON.stringify({
      ...redactedA2SuccessorCarrySummary(state),
      externalCallsMade: 0,
      successorArtifactsWritten: 0,
      carryManifestWritten: carryExistedBefore ? 0 : 1,
    })}\n`);
    expect(state.counts).toMatchObject({
      oldStrict: 43,
      oldQualityOnly: 5,
      oldCarriedQualityRows: 48,
      continuationComplete: 67,
      carriedQualityRows: 115,
      pendingInvalid: 1,
      pendingUnattempted: 148,
      pendingPaidRows: 149,
      totalLogicalRows: 264,
      continuationVoyageOneCall: 66,
      continuationVoyageZeroCall: 1,
      pendingNextLineageOne: 148,
      pendingNextLineageThree: 1,
    });
    expect(state.carriedLogicalKeys.size).toBe(115);
    expect(state.pendingPaidLogicalKeys.size).toBe(149);
    expect(state.pendingInvalidLogicalKeys.size).toBe(1);
    expect(state.pendingUnattemptedLogicalKeys.size).toBe(148);
    expect(state.manifest.sourceEvidence.continuation.staleRetry.authoritative).toBe(false);
    expect(existsSync(successorDirectory)).toBe(false);
  });
});
