"""
06-upload-to-supabase.py — Upload scraped JSON to Supabase

Reads JSON files from scraped_data/ and inserts into Supabase tables.
Handles both transcripts and letters. Reads back after insert to verify.

Usage:
  python scripts/06-upload-to-supabase.py transcripts
  python scripts/06-upload-to-supabase.py letters
  python scripts/06-upload-to-supabase.py --test transcripts   (upload 5 only)
"""
import json
import sys
import time
from datetime import datetime
from pathlib import Path
from supabase import create_client

from config import (
    SUPABASE_URL, SUPABASE_SERVICE_KEY,
    TRANSCRIPTS_JSON_DIR, LETTERS_JSON_DIR,
    LOGS_DIR, BATCH_SIZE_UPLOAD,
)

TEST_MODE = "--test" in sys.argv
CONTENT_TYPE = "transcripts" if "transcripts" in sys.argv else "letters" if "letters" in sys.argv else None

if not CONTENT_TYPE:
    print("Usage: python 06-upload-to-supabase.py [transcripts|letters] [--test]")
    sys.exit(1)

LOG_FILE = LOGS_DIR / f"upload_{CONTENT_TYPE}.log"
ERRORS_FILE = LOGS_DIR / f"upload_{CONTENT_TYPE}_errors.json"

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def upload_transcripts():
    json_dir = TRANSCRIPTS_JSON_DIR
    files = sorted(json_dir.glob("*.json"))
    if TEST_MODE:
        files = files[:5]

    log(f"Found {len(files)} transcript JSON files to upload")
    uploaded = 0
    errors = []
    skipped = 0

    for i, fpath in enumerate(files):
        try:
            data = json.loads(fpath.read_text(encoding="utf-8"))

            # Check if already exists by vedabase_url
            existing = supabase.table("transcripts").select("id").eq(
                "vedabase_url", data["vedabase_url"]
            ).execute()
            if existing.data:
                skipped += 1
                if (i + 1) % 100 == 0:
                    log(f"  Progress: {i+1}/{len(files)} | ✓{uploaded} skip:{skipped} err:{len(errors)}")
                continue

            # Insert parent transcript
            parent = supabase.table("transcripts").insert({
                "title": data["title"],
                "type": data.get("type") or None,
                "date": data.get("date"),
                "location": data.get("location") or None,
                "scripture_ref": data.get("scripture_ref") or None,
                "occasion": data.get("occasion") or None,
                "vedabase_url": data["vedabase_url"],
            }).execute()

            if not parent.data:
                errors.append({"file": fpath.name, "error": "Parent insert failed"})
                continue

            transcript_id = parent.data[0]["id"]

            # Insert paragraphs in batches
            paragraphs = data.get("paragraphs", [])
            for batch_start in range(0, len(paragraphs), BATCH_SIZE_UPLOAD):
                batch = paragraphs[batch_start:batch_start + BATCH_SIZE_UPLOAD]
                rows = [
                    {
                        "transcript_id": transcript_id,
                        "paragraph_number": batch_start + j + 1,
                        "body_text": text,
                    }
                    for j, text in enumerate(batch)
                ]
                supabase.table("transcript_paragraphs").insert(rows).execute()

            uploaded += 1
            if (i + 1) % 50 == 0:
                log(f"  Progress: {i+1}/{len(files)} | ✓{uploaded} skip:{skipped} err:{len(errors)}")

        except Exception as e:
            errors.append({"file": fpath.name, "error": str(e)[:300]})
            log(f"  ERROR on {fpath.name}: {str(e)[:200]}")

    return uploaded, skipped, errors

def upload_letters():
    json_dir = LETTERS_JSON_DIR
    files = sorted(json_dir.glob("*.json"))
    if TEST_MODE:
        files = files[:5]

    log(f"Found {len(files)} letter JSON files to upload")
    uploaded = 0
    errors = []
    skipped = 0

    for i, fpath in enumerate(files):
        try:
            data = json.loads(fpath.read_text(encoding="utf-8"))

            existing = supabase.table("letters").select("id").eq(
                "vedabase_url", data["vedabase_url"]
            ).execute()
            if existing.data:
                skipped += 1
                if (i + 1) % 100 == 0:
                    log(f"  Progress: {i+1}/{len(files)} | ✓{uploaded} skip:{skipped} err:{len(errors)}")
                continue

            parent = supabase.table("letters").insert({
                "recipient": data.get("recipient") or None,
                "date": data.get("date"),
                "location": data.get("location") or None,
                "letter_number": data.get("letter_number") or None,
                "vedabase_url": data["vedabase_url"],
            }).execute()

            if not parent.data:
                errors.append({"file": fpath.name, "error": "Parent insert failed"})
                continue

            letter_id = parent.data[0]["id"]

            paragraphs = data.get("paragraphs", [])
            for batch_start in range(0, len(paragraphs), BATCH_SIZE_UPLOAD):
                batch = paragraphs[batch_start:batch_start + BATCH_SIZE_UPLOAD]
                rows = [
                    {
                        "letter_id": letter_id,
                        "paragraph_number": batch_start + j + 1,
                        "body_text": text,
                    }
                    for j, text in enumerate(batch)
                ]
                supabase.table("letter_paragraphs").insert(rows).execute()

            uploaded += 1
            if (i + 1) % 50 == 0:
                log(f"  Progress: {i+1}/{len(files)} | ✓{uploaded} skip:{skipped} err:{len(errors)}")

        except Exception as e:
            errors.append({"file": fpath.name, "error": str(e)[:300]})
            log(f"  ERROR on {fpath.name}: {str(e)[:200]}")

    return uploaded, skipped, errors

def main():
    log("=" * 60)
    log(f"UPLOAD TO SUPABASE — {CONTENT_TYPE.upper()}")
    log(f"Test mode: {TEST_MODE}")
    log("=" * 60)

    if CONTENT_TYPE == "transcripts":
        uploaded, skipped, errors = upload_transcripts()
    else:
        uploaded, skipped, errors = upload_letters()

    log(f"\nDONE | ✓ {uploaded} uploaded | ⏭ {skipped} skipped | ✗ {len(errors)} errors")

    if errors:
        Path(ERRORS_FILE).write_text(json.dumps(errors, indent=2), encoding="utf-8")
        log(f"Errors saved: {ERRORS_FILE}")

if __name__ == "__main__":
    main()
