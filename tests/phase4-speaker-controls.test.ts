/** Speaker-only controls stay absent from the active search experience. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
});
