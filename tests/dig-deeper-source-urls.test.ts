/**
 * Every Dig Deeper result carries its real Vedabase link, or honestly none.
 *
 * Before this, `adapt.ts` hard-coded `url: null` for anything that was not a
 * verse or a purport, so a lecture, a letter, or a book paragraph never showed
 * its "Open source" button even though the URL was stored on its row. These
 * tests hold both halves of the fix: source-url.ts reads the stored column for
 * every source type, and adapt.ts prefers that stored URL over the reference
 * conversion — and still emits null, never a guess, when the row has none.
 */
import { describe, expect, it } from "vitest";
import { fetchSourceUrls } from "@/app/lib/search-v2/source-url";
import { toWireAdditional } from "@/app/lib/search-v2/adapt";
import type { AdditionalPassage } from "@/app/lib/search-v2/pipeline";

type Row = Record<string, unknown>;

interface FakeCall {
  table: string;
  columns: string;
  ids: string[];
}

/**
 * Minimal stand-in for the Supabase client, recording every read so the tests
 * can assert which table was touched and which columns were asked for.
 */
function fakeClient(tables: Record<string, Row[]>, opts: { failTable?: string } = {}) {
  const calls: FakeCall[] = [];
  const client = {
    from(table: string) {
      return {
        select(columns: string) {
          return {
            in(_column: string, ids: string[]) {
              calls.push({ table, columns, ids });
              if (opts.failTable === table) {
                return Promise.resolve({ data: null, error: { message: "connection refused" } });
              }
              const rows = (tables[table] ?? []).filter((row) => ids.includes(String(row.id)));
              return Promise.resolve({ data: rows, error: null });
            },
          };
        },
      };
    },
  };
  return { client, calls };
}

const ctx = { requestId: "req-test" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asDb = (client: unknown) => client as any;

function additional(overrides: Partial<AdditionalPassage> = {}): AdditionalPassage {
  return {
    passageKey: "verse:v1",
    sourceType: "verse",
    reference: "BG 2.13",
    speaker: null,
    speakerUnidentified: false,
    recipient: null,
    occurredOn: null,
    location: null,
    rerankScore: null,
    snippet: "Exact corpus text.",
    vedabaseUrl: null,
    ...overrides,
  };
}

describe("fetchSourceUrls reads the stored URL for every source type", () => {
  it("reads a verse URL off the verses row", async () => {
    const { client } = fakeClient({
      verses: [{ id: "v1", vedabase_url: "https://vedabase.io/en/library/bg/2/13/" }],
    });
    const result = await fetchSourceUrls(asDb(client), ["verse:v1"], ctx);
    expect(result.urls.get("verse:v1")).toBe("https://vedabase.io/en/library/bg/2/13/");
    expect(result.failedNamespaces).toEqual([]);
  });

  it("reads a purport URL from the parent verse, because verse_chunks stores none", async () => {
    const { client, calls } = fakeClient({
      verse_chunks: [
        { id: "c1", verses: { vedabase_url: "https://vedabase.io/en/library/sb/1/2/6/" } },
      ],
    });
    const result = await fetchSourceUrls(asDb(client), ["purport:c1"], ctx);
    expect(result.urls.get("purport:c1")).toBe("https://vedabase.io/en/library/sb/1/2/6/");
    // The join is the whole mechanism: verse_chunks has no URL column at all.
    expect(calls[0].table).toBe("verse_chunks");
    expect(calls[0].columns).toContain("verses(vedabase_url)");
    expect(calls[0].columns).not.toMatch(/(^|[\s,])vedabase_url/);
  });

  it("normalises a to-many embedded parent verse returned as an array", async () => {
    const { client } = fakeClient({
      verse_chunks: [
        { id: "c2", verses: [{ vedabase_url: "https://vedabase.io/en/library/cc/adi/1/1/" }] },
      ],
    });
    const result = await fetchSourceUrls(asDb(client), ["purport:c2"], ctx);
    expect(result.urls.get("purport:c2")).toBe("https://vedabase.io/en/library/cc/adi/1/1/");
  });

  it("prefers the precise paragraph anchor for book prose", async () => {
    const { client } = fakeClient({
      prose_paragraphs: [{
        id: "p1",
        vedabase_url: "https://vedabase.io/en/library/noi/",
        vedabase_url_precise: "https://vedabase.io/en/library/noi/3/",
      }],
    });
    const result = await fetchSourceUrls(asDb(client), ["book:p1"], ctx);
    expect(result.urls.get("book:p1")).toBe("https://vedabase.io/en/library/noi/3/");
  });

  it("falls back to the chapter-level URL when book prose has no precise anchor", async () => {
    const { client } = fakeClient({
      prose_paragraphs: [{
        id: "p2",
        vedabase_url: "https://vedabase.io/en/library/noi/",
        vedabase_url_precise: null,
      }],
    });
    const result = await fetchSourceUrls(asDb(client), ["book:p2"], ctx);
    expect(result.urls.get("book:p2")).toBe("https://vedabase.io/en/library/noi/");
  });

  it("reads a lecture URL off the transcript_paragraphs row", async () => {
    const { client } = fakeClient({
      transcript_paragraphs: [
        { id: "t1", vedabase_url: "https://vedabase.io/en/library/transcripts/750101lec/" },
      ],
    });
    const result = await fetchSourceUrls(asDb(client), ["lecture:t1"], ctx);
    expect(result.urls.get("lecture:t1"))
      .toBe("https://vedabase.io/en/library/transcripts/750101lec/");
  });

  it("reads a letter URL off the letter_paragraphs row", async () => {
    const { client } = fakeClient({
      letter_paragraphs: [
        { id: "l1", vedabase_url: "https://vedabase.io/en/library/letters/680101/" },
      ],
    });
    const result = await fetchSourceUrls(asDb(client), ["letter:l1"], ctx);
    expect(result.urls.get("letter:l1")).toBe("https://vedabase.io/en/library/letters/680101/");
  });

  it("leaves a row with no stored URL out of the map entirely", async () => {
    const { client } = fakeClient({
      transcript_paragraphs: [{ id: "t2", vedabase_url: null }],
      letter_paragraphs: [{ id: "l2", vedabase_url: "   " }],
      verses: [{ id: "v2" }],
    });
    const result = await fetchSourceUrls(
      asDb(client), ["lecture:t2", "letter:l2", "verse:v2"], ctx,
    );
    expect(result.urls.size).toBe(0);
  });

  it("issues one read per namespace, never one per passage", async () => {
    const { client, calls } = fakeClient({
      transcript_paragraphs: [
        { id: "t1", vedabase_url: "https://vedabase.io/en/library/transcripts/a/" },
        { id: "t2", vedabase_url: "https://vedabase.io/en/library/transcripts/b/" },
        { id: "t3", vedabase_url: "https://vedabase.io/en/library/transcripts/c/" },
      ],
    });
    const result = await fetchSourceUrls(
      asDb(client), ["lecture:t1", "lecture:t2", "lecture:t3"], ctx,
    );
    expect(result.fetchCount).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].ids).toEqual(["t1", "t2", "t3"]);
    expect(result.urls.size).toBe(3);
  });

  it("resolves every passage key that shares one row id", async () => {
    const { client, calls } = fakeClient({
      verses: [{ id: "v1", vedabase_url: "https://vedabase.io/en/library/bg/2/13/" }],
    });
    const result = await fetchSourceUrls(asDb(client), ["verse:v1", "verse:v1"], ctx);
    expect(calls[0].ids).toEqual(["v1"]);
    expect(result.urls.get("verse:v1")).toBe("https://vedabase.io/en/library/bg/2/13/");
  });

  it("survives a failed read: no throw, other namespaces still resolve", async () => {
    const { client } = fakeClient({
      verses: [{ id: "v1", vedabase_url: "https://vedabase.io/en/library/bg/2/13/" }],
      letter_paragraphs: [
        { id: "l1", vedabase_url: "https://vedabase.io/en/library/letters/680101/" },
      ],
    }, { failTable: "verses" });
    const result = await fetchSourceUrls(asDb(client), ["verse:v1", "letter:l1"], ctx);
    expect(result.failedNamespaces).toEqual(["verse"]);
    expect(result.urls.has("verse:v1")).toBe(false);
    expect(result.urls.get("letter:l1")).toBe("https://vedabase.io/en/library/letters/680101/");
  });

  it("ignores a key whose namespace is not a known source table", async () => {
    const { client, calls } = fakeClient({});
    const result = await fetchSourceUrls(asDb(client), ["mystery:x1", "notakey"], ctx);
    expect(calls).toHaveLength(0);
    expect(result.urls.size).toBe(0);
    expect(result.fetchCount).toBe(0);
  });
});

describe("toWireAdditional puts a real link on every Dig Deeper result", () => {
  it.each([
    ["verse", "verse:v1", "BG 2.13", "https://vedabase.io/en/library/bg/2/13/"],
    ["purport", "purport:c1", "SB 1.2.6", "https://vedabase.io/en/library/sb/1/2/6/"],
    ["book", "book:p1", "noi", "https://vedabase.io/en/library/noi/3/"],
    ["lecture", "lecture:t1", "Lecture", "https://vedabase.io/en/library/transcripts/750101lec/"],
    ["letter", "letter:l1", "Letter", "https://vedabase.io/en/library/letters/680101/"],
  ])("carries the stored URL for a %s", (sourceType, passageKey, reference, url) => {
    const wire = toWireAdditional(additional({
      sourceType, passageKey, reference, vedabaseUrl: url,
    }));
    expect(wire.url).toBe(url);
  });

  it("prefers the stored URL over the reference conversion", () => {
    // The stored URL is the authority: it already carries the canonical path.
    const wire = toWireAdditional(additional({
      reference: "BG 2.13",
      vedabaseUrl: "https://vedabase.io/en/library/bg/2/13-14/",
    }));
    expect(wire.url).toBe("https://vedabase.io/en/library/bg/2/13-14/");
  });

  it.each([
    ["verse", "verse:v9", "BG 2.13", "https://vedabase.io/en/library/bg/2/13/"],
    ["purport", "purport:c9", "SB 1.2.6", "https://vedabase.io/en/library/sb/1/2/6/"],
  ])("falls back to the reference conversion for a %s with no stored URL",
    (sourceType, passageKey, reference, expected) => {
      const wire = toWireAdditional(additional({
        sourceType, passageKey, reference, vedabaseUrl: null,
      }));
      expect(wire.url).toBe(expected);
    });

  it.each([
    ["book", "book:p9", "noi"],
    ["lecture", "lecture:t9", "Arrival Address"],
    ["letter", "letter:l9", "Letter to Brahmananda"],
  ])("shows no button for a %s with no stored URL", (sourceType, passageKey, reference) => {
    // No button is the honest outcome. These references do not address
    // Vedabase, so there is nothing safe to convert them into.
    const wire = toWireAdditional(additional({
      sourceType, passageKey, reference, vedabaseUrl: null,
    }));
    expect(wire.url).toBeNull();
  });

  it("shows no button for a verse whose reference cannot be parsed safely", () => {
    const wire = toWireAdditional(additional({
      reference: "Bhagavad-gita, chapter two",
      vedabaseUrl: null,
    }));
    expect(wire.url).toBeNull();
  });
});
