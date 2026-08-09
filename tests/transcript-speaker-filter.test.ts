/** Regression coverage for complete transcript evidence and conservative labels. */
import { describe, expect, it } from "vitest";
import {
  CANONICAL_PRABHUPADA_SPEAKER,
  segmentTranscriptParagraph,
  transcriptSpeakerAttribution,
} from "@/app/lib/15-transcript-speakers";
import { buildFoldPreviewHtml } from "@/app/lib/10-passage-fold";
import { refetchAndVerify } from "@/app/lib/search-v2/refetch";
import type { SelectedPassage } from "@/app/lib/search-v2/select";
import type { RetrievedCandidate } from "@/app/lib/search-v2/fusion";

const mixed = [
  "Dr. Patel: A guest asks about the mind.",
  "Prabhupāda: The mind can be controlled by practice.",
  "Guest: Another guest asks about detachment.",
  "Śrīla Prabhupāda: And by detachment.",
].join("\n");

function candidate(id: string, text: string): RetrievedCandidate {
  return {
    passage_key: `lecture:${id}`,
    source_type: "lecture",
    row_id: id,
    retrieval_text: text,
    reference: "Room Conversation",
    speaker: null,
    recipient: null,
    occurred_on: "1974-01-01",
    location: "Bombay",
    matched_query_ids: [],
    channel_ranks: [],
    channel_scores: {},
    tag_matches: 0,
  };
}

function selected(item: RetrievedCandidate): SelectedPassage {
  return {
    candidate: {
      ...item,
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

describe("transcript speaker attribution", () => {
  it("reports every identified speaker in first-appearance order", () => {
    expect(transcriptSpeakerAttribution(mixed)).toEqual({
      speakers: ["Dr. Patel", CANONICAL_PRABHUPADA_SPEAKER, "Guest"],
      displaySpeaker: `Dr. Patel, ${CANONICAL_PRABHUPADA_SPEAKER}, Guest`,
      unidentified: false,
      confidence: "labelled",
    });
  });

  it("keeps a leading continuation unidentified alongside proved names", () => {
    expect(transcriptSpeakerAttribution("Leading continuation.\nDr. Patel: Answer.")).toEqual({
      speakers: ["Dr. Patel"],
      displaySpeaker: "Dr. Patel",
      unidentified: true,
      confidence: "unknown",
    });
    expect(transcriptSpeakerAttribution("No prefix at all.")).toEqual({
      speakers: [],
      displaySpeaker: null,
      unidentified: true,
      confidence: "unknown",
    });
  });

  it("recognizes standalone and no-space turn boundaries without merging speakers", () => {
    const source = [
      "Prabhupāda:\nKeep this exact turn.",
      "Devotees:. [kīrtana]",
      "Guest (1):A distinct turn without a space.",
    ].join("\n");
    expect(segmentTranscriptParagraph(source).map((part) => part.speaker)).toEqual([
      "Prabhupāda",
      "Devotees",
      "Guest (1)",
    ]);
  });
});

describe("complete transcript verification", () => {
  const rows = [
    { id: "mixed", title: "Room Conversation", body_text: mixed, date: "1974-01-01", location: "Bombay" },
    { id: "guest", title: "Room Conversation", body_text: "Dr. Patel: Guest-only evidence.", date: "1974-01-01", location: "Bombay" },
    { id: "unknown", title: "Room Conversation", body_text: "Wholly unlabelled continuation.", date: "1974-01-01", location: "Bombay" },
  ];

  it("keeps mixed, guest-only, and unlabelled body text byte-for-byte", async () => {
    const columnsSeen: string[] = [];
    const selections = rows.map((row) => selected(candidate(String(row.id), String(row.body_text))));
    const out = await refetchAndVerify(
      fakeDb(rows, columnsSeen) as never,
      selections,
      { requestId: "req-complete-transcripts" },
    );

    expect(out.dropped).toEqual([]);
    expect(out.verified.map((passage) => passage.text)).toEqual(rows.map((row) => row.body_text));
    expect(out.verified.map((passage) => passage.speaker)).toEqual([
      `Dr. Patel, ${CANONICAL_PRABHUPADA_SPEAKER}, Guest`,
      "Dr. Patel",
      null,
    ]);
    expect(out.verified.map((passage) => passage.speakerConfidence)).toEqual([
      "labelled",
      "labelled",
      "unknown",
    ]);
    expect(columnsSeen[0]).not.toContain("speaker");
  });

  it("still fails closed when the authoritative row changed", async () => {
    const stale = selected(candidate("mixed", `${mixed} stale`));
    const out = await refetchAndVerify(
      fakeDb([rows[0]]) as never,
      [stale],
      { requestId: "req-stale-transcript" },
    );
    expect(out.verified).toEqual([]);
    expect(out.dropped).toEqual([{ passageKey: "lecture:mixed", reason: "text_mismatch" }]);
  });

  it("lets a relevant guest sentence lead a long folded preview", () => {
    const source = [
      "Prabhupāda: This opening sentence discusses another subject.",
      ...Array.from({ length: 80 }, (_, index) => `Prabhupāda: Context sentence ${index} remains verbatim and deliberately long.`),
      "Dr. Patel: The distinctive guestneedle answer is present in full.",
    ].join("\n");
    const preview = buildFoldPreviewHtml({
      type: "lecture",
      text: source,
      queryTerms: ["guestneedle"],
    });

    expect(preview.truncated).toBe(true);
    expect(preview.previewHtml).toContain("guestneedle");
    expect(preview.previewHtml).toContain("Dr. Patel:");
  });
});
