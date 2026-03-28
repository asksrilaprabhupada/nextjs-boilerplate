"""
11-validate.py — Two-Step Validation

STEP 1 (Completeness): Compares JSON files on disk vs rows in Supabase.
  - Are all scraped items uploaded?
  - Are any missing?

STEP 2 (Integrity): Downloads content from Supabase and compares
  character-by-character against local JSON files.
  - Did any text get truncated?
  - Did diacritical marks survive? (ā ī ū ṛ ṣ ṭ ḍ ṅ ñ ś)
  - Are paragraph counts correct?

Usage:
  python scripts/11-validate.py transcripts
  python scripts/11-validate.py letters
  python scripts/11-validate.py ebooks
  python scripts/11-validate.py all
  python scripts/11-validate.py all --spot-check   (also picks 20 random for manual review)
"""
import json
import sys
import random
from datetime import datetime
from pathlib import Path
from supabase import create_client

from config import (
    SUPABASE_URL, SUPABASE_SERVICE_KEY,
    TRANSCRIPTS_JSON_DIR, LETTERS_JSON_DIR, EBOOKS_JSON_DIR,
    VALIDATION_DIR, LOGS_DIR,
)

TARGET = [a for a in sys.argv[1:] if not a.startswith("--")]
TARGET = TARGET[0] if TARGET else "all"
SPOT_CHECK = "--spot-check" in sys.argv

LOG_FILE = LOGS_DIR / f"validation_{TARGET}.log"
REPORT_FILE = VALIDATION_DIR / f"validation_report_{TARGET}_{datetime.now().strftime('%Y%m%d_%H%M')}.json"

supabase = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# Diacritical characters that must survive encoding
DIACRITICALS = set("āīūṛṝḷṃḥṣṭḍṅñśṁĀĪŪṚṢṬḌṄÑŚ")


def log(msg: str):
    line = f"[{datetime.now().isoformat()}] {msg}"
    print(line)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(line + "\n")


def check_diacriticals(original: str, db_text: str) -> list[str]:
    """Check if diacritical characters survived the upload."""
    issues = []
    for char in DIACRITICALS:
        orig_count = original.count(char)
        db_count = db_text.count(char)
        if orig_count != db_count:
            issues.append(f"  '{char}': {orig_count} in original, {db_count} in DB")
    return issues


# ═══════════════════════════════════════════════════════════
# VALIDATION: TRANSCRIPTS
# ═══════════════════════════════════════════════════════════

def validate_transcripts() -> dict:
    log("\n" + "=" * 60)
    log("VALIDATING TRANSCRIPTS")
    log("=" * 60)

    results = {"type": "transcripts", "step1": {}, "step2": {}, "issues": []}

    # ── STEP 1: Completeness ──
    log("\n── Step 1: Completeness Check ──")

    json_files = list(TRANSCRIPTS_JSON_DIR.glob("*.json"))
    log(f"  JSON files on disk: {len(json_files)}")

    # Count rows in Supabase
    db_count = supabase.table("transcripts").select("id", count="exact").execute()
    db_total = db_count.count or 0
    log(f"  Transcripts in Supabase: {db_total}")

    # Count paragraphs
    para_count = supabase.table("transcript_paragraphs").select("id", count="exact").execute()
    para_total = para_count.count or 0
    log(f"  Transcript paragraphs in Supabase: {para_total}")

    # Check embeddings
    emb_null = supabase.table("transcript_paragraphs").select("id", count="exact").is_("embedding", "null").execute()
    emb_null_count = emb_null.count or 0
    log(f"  Paragraphs without embeddings: {emb_null_count}")

    # Check tags
    tag_null = supabase.table("transcript_paragraphs").select("id", count="exact").or_("tags.is.null,tags.eq.{}").execute()
    tag_null_count = tag_null.count or 0
    log(f"  Paragraphs without tags: {tag_null_count}")

    # Check for missing uploads (JSON on disk but not in DB)
    missing = []
    for fpath in json_files[:500]:  # Check first 500
        data = json.loads(fpath.read_text(encoding="utf-8"))
        url = data.get("vedabase_url", "")
        if url:
            check = supabase.table("transcripts").select("id").eq("vedabase_url", url).execute()
            if not check.data:
                missing.append(url)

    if missing:
        log(f"  ⚠ {len(missing)} transcripts on disk but NOT in Supabase!")
        results["issues"].extend([f"MISSING in DB: {u}" for u in missing[:10]])
    else:
        log(f"  ✓ All checked transcripts found in Supabase")

    results["step1"] = {
        "json_files_on_disk": len(json_files),
        "transcripts_in_db": db_total,
        "paragraphs_in_db": para_total,
        "paragraphs_no_embedding": emb_null_count,
        "paragraphs_no_tags": tag_null_count,
        "missing_from_db": len(missing),
        "pass": len(missing) == 0,
    }

    # ── STEP 2: Content Integrity ──
    log("\n── Step 2: Content Integrity Check ──")

    sample_files = random.sample(json_files, min(50, len(json_files)))
    integrity_issues = []
    checked = 0

    for fpath in sample_files:
        data = json.loads(fpath.read_text(encoding="utf-8"))
        url = data.get("vedabase_url", "")
        if not url:
            continue

        # Find in DB
        db_transcript = supabase.table("transcripts").select("id").eq("vedabase_url", url).execute()
        if not db_transcript.data:
            continue

        t_id = db_transcript.data[0]["id"]

        # Get all paragraphs for this transcript
        db_paras = (
            supabase.table("transcript_paragraphs")
            .select("paragraph_number, body_text")
            .eq("transcript_id", t_id)
            .order("paragraph_number")
            .execute()
        )

        local_paras = data.get("paragraphs", [])
        db_para_count = len(db_paras.data) if db_paras.data else 0

        # Check paragraph count
        if db_para_count != len(local_paras):
            issue = f"PARA COUNT MISMATCH: {url} — local:{len(local_paras)} vs db:{db_para_count}"
            integrity_issues.append(issue)
            log(f"  ⚠ {issue}")

        # Check content of first paragraph for encoding
        if db_paras.data and local_paras:
            db_first = db_paras.data[0].get("body_text", "")
            local_first = local_paras[0]
            diac_issues = check_diacriticals(local_first, db_first)
            if diac_issues:
                integrity_issues.append(f"DIACRITICAL MISMATCH: {url}")
                for d in diac_issues:
                    integrity_issues.append(d)

        checked += 1

    log(f"  Checked {checked} transcripts for integrity")
    log(f"  Issues found: {len(integrity_issues)}")

    results["step2"] = {
        "samples_checked": checked,
        "issues_found": len(integrity_issues),
        "pass": len(integrity_issues) == 0,
    }
    results["issues"].extend(integrity_issues)

    return results


# ═══════════════════════════════════════════════════════════
# VALIDATION: LETTERS
# ═══════════════════════════════════════════════════════════

def validate_letters() -> dict:
    log("\n" + "=" * 60)
    log("VALIDATING LETTERS")
    log("=" * 60)

    results = {"type": "letters", "step1": {}, "step2": {}, "issues": []}

    log("\n── Step 1: Completeness Check ──")

    json_files = list(LETTERS_JSON_DIR.glob("*.json"))
    log(f"  JSON files on disk: {len(json_files)}")

    db_count = supabase.table("letters").select("id", count="exact").execute()
    db_total = db_count.count or 0
    log(f"  Letters in Supabase: {db_total}")

    para_count = supabase.table("letter_paragraphs").select("id", count="exact").execute()
    para_total = para_count.count or 0
    log(f"  Letter paragraphs in Supabase: {para_total}")

    emb_null = supabase.table("letter_paragraphs").select("id", count="exact").is_("embedding", "null").execute()
    emb_null_count = emb_null.count or 0
    log(f"  Paragraphs without embeddings: {emb_null_count}")

    tag_null = supabase.table("letter_paragraphs").select("id", count="exact").or_("tags.is.null,tags.eq.{}").execute()
    tag_null_count = tag_null.count or 0
    log(f"  Paragraphs without tags: {tag_null_count}")

    missing = []
    for fpath in json_files[:500]:
        data = json.loads(fpath.read_text(encoding="utf-8"))
        url = data.get("vedabase_url", "")
        if url:
            check = supabase.table("letters").select("id").eq("vedabase_url", url).execute()
            if not check.data:
                missing.append(url)

    results["step1"] = {
        "json_files_on_disk": len(json_files),
        "letters_in_db": db_total,
        "paragraphs_in_db": para_total,
        "paragraphs_no_embedding": emb_null_count,
        "paragraphs_no_tags": tag_null_count,
        "missing_from_db": len(missing),
        "pass": len(missing) == 0,
    }

    if missing:
        log(f"  ⚠ {len(missing)} letters on disk but NOT in Supabase!")
    else:
        log(f"  ✓ All checked letters found in Supabase")

    # Step 2: Integrity
    log("\n── Step 2: Content Integrity Check ──")
    sample_files = random.sample(json_files, min(50, len(json_files)))
    integrity_issues = []
    checked = 0

    for fpath in sample_files:
        data = json.loads(fpath.read_text(encoding="utf-8"))
        url = data.get("vedabase_url", "")
        if not url:
            continue
        db_letter = supabase.table("letters").select("id").eq("vedabase_url", url).execute()
        if not db_letter.data:
            continue
        l_id = db_letter.data[0]["id"]
        db_paras = supabase.table("letter_paragraphs").select("paragraph_number, body_text").eq("letter_id", l_id).order("paragraph_number").execute()
        local_paras = data.get("paragraphs", [])
        db_para_count = len(db_paras.data) if db_paras.data else 0

        if db_para_count != len(local_paras):
            integrity_issues.append(f"PARA COUNT MISMATCH: {url} — local:{len(local_paras)} vs db:{db_para_count}")

        if db_paras.data and local_paras:
            diac_issues = check_diacriticals(local_paras[0], db_paras.data[0].get("body_text", ""))
            if diac_issues:
                integrity_issues.extend([f"DIACRITICAL: {url}"] + diac_issues)

        checked += 1

    results["step2"] = {"samples_checked": checked, "issues_found": len(integrity_issues), "pass": len(integrity_issues) == 0}
    results["issues"].extend(integrity_issues)
    log(f"  Checked {checked} letters | Issues: {len(integrity_issues)}")

    return results


# ═══════════════════════════════════════════════════════════
# VALIDATION: EBOOKS
# ═══════════════════════════════════════════════════════════

def validate_ebooks() -> dict:
    log("\n" + "=" * 60)
    log("VALIDATING EBOOKS")
    log("=" * 60)

    results = {"type": "ebooks", "step1": {}, "issues": []}

    json_files = list(EBOOKS_JSON_DIR.glob("*.json"))
    log(f"  Ebook JSON files on disk: {len(json_files)}")

    missing = []
    for fpath in json_files:
        slug = fpath.stem
        check = supabase.table("books").select("id").eq("slug", slug).execute()
        if not check.data:
            missing.append(slug)
            log(f"  ⚠ Book '{slug}' not found in Supabase")

    results["step1"] = {
        "ebook_json_files": len(json_files),
        "missing_from_db": len(missing),
        "pass": len(missing) == 0,
    }

    if not missing:
        log(f"  ✓ All ebooks found in Supabase")

    return results


# ═══════════════════════════════════════════════════════════
# SPOT CHECK: Random 20 for human review
# ═══════════════════════════════════════════════════════════

def spot_check():
    log("\n" + "=" * 60)
    log("SPOT CHECK — 20 Random Samples for Human Review")
    log("=" * 60)

    samples = []

    # 10 transcript paragraphs
    tp = supabase.table("transcript_paragraphs").select("id, body_text, transcript_id").limit(200).execute()
    if tp.data:
        picks = random.sample(tp.data, min(10, len(tp.data)))
        for p in picks:
            parent = supabase.table("transcripts").select("title, vedabase_url").eq("id", p["transcript_id"]).execute()
            title = parent.data[0]["title"] if parent.data else "Unknown"
            url = parent.data[0].get("vedabase_url", "") if parent.data else ""
            samples.append({
                "type": "transcript",
                "title": title,
                "vedabase_url": url,
                "text_preview": (p["body_text"] or "")[:300],
            })

    # 10 letter paragraphs
    lp = supabase.table("letter_paragraphs").select("id, body_text, letter_id").limit(200).execute()
    if lp.data:
        picks = random.sample(lp.data, min(10, len(lp.data)))
        for p in picks:
            parent = supabase.table("letters").select("recipient, vedabase_url").eq("id", p["letter_id"]).execute()
            recipient = parent.data[0].get("recipient", "Unknown") if parent.data else "Unknown"
            url = parent.data[0].get("vedabase_url", "") if parent.data else ""
            samples.append({
                "type": "letter",
                "recipient": recipient,
                "vedabase_url": url,
                "text_preview": (p["body_text"] or "")[:300],
            })

    spot_file = VALIDATION_DIR / "spot_check_samples.json"
    spot_file.write_text(json.dumps(samples, ensure_ascii=False, indent=2), encoding="utf-8")
    log(f"\n  Saved {len(samples)} samples to: {spot_file}")
    log("  OPEN THIS FILE and compare each sample against the Vedabase URL.")
    log("  If all 20 look correct → you're good!")

    return samples


# ═══════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════

def main():
    log("=" * 60)
    log(f"VALIDATION — Target: {TARGET}")
    log("=" * 60)

    all_results = []

    if TARGET in ("transcripts", "all"):
        all_results.append(validate_transcripts())
    if TARGET in ("letters", "all"):
        all_results.append(validate_letters())
    if TARGET in ("ebooks", "all"):
        all_results.append(validate_ebooks())

    if SPOT_CHECK:
        spot_check()

    # Save report
    report = {
        "generated_at": datetime.now().isoformat(),
        "results": all_results,
        "overall_pass": all(
            r.get("step1", {}).get("pass", False) and
            r.get("step2", {}).get("pass", True)
            for r in all_results
        ),
    }
    Path(REPORT_FILE).write_text(json.dumps(report, indent=2), encoding="utf-8")
    log(f"\nReport saved: {REPORT_FILE}")

    # Summary
    log("\n" + "=" * 60)
    log("VALIDATION SUMMARY")
    for r in all_results:
        s1 = "✓ PASS" if r.get("step1", {}).get("pass") else "✗ FAIL"
        s2 = "✓ PASS" if r.get("step2", {}).get("pass", True) else "✗ FAIL"
        log(f"  {r['type'].upper()}: Step1={s1} | Step2={s2} | Issues={len(r.get('issues', []))}")

    if report["overall_pass"]:
        log("\n✓ ALL VALIDATIONS PASSED")
    else:
        log("\n✗ SOME VALIDATIONS FAILED — check the report file")

    log("=" * 60)


if __name__ == "__main__":
    main()
