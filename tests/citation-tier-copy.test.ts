/**
 * citation-tier-copy.test.ts — The second tier must not claim to be the library.
 *
 * The heading used to read "664 more passages — every one the library found".
 * That was not true and could not be: the candidate pool is capped at 700 rows
 * across the five sources, so the number describes ONE SEARCH, not the corpus.
 * A devotee reading "every one the library found" would reasonably conclude
 * there is nothing further to look for, and stop looking.
 *
 * Honesty about reach is the point of this project, so the wording is pinned
 * here rather than left to be re-broken by a later edit.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(
  join(process.cwd(), "app/components/results/01-narrative-response.tsx"),
  "utf8",
);

/** The rendered summary line, with the JSX comment block stripped out. */
const SUMMARY_LINE = SOURCE.split("\n")
  .filter((line) => line.includes("more {list.length === 1"))
  .join(" ");

describe("the citation tier says what it actually is", () => {
  it("says the passages were retrieved in this search", () => {
    expect(SUMMARY_LINE).toContain("retrieved in this search");
  });

  it("never claims to be everything the library holds", () => {
    // Any of these would tell a devotee the search was exhaustive.
    for (const claim of [
      "every one the library found",
      "everything the library",
      "all the passages",
      "every passage in the library",
      "the whole library",
    ]) {
      expect(SUMMARY_LINE).not.toContain(claim);
    }
  });

  it("does not promise exhaustiveness anywhere in the rendered heading", () => {
    // "every"/"all" are the words that make the false promise. The heading is
    // a count and a plain statement of where the count came from.
    expect(SUMMARY_LINE).not.toMatch(/\bevery\b/i);
    expect(SUMMARY_LINE).not.toMatch(/\ball\b/i);
  });
});
