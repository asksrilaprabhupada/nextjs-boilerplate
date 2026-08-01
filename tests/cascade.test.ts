/**
 * cascade.test.ts — The spending gates: the pre-filter and the snippet rule.
 *
 * Two invariants the cascade must never break:
 *   - The pre-filter is a SPENDING decision, not a relevance verdict. What it
 *     sets aside is returned, not deleted, and no source can be flooded out of
 *     its guaranteed floor by a more numerous one.
 *   - A snippet never ends mid-sentence. A technically correct quotation cut
 *     before the line that completes its meaning is a small lie (the SB 8.23.31
 *     incident), so truncation always lands on a sentence boundary and is
 *     always visibly marked.
 */
import { describe, it, expect } from "vitest";
import { fuseWeighted, type RetrievedCandidate } from "@/app/lib/search-v2/fusion";
import { prefilterCandidates, agreementScore, SOURCE_FLOORS } from "@/app/lib/search-v2/prefilter";
import { makeSnippet } from "@/app/lib/search-v2/snippet";

function candidate(over: Partial<RetrievedCandidate> & { passage_key: string }): RetrievedCandidate {
  return {
    source_type: "lecture",
    row_id: over.passage_key.split(":")[1] ?? "row",
    retrieval_text: "a candidate passage long enough to clear every floor in this suite",
    reference: null,
    speaker: null,
    recipient: null,
    occurred_on: null,
    location: null,
    matched_query_ids: ["q"],
    channel_ranks: [{ query_id: "q", channel: "semantic", rank: 1 }],
    channel_scores: {},
    tag_matches: 0,
    ...over,
  } as RetrievedCandidate;
}

const fused = (cs: RetrievedCandidate[]) => fuseWeighted([cs], { q: "original" });

describe("agreement scoring", () => {
  it("scores channels double and counts pseudo-ids as channels, not queries", () => {
    const c = fused([
      candidate({
        passage_key: "verse:x",
        source_type: "verse",
        channel_ranks: [
          { query_id: "q", channel: "fts_core", rank: 1 },
          { query_id: "q", channel: "semantic", rank: 4 },
          { query_id: "__lexical__", channel: "lexical", rank: 2 },
        ],
      }),
    ])[0];
    // 3 distinct channels × 2 + 1 distinct real query = 7.
    expect(agreementScore(c)).toBe(7);
  });
});

describe("prefilter", () => {
  it("keeps the pool bounded and sets the rest ASIDE — never deletes", () => {
    // 200 lectures against a pool of 60: the source floor (50) fills first,
    // the global order fills the remainder, and the other 140 are set aside —
    // set aside, not deleted: they come back as the tail of `additional`.
    const pool = fused(
      Array.from({ length: 200 }, (_, i) =>
        candidate({ passage_key: `lecture:${String(i).padStart(3, "0")}`, channel_ranks: [{ query_id: "q", channel: "semantic", rank: i + 1 }] }),
      ),
    );
    const out = prefilterCandidates(pool, { pool: 60 });
    expect(out.passed).toHaveLength(60);
    expect(out.setAside).toHaveLength(140);
    expect(out.stats.before).toBe(200);
    expect(out.stats.after + out.stats.setAside).toBe(200);
  });

  it("guarantees source floors before the global cut — agreement cannot flood out a scarce source", () => {
    // 40 well-agreed lectures vs 5 poorly-agreed verses, pool of 20: every
    // verse still earns a seat, because a devotee preparing a class needs the
    // verse even when 144,438 transcript paragraphs outvote 25,131 verses.
    const lectures = Array.from({ length: 40 }, (_, i) =>
      candidate({
        passage_key: `lecture:${i}`,
        channel_ranks: [
          { query_id: "q", channel: "semantic", rank: i + 1 },
          { query_id: "q", channel: "fts_core", rank: i + 1 },
        ],
      }),
    );
    const verses = Array.from({ length: 5 }, (_, i) =>
      candidate({
        passage_key: `verse:${i}`,
        source_type: "verse",
        channel_ranks: [{ query_id: "q", channel: "semantic", rank: 300 + i }],
      }),
    );
    const out = prefilterCandidates(fused([...lectures, ...verses]), { pool: 20 });
    const passedVerses = out.passed.filter((c) => c.source_type === "verse");
    expect(passedVerses).toHaveLength(5);
  });

  it("always includes a pinned candidate", () => {
    const pool = fused([
      ...Array.from({ length: 30 }, (_, i) =>
        candidate({ passage_key: `lecture:${i}`, channel_ranks: [{ query_id: "q", channel: "semantic", rank: i + 1 }] }),
      ),
      candidate({ passage_key: "verse:pinned", source_type: "verse", pinned: true, channel_ranks: [] }),
    ]);
    const out = prefilterCandidates(pool, { pool: 5 });
    expect(out.passed.some((c) => c.passage_key === "verse:pinned")).toBe(true);
  });

  it("has a floor for every source type the pipeline retrieves", () => {
    for (const t of ["verse", "purport", "book", "lecture", "letter"]) {
      expect(SOURCE_FLOORS[t]).toBeGreaterThan(0);
    }
  });
});

describe("makeSnippet — never a small lie", () => {
  const TWO_SENTENCES =
    "The Lord promised deliverance to all who surrender fully. " +
    "Yet that promise carries a condition stated in the very next line, and reading the first half alone reverses its meaning.";

  it("returns short text whole, untouched", () => {
    expect(makeSnippet("A short line.", 220)).toBe("A short line.");
  });

  it("extends past the budget to the sentence boundary rather than cutting mid-thought", () => {
    const snippet = makeSnippet(TWO_SENTENCES + " A third sentence follows here for length.", 60);
    // The budget lands inside sentence one; the snippet finishes that sentence.
    expect(snippet.startsWith("The Lord promised deliverance to all who surrender fully.")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    // Never a cut inside a word or a clause: the char before the ellipsis is
    // closing punctuation, not a letter.
    expect(snippet.charAt(snippet.length - 2)).toMatch(/[.!?"॥]/);
  });

  it("opens at the sentence with the best keyword match and marks the elision", () => {
    const text =
      "An unrelated opening line about management matters. " +
      "The soul is eternal and never dies, as this sentence explains. " +
      "A closing line about travel arrangements.";
    const snippet = makeSnippet(text, 40, ["soul", "eternal"]);
    expect(snippet.startsWith("… ")).toBe(true);
    expect(snippet).toContain("The soul is eternal");
  });

  it("appends the ellipsis AFTER the closing punctuation, never instead of it", () => {
    const snippet = makeSnippet(TWO_SENTENCES + " More text follows to force truncation of the tail end.", 30);
    expect(snippet).toMatch(/[.!?"॥]…$/);
  });

  it("honours the danda for Sanskrit lines", () => {
    const text = "धर्मक्षेत्रे कुरुक्षेत्रे समवेता युयुत्सवः ॥ And a very long English continuation follows this verse line for many further words.";
    const snippet = makeSnippet(text, 10);
    expect(snippet.startsWith("धर्मक्षेत्रे")).toBe(true);
    expect(snippet).toContain("॥");
  });
});
