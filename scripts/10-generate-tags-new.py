"""
10-generate-tags-new.py — Generate Tags for Transcripts & Letters

Uses Gemini Flash Lite to generate topic tags, questions, and summaries
for transcript_paragraphs and letter_paragraphs tables.

Usage:
  python scripts/10-generate-tags-new.py transcripts
  python scripts/10-generate-tags-new.py letters
  python scripts/10-generate-tags-new.py all
  python scripts/10-generate-tags-new.py --test transcripts
"""
import json
import sys
import time
import requests
from datetime import datetime
from supabase import create_client

from config import (
    SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY, LOGS_DIR,
)

TARGET = [a for a in sys.argv[1:] if not a.startswith("--")]
TARGET = TARGET[0] if TARGET else "all"
TEST_MODE = "--test" in sys.argv
LOG_FILE = LOGS_DIR / f"tags_{TARGET}.log"

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

GEMINI_MODEL = "gemini-2.5-flash-lite"
GEMINI_URL = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent"

BATCH_SIZE = 50
BATCH_DELAY = 1.5
start_time = time.time()


def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def elapsed():
    return f"{(time.time() - start_time) / 60:.1f}m"


def call_gemini(prompt: str) -> str:
    for attempt in range(1, 4):
        try:
            resp = requests.post(
                f"{GEMINI_URL}?key={GEMINI_API_KEY}",
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.2,
                        "maxOutputTokens": 4096,
                        "responseMimeType": "application/json",
                    },
                },
                timeout=30,
            )
            if resp.status_code in (429, 503) and attempt < 3:
                time.sleep(3 * attempt)
                continue
            resp.raise_for_status()
            data = resp.json()
            return data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text", "")
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(3 * attempt)
    return ""


def extract_json(raw: str) -> dict | None:
    if not raw:
        return None
    cleaned = raw.strip().replace("```json", "").replace("```", "").strip()
    first = cleaned.find("{")
    last = cleaned.rfind("}")
    if first == -1 or last == -1:
        return None
    cleaned = cleaned[first:last + 1].replace(",}", "}").replace(",]", "]")
    try:
        return json.loads(cleaned)
    except:
        return None


def build_tags(parsed: dict) -> list[str]:
    tags = []
    if isinstance(parsed.get("topics"), list):
        tags.extend([t for t in parsed["topics"] if isinstance(t, str)])
    if isinstance(parsed.get("sanskrit_terms"), list):
        tags.extend([t for t in parsed["sanskrit_terms"] if isinstance(t, str)])
    if isinstance(parsed.get("questions"), list):
        tags.extend([t for t in parsed["questions"] if isinstance(t, str)])
    if isinstance(parsed.get("summary"), str) and parsed["summary"]:
        tags.append("SUMMARY: " + parsed["summary"])
    return tags


def tag_one_row(table: str, row_id: str, body_text: str, context: str) -> bool:
    excerpt = (body_text or "")[:800]
    if len(excerpt) < 30:
        return False

    prompt = f"""You are an expert on Srila Prabhupada's teachings and ISKCON devotee culture.

Read this passage from {context}.

Text: "{excerpt}"

Return a JSON object with these fields:
{{
  "topics": ["10-15 English search terms a devotee might type to find this passage"],
  "sanskrit_terms": ["5-8 relevant Sanskrit terms with and without diacritics"],
  "questions": ["3-5 questions a devotee might ask that this passage answers"],
  "summary": "1-2 sentence summary of the key teaching"
}}"""

    for attempt in range(1, 3):
        try:
            raw = call_gemini(prompt)
            parsed = extract_json(raw)
            if parsed:
                tags = build_tags(parsed)
                if tags:
                    supabase.table(table).update({"tags": tags}).eq("id", row_id).execute()
                    return True
            if attempt == 1:
                time.sleep(1)
        except Exception as e:
            if attempt == 1:
                time.sleep(2)
    return False


def process_table(table: str, parent_table: str, parent_fk: str):
    log(f"\n=== Processing {table} ===")

    # Fetch rows needing tags
    all_ids = []
    offset = 0
    while True:
        result = (
            supabase.table(table)
            .select("id")
            .or_("tags.is.null,tags.eq.{}")
            .range(offset, offset + 999)
            .execute()
        )
        if not result.data:
            break
        all_ids.extend([r["id"] for r in result.data])
        if len(result.data) < 1000:
            break
        offset += 1000

    if TEST_MODE:
        all_ids = all_ids[:10]

    total = len(all_ids)
    log(f"Found {total} rows needing tags")
    if total == 0:
        return

    done = 0
    errors = 0

    for i in range(0, total, BATCH_SIZE):
        batch_ids = all_ids[i:i + BATCH_SIZE]

        # Fetch row data
        rows = supabase.table(table).select(f"id, body_text, {parent_fk}").in_("id", batch_ids).execute()
        if not rows.data:
            errors += len(batch_ids)
            continue

        # Get parent metadata for context
        parent_ids = list(set(r[parent_fk] for r in rows.data if r.get(parent_fk)))
        parent_map = {}
        if parent_ids:
            parents = supabase.table(parent_table).select("id, *").in_("id", parent_ids[:50]).execute()
            if parents.data:
                parent_map = {p["id"]: p for p in parents.data}

        for row in rows.data:
            parent = parent_map.get(row.get(parent_fk), {})
            if parent_table == "transcripts":
                context = f"a lecture by Srila Prabhupada: {parent.get('title', 'Unknown')}"
            else:
                context = f"a letter by Srila Prabhupada to {parent.get('recipient', 'Unknown')}"

            if tag_one_row(table, row["id"], row["body_text"], context):
                done += 1
            else:
                errors += 1

        # Progress
        if done > 0:
            mins = (time.time() - start_time) / 60
            rate = done / mins if mins > 0.1 else 0
            eta = (total - done) / rate if rate > 0 else 0
            log(f"  {done}/{total} ({done/total*100:.1f}%) | {errors} err | {rate:.0f}/min | ~{eta:.0f}min | {elapsed()}")

        time.sleep(BATCH_DELAY)

    log(f"\n{table}: {done} tagged, {errors} errors | {elapsed()}")


def main():
    log("=" * 60)
    log(f"TAG GENERATION — Target: {TARGET} | Test: {TEST_MODE}")
    log("=" * 60)

    if TARGET in ("transcripts", "all"):
        process_table("transcript_paragraphs", "transcripts", "transcript_id")
    if TARGET in ("letters", "all"):
        process_table("letter_paragraphs", "letters", "letter_id")

    log(f"\n=== ALL DONE === | {elapsed()}")


if __name__ == "__main__":
    main()
