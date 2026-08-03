/** Regression coverage for speaker-only verification degradation semantics. */
import { describe, expect, it } from "vitest";
import { incompleteSearchWarning } from "@/app/components/results/02-incomplete-search-warning";
import { degradedSourcesForWire } from "@/app/lib/search-v2/adapt";
import {
  FILTERED_TRANSCRIPT_VERIFICATION_PARTIAL_CODE,
  hasFilteredTranscriptVerificationDrop,
} from "@/app/lib/search-v2/pipeline";
import { shouldCacheSearchResult } from "@/app/api/search/route";

const partialWireSources = () => degradedSourcesForWire({
  degradedSources: [],
  degradedStages: [{
    stage: "verification",
    source: "filtered_transcripts",
    code: FILTERED_TRANSCRIPT_VERIFICATION_PARTIAL_CODE,
  }],
});

describe("speaker-only verification degradation", () => {
  it.each(["fetch_failed", "row_not_found", "empty_text", "speaker_projection_mismatch"])(
    "warns and blocks cache when a main transcript is dropped for %s",
    (reason) => {
      const partial = hasFilteredTranscriptVerificationDrop(
        true,
        [{ passageKey: `lecture:dropped-${reason}` }],
        [],
      );
      expect(partial).toBe(true);
      const wireSources = partialWireSources();
      expect(wireSources).toEqual([{
        source: "Lectures and conversations",
        reason: "some passages could not be verified",
      }]);
      expect(incompleteSearchWarning(wireSources)).toContain(
        "Some passages from lectures and conversations could not be verified",
      );
      expect(shouldCacheSearchResult({
        telemetry: { degraded: true, degradedSources: [] },
        evidenceInsufficient: false,
      })).toBe(false);
    },
  );

  it("warns when a filtered additional transcript is dropped", () => {
    expect(hasFilteredTranscriptVerificationDrop(
      true,
      [],
      [{ passageKey: "lecture:additional" }],
    )).toBe(true);
  });

  it("does not label non-transcript main drops as a transcript outage", () => {
    expect(hasFilteredTranscriptVerificationDrop(
      true,
      [{ passageKey: "verse:missing" }, { passageKey: "book:missing" }],
      [],
    )).toBe(false);
  });

  it("does not invent a speaker-filter outage in unfiltered mode", () => {
    expect(hasFilteredTranscriptVerificationDrop(
      false,
      [{ passageKey: "lecture:missing" }],
      [],
    )).toBe(false);
  });

  it("keeps total source outages distinct from row-level verification loss", () => {
    const sources = degradedSourcesForWire({
      degradedSources: ["Lectures and conversations"],
      degradedStages: [{
        stage: "verification",
        source: "filtered_transcripts",
        code: FILTERED_TRANSCRIPT_VERIFICATION_PARTIAL_CODE,
      }],
    });
    expect(sources).toEqual([{
      source: "Lectures and conversations",
      reason: "temporarily unavailable",
    }]);
    expect(incompleteSearchWarning(sources)).toContain(
      "Lectures and conversations could not be searched this time",
    );
  });
});
