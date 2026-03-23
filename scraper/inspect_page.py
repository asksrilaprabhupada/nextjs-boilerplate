#!/usr/bin/env python3
"""
============================================================
PAGE INSPECTOR - Run this BEFORE the full scraper
============================================================
Opens ONE page from vedabase.io and shows you:
1. What CSS classes exist on the page
2. Whether our verse selectors find anything
3. A preview of the page text
============================================================
"""

import asyncio
from playwright.async_api import async_playwright


TEST_URL = "https://vedabase.io/en/library/bg/1/advanced-view/"


async def inspect():
    print(f"Opening: {TEST_URL}")
    print(f"Please wait...\n")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=True)
        context = await browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        )
        page = await context.new_page()

        await page.goto(TEST_URL, wait_until="networkidle", timeout=30000)
        await asyncio.sleep(3)

        # Save full HTML
        html = await page.content()
        with open("inspect_output.html", "w", encoding="utf-8") as f:
            f.write(html)
        print(f"Full HTML saved to: inspect_output.html ({len(html)} chars)")

        # Find all CSS classes on the page
        classes = await page.evaluate("""
            () => {
                const all = document.querySelectorAll('*');
                const classSet = new Set();
                all.forEach(el => {
                    el.classList.forEach(c => classSet.add(c));
                });
                return Array.from(classSet).sort();
            }
        """)

        # Filter for verse-related classes
        verse_classes = [c for c in classes if any(
            kw in c.lower() for kw in
            ['verse', 'trans', 'purport', 'synonym', 'sanskrit',
             'devana', 'content', 'chapter', 'sloka', 'transliter']
        )]
        print(f"\nVerse-related CSS classes ({len(verse_classes)}):")
        for c in verse_classes:
            print(f"  .{c}")

        # Test selectors
        print(f"\n--- TESTING SELECTORS ---")
        test_selectors = [
            ('[class*="Verse"]', "Verse (capital V)"),
            ('[class*="verse"]', "verse (lowercase)"),
            ('[class*="devanagari"]', "devanagari"),
            ('[class*="Devanagari"]', "Devanagari (capital)"),
            ('[class*="transliteration"]', "transliteration"),
            ('[class*="synonym"]', "synonyms"),
            ('[class*="translation"]', "translation"),
            ('[class*="Translation"]', "Translation (capital)"),
            ('[class*="purport"]', "purport"),
            ('[class*="Purport"]', "Purport (capital)"),
            ('h1', "h1 (title)"),
            ('h2', "h2"),
            ('article', "article"),
        ]

        for selector, label in test_selectors:
            elements = await page.query_selector_all(selector)
            count = len(elements)
            sample = ""
            if count > 0:
                text = await elements[0].inner_text()
                sample = text[:80].replace("\n", " ")
            print(f"  {label:30s} > {count:3d} found   | Sample: {sample}")

        # Page text preview
        print(f"\n--- PAGE TEXT PREVIEW (first 2000 chars) ---")
        body_text = await page.evaluate("() => document.body.innerText")
        print(body_text[:2000])

        await browser.close()

    print(f"\n{'=' * 60}")
    print(f"DONE. Share this output with Claude if selectors show 0.")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    asyncio.run(inspect())
