"""
tagging.py — the combined tagging + questions pass (Gemini Batch API).

ONE structured call per passage returns BOTH:
  • tags_core — flexible count up to config.MAX_TAGS, every tag constrained to
    the passage's vocab shortlist by a strict responseSchema enum, each with an
    evidence sentence; and
  • questions — the few distinct questions the passage genuinely answers
    (doc2query lane) — requested ONLY for Prabhupāda-speaking / HIS passages.
    Gating comes exclusively from provenance.json: NOT-HIS/MIXED-VERIFY rows
    get topic tags only, and their responseSchema omits questions entirely.

verse_chunks are NEVER sent — they inherit tags_core from their parent verse
by SQL (finalize.py).

Code gates on every response (evidence is stored either way — tag_evidence):
  1. closed vocabulary: a tag not in vocabulary.json is dropped;
  2. evidence: the sentence must appear in the passage under a lenient fold
     (lowercase + strip diacritics + collapse whitespace), ≥ MIN_EVIDENCE_WORDS.

Batch mechanics (resumable; jobs run server-side up to 24h — close the script
after submission and rerun later to collect):
  • deterministic shard names ("pilot:verses:000", "transcript_paragraphs:w01:0003");
  • Google job IDs recorded in tag_batch_jobs BEFORE any polling;
  • on restart, reconcile against Google's job list by display_name so
    accepted-but-unrecorded jobs are recovered, never resubmitted;
  • a shard is marked applied only after its whole write transaction commits;
  • MACHINE-ENFORCED cost ceiling: the submitter refuses to submit a shard
    once real+estimated spend would exceed config.MAX_SPEND_USD.
"""
from __future__ import annotations

import json
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
MAX_OUTPUT_TOKENS = 2048
IN_FLIGHT = ("submitted", "running")
UNFINISHED = ("pending", "submitted", "running", "retrieved")


# ── text folding + evidence gate ────────────────────────────────────────────

def fold_text(text: str) -> str:
    """Lenient fold for the evidence gate: lowercase, strip diacritics,
    normalize quotes/dashes, collapse whitespace. Deliberately looser than the
    display verbatim validator so valid tags aren't over-dropped."""
    decomposed = unicodedata.normalize("NFD", text or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    normalized = (
        stripped.lower()
        .replace("‘", "'").replace("’", "'")
        .replace("“", '"').replace("”", '"')
        .replace("—", "-").replace("–", "-")
    )
    return " ".join(normalized.split())


def evidence_ok(evidence: str, folded_passage: str) -> tuple[bool, str | None]:
    words = (evidence or "").split()
    if len(words) < config.MIN_EVIDENCE_WORDS:
        return False, f"evidence shorter than {config.MIN_EVIDENCE_WORDS} words"
    if fold_text(evidence) not in folded_passage:
        return False, "evidence not found in passage (lenient fold)"
    return True, None


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


def attach_shortlists(table: str, passages: list[Passage]) -> None:
    """Top-SHORTLIST_SIZE nearest vocab terms per passage via pgvector — free SQL."""
    ids = [p.id for p in passages]
    shortlist_by_id: dict[str, list[str]] = {}
    for pid, slugs in db.rows(
        f"SELECT p.id::text, ("
        f"   SELECT array_agg(sub.slug ORDER BY sub.dist) FROM ("
        f"     SELECT slug, embedding <=> p.embedding_context4 AS dist FROM public.vocab_terms"
        f"     WHERE embedding IS NOT NULL AND NOT is_ai"
        f"     ORDER BY embedding <=> p.embedding_context4 LIMIT %s) sub)"
        f" FROM public.{table} p"
        f" WHERE p.id = ANY(%s::uuid[]) AND p.embedding_context4 IS NOT NULL",
        (config.SHORTLIST_SIZE, ids),
    ):
        shortlist_by_id[pid] = list(slugs or [])
    for passage in passages:
        passage.shortlist = shortlist_by_id.get(passage.id, [])


# ── prompt + schema ─────────────────────────────────────────────────────────

def response_schema(shortlist: list[str], questions_allowed: bool) -> dict:
    schema: dict = {
        "type": "OBJECT",
        "properties": {
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
                },
            }
        },
        "required": ["tags"],
    }
    if questions_allowed:
        schema["properties"]["questions"] = {
            "type": "ARRAY",
            "maxItems": config.MAX_QUESTIONS,
            "items": {"type": "STRING"},
        }
    return schema


def build_prompt(passage: Passage, term_by_slug: dict[str, dict]) -> str:
    candidates = "\n".join(
        f"- {slug}: {term_by_slug[slug]['term']} ({term_by_slug[slug]['facet']})"
        for slug in passage.shortlist
        if slug in term_by_slug
    )
    base = (
        "You are indexing a passage from Śrīla Prabhupāda's corpus for subject"
        " search.\n\nCANDIDATE TAGS (closed list — you may ONLY use these slugs):\n"
        f"{candidates}\n\nRULES:\n"
        "1. Choose only tags whose subject the passage SUBSTANTIALLY discusses —"
        " as few or as many of the candidates as truly apply (often 2-6, never"
        f" more than {config.MAX_TAGS}). Do not tag passing mentions.\n"
        "2. For EACH tag, quote one EXACT sentence from the passage (verbatim,"
        " no paraphrase, no ellipsis) that shows the passage discusses that"
        " subject. Tags without a real verbatim sentence are discarded.\n"
    )
    if passage.questions_allowed:
        base += (
            f"3. Also list the few (at most {config.MAX_QUESTIONS}) DISTINCT"
            " questions a person might sincerely ask that THIS passage genuinely"
            " answers. Write natural questions, one sentence each; no duplicates,"
            " no questions the passage only touches in passing.\n"
        )
    else:
        base += (
            "3. This passage is NOT Śrīla Prabhupāda's own words — return topic"
            " tags only.\n"
        )
    return base + "\nPASSAGE:\n" + passage.text


def request_line(passage: Passage, term_by_slug: dict[str, dict]) -> dict:
    return {
        "key": f"{passage.table}|{passage.id}",
        "request": {
            "contents": [{"parts": [{"text": build_prompt(passage, term_by_slug)}]}],
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
    """First stratified PILOT_SIZE passages, proportional across the five
    content tables ('first' = ORDER BY id, deterministic). The verse_chunks
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
                "  WHERE tags_core IS NULL ORDER BY id LIMIT %s) c"
                " JOIN public.verses v ON v.id = c.verse_id"
                " WHERE v.tags_core IS NULL AND v.embedding_context4 IS NOT NULL",
                (want,),
            )
            picked["verses"].extend(r[0] for r in rows)
        else:
            rows = db.rows(
                f"SELECT id::text FROM public.{table}"
                " WHERE tags_core IS NULL AND embedding_context4 IS NOT NULL"
                " ORDER BY id LIMIT %s",
                (want,),
            )
            picked[table].extend(r[0] for r in rows)
    for table, ids in picked.items():
        ids = sorted(set(ids))
        if not ids:
            continue
        for index in range(0, len(ids), config.SHARD_SIZE):
            chunk = ids[index : index + config.SHARD_SIZE]
            _insert_shard(f"pilot:{table}:{index // config.SHARD_SIZE:03d}", table, chunk, run_id)
    print(f"  pilot planned: {sum(len(v) for v in picked.values())} passages.", flush=True)


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

def build_shard_file(shard_key: str, table: str, ids: list[str], term_by_slug: dict[str, dict]) -> tuple[int, int, int]:
    """Write shards/<key>.requests.jsonl. Returns (rows_written, est_in, est_out)."""
    passages = load_passages(table, ids)
    attach_shortlists(table, passages)
    usable = [p for p in passages if p.shortlist]
    skipped = len(passages) - len(usable)
    if skipped:
        print(f"    {shard_key}: {skipped} rows have no shortlist (missing embedding) — skipped", flush=True)
    config.SHARDS_DIR.mkdir(parents=True, exist_ok=True)
    path = config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.requests.jsonl"
    est_in = 0
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        for passage in usable:
            line = request_line(passage, term_by_slug)
            raw = json.dumps(line, ensure_ascii=False)
            est_in += len(raw) // 4  # chars/4 ≈ tokens; includes schema+enum overhead
            f.write(raw + "\n")
    est_out = int(len(usable) * measured_output_tokens_per_row())
    return len(usable), est_in, est_out


def shard_request_path(shard_key: str) -> Path:
    return config.SHARDS_DIR / f"{shard_key.replace(':', '_')}.requests.jsonl"


def submit_pending(model: str, term_by_slug: dict[str, dict]) -> None:
    """Submit pending shards while the ceiling allows. Job IDs are recorded in
    tag_batch_jobs immediately on acceptance — BEFORE any polling."""
    pending = db.rows(
        "SELECT shard_key, table_name, id_list::text[] FROM public.tag_batch_jobs"
        " WHERE status = 'pending' ORDER BY shard_key"
    )
    for shard_key, table, ids in pending:
        rows_written, est_in, est_out = build_shard_file(shard_key, table, ids, term_by_slug)
        if rows_written == 0:
            with db.get_pg().cursor() as cur:
                cur.execute(
                    "UPDATE public.tag_batch_jobs SET status='failed',"
                    " error='no usable rows (missing embeddings)' WHERE shard_key=%s",
                    (shard_key,),
                )
            continue
        ledger = spend_ledger()
        projected = ledger["committed_usd"] + _usd(est_in, est_out)
        if projected > config.MAX_SPEND_USD:
            print(
                f"  ⛔ COST CEILING: submitting {shard_key} would commit"
                f" ~${projected:,.2f} > MAX_SPEND_USD=${config.MAX_SPEND_USD:,.2f}."
                " Refusing to submit further shards (collection continues)."
                " Raise MAX_SPEND_USD in .env only after reviewing spend.",
                flush=True,
            )
            return
        display_name = f"{config.BATCH_DISPLAY_PREFIX}:{shard_key}"
        file_name = db.with_retry(
            lambda: gemini_client.upload_jsonl(shard_request_path(shard_key), display_name),
            f"upload {shard_key}",
        )
        job_name = db.with_retry(
            lambda: gemini_client.create_batch(model, file_name, display_name),
            f"batch create {shard_key}",
        )
        # Record BEFORE polling — a crash after this line is recoverable from
        # the DB alone; a crash before it is recovered by reconcile().
        with db.get_pg().cursor() as cur:
            cur.execute(
                "UPDATE public.tag_batch_jobs SET provider_job_id=%s, status='submitted',"
                " submitted_at=%s, est_input_tok=%s, est_output_tok=%s, row_count=%s"
                " WHERE shard_key=%s",
                (job_name, datetime.now(timezone.utc), est_in, est_out, rows_written, shard_key),
            )
        print(f"  submitted {shard_key} → {job_name} (~{est_in / 1e6:.2f}M in tok)", flush=True)


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
    tags_evidence_rejected: int = 0
    tags_accepted: int = 0
    questions_kept: int = 0
    zero_tag_rows: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    per_row_tag_counts: list[int] = field(default_factory=list)


def apply_results(shard_key: str, table: str, results_path, run_id: str,
                  vocab_slugs: set[str], term_by_slug: dict[str, dict]) -> ShardOutcome:
    """Validate + write one shard inside ONE transaction; mark applied only
    after commit. Writes ONLY new columns (tags_core, questions,
    fts_expansion_src — the trigger derives the tsvectors). Rows whose tags all
    fail the gates get tags_core='{}' so they are never resubmitted."""
    outcome = ShardOutcome(shard_key=shard_key)
    updates: list[tuple] = []          # (tags[], questions|None, expansion|None, id)
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

            folded = fold_text(passage.text)
            accepted: list[str] = []
            for item in parsed.get("tags", [])[: config.MAX_TAGS]:
                if not isinstance(item, dict):
                    continue
                tag = str(item.get("tag") or "").strip()
                evidence = str(item.get("evidence") or "").strip()
                outcome.tags_returned += 1
                if tag not in vocab_slugs:
                    outcome.tags_out_of_vocab += 1
                    evidence_records.append((table, passage_id, tag, evidence, False, "out of vocabulary"))
                    continue
                ok, reason = evidence_ok(evidence, folded)
                if not ok:
                    outcome.tags_evidence_rejected += 1
                    evidence_records.append((table, passage_id, tag, evidence, False, reason))
                    continue
                if tag not in accepted:
                    accepted.append(tag)
                    outcome.tags_accepted += 1
                    evidence_records.append((table, passage_id, tag, evidence, True, None))

            questions: list[str] = []
            if passage.questions_allowed:
                seen = set()
                for q in parsed.get("questions", [])[: config.MAX_QUESTIONS]:
                    q = str(q or "").strip()
                    if q and q.lower() not in seen:
                        seen.add(q.lower())
                        questions.append(q)
            outcome.questions_kept += len(questions)
            outcome.per_row_tag_counts.append(len(accepted))
            if not accepted:
                outcome.zero_tag_rows += 1

            expansion_lines: dict[str, None] = {}
            for tag in accepted:
                term = term_by_slug.get(tag)
                if term:
                    expansion_lines.setdefault(term["term"], None)
                    for variant in term["variants"]:
                        expansion_lines.setdefault(variant, None)
            updates.append(
                (
                    accepted,
                    "\n".join(questions) if questions else None,
                    "\n".join(expansion_lines) if expansion_lines else None,
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
                    f" fts_expansion_src=%s WHERE id=%s::uuid",
                    updates[start : start + config.DB_BATCH],
                )
            cur.executemany(
                "INSERT INTO public.tag_evidence"
                " (run_id, table_name, passage_id, tag, evidence, accepted, reject_reason)"
                " VALUES (%s::uuid, %s, %s::uuid, %s, %s, %s, %s)",
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
    vocabulary = build_vocabulary.load_vocabulary()
    vocab_slugs = {t["slug"] for t in vocabulary["terms"]}
    term_by_slug = {t["slug"]: t for t in vocabulary["terms"]}
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
                outcomes.append(apply_results(shard_key, table, results_path, run_id, vocab_slugs, term_by_slug))
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
                outcomes.append(apply_results(shard_key, table, results_path, run_id, vocab_slugs, term_by_slug))
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

def summarize(outcomes: list[ShardOutcome]) -> dict:
    tag_counts = [n for o in outcomes for n in o.per_row_tag_counts]
    responses = sum(o.responses for o in outcomes)
    tags_returned = sum(o.tags_returned for o in outcomes)
    vocab_valid = tags_returned - sum(o.tags_out_of_vocab for o in outcomes)
    stats = {
        "rows": sum(o.rows for o in outcomes),
        "responses": responses,
        "schema_valid_rate": (sum(o.schema_valid for o in outcomes) / responses) if responses else 0.0,
        "out_of_vocab_rate": (sum(o.tags_out_of_vocab for o in outcomes) / tags_returned) if tags_returned else 0.0,
        "evidence_match_rate": (sum(o.tags_accepted for o in outcomes) / vocab_valid) if vocab_valid else 0.0,
        "tags_returned": tags_returned,
        "tags_accepted": sum(o.tags_accepted for o in outcomes),
        "questions_kept": sum(o.questions_kept for o in outcomes),
        "zero_tag_rows": sum(o.zero_tag_rows for o in outcomes),
        "input_tokens": sum(o.input_tokens for o in outcomes),
        "output_tokens": sum(o.output_tokens for o in outcomes),
    }
    if tag_counts:
        ordered = sorted(tag_counts)
        stats["tags_mean"] = sum(ordered) / len(ordered)
        stats["tags_p50"] = ordered[len(ordered) // 2]
        stats["tags_p90"] = ordered[int(len(ordered) * 0.9)]
        stats["tags_max"] = ordered[-1]
    else:
        stats.update({"tags_mean": 0.0, "tags_p50": 0, "tags_p90": 0, "tags_max": 0})
    return stats


def pilot_thresholds_pass(stats: dict) -> list[str]:
    failures = []
    if stats["schema_valid_rate"] < config.PILOT_MIN_SCHEMA_VALID:
        failures.append(
            f"schema_valid_rate {stats['schema_valid_rate']:.3f} < {config.PILOT_MIN_SCHEMA_VALID}"
        )
    if stats["evidence_match_rate"] < config.PILOT_MIN_EVIDENCE_MATCH:
        failures.append(
            f"evidence_match_rate {stats['evidence_match_rate']:.3f} < {config.PILOT_MIN_EVIDENCE_MATCH}"
        )
    if stats["out_of_vocab_rate"] > config.PILOT_MAX_OUT_OF_VOCAB:
        failures.append(
            f"out_of_vocab_rate {stats['out_of_vocab_rate']:.3f} > {config.PILOT_MAX_OUT_OF_VOCAB}"
        )
    if stats["tags_mean"] < config.PILOT_MIN_MEAN_TAGS:
        failures.append(f"tags_mean {stats['tags_mean']:.2f} < {config.PILOT_MIN_MEAN_TAGS}")
    return failures


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
        "# Pilot report — tags+questions combined pass",
        "",
        f"- Generated: {datetime.now(timezone.utc).isoformat()}",
        f"- Model: `{model}` · prompt `{config.PROMPT_VERSION}` · MAX_TAGS {config.MAX_TAGS}",
        f"- Verdict: **{verdict}**",
        "",
        "## Quality",
        f"- Passages applied: {stats['rows']} (responses: {stats['responses']})",
        f"- Schema validity: {stats['schema_valid_rate']:.1%} (threshold ≥ {config.PILOT_MIN_SCHEMA_VALID:.0%})",
        f"- Evidence-match rate: {stats['evidence_match_rate']:.1%} (threshold ≥ {config.PILOT_MIN_EVIDENCE_MATCH:.0%})",
        f"- Out-of-vocabulary rate: {stats['out_of_vocab_rate']:.2%} (threshold ≤ {config.PILOT_MAX_OUT_OF_VOCAB:.0%})",
        f"- Tags/passage: mean {stats['tags_mean']:.2f} · p50 {stats['tags_p50']} · p90 {stats['tags_p90']}"
        f" · max {stats['tags_max']} (cap {config.MAX_TAGS})",
        f"- Zero-tag passages: {stats['zero_tag_rows']}",
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
    with open(config.PILOT_REPORT_PATH, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")
    print(f"  wrote {config.PILOT_REPORT_PATH}", flush=True)


def pilot_stats_from_db() -> dict:
    """Pilot quality metrics recomputed from the DATABASE (not in-memory shard
    outcomes) so validation is correct even when some pilot shards were applied
    by an earlier, interrupted process. schema_valid_rate works because apply
    only UPDATEs rows whose response parsed: unparsed rows keep tags_core NULL."""
    planned, real_in, real_out = db.rows(
        "SELECT coalesce(sum(row_count),0), coalesce(sum(cost_input_tok),0),"
        "       coalesce(sum(cost_output_tok),0)"
        " FROM public.tag_batch_jobs WHERE shard_key LIKE %s AND status='applied'",
        ("pilot:%",),
    )[0]
    per_table_union = " UNION ALL ".join(
        f"SELECT cardinality(t.tags_core) AS n, t.questions IS NOT NULL AS has_q,"
        f"       t.tags_core IS NOT NULL AS updated"
        f" FROM pilot p JOIN public.{t} t ON t.id = p.id AND p.table_name = '{t}'"
        for t in config.GEMINI_TABLES
    )
    row = db.rows(
        "WITH pilot AS (SELECT table_name, unnest(id_list) AS id FROM public.tag_batch_jobs"
        "               WHERE shard_key LIKE %s AND status='applied'),"
        f" c AS ({per_table_union})"
        " SELECT count(*) FILTER (WHERE updated),"
        "        coalesce(avg(n) FILTER (WHERE updated), 0),"
        "        coalesce(percentile_disc(0.5) WITHIN GROUP (ORDER BY n) FILTER (WHERE updated), 0),"
        "        coalesce(percentile_disc(0.9) WITHIN GROUP (ORDER BY n) FILTER (WHERE updated), 0),"
        "        coalesce(max(n) FILTER (WHERE updated), 0),"
        "        count(*) FILTER (WHERE updated AND n = 0),"
        "        count(*) FILTER (WHERE has_q)"
        " FROM c",
        ("pilot:%",),
    )[0]
    updated, tags_mean, tags_p50, tags_p90, tags_max, zero_tag_rows, question_rows = row
    ev = db.rows(
        "WITH pilot AS (SELECT table_name, unnest(id_list) AS id FROM public.tag_batch_jobs"
        "               WHERE shard_key LIKE %s AND status='applied')"
        " SELECT count(*),"
        "        count(*) FILTER (WHERE NOT accepted AND reject_reason = 'out of vocabulary'),"
        "        count(*) FILTER (WHERE accepted)"
        " FROM public.tag_evidence e"
        " WHERE EXISTS (SELECT 1 FROM pilot p WHERE p.table_name = e.table_name AND p.id = e.passage_id)",
        ("pilot:%",),
    )[0]
    tags_returned, oov, accepted = int(ev[0]), int(ev[1]), int(ev[2])
    vocab_valid = tags_returned - oov
    planned = int(planned)
    return {
        "rows": int(updated),
        "responses": planned,
        "schema_valid_rate": (int(updated) / planned) if planned else 0.0,
        "out_of_vocab_rate": (oov / tags_returned) if tags_returned else 0.0,
        "evidence_match_rate": (accepted / vocab_valid) if vocab_valid else 0.0,
        "tags_returned": tags_returned,
        "tags_accepted": accepted,
        "questions_kept": int(question_rows),
        "zero_tag_rows": int(zero_tag_rows),
        "input_tokens": int(real_in),
        "output_tokens": int(real_out),
        "tags_mean": float(tags_mean),
        "tags_p50": int(tags_p50),
        "tags_p90": int(tags_p90),
        "tags_max": int(tags_max),
    }


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
