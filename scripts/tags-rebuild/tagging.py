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

v3.p3-hybrid: TWO models, one pipeline (routing.py): core scripture
(verses/verse_chunks of bg/sb/cc) → config.MODEL_CORE, everything else →
config.MODEL_STANDARD. Shard keys embed a short run token + the routed model
("pilot:p3:<run8>:<model>:verses:000", "full:p3:<run8>:<model>:verses:w01:0000",
with ":retry:"/":esc:" attempt segments), so p1/p2 keys, other p3 runs, and both
models' request/result files can never collide. Completion is ROW-LEVEL
(tag_passage_outcomes): a passage counts as covered ONLY when it has a
successfully applied result in this run — never because its id appeared in a
submitted shard. Invalid/missing rows retry once on their own model; standard
rows still invalid then escalate once to MODEL_CORE; anything still invalid is
QUARANTINED (unresolved — the run never reports complete and finalize refuses).

Batch mechanics (resumable; jobs run server-side up to 24h — close the script
after submission and rerun later to collect):
  • deterministic shard names (see above), model + pinned prices recorded on
    every tag_batch_jobs row at insert;
  • real token usage recorded the moment results are RETRIEVED (downloaded) —
    not at apply — so the spend ledger and ceiling count every dollar actually
    spent even if a later apply step fails;
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
import routing
import sentences as sentence_split

IN_FLIGHT = ("submitted", "running")
UNFINISHED = ("pending", "submitted", "running", "retrieved")

# Row-level outcome states that count as RESOLVED for completion. `quarantined`
# is terminal for planning (no further spend) but deliberately NOT resolved —
# a run with quarantined rows is never reported complete and finalize refuses.
RESOLVED_OUTCOMES = ("applied", "skipped_no_shortlist")
RETRYABLE_OUTCOMES = ("invalid", "missing_response")


def run_token(run_id: str) -> str:
    """Short run discriminator embedded in every p3 shard key, so two p3 runs
    (e.g. after a vocabulary rebuild) can never collide in tag_batch_jobs or on
    disk. 8 hex chars of the run uuid — unique enough among a handful of runs."""
    return run_id.replace("-", "")[:8]


def pilot_prefix(run_id: str) -> str:
    return f"{config.PILOT_SHARD_PREFIX}{run_token(run_id)}:"


def full_prefix(run_id: str) -> str:
    return f"{config.FULL_SHARD_PREFIX}{run_token(run_id)}:"


def attempt_for_shard_key(shard_key: str) -> int:
    """Attempt number is DERIVED from the key (single source of truth): fresh=1,
    ':retry:'=2, ':esc:'=3. Works for pilot, full-run and ':pNN' part keys."""
    if ":esc:" in shard_key:
        return 3
    if ":retry:" in shard_key:
        return 2
    return 1

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


def attach_shortlists_v4(table: str, passages: list[Passage], vocab: VocabIndex) -> None:
    """v4-tiered.2 shortlist = the Tier-3 candidate list. For each passage build the
    UNION of three lanes — top-TIER2_SHORTLIST_K by LABEL similarity, top-K by
    MAX-EXEMPLAR similarity, and every C/P term that LITERALLY appears — deduped and
    capped at TIER3_CANDIDATE_CAP, then keep the middle band: label similarity ≥
    TIER2_REJECT OR a lexical hit (a literal appearance is always judged). There is
    no auto-accept band any more, so EVERYTHING above T_reject is shown to the judge.
    Deterministic from the frozen p1 exemplars + stored embeddings + the active
    threshold, so it matches the free-tier counter and the apply reconstruction
    exactly on every resume."""
    import tiers
    concept_index = tiers.concept_alias_index(tiers.build_vocab_dict(vocab))
    cand = tiers.tier3_shortlist_for_passages(table, passages, concept_index)
    for passage in passages:
        passage.shortlist = tiers.middle_band(cand.get(passage.id, []), config.TIER2_REJECT)


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


def request_line(passage: Passage, vocab: VocabIndex,
                 max_output_tokens: int | None = None) -> dict:
    if config.PURE_CLASSIFICATION:
        return request_line_v4(passage, vocab, max_output_tokens)
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


# ── v4-tiered: the Tier-3 LLM JUDGE (classification only) ────────────────────
# Questions + passage_function are DEFERRED (no generation now). The judge sees
# ONLY the Tier-2 middle-band Concept/Practice candidates and confirms which
# genuinely apply, citing a target sentence id. Output schema is exactly
# {"tags":[{"slug", "evidence_sentence_id"}]} and nothing else; zero tags valid.

def response_schema_v4(shortlist: list[str], sentence_ids: list[str]) -> dict:
    """Classification-only schema: an array of {slug, evidence_sentence_id}. Both
    fields are CLOSED ENUMS (the middle-band slugs; the target sentence ids), so
    the model can neither invent a tag nor a citation. No passage_function, no
    questions, no free-text — the whole payload is a shortlist confirmation."""
    ev = _evidence_id_schema(sentence_ids)
    return {
        "type": "OBJECT",
        "properties": {
            "tags": {
                "type": "ARRAY",
                "maxItems": config.MAX_TAGS,
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "slug": {"type": "STRING", "enum": shortlist},
                        "evidence_sentence_id": ev,
                    },
                    "required": ["slug", "evidence_sentence_id"],
                    "propertyOrdering": ["slug", "evidence_sentence_id"],
                },
            },
        },
        "required": ["tags"],
        "propertyOrdering": ["tags"],
    }


def _candidate_line_v4(slug: str, vocab: VocabIndex, shortlist: set[str]) -> str:
    """One candidate line for the judge: slug + scope note + the hard-negative
    partners that are ALSO in this passage's shortlist (per the v4 spec — only
    shortlisted partners are worth contrasting; nothing outside the middle band
    is ever shown as a candidate)."""
    term = vocab.term_by_slug[slug]
    line = f"- {slug} — \"{term['term']}\" ({term['facet']})"
    note = (term.get("scope_note") or "").strip()
    if note:
        line += f". Scope: {note}"
    partners = [n for n in vocab.hard_negatives(slug) if n in shortlist]
    if partners:
        names = ", ".join(f"{n} (\"{vocab.term_by_slug[n]['term']}\")" for n in partners)
        line += f". Do NOT confuse with: {names}"
    return line


def build_prompt_v4(passage: Passage, vocab: VocabIndex, sents: list) -> str:
    shortlist = set(passage.shortlist)
    candidates = "\n".join(
        _candidate_line_v4(slug, vocab, shortlist)
        for slug in passage.shortlist if slug in vocab.term_by_slug
    )
    base = (
        "You are CONFIRMING which candidate subjects a passage from Śrīla"
        " Prabhupāda's corpus is genuinely about. A shortlist was pre-selected by"
        " embedding similarity; your job is to keep only the ones that truly"
        " apply.\n\nCANDIDATE TAGS (closed list — you may ONLY return these"
        " slugs; each shows its scope and what NOT to confuse it with):\n"
        f"{candidates}\n\nRULES:\n"
        "1. Confirm ABOUTNESS only. Keep a candidate ONLY if the passage is"
        " genuinely about it. Do NOT keep a subject the passage merely mentions"
        " in passing, quotes from an opponent, or explicitly REJECTS. Prefer the"
        " MOST SPECIFIC fitting concepts; drop broad ancestors. ZERO tags is a"
        f" valid answer — never force a tag. Never more than {config.MAX_TAGS}.\n"
        "2. For EACH kept tag, set `evidence_sentence_id` to the ID (e.g. S002)"
        " of the ONE TARGET sentence that best shows the passage is about that"
        " subject. Use ONLY the numbered sentence IDs below — never invent one,"
        " never copy text.\n"
    )
    if passage.context:
        base += (
            "\nCONTEXT (for understanding only — do NOT cite it; it has no"
            " sentence IDs and its subject is not necessarily the TARGET's):\n"
            + passage.context
        )
    return (
        base
        + "\n\nTARGET PASSAGE (confirm ONLY what THIS is about; cite evidence by"
        " its sentence ID):\n"
        + sentence_split.render_numbered(sents)
    )


def request_line_v4(passage: Passage, vocab: VocabIndex,
                    max_output_tokens: int | None = None) -> dict:
    sents = sentence_split.split_sentences(passage.text)
    return {
        "key": f"{passage.table}|{passage.id}",
        "request": {
            "contents": [{"parts": [{"text": build_prompt_v4(passage, vocab, sents)}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": response_schema_v4(
                    passage.shortlist, sentence_split.sentence_ids(sents),
                ),
                "thinkingConfig": {"thinkingLevel": config.THINKING_LEVEL},
                # TIERED cap by ladder attempt (2048 → 4096 → 8192); the first-attempt
                # default (config.TIER3_MAX_OUTPUT_TOKENS) when none is threaded in.
                "maxOutputTokens": max_output_tokens or config.TIER3_MAX_OUTPUT_TOKENS,
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


def _route_split_ids(table: str, ids: list[str]) -> dict[str, list[str]]:
    """Split a table's id list by route in SQL (the exact slug expressions
    load_passages uses). Non-book tables are all 'standard' without a query."""
    ids = sorted(set(ids))
    if not ids:
        return {}
    if table not in routing.ROUTED_TABLES:
        return {"standard": ids}
    join, expr = routing.route_sql(table)
    out: dict[str, list[str]] = {}
    for pid, route in db.rows(
        f"SELECT t.id::text, {expr} FROM public.{table} t{join}"
        f" WHERE t.id = ANY(%s::uuid[]) ORDER BY t.id",
        (ids,),
    ):
        out.setdefault(route, []).append(pid)
    return out


def plan_pilot_shards(run_id: str) -> None:
    """Build the EXACT pilot manifest (config.PILOT_SIZE rows) with the same
    cohort/stratification method as p2 — ALL p1-failures + a p1-success
    comparison slice (matched to the failure table mix + length quartile) + a
    fresh stratified remainder — under the p3 seed, then ROUTE-SPLIT each
    table's ids (routing.py) and shard PER MODEL under this run's pilot prefix.
    Records a checksum + cohort + per-route sizes in tag_runs.config."""
    prefix = pilot_prefix(run_id)
    if db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", (prefix + "%",)):
        print("  p3 pilot shards already planned.", flush=True)
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
    route_counts: dict[str, int] = {r: 0 for r in routing.ROUTES}
    for table in config.GEMINI_TABLES:
        ids = sorted(set(picked.get(table, [])))
        if not ids:
            continue
        manifest += [(table, i) for i in ids]
        for route, route_ids in sorted(_route_split_ids(table, ids).items()):
            model = routing.model_for_route(route)
            route_counts[route] = route_counts.get(route, 0) + len(route_ids)
            for index in range(0, len(route_ids), config.SHARD_SIZE):
                chunk = route_ids[index : index + config.SHARD_SIZE]
                _insert_shard(
                    f"{prefix}{model}:{table}:{index // config.SHARD_SIZE:03d}",
                    table, chunk, run_id, model,
                )

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
                "pilot_routes": route_counts,
            }), run_id),
        )
    print(
        f"  p3 pilot planned: {len(manifest)} passages "
        f"(failed {n_failed} + success-slice {n_success} + fresh {n_fresh}); "
        f"routes core {route_counts.get('core', 0)} / standard {route_counts.get('standard', 0)}; "
        f"seed {config.SAMPLE_SEED!r}; manifest {checksum}.",
        flush=True,
    )


def plan_pilot_retry(run_id: str) -> int:
    """Plan ONE retry generation for every invalid/missing first-attempt pilot
    row, on the SAME model that failed ({prefix}retry:{model}:{table}:NNN).
    Guarded: if any retry shard already exists this is a no-op (a resume never
    re-retries). Returns the number of rows planned for retry."""
    prefix = pilot_prefix(run_id)
    if db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", (prefix + "retry:%",)):
        print("  pilot retry shards already planned.", flush=True)
        return 0
    by_model_table = failed_keys_from_files(prefix, run_id=run_id)
    planned = 0
    for (model, table), ids in sorted(by_model_table.items()):
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(
                f"{prefix}retry:{model}:{table}:{index // config.SHARD_SIZE:03d}",
                table, chunk, run_id, model,
            )
            planned += 1
    total = sum(len(v) for v in by_model_table.values())
    if total:
        print(f"  planned retry for {total} invalid/missing pilot row(s) in {planned} shard(s).", flush=True)
    return total


def plan_pilot_escalation(run_id: str) -> int:
    """Plan ONE escalation generation: STANDARD-route rows still invalid after
    their same-model retry are re-run once on MODEL_CORE
    ({prefix}esc:{model_core}:{table}:NNN). Core-route rows have no stronger
    target — they go to the final-failure list instead. No-op when the two
    models are identical (env override): there is no distinct escalation
    target, so the ladder terminates at the retry. Guarded like the retry."""
    if config.MODEL_CORE == config.MODEL_STANDARD:
        return 0
    prefix = pilot_prefix(run_id)
    if db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", (prefix + "esc:%",)):
        print("  pilot escalation shards already planned.", flush=True)
        return 0
    still = pilot_final_failures(prefix, run_id=run_id, include_escalation=False)
    planned = total = 0
    for (model, table), ids in sorted(still.items()):
        if model != config.MODEL_STANDARD:
            continue
        total += len(ids)
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(
                f"{prefix}esc:{config.MODEL_CORE}:{table}:{index // config.SHARD_SIZE:03d}",
                table, chunk, run_id, config.MODEL_CORE,
            )
            planned += 1
    if total:
        print(
            f"  planned escalation to {config.MODEL_CORE} for {total} standard-route"
            f" row(s) in {planned} shard(s).",
            flush=True,
        )
    return total


def _valid_and_invalid_keys(paths: list[Path]) -> tuple[set[str], set[str]]:
    """Scan result files → (valid_keys, invalid_keys) as 'table|id' strings.
    A key with BOTH a valid and an invalid line counts as valid (first valid
    response wins — a provider-side duplicate must never burn a row retry)."""
    valid: set[str] = set()
    invalid: set[str] = set()
    for path in paths:
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                key, parsed, _usage, error, _fr, _br = _parse_response_line(line)
                if not key or "|" not in (key or ""):
                    continue
                if error or parsed is None:
                    invalid.add(key)
                else:
                    valid.add(key)
    return valid, invalid - valid


def _pilot_skipped_ids(run_id: str) -> set[tuple[str, str]]:
    """(table, id) pairs already resolved as skipped_no_shortlist in this run —
    they never produce response lines and must not count as missing."""
    return {
        (t, pid)
        for t, pid in db.rows(
            "SELECT table_name, passage_id::text FROM public.tag_passage_outcomes"
            " WHERE run_id=%s::uuid AND outcome='skipped_no_shortlist'",
            (run_id,),
        )
    }


def failed_keys_from_files(shard_key_prefix: str,
                           run_id: str | None = None) -> dict[tuple[str, str], list[str]]:
    """First-attempt failures per (model, table) from the banked pilot files:
    ids whose response was schema-invalid PLUS — when run_id is given — ids in
    a first-pass shard's id_list with NO response line at all (a missing
    response counts as invalid; build-time skipped_no_shortlist rows are
    excluded via their outcome rows). First-pass files are globbed PER KNOWN
    MODEL ('<base><model>_*' — model strings never contain '_', so the match is
    unambiguous); retry/esc files carry their own key segment and never match."""
    base = shard_key_prefix.replace(":", "_")
    out: dict[tuple[str, str], set[str]] = {}
    for model in config.ROUTED_MODELS:
        paths = sorted(config.SHARDS_DIR.glob(f"{base}{model}_*.results.jsonl"))
        if not paths:
            continue
        _valid, invalid = _valid_and_invalid_keys(paths)
        for key in invalid:
            table, pid = key.split("|", 1)
            out.setdefault((model, table), set()).add(pid)
    if run_id:
        skipped = _pilot_skipped_ids(run_id)
        shards = db.rows(
            "SELECT shard_key, table_name, id_list::text[], model FROM public.tag_batch_jobs"
            " WHERE shard_key LIKE %s AND shard_key NOT LIKE %s AND shard_key NOT LIKE %s"
            " AND status IN ('retrieved','applied')",
            (shard_key_prefix + "%", shard_key_prefix + "retry:%", shard_key_prefix + "esc:%"),
        )
        for shard_key, table, ids, model in shards:
            results = config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.results.jsonl"
            present: set[str] = set()
            if results.exists():
                valid, invalid = _valid_and_invalid_keys([results])
                present = {k.split("|", 1)[1] for k in (valid | invalid) if "|" in k}
            for pid in ids:
                if pid not in present and (table, pid) not in skipped:
                    out.setdefault((model or "?", table), set()).add(pid)
    return {key: sorted(ids) for key, ids in out.items() if ids}


# SQL guard shared by the retry/escalation lanes: the row must not sit in any
# unfinished shard of this run (its next attempt is already planned/in flight).
_NOT_INFLIGHT = (
    " AND NOT EXISTS (SELECT 1 FROM public.tag_batch_jobs j"
    "   WHERE j.run_id = o.run_id AND j.table_name = o.table_name"
    "   AND j.status IN ('pending','submitted','running','retrieved')"
    "   AND o.passage_id = ANY(j.id_list))"
)


def plan_full_shards(run_id: str) -> int:
    """Plan a wave of full-run shards. v3.p3: coverage is ROW-LEVEL — a passage
    needs work unless it has an outcome row in tag_passage_outcomes for THIS
    run (the v3.p2 'id appeared in a shard' coverage was the silent-holes flaw).
    Three lanes per table, each sharded per model:
      fresh      — eligible rows with NO outcome row and not in an unfinished
                   shard of this run, route-split core/standard (routing.py);
      retry      — invalid/missing rows at attempt 1, retried once on the SAME
                   model that failed;
      escalation — STANDARD-route rows still invalid at attempt 2, re-run once
                   on MODEL_CORE (skipped when the two models are identical).
    Wave numbering is scoped to this run's keys. Returns shards planned."""
    prefix = full_prefix(run_id)
    wave = int(
        db.one(
            r"SELECT coalesce(max((regexp_match(shard_key, ':w(\d+):'))[1]::int), 0) + 1"
            r" FROM public.tag_batch_jobs WHERE shard_key LIKE %s",
            (prefix + "%",),
        )
        or 1
    )
    planned = 0

    def shard_out(kind_prefix: str, model: str, table: str, ids: list[str]) -> int:
        n = 0
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(
                f"{kind_prefix}{model}:{table}:w{wave:02d}:{index // config.SHARD_SIZE:04d}",
                table, chunk, run_id, model,
            )
            n += 1
        return n

    for table in config.GEMINI_TABLES:
        # Lane 1 — fresh (attempt 1), route-split in SQL.
        join, expr = routing.route_sql(table)
        by_route: dict[str, list[str]] = {}
        for pid, route in db.rows(
            f"WITH attempted AS (SELECT passage_id FROM public.tag_passage_outcomes"
            f"   WHERE run_id = %s::uuid AND table_name = %s),"
            f" inflight AS (SELECT DISTINCT unnest(id_list) AS id FROM public.tag_batch_jobs"
            f"   WHERE run_id = %s::uuid AND table_name = %s"
            f"   AND status IN ('pending','submitted','running','retrieved'))"
            f" SELECT t.id::text, {expr} AS route"
            f" FROM public.{table} t{join}"
            f" LEFT JOIN attempted a ON a.passage_id = t.id"
            f" LEFT JOIN inflight f ON f.id = t.id"
            f" WHERE t.embedding_context4 IS NOT NULL AND a.passage_id IS NULL AND f.id IS NULL"
            f" ORDER BY t.id",
            (run_id, table, run_id, table),
        ):
            by_route.setdefault(route, []).append(pid)
        for route, ids in sorted(by_route.items()):
            planned += shard_out(prefix, routing.model_for_route(route), table, ids)

        # Lane 2 — retry once on the SAME model that failed.
        by_model: dict[str, list[str]] = {}
        for pid, model in db.rows(
            "SELECT o.passage_id::text, o.model FROM public.tag_passage_outcomes o"
            " WHERE o.run_id = %s::uuid AND o.table_name = %s"
            " AND o.outcome IN ('invalid','missing_response') AND o.attempt = 1"
            + _NOT_INFLIGHT + " ORDER BY o.passage_id",
            (run_id, table),
        ):
            by_model.setdefault(model, []).append(pid)
        for model, ids in sorted(by_model.items()):
            planned += shard_out(prefix + "retry:", model, table, ids)

        # Lane 3 — escalate still-invalid STANDARD rows once to MODEL_CORE.
        if config.MODEL_CORE != config.MODEL_STANDARD:
            esc_ids = [
                r[0]
                for r in db.rows(
                    "SELECT o.passage_id::text FROM public.tag_passage_outcomes o"
                    " WHERE o.run_id = %s::uuid AND o.table_name = %s"
                    " AND o.outcome IN ('invalid','missing_response')"
                    " AND o.attempt = 2 AND o.model = %s"
                    + _NOT_INFLIGHT + " ORDER BY o.passage_id",
                    (run_id, table, config.MODEL_STANDARD),
                )
            ]
            planned += shard_out(prefix + "esc:", config.MODEL_CORE, table, esc_ids)

    if planned:
        print(f"  planned {planned} full-run shards (wave {wave}).", flush=True)
    return planned


def _insert_shard(shard_key: str, table: str, ids: list[str], run_id: str, model: str) -> None:
    prices = config.batch_prices(model)
    if prices is None:  # defense in depth behind --doctor: unpriced ⇒ no spend, ever
        raise SystemExit(
            f"FATAL: no pinned batch price for model {model!r} — refusing to plan"
            " shards for it. Pin it in config.GEMINI_BATCH_PRICES_CANONICAL."
        )
    with db.get_pg().cursor() as cur:
        cur.execute(
            "INSERT INTO public.tag_batch_jobs"
            " (shard_key, table_name, id_list, row_count, run_id, model,"
            "  price_in_per_m, price_out_per_m)"
            " VALUES (%s, %s, %s::uuid[], %s, %s::uuid, %s, %s, %s)"
            " ON CONFLICT (shard_key) DO NOTHING",
            (shard_key, table, ids, len(ids), run_id, model, prices[0], prices[1]),
        )


def record_outcomes(run_id: str, rows: list[tuple], cur) -> None:
    """Upsert row-level outcomes inside the CALLER's transaction. `rows` are
    (table_name, passage_id, shard_key, model, attempt, outcome, failure_class).
    The guard never downgrades a RESOLVED row (applied / skipped_no_shortlist);
    every accepted write appends to `history` so quarantine reports keep the
    full per-attempt error trail."""
    if not rows:
        return
    cur.executemany(
        "INSERT INTO public.tag_passage_outcomes AS o"
        " (run_id, table_name, passage_id, shard_key, model, attempt, outcome,"
        "  failure_class, history)"
        " VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s,"
        "         jsonb_build_array(jsonb_build_object("
        "           'attempt', %s::int, 'model', %s::text,"
        "           'outcome', %s::text, 'failure_class', %s::text)))"
        " ON CONFLICT (run_id, table_name, passage_id) DO UPDATE SET"
        "   shard_key = EXCLUDED.shard_key, model = EXCLUDED.model,"
        "   attempt = greatest(o.attempt, EXCLUDED.attempt),"
        "   outcome = EXCLUDED.outcome, failure_class = EXCLUDED.failure_class,"
        "   history = o.history || EXCLUDED.history, updated_at = now()"
        " WHERE o.outcome NOT IN ('applied','skipped_no_shortlist')",
        [
            (run_id, t, pid, sk, model, attempt, outcome, fc, attempt, model, outcome, fc)
            for (t, pid, sk, model, attempt, outcome, fc) in rows
        ],
    )


def is_quarantinable(model: str, attempt: int) -> bool:
    """Pure mirror of quarantine_exhausted's SQL predicate (kept in lock-step;
    unit-tested): no recourse left after a failed CORE retry (attempt ≥ 2 on
    MODEL_CORE — also the terminal rung when the two models are identical) or a
    failed escalation (attempt ≥ 3)."""
    return (attempt >= 2 and model == config.MODEL_CORE) or attempt >= 3


def quarantine_exhausted(run_id: str) -> int:
    """Mark rows with no further recourse as `quarantined` (terminal,
    UNRESOLVED): a failed same-model retry on the CORE model, or a failed
    escalation (attempt ≥ 3). When MODEL_CORE == MODEL_STANDARD (env override)
    escalation degenerates and the core-model rule still terminates the ladder
    at attempt 2. Appends the transition to `history`. Returns rows quarantined."""
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_passage_outcomes o SET outcome='quarantined',"
            " history = o.history || jsonb_build_array(jsonb_build_object("
            "   'attempt', o.attempt, 'model', o.model,"
            "   'outcome', 'quarantined', 'failure_class', o.failure_class)),"
            " updated_at = now()"
            " WHERE o.run_id = %s::uuid AND o.outcome IN ('invalid','missing_response')"
            " AND ((o.attempt >= 2 AND o.model = %s) OR o.attempt >= 3)",
            (run_id, config.MODEL_CORE),
        )
        n = cur.rowcount
    if n:
        print(f"  ⛔ quarantined {n} row(s) as UNRESOLVED (retry + escalation exhausted).", flush=True)
    return n


def unresolved_for_run(run_id: str) -> dict:
    """Row-level completion state for this run:
      unattempted — eligible rows with NO outcome row and not in an unfinished
                    shard of this run (still need a first attempt);
      retryable   — invalid/missing rows the retry/escalation lanes still own;
      quarantined — terminal, UNRESOLVED (run is never complete while any exist)."""
    unattempted = 0
    for table in config.GEMINI_TABLES:
        unattempted += int(
            db.one(
                f"WITH attempted AS (SELECT passage_id FROM public.tag_passage_outcomes"
                f"   WHERE run_id = %s::uuid AND table_name = %s),"
                f" inflight AS (SELECT DISTINCT unnest(id_list) AS id FROM public.tag_batch_jobs"
                f"   WHERE run_id = %s::uuid AND table_name = %s"
                f"   AND status IN ('pending','submitted','running','retrieved'))"
                f" SELECT count(*) FROM public.{table} t"
                f" LEFT JOIN attempted a ON a.passage_id = t.id"
                f" LEFT JOIN inflight f ON f.id = t.id"
                f" WHERE t.embedding_context4 IS NOT NULL AND a.passage_id IS NULL"
                f" AND f.id IS NULL",
                (run_id, table, run_id, table),
            )
            or 0
        )
    retryable, quarantined = db.rows(
        "SELECT count(*) FILTER (WHERE outcome IN ('invalid','missing_response')),"
        "       count(*) FILTER (WHERE outcome = 'quarantined')"
        " FROM public.tag_passage_outcomes WHERE run_id = %s::uuid",
        (run_id,),
    )[0]
    return {
        "unattempted": int(unattempted),
        "retryable": int(retryable),
        "quarantined": int(quarantined),
    }


def quarantined_rows(run_id: str, limit: int = 50) -> list[tuple]:
    """(table, id, model, attempt, failure_class, history) for the quarantine
    listing — the explicit, never-silent record of unresolved passages."""
    return db.rows(
        "SELECT table_name, passage_id::text, model, attempt, failure_class,"
        "       history::text"
        " FROM public.tag_passage_outcomes"
        " WHERE run_id = %s::uuid AND outcome = 'quarantined'"
        " ORDER BY table_name, passage_id LIMIT %s",
        (run_id, limit),
    )


def remaining_by_route(run_id: str) -> dict[str, int]:
    """Eligible rows with NO outcome row in this run, per route — the honest
    'work left to pay for' basis of the pilot report's full-run extrapolation."""
    totals: dict[str, int] = {r: 0 for r in routing.ROUTES}
    for table in config.GEMINI_TABLES:
        join, expr = routing.route_sql(table)
        for route, n in db.rows(
            f"WITH attempted AS (SELECT passage_id FROM public.tag_passage_outcomes"
            f"   WHERE run_id = %s::uuid AND table_name = %s)"
            f" SELECT {expr} AS route, count(*) FROM public.{table} t{join}"
            f" LEFT JOIN attempted a ON a.passage_id = t.id"
            f" WHERE t.embedding_context4 IS NOT NULL AND a.passage_id IS NULL"
            f" GROUP BY 1",
            (run_id, table),
        ):
            totals[route] = totals.get(route, 0) + int(n)
    return totals


# ── cost ledger (machine-enforced ceiling; model-aware in v3.p3) ────────────

def _usd(model: str, input_tok: float, output_tok: float) -> float:
    """Price a token pair at `model`'s effective Batch prices. An unpriced model
    is a hard stop — money must never be spent (or estimated) at a guess."""
    prices = config.batch_prices(model)
    if prices is None:
        raise SystemExit(
            f"FATAL: no pinned batch price for model {model!r} — cannot price its"
            " tokens. Pin it in config.GEMINI_BATCH_PRICES_CANONICAL."
        )
    return input_tok / 1e6 * prices[0] + output_tok / 1e6 * prices[1]


# Every shard row records its model + prices at insert, and audit's legacy
# backfill stamps all pre-p3 rows (they were all gemini-3.5-flash), so the
# ledger prices strictly by RECORDED per-row prices. The COALESCE fallback only
# guards the window before the first p3 ensure_audit_tables() ran; --doctor
# FAILS if any billed row is still unpriced after that.
_LEDGER_FALLBACK = config.GEMINI_BATCH_PRICES_CANONICAL["gemini-3.5-flash"]
# The real bucket counts 'failed' too: a batch that ended in a terminal
# non-success state (e.g. BATCH_STATE_EXPIRED) may still have produced — and
# billed for — a partial output file, whose usage collect() records into
# cost_* before failing the shard. For a clean failure cost_* is 0, so 'failed'
# contributes nothing; the only effect is that genuinely-billed partial spend
# is never invisible to the ledger or the ceiling.
_LEDGER_SUMS = (
    " coalesce(sum(CASE WHEN status IN ('retrieved','applied','failed') THEN"
    "   cost_input_tok  * coalesce(price_in_per_m,  %(fin)s)  / 1e6"
    " + cost_output_tok * coalesce(price_out_per_m, %(fout)s) / 1e6 END), 0),"
    " coalesce(sum(CASE WHEN status IN ('submitted','running') THEN"
    "   est_input_tok  * coalesce(price_in_per_m,  %(fin)s)  / 1e6"
    " + est_output_tok * coalesce(price_out_per_m, %(fout)s) / 1e6 END), 0)"
)
_LEDGER_PARAMS = {"fin": _LEDGER_FALLBACK[0], "fout": _LEDGER_FALLBACK[1]}


def spend_ledger() -> dict:
    real_usd, est_usd = db.rows(
        "SELECT" + _LEDGER_SUMS + " FROM public.tag_batch_jobs", _LEDGER_PARAMS
    )[0]
    return {
        "real_usd": float(real_usd),
        "in_flight_est_usd": float(est_usd),
        "committed_usd": float(real_usd) + float(est_usd),
    }


# Committed spend using ONLY columns present on BOTH the p2 and p3 schemas (no
# model / price_* columns) priced at the canonical core rate. For a read-only
# ceiling floor computed from a context that never runs the p3 audit DDL (the
# bakeoff): the full ledger's price_* references would raise "undefined column"
# on a pre-p3 DB, and that error must never be silently read as $0 spend.
_COMMITTED_LEGACY_SUM = (
    " coalesce(sum("
    "   CASE WHEN status IN ('retrieved','applied','failed')"
    "     THEN cost_input_tok * %(fin)s / 1e6 + cost_output_tok * %(fout)s / 1e6"
    "   WHEN status IN ('submitted','running')"
    "     THEN est_input_tok * %(fin)s / 1e6 + est_output_tok * %(fout)s / 1e6"
    "   ELSE 0 END), 0)"
)


def committed_usd_schema_agnostic() -> float:
    """DB committed spend (real + in-flight est) priced at the canonical core
    (3.5-flash) rate, using only p2/p3-common columns. Over-prices standard-route
    rows — deliberately conservative for a ceiling floor. Raises on a genuinely
    unreachable DB (the caller distinguishes that from a $0 result)."""
    return float(
        db.rows(
            "SELECT" + _COMMITTED_LEGACY_SUM + " FROM public.tag_batch_jobs",
            _LEDGER_PARAMS,
        )[0][0]
    )


def spend_ledger_by_model() -> dict[str, dict]:
    """Per-model ledger for --doctor: {model: {real_usd, in_flight_est_usd}}.
    Rows still unpriced/unstamped (pre-backfill) appear under a loud label."""
    out: dict[str, dict] = {}
    for model, real_usd, est_usd in db.rows(
        "SELECT coalesce(model, '(unstamped legacy — run run_all to backfill)'),"
        + _LEDGER_SUMS
        + " FROM public.tag_batch_jobs GROUP BY 1 ORDER BY 1",
        _LEDGER_PARAMS,
    ):
        out[model] = {
            "real_usd": float(real_usd),
            "in_flight_est_usd": float(est_usd),
        }
    return out


def measured_output_tokens_per_row(model: str) -> float:
    """Measured avg output tokens/row for `model` once real usage exists, else
    the all-model average, else the pre-pilot estimate — so the cheap standard
    model's estimates are never inflated by 3.5 Flash history (or vice versa)."""
    for where, params in (
        ("AND model = %s", (model,)),
        ("", ()),
    ):
        row = db.rows(
            "SELECT coalesce(sum(cost_output_tok),0), coalesce(sum(row_count),0)"
            " FROM public.tag_batch_jobs"
            f" WHERE status IN ('retrieved','applied') AND cost_output_tok > 0 {where}",
            params,
        )[0]
        total_out, total_rows = float(row[0]), float(row[1])
        if total_rows > 0 and total_out > 0:
            return total_out / total_rows
    return float(config.EST_OUTPUT_TOKENS_PER_PASSAGE)


# ── submission ──────────────────────────────────────────────────────────────

@dataclass
class ShardPart:
    """One submittable batch job: a shard, or one token-bounded slice of a shard
    that was too large for the queue and got split. Carries the routed model —
    the batch is created against it and the ceiling prices its estimate with it."""
    shard_key: str
    rows: int
    est_in: int
    est_out: int
    model: str


def _est_tokens(raw: str) -> int:
    return len(raw) // 4  # chars/4 ≈ tokens; includes schema+enum overhead


def _build_request_lines(
    table: str, ids: list[str], vocab: VocabIndex, max_output_tokens: int | None = None
) -> tuple[list[tuple[str, str, int]], list[str]]:
    """Load a shard's rows and return (lines, skipped_ids). `lines` is one
    (passage_id, raw_json, est_in_tokens) per USABLE passage (one with a
    candidate shortlist); `skipped_ids` are rows dropped for a missing
    embedding/shortlist (never sent, but still counted as covered).
    `max_output_tokens` is the TIERED Tier-3 cap for this shard's ladder attempt
    (build_shard_parts derives it from the shard key)."""
    passages = load_passages(table, ids)
    if config.PURE_CLASSIFICATION:
        attach_shortlists_v4(table, passages, vocab)
    else:
        attach_shortlists(table, passages, vocab)
    lines: list[tuple[str, str, int]] = []
    skipped_ids: list[str] = []
    for passage in passages:
        if not passage.shortlist:
            skipped_ids.append(passage.id)
            continue
        raw = json.dumps(request_line(passage, vocab, max_output_tokens), ensure_ascii=False)
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


def _write_part_file(shard_key: str, lines: list[tuple[str, str, int]], model: str) -> ShardPart:
    """Write shards/<key>.requests.jsonl for one packed part."""
    config.SHARDS_DIR.mkdir(parents=True, exist_ok=True)
    est_in = 0
    with open(shard_request_path(shard_key), "w", encoding="utf-8", newline="\n") as f:
        for _pid, raw, tok in lines:
            est_in += tok
            f.write(raw + "\n")
    est_out = int(len(lines) * measured_output_tokens_per_row(model))
    return ShardPart(shard_key, len(lines), est_in, est_out, model)


def build_shard_parts(
    shard_key: str, table: str, ids: list[str], vocab: VocabIndex,
    run_id: str | None, model: str
) -> tuple[list[ShardPart], list[str]]:
    """Build the request JSONL for a pending shard, capping every job's input at
    config.MAX_SHARD_INPUT_TOKENS so it always fits the 3M batch queue. A shard
    whose built requests fit the cap is written as-is and returned unchanged. An
    OVERSIZED shard is split into token-bounded parts: the pending row is
    transactionally replaced by one pending row per part (deterministic keys
    '<shard_key>:p00', ':p01', …, each carrying the shard's model + prices),
    each part's file is written, and the parts are returned in order. The union
    of the parts' id_lists equals the original id_list — rows with no shortlist
    ride along on the first part — so reconciliation is unchanged.

    Returns (parts, skipped_ids). skipped_ids are rows with no shortlist /
    embedding: v3.p3 records them as explicit `skipped_no_shortlist` outcome
    rows (resolved-but-listed) — NEVER silently 'covered'. parts is [] when the
    shard has no usable rows (the caller fails it). Idempotent on rerun: an
    already-split part fits the cap and is returned without re-splitting.

    The Tier-3 maxOutputTokens cap is TIERED by the shard's ladder attempt
    (derived from its key): first pass 2048, same-model retry 4096, escalation
    8192 — so a MAX_TOKENS truncation is always given more room before quarantine."""
    max_output_tokens = config.tier3_output_cap(attempt_for_shard_key(shard_key))
    lines, skipped_ids = _build_request_lines(table, ids, vocab, max_output_tokens)
    if skipped_ids:
        print(
            f"    {shard_key}: {len(skipped_ids)} rows have no shortlist"
            " (missing embedding) — recorded as skipped_no_shortlist",
            flush=True,
        )
    if not lines:
        return [], skipped_ids
    parts = _pack_parts(lines)
    if len(parts) == 1:
        return [_write_part_file(shard_key, parts[0], model)], skipped_ids

    # Oversized shard → split. Repartition the DB row atomically FIRST; on a crash
    # after the commit the pending part rows rebuild idempotently (each part
    # already fits the cap, so no further split).
    prices = config.batch_prices(model)
    if prices is None:
        raise SystemExit(f"FATAL: no pinned batch price for model {model!r}.")
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
                    " (shard_key, table_name, id_list, row_count, run_id, model,"
                    "  price_in_per_m, price_out_per_m)"
                    " VALUES (%s, %s, %s::uuid[], %s, %s::uuid, %s, %s, %s)",
                    (part_key, table, part_ids, len(part_ids), run_id, model,
                     prices[0], prices[1]),
                )
    print(
        f"  split {shard_key}: {len(lines)} requests exceed the"
        f" {config.MAX_SHARD_INPUT_TOKENS / 1e6:.1f}M-token cap →"
        f" {len(parts)} parts",
        flush=True,
    )
    return (
        [_write_part_file(part_key, part, model) for part_key, part in zip(part_keys, parts)],
        skipped_ids,
    )


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


def _inflight_jobs_from_db() -> list[str]:
    """The pipeline's in-flight provider job ids: every recorded `submitted`
    shard. Used by the queue-drain wait to detect a freed slot."""
    return [j for (j,) in db.rows(
        "SELECT provider_job_id FROM public.tag_batch_jobs"
        " WHERE status = 'submitted' AND provider_job_id IS NOT NULL"
    )]


def _poll_queue_quota(already_terminal: set[str], inflight_fn=None) -> bool:
    """Sleep one poll cycle, then report the state of every already-submitted
    job. Returns True if a NEW job reached a terminal state since the last cycle
    (a queue slot was freed → the create is worth retrying). Mutates
    `already_terminal` with any newly-terminal job ids. Prints exactly one status
    line: jobs running / done / shards still pending.

    `inflight_fn` supplies the current in-flight provider job ids. It defaults to
    the pipeline's DB view; the NO-DB bakeoff passes a function reading its local
    state file, so the same patient wait covers bakeoff/pilot/full paths."""
    time.sleep(QUEUE_QUOTA_POLL_SECONDS)
    if inflight_fn is None:
        submitted = _inflight_jobs_from_db()
        pending = db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE status = 'pending'")
    else:
        submitted = list(inflight_fn())
        pending = None
    running = done = 0
    freed = False
    for job_id in submitted:
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
    pending_note = f" {pending} shard(s) still pending;" if pending is not None else ""
    print(
        f"  ⏳ batch queue full — {running} job(s) running, {done} done,"
        f"{pending_note} polling again in {QUEUE_QUOTA_POLL_SECONDS // 60}m…",
        flush=True,
    )
    return freed


def _create_batch_draining_queue(
    model: str, file_name: str, display_name: str, shard_key: str,
    already_terminal: set[str], inflight_fn=None
) -> str:
    """gemini_client.create_batch, but patient about a full batch queue. On HTTP
    429 (queue quota exhausted) it waits for a submitted job to finish and free a
    slot instead of crashing; every other error re-raises immediately. Gives up
    only after QUEUE_QUOTA_GIVE_UP_SECONDS with no job freeing a slot.

    `inflight_fn` (see _poll_queue_quota) makes this reusable by the NO-DB
    bakeoff path, which tracks its in-flight jobs in a local state file rather
    than tag_batch_jobs — so bakeoff, pilot and full all wait instead of crashing."""
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
        if _poll_queue_quota(already_terminal, inflight_fn):
            no_progress_deadline = time.monotonic() + QUEUE_QUOTA_GIVE_UP_SECONDS
        elif time.monotonic() >= no_progress_deadline:
            raise SystemExit(
                "FATAL: the Gemini batch queue has been full for 24h with no job"
                " finishing to free a slot — cannot submit further shards now."
                " Rerun `python run_all.py --resume` once jobs drain to continue"
                " where this left off (already-submitted work is safe in the DB)."
            )


def _submit_one(part: ShardPart, queue_terminal_seen: set[str]) -> bool:
    """Upload + create one shard's batch job against the shard's ROUTED model,
    recording it BEFORE any polling. Returns False (submitting nothing) when the
    cost ceiling would be exceeded so the caller stops submitting further shards.
    A full batch queue does NOT stop the run: _create_batch_draining_queue waits
    for a slot to free."""
    shard_key, model = part.shard_key, part.model
    ledger = spend_ledger()
    projected = ledger["committed_usd"] + _usd(model, part.est_in, part.est_out)
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
    print(
        f"  submitted {shard_key} → {job_name} ({model}, ~{part.est_in / 1e6:.2f}M in tok)",
        flush=True,
    )
    return True


def submit_pending(vocab: VocabIndex, run_id: str | None = None) -> None:
    """Submit pending p3 shards while the ceiling allows, each against its OWN
    recorded model. Job IDs are recorded in tag_batch_jobs immediately on
    acceptance — BEFORE any polling. A full batch queue (HTTP 429) does not
    crash the run: it waits for in-flight jobs to drain a slot, so a large shard
    list submits in waves, unattended. Any shard whose built requests exceed
    config.MAX_SHARD_INPUT_TOKENS is split into token-bounded parts
    (build_shard_parts) so every job fits the 3M queue. Rows skipped at build
    time (no shortlist/embedding) get explicit `skipped_no_shortlist` outcome
    rows. Stale pre-p3 pending rows (no recorded model) are never submitted.

    `run_id` scopes submission to the ACTIVE run's own pending shards. Without
    it, an aborted prior run whose identity changed (new run_id) would leave
    orphan pending shards that this run would submit and pay for yet never
    collect (collect() is run-prefix scoped), then re-plan + pay for again. The
    common resume path reuses the same run_id, so scoping never blocks a legit
    resume. Callers always pass it; the default is a defensive no-scope fallback."""
    where = "status = 'pending'"
    params: tuple = ()
    if run_id is not None:
        where += " AND run_id = %s::uuid"
        params = (run_id,)
    pending = db.rows(
        "SELECT shard_key, table_name, id_list::text[], run_id::text, model"
        f" FROM public.tag_batch_jobs WHERE {where} ORDER BY shard_key",
        params,
    )
    # Shared across every shard's wait so completions during one shard's wait
    # aren't miscounted as fresh progress for the next.
    queue_terminal_seen: set[str] = set()
    for shard_key, table, ids, run_id, model in pending:
        if not model or not (shard_key.startswith(config.PILOT_SHARD_PREFIX)
                             or shard_key.startswith(config.FULL_SHARD_PREFIX)):
            print(f"  skipping stale pre-p3 pending shard {shard_key} (never submitted)", flush=True)
            continue
        parts, skipped_ids = build_shard_parts(shard_key, table, ids, vocab, run_id, model)
        if skipped_ids and run_id:
            with db.get_pg().cursor() as cur:
                record_outcomes(
                    run_id,
                    [(table, pid, shard_key, model, attempt_for_shard_key(shard_key),
                      "skipped_no_shortlist", "no shortlist/embedding")
                     for pid in skipped_ids],
                    cur,
                )
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
            if not _submit_one(part, queue_terminal_seen):
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
    model: str = ""                   # routed model recorded on the shard row
    attempt: int = 1                  # derived from the shard key (retry/esc)
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
    # v3.p3 ROW-LEVEL outcomes staged for tag_passage_outcomes:
    # (table, passage_id, shard_key, model, attempt, outcome, failure_class).
    outcome_rows: list[tuple] = field(default_factory=list)
    # v4-tiered: passage ids whose tags_core must be re-materialized from
    # tag_evidence after this shard's Tier-3 rows land (the merge of Tiers 1+2+3).
    recompute_ids: list[str] = field(default_factory=list)


def _gate_shard(shard_key: str, table: str, results_path, vocab: VocabIndex) -> ShardOutcome:
    """Parse + gate one shard's results file into staged writes on the returned
    ShardOutcome — WITHOUT touching the DB. Gates: out-of-vocabulary → HARD drop;
    unresolvable evidence sentence id → SOFT (tag kept, evidence_found=false);
    unevidenced question → dropped; passage_function outside the enum → NULL.
    Evidence is a sentence ID resolved back to the EXACT source sentence text.

    v3.p3 additionally STAGES a row-level outcome for every id in the shard:
    valid → applied; schema-invalid → invalid (+failure bucket); id with no
    response line at all → missing_response. A duplicate key inside one file is
    resolved FIRST-VALID-WINS (logged; never double-applied, and a provider-side
    duplicate never burns the row's retry). Build-time-skipped rows are also
    staged missing_response here, but their resolved `skipped_no_shortlist`
    outcome row can never be downgraded (record_outcomes guard)."""
    shard_row = db.rows(
        "SELECT id_list::text[], model FROM public.tag_batch_jobs WHERE shard_key=%s",
        (shard_key,),
    )
    id_list, model = (shard_row[0] if shard_row else ([], ""))
    attempt = attempt_for_shard_key(shard_key)
    outcome = ShardOutcome(shard_key=shard_key, table=table, model=model or "", attempt=attempt)
    passages = {p.id: p for p in load_passages(table, list(id_list))}
    pure = config.PURE_CLASSIFICATION
    # v4-tiered.2: reconstruct the EXACT Tier-3 candidate list attach_shortlists_v4
    # built (union of top-K label, top-K exemplar, lexical → the middle band) so we
    # have both the LABEL similarity for each confirmation's confidence AND the
    # judged-but-dropped audit trail. Deterministic from the frozen p1 exemplars +
    # stored embeddings + the active threshold, so it matches on every resume.
    sim_by: dict[str, dict[str, float | None]] = {}
    mid_by: dict[str, list[str]] = {}
    if pure and id_list:
        import tiers
        concept_index = tiers.concept_alias_index(tiers.build_vocab_dict(vocab))
        cand_by = tiers.tier3_shortlist_for_passages(table, list(passages.values()), concept_index)
        for pid, cand in cand_by.items():
            sim_by[pid] = {slug: sim for slug, sim, _is_lex in cand}
            mid_by[pid] = tiers.middle_band(cand, config.TIER2_REJECT)
    tier3_method = "llm_confirmed" if pure else None
    resolved_ids: dict[str, bool] = {}  # passage_id → had a schema-valid response

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
            if resolved_ids.get(passage_id):
                # Duplicate key after a valid response: first valid wins.
                print(f"  {shard_key}: duplicate response line for {key} ignored", flush=True)
                continue
            if error or parsed is None:
                if passage_id in resolved_ids:
                    continue  # already saw an invalid line for this id — keep one outcome
                # Schema-invalid row: classify WHY it failed from the model's own
                # signal before dropping it, so the reason is tallied not lost.
                bucket = classify_schema_failure(error, finish_reason, block_reason)
                outcome.schema_invalid_reasons[bucket] += 1
                if bucket == "other":
                    outcome.other_reasons.append(raw_failure_signal(error, finish_reason, block_reason))
                resolved_ids[passage_id] = False
                outcome.outcome_rows.append(
                    (table, passage_id, shard_key, model, attempt, "invalid", bucket)
                )
                continue
            if passage_id in resolved_ids and not resolved_ids[passage_id]:
                # A valid line after an invalid one for the same id: the valid
                # response wins — drop the staged invalid outcome for this id.
                outcome.outcome_rows = [
                    r for r in outcome.outcome_rows if r[1] != passage_id
                ]
            resolved_ids[passage_id] = True
            outcome.outcome_rows.append(
                (table, passage_id, shard_key, model, attempt, "applied", None)
            )
            outcome.schema_valid += 1

            sents = sentence_split.split_sentences(passage.text)
            accepted: list[str] = []
            for item in parsed.get("tags", [])[: config.MAX_TAGS]:
                if not isinstance(item, dict):
                    continue
                # v4 returns {"slug": …}; the legacy generative schema used "tag".
                tag = str(item.get("slug") or item.get("tag") or "").strip()
                sid = item.get("evidence_sentence_id")
                sid = sid.strip() if isinstance(sid, str) else None
                found, ev_text, start, end, miss = sentence_split.resolve_sentence(sid, sents)
                outcome.tags_returned += 1
                if tag not in vocab.slugs:
                    # HARD gate — out-of-vocabulary is never written to tags_core.
                    outcome.tags_out_of_vocab += 1
                    outcome.evidence_records.append(
                        (table, passage_id, tag, ev_text, False, "out of vocabulary",
                         found, start, end, sid, tier3_method, None)
                    )
                    continue
                if tag in accepted:
                    continue
                # SOFT gate — the tag is KEPT either way; a miss (id didn't resolve
                # to a target sentence) is flagged evidence_found=false. Tier-3
                # confidence = the embedding similarity that shortlisted the tag.
                accepted.append(tag)
                outcome.tags_accepted += 1
                if not found:
                    outcome.tags_unevidenced_kept += 1
                conf = sim_by.get(passage_id, {}).get(tag) if pure else None
                outcome.evidence_records.append(
                    (table, passage_id, tag, ev_text, True, miss, found, start, end, sid,
                     tier3_method, conf)
                )

            if pure:
                # Record the judge's NEGATIVE decisions: candidates in the Tier-3
                # candidate list (the reconstructed middle band) it did NOT confirm
                # (the full Tier-3 decision trail). tags_core is merged from
                # tag_evidence later; questions + passage_function are DEFERRED, so
                # no content columns are written from `updates` here.
                sims = sim_by.get(passage_id, {})
                confirmed = set(accepted)
                for slug in mid_by.get(passage_id, []):
                    if slug not in confirmed:
                        outcome.evidence_records.append(
                            (table, passage_id, slug, "", False, "llm_rejected",
                             False, None, None, None, "llm_confirmed", sims.get(slug))
                        )
                outcome.per_row_tag_counts.append(len(accepted))
                if not accepted:
                    outcome.zero_tag_rows += 1
                outcome.recompute_ids.append(passage_id)
                continue

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
    # Ids in the shard with NO response line at all count as failures too
    # (missing_response → row retry), never as silently covered. Build-time
    # skipped rows are staged here as well, but their `skipped_no_shortlist`
    # outcome row is resolved and the upsert guard refuses the downgrade.
    for pid in id_list:
        if pid not in resolved_ids:
            outcome.outcome_rows.append(
                (table, pid, shard_key, model, attempt, "missing_response", "no_response_line")
            )
    outcome.rows = len(outcome.recompute_ids) if config.PURE_CLASSIFICATION else len(outcome.updates)
    return outcome


def _write_outcomes(outcomes: list[ShardOutcome], run_id: str) -> None:
    """Write a batch of already-gated shards in ONE transaction (content columns +
    tag_evidence + row-level outcomes + each shard's applied-status). Used
    per-shard by the full run and as a single atomic bundle by the pilot —
    nothing is written unless the whole transaction commits. Token costs are NOT
    written here — they were already recorded at retrieval (collect), so a failed
    apply can never erase or defer real spend.

    v4-tiered: Tier-3 rows do NOT write content columns from `updates` (questions
    + passage_function are DEFERRED). Instead the shard's Tier-3 evidence is
    inserted, then tags_core is re-materialized from tag_evidence — the merge of
    Tiers 1+2 (written up front by tiers.apply_free_tiers) and this shard's Tier-3
    confirmations — via tiers.recompute_tags_core."""
    pure = config.PURE_CLASSIFICATION
    conn = db.get_pg()
    with conn.transaction():
        with conn.cursor() as cur:
            for outcome in outcomes:
                if not pure:
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
                        "  evidence_found, evidence_start, evidence_end, evidence_sentence_id,"
                        "  method, confidence)"
                        " VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)",
                        [(run_id, *r) for r in outcome.evidence_records],
                    )
                if pure and outcome.recompute_ids:
                    import tiers
                    for start in range(0, len(outcome.recompute_ids), config.DB_BATCH):
                        tiers.recompute_tags_core(
                            cur, run_id, outcome.table,
                            outcome.recompute_ids[start : start + config.DB_BATCH],
                        )
                record_outcomes(run_id, outcome.outcome_rows, cur)
                cur.execute(
                    "UPDATE public.tag_batch_jobs SET status='applied', applied_at=%s"
                    " WHERE shard_key=%s",
                    (datetime.now(timezone.utc), outcome.shard_key),
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


def usage_from_results_file(results_path) -> tuple[int, int, int, int]:
    """Sum usageMetadata over EVERY line of a downloaded results file:
    (input, output, candidate, thought) tokens, output = candidates + thinking
    (both billable). Used at retrieval time so the ledger counts every dollar
    actually spent the moment the results land — before (and regardless of)
    any apply step."""
    input_tok = output_tok = cand_tok = thought_tok = 0
    with open(results_path, encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            _key, _parsed, usage, _error, _fr, _br = _parse_response_line(line)
            input_tok += int(usage.get("promptTokenCount") or 0)
            cand = int(usage.get("candidatesTokenCount") or 0)
            thought = int(usage.get("thoughtsTokenCount") or 0)
            cand_tok += cand
            thought_tok += thought
            output_tok += cand + thought
    return input_tok, output_tok, cand_tok, thought_tok


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
                # v3.p3: real usage is recorded THE MOMENT results are retrieved
                # (one atomic UPDATE with the status flip) — the ledger predicate
                # (status IN retrieved/applied) then counts this spend even if
                # the apply step later fails or never runs (pilot download-only).
                in_tok, out_tok, cand_tok, thought_tok = usage_from_results_file(results_path)
                with db.get_pg().cursor() as cur:
                    cur.execute(
                        "UPDATE public.tag_batch_jobs SET status='retrieved', retrieved_at=%s,"
                        " cost_input_tok=%s, cost_output_tok=%s, cost_candidate_tok=%s,"
                        " cost_thought_tok=%s WHERE shard_key=%s",
                        (datetime.now(timezone.utc), in_tok, out_tok, cand_tok,
                         thought_tok, shard_key),
                    )
                if apply:
                    outcomes.append(apply_results(shard_key, table, results_path, run_id, vocab))
                    print(f"  applied {shard_key}", flush=True)
                else:
                    print(f"  downloaded {shard_key} (not yet applied)", flush=True)
                progressed = True
            elif state in gemini_client.TERMINAL_STATES:
                # Terminal non-success (e.g. BATCH_STATE_EXPIRED): the batch may
                # still have produced — and been BILLED for — a partial output
                # file. Capture its usage into cost_* (counted by the ledger's
                # real bucket, which includes 'failed') BEFORE failing the shard,
                # so billed partial spend is never invisible to the ceiling. The
                # shard is still failed → its rows re-plan (no silent holes); we
                # do not apply partial results here (an expired file may be
                # truncated), only meter the money already spent.
                if job.get("output_file"):
                    try:
                        db.with_retry(
                            lambda j=job, p=results_path: gemini_client.download_file(j["output_file"], p),
                            f"download partial {shard_key}",
                        )
                        in_tok, out_tok, cand_tok, thought_tok = usage_from_results_file(results_path)
                        if in_tok or out_tok:
                            with db.get_pg().cursor() as cur:
                                cur.execute(
                                    "UPDATE public.tag_batch_jobs SET cost_input_tok=%s,"
                                    " cost_output_tok=%s, cost_candidate_tok=%s,"
                                    " cost_thought_tok=%s WHERE shard_key=%s",
                                    (in_tok, out_tok, cand_tok, thought_tok, shard_key),
                                )
                            print(
                                f"  captured partial usage from {state} {shard_key}"
                                f" (~{out_tok / 1e3:.1f}K out tok) before failing", flush=True,
                            )
                    except Exception as exc:  # noqa: BLE001 — best-effort metering
                        print(f"  {shard_key}: no partial output captured from {state}"
                              f" ({str(exc)[:120]})", flush=True)
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
    """Gate EVERY retrieved pilot shard (original + retry + esc) and write them all
    in ONE transaction. On a clean pass (100% row-level validity) a first-pass-invalid
    id is written from its retry/esc shard and no id is written twice. Under
    --accept-quarantine it is also called WITH still-invalid rows present: those rows
    simply carry an `invalid`/`missing_response` outcome (no content) — the caller then
    promotes them to `quarantined` — while every RESOLVED row is applied normally.
    All-or-nothing: a mid-apply failure leaves prior content + evidence intact."""
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


def pilot_final_failures(shard_key_prefix: str, run_id: str | None = None,
                         include_escalation: bool = True) -> dict[tuple[str, str], list[str]]:
    """Ids STILL invalid/missing after the rescue ladder, per (model, table):
    first-attempt failures (schema-invalid + missing responses) not rescued by a
    valid response in a retry file — nor, when include_escalation, an esc file.
    Empty ⇒ 100% row-level validity ⇒ safe to apply. The (model, table) key is
    the FIRST-attempt model, so the caller can see which route still fails."""
    first = failed_keys_from_files(shard_key_prefix, run_id=run_id)
    base = shard_key_prefix.replace(":", "_")
    rescue_globs = [f"{base}retry_*.results.jsonl"]
    if include_escalation:
        rescue_globs.append(f"{base}esc_*.results.jsonl")
    rescue_paths: list[Path] = []
    for pattern in rescue_globs:
        rescue_paths.extend(sorted(config.SHARDS_DIR.glob(pattern)))
    rescued, _still_invalid = _valid_and_invalid_keys(rescue_paths)
    still: dict[tuple[str, str], list[str]] = {}
    for (model, table), ids in first.items():
        rem = [pid for pid in ids if f"{table}|{pid}" not in rescued]
        if rem:
            still[(model, table)] = rem
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


def _rest_after_base(name: str, base: str) -> str:
    return name[len(base):] if name.startswith(base) else name


def _attempt_from_filename(name: str, base: str) -> int:
    """Attempt number from a banked result filename: `esc_`→3, `retry_`→2, else 1.
    The filename mirror of attempt_for_shard_key (keys use ':', files use '_')."""
    rest = _rest_after_base(name, base)
    if rest.startswith("esc_"):
        return 3
    if rest.startswith("retry_"):
        return 2
    return 1


def _model_from_filename(name: str, base: str) -> str:
    """The routed model embedded in a banked result filename
    (``<base>[retry_|esc_]<model>_…``). Model strings never contain '_', so the
    prefix match against the known routed models is unambiguous; older/foreign
    files fall to '(unknown)'."""
    rest = _rest_after_base(name, base)
    for seg in ("retry_", "esc_"):
        if rest.startswith(seg):
            rest = rest[len(seg):]
    for m in config.ROUTED_MODELS:
        if rest.startswith(m + "_"):
            return m
    return "(unknown)"


def pilot_quarantine_listing(shard_key_prefix: str,
                             still: dict[tuple[str, str], list[str]],
                             excerpt_chars: int = 240) -> list[dict]:
    """The explicit, never-silent QUARANTINE record required by design: one dict
    per row still invalid/missing after retry + escalation, carrying

      - ``table`` + ``passage_id``,
      - ``attempts`` — the FULL per-attempt failure history reconstructed from the
        banked shard files: ``{attempt, model, finish_reason, block_reason,
        bucket, raw}`` for each attempt, ordered attempt 1→3 (the raw
        finishReason/blockReason signal is kept inline for `other`-bucketed
        attempts so nothing is lost), and
      - ``excerpt`` — a short passage excerpt (from the DB).

    The FILES supply the history (present in both the refuse and the
    --accept-quarantine paths, before any tag_passage_outcomes rows exist); the DB
    supplies the excerpt. Sorted by (table, passage_id). No Gemini calls, no cost."""
    targets: dict[str, dict] = {}
    ids_by_table: dict[str, set[str]] = {}
    for (model, table), ids in still.items():
        for pid in ids:
            targets[f"{table}|{pid}"] = {
                "table": table, "passage_id": pid, "first_model": model,
                "attempts": [], "excerpt": "",
            }
            ids_by_table.setdefault(table, set()).add(pid)
    if not targets:
        return []
    base = shard_key_prefix.replace(":", "_")
    for path in sorted(config.SHARDS_DIR.glob(f"{base}*.results.jsonl")):
        attempt = _attempt_from_filename(path.name, base)
        model = _model_from_filename(path.name, base)
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                key, parsed, _usage, error, fr, br = _parse_response_line(line)
                rec = targets.get(key) if key else None
                if rec is None or not (error or parsed is None):
                    continue  # only a FAILING line for a target key belongs here
                if any(a["attempt"] == attempt for a in rec["attempts"]):
                    continue  # provider-duplicate line for the same attempt
                bucket = classify_schema_failure(error, fr, br)
                rec["attempts"].append({
                    "attempt": attempt, "model": model,
                    "finish_reason": fr, "block_reason": br, "bucket": bucket,
                    "raw": raw_failure_signal(error, fr, br) if bucket == "other" else None,
                })
    for table, pids in ids_by_table.items():
        try:
            excerpts = {
                p.id: " ".join((p.text or "").split())[:excerpt_chars]
                for p in load_passages(table, sorted(pids))
            }
        except Exception as exc:  # noqa: BLE001 — a report must never crash on a text read
            print(f"  (quarantine excerpt read failed for {table}: {str(exc)[:120]})", flush=True)
            excerpts = {}
        for pid in pids:
            rec = targets[f"{table}|{pid}"]
            rec["excerpt"] = excerpts.get(pid, "")
            rec["attempts"].sort(key=lambda a: a["attempt"])
            if not rec["attempts"]:
                # No response line in any file → the row was a pure missing_response.
                rec["attempts"] = [{
                    "attempt": 1, "model": rec["first_model"], "finish_reason": None,
                    "block_reason": None, "bucket": "missing_response", "raw": None,
                }]
    return sorted(targets.values(), key=lambda r: (r["table"], r["passage_id"]))


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
    by_model: dict[str, dict] = {}
    base = shard_key_prefix.replace(":", "_")

    for path in files:
        mstats = by_model.setdefault(
            _model_from_filename(path.name, base),
            {"responses": 0, "schema_valid": 0, "rows": 0, "input_tokens": 0,
             "output_tokens": 0, "candidate_tokens": 0, "thought_tokens": 0},
        )
        with open(path, encoding="utf-8") as f:
            for line in f:
                if not line.strip():
                    continue
                key, parsed, usage, error, finish_reason, block_reason = _parse_response_line(line)
                in_tok = int(usage.get("promptTokenCount") or 0)
                input_tokens += in_tok
                cand = int(usage.get("candidatesTokenCount") or 0)
                thought = int(usage.get("thoughtsTokenCount") or 0)
                candidate_tokens += cand
                thought_tokens += thought
                output_tokens += cand + thought
                mstats["input_tokens"] += in_tok
                mstats["candidate_tokens"] += cand
                mstats["thought_tokens"] += thought
                mstats["output_tokens"] += cand + thought
                if not key or "|" not in key:
                    continue
                responses += 1
                mstats["responses"] += 1
                if error or parsed is None:
                    bucket = classify_schema_failure(error, finish_reason, block_reason)
                    buckets[bucket] += 1
                    if bucket == "other":
                        other_reasons.append(raw_failure_signal(error, finish_reason, block_reason))
                    continue
                schema_valid += 1
                mstats["schema_valid"] += 1
                mstats["rows"] += 1
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
        "by_model": by_model,
    }
    return {"files": [p.name for p in files], "pattern": pattern, "buckets": buckets,
            "other_reasons": other_reasons, "stats": stats}


def pilot_stats_from_db(shard_key_prefix: str | None = None) -> dict:
    """Pilot quality metrics recomputed from the DATABASE (not in-memory shard
    outcomes) so validation is correct even when some pilot shards were applied
    by an earlier, interrupted process. schema_valid_rate works because apply
    only UPDATEs rows whose response parsed: unparsed rows keep tags_core NULL.
    Zero-tag passages are VALID and excluded from the tagged-row median.

    NOTE (v3.p2+): schema_valid_rate here is UNRELIABLE when the pilot re-tags rows
    p1 already wrote (the success slice is already tags_core NOT NULL) — the FILE
    scan owns the schema gate. This function's schema_valid_rate is only a
    trivially-passing backstop; the distribution metrics are the real DB gates."""
    like = (shard_key_prefix or config.PILOT_SHARD_PREFIX) + "%"
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


def _pilot_samples(limit: int, run_id: str | None = None,
                   shard_key_prefix: str | None = None) -> list[dict]:
    """Seeded-random passage→tags→evidence samples for the optional human skim.
    Evidence is scoped to THIS run so a re-tagged (p1-success-slice) passage shows
    this run's evidence, not an earlier run's leftover audit rows."""
    like = (shard_key_prefix or config.PILOT_SHARD_PREFIX) + "%"
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
            "SELECT tag, coalesce(evidence_found, false), left(coalesce(evidence, ''), 200),"
            "       coalesce(method, '')"
            " FROM public.tag_evidence"
            " WHERE table_name = %s AND passage_id = %s::uuid AND accepted" + run_filter +
            " ORDER BY confidence DESC NULLS LAST, tag",
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


def pilot_cost_by_model(shard_key_prefix: str) -> dict[str, dict]:
    """Real per-model token sums for the pilot shards (any retrieved/applied
    status — costs are recorded at retrieval in v3.p3)."""
    out: dict[str, dict] = {}
    for model, in_tok, out_tok, rows in db.rows(
        "SELECT coalesce(model, '(unknown)'), coalesce(sum(cost_input_tok),0),"
        "       coalesce(sum(cost_output_tok),0), coalesce(sum(row_count),0)"
        " FROM public.tag_batch_jobs"
        " WHERE shard_key LIKE %s AND status IN ('retrieved','applied')"
        " GROUP BY 1 ORDER BY 1",
        (shard_key_prefix + "%",),
    ):
        out[model] = {
            "input_tokens": int(in_tok),
            "output_tokens": int(out_tok),
            "rows": int(rows),
        }
    return out


def _model_usd(model: str, input_tok: float, output_tok: float) -> float | None:
    """_usd, but None (instead of a hard stop) for an unpriced/unknown model —
    report rendering must degrade loudly-but-cleanly, never crash."""
    prices = config.batch_prices(model)
    if prices is None:
        return None
    return input_tok / 1e6 * prices[0] + output_tok / 1e6 * prices[1]


def eligible_passage_count() -> int:
    """Total Gemini-eligible passages across the corpus (embedding present) — the
    denominator for the projected full-corpus Tier-3 cost."""
    total = 0
    for t in config.GEMINI_TABLES:
        total += int(db.one(
            f"SELECT count(*) FROM public.{t} WHERE embedding_context4 IS NOT NULL") or 0)
    return total


def write_pilot_report_v4(run_id: str, prefix: str, calibration: dict, free: dict,
                          models: dict, distribution_failures: list[str] | None = None,
                          offline: bool = False,
                          unresolved: dict | None = None,
                          accepted_quarantine: bool = False) -> None:
    """The v4-tiered pilot report: per-tier counts, the calibrated thresholds +
    their measured precision/recall, distribution health, PILOT_SAMPLE_ROWS random
    samples (passage excerpt + tags + per-tag method + evidence sentence), the TRUE
    pilot cost (Tiers 1-2 = $0; Tier 3 from usageMetadata) and the projected
    full-corpus Tier-3 cost. `offline=True` renders the free-tier + calibration
    sections only (no Tier-3 run yet — e.g. no Gemini key).

    ``unresolved`` ({(model, table): [ids]}) is the set of rows STILL invalid after
    retry + escalation. When present the report renders the explicit QUARANTINE
    listing (table · passage_id · full per-attempt finishReason/blockReason history ·
    a passage excerpt) AND the schema-invalid failure buckets with the raw signal
    for every `other`-bucketed row — the never-silent record required by design.
    ``accepted_quarantine`` toggles the section's framing between "the pilot refused
    to apply" (default) and "--accept-quarantine: resolved rows applied; these
    recorded UNRESOLVED, never counted complete"."""
    from datetime import datetime, timezone
    lines: list[str] = []
    ap = lines.append
    ap(f"# Pilot report — {config.PROMPT_VERSION}")
    ap("")
    ap(f"_Generated {datetime.now(timezone.utc).isoformat(timespec='seconds')}"
       + (" · FREE-TIERS + CALIBRATION ONLY (Tier 3 not run here)_" if offline else "_"))
    ap("")
    ap(f"- Pipeline: three-tier classifier over {calibration.get('vocab_total', 251)}-term"
       " vocabulary; questions + passage_function DEFERRED")
    ap(f"- Tier-3 model: {models.get('standard')} → escalates once to {models.get('core')}")
    ap(f"- Evidence: sentence-id ({sentence_split.SPLITTER_VERSION}); MAX_TAGS={config.MAX_TAGS}")
    ap(f"- Tier-2 shortlist width: k={calibration.get('topk', config.TIER2_SHORTLIST_K)}"
       f" (pilot default {config.TIER2_SHORTLIST_K}; full run widens to"
       f" {config.TIER2_SHORTLIST_K_FULL} and recalibrates)")
    ap("")

    # ── Calibration ─────────────────────────────────────────────────────────
    ap("## Tier-2 threshold calibration (vs the p1 pilot tags)")
    ap("")
    ap(f"Ground truth: run `{calibration.get('pilot_run_id')}` accepted Concept/Practice"
       " tags. Sweep over the top-{} embedding shortlist per passage.".format(calibration.get("topk")))
    ap("")
    ap(f"- **T_reject = {calibration['t_reject']:.2f}** — retains"
       f" **{_fmt(calibration.get('reject_recall_retained'))}** of in-shortlist positive"
       f" tags (target ≥ {calibration.get('target_reject_recall')}). Everything above"
       " T_reject (plus every lexical hit) goes to the Tier-3 judge.")
    ap(f"- _Diagnostic only:_ T_accept = {calibration['t_accept']:.2f} reaches measured"
       f" precision {_fmt(calibration.get('accept_precision'))} on"
       f" {calibration.get('pairs_auto_accepted')} candidate(s) — **v4-tiered.2 REMOVED"
       " the auto-accept band** (0.800 precision on too few tags was below our bar);"
       " nothing is auto-assigned. T_accept is retained as a reported precision head.")
    ceiling = calibration.get("shortlist_recall_ceiling")
    ap(f"- Shortlist recall ceiling (label-only, k={calibration.get('topk')}): {_fmt(ceiling)}"
       f" of accepted Concept/Practice pilot tags are reachable at all"
       f" ({calibration.get('positives_in_shortlist')}/{calibration.get('positives_total')})")
    ur = calibration.get("union_recall") or {}
    if ur and "error" not in ur:
        ap(f"- **Recall ceiling at K={ur.get('recall_ceiling_k')} — UNION vs label-only:**"
           f" union (label ∪ max-exemplar ∪ lexical) **{_fmt(ur.get('union_recall_ceiling'))}**"
           f" ({ur.get('union_reached')}/{ur.get('positives_total')}) vs label-only"
           f" {_fmt(ur.get('label_only_recall_ceiling'))} ({ur.get('label_reached')}/"
           f"{ur.get('positives_total')}); {ur.get('lexical_reached')} positive(s) reached"
           " by a literal (lexical) appearance")
    elif ur.get("error"):
        ap(f"- Union recall ceiling: _unavailable ({ur['error']})_")
    ap("")
    # Calibration sweep is over the LABEL-only pool used to pick T_reject; under
    # v4-tiered.2 everything ≥ T_reject is judged, so the judged column is the old
    # middle band PLUS the former auto-accept head (pairs_judged + pairs_auto_accepted)
    # — the three columns sum to the candidate total.
    ap("| calibration candidates (label pool) | judged (≥ T_reject) | dropped (< T_reject) |")
    ap("|---|---|---|")
    ap(f"| {calibration.get('candidate_pairs')} |"
       f" {(calibration.get('pairs_judged') or 0) + (calibration.get('pairs_auto_accepted') or 0)}"
       f" | {calibration.get('pairs_auto_rejected')} |")
    ap("")

    # ── Per-tier counts on the pilot manifest ────────────────────────────────
    ap("## Per-tier counts (pilot manifest)")
    ap("")
    ap(f"- Passages processed: **{free.get('passages')}**")
    ap(f"- Tier 1 — exact aliases: **{free.get('tier1_tags')}** tags on"
       f" {free.get('tier1_passages')} passages (free, $0)")
    ap(f"- Tier 2 — candidate list (union of label ∪ max-exemplar ∪ lexical, capped at"
       f" {config.TIER3_CANDIDATE_CAP}): **{free.get('candidate_pairs')}** candidate pairs,"
       f" of which **{free.get('lexical_candidate_tags')}** are literal (lexical) hits."
       " The auto-accept band is REMOVED — Tier 2 writes nothing.")
    ap(f"- Tier 2 — reject filter (< T_reject, non-lexical): **{free.get('auto_rejected_pairs')}**"
       " candidate pairs dropped (free, $0)")
    ap(f"- Tier 3 — judged (≥ T_reject or lexical): **{free.get('judged_pairs')}** candidate pairs"
       f" across **{free.get('passages_needing_tier3')}** passages (the only paid tier)")
    ap(f"- Free-tier-only passages (no Tier-3 call): {free.get('free_tier_passages_only')}")
    ap("")

    # ── Distribution health (merged tags_core) ───────────────────────────────
    if not offline:
        try:
            stats = pilot_stats_from_db(prefix)
            ap("## Distribution health (merged tags_core — Tiers 1+2+3)")
            ap("")
            ap(f"- Passages tagged: {stats['rows']}")
            ap(f"- Distinct tags used: {stats['distinct_tags']} / {stats['vocab_total']}"
               f" (coverage {stats['vocab_coverage']:.0%})")
            ap(f"- Singleton share: {stats['singleton_share']:.0%};"
               f" max single-tag share: {stats['max_tag_share']:.1%}")
            ap(f"- Tags/passage (tagged): median {stats['tagged_median']}, p90"
               f" {stats['tagged_p90']}, max {stats['tags_max']}; zero-tag {stats['zero_tag_rows']}")
            ap(f"- Out-of-vocab rate: {stats['out_of_vocab_rate']:.2%}")
            failures = distribution_failures if distribution_failures is not None \
                else pilot_thresholds_pass(stats)
            ap(f"- Distribution gates: {'PASS' if not failures else 'FAIL — ' + '; '.join(failures)}")
            ap("")
        except Exception as exc:  # noqa: BLE001
            ap(f"## Distribution health\n\n_unavailable: {exc}_\n")

    # ── Quarantine — rows still invalid after retry + escalation ─────────────
    # Required by design: every still-invalid row is listed explicitly with its
    # table, passage_id, the FULL per-attempt finishReason/blockReason history, and
    # a short passage excerpt. Never silent — in BOTH the refuse path and the
    # --accept-quarantine path.
    if unresolved:
        n_unresolved = sum(len(v) for v in unresolved.values())
        ap(f"## Quarantine — rows still invalid after retry + escalation ({n_unresolved})")
        ap("")
        if accepted_quarantine:
            ap("**--accept-quarantine.** Tier-3 was applied for every RESOLVED row; the"
               " rows below have NO valid Tier-3 response after the full retry +"
               " escalation ladder. They are recorded as `quarantined` (UNRESOLVED) and"
               " are NEVER counted complete — listed here in full, never silently dropped.")
        else:
            ap("The pilot REFUSES to apply while any of these exist — **nothing was"
               " written**. Review them, then rerun with `--accept-quarantine` to apply"
               " the resolved rows and record these as unresolved. Every attempt's raw"
               " termination signal is shown below; nothing is silently dropped.")
        ap("")
        try:
            listing = pilot_quarantine_listing(prefix, unresolved)
        except Exception as exc:  # noqa: BLE001 — a report must never crash
            listing = []
            ap(f"_quarantine detail unavailable: {exc}_")
        for rec in listing:
            ap(f"- **{rec['table']}** `{rec['passage_id']}`")
            for a in rec["attempts"]:
                sig = " · ".join(filter(None, [
                    f"finishReason={a['finish_reason']}" if a["finish_reason"] else "",
                    f"blockReason={a['block_reason']}" if a["block_reason"] else "",
                    f"bucket={a['bucket']}",
                    f"raw={a['raw']}" if a.get("raw") else "",
                ]))
                ap(f"  - attempt {a['attempt']} `{a['model']}` — {sig}")
            ap(f"  - excerpt: “{rec['excerpt']}”" if rec["excerpt"] else "  - excerpt: (unavailable)")
        ap("")

    # ── Schema-invalid failure reasons (buckets + raw `other` signals) ───────
    # Always rendered for a live run so the raw signal for anything bucketed
    # `other` is LOGGED (not just the quarantined rows — any invalid attempt,
    # including rows later rescued by a retry, is bucketed here).
    if not offline:
        try:
            for ln in _failure_reason_lines(scan_pilot_results(prefix)):
                ap(ln)
            ap("")
        except Exception as exc:  # noqa: BLE001
            ap(f"## Schema-invalid failure reasons\n\n_unavailable: {exc}_\n")

    # ── Cost + projection ────────────────────────────────────────────────────
    ap("## Cost (Tiers 1-2 = $0; Tier 3 from usageMetadata)")
    ap("")
    if offline:
        ap("_Tier-3 not run in this environment (no Gemini key). Tiers 1-2 cost $0."
           " Projected Tier-3 cost is computed from the middle-band volume below._")
        ap("")
    else:
        pilot_tier3 = 0.0
        by_model = pilot_cost_by_model(prefix)
        for model, c in by_model.items():
            usd = _model_usd(model, c["input_tokens"], c["output_tokens"])
            usd_s = f"${usd:,.2f}" if usd is not None else "UNPRICED"
            if usd:
                pilot_tier3 += usd
            ap(f"- {model}: {c['input_tokens']:,} in + {c['output_tokens']:,} out → {usd_s}"
               f" ({c['rows']:,} rows)")
        ap(f"- **True pilot Tier-3 cost: ${pilot_tier3:,.2f}**")
        ap("")
        # Projected full corpus: judged-passage rate × eligible passages × per-passage Tier-3 cost.
        judged_passages = max(1, int(free.get("passages_needing_tier3") or 0))
        try:
            eligible = eligible_passage_count()
            judged_rate = judged_passages / max(1, int(free.get("passages") or 1))
            per_passage = pilot_tier3 / judged_passages
            projected = eligible * judged_rate * per_passage
            ap(f"- Eligible passages (corpus): {eligible:,}; judged-passage rate"
               f" {judged_rate:.0%} → ~{int(eligible * judged_rate):,} Tier-3 calls")
            ap(f"- **Projected full-corpus Tier-3 cost: ~${projected:,.2f}**"
               f" (ceiling MAX_SPEND_USD=${config.MAX_SPEND_USD:,.0f})")
        except Exception as exc:  # noqa: BLE001
            ap(f"- Projection unavailable: {exc}")
        ap("")

    # ── Samples (passage excerpt + tags + per-tag method + evidence sentence) ─
    if not offline:
        try:
            samples = _pilot_samples(config.PILOT_SAMPLE_ROWS, run_id=run_id, shard_key_prefix=prefix)
            ap(f"## {len(samples)} random samples (human skim)")
            ap("")
            for i, s in enumerate(samples, 1):
                ap(f"**{i}. {s['table']}** `{s['id']}` — {', '.join(s['tags']) or '(no tags)'}"
                   + (f" · function: `{s['function']}`" if s.get("function") else ""))
                if s.get("snippet"):
                    ap(f"> {s['snippet']}")
                for tag, found, evidence, method in s.get("evidence", []):
                    marker = "✓" if found else "∅ (kept, unevidenced)"
                    method_s = f"`{method}`" if method else "`?`"
                    ev_s = f" — “{evidence}”" if evidence else ""
                    ap(f"- `{tag}` · method {method_s} · evidence {marker}{ev_s}")
                ap("")
        except Exception as exc:  # noqa: BLE001
            ap(f"## Samples\n\n_unavailable: {exc}_")

    config.PILOT_REPORT_PATH.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _fmt(x) -> str:
    """Percent-ish formatter that tolerates None."""
    return f"{x:.3f}" if isinstance(x, (int, float)) else "n/a"


def write_pilot_report(stats: dict, failures: list[str], models,
                       failure_reasons: dict | None = None, offline: bool = False,
                       run_id: str | None = None, validity: dict | None = None,
                       unresolved: dict | None = None) -> None:
    """Write pilot-report.md. ``models`` is the routing dict
    ({'core': …, 'standard': …}) for live runs or a plain string for offline
    re-validation. When ``offline`` is True the DB-only sections (remaining-
    passage projection and the random skim samples) are skipped so the report
    can be regenerated with no database access and no cost — used by
    `run_all.py --revalidate-pilot`. ``failure_reasons`` (a scan_pilot_results()
    result) adds the 'Schema-invalid failure reasons' section. ``validity`` (a
    live run's file-based first-pass/retry/escalation/final summary) is the
    AUTHORITATIVE schema gate; the DB schema_valid_rate is only a backstop.
    ``unresolved`` ({(model, table): [ids]}) lists rows still invalid after
    retry + escalation — the explicit would-be-quarantine list. Cost lines are
    PER MODEL at each model's pinned Batch prices; the full-run extrapolation
    is run_id-scoped and priced PER ROUTE under the p3 routing mix."""
    if isinstance(models, dict):
        model_desc = " · ".join(f"{route} `{m}`" for route, m in sorted(models.items()))
    else:
        model_desc = f"`{models}`"

    by_model: dict[str, dict] = dict(stats.get("by_model") or {})
    if not by_model and run_id and not offline:
        by_model = pilot_cost_by_model(pilot_prefix(run_id))
    rows = max(stats["rows"], 1)
    per_row_in = stats["input_tokens"] / rows
    per_row_out = stats["output_tokens"] / rows
    pilot_usd = 0.0
    unpriced_models: list[str] = []
    for m, tok in by_model.items():
        usd = _model_usd(m, tok.get("input_tokens", 0), tok.get("output_tokens", 0))
        if usd is None:
            unpriced_models.append(m)
        else:
            pilot_usd += usd

    if offline:
        remaining = None
        rem_by_route: dict[str, int] = {}
    elif run_id:
        rem_by_route = remaining_by_route(run_id)
        remaining = sum(rem_by_route.values())
    else:
        rem_by_route = {}
        remaining = sum(
            db.table_count(t, "tags_core IS NULL AND embedding_context4 IS NOT NULL")
            for t in config.GEMINI_TABLES
        )
    projected_usd: float | None = None
    if remaining is not None:
        projected_usd = 0.0
        for route in routing.ROUTES:
            n = rem_by_route.get(route, 0) if rem_by_route else (
                remaining if route == "standard" else 0
            )
            if not n:
                continue
            model = routing.model_for_route(route)
            tok = by_model.get(model) or {}
            m_rows = max(int(tok.get("rows") or 0), 1)
            m_in = (tok.get("input_tokens") or 0) / m_rows if tok else per_row_in
            m_out = (tok.get("output_tokens") or 0) / m_rows if tok else per_row_out
            if not tok or not tok.get("output_tokens"):
                m_in, m_out = per_row_in, per_row_out  # no per-model sample yet
            usd = _model_usd(model, m_in * n, m_out * n)
            projected_usd += usd if usd is not None else 0.0
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
        f"- Models: {model_desc} · prompt `{config.PROMPT_VERSION}`"
        f" · thinking `{config.THINKING_LEVEL}` (non-overridable, sent to BOTH models)"
        f" · temperature model-default"
        f" · MAX_TAGS {config.MAX_TAGS} · maxOutputTokens {config.MAX_OUTPUT_TOKENS}",
        f"- Evidence: sentence-ID (`{sentence_split.SPLITTER_VERSION}`) resolved to source text",
        f"- Sampling: seeded-random stratified by table × length quartile, seed"
        f" `{config.SAMPLE_SEED}` · pilot size {config.PILOT_SIZE}",
        f"- Verdict: **{verdict}**",
        "",
        "## Schema validity (FILE-based gate — authoritative; first pass is DIAGNOSTIC)",
        (
            f"- First pass: {validity['first_pass']:.2%} (diagnostic — no abort)"
            f" · retried {validity['retry_rows']} row(s) once on their own model"
            f" · escalated {validity.get('esc_rows', 0)} standard-route row(s) to"
            f" `{config.MODEL_CORE}`"
            f" · final: {validity['final']:.2%} (gate = {config.PILOT_FINAL_SCHEMA_VALID:.0%}"
            " after retry + escalation)"
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
        f" → **${pilot_usd:,.2f}** total (per-model batch prices below)",
        f"- Per-passage average: {per_row_in:,.0f} in / {per_row_out:,.0f} out tokens"
        " (retried/escalated rows are billed for every attempt — real spend)",
    ]
    for m in sorted(by_model):
        tok = by_model[m]
        prices = config.batch_prices(m)
        usd = _model_usd(m, tok.get("input_tokens", 0), tok.get("output_tokens", 0))
        if prices is None or usd is None:
            lines.append(
                f"- `{m}`: {tok.get('input_tokens', 0):,} in / {tok.get('output_tokens', 0):,} out"
                " — ⚠️ NO PINNED PRICE (excluded from the USD total; fix the price map)"
            )
        else:
            lines.append(
                f"- `{m}`: {tok.get('input_tokens', 0):,} in / {tok.get('output_tokens', 0):,} out"
                f" → ${usd:,.2f} at ${prices[0]}/M in, ${prices[1]}/M out (batch)"
            )
    if remaining is None:
        lines.append(
            "- Remaining-passage count & projected full-run cost: skipped"
            " (offline — needs the DB)"
        )
    else:
        scope = "without an outcome in this run (all 5 tables incl. verse_chunks)" if run_id \
            else "still untagged (all 5 tables incl. verse_chunks)"
        route_mix = (
            " (" + " · ".join(
                f"{route} → `{routing.model_for_route(route)}`: {rem_by_route.get(route, 0):,}"
                for route in routing.ROUTES
            ) + ")"
            if rem_by_route else ""
        )
        lines += [
            f"- Remaining Gemini-eligible passages {scope}: {remaining:,}{route_mix}",
            f"- **Projected full-run cost: ${projected_usd:,.2f}** priced per route"
            f" (ceiling MAX_SPEND_USD = ${config.MAX_SPEND_USD:,.2f})",
        ]
    if unresolved:
        n_unresolved = sum(len(v) for v in unresolved.values())
        lines += [
            "",
            f"## Unresolved rows — still invalid after retry + escalation ({n_unresolved})",
            "",
            "These rows would be QUARANTINED; the pilot refuses to apply while any exist.",
        ]
        for (m, table), ids in sorted(unresolved.items()):
            shown = ", ".join(ids[:20]) + (" …" if len(ids) > 20 else "")
            lines.append(f"- `{table}` on `{m}`: {len(ids)} row(s) — {shown}")
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
        sample_prefix = pilot_prefix(run_id) if run_id else None
        for i, sample in enumerate(
            _pilot_samples(config.PILOT_SAMPLE_ROWS, run_id=run_id,
                           shard_key_prefix=sample_prefix), 1,
        ):
            lines.append(
                f"**{i}. {sample['table']} {sample['id']}**"
                + (f" · function: `{sample['function']}`" if sample["function"] else "")
            )
            lines.append(f"> {sample['snippet']}")
            for tag, found, evidence, _method in sample["evidence"]:
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


def pilot_done(shard_key_prefix: str | None = None) -> bool:
    like = (shard_key_prefix or config.PILOT_SHARD_PREFIX) + "%"
    unfinished = db.one(
        "SELECT count(*) FROM public.tag_batch_jobs"
        " WHERE shard_key LIKE %s AND status NOT IN ('applied','failed')",
        (like,),
    )
    any_pilot = db.one(
        "SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", (like,)
    )
    return bool(any_pilot) and not unfinished
