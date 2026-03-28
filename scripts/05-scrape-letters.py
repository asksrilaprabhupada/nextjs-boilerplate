"""
05-scrape-letters.py — Scrape ALL letters from Vedabase

Same approach as transcript scraper: real Chrome, save raw HTML + JSON.
Resumable: skips pages already scraped.

Usage:
  python scripts/05-scrape-letters.py
  python scripts/05-scrape-letters.py --test
"""
import json
import re
import sys
import time
import hashlib
from datetime import datetime
from pathlib import Path
from playwright.sync_api import sync_playwright, Page, TimeoutError as PwTimeout

from config import (
    LETTERS_RAW_DIR, LETTERS_JSON_DIR, LOGS_DIR,
    VEDABASE_BASE, PAGE_DELAY_SECONDS, RETRY_COUNT,
)

TEST_MODE = "--test" in sys.argv
LOG_FILE = LOGS_DIR / "scrape_letters.log"
PROGRESS_FILE = LOGS_DIR / "letters_progress.json"

def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def load_progress() -> dict:
    if PROGRESS_FILE.exists():
        return json.loads(PROGRESS_FILE.read_text(encoding="utf-8"))
    return {"scraped_urls": [], "failed_urls": [], "total_found": 0}

def save_progress(progress: dict):
    PROGRESS_FILE.write_text(json.dumps(progress, indent=2), encoding="utf-8")

def safe_filename(url: str) -> str:
    h = hashlib.md5(url.encode()).hexdigest()[:10]
    slug = url.rstrip("/").split("/")[-1] or "index"
    slug = re.sub(r'[^a-zA-Z0-9_-]', '_', slug)[:80]
    return f"{slug}_{h}"

def collect_letter_urls(page: Page) -> list[str]:
    """Navigate through all letter listing pages."""
    all_urls = []
    current_url = f"{VEDABASE_BASE}/letters/"
    page_num = 0

    while current_url:
        page_num += 1
        log(f"  Index page {page_num}: {current_url}")
        page.goto(current_url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)

        links = page.eval_on_selector_all(
            'a[href*="/library/letters/"]',
            """els => els.map(el => el.href).filter(h =>
                h.includes('/letters/') &&
                !h.endsWith('/letters/') &&
                !h.includes('?') &&
                h.split('/').filter(Boolean).length > 5
            )"""
        )

        new_links = [u for u in links if u not in all_urls]
        all_urls.extend(new_links)
        log(f"    Found {len(new_links)} new links (total: {len(all_urls)})")

        next_link = page.eval_on_selector_all(
            'a[rel="next"], a:has-text("Next"), a:has-text("›"), .pagination a',
            "els => els.map(el => el.href)"
        )
        next_url = None
        for nl in next_link:
            if nl and nl != current_url and "/letters/" in nl:
                next_url = nl
                break
        if next_url and next_url != current_url:
            current_url = next_url
            time.sleep(PAGE_DELAY_SECONDS)
        else:
            current_url = None

    seen = set()
    unique = []
    for u in all_urls:
        n = u.rstrip("/")
        if n not in seen:
            seen.add(n)
            unique.append(u)
    return unique

def scrape_one_letter(page: Page, url: str) -> dict | None:
    fname = safe_filename(url)

    for attempt in range(1, RETRY_COUNT + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)

            raw_html = page.content()
            (LETTERS_RAW_DIR / f"{fname}.html").write_text(raw_html, encoding="utf-8")

            # Title
            title = ""
            try:
                title = page.inner_text("h1").strip()
            except:
                try:
                    title = page.title().strip()
                except:
                    pass

            # Body text
            body_text = ""
            selectors_to_try = [
                ".content-body", ".letter-content", "article .content",
                ".r-text", "article", "main .container", "#content", "main",
            ]
            for sel in selectors_to_try:
                try:
                    el = page.query_selector(sel)
                    if el:
                        text = el.inner_text().strip()
                        if len(text) > 50:
                            body_text = text
                            break
                except:
                    continue

            if not body_text:
                try:
                    body_text = page.eval_on_selector(
                        "body",
                        """el => {
                            const clone = el.cloneNode(true);
                            clone.querySelectorAll('nav, footer, header, script, style').forEach(e => e.remove());
                            return clone.innerText.trim();
                        }"""
                    )
                except:
                    pass

            # ── Extract letter metadata from STRUCTURED fields on page ──
            # Page shows: Dated, Location, Letter to as labeled fields
            recipient = ""
            date_str = ""
            location = ""
            letter_number = ""

            try:
                page_text = page.inner_text("body")

                # Extract "Letter to:" field
                recip_match = re.search(r'Letter to:\s*(.+?)(?:\n|$)', page_text)
                if recip_match:
                    recipient = recip_match.group(1).strip()

                # Extract "Dated:" field
                dated_match = re.search(r'Dated:\s*(.+?)(?:\n|$)', page_text)
                if dated_match:
                    date_str = dated_match.group(1).strip()

                # Extract "Location:" field
                loc_match = re.search(r'Location:\s*(.+?)(?:\n|$)', page_text)
                if loc_match:
                    location = loc_match.group(1).strip()
            except:
                pass

            # Fallback: extract recipient from title "Letter to: Mahatma Gandhi"
            if not recipient and title:
                recip_title = re.search(r'Letter\s+to:?\s*(.+?)(?:\s*[—–-]\s*|$)', title, re.IGNORECASE)
                if recip_title:
                    recipient = recip_title.group(1).strip()

            # Letter number from URL slug
            url_parts = url.rstrip("/").split("/")
            if url_parts:
                letter_number = url_parts[-1]

            # Parse date — handle "July 12th 1947", "January 1, 1972", etc.
            date_iso = None
            if date_str:
                clean_date = re.sub(r'(\d+)(st|nd|rd|th)', r'\1', date_str)
                for fmt in ["%B %d %Y", "%B %d, %Y", "%d %B %Y", "%B %Y"]:
                    try:
                        parsed = datetime.strptime(clean_date.strip(), fmt)
                        date_iso = parsed.strftime("%Y-%m-%d")
                        break
                    except:
                        continue

            # Remove metadata section from body_text
            if body_text:
                meta_end_patterns = [
                    r'Letter to:.*?\n',
                    r'Location:.*?\n',
                    r'Dated:.*?\n',
                ]
                for pat in meta_end_patterns:
                    match = re.search(pat, body_text)
                    if match:
                        possible_start = match.end()
                        if possible_start < len(body_text) * 0.3:
                            body_text = body_text[possible_start:].strip()
                            break

            # Paragraphs
            paragraphs = []
            for line in body_text.split("\n"):
                cleaned = line.strip()
                if cleaned and len(cleaned) > 15:
                    paragraphs.append(cleaned)

            result = {
                "vedabase_url": url,
                "title": title,
                "recipient": recipient,
                "date": date_iso,
                "date_raw": date_str,
                "location": location,
                "letter_number": letter_number,
                "body_text_full": body_text,
                "paragraphs": paragraphs,
                "paragraph_count": len(paragraphs),
                "char_count": len(body_text),
                "word_count": len(body_text.split()),
                "scraped_at": datetime.now().isoformat(),
            }

            json_path = LETTERS_JSON_DIR / f"{fname}.json"
            json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
            return result

        except PwTimeout:
            log(f"    Timeout attempt {attempt}/{RETRY_COUNT}")
            time.sleep(5 * attempt)
        except Exception as e:
            log(f"    Error attempt {attempt}/{RETRY_COUNT}: {str(e)[:200]}")
            time.sleep(5 * attempt)

    return None

def main():
    log("=" * 60)
    log("LETTER SCRAPER — Starting")
    log(f"Test mode: {TEST_MODE}")
    log("=" * 60)

    progress = load_progress()
    scraped_set = set(progress["scraped_urls"])

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=False, slow_mo=500)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()

        log("\n── Step 1: Collecting letter URLs ──")
        all_urls = collect_letter_urls(page)
        progress["total_found"] = len(all_urls)
        save_progress(progress)
        log(f"\nFound {len(all_urls)} total letter URLs")

        to_scrape = [u for u in all_urls if u.rstrip("/") not in scraped_set]
        log(f"Already scraped: {len(scraped_set)} | Remaining: {len(to_scrape)}")

        if TEST_MODE:
            to_scrape = to_scrape[:5]

        log("\n── Step 2: Scraping individual letters ──")
        success = 0
        failed = 0

        for i, url in enumerate(to_scrape):
            log(f"\n[{i+1}/{len(to_scrape)}] {url}")
            result = scrape_one_letter(page, url)
            if result:
                success += 1
                progress["scraped_urls"].append(url.rstrip("/"))
                log(f"  ✓ {result['title'][:60]} | {result['paragraph_count']} para | {result['word_count']} words")
            else:
                failed += 1
                progress["failed_urls"].append(url)
                log(f"  ✗ FAILED")
            save_progress(progress)
            time.sleep(PAGE_DELAY_SECONDS)

        browser.close()

    log("\n" + "=" * 60)
    log(f"DONE | ✓ {success} | ✗ {failed} | Total: {len(progress['scraped_urls'])}")
    log("=" * 60)

    url_list_path = LOGS_DIR / "letter_urls_found.json"
    url_list_path.write_text(json.dumps(all_urls, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
