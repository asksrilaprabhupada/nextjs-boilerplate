#!/usr/bin/env python3
"""
============================================================
IMPORT TO SUPABASE - Uploads verse data from merged JSON
============================================================
"""

import json
import os
import sys
from supabase import create_client
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY


MERGED_DIR = "merged"
BATCH_SIZE = 200


def import_all():
    print("Connecting to Supabase...")
    try:
        supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
        print("  Connected!")
    except Exception as e:
        print(f"  ERROR: {e}")
        print(f"  Check your config.py credentials.")
        sys.exit(1)

    try:
        supabase.table("chapters").select("id").limit(1).execute()
        print("  Tables found!")
    except Exception as e:
        print(f"  ERROR: Tables not found. Run SQL first.")
        sys.exit(1)

    files_to_import = [
        ("bhagavad_gita.json", "Bhagavad Gita"),
        ("srimad_bhagavatam.json", "Srimad Bhagavatam"),
        ("chaitanya_charitamrita.json", "Chaitanya Charitamrita"),
    ]

    total_chapters = 0
    total_verses = 0

    for filename, display_name in files_to_import:
        filepath = os.path.join(MERGED_DIR, filename)

        if not os.path.exists(filepath):
            print(f"\n  SKIPPING {display_name} - file not found")
            continue

        print(f"\nIMPORTING: {display_name}")

        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)

        chapters = data["chapters"]

        for ch_data in chapters:
            chapter_row = {
                "scripture": ch_data["scripture"],
                "canto_or_division": ch_data.get("canto_or_division"),
                "chapter_number": ch_data["chapter_number"],
                "chapter_title": ch_data.get("chapter_title", ""),
                "total_verses": len(ch_data.get("verses", [])),
                "vedabase_url": ch_data.get("vedabase_url", ""),
            }

            try:
                result = supabase.table("chapters").insert(chapter_row).execute()
                chapter_id = result.data[0]["id"]
            except Exception as e:
                print(f"  ERROR chapter: {e}")
                continue

            total_chapters += 1

            verse_rows = []
            for v in ch_data.get("verses", []):
                verse_rows.append({
                    "chapter_id": chapter_id,
                    "scripture": ch_data["scripture"],
                    "verse_number": v.get("verse_number", ""),
                    "sanskrit_devanagari": v.get("sanskrit_devanagari", ""),
                    "transliteration": v.get("transliteration", ""),
                    "synonyms": v.get("synonyms", ""),
                    "translation": v.get("translation", ""),
                    "purport": v.get("purport", ""),
                    "vedabase_url": v.get("vedabase_url", ""),
                })

            for i in range(0, len(verse_rows), BATCH_SIZE):
                batch = verse_rows[i:i + BATCH_SIZE]
                try:
                    supabase.table("verses").insert(batch).execute()
                    total_verses += len(batch)
                except Exception as e:
                    print(f"  ERROR batch: {e}")

            div = ch_data.get("canto_or_division", "")
            div_str = f" {div}." if div else " "
            print(f"  {ch_data['scripture']}{div_str}{ch_data['chapter_number']}"
                  f" > {len(verse_rows)} verses done")

    print(f"\nIMPORT COMPLETE")
    print(f"  Chapters: {total_chapters}")
    print(f"  Verses:   {total_verses}")


def verify():
    supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    print("\n--- VERIFICATION ---")
    for s in ["BG", "SB", "CC"]:
        r = supabase.table("verses").select("id", count="exact").eq("scripture", s).execute()
        print(f"  {s}: {r.count} verses")


if __name__ == "__main__":
    import_all()
    verify()
