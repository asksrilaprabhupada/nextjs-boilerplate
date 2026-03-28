"""
07-download-and-extract-ebooks.py — Download PDFs + Extract Text

Downloads missing Prabhupada ebooks from ISKCON Desire Tree,
extracts text using pdfplumber, saves as JSON ready for upload.

Usage:
  python scripts/07-download-and-extract-ebooks.py
  python scripts/07-download-and-extract-ebooks.py --test   (1 book only)
"""
import json
import re
import sys
import time
import requests
import pdfplumber
from datetime import datetime
from pathlib import Path

from config import (
    EBOOKS_PDF_DIR, EBOOKS_JSON_DIR, LOGS_DIR, MISSING_EBOOKS,
)

TEST_MODE = "--test" in sys.argv
LOG_FILE = LOGS_DIR / "ebooks.log"

def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def download_pdf(slug: str, url: str) -> Path | None:
    """Download a PDF file if not already on disk."""
    pdf_path = EBOOKS_PDF_DIR / f"{slug}.pdf"
    if pdf_path.exists() and pdf_path.stat().st_size > 1000:
        log(f"  Already downloaded: {pdf_path.name}")
        return pdf_path

    try:
        log(f"  Downloading {url}...")
        resp = requests.get(url, timeout=120, stream=True)
        resp.raise_for_status()
        with open(pdf_path, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        log(f"  ✓ Saved {pdf_path.name} ({pdf_path.stat().st_size / 1024:.0f} KB)")
        return pdf_path
    except Exception as e:
        log(f"  ✗ Download failed: {str(e)[:200]}")
        return None

def extract_pdf_text(pdf_path: Path) -> list[dict]:
    """Extract text from PDF, page by page. Returns list of page dicts."""
    pages = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for i, page in enumerate(pdf.pages):
                text = page.extract_text() or ""
                text = text.strip()
                if text and len(text) > 30:
                    pages.append({
                        "page_number": i + 1,
                        "text": text,
                        "char_count": len(text),
                    })
    except Exception as e:
        log(f"  ✗ PDF extraction error: {str(e)[:200]}")
    return pages

def split_into_paragraphs(pages: list[dict]) -> list[str]:
    """Combine all page text and split into meaningful paragraphs."""
    full_text = "\n\n".join(p["text"] for p in pages)

    # Split by double newlines (paragraph boundaries)
    raw_paragraphs = re.split(r'\n\s*\n', full_text)

    paragraphs = []
    for para in raw_paragraphs:
        cleaned = para.strip()
        # Skip very short lines (page numbers, headers, etc.)
        if len(cleaned) < 40:
            continue
        # Skip lines that are just numbers (page numbers)
        if re.match(r'^\d+$', cleaned):
            continue
        paragraphs.append(cleaned)

    return paragraphs

def detect_chapters(paragraphs: list[str]) -> list[dict]:
    """Try to detect chapter boundaries from the text."""
    chapters = []
    current_chapter = {"title": "Introduction", "number": 0, "paragraphs": []}

    chapter_patterns = [
        r'^CHAPTER\s+(\d+)',
        r'^Chapter\s+(\d+)',
        r'^(\d+)\.\s+[A-Z]',  # "1. The Science of..."
        r'^Part\s+(\d+)',
    ]

    for para in paragraphs:
        is_chapter_heading = False
        for pattern in chapter_patterns:
            match = re.match(pattern, para)
            if match:
                # Save current chapter
                if current_chapter["paragraphs"]:
                    chapters.append(current_chapter)
                # Start new chapter
                chapter_num = int(match.group(1))
                current_chapter = {
                    "title": para[:100],
                    "number": chapter_num,
                    "paragraphs": [],
                }
                is_chapter_heading = True
                break

        if not is_chapter_heading:
            current_chapter["paragraphs"].append(para)

    # Don't forget the last chapter
    if current_chapter["paragraphs"]:
        chapters.append(current_chapter)

    # If no chapters detected, treat entire book as one chapter
    if len(chapters) <= 1:
        return [{"title": "Full Text", "number": 1, "paragraphs": paragraphs}]

    return chapters

def main():
    log("=" * 60)
    log("EBOOK DOWNLOADER + EXTRACTOR")
    log(f"Books to process: {len(MISSING_EBOOKS)}")
    log(f"Test mode: {TEST_MODE}")
    log("=" * 60)

    books_to_process = dict(list(MISSING_EBOOKS.items())[:1]) if TEST_MODE else MISSING_EBOOKS
    success = 0
    failed = 0

    for slug, info in books_to_process.items():
        log(f"\n── {info['title']} ({slug}) ──")

        # Download
        pdf_path = download_pdf(slug, info["url"])
        if not pdf_path:
            failed += 1
            continue

        # Extract pages
        pages = extract_pdf_text(pdf_path)
        log(f"  Extracted {len(pages)} pages with text")

        if not pages:
            log(f"  ✗ No text extracted — may be scanned PDF (needs OCR)")
            failed += 1
            continue

        # Split into paragraphs
        paragraphs = split_into_paragraphs(pages)
        log(f"  Split into {len(paragraphs)} paragraphs")

        # Detect chapters
        chapters = detect_chapters(paragraphs)
        log(f"  Detected {len(chapters)} chapters")

        # Save as JSON
        result = {
            "slug": slug,
            "title": info["title"],
            "source_url": info["url"],
            "total_pages": len(pages),
            "total_paragraphs": len(paragraphs),
            "total_chars": sum(len(p) for p in paragraphs),
            "total_words": sum(len(p.split()) for p in paragraphs),
            "chapters": chapters,
            "extracted_at": datetime.now().isoformat(),
        }

        json_path = EBOOKS_JSON_DIR / f"{slug}.json"
        json_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"  ✓ Saved {json_path.name} | {result['total_paragraphs']} para | {result['total_words']} words")
        success += 1

    log(f"\n{'='*60}")
    log(f"DONE | ✓ {success} books | ✗ {failed} failed")
    log(f"PDFs: {EBOOKS_PDF_DIR}")
    log(f"JSON: {EBOOKS_JSON_DIR}")

if __name__ == "__main__":
    main()
