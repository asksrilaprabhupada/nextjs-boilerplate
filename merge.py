#!/usr/bin/env python3
"""
============================================================
MERGE - Combines chapter JSON files into 3 master files
============================================================
"""

import json
import os
from pathlib import Path


RAW_DATA_DIR = "raw_data"
MERGED_DIR = "merged"


def merge():
    Path(MERGED_DIR).mkdir(exist_ok=True)

    files = sorted([
        f for f in os.listdir(RAW_DATA_DIR)
        if f.endswith(".json") and not f.startswith("DEBUG")
    ])

    if not files:
        print("ERROR: No JSON files in raw_data/. Run scraper.py first!")
        return

    print(f"Found {len(files)} chapter files")

    scriptures = {"BG": [], "SB": [], "CC": []}
    total_verses = 0

    for filename in files:
        filepath = os.path.join(RAW_DATA_DIR, filename)
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        scripture = data["scripture"]
        total_verses += len(data.get("verses", []))
        scriptures[scripture].append(data)

    for key in scriptures:
        scriptures[key].sort(key=lambda x: (
            x.get("canto_or_division") or "", x["chapter_number"]
        ))

    output_map = {
        "BG": "bhagavad_gita.json",
        "SB": "srimad_bhagavatam.json",
        "CC": "chaitanya_charitamrita.json"
    }

    for key, filename in output_map.items():
        chapters = scriptures[key]
        v_count = sum(len(ch.get("verses", [])) for ch in chapters)
        merged = {
            "scripture": key,
            "total_chapters": len(chapters),
            "total_verses": v_count,
            "chapters": chapters
        }
        filepath = os.path.join(MERGED_DIR, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(merged, f, ensure_ascii=False, indent=2)
        print(f"  {key}: {len(chapters)} chapters, {v_count} verses")

    print(f"\nTOTAL: {total_verses} verses")
    print(f"\nNext: python import_to_supabase.py")


if __name__ == "__main__":
    merge()
