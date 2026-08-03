import { describe, expect, it } from "vitest";
import {
  CANONICAL_PRABHUPADA_SPEAKER,
  projectPrabhupadaSegments,
  transcriptSpeakerAttribution,
} from "@/app/lib/15-transcript-speakers";
import {
  refetchAndVerify,
  refetchAndVerifyFilteredTranscripts,
} from "@/app/lib/search-v2/refetch";
import { fullSha256 } from "@/app/lib/search-v2/cache";
import type { SelectedPassage } from "@/app/lib/search-v2/select";
import type { RetrievedCandidate } from "@/app/lib/search-v2/fusion";

const mixed = [
  "Dr. Patel: guest sentinel one.",
  "Prabhupāda: The mind can be controlled by practice.",
  "Guest: guest sentinel two.",
  "Śrīla Prabhupāda: And by detachment.",
].join("\r\n");

function projectedCandidate(over: Partial<RetrievedCandidate> = {}): RetrievedCandidate {
  const projection = projectPrabhupadaSegments(mixed);
  return {
    passage_key: "lecture:t1",
    source_type: "lecture",
    row_id: "t1",
    retrieval_text: projection.text,
    reference: "Conversation",
    speaker: CANONICAL_PRABHUPADA_SPEAKER,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: [],
    channel_ranks: [],
    channel_scores: {},
    tag_matches: 0,
    speakerUnidentified: false,
    speakerProjection: {
      mode: "prabhupada_segments",
      sourceVerificationHash: fullSha256(mixed),
      keptSegments: projection.keptSegments,
      guestSegmentsRemoved: projection.guestSegmentsRemoved,
      unknownSegmentsRemoved: projection.unknownSegmentsRemoved,
    },
    ...over,
  };
}

function selected(candidate: RetrievedCandidate): SelectedPassage {
  return {
    candidate: {
      ...candidate,
      fusedScore: 1,
      contributions: [],
      queryCoverage: [],
      alternates: [],
      rerankScore: 1,
    },
    reasons: [],
    contextRequirements: ["conversation_context"],
    rerankPosition: 0,
  } as SelectedPassage;
}

function fakeDb(rows: Record<string, unknown>[], columnsSeen: string[] = []) {
  return {
    rpc: async () => ({ data: null, error: null }),
    from(table: string) {
      expect(table).toBe("transcript_paragraphs");
      return {
        select(columns: string) {
          columnsSeen.push(columns);
          return {
            in(_column: string, ids: string[]) {
              return Promise.resolve({
                data: rows.filter((row) => ids.includes(String(row.id))),
                error: null,
              });
            },
          };
        },
      };
    },
  };
}

describe("transcript speaker projection", () => {
  it("keeps exact canonical turns and removes guest turns without inserting bytes", () => {
    const out = projectPrabhupadaSegments(mixed);
    expect(out).toEqual({
      text: "Prabhupāda: The mind can be controlled by practice.\r\nŚrīla Prabhupāda: And by detachment.",
      keptSegments: 2,
      guestSegmentsRemoved: 2,
      unknownSegmentsRemoved: 0,
    });
    expect(projectPrabhupadaSegments(out.text).text).toBe(out.text);
  });

  it("drops leading unknown text and projects guest-only or unlabelled rows to empty", () => {
    expect(projectPrabhupadaSegments(
      "Unidentified continuation.\nPrabhupada: Keep this exact line.",
    )).toEqual({
      text: "Prabhupada: Keep this exact line.",
      keptSegments: 1,
      guestSegmentsRemoved: 0,
      unknownSegmentsRemoved: 1,
    });
    expect(projectPrabhupadaSegments("Dr. Patel: guest only.").text).toBe("");
    expect(projectPrabhupadaSegments("No prefix at all.").text).toBe("");
    expect(projectPrabhupadaSegments("the process: this is prose, not a label.").text).toBe("");
  });

  it("treats lowercase-role, long, punctuated, and heading prefixes as safety boundaries", () => {
    const adversarial = [
      "Prabhupāda: Keep this first exact turn.",
      "Indian man: lowercase-role guest sentinel.",
      "A Very Long Visiting Indian Gentleman: long-label guest sentinel.",
      "Guest #1: punctuated guest sentinel.",
      "Translation: heading sentinel.",
      "Śrīla Prabhupāda: Keep this second exact turn.",
    ].join("\n");

    expect(projectPrabhupadaSegments(adversarial)).toEqual({
      text: [
        "Prabhupāda: Keep this first exact turn.\n",
        "Śrīla Prabhupāda: Keep this second exact turn.",
      ].join(""),
      keptSegments: 2,
      guestSegmentsRemoved: 2,
      unknownSegmentsRemoved: 2,
    });
    const attribution = transcriptSpeakerAttribution(adversarial);
    expect(attribution.speakers).toEqual([
      CANONICAL_PRABHUPADA_SPEAKER,
      "Indian man",
      "A Very Long Visiting Indian Gentleman",
    ]);
    expect(attribution.unidentified).toBe(true);
    expect(JSON.stringify(projectPrabhupadaSegments(adversarial))).not.toContain("guest sentinel");
    expect(JSON.stringify(projectPrabhupadaSegments(adversarial))).not.toContain("heading sentinel");
  });

  it("treats no-space turn labels as boundaries instead of leaking guest text", () => {
    const noSpaceTurns = [
      "Prabhupada: Keep this first exact turn.",
      "Devotees:. [kirtana guest sentinel]",
      "Prabhupada:? Keep this canonical no-space turn.",
      "Guest (1):Guest sentinel without a space.",
    ].join("\n");

    const out = projectPrabhupadaSegments(noSpaceTurns);
    expect(out.text).toBe([
      "Prabhupada: Keep this first exact turn.\n",
      "Prabhupada:? Keep this canonical no-space turn.\n",
    ].join(""));
    expect(out).toMatchObject({
      keptSegments: 2,
      guestSegmentsRemoved: 2,
      unknownSegmentsRemoved: 0,
    });
    expect(out.text).not.toContain("guest sentinel");
    expect(out.text).not.toContain("Guest sentinel");
  });

  it("does not present transcript headings as speaker names", () => {
    expect(transcriptSpeakerAttribution("Translation: A heading, not a speaker.")).toEqual({
      speakers: [],
      displaySpeaker: null,
      unidentified: true,
      confidence: "unknown",
    });
  });

  it("keeps canonical labels whose punctuation is removed by normalization", () => {
    for (const punctuatedCanonical of [
      "Prabhup\u0101da.: Keep this exact turn.",
      "Prabhup\u00e6ada: Keep this ligature edge case.",
      "Prabhu1p\u0101da: Keep this digit edge case.",
      "Prabhupada:\r",
    ]) {
      expect(projectPrabhupadaSegments(punctuatedCanonical)).toEqual({
        text: punctuatedCanonical,
        keptSegments: 1,
        guestSegmentsRemoved: 0,
        unknownSegmentsRemoved: 0,
      });
    }
  });

  it("reports every identified speaker and marks only genuinely unknown bytes unknown", () => {
    expect(transcriptSpeakerAttribution(mixed)).toEqual({
      speakers: ["Dr. Patel", CANONICAL_PRABHUPADA_SPEAKER, "Guest"],
      displaySpeaker: `Dr. Patel, ${CANONICAL_PRABHUPADA_SPEAKER}, Guest`,
      unidentified: false,
      confidence: "labelled",
    });
    expect(transcriptSpeakerAttribution("Leading continuation.\nDr. Patel: Answer.")).toMatchObject({
      displaySpeaker: "Dr. Patel",
      unidentified: true,
      confidence: "unknown",
    });
    expect(transcriptSpeakerAttribution("No prefix.")).toEqual({
      speakers: [],
      displaySpeaker: null,
      unidentified: true,
      confidence: "unknown",
    });
  });
});

describe("fresh-row speaker projection", () => {
  const row = {
    id: "t1",
    title: "Room Conversation",
    body_text: mixed,
    date: "1974-01-01",
    location: "Bombay",
  };

  it("reconstructs filtered main text from body_text without speaker columns", async () => {
    const columnsSeen: string[] = [];
    const out = await refetchAndVerify(
      fakeDb([row], columnsSeen) as never,
      [selected(projectedCandidate())],
      { requestId: "req-filtered", speakerOnly: true },
    );
    expect(out.dropped).toEqual([]);
    expect(out.verified[0]).toMatchObject({
      text: projectPrabhupadaSegments(mixed).text,
      speaker: CANONICAL_PRABHUPADA_SPEAKER,
      speakerConfidence: "labelled",
    });
    expect(columnsSeen[0]).not.toContain("speaker");
    expect(JSON.stringify(out.verified)).not.toContain("guest sentinel");
  });

  it("fails closed when the marker is missing or the full row changed", async () => {
    const missing = projectedCandidate({ speakerProjection: undefined });
    const missingOut = await refetchAndVerify(
      fakeDb([row]) as never,
      [selected(missing)],
      { requestId: "req-missing", speakerOnly: true },
    );
    expect(missingOut.dropped[0].reason).toBe("speaker_projection_missing");

    const stale = projectedCandidate({
      speakerProjection: {
        ...projectedCandidate().speakerProjection!,
        sourceVerificationHash: fullSha256(`${mixed} changed`),
      },
    });
    const staleOut = await refetchAndVerify(
      fakeDb([row]) as never,
      [selected(stale)],
      { requestId: "req-stale", speakerOnly: true },
    );
    expect(staleOut.dropped[0].reason).toBe("speaker_projection_mismatch");
  });

  it("derives all names from the fresh unfiltered body", async () => {
    const candidate = projectedCandidate({
      retrieval_text: mixed,
      speaker: "stale speaker",
      speakerProjection: undefined,
    });
    const out = await refetchAndVerify(
      fakeDb([row]) as never,
      [selected(candidate)],
      { requestId: "req-all" },
    );
    expect(out.verified[0].speaker).toBe(`Dr. Patel, ${CANONICAL_PRABHUPADA_SPEAKER}, Guest`);
    expect(out.verified[0].speakerConfidence).toBe("labelled");
  });

  it("freshly verifies filtered additional transcript previews", async () => {
    const candidate = projectedCandidate();
    const out = await refetchAndVerifyFilteredTranscripts(
      fakeDb([row]) as never,
      [candidate],
      { requestId: "req-additional" },
    );
    expect(out.dropped).toEqual([]);
    expect(out.textByPassageKey.get(candidate.passage_key)).toBe(projectPrabhupadaSegments(mixed).text);
    expect(out.textByPassageKey.get(candidate.passage_key)).not.toContain("guest sentinel");
  });
});
