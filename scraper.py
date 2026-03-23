#!/usr/bin/env python3
"""
============================================================
VEDABASE SCRAPER - Automated verse extraction
============================================================
Uses Playwright (real Chrome browser) to visit vedabase.io
advanced-view pages and extract all verse data.

Saves one JSON file per chapter in the raw_data/ folder.
If it crashes, restart it - it skips completed chapters.
============================================================
"""

import asyncio
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright
from url_map import get_all_urls


# --- CONFIGURATION ---
RAW_DATA_DIR = "raw_data"
DELAY_BETWEEN_PAGES = 4  # seconds between pages (be respectful)
HEADLESS = True  # True = invisible browser (faster)


def get_chapter_filename(chapter_info):
    """Generate filename for a chapter JSON file."""
    s = chapter_info["scripture"].lower()
    d = chapter_info["canto_or_division"] or ""
    c = str(chapter_info["chapter_number"]).zfill(2)
    if d:
        return f"{s}_{d}_{c}.json"
    return f"{s}_{c}.json"


async def extract_verses_from_page(page):
    """Extract all verses from a loaded vedabase advanced-view page."""
    verses = []

    await page.wait_for_load_state("networkidle")
    await asyncio.sleep(2)

    # Try known selectors for verse blocks
    verse_blocks = await page.query_selector_all(
        '[class*="Verse"], [class*="verse"], .r-verse, article'
    )

    if not verse_blocks:
        verse_blocks = await page.query_selector_all(
            '[id*="verse"], [data-verse], .content-verse'
        )

    if not verse_blocks:
        print("    WARNING: 0 verse blocks found.")
        content = await page.content()
        return verses, content

    for block in verse_blocks:
        verse_data = {}

        # Verse number
        num_el = await block.query_selector(
            '[class*="number"], [class*="Number"], h2, h3'
        )
        if num_el:
            verse_data["verse_number"] = (await num_el.inner_text()).strip()

        # Sanskrit (Devanagari)
        sanskrit_el = await block.query_selector(
            '[class*="devanagari"], [class*="Devanagari"], [class*="sanskrit"]'
        )
        if sanskrit_el:
            verse_data["sanskrit_devanagari"] = (await sanskrit_el.inner_text()).strip()

        # Transliteration
        translit_el = await block.query_selector(
            '[class*="transliteration"], [class*="Transliteration"]'
        )
        if translit_el:
            verse_data["transliteration"] = (await translit_el.inner_text()).strip()

        # Synonyms
        syn_el = await block.query_selector(
            '[class*="synonym"], [class*="Synonym"]'
        )
        if syn_el:
            verse_data["synonyms"] = (await syn_el.inner_text()).strip()

        # Translation
        trans_el = await block.query_selector(
            '[class*="translation"], [class*="Translation"]'
        )
        if trans_el:
            verse_data["translation"] = (await trans_el.inner_text()).strip()

        # Purport
        purport_el = await block.query_selector(
            '[class*="purport"], [class*="Purport"]'
        )
        if purport_el:
            verse_data["purport"] = (await purport_el.inner_text()).strip()

        if verse_data.get("verse_number") or verse_data.get("translation"):
            verses.append(verse_data)

    return verses, None


async def scrape_all():
    """Main scraping function."""
    Path(RAW_DATA_DIR).mkdir(exist_ok=True)

    all_urls = get_all_urls()
    total = len(all_urls)

    print(f"={" * 60}")
    print(f"VEDABASE SCRAPER")
    print(f"Total chapters to scrape: {total}")
    print(f"={"  * 60}")

    already_done = set(os.listdir(RAW_DATA_DIR))
    remaining = [u for u in all_urls if get_chapter_filename(u) not in already_done]

    if len(remaining) < total:
        print(f"Already completed: {total - len(remaining)} chapters")
        print(f"Remaining: {len(remaining)} chapters")

    if not remaining:
        print("ALL DONE! Run merge.py next.")
        return

    print(f"\nStarting in 3 seconds...")
    await asyncio.sleep(3)

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=HEADLESS)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()

        failed = []

        for i, chapter_info in enumerate(remaining, 1):
            filename = get_chapter_filename(chapter_info)
            url = chapter_info["url"]

            print(f"\n[{i}/{len(remaining)}] {chapter_info['scripture']} ", end="")
            if chapter_info["canto_or_division"]:
                print(f"{chapter_info['canto_or_division']}.", end="")
            print(f"{chapter_info['chapter_number']}")
            print(f"  URL: {url}")

            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=30000)

                verses, raw_html = await extract_verses_from_page(page)

                title_el = await page.query_selector("h1")
                chapter_title = ""
                if title_el:
                    chapter_title = (await title_el.inner_text()).strip()

                chapter_data = {
                    "scripture": chapter_info["scripture"],
                    "canto_or_division": chapter_info["canto_or_division"],
                    "chapter_number": chapter_info["chapter_number"],
                    "chapter_title": chapter_title,
                    "vedabase_url": url,
                    "total_verses": len(verses),
                    "verses": verses
                }

                if not verses and raw_html:
                    debug_path = os.path.join(RAW_DATA_DIR, f"DEBUG_{filename}.html")
                    with open(debug_path, "w", encoding="utf-8") as f:
                        f.write(raw_html)
                    print(f"  WARNING: 0 verses. Debug HTML saved.")
                    failed.append(filename)
                else:
                    print(f"  OK: {len(verses)} verses. Title: {chapter_title[:50]}")

                filepath = os.path.join(RAW_DATA_DIR, filename)
                with open(filepath, "w", encoding="utf-8") as f:
                    json.dump(chapter_data, f, ensure_ascii=False, indent=2)

            except Exception as e:
                print(f"  ERROR: {str(e)}")
                failed.append(filename)

            await asyncio.sleep(DELAY_BETWEEN_PAGES)

        await browser.close()

    print(f"\n={"  * 60}")
    print(f"SCRAPING COMPLETE")
    print(f"  Failed: {len(failed)}")
    if failed:
        print(f"  Re-run script to retry: python scraper.py")
    print(f"\nNext step: python merge.py")


if __name__ == "__main__":
    asyncio.run(scrape_all())
