"""
provenance.py — interpreter for provenance.json (the manifest).

The harness gates ONLY from the manifest: this module holds no book lists, no
canto/chapter thresholds, no speaker names — it reads them all from
scripts/tags-rebuild/provenance.json and exposes:

  load_manifest()                     → parsed + lightly validated manifest
  authorship_for_verse(...)           → HIS | NOT_HIS | MIXED_VERIFY
  authorship_for_prose(book_slug)     → same
  authorship_for_letter()             → same (always HIS per manifest)
  TranscriptWalker                    → per-transcript speaker walk with
                                        carry-forward; .paragraph_speakers()
  questions_allowed(authorship)       → gating.<authorship>.questions

Speaker segmentation mirrors app/lib/15-transcript-speakers.ts (same regex,
same diacritic fold) with the manifest's harness-side addition: the last named
speaker carries forward across prefix-less continuation paragraphs within a
transcript, and a paragraph counts as Prabhupāda-speaking if he is among its
speakers.
"""
from __future__ import annotations

import json
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from typing import Optional

import regex  # 'regex' (not 're') — supports \p{Lu}/\p{L}/\p{M}/\p{N} like the app's JS regex

import config

HIS, NOT_HIS, MIXED_VERIFY = "HIS", "NOT_HIS", "MIXED_VERIFY"


@lru_cache(maxsize=1)
def load_manifest() -> dict:
    with open(config.PROVENANCE_PATH, encoding="utf-8") as f:
        manifest = json.load(f)
    for key in ("books", "sb_completion_rule", "tables", "transcripts", "gating"):
        if key not in manifest:
            raise SystemExit(f"FATAL: provenance.json is missing required section '{key}'")
    return manifest


def fold_name(name: str) -> str:
    """Manifest 'name_folding': NFD, strip combining marks, lowercase, [a-z ] only."""
    decomposed = unicodedata.normalize("NFD", name or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return "".join(ch for ch in stripped.lower() if ch == " " or "a" <= ch <= "z").strip()


# ── Book-level rules (verses + prose) ───────────────────────────────────────

def _book_authorship(book_slug: str) -> str:
    books = load_manifest()["books"]
    slug = (book_slug or "").lower()
    if slug in books["not_his_slugs"]:
        return NOT_HIS
    if slug in books["mixed_verify_slugs"]:
        return MIXED_VERIFY
    if slug in books["his_slugs"]:
        return HIS
    return books["unknown_book_slug"]


def parse_sb_canto_chapter(
    vedabase_url: Optional[str],
    canto_field: Optional[str | int] = None,
    chapter_field: Optional[str | int] = None,
) -> Optional[tuple[int, int]]:
    rule = load_manifest()["sb_completion_rule"]
    if vedabase_url:
        m = regex.search(rule["parse"]["url_pattern"], vedabase_url)
        if m:
            return int(m.group(1)), int(m.group(2))
    try:
        return int(str(canto_field)), int(str(chapter_field))
    except (TypeError, ValueError):
        return None


def sb_disciple_completed(canto: int, chapter: int) -> bool:
    boundary = load_manifest()["sb_completion_rule"]["not_his_from"]
    return canto > boundary["canto"] or (
        canto == boundary["canto"] and chapter >= boundary["chapter"]
    )


def authorship_for_verse(
    book_slug: Optional[str],
    vedabase_url: Optional[str],
    canto_field: Optional[str | int] = None,
    chapter_field: Optional[str | int] = None,
) -> str:
    manifest = load_manifest()
    slug = (book_slug or "").lower()
    if slug == manifest["sb_completion_rule"]["book_slug"]:
        cc = parse_sb_canto_chapter(vedabase_url, canto_field, chapter_field)
        if cc and sb_disciple_completed(*cc):
            return NOT_HIS
        return HIS
    return _book_authorship(slug)


def authorship_for_prose(book_slug: Optional[str]) -> str:
    return _book_authorship(book_slug or "")


def authorship_for_letter() -> str:
    return load_manifest()["tables"]["letter_paragraphs"]["authorship"]


def questions_allowed(authorship: str) -> bool:
    gate = load_manifest()["gating"].get(authorship)
    if gate is None:
        raise SystemExit(f"FATAL: provenance.json gating has no entry for '{authorship}'")
    return bool(gate["questions"])


# ── Transcript speaker walk ─────────────────────────────────────────────────

@dataclass
class ParagraphSpeakers:
    paragraph_id: str
    speakers: set[str]          # folded speaker names evidenced for this paragraph
    prabhupada_speaking: bool   # he is among the speakers → questions allowed


class TranscriptWalker:
    """Walks ONE transcript's paragraphs in paragraph_number order, segmenting
    each on the manifest's speaker-prefix regex and carrying the last named
    speaker forward across prefix-less continuation paragraphs."""

    def __init__(self) -> None:
        t = load_manifest()["transcripts"]
        self._re = regex.compile(t["speaker_prefix_regex"], regex.UNICODE)
        self._prabhupada = set(t["prabhupada_names_folded"])
        self._carry_forward = bool(t["carry_forward_last_named_speaker"])

    def _is_prabhupada(self, folded: str) -> bool:
        return folded in self._prabhupada

    def paragraph_speaker_names(self, body_text: str) -> list[str]:
        """Folded names of the prefixed speakers in one paragraph, in order."""
        names = []
        for line in (body_text or "").split("\n"):
            m = self._re.match(line)
            if m:
                names.append(fold_name(m.group(1)))
        return names

    def walk(self, ordered_paragraphs: list[tuple[str, str]]) -> list[ParagraphSpeakers]:
        """ordered_paragraphs: [(paragraph_id, body_text)] sorted by paragraph_number
        for a single transcript_id. Returns per-paragraph evidenced speakers."""
        results: list[ParagraphSpeakers] = []
        last_named: Optional[str] = None
        for pid, body in ordered_paragraphs:
            named_here = self.paragraph_speaker_names(body)
            speakers: set[str] = set(named_here)
            if not named_here:
                # Prefix-less continuation: the last named speaker (from earlier
                # in THIS transcript) is still speaking. Before any named
                # speaker exists, the manifest says NOT_HIS — no speaker added.
                if self._carry_forward and last_named is not None:
                    speakers.add(last_named)
            else:
                # An unlabeled leading run before the first prefix in this
                # paragraph is the previous paragraph's speaker continuing.
                leading_unlabeled = not self._re.match((body or "").split("\n", 1)[0])
                if self._carry_forward and leading_unlabeled and last_named is not None:
                    speakers.add(last_named)
                last_named = named_here[-1]
            results.append(
                ParagraphSpeakers(
                    paragraph_id=pid,
                    speakers=speakers,
                    prabhupada_speaking=any(self._is_prabhupada(s) for s in speakers),
                )
            )
        return results

    def authorship_for_paragraph(self, para: ParagraphSpeakers) -> str:
        """Manifest 'counts_as_his_if': prabhupada_among_speakers."""
        return HIS if para.prabhupada_speaking else NOT_HIS
