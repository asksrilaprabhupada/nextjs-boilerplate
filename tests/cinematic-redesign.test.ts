/**
 * cinematic-redesign.test.ts — The promises the redesign makes, pinned.
 *
 * docs/redesign/HANDOFF.md sets rules that are easy to re-break with a later
 * edit: only real words, nothing animated through a CSS filter, no live SVG
 * grain, everything stilled by reduced motion, the extra pages hidden (307
 * home, out of the sitemap), Advanced switched off unless the deployment says
 * otherwise, and nothing from the mockups that exists only in the mockups.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "@/next.config";
import sitemap from "@/app/sitemap";
import entrance from "@/public/data/entrance-quotes.json";
import lineage from "@/public/data/lineage.json";
import questions from "@/public/data/self-typing-questions.json";
import { DOORWAY_DATE_KEY, DOORWAY_DECISION_SCRIPT } from "@/app/lib/29-doorway-decision";

const ROOT = process.cwd();
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const CSS = read("app/redesign.css");

/** Every live source file of the redesign (the retained earlier generation excluded). */
const LIVE_FILES = [
  "app/page.tsx",
  "app/layout.tsx",
  "app/components/cinematic/09-search-experience.tsx",
  "app/components/cinematic/10-search-loader.tsx",
  "app/components/cinematic/11-site-header.tsx",
  "app/components/cinematic/12-site-footer.tsx",
  "app/components/cinematic/15-brand.tsx",
  "app/components/cinematic/16-doorway.tsx",
  "app/components/cinematic/17-self-typing.tsx",
  "app/components/cinematic/18-search-in-switch.tsx",
  "app/components/cinematic/19-ask-home.tsx",
  "app/components/cinematic/20-advanced-page.tsx",
  "app/components/results/01-narrative-response.tsx",
  "app/components/results/03-cinematic-dig-deeper.tsx",
  "app/components/results/04-citation-bar.tsx",
];

function keyframeBodies(css: string): string[] {
  const bodies: string[] = [];
  const re = /@keyframes\s+[\w-]+\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(css))) {
    let depth = 1;
    let i = match.index + match[0].length;
    const start = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth += 1;
      if (css[i] === "}") depth -= 1;
      i += 1;
    }
    bodies.push(css.slice(start, i - 1));
  }
  return bodies;
}

describe("the redesign's data", () => {
  it("ships the new doorway verse pool, every line with its speaker and source", () => {
    expect(entrance.quotes).toHaveLength(24);
    for (const quote of entrance.quotes) {
      expect(quote.text.trim().length).toBeGreaterThan(20);
      expect(quote.source.trim().length).toBeGreaterThan(3);
    }
  });

  it("types eight questions on desktop and eight shorter ones on phone", () => {
    expect(questions.desktop_and_ipad).toHaveLength(8);
    expect(questions.phone).toHaveLength(8);
  });

  it("walks fifteen names and ends on Śrīla Prabhupāda's photograph", () => {
    expect(lineage.lineage).toHaveLength(15);
    expect(lineage.lineage[0].name).toBe("Śrī Caitanya Mahāprabhu");
    const last = lineage.lineage[lineage.lineage.length - 1];
    expect(last.name).toBe("Śrīla Prabhupāda");
    expect(last.image).toBeTruthy();
    // Until an approved painting exists, an entry has no image — never a stand-in.
    for (const entry of lineage.lineage.slice(0, -1)) {
      expect(entry.image === null || typeof entry.image === "string").toBe(true);
    }
  });
});

describe("only transform and opacity move", () => {
  it("never animates a CSS filter, width or background colour in a keyframe", () => {
    for (const body of keyframeBodies(CSS)) {
      expect(body).not.toMatch(/\bfilter\s*:/);
      expect(body).not.toMatch(/(^|[\s{;])width\s*:/);
      expect(body).not.toMatch(/\bbackground\s*:/);
    }
  });

  it("uses a PNG grain tile, never a live SVG turbulence filter", () => {
    expect(CSS).toContain('url("/images/redesign/grain.png")');
    for (const file of LIVE_FILES) expect(read(file)).not.toContain("feTurbulence");
    expect(statSync(join(ROOT, "public/images/redesign/grain.png")).size).toBeLessThan(40_000);
  });

  it("puts no filter on text", () => {
    expect(CSS).not.toMatch(/filter\s*:\s*drop-shadow/);
    for (const file of LIVE_FILES) expect(read(file)).not.toMatch(/filter:\s*["']?drop-shadow/);
  });

  it("stills everything under reduced motion", () => {
    const reduced = CSS.slice(CSS.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain("animation: none !important");
    expect(reduced).toContain("transition: none !important");
    expect(reduced).toMatch(/\.asp-Lp0,\s*\.asp-Pp0 \{ opacity: 1 !important/);
  });

  it("loads the doorway's portrait and landscape sets by screen width", () => {
    expect(CSS).toContain("@media (max-width: 767px) { .asp-door-set-L { display: none; } }");
    expect(CSS).toContain("@media (min-width: 768px) { .asp-door-set-P { display: none; } }");
    // The first photo of each set is fetched only under its own width rule…
    expect(CSS).toMatch(/@media \(min-width: 768px\) \{\s*\.asp-door-set-L \.asp-ph-first \.asp-ph-img \{ background-image: url\("\/images\/redesign\/photos\/with-disciples\.webp"\)/);
    expect(CSS).toMatch(/@media \(max-width: 767px\) \{\s*\.asp-door-set-P \.asp-ph-first \.asp-ph-img \{ background-image: url\("\/images\/redesign\/photos\/folded-hands\.webp"\)/);
    // …and the rest only for the set the screen shows, after the first paint.
    const door = read("app/components/cinematic/16-doorway.tsx");
    expect(door).toContain('image={i > 0 && loadRest("L")}');
    expect(door).toContain('image={i > 0 && loadRest("P")}');
  });
});

describe("only real words", () => {
  it("keeps the mockups' scaffolding off the live site", () => {
    for (const file of LIVE_FILES) {
      const source = read(file);
      expect(source).not.toContain("Prototype only");
      expect(source).not.toContain("Painting to come");
      expect(source).not.toContain("Sample page");
      expect(source).not.toContain("Sample rows");
      // The three-colour legend would describe kinds the search does not produce.
      expect(source).not.toContain("The direct answer");
      expect(source).not.toContain("An analogy");
    }
  });

  it("prints the disclaimer word for word", () => {
    expect(read("app/components/results/01-narrative-response.tsx")).toContain(
      "This site finds Śrīla Prabhupāda&apos;s words and shows exactly where they come from. It does not give the whole teaching. Read every passage in its full context, on Vedabase or in the original book, and ask senior devotees when something is unclear. We cannot take responsibility for how a passage is understood.",
    );
  });

  it("builds no context story and shows no placeholder Advanced passages", () => {
    const answer = read("app/components/results/01-narrative-response.tsx");
    expect(answer).not.toContain("The story that led here");
    const advanced = read("app/components/cinematic/20-advanced-page.tsx");
    expect(advanced).not.toContain("[translator]");
    expect(advanced).not.toContain("asp-bar");
  });
});

describe("hidden pages and the Advanced switch", () => {
  it("sends His Journey, Features and How it works home with a temporary redirect", async () => {
    const redirects = await nextConfig.redirects!();
    expect(redirects.map((r) => r.source).sort()).toEqual(["/features", "/how-it-works", "/journey"]);
    for (const redirect of redirects) {
      expect(redirect.destination).toBe("/");
      expect("permanent" in redirect && redirect.permanent).toBe(false);
    }
  });

  it("lists only the home page in the sitemap", () => {
    const urls = sitemap().map((entry) => entry.url);
    expect(urls).toHaveLength(1);
    expect(urls.join(" ")).not.toMatch(/journey|features|how-it-works/);
  });

  it("keeps Advanced off unless the deployment switches it on", async () => {
    const previous = process.env.NEXT_PUBLIC_ADVANCED_ENABLED;
    delete process.env.NEXT_PUBLIC_ADVANCED_ENABLED;
    const { ADVANCED_ENABLED } = await import("@/app/lib/28-advanced-flag");
    expect(ADVANCED_ENABLED).toBe(false);
    if (previous !== undefined) process.env.NEXT_PUBLIC_ADVANCED_ENABLED = previous;
    expect(read("app/components/cinematic/19-ask-home.tsx")).toContain("{ADVANCED_ENABLED && <SearchInSwitch");
    expect(read("app/components/results/01-narrative-response.tsx")).toContain("{ADVANCED_ENABLED && (");
    expect(read("app/advanced/page.tsx")).toContain("if (!ADVANCED_ENABLED) notFound();");
  });

  it("links nowhere to the hidden pages from the live UI", () => {
    for (const file of LIVE_FILES) {
      expect(read(file)).not.toMatch(/href="\/(journey|features|how-it-works)"/);
    }
  });
});

describe("when the doorway shows", () => {
  function decide(pathname: string, search: string, stored?: string) {
    const attrs: Record<string, string> = {};
    const store = new Map<string, string>(stored ? [[DOORWAY_DATE_KEY, stored]] : []);
    const fakeDocument = { documentElement: { setAttribute: (key: string, value: string) => { attrs[key] = value; } } };
    const fakeStorage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    };
    new Function("location", "document", "localStorage", "URLSearchParams", DOORWAY_DECISION_SCRIPT)(
      { pathname, search },
      fakeDocument,
      fakeStorage,
      URLSearchParams,
    );
    return { door: attrs["data-door"], stored: store.get(DOORWAY_DATE_KEY) };
  }
  const now = new Date();
  const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;

  it("shows on the first arrival of the day and remembers the date", () => {
    expect(decide("/", "")).toEqual({ door: "show", stored: today });
  });

  it("shows at most once a day per device", () => {
    expect(decide("/", "", today).door).toBe("skip");
    expect(decide("/", "", "1999-1-1").door).toBe("show");
  });

  it("is skipped by ?entrance=0 and never runs off the home page", () => {
    expect(decide("/", "?entrance=0").door).toBe("skip");
    expect(decide("/search", "?q=x").door).toBeUndefined();
  });
});

describe("the redesign's images", () => {
  it("has every photograph and logo crop the designs reference", () => {
    const photos = readdirSync(join(ROOT, "public/images/redesign/photos"));
    for (const name of [
      "with-disciples.webp", "vrindavan-deities.webp", "new-york-1965.webp", "jaladuta-1965.webp",
      "morning-walk.webp", "folded-hands.webp", "lecturing.webp", "paris.webp", "translating.webp",
    ]) {
      expect(photos).toContain(name);
    }
    expect(readdirSync(join(ROOT, "public/images/redesign/logo"))).toContain("face-gold.webp");
    expect(statSync(join(ROOT, "app/apple-icon.png")).size).toBeGreaterThan(0);
    expect(read("app/icon.svg")).toContain('width="16" height="16"');
  });
});
