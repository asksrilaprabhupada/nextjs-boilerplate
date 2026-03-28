"""
09-generate-embeddings-new.py — Generate Embeddings for Transcripts & Letters

Same batch approach as 01-generate-embeddings.ts but in Python,
targeting transcript_paragraphs and letter_paragraphs tables.

Usage:
  python scripts/09-generate-embeddings-new.py transcripts
  python scripts/09-generate-embeddings-new.py letters
  python scripts/09-generate-embeddings-new.py all
"""
import json
import sys
import time
import requests
from datetime import datetime
from supabase import create_client

from config import (
    SUPABASE_URL, SUPABASE_SERVICE_KEY, GEMINI_API_KEY,
    LOGS_DIR, BATCH_SIZE_EMBED,
)

TARGET = sys.argv[1] if len(sys.argv) > 1 else "all"
LOG_FILE = LOGS_DIR / f"embeddings_{TARGET}.log"

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

BATCH_EMBED_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2-preview:batchEmbedContents"
EXPECTED_DIMS = 1536
BATCH_DELAY_MS = 0.3

start_time = time.time()

def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")

def elapsed():
    return f"{(time.time() - start_time) / 60:.1f}m"

def batch_embed(texts: list[str]) -> list[list[float]]:
    """Send N texts to Gemini, get N embeddings back in 1 API call."""
    requests_body = [{
        "model": "models/gemini-embedding-2-preview",
        "content": {"parts": [{"text": t}]},
        "outputDimensionality": EXPECTED_DIMS,
        "taskType": "RETRIEVAL_DOCUMENT",
    } for t in texts]

    for attempt in range(1, 4):
        try:
            resp = requests.post(
                f"{BATCH_EMBED_URL}?key={GEMINI_API_KEY}",
                json={"requests": requests_body},
                timeout=60,
            )
            if resp.status_code in (429, 503) and attempt < 3:
                log(f"  Rate limited ({resp.status_code}), waiting {3*attempt}s...")
                time.sleep(3 * attempt)
                continue
            resp.raise_for_status()
            data = resp.json()
            embeddings = [e["values"] for e in data.get("embeddings", [])]
            if len(embeddings) != len(texts):
                raise ValueError(f"Expected {len(texts)} embeddings, got {len(embeddings)}")
            return embeddings
        except Exception as e:
            if attempt == 3:
                raise
            time.sleep(3 * attempt)
    return []

def process_table(table_name: str):
    log(f"\n=== Processing {table_name} ===")

    # Fetch IDs with null embeddings
    all_ids = []
    offset = 0
    while True:
        result = supabase.rpc("fetch_null_embedding_ids_v2", {
            "p_table": table_name,
            "p_limit": 1000,
            "p_offset": offset,
        }).execute()
        if not result.data:
            break
        all_ids.extend([r["id"] for r in result.data])
        if len(result.data) < 1000:
            break
        offset += 1000

    total = len(all_ids)
    log(f"Found {total} rows needing embeddings")
    if total == 0:
        return

    done = 0
    errors = 0

    for i in range(0, total, BATCH_SIZE_EMBED):
        batch_ids = all_ids[i:i + BATCH_SIZE_EMBED]

        try:
            # Fetch text content
            rows = supabase.table(table_name).select("id, body_text").in_("id", batch_ids).execute()
            if not rows.data:
                errors += len(batch_ids)
                continue

            # Build texts for embedding
            ordered_ids = [r["id"] for r in rows.data]
            texts = [f"{(r['body_text'] or '')[:1200]}" for r in rows.data]

            # Batch embed
            embeddings = batch_embed(texts)

            # Batch write to DB
            emb_strings = [f"[{','.join(str(v) for v in emb)}]" for emb in embeddings]
            written = supabase.rpc("batch_set_embeddings_v2", {
                "p_table": table_name,
                "p_ids": ordered_ids,
                "p_embeddings": emb_strings,
            }).execute()

            done += len(ordered_ids)

        except Exception as e:
            errors += len(batch_ids)
            log(f"  Batch error: {str(e)[:200]}")

        # Progress
        if done > 0:
            mins = (time.time() - start_time) / 60
            rate = done / mins if mins > 0.1 else 0
            eta = (total - done) / rate if rate > 0 else 0
            log(f"  {done}/{total} ({done/total*100:.1f}%) | {errors} err | {rate:.0f}/min | ~{eta:.0f}min | {elapsed()}")

        time.sleep(BATCH_DELAY_MS)

    log(f"\n{table_name}: {done} done, {errors} errors | {elapsed()}")

def main():
    log("=" * 60)
    log(f"EMBEDDING GENERATION — Target: {TARGET}")
    log("=" * 60)

    if TARGET in ("transcripts", "all"):
        process_table("transcript_paragraphs")
    if TARGET in ("letters", "all"):
        process_table("letter_paragraphs")

    log(f"\n=== ALL DONE === | {elapsed()}")

if __name__ == "__main__":
    main()
