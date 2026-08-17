/**
 * Phase 4 presentation tests — names are attribution, unknown is explicit,
 * copied lectures keep that attribution, and follow-ups use canonical URLs.
 */
import { describe, expect, it } from "vitest";
import {
  formatLabel,
  labelForAdditionalPassage,
  labelForWirePassage,
} from "@/app/lib/13-passage-label";
import {
  transcriptSpeakerDisplay,
  UNIDENTIFIED_SPEAKER_NOTICE,
} from "@/app/lib/21-transcript-attribution";
import { buildSearchHref } from "@/app/lib/22-search-navigation";
import { buildPassageCopyText } from "@/app/lib/23-passage-copy";
import { contextNoticeFor } from "@/app/lib/search-v2/render";
import type { VerifiedPassage } from "@/app/lib/search-v2/refetch";

function lecture(over: Record<string, unknown> = {}): VerifiedPassage {
  return {
    passageKey: "lecture:1",
    sourceType: "lecture",
    rowId: "1",
    text: "Dr. Patel: What is mind?",
    reference: "Morning Walk",
    speaker: "Dr. Patel",
    speakerConfidence: "labelled",
    recipient: null,
    date: "1975-01-01",
    location: "Bombay",
    vedabaseUrl: null,
    sanskrit: null,
    transliteration: null,
    synonyms: null,
    purport: null,
    selection: { candidate: { alternates: [] } },
    ...over,
  } as unknown as VerifiedPassage;
}

describe("transcript attribution presentation", () => {
  it("shows an identified speaker plainly with one trailing colon", () => {
    expect(transcriptSpeakerDisplay("Dr. Patel:")).toBe("Dr. Patel:");
    const label = labelForWirePassage({
      type: "lecture",
      reference: "Morning Walk",
      speaker: "Dr. Patel",
    });
    expect(formatLabel(label)).toContain("Dr. Patel:");
    expect(label.provenanceNote).toBe("");
    expect(JSON.stringify(label)).not.toContain("not Śrīla Prabhupāda");
  });

  it("shows every identified name plainly in a multi-speaker block", () => {
    expect(transcriptSpeakerDisplay("Śrīla Prabhupāda, Dr. Patel")).toBe(
      "Śrīla Prabhupāda: · Dr. Patel:",
    );
  });

  it("uses the one explicit notice when no speaker is identified", () => {
    const main = labelForWirePassage({
      type: "lecture",
      reference: "Room Conversation",
      speaker: null,
      speakerConfidence: "unknown",
    });
    const additional = labelForAdditionalPassage({
      type: "lecture",
      reference: "Room Conversation",
      speaker: null,
    });
    expect(main.provenanceNote).toBe(UNIDENTIFIED_SPEAKER_NOTICE);
    expect(additional.provenanceNote).toBe(UNIDENTIFIED_SPEAKER_NOTICE);
  });

  it("keeps the notice when only part of a mixed block is unidentified", () => {
    const label = labelForWirePassage({
      type: "lecture",
      reference: "Room Conversation",
      speaker: "Dr. Patel",
      speakerUnidentified: true,
    });
    expect(formatLabel(label)).toContain("Dr. Patel:");
    expect(label.provenanceNote).toBe(UNIDENTIFIED_SPEAKER_NOTICE);
  });

  it("does not repeat lecture attribution as a context notice", () => {
    expect(contextNoticeFor(lecture())).toBeNull();
    expect(contextNoticeFor(lecture({ speaker: null, speakerConfidence: "unknown" }))).toBeNull();
  });
});

describe("copied lecture attribution", () => {
  it("includes the identified speaker", () => {
    const copied = buildPassageCopyText({
      type: "lecture",
      text: "What is mind?",
      speaker: "Dr. Patel",
      citation: "Lecture · 1975",
      url: null,
    });
    expect(copied).toBe('Dr. Patel:\n\n"What is mind?"\n\n— Lecture · 1975');
  });

  it("includes the unidentified notice instead of silently implying a speaker", () => {
    const copied = buildPassageCopyText({
      type: "lecture",
      text: "Who is speaking?",
      speaker: null,
      citation: "Lecture",
      url: null,
    });
    expect(copied.split(UNIDENTIFIED_SPEAKER_NOTICE)).toHaveLength(2);
  });

  it("includes identified names and one notice for a partially unidentified block", () => {
    const copied = buildPassageCopyText({
      type: "lecture",
      text: "Continuation.\nDr. Patel: A labelled turn.",
      speaker: "Dr. Patel",
      speakerUnidentified: true,
      citation: "Room Conversation",
      url: null,
    });
    expect(copied).toContain("Dr. Patel:");
    expect(copied.split(UNIDENTIFIED_SPEAKER_NOTICE)).toHaveLength(2);
  });
});

describe("search navigation", () => {
  it("builds a canonical question-only follow-up URL", () => {
    expect(buildSearchHref("  what is the soul?  ")).toBe(
      "/search?q=what%20is%20the%20soul%3F",
    );
  });
});
