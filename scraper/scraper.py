#!/usr/bin/env python3
"""
============================================================
VEDABASE SCRAPER - FINAL VERSION
============================================================
Verified HTML structure (March 2026):

.av-verses (one container)
  └── DIV (one per verse, no class)
       ├── DIV > H2 (verse number like "TEXT 1")
       ├── DIV.av-devanagari (Sanskrit)
       ├── DIV.av-verse_text (transliteration)
       ├── DIV.av-synonyms (word meanings)
       ├── DIV.av-translation (English translation)
       └── DIV.av-purport (purport - may not exist)

Features:
- Stealth mode to bypass Cloudflare
- 90 second page timeout for large chapters
- 6 second delay between pages
- Browser restarts every 25 chapters (memory)
- Crash recovery (skips completed chapters)
- Extracts all verse components correctly
============================================================
"""

import asyncio
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright
from playwright_stealth import stealth_async
from url_map import get_all_urls


# --- CONFIGURATION ---
RAW_DATA_DIR = "raw_data"
DELAY_BETWEEN_PAGES = 6
HEADLESS = True
PAGE_TIMEOUT = 90000        # 90 seconds for big chapters
CLOUDFLARE_WAIT = 30        # max seconds to wait for Cloudflare
BROWSER_RESTART_EVERY = 25  # restart browser every N chapters


def get_chapter_filename(chapter_info):
    s = chapter_info["scripture"].lower()
    d = chapter_info["canto_or_division"] or ""
    c = str(chapter_info["chapter_number"]).zfill(2)
    if d:
        return f"{s}_{d}_{c}.json"
    return f"{s}_{c}.json"


async def wait_for_cloudflare(page):
    """Wait for Cloudflare challenge to resolve. Returns True if passed."""
    for i in range(CLOUDFLARE_WAIT // 2):
        await asyncio.sleep(2)
        try:
            body = await page.evaluate(
                "() => document.body.innerText.substring(0, 500)"
            )
            # Check for real content indicators
            if any(kw in body for kw in ["TEXT 1", "TEXT 2", "TEXTS"]):
                return True
            if "av-verses" in await page.content()[:5000]:
                return True
        except:
            pass
    return False


async def extract_verses(page):
    """Extract all verses using JavaScript inside the browser."""
    verses = await page.evaluate("""
        () => {
            const container = document.querySelector(".av-verses");
            if (!container) return [];

            const verseDivs = container.children;
            const results = [];

            for (const vDiv of verseDivs) {
                const verse = {};

                // Verse number from h2
                const h2 = vDiv.querySelector("h2");
                if (h2) {
                    let num = h2.innerText.trim();
                    num = num.replace("TEXTS", "").replace("TEXT", "").trim();
                    verse.verse_number = num;
                }

                // Sanskrit (Devanagari)
                const dev = vDiv.querySelector(".av-devanagari");
                if (dev) verse.sanskrit_devanagari = dev.innerText.trim();

                // Transliteration
                const vt = vDiv.querySelector(".av-verse_text");
                if (vt) verse.transliteration = vt.innerText.trim();

                // Synonyms
                const syn = vDiv.querySelector(".av-synonyms");
                if (syn) {
                    let t = syn.innerText.trim();
                    if (t.startsWith("Synonyms")) t = t.substring(8).trim();
                    verse.synonyms = t;
                }

                // Translation
                const tr = vDiv.querySelector(".av-translation");
                if (tr) {
                    let t = tr.innerText.trim();
                    if (t.startsWith("Translation")) t = t.substring(11).trim();
                    verse.translation = t;
                }

                // Purport (not every verse has one)
                const pur = vDiv.querySelector(".av-purport");
                if (pur) {
                    let t = pur.innerText.trim();
                    if (t.startsWith("Purport")) t = t.substring(7).trim();
                    verse.purport = t;
                }

                if (verse.verse_number) {
                    results.push(verse);
                }
            }

            return results;
        }
    """)

    return verses


async def create_browser(playwright):
    """Create a new stealth browser instance."""
    browser = await playwright.chromium.launch(
        headless=HEADLESS,
        args=["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    )
    context = await browser.new_context(
        user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        viewport={"width": 1920, "height": 1080},
        locale="en-US",
    )
    page = await context.new_page()
    await stealth_async(page)
    return browser, context, page


async def scrape_all():
    Path(RAW_DATA_DIR).mkdir(exist_ok=True)

    all_urls = get_all_urls()
    total = len(all_urls)

    print(f"{'=' * 60}")
    print(f"VEDABASE SCRAPER (Final Version)")
    print(f"Total chapters: {total}")
    print(f"{'=' * 60}")

    already_done = set(os.listdir(RAW_DATA_DIR))
    remaining = [u for u in all_urls if get_chapter_filename(u) not in already_done]

    if len(remaining) < total:
        print(f"Already completed: {total - len(remaining)} chapters")
    print(f"Remaining: {len(remaining)} chapters")

    if not remaining:
        print("ALL DONE! Run: python merge.py")
        return

    print(f"\nStarting in 3 seconds...")
    await asyncio.sleep(3)

    async with async_playwright() as p:
        browser, context, page = await create_browser(p)
        failed = []
        chapters_since_restart = 0

        for i, chapter_info in enumerate(remaining, 1):
            filename = get_chapter_filename(chapter_info)
            url = chapter_info["url"]

            # Restart browser periodically to free memory
            if chapters_since_restart >= BROWSER_RESTART_EVERY:
                print(f"\n  [Restarting browser for memory...]")
                await browser.close()
                browser, context, page = await create_browser(p)
                chapters_since_restart = 0

            scripture = chapter_info["scripture"]
            div = chapter_info["canto_or_division"]
            ch = chapter_info["chapter_number"]
            label = f"{scripture}"
            if div:
                label += f" {div}.{ch}"
            else:
                label += f" {ch}"

            print(f"\n[{i}/{len(remaining)}] {label}")
            print(f"  URL: {url}")

            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT)

                # Wait for Cloudflare
                passed = await wait_for_cloudflare(page)
                if not passed:
                    print(f"  BLOCKED by Cloudflare. Waiting 30s and retrying...")
                    await asyncio.sleep(30)
                    await page.goto(url, wait_until="domcontentloaded", timeout=PAGE_TIMEOUT)
                    passed = await wait_for_cloudflare(page)
                    if not passed:
                        print(f"  STILL BLOCKED. Skipping.")
                        failed.append(filename)
                        continue

                # Extra wait for large pages to finish rendering
                await asyncio.sleep(3)

                # Extract verses
                verses = await extract_verses(page)

                # Get chapter title
                title_el = await page.query_selector("h1")
                chapter_title = ""
                if title_el:
                    chapter_title = (await title_el.inner_text()).strip()

                chapter_data = {
                    "scripture": scripture,
                    "canto_or_division": div,
                    "chapter_number": ch,
                    "chapter_title": chapter_title,
                    "vedabase_url": url,
                    "total_verses": len(verses),
                    "verses": verses,
                }

                if not verses:
                    # Save debug HTML
                    debug_html = await page.content()
                    debug_path = os.path.join(RAW_DATA_DIR, f"DEBUG_{filename}.html")
                    with open(debug_path, "w", encoding="utf-8") as f:
                        f.write(debug_html)
                    print(f"  WARNING: 0 verses. Debug HTML saved.")
                    failed.append(filename)
                else:
                    with_purport = sum(1 for v in verses if v.get("purport"))
                    print(f"  OK: {len(verses)} verses ({with_purport} with purport)")
                    if chapter_title:
                        print(f"  Title: {chapter_title[:60]}")

                # Save JSON
                filepath = os.path.join(RAW_DATA_DIR, filename)
                with open(filepath, "w", encoding="utf-8") as f:
                    json.dump(chapter_data, f, ensure_ascii=False, indent=2)

                chapters_since_restart += 1

            except Exception as e:
                print(f"  ERROR: {str(e)[:100]}")
                failed.append(filename)
                # Restart browser after error
                try:
                    await browser.close()
                except:
                    pass
                browser, context, page = await create_browser(p)
                chapters_since_restart = 0

            await asyncio.sleep(DELAY_BETWEEN_PAGES)

        await browser.close()

    # Summary
    print(f"\n{'=' * 60}")
    print(f"SCRAPING COMPLETE")
    print(f"  Total processed: {len(remaining)}")
    print(f"  Failed: {len(failed)}")
    if failed:
        print(f"  Failed: {failed[:20]}")
        if len(failed) > 20:
            print(f"  ... and {len(failed) - 20} more")
        print(f"  Re-run to retry: python scraper.py")
    print(f"{'=' * 60}")
    print(f"\nNext: python merge.py")


if __name__ == "__main__":
    asyncio.run(scrape_all())