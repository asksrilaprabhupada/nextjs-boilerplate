"""
sentences.py — deterministic sentence splitter for evidence-by-ID (v3.p2).

Splits a passage into stable, numbered sentences (S001, S002, …) so Gemini can
cite EVIDENCE as a sentence ID instead of copying text (which it can hallucinate,
paraphrase, or truncate). The prompt shows the numbered target sentences; the
responseSchema constrains `evidence_sentence_id` to a closed enum of those IDs;
our code resolves the returned ID back to the EXACT original sentence + character
offsets for tag_evidence. The model never supplies evidence text — only a pointer.

Determinism (same input → identical split) is the requirement, not linguistic
perfection: the splitter identity is recorded as SPLITTER_VERSION in
tag_runs.config so any run's evidence is reproducible. Pure string/regex ops,
stdlib only — safe to import from audit.py and tagging.py without cycles.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass

SPLITTER_VERSION = "asp-sentences-v1"

# Sentence-final punctuation: ASCII . ? ! plus the Devanagari daṇḍa (।, U+0964)
# and double daṇḍa (॥, U+0965) that end Sanskrit verse lines throughout the corpus.
# A boundary = one-or-more terminators + optional closing quotes/brackets,
# immediately followed by whitespace or end-of-text (zero-width lookahead, so the
# boundary index sits right after the closers, before the separating whitespace).
_BOUNDARY_RE = re.compile(r"[.?!।॥]+[\"'”’»)\]]*(?=\s|$)")

# Tokens whose trailing period is an abbreviation, NOT a sentence end (folded +
# lowercased, trailing dots stripped). Deliberately excludes ambiguous words
# ("no", "vol", "p") so real sentence ends are never merged; under-splitting an
# abbreviation is harmless (evidence stays correct, just coarser) while
# over-splitting mid-abbreviation would fragment it.
_ABBREVIATIONS = {
    # scriptural inline refs
    "bg", "sb", "cc", "bs", "iso", "nod", "noi", "tlc", "kb", "mg",
    # honorifics / names
    "sri", "srila", "srimati", "smt", "mr", "mrs", "ms", "dr",
    # latin
    "e.g", "i.e", "etc", "viz", "cf", "ibid",
}


@dataclass(frozen=True)
class Sentence:
    id: str      # "S001", "S002", … (1-based, zero-padded to 3)
    start: int   # inclusive char offset into the ORIGINAL text
    end: int     # exclusive char offset — text[start:end] == self.text
    text: str


def _fold(s: str) -> str:
    """NFD + drop combining marks so 'Śrī' matches 'sri' for abbreviation checks."""
    return "".join(c for c in unicodedata.normalize("NFD", s) if not unicodedata.combining(c))


def _is_false_boundary(text: str, term_start: int) -> bool:
    """A '.' boundary that is really an initial ('A.') or an abbreviation ('Bg.').
    Only '.' can be a false boundary; ? ! and the daṇḍas always terminate."""
    if text[term_start] != ".":
        return False
    k = term_start
    while k > 0 and not text[k - 1].isspace():
        k -= 1
    word = text[k:term_start]  # the token immediately before the terminator run
    core = word.rstrip(".")
    if not core:
        return False
    if len(core) == 1 and core.isalpha():
        return True  # single-letter initial: "A." "C."
    return _fold(core).lower() in _ABBREVIATIONS


def _emit(text: str, lo: int, hi: int, idx: int) -> Sentence | None:
    """Trim outer whitespace from text[lo:hi] and build a Sentence with exact
    offsets, or None when the span is blank."""
    seg = text[lo:hi]
    stripped = seg.strip()
    if not stripped:
        return None
    start = lo + (len(seg) - len(seg.lstrip()))
    end = start + len(stripped)
    return Sentence(f"S{idx:03d}", start, end, text[start:end])


def split_sentences(text: str | None) -> list[Sentence]:
    """Deterministically split `text` into numbered sentences with offsets back
    into the original string. Any non-empty trailing fragment (no terminator) is
    itself a sentence."""
    if not text:
        return []
    sentences: list[Sentence] = []
    pos = 0
    idx = 0
    for m in _BOUNDARY_RE.finditer(text):
        if _is_false_boundary(text, m.start()):
            continue
        sent = _emit(text, pos, m.end(), idx + 1)
        if sent is not None:
            idx += 1
            sentences.append(sent)
        pos = m.end()
    if pos < len(text):
        sent = _emit(text, pos, len(text), idx + 1)
        if sent is not None:
            sentences.append(sent)
    return sentences


def sentence_ids(sentences: list[Sentence]) -> list[str]:
    return [s.id for s in sentences]


def render_numbered(sentences: list[Sentence]) -> str:
    """The block shown in the prompt: one `[S001] text` line per sentence."""
    return "\n".join(f"[{s.id}] {s.text}" for s in sentences)


def resolve_sentence(
    sid: object, sentences: list[Sentence]
) -> tuple[bool, str, int | None, int | None, str | None]:
    """Resolve a model-returned sentence id back to the EXACT source sentence.
    Returns (found, text, start, end, miss_reason). A missing/blank/unknown id is
    a soft miss for tags (kept, evidence_found=false) and a hard drop for questions."""
    if not isinstance(sid, str) or not sid.strip():
        return False, "", None, None, "evidence sentence id missing"
    sid = sid.strip()
    for s in sentences:
        if s.id == sid:
            return True, s.text, s.start, s.end, None
    return False, "", None, None, "evidence sentence id not in target"
