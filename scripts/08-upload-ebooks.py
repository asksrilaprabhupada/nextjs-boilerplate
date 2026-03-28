"""
08-upload-ebooks.py — Upload extracted ebook JSON to Supabase

Reads ebook JSON files and inserts into existing books, chapters,
and prose_paragraphs tables (same schema as existing 27 books).

Usage:
  python scripts/08-upload-ebooks.py
  python scripts/08-upload-ebooks.py --test
"""
import json
import sys
from datetime import datetime
from pathlib import Path
from supabase import create_client

from config import (
    SUPABASE_URL, SUPABASE_SERVICE_KEY,
    EBOOKS_JSON_DIR, LOGS_DIR, MISSING_EBOOKS,
)

TEST_MODE = "--test" in sys.argv
LOG_FILE = LOGS_DIR / "upload_ebooks.log"

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def upload_one_book(slug: str, data: dict) -> bool:
    title = data["title"]

    # Check if book already exists
    existing = supabase.table("books").select("id").eq("slug", slug).execute()
    if existing.data:
        log(f"  Book '{slug}' already exists in Supabase — skipping")
        return True

    # Insert book
    book_result = supabase.table("books").insert({
        "title": title,
        "slug": slug,
        "content_type": "prose_book",
        "author": "A.C. Bhaktivedanta Swami Prabhupada",
        "total_chapters": len(data.get("chapters", [])),
    }).execute()

    if not book_result.data:
        log(f"  ✗ Failed to insert book '{slug}'")
        return False

    # Insert chapters and paragraphs
    total_paras = 0
    for ch in data.get("chapters", []):
        chapter_result = supabase.table("chapters").insert({
            "scripture": slug.upper(),
            "chapter_number": ch["number"],
            "chapter_title": ch.get("title", ""),
            "book_slug": slug,
            "total_verses": len(ch.get("paragraphs", [])),
        }).execute()

        if not chapter_result.data:
            log(f"  ✗ Failed to insert chapter {ch['number']}")
            continue

        chapter_id = chapter_result.data[0]["id"]

        # Insert paragraphs in batches of 50
        paragraphs = ch.get("paragraphs", [])
        for batch_start in range(0, len(paragraphs), 50):
            batch = paragraphs[batch_start:batch_start + 50]
            rows = [
                {
                    "chapter_id": chapter_id,
                    "book_slug": slug,
                    "paragraph_number": batch_start + j + 1,
                    "body_text": text,
                }
                for j, text in enumerate(batch)
            ]
            supabase.table("prose_paragraphs").insert(rows).execute()
            total_paras += len(batch)

    log(f"  ✓ {title}: {len(data.get('chapters', []))} chapters, {total_paras} paragraphs")
    return True

def main():
    log("=" * 60)
    log("EBOOK UPLOAD TO SUPABASE")
    log("=" * 60)

    files = sorted(EBOOKS_JSON_DIR.glob("*.json"))
    if TEST_MODE:
        files = files[:1]

    log(f"Found {len(files)} ebook JSON files")
    success = 0
    failed = 0

    for fpath in files:
        slug = fpath.stem
        log(f"\n── {slug} ──")
        try:
            data = json.loads(fpath.read_text(encoding="utf-8"))
            if upload_one_book(slug, data):
                success += 1
            else:
                failed += 1
        except Exception as e:
            log(f"  ✗ Error: {str(e)[:200]}")
            failed += 1

    log(f"\nDONE | ✓ {success} | ✗ {failed}")

if __name__ == "__main__":
    main()
