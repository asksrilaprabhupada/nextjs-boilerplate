/** Search progress must remain truthful for unfiltered multi-speaker results. */
import { describe, expect, it } from "vitest";
import { SEARCH_PROGRESS_LABELS } from "@/app/lib/24-search-progress";

describe("search progress copy", () => {
  it("describes evidence and passages without claiming every word is his", () => {
    expect(SEARCH_PROGRESS_LABELS).toEqual({
      reranking: "Selecting relevant passages…",
      weaving: "Arranging the evidence…",
      idle: "Preparing the evidence…",
    });
    expect(Object.values(SEARCH_PROGRESS_LABELS).join(" ")).not.toMatch(/his words/i);
  });
});
