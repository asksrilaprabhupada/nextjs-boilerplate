"""Pure, deterministic transcript speaker attribution.

The mapper deliberately uses only paragraph identity, transcript identity,
paragraph order, and stored body text. It performs no network access and no
model-based inference.
"""

from __future__ import annotations

from collections import defaultdict
from dataclasses import asdict, dataclass, is_dataclass
from hashlib import sha256
import json
import re
import unicodedata
from typing import Any, Iterable, Literal, Mapping, Sequence


UNKNOWN_SPEAKER = "Speaker not identified"
CANONICAL_PRABHUPADA = "Śrīla Prabhupāda"

_MODE_ORDER = ("explicit", "inherited", "mixed", "unknown", "suspicious")
_NON_SPEECH_BOUNDARY_LABELS = {
    "audio file",
    "chapter",
    "conclusion",
    "date",
    "dated",
    "example",
    "introduction",
    "location",
    "note",
    "notes",
    "purport",
    "recording",
    "reference",
    "synonyms",
    "text",
    "translation",
    "type",
    "verse",
    "why",
}
_UNKNOWN_SPEECH_BOUNDARY_LABELS = {
    "answer",
    "question",
    "speaker not identified",
    "unidentified speaker",
    "unknown",
}
_LOWERCASE_ROLE_WORDS = {
    "assistant",
    "audience",
    "boy",
    "boys",
    "child",
    "children",
    "dasa",
    "dasi",
    "devotee",
    "devotees",
    "disciple",
    "doctor",
    "dr",
    "father",
    "follower",
    "girl",
    "girls",
    "guest",
    "guests",
    "lady",
    "manager",
    "man",
    "men",
    "member",
    "monk",
    "mother",
    "passerby",
    "person",
    "priest",
    "professor",
    "reporter",
    "reporters",
    "representative",
    "secretary",
    "son",
    "student",
    "students",
    "voice",
    "wife",
    "woman",
    "women",
}
_HONORIFIC_WORDS = {"dr", "miss", "mr", "mrs", "professor", "reverend"}
_BOUNDARY_ONLY_ROLE_WORDS = {"ambassador"}
_COMPOSITE_CONNECTORS = {"and", "or", "with", "to"}
_NAME_JOINERS = {"at", "from", "in", "of"}
_PROSE_ONLY_PREFIXES = {
    "actually",
    "also",
    "and",
    "because",
    "but",
    "however",
    "no",
    "now",
    "or",
    "otherwise",
    "similarly",
    "so",
    "then",
    "therefore",
    "thus",
    "well",
    "yes",
}
_PROSE_LEADING_WORDS = {
    "actually",
    "also",
    "and",
    "another",
    "anyway",
    "because",
    "begin",
    "but",
    "everything",
    "four",
    "here",
    "how",
    "if",
    "in",
    "it",
    "just",
    "lord",
    "no",
    "now",
    "one",
    "only",
    "otherwise",
    "same",
    "similarly",
    "simple",
    "six",
    "so",
    "sometimes",
    "take",
    "that",
    "the",
    "their",
    "then",
    "there",
    "therefore",
    "these",
    "they",
    "this",
    "three",
    "try",
    "two",
    "very",
    "we",
    "when",
    "who",
    "why",
    "you",
}
_NUMBER_WORDS = {
    "zero",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
    "thirteen",
    "fourteen",
    "fifteen",
    "sixteen",
    "seventeen",
    "eighteen",
    "nineteen",
    "twenty",
    "thirty",
    "forty",
    "fifty",
    "sixty",
    "seventy",
    "eighty",
    "ninety",
    "hundred",
    "first",
    "second",
    "third",
    "fourth",
    "fifth",
    "sixth",
    "seventh",
    "eighth",
    "ninth",
    "tenth",
}
# These exact prefixes were manually audited in the first full-corpus dry run.
# They introduce Sanskrit glossary or verse material, not human turns. Keeping
# the list explicit is safer than guessing from language or diacritic shape.
_AUDITED_GLOSS_OR_VERSE_LABELS = {
    "aham",
    "akhila bandha muktaye",
    "bahu sambhavante",
    "nitya siddha",
    "yantra",
}
_AUDITED_EXACT_PERSON_LABELS = {
    "bali mardana",
    "bhavananda",
    "brahmananda",
    "dayananda",
    "gurudasa",
    "harikesa",
    "hayagriva",
    "hrdayananda",
    "jagadisa",
    "karandhara",
    "madhudvisa",
    "pradyumna",
    "pusta krsna",
    "ramesvara",
    "rupanuga",
    "satsvarupa",
    "srutakirti",
    "sudama",
    "syamasundara",
    "tamala krsna",
}
# These additional exact names were independently established as literal
# speaker turns in the full-corpus candidate-2 audit. Every allowlisted label
# proves only itself; no transcript-local promotion is permitted.
_AUDITED_EXACT_PERSON_LABELS |= {
    "acyutananda",
    "atreya rsi",
    "bhakti caru",
    "birabhadra",
    "dhananjaya",
    "gargamuni",
    "giriraja",
    "gopala krsna",
    "hamsaduta",
    "hari sauri",
    "janardana",
    "jayadvaita",
    "jayapataka",
    "jayatirtha",
    "kirtanananda",
    "nitai",
    "pancadravida",
    "paramahamsa",
    "revatinandana",
    "sastriji",
    "satadhanya",
    "svarupa damodara",
    "upendra",
    "visnujana",
    "yamuna",
    "yasodanandana",
    "yasomatinandana",
    "yogesvara",
    "yadubara",
}
_TRUSTED_EXACT_PERSON_LABELS = _AUDITED_EXACT_PERSON_LABELS
_CANONICAL_SPEAKER_ALIASES = {
    "yadubara": "Yadubara",
    "yaduvara": "Yadubara",
}
_FINITE_VERB_WORDS = {
    "am",
    "are",
    "can",
    "could",
    "did",
    "do",
    "does",
    "had",
    "has",
    "have",
    "is",
    "may",
    "might",
    "must",
    "shall",
    "should",
    "was",
    "were",
    "will",
    "would",
}
_PRABHUPADA_KEYS = {
    "prahupada",
    "prabhupad",
    "prabhupada",
    "prabhuapda",
    "pprabhupada",
    "srila prabhupad",
    "srila prabhupada",
    "a c bhaktivedanta swami prabhupada",
    "ac bhaktivedanta swami prabhupada",
    "srila a c bhaktivedanta swami prabhupada",
    "srila ac bhaktivedanta swami prabhupada",
    "his divine grace a c bhaktivedanta swami prabhupada",
    "his divine grace ac bhaktivedanta swami prabhupada",
}
_MAX_LABEL_CHARACTERS = 80
_MAX_LABEL_WORDS = 8
_DISALLOWED_CANDIDATE_CHARACTERS = frozenset("?!;=[]{}<>\"“”")
_ALLOWED_LABEL_PUNCTUATION = frozenset(".'’()-/,&")


BoundaryKind = Literal["proved", "unrecognized", "editorial", "prose"]


class TranscriptOrderError(ValueError):
    """Raised when paragraph order is insufficient for safe inheritance."""


@dataclass(frozen=True)
class TranscriptParagraph:
    id: str
    transcript_id: str | None
    paragraph_number: int
    body_text: str


@dataclass(frozen=True)
class BoundaryClassification:
    kind: BoundaryKind
    raw_label: str | None = None
    speakers: tuple[str, ...] = ()
    remainder: str = ""


@dataclass(frozen=True)
class MappingResult:
    id: str
    transcript_id: str | None
    paragraph_number: int
    body_sha256: str
    speaker_names: tuple[str, ...]
    before_speaker: str | None
    after_speaker: str | None
    evidence_modes: tuple[str, ...]
    suspicious_codes: tuple[str, ...]

    def to_record(self) -> dict[str, object]:
        """Return the stable, JSON-ready runner record."""

        return {
            "id": self.id,
            "transcriptId": self.transcript_id,
            "paragraphNumber": self.paragraph_number,
            "bodySha256": self.body_sha256,
            "speakerNames": list(self.speaker_names),
            "beforeSpeaker": self.before_speaker,
            "afterSpeaker": self.after_speaker,
            "evidenceModes": list(self.evidence_modes),
            "suspiciousCodes": list(self.suspicious_codes),
        }


@dataclass(frozen=True)
class CorpusStats:
    processed_paragraphs: int
    processed_transcripts: int
    explicit_paragraphs: int
    inherited_paragraphs: int
    mixed_paragraphs: int
    unknown_paragraphs: int
    suspicious_paragraphs: int

    def to_record(self) -> dict[str, int]:
        return {
            "processedParagraphs": self.processed_paragraphs,
            "processedTranscripts": self.processed_transcripts,
            "explicitParagraphs": self.explicit_paragraphs,
            "inheritedParagraphs": self.inherited_paragraphs,
            "mixedParagraphs": self.mixed_paragraphs,
            "unknownParagraphs": self.unknown_paragraphs,
            "suspiciousParagraphs": self.suspicious_paragraphs,
        }


def _collapse_space(value: str) -> str:
    return " ".join(value.split())


def _fold(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    characters: list[str] = []
    for character in decomposed.casefold():
        category = unicodedata.category(character)
        if category.startswith("M"):
            continue
        if category.startswith(("L", "N")):
            characters.append(character)
        else:
            characters.append(" ")
    return _collapse_space("".join(characters))


def _has_letter(value: str) -> bool:
    return any(unicodedata.category(character).startswith("L") for character in value)


def _first_cased_character(value: str) -> str | None:
    for character in value:
        if character.lower() != character.upper():
            return character
    return None


def _starts_uppercase(value: str) -> bool:
    first = _first_cased_character(value)
    return first is not None and (first.isupper() or first.istitle())


def _token_core(token: str) -> str:
    return token.strip(".'’()-/,&")


def _looks_like_boundary_candidate(label: str) -> bool:
    if not label or len(label) > _MAX_LABEL_CHARACTERS:
        return False
    if not _has_letter(label):
        return False
    if len(label.split()) > _MAX_LABEL_WORDS:
        return False
    if any(character in _DISALLOWED_CANDIDATE_CHARACTERS for character in label):
        return False

    for character in label:
        category = unicodedata.category(character)
        if category.startswith(("L", "M", "N", "Z")):
            continue
        if character in _ALLOWED_LABEL_PUNCTUATION:
            continue
        return False
    return True


def _canonical_prabhupada(label: str) -> str | None:
    folded = _fold(label)
    folded = re.sub(r"\s+\d+$", "", folded)
    if folded in _PRABHUPADA_KEYS:
        return CANONICAL_PRABHUPADA
    return None


def _folded_words(value: str) -> list[str]:
    return _fold(value).split()


def _has_human_role_word(label: str) -> bool:
    words = _folded_words(label)
    return any(
        word in _LOWERCASE_ROLE_WORDS or word in _HONORIFIC_WORDS
        for word in words
    )


def _is_composite_label(label: str) -> bool:
    words = _folded_words(label)
    return any(separator in label for separator in (",", "&", "/")) or any(
        word in _COMPOSITE_CONNECTORS for word in words
    )


def _is_name_shaped(label: str) -> bool:
    """Return whether a label could be a person without proving that it is one."""

    tokens = label.split()
    if not tokens:
        return False
    saw_name_token = False
    for token in tokens:
        core = _token_core(token)
        folded_token = _fold(core)
        if not core:
            continue
        if folded_token.isdigit():
            continue
        if folded_token in _COMPOSITE_CONNECTORS | _NAME_JOINERS:
            continue
        if folded_token in _LOWERCASE_ROLE_WORDS | _HONORIFIC_WORDS:
            continue
        if not _starts_uppercase(core):
            return False
        saw_name_token = True
    return saw_name_token


def _looks_like_human_boundary(label: str) -> bool:
    # Lowercase descriptions such as ``mystery person`` are not proof, but they
    # are still plausible human boundaries and therefore must clear carry.
    return _has_human_role_word(label) or _is_name_shaped(label)


def _trusted_speaker(label: str) -> str | None:
    normalized = _collapse_space(unicodedata.normalize("NFC", label))
    # Transcript labels sometimes omit the space before a numeric role suffix
    # (for example, ``Indian man(2)``). Normalize only that exact suffix shape;
    # the folded identity already treats it as the same role as ``Indian man
    # (2)``, and this keeps the public spelling consistent.
    normalized = re.sub(r"\s*\(\s*(\d+)\s*\)\s*$", r" (\1)", normalized)
    compact_role_suffix = re.fullmatch(r"(.+?)(\d+)", normalized)
    if compact_role_suffix and _has_human_role_word(compact_role_suffix.group(1)):
        normalized = f"{compact_role_suffix.group(1).rstrip()} ({compact_role_suffix.group(2)})"
    folded = _fold(normalized)
    if not folded or folded in _NON_SPEECH_BOUNDARY_LABELS:
        return None

    prabhupada = _canonical_prabhupada(normalized)
    if prabhupada is not None:
        return prabhupada

    if _is_composite_label(normalized):
        return None

    alias = _CANONICAL_SPEAKER_ALIASES.get(folded)
    if alias is not None:
        return alias

    tokens = normalized.split()
    if not tokens or not _starts_uppercase(tokens[0]):
        return None
    if folded not in _TRUSTED_EXACT_PERSON_LABELS and not _has_human_role_word(
        normalized
    ):
        return None

    for token in tokens[1:]:
        core = _token_core(token)
        folded_token = _fold(core)
        if not core:
            return None
        if folded_token.isdigit():
            continue
        if folded_token in _LOWERCASE_ROLE_WORDS | _HONORIFIC_WORDS | _NAME_JOINERS:
            continue
        if _starts_uppercase(core):
            continue
        return None
    return normalized


def _trusted_speakers(label: str) -> tuple[str, ...]:
    """Return one or more independently proved speakers for a label.

    Composite labels are accepted only when every component is already proved
    by the same exact-name, Prabhupāda, or human-role rules used for a singular
    label. An uncertain component makes the whole boundary unrecognized.
    """

    singular = _trusted_speaker(label)
    if singular is not None:
        return (singular,)
    if not _is_composite_label(label):
        return ()

    split = re.sub(r"\s+(?:and)\s+", "|", label, flags=re.IGNORECASE)
    split = re.sub(r"[,/&]", "|", split)
    parts = [_collapse_space(part) for part in split.split("|") if part.strip()]
    if len(parts) < 2:
        return ()
    speakers: list[str] = []
    for part in parts:
        speaker = _trusted_speaker(part)
        if speaker is None:
            return ()
        _append_unique(speakers, speaker)
    return tuple(speakers) if len(speakers) >= 2 else ()


def _looks_like_potential_human_boundary(label: str) -> bool:
    """Recognize uncertain human labels broadly enough to clear inheritance."""

    without_annotations = re.sub(r"\[[^\]]*\]|\([^)]*\)", " ", label)
    normalized = _collapse_space(without_annotations)
    if (
        not normalized
        or len(normalized) > 160
        or len(normalized.split()) > 12
    ):
        return False
    words = _folded_words(normalized)
    if _has_human_role_word(normalized) or any(
        word in _BOUNDARY_ONLY_ROLE_WORDS for word in words
    ):
        return True
    if any(word in _FINITE_VERB_WORDS for word in words[1:]):
        return False
    return _is_name_shaped(normalized)


def _alternate_translation_boundary(line: str) -> BoundaryClassification | None:
    """Detect the audited ``TrustedName = Translation = text`` alternate form."""

    parts = line.lstrip(" \t").split("=", 2)
    if len(parts) != 3:
        return None
    possible_speaker = _collapse_space(parts[0])
    boundary_kind = _fold(parts[1])
    if boundary_kind != "translation" or _trusted_speaker(possible_speaker) is None:
        return None
    return BoundaryClassification(
        kind="unrecognized",
        raw_label=f"{possible_speaker} = Translation",
        remainder=parts[2],
    )


def _looks_like_prose_prefix(label: str) -> bool:
    folded = _fold(label)
    words = folded.split()
    if not words:
        return False
    if folded in _AUDITED_GLOSS_OR_VERSE_LABELS:
        return True
    if folded in _PROSE_ONLY_PREFIXES or folded in _NUMBER_WORDS:
        return True
    if all(word.isdigit() or word in _NUMBER_WORDS for word in words):
        return True
    if (
        words[0] == "text"
        and words[-1] in {"purport", "synonyms", "translation"}
        and all(
            word.isdigit()
            or word in _NUMBER_WORDS
            or word in {"purport", "synonyms", "translation"}
            for word in words[1:]
        )
    ):
        return True
    if words[0] == "verse" and (
        len(words) == 1
        or all(word.isdigit() or word in _NUMBER_WORDS or word == "number" for word in words[1:])
    ):
        return True
    if len(words) > 1 and words[0] in _PROSE_LEADING_WORDS:
        return True
    if len(words) >= 2 and any(word in _FINITE_VERB_WORDS for word in words[1:]):
        return True
    if len(words) >= 4 and not _has_human_role_word(label):
        return True
    if len(words) >= 2 and not _looks_like_human_boundary(label):
        return True
    return False


def _find_label_separator(line: str) -> tuple[int, str] | None:
    colon = line.find(":")
    fullwidth_colon = line.find("：")
    positions = [position for position in (colon, fullwidth_colon) if position >= 0]
    if not positions:
        return None
    position = min(positions)
    return position, line[position]


def classify_line(line: str) -> BoundaryClassification:
    """Classify a possible line-start boundary without using surrounding metadata."""

    if not isinstance(line, str):
        raise TypeError("line must be a string")

    alternate = _alternate_translation_boundary(line)
    if alternate is not None:
        return alternate

    candidate_line = line.lstrip(" \t")
    separator = _find_label_separator(candidate_line)
    if separator is None:
        return BoundaryClassification(kind="prose", remainder=line)

    position, _ = separator
    raw_label = candidate_line[:position].rstrip()
    remainder = candidate_line[position + 1 :]
    if _fold(raw_label) in {"http", "https", "mailto"}:
        return BoundaryClassification(kind="prose", remainder=line)

    normalized_label = _collapse_space(unicodedata.normalize("NFC", raw_label))
    folded_label = _fold(normalized_label)
    if folded_label in _NON_SPEECH_BOUNDARY_LABELS:
        return BoundaryClassification(
            kind="editorial",
            raw_label=normalized_label,
            remainder=remainder,
        )
    trusted = _trusted_speakers(normalized_label)
    if trusted:
        return BoundaryClassification(
            kind="proved",
            raw_label=normalized_label,
            speakers=trusted,
            remainder=remainder,
        )
    if folded_label in _UNKNOWN_SPEECH_BOUNDARY_LABELS:
        return BoundaryClassification(
            kind="unrecognized",
            raw_label=normalized_label,
            remainder=remainder,
        )
    if not _looks_like_boundary_candidate(raw_label):
        if _looks_like_potential_human_boundary(normalized_label):
            return BoundaryClassification(
                kind="unrecognized",
                raw_label=normalized_label,
                remainder=remainder,
            )
        return BoundaryClassification(kind="prose", remainder=line)
    if any(
        word in _BOUNDARY_ONLY_ROLE_WORDS
        for word in _folded_words(normalized_label)
    ):
        return BoundaryClassification(
            kind="unrecognized",
            raw_label=normalized_label,
            remainder=remainder,
        )
    if _looks_like_prose_prefix(normalized_label):
        if _is_composite_label(normalized_label):
            split = re.sub(
                r"\s+(?:and)\s+", "|", normalized_label, flags=re.IGNORECASE
            )
            split = re.sub(r"[,/&]", "|", split)
            if any(_trusted_speaker(part.strip()) for part in split.split("|")):
                return BoundaryClassification(
                    kind="unrecognized",
                    raw_label=normalized_label,
                    remainder=remainder,
                )
        return BoundaryClassification(kind="prose", remainder=line)
    if not _looks_like_potential_human_boundary(normalized_label):
        return BoundaryClassification(kind="prose", remainder=line)
    return BoundaryClassification(
        kind="unrecognized",
        raw_label=normalized_label,
        remainder=remainder,
    )


def _append_unique(values: list[str], value: str) -> None:
    key = _fold(value)
    if not any(_fold(existing) == key for existing in values):
        values.append(value)


def _suspicious_code(label: str | None) -> str:
    folded = _fold(label or "")
    if not folded:
        return "unrecognized_boundary"
    return f"unrecognized_boundary:{folded.replace(' ', '_')}"


def _map_paragraph(
    paragraph: TranscriptParagraph,
    active_speaker: str | None,
) -> tuple[MappingResult, str | None]:
    before_speaker = active_speaker
    origin: Literal["prior", "explicit", "unknown"] = (
        "prior" if active_speaker is not None else "unknown"
    )
    speaker_events: list[str] = []
    suspicious_codes: list[str] = []
    explicit = False
    inherited = False
    row_has_content = False

    normalized_body = paragraph.body_text.replace("\r\n", "\n").replace("\r", "\n")
    for line in normalized_body.split("\n"):
        classification = classify_line(line)
        if classification.kind == "proved":
            row_has_content = True
            explicit = True
            active_speaker = (
                classification.speakers[0]
                if len(classification.speakers) == 1
                else None
            )
            origin = "explicit"
            for speaker in classification.speakers:
                _append_unique(speaker_events, speaker)
            continue

        if classification.kind == "editorial":
            continue

        if classification.kind == "unrecognized":
            row_has_content = True
            active_speaker = None
            origin = "unknown"
            _append_unique(suspicious_codes, _suspicious_code(classification.raw_label))
            if classification.remainder.strip():
                _append_unique(speaker_events, UNKNOWN_SPEAKER)
            continue

        if not line.strip():
            continue

        row_has_content = True
        if active_speaker is None:
            _append_unique(speaker_events, UNKNOWN_SPEAKER)
        else:
            _append_unique(speaker_events, active_speaker)
            if origin == "prior":
                inherited = True

    known_exists = any(speaker != UNKNOWN_SPEAKER for speaker in speaker_events)
    if known_exists:
        speaker_names = tuple(speaker_events)
    else:
        speaker_names = ()

    unknown = UNKNOWN_SPEAKER in speaker_events or (row_has_content and not known_exists)
    modes_present = {
        "explicit": explicit,
        "inherited": inherited,
        "mixed": len(speaker_names) > 1,
        "unknown": unknown,
        "suspicious": bool(suspicious_codes),
    }
    evidence_modes = tuple(mode for mode in _MODE_ORDER if modes_present[mode])
    result = MappingResult(
        id=paragraph.id,
        transcript_id=paragraph.transcript_id,
        paragraph_number=paragraph.paragraph_number,
        body_sha256=sha256(paragraph.body_text.encode("utf-8")).hexdigest(),
        speaker_names=speaker_names,
        before_speaker=before_speaker,
        after_speaker=active_speaker,
        evidence_modes=evidence_modes,
        suspicious_codes=tuple(suspicious_codes),
    )
    return result, active_speaker


def _validate_paragraph(paragraph: TranscriptParagraph) -> None:
    if not isinstance(paragraph.id, str) or not paragraph.id:
        raise ValueError("paragraph id must be a non-empty string")
    if paragraph.transcript_id is not None and not isinstance(paragraph.transcript_id, str):
        raise TypeError(f"paragraph {paragraph.id!r} has a non-string transcript_id")
    if isinstance(paragraph.paragraph_number, bool) or not isinstance(
        paragraph.paragraph_number, int
    ) or paragraph.paragraph_number < 1:
        raise TranscriptOrderError(
            f"paragraph {paragraph.id!r} must have a positive integer paragraph_number"
        )
    if not isinstance(paragraph.body_text, str):
        raise TypeError(f"paragraph {paragraph.id!r} has a non-string body_text")


def map_transcript(rows: Sequence[TranscriptParagraph]) -> tuple[MappingResult, ...]:
    """Map one complete transcript, resetting state at the transcript boundary."""

    if not rows:
        return ()
    for row in rows:
        _validate_paragraph(row)

    transcript_ids = {row.transcript_id for row in rows}
    if len(transcript_ids) != 1:
        raise TranscriptOrderError("map_transcript received more than one transcript_id")
    transcript_id = next(iter(transcript_ids))
    if transcript_id is None and len(rows) != 1:
        raise TranscriptOrderError("rows without transcript_id must be mapped in isolation")

    paragraph_ids: set[str] = set()
    paragraph_numbers: set[int] = set()
    for row in rows:
        if row.id in paragraph_ids:
            raise TranscriptOrderError(f"duplicate paragraph id {row.id!r}")
        if row.paragraph_number in paragraph_numbers:
            raise TranscriptOrderError(
                f"duplicate paragraph_number {row.paragraph_number!r} in transcript {transcript_id!r}"
            )
        paragraph_ids.add(row.id)
        paragraph_numbers.add(row.paragraph_number)

    ordered_rows = sorted(rows, key=lambda item: (item.paragraph_number, item.id))
    if transcript_id is not None and ordered_rows[0].paragraph_number != 1:
        raise TranscriptOrderError(
            f"transcript {transcript_id!r} starts at paragraph "
            f"{ordered_rows[0].paragraph_number!r}, not 1"
        )
    for previous, current in zip(ordered_rows, ordered_rows[1:]):
        if current.paragraph_number != previous.paragraph_number + 1:
            raise TranscriptOrderError(
                f"transcript {transcript_id!r} has a paragraph-number gap "
                f"between {previous.paragraph_number!r} and "
                f"{current.paragraph_number!r}"
            )

    active_speaker: str | None = None
    results: list[MappingResult] = []
    for row in ordered_rows:
        result, active_speaker = _map_paragraph(
            row,
            active_speaker,
        )
        results.append(result)
    return tuple(results)


def map_transcripts(rows: Iterable[TranscriptParagraph]) -> tuple[MappingResult, ...]:
    """Map complete transcripts in a canonical order independent of input order."""

    grouped: dict[tuple[int, str], list[TranscriptParagraph]] = defaultdict(list)
    seen_ids: set[str] = set()
    for row in rows:
        _validate_paragraph(row)
        if row.id in seen_ids:
            raise TranscriptOrderError(f"duplicate paragraph id {row.id!r}")
        seen_ids.add(row.id)
        key = (0, row.transcript_id) if row.transcript_id is not None else (1, row.id)
        grouped[key].append(row)

    results: list[MappingResult] = []
    for key in sorted(grouped):
        results.extend(map_transcript(grouped[key]))
    return tuple(results)


def _row_from_record(record: Mapping[str, object]) -> TranscriptParagraph:
    required = ("id", "transcript_id", "paragraph_number", "body_text")
    missing = [key for key in required if key not in record]
    if missing:
        raise KeyError(f"missing required transcript paragraph fields: {', '.join(missing)}")
    return TranscriptParagraph(
        id=record["id"],  # type: ignore[arg-type]
        transcript_id=record["transcript_id"],  # type: ignore[arg-type]
        paragraph_number=record["paragraph_number"],  # type: ignore[arg-type]
        body_text=record["body_text"],  # type: ignore[arg-type]
    )


def map_corpus(
    rows: Iterable[dict[str, object]],
) -> tuple[list[MappingResult], CorpusStats]:
    """Map database-shaped rows and return JSON-ready results plus dry-run counts.

    Input records must contain ``id``, ``transcript_id``, ``paragraph_number``,
    and ``body_text``. Additional fields are ignored and cannot influence the
    attribution.
    """

    paragraphs = [_row_from_record(row) for row in rows]
    results = list(map_transcripts(paragraphs))
    non_null_transcripts = {row.transcript_id for row in paragraphs if row.transcript_id is not None}
    null_transcript_rows = sum(row.transcript_id is None for row in paragraphs)
    modes = [set(result.evidence_modes) for result in results]
    stats = CorpusStats(
        processed_paragraphs=len(results),
        processed_transcripts=len(non_null_transcripts) + null_transcript_rows,
        explicit_paragraphs=sum("explicit" in row_modes for row_modes in modes),
        inherited_paragraphs=sum("inherited" in row_modes for row_modes in modes),
        mixed_paragraphs=sum("mixed" in row_modes for row_modes in modes),
        unknown_paragraphs=sum("unknown" in row_modes for row_modes in modes),
        suspicious_paragraphs=sum("suspicious" in row_modes for row_modes in modes),
    )
    return results, stats


def audited_exact_speaker_proofs(
    rows: Iterable[Mapping[str, object]],
    *,
    maximum_samples_per_label: int = 3,
) -> list[dict[str, object]]:
    """Freeze reviewable source pointers for every exact-name allowlist entry.

    The proof ledger deliberately excludes paragraph text. A paragraph ID,
    body hash, line number, and literal label bind each allowlist decision to
    the scanned corpus while keeping the approval artifact compact.
    """

    if maximum_samples_per_label < 1:
        raise ValueError("maximum_samples_per_label must be positive")
    counts = {label: 0 for label in sorted(_TRUSTED_EXACT_PERSON_LABELS)}
    samples: dict[str, list[dict[str, object]]] = {
        label: [] for label in counts
    }
    alias_to_registry = {
        alias: _fold(canonical)
        for alias, canonical in _CANONICAL_SPEAKER_ALIASES.items()
    }

    for raw_row in rows:
        paragraph = _row_from_record(raw_row)
        body_hash = sha256(paragraph.body_text.encode("utf-8")).hexdigest()
        normalized_body = paragraph.body_text.replace("\r\n", "\n").replace("\r", "\n")
        for line_number, line in enumerate(normalized_body.split("\n"), start=1):
            candidate_line = line.lstrip(" \t")
            separator = _find_label_separator(candidate_line)
            if separator is None:
                continue
            raw_label = _collapse_space(candidate_line[: separator[0]])
            split = re.sub(r"\s+(?:and)\s+", "|", raw_label, flags=re.IGNORECASE)
            split = re.sub(r"[,/&]", "|", split)
            parts = [_collapse_space(part) for part in split.split("|") if part.strip()]
            for part in parts:
                folded = _fold(part)
                registry_key = alias_to_registry.get(folded, folded)
                if registry_key not in counts:
                    continue
                proved = _trusted_speaker(part)
                if proved is None:
                    continue
                counts[registry_key] += 1
                if len(samples[registry_key]) >= maximum_samples_per_label:
                    continue
                samples[registry_key].append(
                    {
                        "bodySha256": body_hash,
                        "canonicalSpeaker": proved,
                        "lineNumber": line_number,
                        "paragraphId": paragraph.id,
                        "paragraphNumber": paragraph.paragraph_number,
                        "rawLabel": part,
                        "transcriptId": paragraph.transcript_id,
                    }
                )

    missing = [label for label, count in counts.items() if count == 0]
    if missing:
        raise ValueError(
            "exact speaker allowlist has no corpus proof for: " + ", ".join(missing)
        )
    return [
        {
            "foldedLabel": label,
            "occurrenceCount": counts[label],
            "proofKind": "audited_exact_allowlist",
            "samples": samples[label],
        }
        for label in sorted(counts)
    ]


def canonical_json(value: Any) -> str:
    """Serialize mapper records with stable keys, separators, and Unicode."""

    def json_ready(item: Any) -> Any:
        if isinstance(item, (MappingResult, CorpusStats)):
            return item.to_record()
        if is_dataclass(item):
            return json_ready(asdict(item))
        if isinstance(item, Mapping):
            return {str(key): json_ready(child) for key, child in item.items()}
        if isinstance(item, (list, tuple)):
            return [json_ready(child) for child in item]
        return item

    return json.dumps(
        json_ready(value),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
