# ============================================================
# URL MAP - All vedabase.io advanced-view chapter URLs
# ============================================================
# BG:  18 chapters
# SB:  12 cantos, ~335 chapters total
# CC:  3 divisions (adi, madhya, antya), ~62 chapters total
# TOTAL: ~415 chapter pages
# ============================================================


def get_all_urls():
    """Returns list of dicts with scripture, division, chapter, url"""
    urls = []

    # --- BHAGAVAD GITA: 18 chapters ---
    for ch in range(1, 19):
        urls.append({
            "scripture": "BG",
            "canto_or_division": None,
            "chapter_number": ch,
            "url": f"https://vedabase.io/en/library/bg/{ch}/advanced-view/"
        })

    # --- SRIMAD BHAGAVATAM: 12 cantos ---
    sb_chapters = {
        1: 19, 2: 10, 3: 33, 4: 31, 5: 26, 6: 19,
        7: 15, 8: 24, 9: 24, 10: 90, 11: 31, 12: 13
    }
    for canto, num_chapters in sb_chapters.items():
        for ch in range(1, num_chapters + 1):
            urls.append({
                "scripture": "SB",
                "canto_or_division": str(canto),
                "chapter_number": ch,
                "url": f"https://vedabase.io/en/library/sb/{canto}/{ch}/advanced-view/"
            })

    # --- CHAITANYA CHARITAMRITA: 3 divisions ---
    cc_chapters = {
        "adi": 17,
        "madhya": 25,
        "antya": 20
    }
    for division, num_chapters in cc_chapters.items():
        for ch in range(1, num_chapters + 1):
            urls.append({
                "scripture": "CC",
                "canto_or_division": division,
                "chapter_number": ch,
                "url": f"https://vedabase.io/en/library/cc/{division}/{ch}/advanced-view/"
            })

    return urls


if __name__ == "__main__":
    urls = get_all_urls()
    print(f"Total chapter URLs: {len(urls)}")
    print(f"  BG:  {sum(1 for u in urls if u['scripture'] == 'BG')} chapters")
    print(f"  SB:  {sum(1 for u in urls if u['scripture'] == 'SB')} chapters")
    print(f"  CC:  {sum(1 for u in urls if u['scripture'] == 'CC')} chapters")
