/**
 * citation.test.ts — The citation is how a devotee verifies a passage.
 *
 * Every case below is a REAL storage pattern measured against the production
 * corpus, not an invented one:
 *
 *   SB   11,944 of 13,004 rows store verse_number as "Text 9"
 *   CC   11,131 of 11,359 rows store verse_number as "Text 1"
 *   BS   all 62 rows store "Verse text"; chapter_number IS the verse, and the
 *        real chapter is always 5 (/library/bs/5/29/)
 *   ISO  all 19 rows store "Verse text", one of which is the Invocation
 *   NOI  all 11 rows store "Devanagari"
 *
 * Before this module, the renderer produced "SB 7.8.Text 9" and
 * "ISO 0.Verse text" for ~92% of the corpus.
 */
import { describe, it, expect } from "vitest";
import { formatVerseReference, cleanVerseNumber } from "@/app/lib/search-v2/citation";

const vb = (path: string) => `https://vedabase.io/en/library/${path}`;

describe("citation from vedabase_url (the authority)", () => {
  const cases: [string, string, string][] = [
    ["BG", "bg/18/66/", "BG 18.66"],
    ["SB", "sb/7/8/9/", "SB 7.8.9"],
    ["SB", "sb/1/1/1/", "SB 1.1.1"],
    ["CC", "cc/adi/1/1/", "CC Adi 1.1"],
    ["CC", "cc/madhya/9/265/", "CC Madhya 9.265"],
    ["CC", "cc/antya/1/1/", "CC Antya 1.1"],
    ["BS", "bs/5/29/", "BS 5.29"],
    ["ISO", "iso/1/", "ISO 1"],
    ["NOI", "noi/8/", "NOI 8"],
    ["ISO", "iso/invocation/", "ISO Invocation"],
  ];

  for (const [scripture, path, expected] of cases) {
    it(`${scripture} ${path} → ${expected}`, () => {
      expect(formatVerseReference({ scripture, vedabaseUrl: vb(path) })).toBe(expected);
    });
  }

  it("prefers the URL over the columns when both are present", () => {
    // The columns would give "SB 7.8.9" too, but the URL is authoritative and
    // must win even if the columns disagree.
    expect(
      formatVerseReference({
        scripture: "SB",
        division: "99",
        chapterNumber: 99,
        verseNumber: "Text 99",
        vedabaseUrl: vb("sb/7/8/9/"),
      }),
    ).toBe("SB 7.8.9");
  });
});

describe("citation from columns (fallback when no URL)", () => {
  it("strips the Text prefix SB and CC store", () => {
    expect(
      formatVerseReference({ scripture: "SB", division: "7", chapterNumber: 8, verseNumber: "Text 9" }),
    ).toBe("SB 7.8.9");
  });

  it("keeps a verse range intact", () => {
    expect(
      formatVerseReference({ scripture: "SB", division: "11", chapterNumber: 19, verseNumber: "Text 36-39" }),
    ).toBe("SB 11.19.36-39");
  });

  it("capitalises a word division", () => {
    expect(
      formatVerseReference({ scripture: "CC", division: "adi", chapterNumber: 1, verseNumber: "Text 1" }),
    ).toBe("CC Adi 1.1");
  });

  it("handles a plain numeric verse with no division", () => {
    expect(formatVerseReference({ scripture: "BG", chapterNumber: 18, verseNumber: "66" })).toBe("BG 18.66");
  });

  it("falls back to the chapter number when verse_number is a placeholder", () => {
    expect(formatVerseReference({ scripture: "ISO", chapterNumber: 1, verseNumber: "Verse text" })).toBe("ISO 1");
    expect(formatVerseReference({ scripture: "NOI", chapterNumber: 8, verseNumber: "Devanagari" })).toBe("NOI 8");
  });

  it("never emits the raw storage artefacts", () => {
    for (const raw of ["Text 9", "Verse text", "Devanagari"]) {
      const out = formatVerseReference({ scripture: "SB", division: "7", chapterNumber: 8, verseNumber: raw });
      expect(out).not.toMatch(/Text\s|Verse text|Devanagari/);
    }
  });
});

describe("citation refuses to half-identify", () => {
  it("returns null with no scripture", () => {
    expect(formatVerseReference({ scripture: null, vedabaseUrl: vb("bg/18/66/") })).toBeNull();
    expect(formatVerseReference({ scripture: "" })).toBeNull();
  });

  it("returns the scripture alone rather than a wrong locator", () => {
    expect(formatVerseReference({ scripture: "BG" })).toBe("BG");
  });

  it("ignores a URL that is not a Vedabase library path", () => {
    expect(
      formatVerseReference({ scripture: "BG", chapterNumber: 18, verseNumber: "66", vedabaseUrl: "https://example.com/x" }),
    ).toBe("BG 18.66");
  });
});

describe("cleanVerseNumber", () => {
  it("strips Text/Texts/Verse prefixes case-insensitively", () => {
    expect(cleanVerseNumber("Text 9")).toBe("9");
    expect(cleanVerseNumber("Texts 1-3")).toBe("1-3");
    expect(cleanVerseNumber("verse 4")).toBe("4");
    expect(cleanVerseNumber("66")).toBe("66");
  });

  it("returns null for an empty or absent value", () => {
    expect(cleanVerseNumber("")).toBeNull();
    expect(cleanVerseNumber(null)).toBeNull();
  });
});
