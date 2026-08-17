/**
 * no-ai-text-on-the-page.test.ts — The organizing step is gone, and stays gone.
 *
 * A Gemini call used to arrange the main tier and write a title. The title was
 * printed above the answer as a framing note — one real saved answer opened
 * with "Navigating Marriage and Brahmacharya Despite Astrological Predictions"
 * — on a page whose whole premise is that it carries only Śrīla Prabhupāda's
 * words. The arrangement, meanwhile, never reached the browser at all: the
 * response's `passages` array has always been the SELECTOR's list, and the
 * rendered sections were built, counted for telemetry, and dropped.
 *
 * So the acceptance test is not "the order changed". It is: the page prints the
 * ranked list in the order it arrived, no model writes anything a reader sees,
 * and no jump list re-states the passage count above it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { adaptToSearchResults } from "@/app/lib/search-v2/adapt";
import type { PipelineOutput } from "@/app/lib/search-v2/pipeline";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";

const RESULTS_VIEW = readFileSync(
  join(process.cwd(), "app/components/results/01-narrative-response.tsx"),
  "utf8",
);

function verified(passageKey: string, reference: string, rerankScore: number): VerifiedPassage {
  return {
    passageKey,
    sourceType: "verse",
    rowId: passageKey,
    text: `Text of ${reference}`,
    reference,
    scripture: "BG",
    division: null,
    chapterNumber: 6,
    sanskrit: null,
    transliteration: null,
    synonyms: null,
    purport: null,
    speaker: null,
    speakerConfidence: null,
    recipient: null,
    date: null,
    location: null,
    vedabaseUrl: null,
    selection: {
      candidate: { rerankScore, alternates: [] },
    },
  } as unknown as VerifiedPassage;
}

/** Four passages in a deliberately non-alphabetical rerank order. */
const RANKED = [
  verified("verse:c", "BG 18.66", 0.91),
  verified("verse:a", "BG 6.34", 0.77),
  verified("verse:d", "BG 2.13", 0.52),
  verified("verse:b", "BG 9.22", 0.31),
];

function pipelineOutput(): PipelineOutput {
  return {
    passages: RANKED,
    additional: [],
    telemetry: {
      requestId: "req_order",
      degraded: false,
      degradedStages: [],
      degradedSources: [],
      droppedOnRefetch: 0,
    },
    uncoveredQueryIds: [],
    evidenceInsufficient: false,
  } as unknown as PipelineOutput;
}

describe("no model writes anything a devotee reads", () => {
  it("puts no intro on the wire — the field is removed, not emptied", () => {
    const wire = adaptToSearchResults("how do I control my mind", pipelineOutput());

    // Not `toBeUndefined()`: an always-undefined key that a client still reads
    // is exactly the half-measure this job was told not to ship.
    expect(Object.keys(wire)).not.toContain("intro");
    expect(JSON.stringify(wire)).not.toMatch(/"intro"/);
  });

  it("prints the ranked list in the order it arrived, id for id", () => {
    const wire = adaptToSearchResults("how do I control my mind", pipelineOutput());

    expect(wire.passages.map((p) => p.reference)).toEqual(
      ["BG 18.66", "BG 6.34", "BG 2.13", "BG 9.22"],
    );
    // The scores are already descending on arrival; nothing downstream re-sorts
    // them, and nothing downstream is allowed to.
    expect(wire.passages.map((p) => p.rerankScore)).toEqual([0.91, 0.77, 0.52, 0.31]);
  });

  it("has no article planner left to call", () => {
    expect(existsSync(join(process.cwd(), "app/lib/search-v2/article-plan.ts"))).toBe(false);
  });

  it("renders neither the framing line nor the Contents jump list", () => {
    expect(RESULTS_VIEW).not.toContain("results.intro");
    expect(RESULTS_VIEW).not.toContain("framing-intro");
    expect(RESULTS_VIEW).not.toMatch(/Contents\s*·/);
  });
});
