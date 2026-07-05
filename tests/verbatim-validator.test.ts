/**
 * verbatim-validator.test.ts — validateMainFlow + normalizeVerbatim unit tests
 *
 * The tampered fixture is the non-negotiable case: a block whose rendered text
 * does not match its re-fetched source row must be dropped and counted. Also
 * covers cosmetic-normalization equivalence (curly quotes, NBSP, doubled
 * spaces), fail-open on fetch errors, and missing source rows.
 */
import { describe, it, expect } from "vitest";
import { validateMainFlow, normalizeVerbatim, type ValidatableItem } from "@/app/lib/17-verbatim-validator";

type Row = Record<string, unknown>;

/** Minimal stand-in for the Supabase client: table → rows, or a thrown error. */
function fakeClient(tables: Record<string, Row[]>, opts: { failTable?: string } = {}) {
  return {
    from(table: string) {
      return {
        select(_cols: string) {
          return {
            in(_col: string, ids: string[]) {
              if (opts.failTable === table) {
                return Promise.resolve({ data: null, error: { message: "connection refused" } });
              }
              const rows = (tables[table] || []).filter(r => ids.includes(String(r.id)));
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
}

const verseItem = (id: string, translation: string, purport = ""): ValidatableItem => ({
  type: "verse",
  data: { id, translation, purport },
});
const lectureItem = (id: string, body: string): ValidatableItem => ({
  type: "lecture",
  data: { id, body_text: body },
});

describe("normalizeVerbatim", () => {
  it("unifies quotes, dashes, NBSP, and whitespace without rewriting words", () => {
    expect(normalizeVerbatim("“For the soul” — there is   neither ‘birth’"))
      .toBe(`"For the soul" - there is neither 'birth'`);
  });
  it("applies NFC so composed and decomposed diacritics compare equal", () => {
    // r/s/n + combining dot below (U+0323) compose to ṛ/ṣ/ṇ under NFC.
    expect(normalizeVerbatim("Kṛṣṇa")).toBe(normalizeVerbatim("Kṛṣṇa"));
  });
});

describe("validateMainFlow", () => {
  const sourceTables = {
    verses: [
      { id: "v1", translation: "For the soul there is neither birth nor death at any time.", purport: "This verse establishes the eternality of the soul beyond any doubt." },
    ],
    transcript_paragraphs: [
      { id: "t1", body_text: "So Krsna consciousness means to act according to the direction of Krsna." },
    ],
  };

  it("keeps clean items and reports validated with zero drops", async () => {
    const items = [
      verseItem("v1", "For the soul there is neither birth nor death at any time.", "This verse establishes the eternality of the soul beyond any doubt."),
      lectureItem("t1", "So Krsna consciousness means to act according to the direction of Krsna."),
    ];
    const r = await validateMainFlow(items, fakeClient(sourceTables));
    expect(r.validated).toBe(true);
    expect(r.droppedBlocks).toBe(0);
    expect(r.keptItems).toHaveLength(2);
  });

  it("DROPS a tampered block and counts it", async () => {
    const items = [
      verseItem("v1", "For the soul there is neither birth nor death at any time, mostly."), // tampered
      lectureItem("t1", "So Krsna consciousness means to act according to the direction of Krsna."),
    ];
    const r = await validateMainFlow(items, fakeClient(sourceTables));
    expect(r.validated).toBe(true);
    expect(r.droppedBlocks).toBe(1);
    expect(r.keptItems.map(i => i.data.id)).toEqual(["t1"]);
    expect(r.droppedRefs[0]).toMatchObject({ id: "v1", reason: "translation not verbatim" });
  });

  it("drops a verse whose purport was tampered even when the translation is clean", async () => {
    const items = [
      verseItem("v1", "For the soul there is neither birth nor death at any time.", "This verse establishes something else entirely."),
    ];
    const r = await validateMainFlow(items, fakeClient(sourceTables));
    expect(r.droppedBlocks).toBe(1);
    expect(r.droppedRefs[0].reason).toBe("purport not verbatim");
  });

  it("accepts cosmetic differences (curly quotes, NBSP, doubled spaces, en dash)", async () => {
    const tables = {
      verses: [{ id: "v2", translation: `He said "do not fear" – and he  meant it.`, purport: "" }],
    };
    const items = [verseItem("v2", "He said “do not fear” — and he meant it.")];
    const r = await validateMainFlow(items, fakeClient(tables));
    expect(r.droppedBlocks).toBe(0);
    expect(r.keptItems).toHaveLength(1);
  });

  it("accepts a rendered excerpt that is a substring of the source (fold previews)", async () => {
    const items = [lectureItem("t1", "act according to the direction of Krsna")];
    const r = await validateMainFlow(items, fakeClient(sourceTables));
    expect(r.keptItems).toHaveLength(1);
  });

  it("drops items whose source row no longer exists", async () => {
    const items = [verseItem("ghost", "Anything at all.")];
    const r = await validateMainFlow(items, fakeClient(sourceTables));
    expect(r.droppedBlocks).toBe(1);
    expect(r.droppedRefs[0].reason).toBe("source row not found");
  });

  it("fails OPEN when the verification fetch errors: keeps everything, validated=false", async () => {
    const items = [
      verseItem("v1", "Tampered text that would normally be dropped."),
    ];
    const r = await validateMainFlow(items, fakeClient(sourceTables, { failTable: "verses" }));
    expect(r.validated).toBe(false);
    expect(r.droppedBlocks).toBe(0);
    expect(r.keptItems).toHaveLength(1);
  });

  it("exposes normalized source text for derived key-answer validation", async () => {
    const items = [verseItem("v1", "For the soul there is neither birth nor death at any time.")];
    const r = await validateMainFlow(items, fakeClient(sourceTables));
    const src = r.sourceText.get("v1")!;
    expect(src).toContain(normalizeVerbatim("neither birth nor death"));
    expect(src).toContain(normalizeVerbatim("eternality of the soul"));
  });
});
