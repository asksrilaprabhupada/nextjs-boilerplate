/**
 * cascade.test.ts — The snippet rule.
 *
 * A snippet never ends mid-sentence. A technically correct quotation cut before
 * the line that completes its meaning is a small lie (the SB 8.23.31 incident),
 * so truncation always lands on a sentence boundary and is always visibly
 * marked.
 *
 * The pre-filter tests that used to sit above this are gone with the
 * pre-filter itself: every retrieved passage now goes to Cohere in one
 * request, so there is no spending gate left to guard.
 */
import { describe, it, expect } from "vitest";
import { makeSnippet } from "@/app/lib/search-v2/snippet";

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
