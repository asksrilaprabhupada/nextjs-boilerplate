import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import IncompleteSearchWarning, {
  incompleteSearchWarning,
} from "@/app/components/results/02-incomplete-search-warning";
import type { DegradedSource } from "@/app/lib/types/01-search";

const unavailable = (source: DegradedSource["source"]): DegradedSource => ({
  source,
  reason: "temporarily unavailable",
});

describe("incomplete search warning", () => {
  it("renders a safe generic warning when non-retrieval guidance is degraded", () => {
    const expected =
      "Some search guidance was unavailable this time. This answer may be less complete. Please search again.";

    expect(incompleteSearchWarning([], true)).toBe(expected);
    expect(incompleteSearchWarning([], false)).toBe("");

    const html = renderToStaticMarkup(
      createElement(IncompleteSearchWarning, { sources: [], degraded: true }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(expected);
    expect(html).not.toContain("Gemini");
    expect(html).not.toContain("plan_rejected");
  });

  it("renders the exact transcript warning before an incomplete answer", () => {
    const sources = [unavailable("Lectures and conversations")];
    const expected =
      "Lectures and conversations could not be searched this time. This answer is incomplete. Please search again.";

    expect(incompleteSearchWarning(sources)).toBe(expected);

    const html = renderToStaticMarkup(
      createElement(IncompleteSearchWarning, { sources }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain(expected);
  });

  it("lists every failed friendly source once and renders no internal details", () => {
    const sourceWithInternalDetails = {
      ...unavailable("Books"),
      function: "search_prose_hybrid_batch_v3",
      code: "57014",
      message: "canceling statement due to statement timeout",
      sql: "select private_search_function($1)",
    } as unknown as DegradedSource;
    const sources = [
      sourceWithInternalDetails,
      unavailable("Letters"),
      unavailable("Purports"),
      unavailable("Books"),
    ];

    const expected =
      "Books, Letters, and Purports could not be searched this time. This answer is incomplete. Please search again.";
    expect(incompleteSearchWarning(sources)).toBe(expected);

    const html = renderToStaticMarkup(
      createElement(IncompleteSearchWarning, { sources }),
    );
    expect(html).toContain(expected);
    expect(html.match(/Books/g)).toHaveLength(1);
    expect(html).not.toContain("search_prose_hybrid_batch_v3");
    expect(html).not.toContain("57014");
    expect(html).not.toContain("statement timeout");
    expect(html).not.toContain("private_search_function");
  });
});
