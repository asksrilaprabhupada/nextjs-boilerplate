"""
tagging.py — the combined tagging + questions + passage_function pass
(Gemini Batch API).

ONE structured call per passage (v3.p2) returns ALL of:
  • passage_function — ONE primary value from the closed enum in
    config.PASSAGE_FUNCTIONS (incl. `not_applicable` for filler; hidden metadata;
    additive column; killable);
  • tags_core — flexible count up to config.MAX_TAGS, every tag constrained to
    the passage's candidate shortlist by a strict responseSchema enum, each with
    an `evidence_sentence_id`. ZERO tags is a valid answer; and
  • questions — 0-3 distinct questions the passage genuinely ANSWERS, each with an
    `evidence_sentence_id` — requested ONLY for Prabhupāda-speaking / HIS passages.
    Gating comes exclusively from provenance.json: NOT-HIS/MIXED-VERIFY rows get
    topic tags only, and their responseSchema omits questions entirely.

The request uses thinkingConfig.thinkingLevel=LOW (native reasoning replaces the
old free-text reasoning field) and the model-default temperature;
maxOutputTokens is a safety ceiling only.

EVIDENCE IS A SENTENCE ID, not copied text. The target passage is split by the
deterministic splitter (sentences.py, SPLITTER_VERSION) into numbered sentences
(S001, S002, …) shown in the prompt; the responseSchema constrains
`evidence_sentence_id` to a CLOSED ENUM of those ids, so the model cannot invent
or hallucinate a quote. Our code resolves the id back to the exact source
sentence + offsets for tag_evidence.

The candidate shortlist is a UNION: semantic top-SHORTLIST_SEMANTIC (pgvector)
∪ exact alias/lexical matches found in the passage ∪ the hard-negative partners
of anything shortlisted (the model always sees BOTH sides of a contrast pair),
capped ≈ SHORTLIST_CAP. Every candidate line carries the term's scope note and
its "do NOT confuse with" hard negatives.

verse_chunks are tagged DIRECTLY (v3.p2): the target chunk body is the numbered/
citable region; the parent-verse translation + adjacent chunks are un-numbered
CONTEXT; provenance (and questions_allowed) comes from the parent verse. There is
no parent→chunk inheritance step.

Code gates on every response (evidence is stored either way — tag_evidence):
  1. closed vocabulary: a tag not in vocabulary.json is dropped (HARD);
  2. evidence (SOFT): the returned sentence id is resolved to a target sentence.
     In-vocabulary tags whose id doesn't resolve are KEPT and flagged
     evidence_found=false; a resolved id stores the exact sentence + its offsets;
  3. questions: an unresolvable answer id DROPS the question (stricter than tags);
  4. passage_function outside the enum → NULL.

Batch mechanics (resumable; jobs run server-side up to 24h — close the script
after submission and rerun later to collect):
  • deterministic shard names ("pilot:verses:000", "transcript_paragraphs:w01:0003");
  • every shard's JSONL input is capped at config.MAX_SHARD_INPUT_TOKENS (2.5M);
    an oversized shard is split into token-bounded parts ("…:p00", "…:p01") so
    each job always fits our 3M enqueued-batch-token queue;
  • the pilot is PILOT_SIZE seeded-random passages, stratified by table
    (seed = config.SAMPLE_SEED, recorded in pilot-report.md);
  • Google job IDs recorded in tag_batch_jobs BEFORE any polling;
  • on restart, reconcile against Google's job list by display_name so
    accepted-but-unrecorded jobs are recovered, never resubmitted;
  • a shard is marked applied only after its whole write transaction commits;
  • MACHINE-ENFORCED cost ceiling: the submitter refuses to submit a shard
    once real+estimated spend would exceed config.MAX_SPEND_USD.
"""
from __future__ import annotations

import hashlib
import json
import re as stdre
import time
import unicodedata
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import build_vocabulary
import config
import db
import gemini_client
import provenance
import sentences as sentence_split

IN_FLIGHT = ("submitted", "running")
UNFINISHED = ("pending", "submitted", "running", "retrieved")

_QUOTE_MAP = {"‘": "'", "’": "'", "“": '"', "”": '"', "—": "-", "–": "-"}


# ── text folding + evidence gate ────────────────────────────────────────────

def fold_text_with_map(text: str) -> tuple[str, list[int]]:
    """Lenient fold for the evidence gate — lowercase, strip diacritics,
    normalize quotes/dashes, collapse whitespace — PLUS an index map from every
    folded character back to its character offset in the original text, so a
    match in folded space yields offsets into the passage as sent to Gemini.
    Deliberately looser than the display verbatim validator so valid tags
    aren't over-flagged."""
    out: list[str] = []
    mapping: list[int] = []
    pending_space = False
    for i, ch in enumerate(text or ""):
        for d in unicodedata.normalize("NFD", ch):
            if unicodedata.combining(d):
                continue
            for c in _QUOTE_MAP.get(d, d).lower():
                if c.isspace():
                    pending_space = True
                    continue
                if pending_space:
                    if out:
                        out.append(" ")
                        mapping.append(i)
                    pending_space = False
                out.append(c)
                mapping.append(i)
    return "".join(out), mapping


def fold_text(text: str) -> str:
    # Still used by the lexical shortlist lane (attach_shortlists / VocabIndex).
    # v3.p2 evidence no longer folds/searches quotes — it resolves sentence IDs
    # (see sentences.resolve_sentence), so the old substring evidence_ok is gone.
    return fold_text_with_map(text)[0]


# ── vocabulary index (shortlist union + prompt context) ─────────────────────

class VocabIndex:
    """Everything the tagging pass needs from the frozen vocabulary.json:
    slug lookup, the folded alias → slug map for the exact-lexical shortlist
    lane, and hard-negative partners for the contrast-pair union."""

    def __init__(self, vocabulary: dict) -> None:
        self.terms: list[dict] = vocabulary["terms"]
        self.term_by_slug: dict[str, dict] = {t["slug"]: t for t in self.terms}
        self.slugs: set[str] = set(self.term_by_slug)
        self.term_count: int = int(vocabulary.get("term_count") or len(self.terms))
        alias_map: dict[str, str] = {}
        for t in self.terms:
            for alias in [t["term"], *t.get("variants", [])]:
                folded = fold_text(alias)
                if len(folded) >= 3:
                    alias_map.setdefault(folded, t["slug"])
        self.alias_to_slug = alias_map
        if alias_map:
            pattern = "|".join(stdre.escape(a) for a in sorted(alias_map, key=len, reverse=True))
            self.alias_regex = stdre.compile(r"(?<![a-z0-9])(?:" + pattern + r")(?![a-z0-9])")
        else:
            self.alias_regex = None

    def lexical_slugs(self, folded_text: str) -> list[str]:
        if self.alias_regex is None:
            return []
        found: dict[str, None] = {}
        for m in self.alias_regex.finditer(folded_text):
            found.setdefault(self.alias_to_slug[m.group(0)], None)
        return list(found)

    def hard_negatives(self, slug: str) -> list[str]:
        term = self.term_by_slug.get(slug) or {}
        return [s for s in term.get("hard_negatives", []) if s in self.slugs]


def load_vocab_index() -> VocabIndex:
    return VocabIndex(build_vocabulary.load_vocabulary())


# ── passages ────────────────────────────────────────────────────────────────

@dataclass
class Passage:
    table: str
    id: str
    text: str                      # the TARGET text — the ONLY sentence-numbered / citable region
    authorship: str
    questions_allowed: bool
    shortlist: list[str] = field(default_factory=list)
    # v3.p2: un-numbered CONTEXT shown to the model for understanding only (verse
    # chunks carry their parent verse translation + adjacent chunks here). Never a
    # source of evidence — only `text` is split into citable sentences.
    context: str = ""


def _verse_text(translation: str | None, synonyms: str | None, purport: str | None) -> str:
    parts = []
    if translation:
        parts.append("TRANSLATION:\n" + translation)
    if synonyms:
        parts.append("SYNONYMS (word-for-word):\n" + synonyms)
    if purport:
        parts.append("PURPORT:\n" + purport)
    return "\n\n".join(parts)[: config.PASSAGE_CHAR_CAP]


def load_passages(table: str, ids: list[str]) -> list[Passage]:
    """Fetch text + provenance gating for a shard's rows. Gating uses ONLY the
    manifest (provenance.py); transcripts get the carry-forward speaker walk
    over each affected transcript's full paragraph sequence."""
    passages: list[Passage] = []
    if table == "verses":
        for row in db.rows(
            "SELECT v.id::text, v.translation, v.synonyms, v.purport, v.vedabase_url,"
            "       lower(coalesce(c.book_slug, v.scripture)), c.canto_or_division, c.chapter_number"
            " FROM public.verses v LEFT JOIN public.chapters c ON c.id = v.chapter_id"
            " WHERE v.id = ANY(%s::uuid[])",
            (ids,),
        ):
            vid, translation, synonyms, purport, url, slug, canto, chapter = row
            authorship = provenance.authorship_for_verse(slug, url, canto, chapter)
            passages.append(
                Passage(table, vid, _verse_text(translation, synonyms, purport),
                        authorship, provenance.questions_allowed(authorship))
            )
    elif table == "prose_paragraphs":
        for pid, body, slug in db.rows(
            "SELECT id::text, body_text, lower(coalesce(book_slug, ''))"
            " FROM public.prose_paragraphs WHERE id = ANY(%s::uuid[])",
            (ids,),
        ):
            authorship = provenance.authorship_for_prose(slug)
            passages.append(
                Passage(table, pid, (body or "")[: config.PASSAGE_CHAR_CAP],
                        authorship, provenance.questions_allowed(authorship))
            )
    elif table == "letter_paragraphs":
        authorship = provenance.authorship_for_letter()
        allowed = provenance.questions_allowed(authorship)
        for pid, body in db.rows(
            "SELECT id::text, body_text FROM public.letter_paragraphs WHERE id = ANY(%s::uuid[])",
            (ids,),
        ):
            passages.append(
                Passage(table, pid, (body or "")[: config.PASSAGE_CHAR_CAP], authorship, allowed)
            )
    elif table == "transcript_paragraphs":
        walker = provenance.TranscriptWalker()
        wanted = set(ids)
        by_transcript: dict[str, list[tuple[str, str]]] = {}
        for pid, tid, body in db.iter_rows(
            "SELECT p.id::text, coalesce(p.transcript_id::text, p.id::text), p.body_text"
            " FROM public.transcript_paragraphs p"
            " WHERE p.transcript_id IN ("
            "   SELECT DISTINCT transcript_id FROM public.transcript_paragraphs WHERE id = ANY(%s::uuid[]))"
            "   OR (p.transcript_id IS NULL AND p.id = ANY(%s::uuid[]))"
            " ORDER BY p.transcript_id, p.paragraph_number, p.id",
            (ids, ids),
        ):
            by_transcript.setdefault(tid, []).append((pid, body or ""))
        for ordered in by_transcript.values():
            for para in walker.walk(ordered):
                if para.paragraph_id not in wanted:
                    continue
                authorship = walker.authorship_for_paragraph(para)
                body = dict(ordered)[para.paragraph_id]
                passages.append(
                    Passage(table, para.paragraph_id, body[: config.PASSAGE_CHAR_CAP],
                            authorship, provenance.questions_allowed(authorship))
                )
    elif table == "verse_chunks":
        # v3.p2: chunks are Gemini-tagged DIRECTLY. The TARGET is the chunk body
        # (the only sentence-numbered / citable region); parent-verse translation
        # and the immediate previous/next chunks are un-numbered CONTEXT so the
        # model understands the target without tagging the neighbours. Provenance
        # (and thus questions_allowed) comes from the PARENT VERSE.
        targets = db.rows(
            "SELECT c.id::text, c.verse_id::text, c.chunk_number, c.body_text,"
            "       v.translation, lower(coalesce(ch.book_slug, v.scripture)),"
            "       v.vedabase_url, ch.canto_or_division, ch.chapter_number"
            " FROM public.verse_chunks c"
            " JOIN public.verses v ON v.id = c.verse_id"
            " LEFT JOIN public.chapters ch ON ch.id = v.chapter_id"
            " WHERE c.id = ANY(%s::uuid[])",
            (ids,),
        )
        verse_ids = sorted({r[1] for r in targets})
        siblings: dict[str, list[tuple[int, str]]] = {}
        if verse_ids:
            for vid, cnum, body in db.rows(
                "SELECT verse_id::text, chunk_number, body_text FROM public.verse_chunks"
                " WHERE verse_id = ANY(%s::uuid[]) ORDER BY verse_id, chunk_number",
                (verse_ids,),
            ):
                siblings.setdefault(vid, []).append((cnum, body or ""))
        for cid, vid, cnum, body, translation, slug, url, canto, chapter in targets:
            authorship = provenance.authorship_for_verse(slug, url, canto, chapter)
            ordered = siblings.get(vid, [])
            prev_body = next_body = ""
            for pos, (n, b) in enumerate(ordered):
                if n == cnum:
                    if pos > 0:
                        prev_body = ordered[pos - 1][1]
                    if pos + 1 < len(ordered):
                        next_body = ordered[pos + 1][1]
                    break
            ctx_parts = []
            if translation:
                ctx_parts.append("PARENT VERSE TRANSLATION:\n" + translation.strip())
            if prev_body:
                ctx_parts.append("PRECEDING CHUNK:\n" + prev_body.strip())
            if next_body:
                ctx_parts.append("FOLLOWING CHUNK:\n" + next_body.strip())
            context = "\n\n".join(ctx_parts)[: config.PASSAGE_CHAR_CAP]
            passages.append(
                Passage(table, cid, (body or "")[: config.PASSAGE_CHAR_CAP],
                        authorship, provenance.questions_allowed(authorship),
                        context=context)
            )
    else:
        raise SystemExit(f"FATAL: load_passages does not send table '{table}' to Gemini")
    return passages


def attach_shortlists(table: str, passages: list[Passage], vocab: VocabIndex) -> None:
    """Candidate UNION per passage: semantic top-SHORTLIST_SEMANTIC via
    pgvector ∪ exact alias matches found in the passage text ∪ the
    hard-negative partners of anything shortlisted. The union (before
    negatives) is capped at SHORTLIST_CAP; negatives are always added back so
    the model sees both sides of every contrast pair."""
    ids = [p.id for p in passages]
    semantic_by_id: dict[str, list[str]] = {}
    for pid, slugs in db.rows(
        f"SELECT p.id::text, ("
        f"   SELECT array_agg(sub.slug ORDER BY sub.dist) FROM ("
        f"     SELECT slug, embedding <=> p.embedding_context4 AS dist FROM public.vocab_terms"
        f"     WHERE embedding IS NOT NULL AND NOT is_ai"
        f"     ORDER BY embedding <=> p.embedding_context4 LIMIT %s) sub)"
        f" FROM public.{table} p"
        f" WHERE p.id = ANY(%s::uuid[]) AND p.embedding_context4 IS NOT NULL",
        (config.SHORTLIST_SEMANTIC, ids),
    ):
        semantic_by_id[pid] = list(slugs or [])
    for passage in passages:
        semantic = [s for s in semantic_by_id.get(passage.id, []) if s in vocab.slugs]
        if not semantic:
            passage.shortlist = []
            continue
        folded = fold_text(passage.text)
        in_semantic = set(semantic)
        lexical = sorted(s for s in vocab.lexical_slugs(folded) if s not in in_semantic)
        base = (semantic + lexical)[: config.SHORTLIST_CAP]
        seen = set(base)
        negatives: list[str] = []
        for slug in base:
            for neg in vocab.hard_negatives(slug):
                if neg not in seen:
                    seen.add(neg)
                    negatives.append(neg)
        passage.shortlist = base + negatives


# ── prompt + schema ─────────────────────────────────────────────────────────

def _evidence_id_schema(sentence_ids: list[str]) -> dict:
    """A sentence-id field. When the target has sentences it is a CLOSED ENUM of
    their ids (S001…) — the same mechanism that constrains tags to the shortlist,
    so the model cannot emit an out-of-range id. An empty target (no sentences)
    falls back to a bare STRING (the row will carry zero tags / not_applicable)."""
    if sentence_ids:
        return {"type": "STRING", "enum": sentence_ids}
    return {"type": "STRING"}


def response_schema(shortlist: list[str], questions_allowed: bool,
                    sentence_ids: list[str]) -> dict:
    """v3.p2: no free-text reasoning field (native LOW thinking replaces the
    reasoning-first format-tax trick). Evidence is a sentence ID drawn from the
    numbered TARGET sentences — never copied text."""
    ev = _evidence_id_schema(sentence_ids)
    properties: dict = {
        "passage_function": {"type": "STRING", "enum": config.PASSAGE_FUNCTIONS},
        "tags": {
            "type": "ARRAY",
            "maxItems": config.MAX_TAGS,
            "items": {
                "type": "OBJECT",
                "properties": {
                    "tag": {"type": "STRING", "enum": shortlist},
                    "evidence_sentence_id": ev,
                },
                "required": ["tag", "evidence_sentence_id"],
                "propertyOrdering": ["tag", "evidence_sentence_id"],
            },
        },
    }
    ordering = ["passage_function", "tags"]
    if questions_allowed:
        properties["questions"] = {
            "type": "ARRAY",
            "maxItems": config.MAX_QUESTIONS,
            "items": {
                "type": "OBJECT",
                "properties": {
                    "question": {"type": "STRING"},
                    "evidence_sentence_id": ev,
                },
                "required": ["question", "evidence_sentence_id"],
                "propertyOrdering": ["question", "evidence_sentence_id"],
            },
        }
        ordering.append("questions")
    return {
        "type": "OBJECT",
        "properties": properties,
        "required": ["passage_function", "tags"],
        "propertyOrdering": ordering,
    }


def _candidate_line(slug: str, vocab: VocabIndex) -> str:
    term = vocab.term_by_slug[slug]
    line = f"- {slug} — \"{term['term']}\" ({term['facet']})"
    note = (term.get("scope_note") or "").strip()
    if note:
        line += f". Scope: {note}"
    negatives = vocab.hard_negatives(slug)
    if negatives:
        names = ", ".join(f"{n} (\"{vocab.term_by_slug[n]['term']}\")" for n in negatives)
        line += f". Do NOT confuse with: {names}"
    return line


def build_prompt(passage: Passage, vocab: VocabIndex,
                 sents: list) -> str:
    candidates = "\n".join(
        _candidate_line(slug, vocab) for slug in passage.shortlist if slug in vocab.term_by_slug
    )
    functions = ", ".join(config.PASSAGE_FUNCTIONS)
    base = (
        "You are indexing a passage from Śrīla Prabhupāda's corpus for subject"
        " search.\n\nCANDIDATE TAGS (closed list — you may ONLY use these slugs;"
        " each shows its scope and what NOT to confuse it with):\n"
        f"{candidates}\n\nRULES:\n"
        "1. Tag ABOUTNESS only. Do NOT tag a subject the passage merely mentions"
        " in passing, quotes from an opponent, or explicitly REJECTS (a passage"
        " arguing against a view is not endorsing it). Choose the MOST SPECIFIC"
        " fitting concepts; do not pad with broad ancestors. Tag a Person, Place"
        " or Scripture only when it is PROMINENT in the passage, never on a"
        " stray mention. ZERO tags is a valid answer — filler or small talk may"
        f" be about nothing; never force tags. Never more than {config.MAX_TAGS}.\n"
        "2. For EACH tag, set `evidence_sentence_id` to the ID (e.g. S002) of the"
        " ONE TARGET sentence that best shows the passage is about that subject."
        " Use ONLY the numbered sentence IDs below — never invent one, never copy"
        " text.\n"
        "3. `passage_function`: the ONE primary thing this passage DOES, from:"
        f" {functions}. Use `not_applicable` for filler, headings, salutations,"
        " or empty/structural content that does nothing doctrinally.\n"
    )
    if passage.questions_allowed:
        base += (
            f"4. `questions`: the 0-{config.MAX_QUESTIONS} DISTINCT questions a"
            " person might sincerely ask that THIS passage genuinely ANSWERS."
            " For each, `evidence_sentence_id` = the ID of the TARGET sentence"
            " that contains the answer. NEVER write a question whose answer needs"
            " outside facts, is only an inference, is far broader than the"
            " passage, or would present a view the passage rejects or negates as"
            " if endorsed. ZERO questions is a valid answer.\n"
        )
    else:
        base += (
            "4. This passage is NOT Śrīla Prabhupāda's own words — return"
            " passage_function and topic tags only.\n"
        )
    if passage.context:
        base += (
            "\nCONTEXT (for understanding only — do NOT cite it; it has no"
            " sentence IDs and its subject is not necessarily the TARGET's):\n"
            + passage.context
        )
    return (
        base
        + "\n\nTARGET PASSAGE (tag/answer ONLY what THIS is about; cite evidence by"
        " its sentence ID):\n"
        + sentence_split.render_numbered(sents)
    )


def request_line(passage: Passage, vocab: VocabIndex) -> dict:
    sents = sentence_split.split_sentences(passage.text)
    return {
        "key": f"{passage.table}|{passage.id}",
        "request": {
            "contents": [{"parts": [{"text": build_prompt(passage, vocab, sents)}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": response_schema(
                    passage.shortlist, passage.questions_allowed,
                    sentence_split.sentence_ids(sents),
                ),
                "thinkingConfig": {"thinkingLevel": config.THINKING_LEVEL},
                "maxOutputTokens": config.MAX_OUTPUT_TOKENS,
            },
        },
    }


# ── shard planning (deterministic names, persisted before submission) ───────

# p1 pilot shards used the bare "pilot:" prefix; p2 uses config.PILOT_SHARD_PREFIX
# ("pilot:p2:"). This LIKE-pair selects the FROZEN p1 shards only.
_P1_PILOT_LIKE = "pilot:%"
# Tables p1 actually tagged (verse_chunks were never sent in p1).
_P1_TABLES = ["verses", "transcript_paragraphs", "prose_paragraphs", "letter_paragraphs"]


def _len_expr(table: str) -> str:
    """Per-table char-length expression for the length-quartile stratification."""
    if table == "verses":
        return "length(coalesce(t.translation,'') || coalesce(t.purport,''))"
    return "length(coalesce(t.body_text,''))"


def _largest_remainder(total: int, weights: dict[str, float]) -> dict[str, int]:
    """Apportion `total` across keys ∝ weights, summing EXACTLY to `total`
    (largest-remainder method; deterministic tie-break by key)."""
    keys = [k for k in weights if weights[k] > 0]
    if total <= 0 or not keys:
        return {k: 0 for k in weights}
    s = sum(weights[k] for k in keys)
    raw = {k: total * weights[k] / s for k in keys}
    alloc = {k: int(raw[k]) for k in keys}
    rem = total - sum(alloc.values())
    order = sorted(keys, key=lambda k: (-(raw[k] - int(raw[k])), k))
    for k in order[:rem]:
        alloc[k] += 1
    return {k: alloc.get(k, 0) for k in weights}


def _p1_pilot_ids() -> list[str]:
    """Every id in the frozen p1 pilot shards (for the fresh-stratum exclusion)."""
    return [
        r[0]
        for r in db.rows(
            "SELECT DISTINCT unnest(id_list)::text FROM public.tag_batch_jobs"
            " WHERE shard_key LIKE %s AND shard_key NOT LIKE %s",
            (_P1_PILOT_LIKE, config.PILOT_SHARD_PREFIX + "%"),
        )
    ]


def _pilot_forced_failed_ids() -> dict[str, list[str]]:
    """All p1-failed passages = p1 pilot ids whose content row never got tagged
    (tags_core IS NULL). These are re-sent in full so p2 re-attempts every failure."""
    out: dict[str, list[str]] = {}
    for table in _P1_TABLES:
        ids = [
            r[0]
            for r in db.rows(
                "WITH p1 AS (SELECT unnest(id_list)::uuid AS id FROM public.tag_batch_jobs"
                "            WHERE shard_key LIKE %s AND shard_key NOT LIKE %s AND table_name=%s)"
                f" SELECT t.id::text FROM public.{table} t JOIN p1 ON p1.id=t.id"
                " WHERE t.tags_core IS NULL ORDER BY t.id",
                (_P1_PILOT_LIKE, config.PILOT_SHARD_PREFIX + "%", table),
            )
        ]
        if ids:
            out[table] = ids
    return out


def _pilot_success_slice_ids(target: int, failure_mix: dict[str, int]) -> dict[str, list[str]]:
    """A p1-SUCCESS comparison slice (rows p1 tagged, tags_core NOT NULL),
    apportioned across tables to mirror the failure table mix and, within each
    table, spread across the four length quartiles — so p2 can be compared to p1
    on similar-profile passages. Seeded-random within each (table, quartile)."""
    if target <= 0 or not failure_mix:
        return {}
    per_table = _largest_remainder(target, {t: float(n) for t, n in failure_mix.items()})
    out: dict[str, list[str]] = {}
    bands = max(1, config.PILOT_LENGTH_BANDS)
    for table, want in per_table.items():
        if want <= 0:
            continue
        per_band = _largest_remainder(want, {str(q): 1.0 for q in range(1, bands + 1)})
        picked: list[str] = []
        for q in range(1, bands + 1):
            k = per_band.get(str(q), 0)
            if k <= 0:
                continue
            picked += [
                r[0]
                for r in db.rows(
                    "WITH p1 AS (SELECT unnest(id_list)::uuid AS id FROM public.tag_batch_jobs"
                    "            WHERE shard_key LIKE %s AND shard_key NOT LIKE %s AND table_name=%s),"
                    f" pool AS (SELECT t.id::text AS id, ntile(%s) OVER (ORDER BY {_len_expr(table)}) AS q"
                    f"          FROM public.{table} t JOIN p1 ON p1.id=t.id WHERE t.tags_core IS NOT NULL)"
                    " SELECT id FROM pool WHERE q=%s ORDER BY md5(%s || id) LIMIT %s",
                    (_P1_PILOT_LIKE, config.PILOT_SHARD_PREFIX + "%", table, bands, q, config.SAMPLE_SEED, k),
                )
            ]
        if picked:
            out[table] = picked
    return out


def _pilot_fresh_stratified_ids(exclude_ids: list[str], remaining: int) -> dict[str, list[str]]:
    """The FRESH remainder — untagged, embeddable rows across ALL FIVE tables
    (incl. verse_chunks), excluding every p1 pilot id, stratified by table
    (∝ live untagged counts) AND length quartile, largest-remainder, seeded-random."""
    if remaining <= 0:
        return {}
    live = {
        t: db.table_count(t, "tags_core IS NULL AND embedding_context4 IS NOT NULL")
        for t in config.GEMINI_TABLES
    }
    per_table = _largest_remainder(remaining, {t: float(n) for t, n in live.items()})
    exclude = exclude_ids or ["00000000-0000-0000-0000-000000000000"]
    bands = max(1, config.PILOT_LENGTH_BANDS)
    out: dict[str, list[str]] = {}
    for table, want in per_table.items():
        if want <= 0:
            continue
        per_band = _largest_remainder(want, {str(q): 1.0 for q in range(1, bands + 1)})
        picked: list[str] = []
        for q in range(1, bands + 1):
            k = per_band.get(str(q), 0)
            if k <= 0:
                continue
            picked += [
                r[0]
                for r in db.rows(
                    f"WITH pool AS (SELECT t.id::text AS id, ntile(%s) OVER (ORDER BY {_len_expr(table)}) AS q"
                    f"              FROM public.{table} t"
                    "               WHERE t.tags_core IS NULL AND t.embedding_context4 IS NOT NULL"
                    "                 AND t.id <> ALL(%s::uuid[]))"
                    " SELECT id FROM pool WHERE q=%s ORDER BY md5(%s || id) LIMIT %s",
                    (bands, exclude, q, config.SAMPLE_SEED, k),
                )
            ]
        if picked:
            out[table] = picked
    return out


def plan_pilot_shards(run_id: str) -> None:
    """Build the EXACT v3.p2 pilot manifest (config.PILOT_SIZE rows), shard it
    under config.PILOT_SHARD_PREFIX, and record a checksum + cohort sizes in
    tag_runs.config. Composition: ALL p1-failures + a p1-success comparison slice
    (matched to the failure table mix + length quartile) + a fresh remainder
    stratified across all five tables × length quartiles by largest-remainder."""
    prefix = config.PILOT_SHARD_PREFIX
    if db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", (prefix + "%",)):
        print("  p2 pilot shards already planned.", flush=True)
        return

    failed = _pilot_forced_failed_ids()
    n_failed = sum(len(v) for v in failed.values())
    slice_target = max(0, min(config.PILOT_SUCCESS_SLICE, config.PILOT_SIZE - n_failed))
    success = _pilot_success_slice_ids(slice_target, {t: len(ids) for t, ids in failed.items()})
    n_success = sum(len(v) for v in success.values())
    remaining = max(0, config.PILOT_SIZE - n_failed - n_success)
    fresh = _pilot_fresh_stratified_ids(_p1_pilot_ids(), remaining)
    n_fresh = sum(len(v) for v in fresh.values())

    picked: dict[str, list[str]] = {t: [] for t in config.GEMINI_TABLES}
    for cohort in (failed, success, fresh):
        for table, ids in cohort.items():
            picked.setdefault(table, []).extend(ids)

    manifest: list[tuple[str, str]] = []  # (table, id) — the checksum basis
    for table in config.GEMINI_TABLES:
        ids = sorted(set(picked.get(table, [])))
        if not ids:
            continue
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(f"{prefix}{table}:{index // config.SHARD_SIZE:03d}", table, chunk, run_id)
        manifest += [(table, i) for i in ids]

    checksum = "sha256:" + hashlib.sha256(
        "\n".join(f"{t}|{i}" for t, i in sorted(manifest)).encode("utf-8")
    ).hexdigest()[:32]
    cohorts = {"p1_failed": n_failed, "p1_success_slice": n_success, "fresh": n_fresh}
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_runs SET config = config || %s::jsonb WHERE id=%s::uuid",
            (json.dumps({
                "pilot_manifest_sha256": checksum,
                "pilot_cohorts": cohorts,
                "pilot_rows": len(manifest),
            }), run_id),
        )
    print(
        f"  p2 pilot planned: {len(manifest)} passages "
        f"(failed {n_failed} + success-slice {n_success} + fresh {n_fresh}); "
        f"seed {config.SAMPLE_SEED!r}; manifest {checksum}.",
        flush=True,
    )


def plan_pilot_retry(run_id: str) -> int:
    """Plan ONE retry generation for every schema-invalid p2 pilot row (from the
    banked first-pass files). Retry shards live under the pilot prefix
    ({prefix}retry:{table}:NNN) so they join the pilot stats + file glob. Guarded:
    if any retry shard already exists this is a no-op (a resume never re-retries)."""
    prefix = config.PILOT_SHARD_PREFIX
    if db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", (prefix + "retry:%",)):
        print("  pilot retry shards already planned.", flush=True)
        return 0
    by_table = failed_keys_from_files(prefix)
    planned = 0
    for table, ids in by_table.items():
        ids = sorted(set(ids))
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(f"{prefix}retry:{table}:{index // config.SHARD_SIZE:03d}", table, chunk, run_id)
            planned += 1
    total = sum(len(v) for v in by_table.values())
    if total:
        print(f"  planned retry for {total} schema-invalid pilot row(s) in {planned} shard(s).", flush=True)
    return total


def failed_keys_from_files(shard_key_prefix: str | None = None) -> dict[str, list[str]]:
    """Re-parse the banked pilot result files and return, per table, the passage
    ids whose first-attempt response was schema-invalid (error or unparsed)."""
    if shard_key_prefix is None:
        shard_key_prefix = config.PILOT_SHARD_PREFIX
    pattern = f"{shard_key_prefix.replace(':', '_')}*.results.jsonl"
    by_table: dict[str, list[str]] = {}
    for path in sorted(config.SHARDS_DIR.glob(pattern)):
        # Skip already-retried shard files so we don't retry a retry.
        if ".retry" in path.name or "_retry_" in path.name:
            continue
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                key, parsed, _usage, error, _fr, _br = _parse_response_line(line)
                if not key or "|" not in key:
                    continue
                if error or parsed is None:
                    table, pid = key.split("|", 1)
                    by_table.setdefault(table, []).append(pid)
    return by_table


def plan_full_shards(run_id: str) -> int:
    """Plan a wave of full-run shards over every remaining untagged,
    embeddable row not already covered by a live shard. Wave numbering keeps
    names deterministic across restarts. Returns shards planned."""
    wave = int(
        db.one(
            r"SELECT coalesce(max((regexp_match(shard_key, ':w(\d+):'))[1]::int), 0) + 1"
            r" FROM public.tag_batch_jobs WHERE shard_key ~ ':w\d+:'"
        )
        or 1
    )
    planned = 0
    for table in config.GEMINI_TABLES:
        # v3.p2: coverage is scoped to THIS run's shards (run_id), NOT `tags_core
        # IS NULL`, so a p2 full run retags every eligible row — including the
        # ~1,722 rows p1's pilot wrote — superseding the defective p1 pass. Rows
        # already covered by a non-failed p2 shard (e.g. the p2 pilot) are skipped.
        ids = [
            r[0]
            for r in db.rows(
                f"WITH covered AS ("
                f"   SELECT DISTINCT unnest(id_list) AS id FROM public.tag_batch_jobs"
                f"   WHERE run_id = %s::uuid AND status <> 'failed')"
                f" SELECT t.id::text FROM public.{table} t"
                f" LEFT JOIN covered c ON c.id = t.id"
                f" WHERE t.embedding_context4 IS NOT NULL AND c.id IS NULL"
                f" ORDER BY t.id",
                (run_id,),
            )
        ]
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(
                f"{table}:w{wave:02d}:{index // config.SHARD_SIZE:04d}", table, chunk, run_id
            )
            planned += 1
    if planned:
        print(f"  planned {planned} full-run shards (wave {wave}).", flush=True)
    return planned


def _insert_shard(shard_key: str, table: str, ids: list[str], run_id: str) -> None:
    with db.get_pg().cursor() as cur:
        cur.execute(
            "INSERT INTO public.tag_batch_jobs (shard_key, table_name, id_list, row_count, run_id)"
            " VALUES (%s, %s, %s::uuid[], %s, %s::uuid) ON CONFLICT (shard_key) DO NOTHING",
            (shard_key, table, ids, len(ids), run_id),
        )


def remaining_for_run(run_id: str) -> int:
    """Eligible rows this run has NOT yet covered (run_id-scoped, matching
    plan_full_shards). Used by the full run to decide when it is complete."""
    total = 0
    for table in config.GEMINI_TABLES:
        total += int(
            db.one(
                f"WITH covered AS (SELECT DISTINCT unnest(id_list) AS id"
                f"  FROM public.tag_batch_jobs WHERE run_id=%s::uuid AND status <> 'failed')"
                f" SELECT count(*) FROM public.{table} t LEFT JOIN covered c ON c.id=t.id"
                f" WHERE t.embedding_context4 IS NOT NULL AND c.id IS NULL",
                (run_id,),
            )
            or 0
        )
    return total


# ── cost ledger (machine-enforced ceiling) ──────────────────────────────────

def _usd(input_tok: float, output_tok: float) -> float:
    return (
        input_tok / 1e6 * config.GEMINI_BATCH_PRICE_IN_PER_M
        + output_tok / 1e6 * config.GEMINI_BATCH_PRICE_OUT_PER_M
    )


def spend_ledger() -> dict:
    real_in, real_out = db.rows(
        "SELECT coalesce(sum(cost_input_tok),0), coalesce(sum(cost_output_tok),0)"
        " FROM public.tag_batch_jobs WHERE status IN ('retrieved','applied')"
    )[0]
    est_in, est_out = db.rows(
        "SELECT coalesce(sum(est_input_tok),0), coalesce(sum(est_output_tok),0)"
        " FROM public.tag_batch_jobs WHERE status IN ('submitted','running')"
    )[0]
    return {
        "real_usd": _usd(float(real_in), float(real_out)),
        "in_flight_est_usd": _usd(float(est_in), float(est_out)),
        "committed_usd": _usd(float(real_in) + float(est_in), float(real_out) + float(est_out)),
    }


def measured_output_tokens_per_row() -> float:
    row = db.rows(
        "SELECT coalesce(sum(cost_output_tok),0), coalesce(sum(row_count),0)"
        " FROM public.tag_batch_jobs WHERE status IN ('retrieved','applied') AND cost_output_tok > 0"
    )[0]
    total_out, total_rows = float(row[0]), float(row[1])
    if total_rows > 0 and total_out > 0:
        return total_out / total_rows
    return float(config.EST_OUTPUT_TOKENS_PER_PASSAGE)


# ── submission ──────────────────────────────────────────────────────────────

@dataclass
class ShardPart:
    """One submittable batch job: a shard, or one token-bounded slice of a shard
    that was too large for the queue and got split."""
    shard_key: str
    rows: int
    est_in: int
    est_out: int


def _est_tokens(raw: str) -> int:
    return len(raw) // 4  # chars/4 ≈ tokens; includes schema+enum overhead


def _build_request_lines(
    table: str, ids: list[str], vocab: VocabIndex
) -> tuple[list[tuple[str, str, int]], list[str]]:
    """Load a shard's rows and return (lines, skipped_ids). `lines` is one
    (passage_id, raw_json, est_in_tokens) per USABLE passage (one with a
    candidate shortlist); `skipped_ids` are rows dropped for a missing
    embedding/shortlist (never sent, but still counted as covered)."""
    passages = load_passages(table, ids)
    attach_shortlists(table, passages, vocab)
    lines: list[tuple[str, str, int]] = []
    skipped_ids: list[str] = []
    for passage in passages:
        if not passage.shortlist:
            skipped_ids.append(passage.id)
            continue
        raw = json.dumps(request_line(passage, vocab), ensure_ascii=False)
        lines.append((passage.id, raw, _est_tokens(raw)))
    return lines, skipped_ids


def _pack_parts(lines: list[tuple[str, str, int]]) -> list[list[tuple[str, str, int]]]:
    """Greedy-pack request lines into parts whose summed input tokens each stay
    ≤ config.MAX_SHARD_INPUT_TOKENS, so every submitted job fits the batch queue.
    A single line larger than the cap (never happens under PASSAGE_CHAR_CAP) is
    given its own part rather than dropped. Input order is preserved."""
    parts: list[list[tuple[str, str, int]]] = []
    current: list[tuple[str, str, int]] = []
    current_tok = 0
    for line in lines:
        tok = line[2]
        if current and current_tok + tok > config.MAX_SHARD_INPUT_TOKENS:
            parts.append(current)
            current, current_tok = [], 0
        current.append(line)
        current_tok += tok
    if current:
        parts.append(current)
    return parts


def _write_part_file(shard_key: str, lines: list[tuple[str, str, int]]) -> ShardPart:
    """Write shards/<key>.requests.jsonl for one packed part."""
    config.SHARDS_DIR.mkdir(parents=True, exist_ok=True)
    est_in = 0
    with open(shard_request_path(shard_key), "w", encoding="utf-8", newline="\n") as f:
        for _pid, raw, tok in lines:
            est_in += tok
            f.write(raw + "\n")
    est_out = int(len(lines) * measured_output_tokens_per_row())
    return ShardPart(shard_key, len(lines), est_in, est_out)


def build_shard_parts(
    shard_key: str, table: str, ids: list[str], vocab: VocabIndex, run_id: str | None
) -> list[ShardPart]:
    """Build the request JSONL for a pending shard, capping every job's input at
    config.MAX_SHARD_INPUT_TOKENS so it always fits the 3M batch queue. A shard
    whose built requests fit the cap is written as-is and returned unchanged. An
    OVERSIZED shard is split into token-bounded parts: the pending row is
    transactionally replaced by one pending row per part (deterministic keys
    '<shard_key>:p00', ':p01', …), each part's file is written, and the parts are
    returned in order. The union of the parts' id_lists equals the original
    id_list — rows with no shortlist ride along on the first part — so coverage
    and reconciliation are unchanged. Returns [] when the shard has no usable
    rows (the caller fails it). Idempotent on rerun: an already-split part fits
    the cap and is returned without re-splitting."""
    lines, skipped_ids = _build_request_lines(table, ids, vocab)
    if skipped_ids:
        print(
            f"    {shard_key}: {len(skipped_ids)} rows have no shortlist"
            " (missing embedding) — skipped",
            flush=True,
        )
    if not lines:
        return []
    parts = _pack_parts(lines)
    if len(parts) == 1:
        return [_write_part_file(shard_key, parts[0])]

    # Oversized shard → split. Repartition the DB row atomically FIRST; on a crash
    # after the commit the pending part rows rebuild idempotently (each part
    # already fits the cap, so no further split), and coverage is preserved.
    part_keys = [f"{shard_key}:p{i:02d}" for i in range(len(parts))]
    part_id_lists = [[pid for pid, _raw, _tok in part] for part in parts]
    part_id_lists[0].extend(skipped_ids)  # keep union(id_list) == original id_list
    conn = db.get_pg()
    with conn.transaction():
        with conn.cursor() as cur:
            cur.execute("DELETE FROM public.tag_batch_jobs WHERE shard_key=%s", (shard_key,))
            for part_key, part_ids in zip(part_keys, part_id_lists):
                cur.execute(
                    "INSERT INTO public.tag_batch_jobs"
                    " (shard_key, table_name, id_list, row_count, run_id)"
                    " VALUES (%s, %s, %s::uuid[], %s, %s::uuid)",
                    (part_key, table, part_ids, len(part_ids), run_id),
                )
    print(
        f"  split {shard_key}: {len(lines)} requests exceed the"
        f" {config.MAX_SHARD_INPUT_TOKENS / 1e6:.1f}M-token cap →"
        f" {len(parts)} parts",
        flush=True,
    )
    return [_write_part_file(part_key, part) for part_key, part in zip(part_keys, parts)]


def shard_request_path(shard_key: str) -> Path:
    return config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.requests.jsonl"


# ── batch-queue quota: patient waiting instead of crashing on 429 ────────────
#
# The Gemini Batch API caps how many jobs may sit queued at once. When that
# ceiling is hit, create_batch returns HTTP 429 RESOURCE_EXHAUSTED. Rather than
# crash a long unattended run, we WAIT: poll the already-submitted jobs every
# QUEUE_QUOTA_POLL_SECONDS; the moment any reaches a terminal state it frees a
# queue slot, so the failed create is retried. Applied across the whole shard
# list, a large run drains the queue in waves. Give up only after
# QUEUE_QUOTA_GIVE_UP_SECONDS of no job finishing to free a slot.
QUEUE_QUOTA_POLL_SECONDS = 300           # 5 minutes between poll cycles
QUEUE_QUOTA_GIVE_UP_SECONDS = 24 * 3600  # 24h of no progress → give up


def _poll_queue_quota(already_terminal: set[str]) -> bool:
    """Sleep one poll cycle, then report the state of every already-submitted
    job. Returns True if a NEW job reached a terminal state since the last cycle
    (a queue slot was freed → the create is worth retrying). Mutates
    `already_terminal` with any newly-terminal job ids. Prints exactly one status
    line: jobs running / done / shards still pending."""
    time.sleep(QUEUE_QUOTA_POLL_SECONDS)
    submitted = db.rows(
        "SELECT provider_job_id FROM public.tag_batch_jobs"
        " WHERE status = 'submitted' AND provider_job_id IS NOT NULL"
    )
    pending = db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE status = 'pending'")
    running = done = 0
    freed = False
    for (job_id,) in submitted:
        try:
            job = gemini_client.get_batch(job_id)
        except Exception:  # noqa: BLE001 — a poll blip must not abort the wait
            running += 1
            continue
        if job["state"] in gemini_client.TERMINAL_STATES or job["done"]:
            done += 1
            if job_id not in already_terminal:
                already_terminal.add(job_id)
                freed = True
        else:
            running += 1
    print(
        f"  ⏳ batch queue full — {running} job(s) running, {done} done,"
        f" {pending} shard(s) still pending; polling again in"
        f" {QUEUE_QUOTA_POLL_SECONDS // 60}m…",
        flush=True,
    )
    return freed


def _create_batch_draining_queue(
    model: str, file_name: str, display_name: str, shard_key: str, already_terminal: set[str]
) -> str:
    """gemini_client.create_batch, but patient about a full batch queue. On HTTP
    429 (queue quota exhausted) it waits for a submitted job to finish and free a
    slot instead of crashing; every other error re-raises immediately. Gives up
    only after QUEUE_QUOTA_GIVE_UP_SECONDS with no job freeing a slot."""
    no_progress_deadline = time.monotonic() + QUEUE_QUOTA_GIVE_UP_SECONDS
    while True:
        try:
            return db.with_retry(
                lambda: gemini_client.create_batch(model, file_name, display_name),
                f"batch create {shard_key}",
            )
        except gemini_client.GeminiHTTPError as exc:
            if exc.status != 429:
                raise
        if _poll_queue_quota(already_terminal):
            no_progress_deadline = time.monotonic() + QUEUE_QUOTA_GIVE_UP_SECONDS
        elif time.monotonic() >= no_progress_deadline:
            raise SystemExit(
                "FATAL: the Gemini batch queue has been full for 24h with no job"
                " finishing to free a slot — cannot submit further shards now."
                " Rerun `python run_all.py --resume` once jobs drain to continue"
                " where this left off (already-submitted work is safe in the DB)."
            )


def _submit_one(model: str, part: ShardPart, queue_terminal_seen: set[str]) -> bool:
    """Upload + create one shard's batch job, recording it BEFORE any polling.
    Returns False (submitting nothing) when the cost ceiling would be exceeded so
    the caller stops submitting further shards. A full batch queue does NOT stop
    the run: _create_batch_draining_queue waits for a slot to free."""
    shard_key = part.shard_key
    ledger = spend_ledger()
    projected = ledger["committed_usd"] + _usd(part.est_in, part.est_out)
    if projected > config.MAX_SPEND_USD:
        print(
            f"  ⛔ COST CEILING: submitting {shard_key} would commit"
            f" ~${projected:,.2f} > MAX_SPEND_USD=${config.MAX_SPEND_USD:,.2f}."
            " Refusing to submit further shards (collection continues)."
            " Raise MAX_SPEND_USD in .env only after reviewing spend.",
            flush=True,
        )
        return False
    display_name = f"{config.BATCH_DISPLAY_PREFIX}:{shard_key}"
    file_name = db.with_retry(
        lambda: gemini_client.upload_jsonl(shard_request_path(shard_key), display_name),
        f"upload {shard_key}",
    )
    job_name = _create_batch_draining_queue(
        model, file_name, display_name, shard_key, queue_terminal_seen
    )
    # Record BEFORE polling — a crash after this line is recoverable from the DB
    # alone; a crash before it is recovered by reconcile().
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_batch_jobs SET provider_job_id=%s, status='submitted',"
            " submitted_at=%s, est_input_tok=%s, est_output_tok=%s, row_count=%s"
            " WHERE shard_key=%s",
            (job_name, datetime.now(timezone.utc), part.est_in, part.est_out, part.rows, shard_key),
        )
    print(f"  submitted {shard_key} → {job_name} (~{part.est_in / 1e6:.2f}M in tok)", flush=True)
    return True


def submit_pending(model: str, vocab: VocabIndex) -> None:
    """Submit pending shards while the ceiling allows. Job IDs are recorded in
    tag_batch_jobs immediately on acceptance — BEFORE any polling. A full batch
    queue (HTTP 429) does not crash the run: it waits for in-flight jobs to drain
    a slot, so a large shard list submits in waves, unattended. Any shard whose
    built requests exceed config.MAX_SHARD_INPUT_TOKENS is split into
    token-bounded parts (build_shard_parts) so every job fits the 3M queue."""
    pending = db.rows(
        "SELECT shard_key, table_name, id_list::text[], run_id::text FROM public.tag_batch_jobs"
        " WHERE status = 'pending' ORDER BY shard_key"
    )
    # Shared across every shard's wait so completions during one shard's wait
    # aren't miscounted as fresh progress for the next.
    queue_terminal_seen: set[str] = set()
    for shard_key, table, ids, run_id in pending:
        parts = build_shard_parts(shard_key, table, ids, vocab, run_id)
        if not parts:
            # No usable rows: the original (unsplit) row is still present to fail.
            with db.get_pg().cursor() as cur:
                cur.execute(
                    "UPDATE public.tag_batch_jobs SET status='failed',"
                    " error='no usable rows (missing embeddings)' WHERE shard_key=%s",
                    (shard_key,),
                )
            continue
        for part in parts:
            if not _submit_one(model, part, queue_terminal_seen):
                return  # cost ceiling reached — remaining parts stay pending


def reconcile() -> None:
    """Recover accepted-but-unrecorded jobs: any Google batch whose
    display_name matches one of our shard keys that still has no
    provider_job_id is adopted, not resubmitted."""
    unrecorded = {
        shard_key: None
        for (shard_key,) in db.rows(
            "SELECT shard_key FROM public.tag_batch_jobs"
            " WHERE provider_job_id IS NULL AND status = 'pending'"
        )
    }
    if not unrecorded:
        return
    prefix = config.BATCH_DISPLAY_PREFIX + ":"
    adopted = 0
    try:
        for job in gemini_client.list_batches():
            display = job.get("display_name") or ""
            if not display.startswith(prefix):
                continue
            shard_key = display[len(prefix):]
            if shard_key in unrecorded and job.get("name"):
                with db.get_pg().cursor() as cur:
                    cur.execute(
                        "UPDATE public.tag_batch_jobs SET provider_job_id=%s, status='submitted',"
                        " submitted_at=coalesce(submitted_at, %s) WHERE shard_key=%s AND provider_job_id IS NULL",
                        (job["name"], datetime.now(timezone.utc), shard_key),
                    )
                adopted += 1
    except Exception as exc:  # noqa: BLE001
        print(f"  reconcile: Google job list unavailable ({exc}) — pending shards stay pending", flush=True)
        return
    if adopted:
        print(f"  reconciled {adopted} accepted-but-unrecorded job(s) from Google's list.", flush=True)


# ── collection + gates + apply ──────────────────────────────────────────────

# Normalized buckets a schema-invalid response is classified into, so the
# pilot report can show WHY rows failed (not just the rate). Order = report
# order; every bucket is always present in a tally (0 when unseen).
SCHEMA_FAIL_BUCKETS = (
    "RECITATION",
    "MAX_TOKENS",
    "SAFETY/PROMPT_BLOCKED",
    "MALFORMED_JSON",
    "NO_TAGS_ARRAY",
    "other",
)
# Two internal error strings _parse_response_line emits for the JSON symptoms;
# shared so the classifier maps them without string drift.
_ERR_NO_SCHEMA_JSON = "response did not contain valid schema JSON"
_ERR_NO_TAGS_ARRAY = "schema-invalid response (no tags array)"
# finishReason values that mean the model was cut off for a safety/policy
# reason (as opposed to RECITATION or MAX_TOKENS, which get their own buckets).
_SAFETY_FINISH_REASONS = {"SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"}


def _empty_fail_tally() -> dict[str, int]:
    return {bucket: 0 for bucket in SCHEMA_FAIL_BUCKETS}


def classify_schema_failure(error: str | None, finish_reason: str | None,
                            block_reason: str | None) -> str:
    """Map ONE schema-invalid row to a normalized bucket, preferring the model's
    OWN termination signal (finishReason / promptFeedback.blockReason) over the
    JSON symptom: a RECITATION, MAX_TOKENS or SAFETY stop usually ALSO yields
    unparseable JSON, and the underlying reason is the actionable one. Falls back
    to the JSON symptom (NO_TAGS_ARRAY / MALFORMED_JSON) when the model gave no
    signal, and to `other` for transport/API errors."""
    fr = (finish_reason or "").strip().upper()
    br = (block_reason or "").strip().upper()
    if fr == "RECITATION":
        return "RECITATION"
    if fr == "MAX_TOKENS":
        return "MAX_TOKENS"
    if br or fr in _SAFETY_FINISH_REASONS:
        return "SAFETY/PROMPT_BLOCKED"
    if error == _ERR_NO_TAGS_ARRAY:
        return "NO_TAGS_ARRAY"
    if error == _ERR_NO_SCHEMA_JSON:
        return "MALFORMED_JSON"
    return "other"


def raw_failure_signal(error: str | None, finish_reason: str | None,
                       block_reason: str | None) -> str:
    """The raw model/transport signal for a row the classifier had to bucket as
    `other` — so an unexpected finishReason/blockReason is LOGGED, not lost."""
    return (
        f"finishReason={(finish_reason or '')!r} blockReason={(block_reason or '')!r}"
        f" error={((error or '')[:200])!r}"
    )


def _parse_response_line(
    line: str,
) -> tuple[str | None, dict | None, dict, str | None, str | None, str | None]:
    """Returns (key, parsed_json, usage, error, finish_reason, block_reason).

    finish_reason (candidates[0].finishReason) and block_reason
    (promptFeedback.blockReason) are the model's own termination signals; they
    are surfaced even for FAILED rows so a schema-invalid row can be classified
    into a failure bucket instead of being dropped with its reason discarded."""
    try:
        outer = json.loads(line)
    except json.JSONDecodeError:
        return None, None, {}, "unparseable JSONL line", None, None
    key = outer.get("key")
    if outer.get("error"):
        return key, None, {}, json.dumps(outer["error"])[:500], None, None
    response = outer.get("response") or {}
    if response.get("error"):
        return key, None, {}, json.dumps(response["error"])[:500], None, None
    usage = response.get("usageMetadata") or {}
    block_reason = (response.get("promptFeedback") or {}).get("blockReason") or None
    candidates = response.get("candidates") or []
    finish_reason = (
        candidates[0].get("finishReason")
        if candidates and isinstance(candidates[0], dict)
        else None
    ) or None
    try:
        text = response["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        return key, None, usage, _ERR_NO_SCHEMA_JSON, finish_reason, block_reason
    if not isinstance(parsed, dict) or not isinstance(parsed.get("tags"), list):
        return key, None, usage, _ERR_NO_TAGS_ARRAY, finish_reason, block_reason
    return key, parsed, usage, None, finish_reason, block_reason


@dataclass
class ShardOutcome:
    shard_key: str
    table: str = ""
    rows: int = 0
    responses: int = 0
    schema_valid: int = 0
    tags_returned: int = 0
    tags_out_of_vocab: int = 0
    tags_unevidenced_kept: int = 0
    tags_accepted: int = 0
    questions_kept: int = 0
    questions_dropped: int = 0
    functions_kept: int = 0
    zero_tag_rows: int = 0
    input_tokens: int = 0
    output_tokens: int = 0            # candidates + thinking (total BILLABLE output)
    candidate_tokens: int = 0         # candidatesTokenCount only
    thought_tokens: int = 0           # thoughtsTokenCount only (billed at output rate)
    per_row_tag_counts: list[int] = field(default_factory=list)
    # Gated writes, staged (NOT yet committed) so the pilot can validate every
    # file before touching the DB, then apply all shards in ONE transaction.
    updates: list[tuple] = field(default_factory=list)
    evidence_records: list[tuple] = field(default_factory=list)
    # Schema-invalid rows dropped from this shard, bucketed by WHY (the model's
    # own finishReason / blockReason). Sums to (responses - schema_valid - rows
    # skipped for an unknown passage id).
    schema_invalid_reasons: dict[str, int] = field(default_factory=_empty_fail_tally)
    # Raw finishReason/blockReason strings for rows bucketed `other` (logged, not lost).
    other_reasons: list[str] = field(default_factory=list)


def _gate_shard(shard_key: str, table: str, results_path, vocab: VocabIndex) -> ShardOutcome:
    """Parse + gate one shard's results file into staged writes on the returned
    ShardOutcome — WITHOUT touching the DB. Gates: out-of-vocabulary → HARD drop;
    unresolvable evidence sentence id → SOFT (tag kept, evidence_found=false);
    unevidenced question → dropped; passage_function outside the enum → NULL.
    Evidence is a sentence ID resolved back to the EXACT source sentence text."""
    outcome = ShardOutcome(shard_key=shard_key, table=table)
    passages = {p.id: p for p in load_passages(table, [
        r[0] for r in db.rows(
            "SELECT unnest(id_list)::text FROM public.tag_batch_jobs WHERE shard_key=%s",
            (shard_key,),
        )
    ])}

    with open(results_path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            key, parsed, usage, error, finish_reason, block_reason = _parse_response_line(line)
            outcome.responses += 1
            outcome.input_tokens += int(usage.get("promptTokenCount") or 0)
            cand = int(usage.get("candidatesTokenCount") or 0)
            thought = int(usage.get("thoughtsTokenCount") or 0)
            outcome.candidate_tokens += cand
            outcome.thought_tokens += thought
            outcome.output_tokens += cand + thought
            if not key or "|" not in (key or ""):
                continue
            _, passage_id = key.split("|", 1)
            passage = passages.get(passage_id)
            if passage is None:
                continue
            if error or parsed is None:
                # Schema-invalid row: classify WHY it failed from the model's own
                # signal before dropping it, so the reason is tallied not lost.
                bucket = classify_schema_failure(error, finish_reason, block_reason)
                outcome.schema_invalid_reasons[bucket] += 1
                if bucket == "other":
                    outcome.other_reasons.append(raw_failure_signal(error, finish_reason, block_reason))
                continue
            outcome.schema_valid += 1

            sents = sentence_split.split_sentences(passage.text)
            accepted: list[str] = []
            for item in parsed.get("tags", [])[: config.MAX_TAGS]:
                if not isinstance(item, dict):
                    continue
                tag = str(item.get("tag") or "").strip()
                sid = item.get("evidence_sentence_id")
                sid = sid.strip() if isinstance(sid, str) else None
                found, ev_text, start, end, miss = sentence_split.resolve_sentence(sid, sents)
                outcome.tags_returned += 1
                if tag not in vocab.slugs:
                    # HARD gate — out-of-vocabulary is never written to tags_core.
                    outcome.tags_out_of_vocab += 1
                    outcome.evidence_records.append(
                        (table, passage_id, tag, ev_text, False, "out of vocabulary", found, start, end, sid)
                    )
                    continue
                if tag in accepted:
                    continue
                # SOFT gate — the tag is KEPT either way; a miss (id didn't resolve
                # to a target sentence) is flagged evidence_found=false.
                accepted.append(tag)
                outcome.tags_accepted += 1
                if not found:
                    outcome.tags_unevidenced_kept += 1
                outcome.evidence_records.append(
                    (table, passage_id, tag, ev_text, True, miss, found, start, end, sid)
                )

            questions: list[str] = []
            if passage.questions_allowed:
                seen = set()
                for q in parsed.get("questions", [])[: config.MAX_QUESTIONS]:
                    if not isinstance(q, dict):
                        continue
                    question = str(q.get("question") or "").strip()
                    sid = q.get("evidence_sentence_id")
                    sid = sid.strip() if isinstance(sid, str) else None
                    if not question or question.lower() in seen:
                        continue
                    found, _, _, _, _ = sentence_split.resolve_sentence(sid, sents)
                    if not found:
                        # Questions are generated text — unevidenced answers drop (strict).
                        outcome.questions_dropped += 1
                        continue
                    seen.add(question.lower())
                    questions.append(question)
            outcome.questions_kept += len(questions)

            function = str(parsed.get("passage_function") or "").strip()
            if function not in config.PASSAGE_FUNCTIONS:
                function = None
            if function:
                outcome.functions_kept += 1

            outcome.per_row_tag_counts.append(len(accepted))
            if not accepted:
                outcome.zero_tag_rows += 1

            expansion_lines: dict[str, None] = {}
            for tag in accepted:
                term = vocab.term_by_slug.get(tag)
                if term:
                    expansion_lines.setdefault(term["term"], None)
                    for variant in term["variants"]:
                        expansion_lines.setdefault(variant, None)
            outcome.updates.append(
                (
                    accepted,
                    "\n".join(questions) if questions else None,
                    "\n".join(expansion_lines) if expansion_lines else None,
                    function,
                    passage_id,
                )
            )
    outcome.rows = len(outcome.updates)
    return outcome


def _write_outcomes(outcomes: list[ShardOutcome], run_id: str) -> None:
    """Write a batch of already-gated shards in ONE transaction (content columns +
    tag_evidence + each shard's applied-status/cost). Used per-shard by the full
    run and as a single atomic bundle by the pilot — nothing is written unless the
    whole transaction commits, so a mid-apply failure leaves p1 data untouched."""
    conn = db.get_pg()
    with conn.transaction():
        with conn.cursor() as cur:
            for outcome in outcomes:
                for start in range(0, len(outcome.updates), config.DB_BATCH):
                    cur.executemany(
                        f"UPDATE public.{outcome.table} SET tags_core=%s::text[], questions=%s,"
                        f" fts_expansion_src=%s, passage_function=%s WHERE id=%s::uuid",
                        outcome.updates[start : start + config.DB_BATCH],
                    )
                if outcome.evidence_records:
                    cur.executemany(
                        "INSERT INTO public.tag_evidence"
                        " (run_id, table_name, passage_id, tag, evidence, accepted, reject_reason,"
                        "  evidence_found, evidence_start, evidence_end, evidence_sentence_id)"
                        " VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s)",
                        [(run_id, *r) for r in outcome.evidence_records],
                    )
                cur.execute(
                    "UPDATE public.tag_batch_jobs SET status='applied', applied_at=%s,"
                    " cost_input_tok=%s, cost_output_tok=%s, cost_candidate_tok=%s,"
                    " cost_thought_tok=%s WHERE shard_key=%s",
                    (datetime.now(timezone.utc), outcome.input_tokens, outcome.output_tokens,
                     outcome.candidate_tokens, outcome.thought_tokens, outcome.shard_key),
                )


def _log_shard_invalids(outcome: ShardOutcome) -> None:
    invalid = sum(outcome.schema_invalid_reasons.values())
    if invalid:
        breakdown = ", ".join(
            f"{bucket}={n}" for bucket, n in outcome.schema_invalid_reasons.items() if n
        )
        print(f"  {outcome.shard_key}: {invalid} schema-invalid row(s) — {breakdown}", flush=True)
        for raw in outcome.other_reasons:
            print(f"    other → {raw}", flush=True)


def apply_results(shard_key: str, table: str, results_path, run_id: str,
                  vocab: VocabIndex) -> ShardOutcome:
    """Gate + write one shard in its own transaction (the full-run path). The
    pilot instead gates every shard first and applies them all atomically."""
    outcome = _gate_shard(shard_key, table, results_path, vocab)
    _write_outcomes([outcome], run_id)
    _log_shard_invalids(outcome)
    return outcome
    return outcome


def collect(run_id: str, shard_key_prefix: str = "", apply: bool = True) -> list[ShardOutcome]:
    """Poll submitted/running shards until every one is terminal; download the
    results file for each as it finishes. Safe to Ctrl+C and rerun.

    apply=True (full-run path): gate + write each shard as it lands, per-shard
    transaction. apply=False (pilot path): download to `retrieved` ONLY — no DB
    writes — so the files can be validated (and failures retried) BEFORE the
    single atomic apply_pilot_bundle. In download-only mode `retrieved` is the
    stop state, so the loop returns once nothing is submitted/running."""
    vocab = load_vocab_index() if apply else None
    outcomes: list[ShardOutcome] = []
    like = shard_key_prefix + "%"
    statuses = "('submitted','running','retrieved')" if apply else "('submitted','running')"
    while True:
        jobs = db.rows(
            "SELECT shard_key, table_name, provider_job_id, status FROM public.tag_batch_jobs"
            f" WHERE shard_key LIKE %s AND status IN {statuses}"
            " ORDER BY shard_key",
            (like,),
        )
        if not jobs:
            return outcomes
        progressed = False
        for shard_key, table, job_name, status in jobs:
            results_path = config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.results.jsonl"
            if status == "retrieved":
                # Only reached when apply=True (download-only excludes 'retrieved').
                outcomes.append(apply_results(shard_key, table, results_path, run_id, vocab))
                progressed = True
                continue
            job = db.with_retry(lambda name=job_name: gemini_client.get_batch(name), f"poll {shard_key}")
            state = job["state"]
            if state == "BATCH_STATE_RUNNING" and status != "running":
                with db.get_pg().cursor() as cur:
                    cur.execute("UPDATE public.tag_batch_jobs SET status='running' WHERE shard_key=%s", (shard_key,))
            elif state == gemini_client.SUCCESS_STATE:
                if not job.get("output_file"):
                    _fail_shard(shard_key, "succeeded but no output file")
                    progressed = True
                    continue
                db.with_retry(
                    lambda j=job, p=results_path: gemini_client.download_file(j["output_file"], p),
                    f"download {shard_key}",
                )
                with db.get_pg().cursor() as cur:
                    cur.execute(
                        "UPDATE public.tag_batch_jobs SET status='retrieved', retrieved_at=%s WHERE shard_key=%s",
                        (datetime.now(timezone.utc), shard_key),
                    )
                if apply:
                    outcomes.append(apply_results(shard_key, table, results_path, run_id, vocab))
                    print(f"  applied {shard_key}", flush=True)
                else:
                    print(f"  downloaded {shard_key} (not yet applied)", flush=True)
                progressed = True
            elif state in gemini_client.TERMINAL_STATES:
                _fail_shard(shard_key, f"batch ended in {state}: {json.dumps(job.get('error') or {})[:300]}")
                progressed = True
        if not progressed:
            print(
                f"  waiting on {len(jobs)} shard(s) — polling every {config.BATCH_POLL_SECONDS}s"
                " (Ctrl+C is safe; rerun later with --resume to keep collecting)",
                flush=True,
            )
            time.sleep(config.BATCH_POLL_SECONDS)


def apply_pilot_bundle(run_id: str, shard_key_prefix: str, vocab: VocabIndex) -> list[ShardOutcome]:
    """Gate EVERY retrieved pilot shard (original + retry) and write them all in
    ONE transaction. Only called after the file scan confirms 100% schema validity,
    so a first-pass-invalid id is written from its retry shard and no id is written
    twice. All-or-nothing: a mid-apply failure leaves p1 content + evidence intact."""
    like = shard_key_prefix + "%"
    jobs = db.rows(
        "SELECT shard_key, table_name FROM public.tag_batch_jobs"
        " WHERE shard_key LIKE %s AND status='retrieved' ORDER BY shard_key",
        (like,),
    )
    outcomes: list[ShardOutcome] = []
    for shard_key, table in jobs:
        results_path = config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.results.jsonl"
        outcomes.append(_gate_shard(shard_key, table, results_path, vocab))
    _write_outcomes(outcomes, run_id)
    for outcome in outcomes:
        _log_shard_invalids(outcome)
    print(f"  applied {len(outcomes)} pilot shard(s) atomically.", flush=True)
    return outcomes


def pilot_final_failures(shard_key_prefix: str | None = None) -> dict[str, list[str]]:
    """After the single retry, the ids STILL schema-invalid = first-pass failures
    not rescued by a valid retry response. Empty ⇒ 100% validity ⇒ safe to apply."""
    if shard_key_prefix is None:
        shard_key_prefix = config.PILOT_SHARD_PREFIX
    first = failed_keys_from_files(shard_key_prefix)  # non-retry files only
    retry_valid: set[str] = set()
    retry_pattern = f"{shard_key_prefix.replace(':', '_')}retry_*.results.jsonl"
    for path in sorted(config.SHARDS_DIR.glob(retry_pattern)):
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                key, parsed, _u, error, _fr, _br = _parse_response_line(line)
                if key and "|" in key and not error and parsed is not None:
                    retry_valid.add(key)
    still: dict[str, list[str]] = {}
    for table, ids in first.items():
        rem = [pid for pid in ids if f"{table}|{pid}" not in retry_valid]
        if rem:
            still[table] = rem
    return still


def _fail_shard(shard_key: str, error: str) -> None:
    print(f"  FAILED {shard_key}: {error}", flush=True)
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_batch_jobs SET status='failed', error=%s WHERE shard_key=%s",
            (error, shard_key),
        )


# ── pilot validation + report ───────────────────────────────────────────────

def _percentile_disc(sorted_values: list[int], p: float) -> int:
    """Postgres percentile_disc(p): the first value whose 1-based position i
    satisfies i/N ≥ p. Matches the DB-side pilot median/p90 exactly so the
    file-recomputed gates line up with pilot_stats_from_db()."""
    n = len(sorted_values)
    if n == 0:
        return 0
    pos = int(p * n)
    if p * n > pos:  # ceil for a positive product
        pos += 1
    idx = max(0, min(n - 1, pos - 1))
    return sorted_values[idx]


def scan_pilot_results(shard_key_prefix: str | None = None) -> dict:
    """Re-scan the banked ``<prefix>*.results.jsonl`` files under SHARDS_DIR and
    recompute — with NO database access, NO Gemini calls and NO cost — BOTH the
    schema-invalid failure buckets (from each row's own finishReason/blockReason)
    AND the pilot quality gates (tags gated against the local vocabulary exactly
    as apply_results gates them: out-of-vocabulary is a HARD drop, in-vocab tags
    are deduped and capped at MAX_TAGS).

    Returns {"files", "pattern", "buckets", "other_reasons", "stats"}. ``files``
    is EMPTY when nothing is banked and ``stats`` is then None — the caller MUST
    treat that as "cannot validate", never as a clean pass. Evidence-found rate
    and the live remaining-passage projection are DB-only and omitted here."""
    if shard_key_prefix is None:
        shard_key_prefix = config.PILOT_SHARD_PREFIX
    pattern = f"{shard_key_prefix.replace(':', '_')}*.results.jsonl"
    files = sorted(config.SHARDS_DIR.glob(pattern))
    buckets = _empty_fail_tally()
    other_reasons: list[str] = []
    if not files:
        return {"files": [], "pattern": pattern, "buckets": buckets,
                "other_reasons": other_reasons, "stats": None}

    vocab = load_vocab_index()
    responses = schema_valid = 0
    tags_returned = oov = 0
    zero_tag_rows = functions_kept = questions_returned = 0
    input_tokens = output_tokens = candidate_tokens = thought_tokens = 0
    per_row_tag_counts: list[int] = []
    tag_usage: dict[str, int] = {}

    for path in files:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                key, parsed, usage, error, finish_reason, block_reason = _parse_response_line(line)
                input_tokens += int(usage.get("promptTokenCount") or 0)
                cand = int(usage.get("candidatesTokenCount") or 0)
                thought = int(usage.get("thoughtsTokenCount") or 0)
                candidate_tokens += cand
                thought_tokens += thought
                output_tokens += cand + thought
                if not key or "|" not in key:
                    continue
                responses += 1
                if error or parsed is None:
                    bucket = classify_schema_failure(error, finish_reason, block_reason)
                    buckets[bucket] += 1
                    if bucket == "other":
                        other_reasons.append(raw_failure_signal(error, finish_reason, block_reason))
                    continue
                schema_valid += 1
                accepted: list[str] = []
                for item in parsed.get("tags", [])[: config.MAX_TAGS]:
                    if not isinstance(item, dict):
                        continue
                    tag = str(item.get("tag") or "").strip()
                    tags_returned += 1
                    if tag not in vocab.slugs:  # HARD gate — OOV never counts as used
                        oov += 1
                        continue
                    if tag in accepted:
                        continue
                    accepted.append(tag)
                per_row_tag_counts.append(len(accepted))
                if not accepted:
                    zero_tag_rows += 1
                for tag in accepted:
                    tag_usage[tag] = tag_usage.get(tag, 0) + 1
                if str(parsed.get("passage_function") or "").strip() in config.PASSAGE_FUNCTIONS:
                    functions_kept += 1
                q_items = parsed.get("questions")
                if isinstance(q_items, list) and any(
                    isinstance(q, dict) and str(q.get("question") or "").strip() for q in q_items
                ):
                    questions_returned += 1

    tagged = sorted(n for n in per_row_tag_counts if n > 0)
    distinct_tags = len(tag_usage)
    singletons = sum(1 for n in tag_usage.values() if n == 1)
    max_tag_uses = max(tag_usage.values()) if tag_usage else 0
    vocab_total = int(vocab.term_count or 1)
    stats = {
        "rows": schema_valid,
        "responses": responses,
        "schema_valid_rate": (schema_valid / responses) if responses else 0.0,
        "out_of_vocab_rate": (oov / tags_returned) if tags_returned else 0.0,
        "evidence_found_rate": None,  # DB-only (needs the original passage text)
        "tags_returned": tags_returned,
        "tags_accepted": sum(per_row_tag_counts),
        "questions_kept": questions_returned,  # returned; evidence gate not re-applied offline
        "functions_kept": functions_kept,
        "zero_tag_rows": zero_tag_rows,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "candidate_tokens": candidate_tokens,
        "thought_tokens": thought_tokens,
        "tags_mean": (sum(per_row_tag_counts) / len(per_row_tag_counts)) if per_row_tag_counts else 0.0,
        "tagged_median": _percentile_disc(tagged, 0.5),
        "tagged_p90": _percentile_disc(tagged, 0.9),
        "tags_max": max(per_row_tag_counts) if per_row_tag_counts else 0,
        "distinct_tags": distinct_tags,
        "singleton_share": (singletons / distinct_tags) if distinct_tags else 0.0,
        "vocab_coverage": (distinct_tags / vocab_total) if vocab_total else 0.0,
        "vocab_total": vocab_total,
        "max_tag_share": (max_tag_uses / schema_valid) if schema_valid else 0.0,
    }
    return {"files": [p.name for p in files], "pattern": pattern, "buckets": buckets,
            "other_reasons": other_reasons, "stats": stats}


def pilot_stats_from_db() -> dict:
    """Pilot quality metrics recomputed from the DATABASE (not in-memory shard
    outcomes) so validation is correct even when some pilot shards were applied
    by an earlier, interrupted process. schema_valid_rate works because apply
    only UPDATEs rows whose response parsed: unparsed rows keep tags_core NULL.
    Zero-tag passages are VALID and excluded from the tagged-row median.

    NOTE (v3.p2): schema_valid_rate here is UNRELIABLE when the pilot re-tags rows
    p1 already wrote (the success slice is already tags_core NOT NULL) — the FILE
    scan owns the schema gate. This function's schema_valid_rate is only a
    trivially-passing backstop; the distribution metrics are the real DB gates."""
    like = config.PILOT_SHARD_PREFIX + "%"
    planned, real_in, real_out, real_cand, real_thought = db.rows(
        "SELECT coalesce(sum(row_count),0), coalesce(sum(cost_input_tok),0),"
        "       coalesce(sum(cost_output_tok),0), coalesce(sum(cost_candidate_tok),0),"
        "       coalesce(sum(cost_thought_tok),0)"
        " FROM public.tag_batch_jobs WHERE shard_key LIKE %s AND status='applied'",
        (like,),
    )[0]
    per_table_union = " UNION ALL ".join(
        f"SELECT cardinality(t.tags_core) AS n, t.questions IS NOT NULL AS has_q,"
        f"       t.tags_core IS NOT NULL AS updated,"
        f"       t.passage_function IS NOT NULL AS has_fn"
        f" FROM pilot p JOIN public.{t} t ON t.id = p.id AND p.table_name = '{t}'"
        for t in config.GEMINI_TABLES
    )
    row = db.rows(
        "WITH pilot AS (SELECT table_name, unnest(id_list) AS id FROM public.tag_batch_jobs"
        "               WHERE shard_key LIKE %s AND status='applied'),"
        f" c AS ({per_table_union})"
        " SELECT count(*) FILTER (WHERE updated),"
        "        coalesce(avg(n) FILTER (WHERE updated), 0),"
        "        coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY n)"
        "                 FILTER (WHERE updated AND n > 0), 0),"
        "        coalesce(percentile_disc(0.9) WITHIN GROUP (ORDER BY n)"
        "                 FILTER (WHERE updated AND n > 0), 0),"
        "        coalesce(max(n) FILTER (WHERE updated), 0),"
        "        count(*) FILTER (WHERE updated AND n = 0),"
        "        count(*) FILTER (WHERE has_q),"
        "        count(*) FILTER (WHERE has_fn)"
        " FROM c",
        (like,),
    )[0]
    (updated, tags_mean, tagged_median, tagged_p90, tags_max,
     zero_tag_rows, question_rows, function_rows) = row

    # Per-tag usage distribution over the pilot rows (unnested tags_core).
    tag_usage: dict[str, int] = {}
    for t in config.GEMINI_TABLES:
        for tag, n in db.rows(
            "WITH pilot AS (SELECT unnest(id_list) AS id FROM public.tag_batch_jobs"
            "               WHERE shard_key LIKE %s AND status='applied' AND table_name=%s)"
            f" SELECT tag, count(*) FROM ("
            f"   SELECT unnest(t.tags_core) AS tag FROM public.{t} t"
            f"   JOIN pilot p ON p.id = t.id WHERE t.tags_core IS NOT NULL) x"
            " GROUP BY tag",
            (like, t),
        ):
            tag_usage[tag] = tag_usage.get(tag, 0) + int(n)
    distinct_tags = len(tag_usage)
    singletons = sum(1 for n in tag_usage.values() if n == 1)
    max_tag_uses = max(tag_usage.values()) if tag_usage else 0
    vocab_total = int(build_vocabulary.load_vocabulary().get("term_count") or 1)

    ev = db.rows(
        "WITH pilot AS (SELECT table_name, unnest(id_list) AS id FROM public.tag_batch_jobs"
        "               WHERE shard_key LIKE %s AND status='applied')"
        " SELECT count(*),"
        "        count(*) FILTER (WHERE NOT accepted AND reject_reason = 'out of vocabulary'),"
        "        count(*) FILTER (WHERE accepted),"
        "        count(*) FILTER (WHERE accepted AND evidence_found)"
        " FROM public.tag_evidence e"
        " WHERE EXISTS (SELECT 1 FROM pilot p WHERE p.table_name = e.table_name AND p.id = e.passage_id)",
        (like,),
    )[0]
    tags_returned, oov, accepted, evidenced = (int(x) for x in ev)
    planned = int(planned)
    updated = int(updated)
    return {
        "rows": updated,
        "responses": planned,
        "schema_valid_rate": (updated / planned) if planned else 0.0,
        "out_of_vocab_rate": (oov / tags_returned) if tags_returned else 0.0,
        "evidence_found_rate": (evidenced / accepted) if accepted else 0.0,  # reported, not gated
        "tags_returned": tags_returned,
        "tags_accepted": accepted,
        "questions_kept": int(question_rows),
        "functions_kept": int(function_rows),
        "zero_tag_rows": int(zero_tag_rows),
        "input_tokens": int(real_in),
        "output_tokens": int(real_out),
        "candidate_tokens": int(real_cand),
        "thought_tokens": int(real_thought),
        "tags_mean": float(tags_mean),
        "tagged_median": int(tagged_median),
        "tagged_p90": int(tagged_p90),
        "tags_max": int(tags_max),
        "distinct_tags": distinct_tags,
        "singleton_share": (singletons / distinct_tags) if distinct_tags else 0.0,
        "vocab_coverage": (distinct_tags / vocab_total) if vocab_total else 0.0,
        "vocab_total": vocab_total,
        "max_tag_share": (max_tag_uses / updated) if updated else 0.0,
    }


def pilot_thresholds_pass(stats: dict) -> list[str]:
    """DISTRIBUTION auto-gates only. v3.p2: the schema-validity gate is enforced
    on the banked FILES before any DB write (first pass ≥ PILOT_MIN_SCHEMA_VALID,
    100% after one retry) — NOT here, because the DB schema_valid_rate over-reports
    once the pilot re-tags rows p1 already wrote. Evidence-found rate is reported,
    never gated. Zero-tag passages are valid; the tagged-row median must merely sit
    in a sane band."""
    failures = []
    if stats["out_of_vocab_rate"] > config.PILOT_MAX_OUT_OF_VOCAB:
        failures.append(
            f"out_of_vocab_rate {stats['out_of_vocab_rate']:.3f} > {config.PILOT_MAX_OUT_OF_VOCAB}"
        )
    if stats["distinct_tags"] < config.PILOT_MIN_DISTINCT_TAGS:
        failures.append(
            f"distinct tags used {stats['distinct_tags']} < {config.PILOT_MIN_DISTINCT_TAGS}"
        )
    if stats["singleton_share"] > config.PILOT_MAX_SINGLETON_SHARE:
        failures.append(
            f"singleton-tag share {stats['singleton_share']:.2f} > {config.PILOT_MAX_SINGLETON_SHARE}"
        )
    if stats["vocab_coverage"] < config.PILOT_MIN_VOCAB_COVERAGE:
        failures.append(
            f"vocabulary coverage {stats['vocab_coverage']:.2f} < {config.PILOT_MIN_VOCAB_COVERAGE}"
        )
    if stats["max_tag_share"] > config.PILOT_MAX_TAG_SHARE:
        failures.append(
            f"most-used tag covers {stats['max_tag_share']:.2f} of pilot passages"
            f" > {config.PILOT_MAX_TAG_SHARE}"
        )
    if stats["rows"] > stats["zero_tag_rows"] and not (
        config.PILOT_MEDIAN_TAGS_MIN <= stats["tagged_median"] <= config.PILOT_MEDIAN_TAGS_MAX
    ):
        failures.append(
            f"median tags among tagged passages {stats['tagged_median']} outside"
            f" [{config.PILOT_MEDIAN_TAGS_MIN}, {config.PILOT_MEDIAN_TAGS_MAX}]"
        )
    return failures


def _pilot_samples(limit: int, run_id: str | None = None) -> list[dict]:
    """Seeded-random passage→tags→evidence samples for the optional human skim.
    Evidence is scoped to THIS run so a re-tagged (p1-success-slice) passage shows
    p2's evidence, not p1's leftover audit rows."""
    like = config.PILOT_SHARD_PREFIX + "%"
    rows: list[dict] = []
    for t in config.GEMINI_TABLES:
        column = "translation" if t == "verses" else "body_text"
        for row_id, snippet, tags, function in db.rows(
            "WITH pilot AS (SELECT unnest(id_list) AS id FROM public.tag_batch_jobs"
            "               WHERE shard_key LIKE %s AND status='applied' AND table_name=%s)"
            f" SELECT t.id::text, left(coalesce(t.{column}, ''), 300), t.tags_core, t.passage_function"
            f" FROM public.{t} t JOIN pilot p ON p.id = t.id"
            " WHERE t.tags_core IS NOT NULL AND cardinality(t.tags_core) > 0"
            " ORDER BY md5(%s || t.id::text) LIMIT %s",
            (like, t, config.SAMPLE_SEED, limit),
        ):
            rows.append(
                {
                    "table": t,
                    "id": row_id,
                    "snippet": (snippet or "").replace("\n", " ").strip(),
                    "tags": list(tags or []),
                    "function": function,
                }
            )
    rows.sort(
        key=lambda r: hashlib.md5((config.SAMPLE_SEED + r["table"] + r["id"]).encode()).hexdigest()
    )
    rows = rows[:limit]
    run_filter = " AND run_id = %s::uuid" if run_id else ""
    for row in rows:
        params = [row["table"], row["id"]]
        if run_id:
            params.append(run_id)
        row["evidence"] = db.rows(
            "SELECT tag, coalesce(evidence_found, false), left(coalesce(evidence, ''), 200)"
            " FROM public.tag_evidence"
            " WHERE table_name = %s AND passage_id = %s::uuid AND accepted" + run_filter +
            " ORDER BY tag",
            tuple(params),
        )
    return rows


def _failure_reason_lines(failure_reasons: dict) -> list[str]:
    """Render the 'Schema-invalid failure reasons' section from a
    scan_pilot_results() result. Every normalized bucket is listed (0 included)
    so the full picture is visible; missing banked files are flagged loudly
    rather than shown as a clean zero."""
    files = failure_reasons.get("files") or []
    buckets = failure_reasons.get("buckets") or _empty_fail_tally()
    total = sum(buckets.values())
    lines = ["", "## Schema-invalid failure reasons", ""]
    if not files:
        lines.append(
            "- ⚠️ No banked pilot shard files were found"
            f" (looked for `{failure_reasons.get('pattern', 'pilot_*.results.jsonl')}`"
            " under `shards/`) — failure reasons could NOT be recomputed. This is"
            " NOT a clean result: re-run the pilot to regenerate the banked shards."
        )
        return lines
    lines.append(
        f"- Scanned {len(files)} banked shard file(s); {total} schema-invalid row(s) total,"
        " bucketed by the model's own `finishReason` / `blockReason`:"
    )
    for bucket in SCHEMA_FAIL_BUCKETS:
        n = buckets.get(bucket, 0)
        share = f" ({n / total:.0%})" if total else ""
        lines.append(f"  - `{bucket}`: {n}{share}")
    other_reasons = failure_reasons.get("other_reasons") or []
    if other_reasons:
        lines.append("- Raw signals for `other`-bucketed rows (logged, not lost):")
        for raw in other_reasons[:50]:
            lines.append(f"  - {raw}")
    return lines


def write_pilot_report(stats: dict, failures: list[str], model: str,
                       failure_reasons: dict | None = None, offline: bool = False,
                       run_id: str | None = None, validity: dict | None = None) -> None:
    """Write pilot-report.md. When ``offline`` is True the DB-only sections
    (remaining-passage projection and the random skim samples) are skipped so
    the report can be regenerated with no database access and no cost — used by
    `run_all.py --revalidate-pilot`. ``failure_reasons`` (a scan_pilot_results()
    result) adds the 'Schema-invalid failure reasons' section. ``validity`` (a
    live run's file-based first-pass/retry/final schema-validity summary) is the
    AUTHORITATIVE schema gate; the DB schema_valid_rate is only a backstop.
    Full-run extrapolation is run_id-scoped (all 5 tables incl. verse_chunks, and
    p1-written rows count as work p2 must replace)."""
    if offline:
        remaining = None
    elif run_id:
        remaining = remaining_for_run(run_id)  # honest: p2 retags every eligible row
    else:
        remaining = sum(
            db.table_count(t, "tags_core IS NULL AND embedding_context4 IS NOT NULL")
            for t in config.GEMINI_TABLES
        )
    rows = max(stats["rows"], 1)
    per_row_in = stats["input_tokens"] / rows
    per_row_out = stats["output_tokens"] / rows
    pilot_usd = _usd(stats["input_tokens"], stats["output_tokens"])
    projected_usd = None if remaining is None else _usd(per_row_in * remaining, per_row_out * remaining)
    if offline:
        verdict = "PASS (gates recomputed offline)" if not failures else "FAIL (gates recomputed offline)"
    else:
        verdict = "PASS — continuing automatically (standing ruling)" if not failures else "FAIL — run stopped"
    ev = stats.get("evidence_found_rate")
    evidence_line = (
        f"- Evidence-found rate: {ev:.1%} (REPORTED — not gated;"
        " unevidenced in-vocab tags are kept and flagged)"
        if ev is not None
        else "- Evidence-found rate: n/a (not recomputed offline — needs the original passage text)"
    )
    questions_line = (
        f"- Passages carrying questions (HIS/Prabhupāda-speaking rows only): {stats['questions_kept']}"
        if not offline
        else f"- Passages returning ≥1 question: {stats['questions_kept']}"
        " (evidence gate not re-applied offline)"
    )
    lines = [
        "# Pilot report — tags + questions + passage_function combined pass",
        "",
        f"- Generated: {datetime.now(timezone.utc).isoformat()}"
        + ("  ·  MODE: offline re-validation (no DB / no Gemini / no cost)" if offline else ""),
        f"- Model: `{model}` · prompt `{config.PROMPT_VERSION}`"
        f" · thinking `{config.THINKING_LEVEL}` · temperature model-default"
        f" · MAX_TAGS {config.MAX_TAGS} · maxOutputTokens {config.MAX_OUTPUT_TOKENS}",
        f"- Evidence: sentence-ID (`{sentence_split.SPLITTER_VERSION}`) resolved to source text",
        f"- Sampling: seeded-random stratified by table × length quartile, seed"
        f" `{config.SAMPLE_SEED}` · pilot size {config.PILOT_SIZE}",
        f"- Verdict: **{verdict}**",
        "",
        "## Schema validity (FILE-based gate — authoritative)",
        (
            f"- First pass: {validity['first_pass']:.2%} (gate ≥ {config.PILOT_MIN_SCHEMA_VALID:.1%})"
            f" · retried {validity['retry_rows']} row(s) once"
            f" · final: {validity['final']:.2%} (gate = {config.PILOT_FINAL_SCHEMA_VALID:.0%})"
            if validity else
            f"- DB backstop schema_valid_rate: {stats['schema_valid_rate']:.1%}"
            " (file-based gate not available in this mode)"
        ),
        "",
        "## Quality gates",
        f"- Passages applied: {stats['rows']} (responses: {stats['responses']})",
        f"- Out-of-vocabulary rate: {stats['out_of_vocab_rate']:.2%} (gate ≤ {config.PILOT_MAX_OUT_OF_VOCAB:.0%})",
        evidence_line,
        "",
        "## Distribution health",
        f"- Distinct tags used: {stats['distinct_tags']} (gate ≥ {config.PILOT_MIN_DISTINCT_TAGS})",
        f"- Singleton-tag share: {stats['singleton_share']:.1%} of used terms"
        f" (gate ≤ {config.PILOT_MAX_SINGLETON_SHARE:.0%})",
        f"- Vocabulary coverage: {stats['vocab_coverage']:.1%} of {stats['vocab_total']} terms"
        f" used at least once (gate ≥ {config.PILOT_MIN_VOCAB_COVERAGE:.0%})",
        f"- Most-used tag share: {stats['max_tag_share']:.1%} of pilot passages"
        f" (gate ≤ {config.PILOT_MAX_TAG_SHARE:.0%})",
        f"- Tags/passage: median {stats['tagged_median']} among TAGGED passages"
        f" (gate {config.PILOT_MEDIAN_TAGS_MIN}-{config.PILOT_MEDIAN_TAGS_MAX};"
        f" zero-tag passages excluded, no minimum-count gate)"
        f" · mean {stats['tags_mean']:.2f} · p90 {stats['tagged_p90']} · max {stats['tags_max']}"
        f" (cap {config.MAX_TAGS})",
        f"- Zero-tag passages: {stats['zero_tag_rows']} (valid output)",
        f"- Passages with passage_function: {stats['functions_kept']}",
        questions_line,
        "",
        "## Real cost (from usageMetadata — thinking INCLUDED) and extrapolation",
        f"- Pilot tokens: {stats['input_tokens']:,} in / {stats['output_tokens']:,} out"
        f" (= {stats.get('candidate_tokens', 0):,} candidate + {stats.get('thought_tokens', 0):,} thinking)"
        f" → ${pilot_usd:,.2f} at ${config.GEMINI_BATCH_PRICE_IN_PER_M}/M in,"
        f" ${config.GEMINI_BATCH_PRICE_OUT_PER_M}/M out (batch)",
        f"- Per-passage average: {per_row_in:,.0f} in / {per_row_out:,.0f} out tokens"
        " (retried rows are billed for both attempts — real spend)",
    ]
    if remaining is None:
        lines.append(
            "- Remaining-passage count & projected full-run cost: skipped"
            " (offline — needs the DB)"
        )
    else:
        scope = "not yet tagged by this run (all 5 tables incl. verse_chunks)" if run_id \
            else "still untagged (all 5 tables incl. verse_chunks)"
        lines += [
            f"- Remaining Gemini-eligible passages {scope}: {remaining:,}",
            f"- **Projected full-run cost: ${projected_usd:,.2f}**"
            f" (ceiling MAX_SPEND_USD = ${config.MAX_SPEND_USD:,.2f})",
        ]
    if failure_reasons is not None:
        lines += _failure_reason_lines(failure_reasons)
    if failures:
        lines += ["", "## Threshold failures", *[f"- {f}" for f in failures]]
    if offline:
        lines += [
            "",
            f"## {config.PILOT_SAMPLE_ROWS} random samples (optional human skim)",
            "",
            "- skipped in offline re-validation (samples are read from the DB).",
        ]
    else:
        lines += ["", f"## {config.PILOT_SAMPLE_ROWS} random samples (optional human skim)", ""]
        for i, sample in enumerate(_pilot_samples(config.PILOT_SAMPLE_ROWS, run_id=run_id), 1):
            lines.append(
                f"**{i}. {sample['table']} {sample['id']}**"
                + (f" · function: `{sample['function']}`" if sample["function"] else "")
            )
            lines.append(f"> {sample['snippet']}")
            for tag, found, evidence in sample["evidence"]:
                marker = "✓" if found else "∅ (kept, unevidenced)"
                lines.append(f"- `{tag}` {marker} — “{evidence}”")
            lines.append("")
    with open(config.PILOT_REPORT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"  wrote {config.PILOT_REPORT_PATH}", flush=True)
    if projected_usd is None:
        print(f"  pilot real cost ${pilot_usd:,.2f} (projection skipped — offline)", flush=True)
    else:
        print(
            f"  pilot real cost ${pilot_usd:,.2f} → projected full run ${projected_usd:,.2f}"
            f" (ceiling ${config.MAX_SPEND_USD:,.2f})",
            flush=True,
        )


def pilot_done() -> bool:
    like = config.PILOT_SHARD_PREFIX + "%"
    unfinished = db.one(
        "SELECT count(*) FROM public.tag_batch_jobs"
        " WHERE shard_key LIKE %s AND status NOT IN ('applied','failed')",
        (like,),
    )
    any_pilot = db.one(
        "SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", (like,)
    )
    return bool(any_pilot) and not unfinished
