import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashA2StableEvidenceTree } from "@/tests/a2-quality-carry";
import {
  A2_LIFETIME_MAX_MICROUSD,
  A2_PRIOR_COMMITTED_MICROUSD,
  A2_SUCCESSOR_DEFINITION_CRITICAL_FILES,
  A2_SUCCESSOR_MAX_MICROUSD,
  A2_SUCCESSOR_RUN_ID,
  assertA2FrozenSuccessorEvidenceDirectory,
  assertA2SuccessorEvidenceAuditEnvironment,
  assertA2SuccessorFreshDestination,
  assertA2SuccessorLedgerAttemptKeys,
  deriveA2SuccessorFrozenCoverage,
} from "@/tests/a2-successor-carry";

const temporaryDirectories: string[] = [];

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeSyntheticEvidence(directory: string): void {
  mkdirSync(join(directory, "pools"));
  writeFileSync(join(directory, "comparison-report.json"), "report-v1", "utf8");
  writeFileSync(join(directory, "run-manifest.json"), "manifest-v1", "utf8");
  writeFileSync(join(directory, "spend-ledger.jsonl"), "ledger-v1\n", "utf8");
  writeFileSync(join(directory, "pools", "q001-r01-a01.json"), "pool-v1", "utf8");
}

function descriptorFor(directory: string) {
  const tree = hashA2StableEvidenceTree(directory);
  return {
    label: "synthetic continuation",
    stableTreeSha256: tree.sha256,
    stableFileCount: tree.fileCount,
    stableBytes: tree.bytes,
    pinnedFiles: {
      "comparison-report.json": sha256File(join(directory, "comparison-report.json")),
      "run-manifest.json": sha256File(join(directory, "run-manifest.json")),
      "spend-ledger.jsonl": sha256File(join(directory, "spend-ledger.jsonl")),
    },
  };
}

function exactCoverageInput() {
  return {
    classes: [
      ...Array(43).fill("old_strict"),
      ...Array(5).fill("old_quality_only"),
      ...Array(67).fill("continuation_complete"),
      "pending_invalid",
      ...Array(148).fill("pending_unattempted"),
    ],
    continuationVoyageProviderCalls: [
      ...Array(66).fill(1),
      0,
    ],
    pendingNextLineageAttempts: [
      ...Array(148).fill(1),
      3,
    ],
  } as const;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("A2 immutable successor carry", () => {
  it("accepts only the exact 43+5 old, 67 current, and 1+148 pending partition", () => {
    expect(deriveA2SuccessorFrozenCoverage(exactCoverageInput())).toEqual({
      oldStrict: 43,
      oldQualityOnly: 5,
      continuationComplete: 67,
      pendingInvalid: 1,
      pendingUnattempted: 148,
      continuationVoyageOneCall: 66,
      continuationVoyageZeroCall: 1,
      pendingNextLineageOne: 148,
      pendingNextLineageThree: 1,
      oldCarriedQualityRows: 48,
      carriedQualityRows: 115,
      pendingPaidRows: 149,
      totalLogicalRows: 264,
    });

    const wrongClass = exactCoverageInput();
    expect(() => deriveA2SuccessorFrozenCoverage({
      ...wrongClass,
      classes: [...wrongClass.classes.slice(0, -1), "continuation_complete"],
    })).toThrow(/43.*5.*67.*1.*148|exact frozen successor coverage/iu);
    expect(() => deriveA2SuccessorFrozenCoverage({
      ...wrongClass,
      continuationVoyageProviderCalls: [...Array(65).fill(1), 0, 0],
    })).toThrow(/66.*one.*1.*zero|voyage/iu);
    expect(() => deriveA2SuccessorFrozenCoverage({
      ...wrongClass,
      pendingNextLineageAttempts: [...Array(147).fill(1), 2, 3],
    })).toThrow(/148.*1.*3|lineage/iu);
  });

  it("does not expose winner, score, pass, regression, rank, or Jaccard outcomes to coverage", () => {
    const input = exactCoverageInput();
    const oppositeOutcomes = {
      ...input,
      winner: "opposite",
      rerankScore: -999,
      automaticPass: false,
      globalQualityRegression: true,
      rankChange: 999,
      top20Jaccard: 0,
    };
    expect(deriveA2SuccessorFrozenCoverage(oppositeOutcomes))
      .toEqual(deriveA2SuccessorFrozenCoverage(input));
    expect(deriveA2SuccessorFrozenCoverage.toString()).not.toMatch(
      /winner|score|pass|regression|jaccard|rank(?:ing)?change/iu,
    );
  });

  it("fixes the successor budget to the exact remaining lifetime allowance", () => {
    expect(A2_PRIOR_COMMITTED_MICROUSD).toBe(16_690_960);
    expect(A2_SUCCESSOR_MAX_MICROUSD).toBe(8_309_040);
    expect(A2_LIFETIME_MAX_MICROUSD).toBe(25_000_000);
    expect(A2_PRIOR_COMMITTED_MICROUSD + A2_SUCCESSOR_MAX_MICROUSD)
      .toBe(A2_LIFETIME_MAX_MICROUSD);
  });

  it("allows only contiguous successor attempts beginning at frozen lineage", () => {
    const partition = {
      carriedLogicalKeys: new Set(["q-carried:1"]),
      pendingPaidLogicalKeys: new Set(["q-fresh:1", "q-invalid:1"]),
      nextLineageAttemptByLogicalKey: new Map([
        ["q-fresh:1", 1],
        ["q-invalid:1", 3],
      ]),
    };
    expect(() => assertA2SuccessorLedgerAttemptKeys(partition, [
      "q-fresh:1@1",
      "q-fresh:1@2",
      "q-invalid:1@3",
      "q-invalid:1@4",
    ])).not.toThrow();
    expect(() => assertA2SuccessorLedgerAttemptKeys(partition, ["q-carried:1@1"]))
      .toThrow(/carried|unapproved/iu);
    expect(() => assertA2SuccessorLedgerAttemptKeys(partition, ["q-unknown:1@1"]))
      .toThrow(/unknown|unapproved/iu);
    expect(() => assertA2SuccessorLedgerAttemptKeys(partition, ["q-fresh:1@2"]))
      .toThrow(/lineage|gap|attempt/iu);
    expect(() => assertA2SuccessorLedgerAttemptKeys(partition, [
      "q-invalid:1@3",
      "q-invalid:1@5",
    ])).toThrow(/lineage|gap|attempt/iu);
  });

  it("pins the complete stable tree and every named core evidence file", () => {
    const directory = temporaryDirectory("a2-successor-tree-");
    writeSyntheticEvidence(directory);
    const descriptor = descriptorFor(directory);
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(directory, descriptor))
      .not.toThrow();

    writeFileSync(join(directory, "comparison-report.json"), "report-drift", "utf8");
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(directory, descriptor))
      .toThrow(/drift|hash|tree/iu);
    writeFileSync(join(directory, "comparison-report.json"), "report-v1", "utf8");
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(directory, descriptor))
      .not.toThrow();

    writeFileSync(join(directory, "pools", "q001-r01-a01.json"), "pool-drift", "utf8");
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(directory, descriptor))
      .toThrow(/drift|hash|tree/iu);
  });

  it("rejects symlinks, non-directory roots, nested locks, and active root locks", () => {
    const directory = temporaryDirectory("a2-successor-shapes-");
    writeSyntheticEvidence(directory);
    const descriptor = descriptorFor(directory);

    writeFileSync(join(directory, "paid-run.lock.recovered-deadbeef"), "archive", "utf8");
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(directory, descriptor))
      .not.toThrow();
    writeFileSync(join(directory, "paid-run.lock"), "active", "utf8");
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(directory, descriptor))
      .toThrow(/active.*lock|paid-run\.lock/iu);
    unlinkSync(join(directory, "paid-run.lock"));

    writeFileSync(
      join(directory, "pools", "paid-run.lock.recovered-deadbeef"),
      "nested evidence",
      "utf8",
    );
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(directory, descriptor))
      .toThrow(/drift|hash|tree/iu);

    const fileRoot = join(temporaryDirectory("a2-successor-nonfile-"), "plain-file");
    writeFileSync(fileRoot, "not a directory", "utf8");
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(fileRoot, descriptor))
      .toThrow(/directory|non-file|nonfile/iu);

    const symlinkSource = temporaryDirectory("a2-successor-symlink-");
    writeSyntheticEvidence(symlinkSource);
    const symlinkDescriptor = descriptorFor(symlinkSource);
    const linkedTarget = temporaryDirectory("a2-successor-link-target-");
    writeFileSync(join(linkedTarget, "linked.json"), "private", "utf8");
    symlinkSync(linkedTarget, join(symlinkSource, "linked"), "junction");
    expect(() => assertA2FrozenSuccessorEvidenceDirectory(symlinkSource, symlinkDescriptor))
      .toThrow(/symbolic|symlink/iu);
  });

  it("requires an entirely absent successor destination", () => {
    const evidenceRoot = temporaryDirectory("a2-successor-fresh-");
    expect(() => assertA2SuccessorFreshDestination(evidenceRoot)).not.toThrow();
    mkdirSync(join(evidenceRoot, A2_SUCCESSOR_RUN_ID));
    expect(() => assertA2SuccessorFreshDestination(evidenceRoot))
      .toThrow(/already exists|fresh successor|destination/iu);
  });

  it("refuses every live credential, URL, paid mode, resume, retry, recovery, or stale-lock marker", () => {
    const forbidden = [
      "GEMINI_API_KEY",
      "VOYAGE_API_KEY",
      "COHERE_API_KEY",
      "SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "A2_MODE",
      "A2_PAID_RUN_APPROVED",
      "A2_RESUME_RUN",
      "A2_RETRY_APPROVAL",
      "A2_PRIOR_STALE_LOCK_APPROVAL",
      "A2_STOPPED_STALE_LOCK_APPROVAL",
      "A2_STALE_LOCK_APPROVAL",
      "A2_CONTINUATION_STALE_LOCK_APPROVAL",
      "A2_SUCCESSOR_STALE_LOCK_APPROVAL",
    ] as const;
    const prior = new Map(forbidden.map((name) => [name, process.env[name]]));
    try {
      for (const name of forbidden) delete process.env[name];
      expect(() => assertA2SuccessorEvidenceAuditEnvironment()).not.toThrow();
      for (const name of forbidden) {
        process.env[name] = "synthetic-never-used";
        expect(() => assertA2SuccessorEvidenceAuditEnvironment(), name)
          .toThrow(/credential|URL|mode|marker/iu);
        delete process.env[name];
      }
    } finally {
      for (const [name, value] of prior) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("binds every successor runtime and audit-critical file into the run definition", async () => {
    const priorStateOnly = process.env.A2_STATE_UNIT_TEST_ONLY;
    process.env.A2_STATE_UNIT_TEST_ONLY = "1";
    try {
      const state = await import("@/tests/a2-rerank-comparison.live");
      const baseline = state.computeA2RunDefinitionSha256(4, 2.50, 8.30904);
      expect(A2_SUCCESSOR_DEFINITION_CRITICAL_FILES.length).toBeGreaterThan(0);
      for (const relativePath of A2_SUCCESSOR_DEFINITION_CRITICAL_FILES) {
        const source = readFileSync(relativePath, "utf8");
        const changed = state.computeA2RunDefinitionSha256(4, 2.50, 8.30904, {
          [relativePath]: `${source}\n// synthetic definition drift`,
        });
        expect(changed, relativePath).not.toBe(baseline);
      }
    } finally {
      if (priorStateOnly === undefined) delete process.env.A2_STATE_UNIT_TEST_ONLY;
      else process.env.A2_STATE_UNIT_TEST_ONLY = priorStateOnly;
    }
  });
});
