/** Focused contracts for the honest facets in the cinematic Dig Deeper browser. */
import { describe, expect, it } from "vitest";
import {
  UNKNOWN_METADATA,
  filterAdditionalSearchPassages,
  parseAdditionalReference,
  parseAdditionalSearchPassage,
  sortAdditionalSearchPassages,
  type DigDeeperFilters,
} from "@/app/components/results/03-cinematic-dig-deeper";
import { BOOK_REGISTRY } from "@/app/lib/12-provenance";
import type { AdditionalSearchPassage } from "@/app/lib/types/01-search";

function passage(
  overrides: Partial<AdditionalSearchPassage> = {},
): AdditionalSearchPassage {
  return {
    type: "verse",
    reference: "BG 2.40",
    url: null,
    label: "Bhagavad-gītā 2.40",
    provenanceNote: "",
    snippet: "Exact corpus text.",
    speaker: null,
    recipient: null,
    date: null,
    location: null,
    rerankScore: null,
    ...overrides,
  };
}

function filters(
  overrides: Partial<DigDeeperFilters> = {},
): DigDeeperFilters {
  return {
    family: "all",
    query: "",
    occasion: "",
    book: "",
    division: "",
    chapter: "",
    speaker: "",
    location: "",
    recipient: "",
    year: "",
    ...overrides,
  };
}

describe("cinematic Dig Deeper reference facets", () => {
  it.each([
    ["SB 7.8.9", "Canto 7", "Chapter 8"],
    ["SB 7.8.Text 9", "Canto 7", "Chapter 8"],
  ])("parses canonical and raw Śrīmad-Bhāgavatam references: %s", (reference, division, chapter) => {
    expect(parseAdditionalReference(passage({ reference }))).toEqual({
      book: BOOK_REGISTRY.sb.title,
      division,
      chapter,
    });
  });

  it.each([
    ["CC Madhya 9.265", "Madhya-līlā", "Chapter 9"],
    ["CC adi.1.Text 1", "Ādi-līlā", "Chapter 1"],
  ])("parses canonical and raw Caitanya-caritāmṛta references: %s", (reference, division, chapter) => {
    expect(parseAdditionalReference(passage({ type: "purport", reference }))).toEqual({
      book: BOOK_REGISTRY.cc.title,
      division,
      chapter,
    });
  });

  it.each([
    ["SB 8.9", "sb", "Chapter 8"],
    ["CC 9.265", "cc", "Chapter 9"],
  ])("uses the strict two-part purport wire shape without inventing a division: %s", (reference, slug, chapter) => {
    expect(parseAdditionalReference(passage({ type: "purport", reference }))).toEqual({
      book: BOOK_REGISTRY[slug].title,
      division: null,
      chapter,
    });
  });

  it("recognizes a Bhagavad-gītā verse range without turning the verse into a chapter", () => {
    expect(parseAdditionalReference(passage({ reference: "BG 2.40-41" }))).toEqual({
      book: BOOK_REGISTRY.bg.title,
      division: null,
      chapter: "Chapter 2",
    });
  });

  it.each([
    ["ISO Invocation", "iso"],
    ["NOI 3", "noi"],
  ])("recognizes text-only works without inventing a chapter: %s", (reference, slug) => {
    expect(parseAdditionalReference(passage({ reference }))).toEqual({
      book: BOOK_REGISTRY[slug].title,
      division: null,
      chapter: null,
    });
  });

  it("accepts an exact registered prose slug and fails closed on an arbitrary prose title", () => {
    expect(
      parseAdditionalReference(passage({ type: "book", reference: "nod ¶12" })),
    ).toEqual({
      book: BOOK_REGISTRY.nod.title,
      division: null,
      chapter: UNKNOWN_METADATA,
    });

    expect(
      parseAdditionalReference(
        passage({ type: "book", reference: "Some Chapter Title ¶12" }),
      ),
    ).toEqual({
      book: UNKNOWN_METADATA,
      division: null,
      chapter: UNKNOWN_METADATA,
    });
  });

  it("never promotes presentation-label text into reference or occasion metadata", () => {
    const scriptureBait = passage({
      reference: null,
      label: "SB 7.8.9 — Morning Walk",
    });
    expect(parseAdditionalReference(scriptureBait)).toEqual({
      book: UNKNOWN_METADATA,
      division: null,
      chapter: UNKNOWN_METADATA,
    });

    const occasionBait = parseAdditionalSearchPassage(
      passage({
        type: "lecture",
        reference: "A recorded talk",
        label: "Morning Walk — Room Conversation",
      }),
    );
    expect(occasionBait.occasion).toBe("Other recorded talk");
  });
});

describe("cinematic Dig Deeper transcript facets", () => {
  it.each([
    ["Morning Walk — Room Conversation, 1975", "Morning Walk"],
    ["Room Conversation with devotees", "Room Conversation"],
    ["Lecture and conversation", "Lecture"],
    ["Informal conversation", "Conversation"],
    ["Recorded exchange", "Other recorded talk"],
  ])("applies specific occasion precedence and keeps unknown talks explicit: %s", (reference, expected) => {
    const parsed = parseAdditionalSearchPassage(
      passage({ type: "lecture", reference }),
    );
    expect(parsed.occasion).toBe(expected);
  });

  it("keeps every proved mixed speaker and exposes the unidentified portion to filtering", () => {
    const mixed = parseAdditionalSearchPassage(
      passage({
        type: "lecture",
        reference: "Room Conversation",
        speaker: "Śrīla Prabhupāda · Devotees",
        speakerUnidentified: true,
      }),
    );

    expect(mixed.speakers).toEqual([
      "Śrīla Prabhupāda",
      "Devotees",
      "Speaker not identified",
    ]);
    expect(
      filterAdditionalSearchPassages(
        [mixed],
        filters({ speaker: "Speaker not identified" }),
      ),
    ).toEqual([mixed]);
  });
});

describe("cinematic Dig Deeper filtering and ordering", () => {
  const rows = [
    parseAdditionalSearchPassage(
      passage({
        type: "lecture",
        reference: "Morning Walk",
        label: "Morning Walk",
        date: "1975-05-01",
        location: "Māyāpura",
        rerankScore: 0.1,
      }),
      0,
    ),
    parseAdditionalSearchPassage(
      passage({
        type: "letter",
        reference: "Letter to Rūpānuga",
        label: "Letter to Rūpānuga",
        recipient: "Rūpānuga",
        date: "March 15, 1972",
        location: "Bombay",
        rerankScore: 0.99,
      }),
      1,
    ),
    parseAdditionalSearchPassage(
      passage({
        reference: "SB 7.8.9",
        label: "Śrīmad-Bhāgavatam 7.8.9",
        rerankScore: 0.8,
      }),
      2,
    ),
    parseAdditionalSearchPassage(
      passage({
        type: "lecture",
        reference: "Room Conversation",
        label: "Undated room conversation",
        date: null,
        location: "Vṛndāvana",
        rerankScore: 1,
      }),
      3,
    ),
  ];

  it("combines honest facets, preserves source order, and returns source order when filters clear", () => {
    const scripture = filterAdditionalSearchPassages(
      rows,
      filters({
        family: "scripture",
        book: BOOK_REGISTRY.sb.title,
        division: "Canto 7",
        chapter: "Chapter 8",
      }),
    );
    expect(scripture.map((row) => row.passage.reference)).toEqual(["SB 7.8.9"]);

    const talks = filterAdditionalSearchPassages(
      rows,
      filters({ family: "lecture" }),
    );
    expect(talks.map((row) => row.passage.reference)).toEqual([
      "Morning Walk",
      "Room Conversation",
    ]);

    const cleared = filterAdditionalSearchPassages(rows, filters());
    expect(cleared.map((row) => row.originalIndex)).toEqual([0, 1, 2, 3]);
    expect(sortAdditionalSearchPassages(cleared, "relevance").map((row) => row.originalIndex)).toEqual([
      0,
      1,
      2,
      3,
    ]);
  });

  it("sorts newest dated evidence first and leaves undated evidence last", () => {
    expect(
      sortAdditionalSearchPassages(rows, "newest").map(
        (row) => row.passage.reference,
      ),
    ).toEqual([
      "Morning Walk",
      "Letter to Rūpānuga",
      "SB 7.8.9",
      "Room Conversation",
    ]);
  });
});
