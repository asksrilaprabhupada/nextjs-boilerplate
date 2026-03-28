"""
04-scrape-transcripts.py — Scrape ALL transcripts from Vedabase

Uses Playwright (real Chrome browser) to bypass bot detection.
Saves raw HTML + extracted JSON for every transcript.
Resumable: skips pages already scraped.

Usage:
  python scripts/04-scrape-transcripts.py
  python scripts/04-scrape-transcripts.py --test   (scrape only 5 pages)
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
    TRANSCRIPTS_RAW_DIR, TRANSCRIPTS_JSON_DIR, LOGS_DIR,
    VEDABASE_BASE, PAGE_DELAY_SECONDS, RETRY_COUNT,
)

TEST_MODE = "--test" in sys.argv
LOG_FILE = LOGS_DIR / "scrape_transcripts.log"
PROGRESS_FILE = LOGS_DIR / "transcripts_progress.json"

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
    """Create a safe filename from a URL."""
    h = hashlib.md5(url.encode()).hexdigest()[:10]
    slug = url.rstrip("/").split("/")[-1] or "index"
    slug = re.sub(r'[^a-zA-Z0-9_-]', '_', slug)[:80]
    return f"{slug}_{h}"

# ─── Step 1: Collect all transcript URLs from the index pages ───

def collect_transcript_urls(page: Page) -> list[str]:
    """Navigate through all index/listing pages and collect every transcript link."""
    all_urls = []
    current_url = f"{VEDABASE_BASE}/transcripts/"
    page_num = 0

    while current_url:
        page_num += 1
        log(f"  Index page {page_num}: {current_url}")
        page.goto(current_url, wait_until="domcontentloaded", timeout=30000)
        time.sleep(2)

        # Collect all transcript links on this page
        # Vedabase transcript links look like: /en/library/transcripts/XXXX/
        links = page.eval_on_selector_all(
            'a[href*="/library/transcripts/"]',
            """els => els.map(el => el.href).filter(h =>
                h.includes('/transcripts/') &&
                !h.endsWith('/transcripts/') &&
                !h.includes('?') &&
                h.split('/').filter(Boolean).length > 5
            )"""
        )

        new_links = [u for u in links if u not in all_urls]
        all_urls.extend(new_links)
        log(f"    Found {len(new_links)} new links (total: {len(all_urls)})")

        # Find "Next" pagination link
        next_link = page.eval_on_selector_all(
            'a[rel="next"], a:has-text("Next"), a:has-text("›"), .pagination a',
            "els => els.map(el => el.href)"
        )
        # Filter to actual next page
        next_url = None
        for nl in next_link:
            if nl and nl != current_url and "/transcripts/" in nl:
                next_url = nl
                break

        if next_url and next_url != current_url:
            current_url = next_url
            time.sleep(PAGE_DELAY_SECONDS)
        else:
            current_url = None  # No more pages

    # Deduplicate
    seen = set()
    unique = []
    for u in all_urls:
        normalized = u.rstrip("/")
        if normalized not in seen:
            seen.add(normalized)
            unique.append(u)
            
    return unique

# ─── Step 2: Scrape a single transcript page ───

def scrape_one_transcript(page: Page, url: str) -> dict | None:
    """Visit one transcript page, save raw HTML, extract text + metadata."""
    fname = safe_filename(url)

    for attempt in range(1, RETRY_COUNT + 1):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=30000)
            time.sleep(2)

            # Save raw HTML (insurance copy)
            raw_html = page.content()
            (TRANSCRIPTS_RAW_DIR / f"{fname}.html").write_text(raw_html, encoding="utf-8")

            # ── Extract title ──
            title = ""
            try:
                title = page.inner_text("h1").strip()
            except:
                try:
                    title = page.title().strip()
                except:
                    pass

            # ── Extract STRUCTURED metadata fields from page ──
            # Vedabase shows: Type, Dated, Location, Audio file as labeled fields
            # These appear as key-value pairs in the HTML
            meta_type = ""
            date_str = ""
            location = ""
            audio_file = ""
            scripture_ref = ""
            occasion = ""

            # Method 1: Look for labeled fields in the page text
            try:
                page_text = page.inner_text("body")

                # Extract "Type:" field
                type_match = re.search(r'Type:\s*(.+?)(?:\n|$)', page_text)
                if type_match:
                    meta_type = type_match.group(1).strip()

                # Extract "Dated:" field
                dated_match = re.search(r'Dated:\s*(.+?)(?:\n|$)', page_text)
                if dated_match:
                    date_str = dated_match.group(1).strip()

                # Extract "Location:" field
                loc_match = re.search(r'Location:\s*(.+?)(?:\n|$)', page_text)
                if loc_match:
                    location = loc_match.group(1).strip()

                # Extract "Audio file:" field
                audio_match = re.search(r'Audio file:\s*(.+?)(?:\n|$)', page_text)
                if audio_match:
                    audio_file = audio_match.group(1).strip()
            except:
                pass

            # Method 2: Also try extracting from structured HTML elements
            if not meta_type:
                try:
                    labels = page.query_selector_all('strong, b, .label, dt, th')
                    for label in labels:
                        text = label.inner_text().strip().lower()
                        if 'type' in text:
                            sibling = label.evaluate('el => el.nextSibling?.textContent || el.parentElement?.innerText || ""')
                            if sibling:
                                meta_type = sibling.replace("Type:", "").strip()
                        elif 'dated' in text:
                            sibling = label.evaluate('el => el.nextSibling?.textContent || el.parentElement?.innerText || ""')
                            if sibling and not date_str:
                                date_str = sibling.replace("Dated:", "").strip()
                        elif 'location' in text:
                            sibling = label.evaluate('el => el.nextSibling?.textContent || el.parentElement?.innerText || ""')
                            if sibling and not location:
                                location = sibling.replace("Location:", "").strip()
                        elif 'audio' in text:
                            sibling = label.evaluate('el => el.nextSibling?.textContent || el.parentElement?.innerText || ""')
                            if sibling and not audio_file:
                                audio_file = sibling.replace("Audio file:", "").strip()
                except:
                    pass

            # Set scripture_ref from type field
            if meta_type:
                scripture_ref = meta_type

            # Determine occasion from URL/title/type
            url_lower = url.lower()
            title_lower = title.lower()
            if "morning-walk" in url_lower or "morning walk" in title_lower:
                occasion = "Morning Walk"
            elif "room-conversation" in url_lower or "room conversation" in title_lower:
                occasion = "Room Conversation"
            elif "arrival" in url_lower:
                occasion = "Arrival Address"
            elif "initiation" in url_lower:
                occasion = "Initiation Lecture"
            elif "press-conference" in url_lower or "press conference" in title_lower:
                occasion = "Press Conference"
            elif "interview" in url_lower or "interview" in title_lower:
                occasion = "Interview"
            elif "garden-conversation" in url_lower:
                occasion = "Garden Conversation"
            else:
                occasion = "Lecture"

            # ── Parse date to ISO format ──
            # Handle formats: "February 19th 1966", "July 12th 1947", "January 1, 1972"
            date_iso = None
            if date_str:
                # Remove ordinal suffixes: 19th -> 19, 1st -> 1, 2nd -> 2, 3rd -> 3
                clean_date = re.sub(r'(\d+)(st|nd|rd|th)', r'\1', date_str)
                for fmt in ["%B %d %Y", "%B %d, %Y", "%d %B %Y", "%B %Y"]:
                    try:
                        parsed = datetime.strptime(clean_date.strip(), fmt)
                        date_iso = parsed.strftime("%Y-%m-%d")
                        break
                    except:
                        continue

            # ── Extract the main content body ──
            # Vedabase typically puts the transcript text BELOW the metadata fields
            body_text = ""
            selectors_to_try = [
                ".content-body",
                ".transcript-content",
                "article .content",
                ".r-text",
                "article",
                "main .container",
                "#content",
                "main",
            ]
            for sel in selectors_to_try:
                try:
                    el = page.query_selector(sel)
                    if el:
                        text = el.inner_text().strip()
                        if len(text) > 100:
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
                            clone.querySelectorAll('nav, footer, header, script, style, .navbar, .footer').forEach(e => e.remove());
                            return clone.innerText.trim();
                        }"""
                    )
                except:
                    pass

            # Remove the metadata section from body_text (Type:, Dated:, etc.)
            # so we keep only the actual transcript content
            if body_text:
                # Find where the actual transcript text starts (after metadata block)
                meta_end_patterns = [
                    r'Audio file:.*?\n',
                    r'Location:.*?\n',
                    r'Dated:.*?\n',
                ]
                for pat in meta_end_patterns:
                    match = re.search(pat, body_text)
                    if match:
                        # Content starts after the last metadata field
                        possible_start = match.end()
                        if possible_start < len(body_text) * 0.3:  # sanity check
                            body_text = body_text[possible_start:].strip()
                            break

            if not body_text or len(body_text) < 50:
                log(f"    WARNING: Very little text extracted from {url}")

            # ── Split body into paragraphs ──
            paragraphs = []
            for line in body_text.split("\n"):
                cleaned = line.strip()
                if cleaned and len(cleaned) > 20:
                    paragraphs.append(cleaned)

            # Build result
            result = {
                "vedabase_url": url,
                "title": title,
                "type": meta_type,
                "date": date_iso,
                "date_raw": date_str,
                "location": location,
                "scripture_ref": scripture_ref,
                "occasion": occasion,
                "body_text_full": body_text,
                "paragraphs": paragraphs,
                "paragraph_count": len(paragraphs),
                "char_count": len(body_text),
                "word_count": len(body_text.split()),
                "scraped_at": datetime.now().isoformat(),
            }

            # Save JSON
            json_path = TRANSCRIPTS_JSON_DIR / f"{fname}.json"
            json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")

            return result

        except PwTimeout:
            log(f"    Timeout attempt {attempt}/{RETRY_COUNT} for {url}")
            time.sleep(5 * attempt)
        except Exception as e:
            log(f"    Error attempt {attempt}/{RETRY_COUNT} for {url}: {str(e)[:200]}")
            time.sleep(5 * attempt)

    return None

# ─── Main ───

def main():
    log("=" * 60)
    log("TRANSCRIPT SCRAPER — Starting")
    log(f"Test mode: {TEST_MODE}")
    log("=" * 60)

    progress = load_progress()
    scraped_set = set(progress["scraped_urls"])

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=False,  # Visible browser to avoid bot detection
            slow_mo=500,     # Human-like speed
        )
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={"width": 1280, "height": 800},
        )
        page = context.new_page()

        # Step 1: Collect all URLs
        log("\n── Step 1: Collecting transcript URLs ──")
        all_urls = collect_transcript_urls(page)
        progress["total_found"] = len(all_urls)
        save_progress(progress)
        log(f"\nFound {len(all_urls)} total transcript URLs")

        # Filter out already-scraped
        to_scrape = [u for u in all_urls if u.rstrip("/") not in scraped_set]
        log(f"Already scraped: {len(scraped_set)} | Remaining: {len(to_scrape)}")

        if TEST_MODE:
            to_scrape = to_scrape[:5]
            log(f"TEST MODE: Only scraping {len(to_scrape)} pages")

        # Step 2: Scrape each page
        log("\n── Step 2: Scraping individual transcripts ──")
        success = 0
        failed = 0

        for i, url in enumerate(to_scrape):
            log(f"\n[{i+1}/{len(to_scrape)}] {url}")
            result = scrape_one_transcript(page, url)

            if result:
                success += 1
                progress["scraped_urls"].append(url.rstrip("/"))
                log(f"  ✓ {result['title'][:60]} | {result['paragraph_count']} paragraphs | {result['word_count']} words")
            else:
                failed += 1
                progress["failed_urls"].append(url)
                log(f"  ✗ FAILED after {RETRY_COUNT} attempts")

            save_progress(progress)
            time.sleep(PAGE_DELAY_SECONDS)

        browser.close()

    # Summary
    log("\n" + "=" * 60)
    log(f"DONE | ✓ {success} scraped | ✗ {failed} failed | Total on disk: {len(progress['scraped_urls'])}")
    log(f"JSON files: {TRANSCRIPTS_JSON_DIR}")
    log(f"Raw HTML:   {TRANSCRIPTS_RAW_DIR}")
    log("=" * 60)

    # Save final URL list for validation
    url_list_path = LOGS_DIR / "transcript_urls_found.json"
    url_list_path.write_text(json.dumps(all_urls, indent=2), encoding="utf-8")

if __name__ == "__main__":
    main()
