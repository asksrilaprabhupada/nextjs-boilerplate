/** Deterministic end-to-end coverage for responsive search and modal states. */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  CLEAN_RESPONSIVE_SEARCH_RESULT,
  failureEventStream,
  RESPONSIVE_SEARCH_RESULT,
  RESPONSIVE_TEST_QUERY,
  resultEventStream,
} from "./fixtures/search-results";

const VIEWPORTS = [
  { name: "mobile-320", width: 320, height: 568 },
  { name: "mobile-360", width: 360, height: 800 },
  { name: "mobile-390", width: 390, height: 844 },
  { name: "tablet-768", width: 768, height: 1024 },
  { name: "tablet-820", width: 820, height: 1180 },
  { name: "tablet-1024", width: 1024, height: 768 },
  { name: "landscape-844", width: 844, height: 390 },
  { name: "laptop-1280", width: 1280, height: 800 },
  { name: "laptop-1366", width: 1366, height: 768 },
  { name: "desktop-1440", width: 1440, height: 900 },
] as const;

const searchPath = `/search?q=${encodeURIComponent(RESPONSIVE_TEST_QUERY)}`;

async function fulfillEventStream(page: Page, body: string): Promise<void> {
  await page.route("**/api/search?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache, no-transform",
        connection: "close",
      },
      body,
    });
  });
}

async function openReadyResults(page: Page): Promise<void> {
  await fulfillEventStream(page, resultEventStream());
  await page.goto(searchPath);
  await expect(page.getByRole("tab", { name: "Essay" })).toBeVisible();
}

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  try {
    await expect.poll(() => page.evaluate(() => (
      document.documentElement.scrollWidth === document.documentElement.clientWidth
    )), { timeout: 5_000 }).toBe(true);
  } catch {
    const diagnostic = await page.evaluate(() => {
      const clientWidth = document.documentElement.clientWidth;
      const offenders = Array.from(document.querySelectorAll<HTMLElement>("body *"))
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            selector: `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${Array.from(element.classList).slice(0, 3).map((name) => `.${name}`).join("")}`,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            overflowX: getComputedStyle(element).overflowX,
            text: (element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80),
          };
        })
        .filter(({ left, right, width }) => width > 0 && (left < -1 || right > clientWidth + 1))
        .sort((a, b) => Math.abs(a.right - document.documentElement.scrollWidth) - Math.abs(b.right - document.documentElement.scrollWidth))
        .slice(0, 20);
      return {
        clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        offenders,
      };
    });
    throw new Error(`Horizontal overflow: ${JSON.stringify(diagnostic)}`);
  }
}

async function expectMinimumTarget(locator: Locator, minimum = 44): Promise<void> {
  await expect(locator).toBeVisible();
  // Transformed parents can produce tiny fractional rounding differences even
  // when the control's computed min-size is exactly 44 CSS pixels. Poll so an
  // entrance scale/translate animation cannot be mistaken for final geometry.
  const renderedMinimum = minimum - 0.1;
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    return Boolean(box && box.width >= renderedMinimum && box.height >= renderedMinimum);
  }, { message: `interactive target should settle at ${minimum}×${minimum} CSS pixels` }).toBe(true);
}

async function expectFullyInsideViewport(page: Page, locator: Locator): Promise<void> {
  await expect.poll(async () => {
    const box = await locator.boundingBox();
    const viewport = page.viewportSize();
    if (!box || !viewport) return false;

    const tolerance = 1;
    return box.x >= -tolerance
      && box.y >= -tolerance
      && box.x + box.width <= viewport.width + tolerance
      && box.y + box.height <= viewport.height + tolerance;
  }, { message: "dialog should settle fully inside the viewport" }).toBe(true);
}

async function selectNormalizedOption(select: Locator, normalizedNeedle: string): Promise<void> {
  const optionValue = await select.locator("option").evaluateAll((options, needle) => {
    const normalize = (value: string) => value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLocaleLowerCase("en")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const match = options.find((option) => normalize(option.textContent || "").includes(String(needle)));
    return match instanceof HTMLOptionElement ? match.value : null;
  }, normalizedNeedle);

  expect(optionValue, `expected an option matching ${normalizedNeedle}`).not.toBeNull();
  await select.selectOption(optionValue!);
}

for (const viewport of VIEWPORTS) {
  test(`${viewport.name}: home search and example questions fit the viewport`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await page.goto("/?entrance=0");

    const searchInput = page.getByRole("textbox", { name: "Search Prabhupāda's books" });
    await expect(searchInput).toBeVisible();
    await expectMinimumTarget(searchInput);
    await expectMinimumTarget(page.locator(".cine-home-search-submit"));
    const moreQuestions = page.getByRole("button", { name: "More questions" });
    await expectMinimumTarget(moreQuestions);
    await expectMinimumTarget(page.locator(".cine-home-feedback"));
    await expectNoHorizontalOverflow(page);

    const bodyPaddingBefore = await page.evaluate(() => document.body.style.paddingRight);
    await moreQuestions.click();
    const examplesDialog = page.getByRole("dialog", { name: "Example questions" });
    await expect(examplesDialog).toBeVisible();
    await expect(examplesDialog).toHaveAttribute("aria-modal", "true");
    expect(await examplesDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    expect(await examplesDialog.evaluate((dialog) => {
      const parent = dialog.parentElement;
      if (!parent) return false;
      return Array.from(parent.children)
        .filter((element) => element !== dialog && element.tagName !== "STYLE")
        .every((element) => element.hasAttribute("inert") && element.getAttribute("aria-hidden") === "true");
    })).toBe(true);
    const examplesClose = examplesDialog.getByRole("button", { name: "Close" });
    await expectMinimumTarget(examplesClose);
    await expectMinimumTarget(examplesDialog.locator(".cine-home-question-pill").first());
    await expectFullyInsideViewport(page, examplesDialog);
    await expectNoHorizontalOverflow(page);

    await expect(examplesClose).toBeFocused();
    const lastExampleControl = examplesDialog.locator("button:not([disabled])").last();
    await page.keyboard.press("Shift+Tab");
    await expect(lastExampleControl).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(examplesClose).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(examplesDialog).toBeHidden();
    await expect(moreQuestions).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
    expect(await page.evaluate(() => document.body.style.paddingRight)).toBe(bodyPaddingBefore);
  });

  test(`${viewport.name}: ready, degraded, references, additional evidence, and preview remain usable`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openReadyResults(page);

    const warning = page.getByRole("alert").filter({ hasText: "Letters could not be searched" });
    await expect(warning).toBeVisible();
    expect(await warning.evaluate((element) => {
      const results = document.querySelector(".results-shell");
      return Boolean(results && (element.compareDocumentPosition(results) & Node.DOCUMENT_POSITION_FOLLOWING));
    })).toBe(true);

    await expectNoHorizontalOverflow(page);
    await expectMinimumTarget(page.getByRole("tab", { name: "Essay" }));
    await expectMinimumTarget(page.getByRole("tab", { name: "By source" }));
    await expectMinimumTarget(page.locator(".search-followup__new"));
    await expectMinimumTarget(page.locator(".search-followup__submit"));

    await page.getByRole("tab", { name: "By source" }).click();
    await expect(page.getByRole("heading", { name: "Lectures & Conversations" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await page.getByRole("tab", { name: "Essay" }).click();

    const digDeeperTrigger = page.getByRole("button", { name: "Dig deeper", exact: true });
    await expect(page.getByText("6 more passages retrieved in this search", { exact: true })).toBeVisible();
    await expectMinimumTarget(digDeeperTrigger);
    await digDeeperTrigger.click();

    const digDeeperDialog = page.getByRole("dialog", { name: "Dig deeper" });
    await expect(digDeeperDialog).toBeVisible();
    await expect(digDeeperDialog).toHaveAttribute("aria-modal", "true");
    expect(await digDeeperDialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await expect(digDeeperDialog.getByPlaceholder("Search within these passages")).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    expect(await page.evaluate(() => {
      const trigger = document.querySelector<HTMLElement>(".dd-launch > button");
      if (!trigger) return false;
      let appRoot = trigger;
      while (appRoot.parentElement && appRoot.parentElement !== document.body) {
        appRoot = appRoot.parentElement;
      }
      return appRoot.hasAttribute("inert") && appRoot.getAttribute("aria-hidden") === "true";
    })).toBe(true);
    await expectFullyInsideViewport(page, digDeeperDialog);
    const digDeeperClose = digDeeperDialog.getByRole("button", { name: "Close Dig deeper" });
    await expectMinimumTarget(digDeeperClose);
    if (viewport.width <= 700) {
      const showFilters = digDeeperDialog.getByRole("button", { name: "Show filters" });
      await expectMinimumTarget(showFilters);
      await expect(showFilters).toHaveAttribute("aria-expanded", "false");
      await showFilters.click();
      await expect(digDeeperDialog.getByRole("button", { name: "Hide filters" })).toHaveAttribute("aria-expanded", "true");
    }
    await expectMinimumTarget(digDeeperDialog.getByRole("button", { name: "Lectures / Conversations" }));
    await expect(digDeeperDialog.getByLabel("Occasion")).toBeVisible();
    await expect(digDeeperDialog.getByLabel("Book / scripture")).toBeVisible();
    await expect(digDeeperDialog.getByLabel("Skandha / canto / division")).toBeVisible();
    await expect(digDeeperDialog.getByLabel("Chapter")).toBeVisible();
    await expect(digDeeperDialog.getByLabel("Speaker")).toBeVisible();
    await expect(digDeeperDialog.getByLabel("Location")).toBeVisible();
    await expect(digDeeperDialog.getByLabel("Recipient")).toBeVisible();
    await expect(digDeeperDialog.getByLabel("Year")).toBeVisible();
    await expect(page.getByText("Second additional responsive fixture.", { exact: false })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    const lastDigDeeperControl = digDeeperDialog.locator(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ).last();
    await digDeeperClose.focus();
    await page.keyboard.press("Shift+Tab");
    await expect(lastDigDeeperControl).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(digDeeperClose).toBeFocused();

    await page.keyboard.press("Escape");
    await expect(digDeeperDialog).toBeHidden();
    await expect(digDeeperTrigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

    const previewTrigger = page.getByRole("button", { name: /^Preview Lecture/ }).first();
    await expectMinimumTarget(previewTrigger);
    await previewTrigger.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    await expectFullyInsideViewport(page, dialog);
    await expectNoHorizontalOverflow(page);

    for (let index = 0; index < 6; index += 1) {
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(previewTrigger).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");

    await page.unrouteAll({ behavior: "wait" });
    await fulfillEventStream(page, resultEventStream(CLEAN_RESPONSIVE_SEARCH_RESULT));
    await page.goto(`${searchPath}&state=clean`);
    await expect(page.getByRole("tab", { name: "Essay" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "could not be searched" })).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });

  test(`${viewport.name}: loading and error states fit the viewport`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });

    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/search?**", async (route) => {
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream",
        body: resultEventStream(),
      });
    });

    try {
      await page.goto(searchPath);
      const progress = page.getByRole("progressbar", { name: "Search progress" });
      await expect(progress).toBeVisible();
      await expect(page.getByRole("list", { name: "Search progress stages" }).getByRole("listitem")).toContainText([
        "Understand",
        "Search",
        "Rerank",
        "Verify",
        "Weave",
      ]);
      await expect.poll(() => progress.evaluate((element) => {
        const percentage = Number(element.getAttribute("aria-valuenow"));
        const fill = document.querySelector<HTMLElement>(".cine-search-loader__fill");
        return fill?.style.width === `${percentage}%`;
      })).toBe(true);
      await expectNoHorizontalOverflow(page);
    } finally {
      release();
    }

    await expect(page.getByRole("tab", { name: "Essay" })).toBeVisible();
    await page.unrouteAll({ behavior: "wait" });
    await fulfillEventStream(page, failureEventStream);
    await page.goto(`${searchPath}&failure=${viewport.name}`);

    const error = page.getByRole("alert").filter({ hasText: "The search failed." });
    await expect(error).toBeVisible();
    await expectMinimumTarget(error.getByRole("button", { name: "Try again" }));
    await expectMinimumTarget(error.getByRole("link", { name: "New search" }));
    await expectNoHorizontalOverflow(page);
  });
}

for (const viewport of [
  { name: "mobile-390", width: 390, height: 844 },
  { name: "laptop-1366", width: 1366, height: 768 },
] as const) {
  test(`${viewport.name}: Dig deeper filters use only proved passage metadata`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    await openReadyResults(page);
    await page.getByRole("button", { name: "Dig deeper", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Dig deeper" });
    const cards = dialog.locator(".dd-card");
    const status = dialog.getByRole("status");
    const clear = () => dialog.getByRole("button", { name: "Clear filters" }).first().click();

    if (viewport.width <= 700) {
      await dialog.getByRole("button", { name: "Show filters" }).click();
    }
    await expect(cards).toHaveCount(6);
    await selectNormalizedOption(dialog.getByLabel("Occasion"), "morning-walk");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Morning Walk");
    await expect(status).toContainText("Showing 1 of 6 passages");
    await clear();

    await selectNormalizedOption(dialog.getByLabel("Book / scripture"), "srimad-bhagavatam");
    await selectNormalizedOption(dialog.getByLabel("Skandha / canto / division"), "canto-7");
    await selectNormalizedOption(dialog.getByLabel("Chapter"), "chapter-8");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("SB 7.8.9");
    await clear();

    await dialog.getByRole("button", { name: "Lectures / Conversations" }).click();
    await selectNormalizedOption(dialog.getByLabel("Occasion"), "room-conversation");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Room Conversation");
    await clear();

    await dialog.getByRole("button", { name: "Letters", exact: true }).click();
    await selectNormalizedOption(dialog.getByLabel("Recipient"), "rupanuga");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Dated letter responsive fixture");
    await clear();

    await dialog.getByPlaceholder("Search within these passages").fill("room-conversation");
    await expect(cards).toHaveCount(1);
    await expect(cards.first()).toContainText("Room-conversation responsive fixture");
    await clear();

    await dialog.getByLabel("Sort").selectOption("newest");
    await expect(cards.first()).toContainText("Morning Walk");
    await dialog.getByRole("button", { name: "By source" }).click();
    await expect(dialog.getByRole("heading", { name: "Morning Walks" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Room Conversations" })).toBeVisible();
    await expect(dialog.getByRole("heading", { name: "Letters" })).toBeVisible();

    await expectFullyInsideViewport(page, dialog);
    await expectNoHorizontalOverflow(page);
    await dialog.getByRole("button", { name: "Close Dig deeper" }).click();
    await expect(dialog).toBeHidden();
  });
}

test("reduced motion disables loader cycling and smooth document scrolling", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/search?**", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: resultEventStream(RESPONSIVE_SEARCH_RESULT),
    });
  });

  try {
    await page.goto(searchPath);
    await expect(page.getByRole("progressbar", { name: "Search progress" })).toBeVisible();
    await expect(page.locator(".cine-search-loader__passage--animated")).toHaveCount(0);
  } finally {
    release();
  }

  await expect(page.getByRole("tab", { name: "Essay" })).toBeVisible();
  expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe("auto");

  await page.goto("/?entrance=0");
  await page.evaluate(() => {
    const testWindow = window as Window & { __responsiveScrollOptions?: ScrollToOptions };
    testWindow.__responsiveScrollOptions = undefined;
    window.scrollTo = ((options: ScrollToOptions) => {
      testWindow.__responsiveScrollOptions = options;
    }) as typeof window.scrollTo;
  });
  await page.getByRole("button", { name: "Search the books" }).click();
  expect(await page.evaluate(() => (
    window as Window & { __responsiveScrollOptions?: ScrollToOptions }
  ).__responsiveScrollOptions)).toEqual({ top: 0, behavior: "auto" });
});
