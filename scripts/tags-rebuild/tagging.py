"""
tagging.py — the combined tagging + questions + passage_function pass
(Gemini Batch API).

ONE structured call per passage returns ALL of:
  • reasoning — a free-text field placed FIRST in the responseSchema (the model
    reasons before any constrained field, mitigating the documented format-tax
    of constrained decoding); never stored;
  • passage_function — ONE primary value from the closed enum in
    config.PASSAGE_FUNCTIONS (hidden metadata; additive column; killable);
  • tags_core — flexible count up to config.MAX_TAGS, every tag constrained to
    the passage's candidate shortlist by a strict responseSchema enum, each
    with an evidence sentence. ZERO tags is a valid answer; and
  • questions — 0-3 distinct questions the passage genuinely ANSWERS, each with
    the exact answer span as evidence (doc2query lane) — requested ONLY for
    Prabhupāda-speaking / HIS passages. Gating comes exclusively from
    provenance.json: NOT-HIS/MIXED-VERIFY rows get topic tags only, and their
    responseSchema omits questions entirely.

The candidate shortlist is a UNION: semantic top-SHORTLIST_SEMANTIC (pgvector)
∪ exact alias/lexical matches found in the passage ∪ the hard-negative partners
of anything shortlisted (the model always sees BOTH sides of a contrast pair),
capped ≈ SHORTLIST_CAP. Every candidate line carries the term's scope note and
its "do NOT confuse with" hard negatives, so the model judges against
definitions, not just labels.

verse_chunks are NEVER sent — they inherit tags_core + passage_function from
their parent verse by SQL (finalize.py).

Code gates on every response (evidence is stored either way — tag_evidence):
  1. closed vocabulary: a tag not in vocabulary.json is dropped (HARD);
  2. evidence (SOFT): the sentence must appear in the passage under a lenient
     fold (lowercase + strip diacritics + collapse whitespace),
     ≥ MIN_EVIDENCE_WORDS. In-vocabulary tags whose evidence fails are KEPT and
     flagged evidence_found=false — abstract doctrinal themes often have no
     single quotable sentence, and strict-drop preferentially deletes the best
     tags. Matched evidence stores character offsets (into the composed passage
     text as sent to Gemini);
  3. questions: an unevidenced answer span DROPS the question (questions are
     generated text — stricter than tags);
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

GEN_TEMPERATURE = 0.2
MAX_OUTPUT_TOKENS = 4096  # reasoning + evidence quotes + answer spans need room
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
    return fold_text_with_map(text)[0]


def evidence_ok(evidence: str, folded_passage: str, mapping: list[int]) -> tuple[bool, str | None, int | None, int | None]:
    """Returns (found, miss_reason, start_offset, end_offset). Offsets are
    character positions in the ORIGINAL passage text (as sent to Gemini)."""
    words = (evidence or "").split()
    if len(words) < config.MIN_EVIDENCE_WORDS:
        return False, f"evidence shorter than {config.MIN_EVIDENCE_WORDS} words", None, None
    needle = fold_text(evidence)
    pos = folded_passage.find(needle)
    if pos == -1 or not needle:
        return False, "evidence not found in passage (lenient fold)", None, None
    start = mapping[pos]
    end = mapping[pos + len(needle) - 1] + 1
    return True, None, start, end


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
    text: str
    authorship: str
    questions_allowed: bool
    shortlist: list[str] = field(default_factory=list)


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

def response_schema(shortlist: list[str], questions_allowed: bool) -> dict:
    """reasoning comes FIRST (free text before any constrained field —
    mitigates the documented format-tax of constrained decoding), then the
    constrained fields, in a pinned propertyOrdering."""
    properties: dict = {
        "reasoning": {"type": "STRING"},
        "passage_function": {"type": "STRING", "enum": config.PASSAGE_FUNCTIONS},
        "tags": {
            "type": "ARRAY",
            "maxItems": config.MAX_TAGS,
            "items": {
                "type": "OBJECT",
                "properties": {
                    "tag": {"type": "STRING", "enum": shortlist},
                    "evidence": {"type": "STRING"},
                },
                "required": ["tag", "evidence"],
                "propertyOrdering": ["tag", "evidence"],
            },
        },
    }
    ordering = ["reasoning", "passage_function", "tags"]
    if questions_allowed:
        properties["questions"] = {
            "type": "ARRAY",
            "maxItems": config.MAX_QUESTIONS,
            "items": {
                "type": "OBJECT",
                "properties": {
                    "question": {"type": "STRING"},
                    "evidence": {"type": "STRING"},
                },
                "required": ["question", "evidence"],
                "propertyOrdering": ["question", "evidence"],
            },
        }
        ordering.append("questions")
    return {
        "type": "OBJECT",
        "properties": properties,
        "required": ["reasoning", "passage_function", "tags"],
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


def build_prompt(passage: Passage, vocab: VocabIndex) -> str:
    candidates = "\n".join(
        _candidate_line(slug, vocab) for slug in passage.shortlist if slug in vocab.term_by_slug
    )
    functions = ", ".join(config.PASSAGE_FUNCTIONS)
    base = (
        "You are indexing a passage from Śrīla Prabhupāda's corpus for subject"
        " search.\n\nCANDIDATE TAGS (closed list — you may ONLY use these slugs;"
        " each shows its scope and what NOT to confuse it with):\n"
        f"{candidates}\n\nRULES:\n"
        "1. First fill `reasoning`: 2-4 sentences on what this passage is"
        " actually ABOUT, which candidates truly fit, and which near-misses you"
        " are rejecting and why. Reason BEFORE you answer.\n"
        "2. Tag ABOUTNESS only. Do NOT tag a subject the passage merely mentions"
        " in passing, quotes from an opponent, or explicitly REJECTS (a passage"
        " arguing against a view is not endorsing it). Choose the MOST SPECIFIC"
        " fitting concepts; do not pad with broad ancestors. Tag a Person, Place"
        " or Scripture only when it is PROMINENT in the passage, never on a"
        " stray mention. ZERO tags is a valid answer — filler or small talk may"
        f" be about nothing; never force tags. Never more than {config.MAX_TAGS}.\n"
        "3. For EACH tag, quote one EXACT sentence from the passage (verbatim,"
        " no paraphrase, no ellipsis) that shows the passage discusses that"
        " subject.\n"
        "4. `passage_function`: the ONE primary thing this passage DOES, from:"
        f" {functions}.\n"
    )
    if passage.questions_allowed:
        base += (
            f"5. `questions`: the 0-{config.MAX_QUESTIONS} DISTINCT questions a"
            " person might sincerely ask that THIS passage genuinely ANSWERS."
            " For each, `evidence` = the EXACT contiguous span from the passage"
            " (verbatim) that contains the answer. NEVER write a question whose"
            " answer needs outside facts, is only an inference, is far broader"
            " than the passage, or would present a view the passage rejects or"
            " negates as if endorsed. ZERO questions is a valid answer.\n"
        )
    else:
        base += (
            "5. This passage is NOT Śrīla Prabhupāda's own words — return"
            " reasoning, passage_function and topic tags only.\n"
        )
    return base + "\nPASSAGE:\n" + passage.text


def request_line(passage: Passage, vocab: VocabIndex) -> dict:
    return {
        "key": f"{passage.table}|{passage.id}",
        "request": {
            "contents": [{"parts": [{"text": build_prompt(passage, vocab)}]}],
            "generationConfig": {
                "responseMimeType": "application/json",
                "responseSchema": response_schema(passage.shortlist, passage.questions_allowed),
                "temperature": GEN_TEMPERATURE,
                "maxOutputTokens": MAX_OUTPUT_TOKENS,
            },
        },
    }


# ── shard planning (deterministic names, persisted before submission) ───────

def plan_pilot_shards(run_id: str) -> None:
    """PILOT_SIZE seeded-random passages, stratified proportionally across the
    five content tables (ORDER BY md5(seed || id) — deterministic for a given
    config.SAMPLE_SEED, which is recorded in pilot-report.md). The verse_chunks
    stratum is fulfilled through parent verses — chunks are never sent; their
    representation is inherited by SQL after apply."""
    if db.one("SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", ("pilot:%",)):
        print("  pilot shards already planned.", flush=True)
        return
    live = {
        t: db.table_count(t, "tags_core IS NULL AND embedding_context4 IS NOT NULL")
        for t in config.CONTENT_TABLES
    }
    total = sum(live.values()) or 1
    alloc = {t: round(config.PILOT_SIZE * n / total) for t, n in live.items()}
    picked: dict[str, list[str]] = {t: [] for t in config.GEMINI_TABLES}
    for table, want in alloc.items():
        if want == 0:
            continue
        if table == "verse_chunks":
            rows = db.rows(
                "SELECT DISTINCT v.id::text FROM ("
                "  SELECT verse_id FROM public.verse_chunks"
                "  WHERE tags_core IS NULL ORDER BY md5(%s || id::text) LIMIT %s) c"
                " JOIN public.verses v ON v.id = c.verse_id"
                " WHERE v.tags_core IS NULL AND v.embedding_context4 IS NOT NULL",
                (config.SAMPLE_SEED, want),
            )
            picked["verses"].extend(r[0] for r in rows)
        else:
            rows = db.rows(
                f"SELECT id::text FROM public.{table}"
                " WHERE tags_core IS NULL AND embedding_context4 IS NOT NULL"
                " ORDER BY md5(%s || id::text) LIMIT %s",
                (config.SAMPLE_SEED, want),
            )
            picked[table].extend(r[0] for r in rows)
    for table, ids in picked.items():
        ids = sorted(set(ids))
        if not ids:
            continue
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(f"pilot:{table}:{index // config.SHARD_SIZE:03d}", table, chunk, run_id)
    print(
        f"  pilot planned: {sum(len(v) for v in picked.values())} passages"
        f" (seeded-random, seed {config.SAMPLE_SEED!r}).",
        flush=True,
    )


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
        # Anti-join against every id already covered by a non-failed shard
        # (NULL-safe and index-friendly — unlike NOT IN over a huge subquery).
        ids = [
            r[0]
            for r in db.rows(
                f"WITH covered AS ("
                f"   SELECT DISTINCT unnest(id_list) AS id FROM public.tag_batch_jobs"
                f"   WHERE status <> 'failed')"
                f" SELECT t.id::text FROM public.{table} t"
                f" LEFT JOIN covered c ON c.id = t.id"
                f" WHERE t.tags_core IS NULL AND t.embedding_context4 IS NOT NULL AND c.id IS NULL"
                f" ORDER BY t.id"
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

def _parse_response_line(line: str) -> tuple[str | None, dict | None, dict, str | None]:
    """Returns (key, parsed_json, usage, error)."""
    try:
        outer = json.loads(line)
    except json.JSONDecodeError:
        return None, None, {}, "unparseable JSONL line"
    key = outer.get("key")
    if outer.get("error"):
        return key, None, {}, json.dumps(outer["error"])[:500]
    response = outer.get("response") or {}
    if response.get("error"):
        return key, None, {}, json.dumps(response["error"])[:500]
    usage = response.get("usageMetadata") or {}
    try:
        text = response["candidates"][0]["content"]["parts"][0]["text"]
        parsed = json.loads(text)
    except (KeyError, IndexError, TypeError, json.JSONDecodeError):
        return key, None, usage, "response did not contain valid schema JSON"
    if not isinstance(parsed, dict) or not isinstance(parsed.get("tags"), list):
        return key, None, usage, "schema-invalid response (no tags array)"
    return key, parsed, usage, None


@dataclass
class ShardOutcome:
    shard_key: str
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
    output_tokens: int = 0
    per_row_tag_counts: list[int] = field(default_factory=list)


def apply_results(shard_key: str, table: str, results_path, run_id: str,
                  vocab: VocabIndex) -> ShardOutcome:
    """Validate + write one shard inside ONE transaction; mark applied only
    after commit. Writes ONLY new columns (tags_core, questions,
    fts_expansion_src, passage_function — the trigger derives the tsvectors).
    Gates: out-of-vocabulary → HARD drop; missing evidence → SOFT (tag kept,
    evidence_found=false); unevidenced question → dropped; passage_function
    outside the enum → NULL. Rows whose tags all fail the hard gate get
    tags_core='{}' so they are never resubmitted."""
    outcome = ShardOutcome(shard_key=shard_key)
    updates: list[tuple] = []   # (tags[], questions|None, expansion|None, function|None, id)
    evidence_records: list[tuple] = []

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
            key, parsed, usage, error = _parse_response_line(line)
            outcome.responses += 1
            outcome.input_tokens += int(usage.get("promptTokenCount") or 0)
            outcome.output_tokens += int(usage.get("candidatesTokenCount") or 0)
            if not key or "|" not in (key or ""):
                continue
            _, passage_id = key.split("|", 1)
            passage = passages.get(passage_id)
            if passage is None or error or parsed is None:
                continue
            outcome.schema_valid += 1

            folded, mapping = fold_text_with_map(passage.text)
            accepted: list[str] = []
            for item in parsed.get("tags", [])[: config.MAX_TAGS]:
                if not isinstance(item, dict):
                    continue
                tag = str(item.get("tag") or "").strip()
                evidence = str(item.get("evidence") or "").strip()
                outcome.tags_returned += 1
                if tag not in vocab.slugs:
                    # HARD gate — out-of-vocabulary is never written.
                    outcome.tags_out_of_vocab += 1
                    evidence_records.append(
                        (table, passage_id, tag, evidence, False, "out of vocabulary", False, None, None)
                    )
                    continue
                if tag in accepted:
                    continue
                # SOFT gate — the tag is KEPT either way; a miss is flagged
                # (evidence_found=false) with the miss reason in reject_reason.
                found, miss_reason, start, end = evidence_ok(evidence, folded, mapping)
                accepted.append(tag)
                outcome.tags_accepted += 1
                if not found:
                    outcome.tags_unevidenced_kept += 1
                evidence_records.append(
                    (table, passage_id, tag, evidence, True, miss_reason, found, start, end)
                )

            questions: list[str] = []
            if passage.questions_allowed:
                seen = set()
                for q in parsed.get("questions", [])[: config.MAX_QUESTIONS]:
                    if not isinstance(q, dict):
                        continue
                    question = str(q.get("question") or "").strip()
                    answer_span = str(q.get("evidence") or "").strip()
                    if not question or question.lower() in seen:
                        continue
                    found, _, _, _ = evidence_ok(answer_span, folded, mapping)
                    if not found:
                        # Questions are generated text — unevidenced answers drop.
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
            updates.append(
                (
                    accepted,
                    "\n".join(questions) if questions else None,
                    "\n".join(expansion_lines) if expansion_lines else None,
                    function,
                    passage_id,
                )
            )

    outcome.rows = len(updates)
    conn = db.get_pg()
    with conn.transaction():
        with conn.cursor() as cur:
            for start in range(0, len(updates), config.DB_BATCH):
                cur.executemany(
                    f"UPDATE public.{table} SET tags_core=%s::text[], questions=%s,"
                    f" fts_expansion_src=%s, passage_function=%s WHERE id=%s::uuid",
                    updates[start : start + config.DB_BATCH],
                )
            cur.executemany(
                "INSERT INTO public.tag_evidence"
                " (run_id, table_name, passage_id, tag, evidence, accepted, reject_reason,"
                "  evidence_found, evidence_start, evidence_end)"
                " VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s, %s, %s, %s)",
                [(run_id, *r) for r in evidence_records],
            )
            cur.execute(
                "UPDATE public.tag_batch_jobs SET status='applied', applied_at=%s,"
                " cost_input_tok=%s, cost_output_tok=%s WHERE shard_key=%s",
                (datetime.now(timezone.utc), outcome.input_tokens, outcome.output_tokens, shard_key),
            )
    return outcome


def collect(run_id: str, shard_key_prefix: str = "") -> list[ShardOutcome]:
    """Poll submitted/running shards until every one is terminal; download,
    gate and apply results as each finishes. Safe to Ctrl+C and rerun."""
    vocab = load_vocab_index()
    outcomes: list[ShardOutcome] = []
    like = shard_key_prefix + "%"
    while True:
        jobs = db.rows(
            "SELECT shard_key, table_name, provider_job_id, status FROM public.tag_batch_jobs"
            " WHERE shard_key LIKE %s AND status IN ('submitted','running','retrieved')"
            " ORDER BY shard_key",
            (like,),
        )
        if not jobs:
            return outcomes
        progressed = False
        for shard_key, table, job_name, status in jobs:
            results_path = config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.results.jsonl"
            if status == "retrieved":
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
                outcomes.append(apply_results(shard_key, table, results_path, run_id, vocab))
                print(f"  applied {shard_key}", flush=True)
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


def _fail_shard(shard_key: str, error: str) -> None:
    print(f"  FAILED {shard_key}: {error}", flush=True)
    with db.get_pg().cursor() as cur:
        cur.execute(
            "UPDATE public.tag_batch_jobs SET status='failed', error=%s WHERE shard_key=%s",
            (error, shard_key),
        )


# ── pilot validation + report ───────────────────────────────────────────────

def pilot_stats_from_db() -> dict:
    """Pilot quality metrics recomputed from the DATABASE (not in-memory shard
    outcomes) so validation is correct even when some pilot shards were applied
    by an earlier, interrupted process. schema_valid_rate works because apply
    only UPDATEs rows whose response parsed: unparsed rows keep tags_core NULL.
    Zero-tag passages are VALID and excluded from the tagged-row median."""
    planned, real_in, real_out = db.rows(
        "SELECT coalesce(sum(row_count),0), coalesce(sum(cost_input_tok),0),"
        "       coalesce(sum(cost_output_tok),0)"
        " FROM public.tag_batch_jobs WHERE shard_key LIKE %s AND status='applied'",
        ("pilot:%",),
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
        ("pilot:%",),
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
            ("pilot:%", t),
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
        ("pilot:%",),
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
    """Auto-gates: continue automatically when ALL pass; otherwise STOP with
    pilot-report.md. Evidence-found rate is reported, never gated. There is NO
    minimum-tag-count gate — zero-tag passages are valid; the tagged-row median
    must merely sit in a sane band."""
    failures = []
    if stats["schema_valid_rate"] < config.PILOT_MIN_SCHEMA_VALID:
        failures.append(
            f"schema_valid_rate {stats['schema_valid_rate']:.3f} < {config.PILOT_MIN_SCHEMA_VALID}"
        )
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


def _pilot_samples(limit: int) -> list[dict]:
    """Seeded-random passage→tags→evidence samples for the optional human skim."""
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
            ("pilot:%", t, config.SAMPLE_SEED, limit),
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
    for row in rows:
        row["evidence"] = db.rows(
            "SELECT tag, coalesce(evidence_found, false), left(coalesce(evidence, ''), 200)"
            " FROM public.tag_evidence"
            " WHERE table_name = %s AND passage_id = %s::uuid AND accepted"
            " ORDER BY tag",
            (row["table"], row["id"]),
        )
    return rows


def write_pilot_report(stats: dict, failures: list[str], model: str) -> None:
    remaining = sum(
        db.table_count(t, "tags_core IS NULL AND embedding_context4 IS NOT NULL")
        for t in config.GEMINI_TABLES
    )
    rows = max(stats["rows"], 1)
    per_row_in = stats["input_tokens"] / rows
    per_row_out = stats["output_tokens"] / rows
    pilot_usd = _usd(stats["input_tokens"], stats["output_tokens"])
    projected_usd = _usd(per_row_in * remaining, per_row_out * remaining)
    verdict = "PASS — continuing automatically (standing ruling)" if not failures else "FAIL — run stopped"
    lines = [
        "# Pilot report — tags + questions + passage_function combined pass",
        "",
        f"- Generated: {datetime.now(timezone.utc).isoformat()}",
        f"- Model: `{model}` · prompt `{config.PROMPT_VERSION}` · MAX_TAGS {config.MAX_TAGS}",
        f"- Sampling: seeded-random stratified, seed `{config.SAMPLE_SEED}` · pilot size {config.PILOT_SIZE}",
        f"- Verdict: **{verdict}**",
        "",
        "## Quality gates",
        f"- Passages applied: {stats['rows']} (responses: {stats['responses']})",
        f"- Schema validity: {stats['schema_valid_rate']:.1%} (gate ≥ {config.PILOT_MIN_SCHEMA_VALID:.0%})",
        f"- Out-of-vocabulary rate: {stats['out_of_vocab_rate']:.2%} (gate ≤ {config.PILOT_MAX_OUT_OF_VOCAB:.0%})",
        f"- Evidence-found rate: {stats['evidence_found_rate']:.1%} (REPORTED — not gated;"
        " unevidenced in-vocab tags are kept and flagged)",
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
        f"- Passages carrying questions (HIS/Prabhupāda-speaking rows only): {stats['questions_kept']}",
        "",
        "## Real cost (from usageMetadata) and extrapolation",
        f"- Pilot tokens: {stats['input_tokens']:,} in / {stats['output_tokens']:,} out"
        f" → ${pilot_usd:,.2f} at ${config.GEMINI_BATCH_PRICE_IN_PER_M}/M in,"
        f" ${config.GEMINI_BATCH_PRICE_OUT_PER_M}/M out (batch)",
        f"- Per-passage average: {per_row_in:,.0f} in / {per_row_out:,.0f} out tokens",
        f"- Remaining Gemini-eligible passages: {remaining:,}",
        f"- **Projected full-run cost: ${projected_usd:,.2f}**"
        f" (ceiling MAX_SPEND_USD = ${config.MAX_SPEND_USD:,.2f})",
    ]
    if failures:
        lines += ["", "## Threshold failures", *[f"- {f}" for f in failures]]
    lines += ["", f"## {config.PILOT_SAMPLE_ROWS} random samples (optional human skim)", ""]
    for i, sample in enumerate(_pilot_samples(config.PILOT_SAMPLE_ROWS), 1):
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
    print(
        f"  pilot real cost ${pilot_usd:,.2f} → projected full run ${projected_usd:,.2f}"
        f" (ceiling ${config.MAX_SPEND_USD:,.2f})",
        flush=True,
    )


def pilot_done() -> bool:
    unfinished = db.one(
        "SELECT count(*) FROM public.tag_batch_jobs"
        " WHERE shard_key LIKE %s AND status NOT IN ('applied','failed')",
        ("pilot:%",),
    )
    any_pilot = db.one(
        "SELECT count(*) FROM public.tag_batch_jobs WHERE shard_key LIKE %s", ("pilot:%",)
    )
    return bool(any_pilot) and not unfinished
