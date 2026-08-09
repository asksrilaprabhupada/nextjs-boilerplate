/** Speaker-only controls are gone and complete evidence remains visible. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DigDeeperModal from "@/app/components/results/02-dig-deeper-modal";
import type { ProseHit } from "@/app/components/results/01-narrative-response";

const searchExperienceSource = readFileSync(
  join(process.cwd(), "app/components/cinematic/09-search-experience.tsx"),
  "utf8",
);

describe("speaker filtering removal", () => {
  it("keeps the neutral result counts without the active speaker control", () => {
    expect(searchExperienceSource).toContain('{passageCount} {passageCount === 1 ? "passage" : "passages"} in full');
    expect(searchExperienceSource).toContain("{additionalCount.toLocaleString(\"en-US\")} more as citations below");
    expect(searchExperienceSource).not.toContain("SpeakerFilterControls");
    expect(searchExperienceSource).not.toContain("onlyHis");
    expect(searchExperienceSource).not.toContain("Śrīla Prabhupāda’s words only");
  });

  it("keeps NOT_HIS evidence visible in the dormant complete-results drawer", () => {
    const guestPassage: ProseHit = {
      id: "guest-prose",
      book_slug: "other",
      paragraph_number: 1,
      body_text: "Guest contribution remains visible.",
      authorship: "NOT_HIS",
      provenanceNote: "Guest-authored source",
    };
    const html = renderToStaticMarkup(createElement(DigDeeperModal, {
      overflowVerses: [],
      overflowProse: [guestPassage],
      totalVerses: 0,
      totalProse: 1,
      onClose: () => undefined,
    }));

    expect(html).toContain("Guest contribution remains visible.");
    expect(html).toContain("Guest-authored source");
    expect(html).not.toContain("His words only");
    expect(html).not.toContain('type="checkbox"');
  });
});
