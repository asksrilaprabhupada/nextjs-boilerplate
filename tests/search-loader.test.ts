import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SEARCH_STAGE_ORDER, SEARCH_STAGE_PERCENT } from "@/app/lib/25-search-stage-events";
import {
  advanceLoaderPercent,
  clampLoaderPercent,
  PREMA_PASSAGE_CANDIDATES,
  PREMA_PASSAGE_COLLECTION_SHA256,
  SEARCH_LOADER_FALLBACK_STAGES,
  SEARCH_LOADER_INITIAL_PERCENT,
  SEARCH_LOADER_STAGES,
} from "@/app/lib/26-search-loader-model";

const loaderSource = readFileSync(
  resolve(process.cwd(), "app", "components", "cinematic", "10-search-loader.tsx"),
  "utf8",
);
const experienceSource = readFileSync(
  resolve(process.cwd(), "app", "components", "cinematic", "09-search-experience.tsx"),
  "utf8",
);

describe("truthful loader progress", () => {
  it("uses the canonical real stage order and percentages", () => {
    expect(SEARCH_LOADER_STAGES.map(({ key }) => key)).toEqual(SEARCH_STAGE_ORDER);
    expect(SEARCH_LOADER_STAGES.map(({ name }) => name)).toEqual([
      "Understand",
      "Search",
      "Rerank",
      "Verify",
      "Weave",
    ]);
    expect(SEARCH_LOADER_FALLBACK_STAGES.map(({ stage }) => stage)).toEqual(SEARCH_STAGE_ORDER);
    expect(SEARCH_LOADER_FALLBACK_STAGES.map(({ pct }) => pct)).toEqual(
      SEARCH_STAGE_ORDER.map((stage) => SEARCH_STAGE_PERCENT[stage]),
    );
  });

  it("keeps one clamped monotonic integer below 100 until ready", () => {
    expect(clampLoaderPercent(-12, false)).toBe(0);
    expect(clampLoaderPercent(71.6, false)).toBe(72);
    expect(clampLoaderPercent(100, false)).toBe(99);
    expect(clampLoaderPercent(Number.POSITIVE_INFINITY, false)).toBe(
      SEARCH_LOADER_INITIAL_PERCENT,
    );
    expect(clampLoaderPercent(12, true)).toBe(100);

    expect(advanceLoaderPercent(74, 25, false)).toBe(74);
    expect(advanceLoaderPercent(74, 82.6, false)).toBe(83);
    expect(advanceLoaderPercent(99, 100, false)).toBe(99);
    expect(advanceLoaderPercent(1, 1, true)).toBe(100);
    expect(Number.isInteger(advanceLoaderPercent(4, 62.4, false))).toBe(true);
  });

  it("uses that same integer for text, width, and progressbar semantics", () => {
    expect(loaderSource).toContain('role="progressbar"');
    expect(loaderSource).toContain("aria-valuemin={0}");
    expect(loaderSource).toContain("aria-valuemax={100}");
    expect(loaderSource).toContain("aria-valuenow={visiblePercent}");
    expect(loaderSource).toContain('aria-valuetext={`${visiblePercent}% complete`}');
    expect(loaderSource).toContain('style={{ width: `${visiblePercent}%` }}');
    expect(loaderSource).toContain("{visiblePercent}%</span>");
  });

  it("renders 100 only during the short result-ready handoff", () => {
    expect(loaderSource).toContain("const visiblePercent = done ? 100 : progressPercent");
    expect(experienceSource).toContain('type Phase = "loading" | "completing" | "ready" | "error"');
    expect(experienceSource).toContain('done={phase === "completing"}');
    expect(experienceSource).toContain('setPhase("completing")');
    expect(experienceSource).toContain('setTimeout(() => setPhase("ready"), COMPLETION_HOLD_MS)');
  });

  it("has no fabricated post-weave verification timer", () => {
    expect(loaderSource).not.toMatch(/VERIFY_AFTER_MS|VERIFY_STAGE|setVerifying|expanding/);
    expect(loaderSource).toContain("key === active?.stage");
  });

  it("keeps the live region narrow and supports reduced motion and short screens", () => {
    expect(loaderSource).toContain('id="search-loader-status"');
    expect(loaderSource).toContain('role="status"');
    expect(loaderSource).toContain('aria-live="polite"');
    expect(loaderSource).toContain("height: 100dvh");
    expect(loaderSource).toContain("overflow-y: auto");
    expect(loaderSource).toContain("env(safe-area-inset-top)");
    expect(loaderSource).toContain("@media (max-height: 640px)");
    expect(loaderSource).toContain("@media (prefers-reduced-motion: reduce)");
  });
});

describe("frozen prema passage candidates", () => {
  it("contains only source-checked passages from Śrīla Rūpa Gosvāmī's works", () => {
    expect(PREMA_PASSAGE_CANDIDATES).toHaveLength(4);
    expect(Object.isFrozen(PREMA_PASSAGE_CANDIDATES)).toBe(true);
    expect(new Set(PREMA_PASSAGE_CANDIDATES.map(({ id }) => id)).size).toBe(4);

    for (const passage of PREMA_PASSAGE_CANDIDATES) {
      expect(Object.isFrozen(passage)).toBe(true);
      expect(Object.isFrozen(passage.verification)).toBe(true);
      expect(passage.author).toBe("Śrīla Rūpa Gosvāmī");
      expect(["Bhakti-rasāmṛta-sindhu", "Upadeśāmṛta"]).toContain(passage.work);
      expect(passage.reference.length).toBeGreaterThan(0);
      expect(passage.text.length).toBeGreaterThan(0);
      expect(passage.translatorAttribution).toBe(
        "Translation by His Divine Grace A. C. Bhaktivedanta Swami Prabhupāda",
      );
      expect(passage.translationSource.length).toBeGreaterThan(0);
      expect(passage.verification).toMatchObject({
        status: "source_checked",
        checkedOn: "2026-08-09",
        sourceCredit: "BBT International content used by VedaBase with permission; VedaBase owned by The Bhaktivedanta Archives Inc.",
      });
      expect(passage.verification.passageUrl).toMatch(/^https:\/\/vedabase\.io\/en\/library\//);
      expect(passage.verification.workAuthorshipUrl).toMatch(/^https:\/\//);
      expect(passage.verification.translatorAttributionUrl).toMatch(/^https:\/\//);
      expect(["none", "editorial quotation wrappers omitted for standalone display"])
        .toContain(passage.verification.normalization);
      expect(passage.verification.evidence.length).toBeGreaterThan(20);
    }

    const serialized = JSON.stringify(PREMA_PASSAGE_CANDIDATES);
    expect(serialized).not.toMatch(/Bhagavad-gītā|\bBg\./u);
    expect(serialized).not.toMatch(/generated|fallback quotation/iu);
  });

  it("pins every exact word and metadata field with one reviewable hash", () => {
    const actual = createHash("sha256")
      .update(JSON.stringify(PREMA_PASSAGE_CANDIDATES), "utf8")
      .digest("hex");
    expect(actual).toBe(PREMA_PASSAGE_COLLECTION_SHA256);
  });

  it("keeps the two defining bhāva and prema translations exact", () => {
    expect(PREMA_PASSAGE_CANDIDATES[0].text).toBe(
      "When devotional service is executed on the transcendental platform of pure goodness, it is like a sun-ray of love for Kṛṣṇa. At such a time, devotional service causes the heart to be softened by various tastes, and one is then situated in bhāva [emotion].",
    );
    expect(PREMA_PASSAGE_CANDIDATES[1].text).toBe(
      "When that bhāva softens the heart completely, becomes endowed with a great feeling of possessiveness in relation to the Lord and becomes very much condensed and intensified, it is called prema [love of Godhead] by learned scholars.",
    );
  });
});
