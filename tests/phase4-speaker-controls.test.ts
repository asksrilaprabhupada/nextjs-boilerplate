/** The speaker toggle must remain available when filtering finds no passages. */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SpeakerFilterControls from "@/app/components/results/03-speaker-filter-controls";

describe("speaker filter controls", () => {
  it("renders the active toggle and explanation at zero results", () => {
    const html = renderToStaticMarkup(createElement(SpeakerFilterControls, {
      passageCount: 0,
      additionalCount: 0,
      onlyHis: true,
      speakerFiltered: true,
      onToggle: () => undefined,
    }));

    expect(html).toContain("Śrīla Prabhupāda’s words only");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Recorded talks contain only explicitly labelled");
    expect(html).not.toContain("passages in full");
  });
});
