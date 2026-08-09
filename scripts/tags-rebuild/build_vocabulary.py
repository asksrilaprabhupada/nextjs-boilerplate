"""
build_vocabulary.py — build the closed, faceted controlled vocabulary
(vocabulary.json) and load it into vocab_terms. Step 2 of run_all.py; also
runnable standalone: `python build_vocabulary.py`.

Facets: Concept / Person / Place / Scripture / Practice. There is NO Sanskrit
facet — one topic = one term and language forms are spelling variants. Every
term carries kind=concept (Concept/Practice) or kind=entity (Person/Place/
Scripture); entities don't count toward the concept-size expectation.

Sources, in order:
  1. Curated seeds (vocabulary_seeds.json — the reviewed menu, committed to the
     repo, including hard_negative contrast pairs and related links).
  2. CANDIDATES — never straight into the menu, always through one Gemini
     naming/dedup review path:
       a. chapter titles (chapters.chapter_title);
       b. recurring Sanskrit glossary terms mined from verses.synonyms glosses
          (particle stoplist + chapter-dispersion check + net-new cap ~100).
  3. Clustering of existing embedding_context4 vectors as LENSES, not truth:
     seeded-random stratified sample → MiniBatchKMeans at k ∈ KMEANS_VIEWS plus
     one HDBSCAN density view. Gemini names each cluster from its nearest AND
     farthest members and may answer "incoherent — drop". The cosine centroid
     auto-merge produces merge PROPOSALS: applied provisionally, every one
     listed in vocabulary.json's "merges" section for the human gate to veto
     (veto = edit vocabulary.json before pressing Enter at the ⛔ gate).

After assembly Gemini drafts a ONE-line scope note per term (what it covers +
one thing it excludes) — stored on the term, shown at the gate, injected into
the tagging prompt.

Output: vocabulary.json (the ⛔ review gate artifact) with {term, slug, facet,
kind, parent, variants, sources, scope_note, hard_negatives, related} plus the
"merges" and "warnings" sections and the recorded sampling seed. Then
load_vocab_terms() upserts the frozen list into public.vocab_terms (service
key) with Voyage embeddings for the per-passage shortlists.
"""
from __future__ import annotations

import hashlib
import json
import re as stdre
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone

import numpy as np
import requests
from tqdm import tqdm

import config
import db
import gemini_client
import voyage_client

CHAPTER_TITLE_MAX = 800
GEMINI_NAMING_TEMP = 0.2
CLUSTERS_PER_CALL = 25          # nearest+farthest snippets make each cluster bigger
CANDIDATES_PER_CALL = 60
SCOPE_NOTES_PER_CALL = 80
MIN_CLUSTER_MEMBERS = 5         # tiny clusters are noise, not concepts
# Sanskrit particles/inflection words that recur constantly in glosses but make
# useless tags (the recurrence floor alone would let them in). Grammatical
# particles are NEVER terms; the Gemini candidate review is told the same rule.
SANSKRIT_STOPWORDS = {
    "ca", "eva", "na", "hi", "tu", "api", "iti", "vai", "atha", "tat", "tam",
    "sa", "te", "me", "mama", "asya", "tasya", "yat", "etat", "idam", "kim",
    "uvaca", "uvāca", "aham", "tvam", "sarva", "sarvam", "khalu", "kila",
    "iva", "yatha", "tatha", "yada", "tada", "atra", "tatra", "kintu",
    "punah", "param", "tatah", "tasmat", "tesam", "yasya", "asmin", "caiva",
}


def fold(text: str) -> str:
    """Lenient diacritic fold shared by slugs and variant generation."""
    decomposed = unicodedata.normalize("NFD", text or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower().strip()


def slugify(term: str) -> str:
    folded = fold(term)
    return stdre.sub(r"-{2,}", "-", stdre.sub(r"[^a-z0-9]+", "-", folded)).strip("-")


def seed_int(salt: str = "") -> int:
    """Deterministic 31-bit int derived from SAMPLE_SEED for sklearn seeding."""
    digest = hashlib.sha256((config.SAMPLE_SEED + salt).encode("utf-8")).hexdigest()
    return int(digest[:8], 16) % (2**31)


def _variants_for(term: str, extra: list[str]) -> list[str]:
    """Spelling variants: given alternates + the ASCII fold of everything."""
    seen: dict[str, None] = {}
    for candidate in [term, *extra]:
        for form in (candidate.strip(), fold(candidate)):
            if form and form.lower() != term.lower():
                seen.setdefault(form, None)
    return list(seen)


class Vocab:
    """Accumulates terms; dedupes by slug (first facet wins, variants merge)."""

    def __init__(self) -> None:
        self.terms: dict[str, dict] = {}

    def add(self, term: str, facet: str, variants: list[str], source: str, parent: str | None = None) -> str:
        slug = slugify(term)
        if not slug:
            return ""
        entry = self.terms.get(slug)
        if entry is None:
            entry = {
                "term": term.strip(),
                "slug": slug,
                "facet": facet,
                "kind": "entity" if facet in config.ENTITY_FACETS else "concept",
                "parent": parent,
                "variants": [],
                "sources": [],
                "scope_note": "",
                "hard_negatives": [],
                "related": [],
            }
            self.terms[slug] = entry
        merged = {v: None for v in entry["variants"]}
        for v in _variants_for(entry["term"], variants):
            merged.setdefault(v, None)
        entry["variants"] = list(merged)
        if source not in entry["sources"]:
            entry["sources"].append(source)
        if parent and not entry["parent"]:
            entry["parent"] = parent
        return slug

    def add_variant(self, slug: str, variant: str) -> None:
        entry = self.terms.get(slug)
        if entry is None:
            return
        merged = {v: None for v in entry["variants"]}
        for v in _variants_for(entry["term"], [variant]):
            merged.setdefault(v, None)
        entry["variants"] = list(merged)

    def link(self, kind: str, slug_a: str, slug_b: str) -> None:
        """Symmetric hard_negatives / related link between two existing slugs."""
        if slug_a == slug_b or slug_a not in self.terms or slug_b not in self.terms:
            return
        for one, other in ((slug_a, slug_b), (slug_b, slug_a)):
            bucket = self.terms[one][kind]
            if other not in bucket:
                bucket.append(other)

    def concept_count(self) -> int:
        return sum(1 for t in self.terms.values() if t["kind"] == "concept")

    def entity_count(self) -> int:
        return sum(1 for t in self.terms.values() if t["kind"] == "entity")


# ── Source 1: curated seeds (incl. contrast pairs) ──────────────────────────

def add_seeds(vocab: Vocab) -> None:
    with open(config.SEEDS_PATH, encoding="utf-8") as f:
        seeds = json.load(f)
    if "Sanskrit" in seeds["facets"]:
        raise SystemExit(
            "FATAL: vocabulary_seeds.json still has a Sanskrit facet — the v3 rule is"
            " one topic = one term with language forms as variants. Dissolve it first."
        )
    pending_links: list[tuple[str, str, str]] = []  # (kind, from_slug, to_term_name)
    for facet, entries in seeds["facets"].items():
        if facet not in config.FACETS:
            raise SystemExit(f"FATAL: vocabulary_seeds.json has unknown facet '{facet}'")
        for entry in entries:
            slug = vocab.add(entry["term"], facet, entry.get("variants", []), "seed")
            for name in entry.get("hard_negatives", []):
                pending_links.append(("hard_negatives", slug, name))
            for name in entry.get("related", []):
                pending_links.append(("related", slug, name))
    # Second pass: every referenced partner must itself be a seeded term.
    for kind, slug, name in pending_links:
        target = slugify(name)
        if target not in vocab.terms:
            raise SystemExit(
                f"FATAL: vocabulary_seeds.json links '{slug}' → '{name}' ({kind}) but"
                " no seed term has that slug — contrast pairs must name real terms."
            )
        vocab.link(kind, slug, target)


# ── Gemini helpers ──────────────────────────────────────────────────────────

def _gemini_generate(model: str, prompt: str, schema: dict) -> dict:
    def _call():
        res = requests.post(
            f"{config.GEMINI_BASE}/models/{model}:generateContent",
            params={"key": config.GEMINI_API_KEY},
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "responseMimeType": "application/json",
                    "responseSchema": schema,
                    "temperature": GEMINI_NAMING_TEMP,
                },
            },
            timeout=120,
        )
        if not res.ok:
            raise gemini_client.GeminiHTTPError("vocabulary call", res)
        return res.json()

    # Patient Gemini-specific retry (503 demand spikes last minutes), NOT the
    # short db.with_retry pooler backoff. 400/401/403 still fail immediately.
    data = gemini_client.with_gemini_retry(_call, "vocabulary call")
    text = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [{}])[0].get("text", "")
    return json.loads(text)


# ── Gemini decision cache (crash-resume: paid work is never repeated) ───────
# Local JSONL, gitignored. Every cluster-naming and candidate-review decision
# is appended as soon as its response arrives, keyed by a content hash; a rerun
# after a crash replays cached decisions in seconds and only calls Gemini for
# uncached work. Append-only writes survive a crash (a torn last line is
# skipped on load).

GEMINI_CACHE_PATH = config.HARNESS_DIR / "gemini-vocab-cache.jsonl"
# Part of every cache key — bump when the naming/review prompts or schemas
# change so stale decisions are never reused.
CACHE_PROMPT_VERSION = "asp-vocab-v1"

_gemini_cache: dict[str, dict] | None = None


def _cache_key(*parts) -> str:
    return hashlib.sha256(
        json.dumps(parts, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()


def _cache_load() -> dict[str, dict]:
    global _gemini_cache
    if _gemini_cache is None:
        _gemini_cache = {}
        if GEMINI_CACHE_PATH.exists():
            with open(GEMINI_CACHE_PATH, encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        entry = json.loads(line)
                        _gemini_cache[entry["key"]] = entry["value"]
                    except (json.JSONDecodeError, KeyError, TypeError):
                        continue  # torn last line from a crash — ignored
    return _gemini_cache


def _cache_get(key: str) -> dict | None:
    return _cache_load().get(key)


def _cache_put(key: str, value: dict) -> None:
    _cache_load()[key] = value
    with open(GEMINI_CACHE_PATH, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps({"key": key, "value": value}, ensure_ascii=False) + "\n")


LABEL_RULES = (
    "Label rules: the preferred label is the word devotees actually use —"
    " English by default; Sanskrit-preferred ONLY where the Sanskrit word IS the"
    " everyday word (prasādam, kīrtana, japa, ekādaśī). Labels are short subject"
    " headings (2-5 words, the kind Vedabase or a Gītā index would use)."
    " Grammatical particles or inflection words (eva, ca, tu, hi, api, na, iti…)"
    " are NEVER terms."
)


# ── Source 2: candidates (chapter titles + mined Sanskrit glosses) ──────────

def chapter_title_candidates() -> list[dict]:
    titles = db.rows(
        "SELECT DISTINCT chapter_title FROM public.chapters"
        " WHERE chapter_title IS NOT NULL AND length(chapter_title) BETWEEN 4 AND 80"
        " ORDER BY chapter_title LIMIT %s",
        (CHAPTER_TITLE_MAX,),
    )
    out = []
    for (title,) in titles:
        cleaned = stdre.sub(r"^\s*(chapter\s+)?\d+[.:\s-]*", "", title, flags=stdre.I).strip()
        if len(cleaned) >= 4 and not cleaned.isdigit():
            out.append({"text": cleaned, "source": "chapter_title", "context": "book chapter title"})
    return out


def sanskrit_gloss_candidates() -> list[dict]:
    """verses.synonyms holds word-for-word glosses: 'term — gloss; term — gloss'.
    Candidates = recurring terms (freq ≥ SANSKRIT_MIN_FREQ) that also pass the
    particle stoplist and the DISPERSION check (must appear across at least
    SANSKRIT_MIN_CHAPTERS distinct chapters — a term concentrated in one chapter
    is a local word, not a subject). Top SANSKRIT_MAX_CANDIDATES by frequency go
    to the Gemini review; net-NEW additions are capped later at SANSKRIT_MAX_NEW."""
    counts: Counter[str] = Counter()
    chapters: dict[str, set] = defaultdict(set)
    display: dict[str, str] = {}
    for synonyms, chapter_id in db.iter_rows(
        "SELECT synonyms, chapter_id::text FROM public.verses WHERE synonyms IS NOT NULL"
    ):
        for entry in synonyms.split(";"):
            head = entry.split("—", 1)[0].split("--", 1)[0].strip()
            head = stdre.sub(r"[.,:()\[\]\"']", "", head).strip()
            if not head or " " in head:
                continue
            base = fold(head).strip("-")
            if len(base) < 4 or base in SANSKRIT_STOPWORDS or base.isdigit():
                continue
            counts[base] += 1
            chapters[base].add(chapter_id)
            display.setdefault(base, head)

    translit = defaultdict(list)
    for variant, canonical, display_name in db.rows(
        "SELECT variant, canonical, display_name FROM public.transliteration_synonyms"
    ):
        translit[fold(canonical)].extend(x for x in (variant, display_name) if x)

    out = []
    dropped_dispersion = 0
    for base, freq in counts.most_common():
        if freq < config.SANSKRIT_MIN_FREQ:
            break
        if len(chapters[base]) < config.SANSKRIT_MIN_CHAPTERS:
            dropped_dispersion += 1
            continue
        out.append(
            {
                "text": display[base],
                "source": "synonyms_gloss",
                "context": f"gloss frequency {freq}, {len(chapters[base])} chapters",
                "variants": translit.get(base, []),
            }
        )
        if len(out) >= config.SANSKRIT_MAX_CANDIDATES:
            break
    print(
        f"  gloss mining: {len(out)} candidates (dispersion dropped {dropped_dispersion};"
        f" net-new additions capped at {config.SANSKRIT_MAX_NEW})",
        flush=True,
    )
    return out


CANDIDATE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "decisions": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "candidate_id": {"type": "INTEGER"},
                    "action": {"type": "STRING", "enum": ["add", "merge", "drop"]},
                    "name": {"type": "STRING"},
                    "facet": {"type": "STRING", "enum": config.FACETS},
                    "merge_into_slug": {"type": "STRING"},
                    "plain_english_variant": {"type": "STRING"},
                },
                "required": ["candidate_id", "action"],
            },
        }
    },
    "required": ["decisions"],
}


def review_candidates(vocab: Vocab, model: str, candidates: list[dict], merges: list[dict]) -> None:
    """ONE naming/dedup path for every non-seed candidate. Gemini decides per
    candidate: add (with a properly-labelled name + facet + one plain-English
    variant), merge into an existing term, or drop. Mined gloss additions are
    capped at SANSKRIT_MAX_NEW net-new terms."""
    if not candidates:
        return
    gloss_added = 0

    def apply_decision(cand: dict, item: dict) -> None:
        nonlocal gloss_added
        action = item.get("action")
        if action == "merge":
            target = (item.get("merge_into_slug") or "").strip()
            if target in vocab.terms:
                if cand["source"] == "synonyms_gloss":
                    # A language form of the same topic → becomes a variant.
                    vocab.add_variant(target, cand["text"])
                    for extra in cand.get("variants", []):
                        vocab.add_variant(target, extra)
                if cand["source"] not in vocab.terms[target]["sources"]:
                    vocab.terms[target]["sources"].append(cand["source"])
                merges.append(
                    {
                        "type": "candidate-merge",
                        "source": cand["source"],
                        "candidate": cand["text"],
                        "into_slug": target,
                    }
                )
        elif action == "add":
            if cand["source"] == "synonyms_gloss" and gloss_added >= config.SANSKRIT_MAX_NEW:
                return  # mining cap: ~100 net-new terms
            name = (item.get("name") or "").strip()
            facet = item.get("facet", "Concept")
            if not name or facet not in config.FACETS:
                return
            variants = [cand["text"], *cand.get("variants", [])]
            plain = (item.get("plain_english_variant") or "").strip()
            if plain:
                variants.append(plain)
            before = slugify(name) in vocab.terms
            vocab.add(name, facet, variants, cand["source"])
            if cand["source"] == "synonyms_gloss" and not before:
                gloss_added += 1

    # Cache split: cached decisions replay instantly (in original candidate
    # order — the cap allocation stays deterministic); only the rest are paid.
    cached: list[tuple[dict, dict]] = []
    pending: list[dict] = []
    for cand in candidates:
        key = _cache_key(
            "candidate-review", CACHE_PROMPT_VERSION, model,
            cand["source"], cand["text"], cand.get("context", ""),
            sorted(cand.get("variants", [])),
        )
        cand["_cache_key"] = key
        hit = _cache_get(key)
        if hit is not None:
            cached.append((cand, hit))
        else:
            pending.append(cand)
    if cached:
        print(
            f"  candidate review: {len(cached)} decisions from cache, {len(pending)} to review",
            flush=True,
        )
    for cand, item in cached:
        apply_decision(cand, item)
    for start in tqdm(range(0, len(pending), CANDIDATES_PER_CALL), desc="  candidate review"):
        chunk = pending[start : start + CANDIDATES_PER_CALL]
        catalog = "\n".join(f"{s}: {vocab.terms[s]['term']}" for s in sorted(vocab.terms))
        lines = [
            f"candidate_id={i}: \"{c['text']}\" (source: {c['source']}; {c['context']})"
            for i, c in enumerate(chunk)
        ]
        prompt = (
            "You are curating a closed subject vocabulary for Śrīla Prabhupāda's"
            " books, lectures and letters (Gauḍīya Vaiṣṇava corpus). Below are raw"
            " CANDIDATES (book chapter titles and recurring Sanskrit glossary"
            " words). For EACH candidate decide:\n"
            "- merge: it is the SAME subject as an existing term → merge_into_slug.\n"
            "- add: it is a real, reusable subject not yet covered → give the"
            " canonical name and facet, plus one plain_english_variant (a natural"
            " English wording of the same subject).\n"
            "- drop: not a reusable subject (a one-off narrative title, a"
            " grammatical particle or inflected form, or too vague to tag with).\n"
            f"{LABEL_RULES}\n\nCANDIDATES:\n" + "\n".join(lines)
            + "\n\nExisting terms (slug: term):\n" + catalog
        )
        parsed = _gemini_generate(model, prompt, CANDIDATE_SCHEMA)
        for item in parsed.get("decisions", []):
            try:
                index = int(item.get("candidate_id"))
            except (TypeError, ValueError):
                continue
            if not 0 <= index < len(chunk):  # negative would WRAP to chunk[-1]
                continue
            cand = chunk[index]
            _cache_put(cand["_cache_key"], {k: v for k, v in item.items() if k != "candidate_id"})
            apply_decision(cand, item)


# ── Source 3: embedding clusters as lenses, named by Gemini ─────────────────

def _parse_vector(text: str) -> np.ndarray:
    # pgvector's text form "[0.1,0.2,...]" is valid JSON
    return np.asarray(json.loads(text), dtype=np.float32)


def _sample_table(table: str, want: int, keys: list, vectors: list, extra_where: str = "",
                  params: tuple = ()) -> None:
    got = 0
    for row_id, vec_text in db.iter_rows(
        f"SELECT id::text, embedding_context4::text FROM public.{table}"
        f" WHERE embedding_context4 IS NOT NULL{extra_where}"
        f" ORDER BY md5(%s || id::text) LIMIT %s",
        (*params, config.SAMPLE_SEED, want),
    ):
        vec = _parse_vector(vec_text)
        if vec.size != 1024:
            continue
        keys.append((table, row_id))
        vectors.append(vec)
        got += 1
    print(f"  {table}{extra_where and ' (stratum)' or ''}: {got} vectors", flush=True)


def _stratified_sample() -> tuple[list[tuple[str, str]], np.ndarray]:
    """SEEDED random sample of (table, id) + vectors, stratified by table (and
    by book within prose_paragraphs). Deterministic given SAMPLE_SEED — the
    seed is recorded in vocabulary.json."""
    live = {t: db.table_count(t, "embedding_context4 IS NOT NULL") for t in config.CONTENT_TABLES}
    total = sum(live.values()) or 1
    keys: list[tuple[str, str]] = []
    vectors: list[np.ndarray] = []
    for table, count in live.items():
        want = min(count, round(config.CLUSTER_SAMPLE * count / total))
        if want == 0:
            continue
        print(f"  sampling {want} vectors from {table} (seed {config.SAMPLE_SEED!r})", flush=True)
        if table == "prose_paragraphs":
            by_book = db.rows(
                "SELECT lower(coalesce(book_slug, '')), count(*) FROM public.prose_paragraphs"
                " WHERE embedding_context4 IS NOT NULL GROUP BY 1 ORDER BY 1"
            )
            book_total = sum(n for _, n in by_book) or 1
            for book, n in by_book:
                want_book = min(n, round(want * n / book_total))
                if want_book:
                    _sample_table(
                        table, want_book, keys, vectors,
                        extra_where=" AND lower(coalesce(book_slug, '')) = %s",
                        params=(book,),
                    )
        else:
            _sample_table(table, want, keys, vectors)
    return keys, np.vstack(vectors)


def _kmeans_view(normalized: np.ndarray, k: int, view: str):
    """One MiniBatchKMeans lens + cosine centroid merge PROPOSALS (applied
    provisionally; every merge recorded for the human gate to veto). Returns
    (labels, centroids, merged_groups) where merged_groups maps final group id
    → provisional merge record (appended to the run's `merges` list by
    _name_view after naming)."""
    from sklearn.cluster import AgglomerativeClustering, MiniBatchKMeans

    k = min(k, len(normalized))
    km = MiniBatchKMeans(n_clusters=k, random_state=seed_int(view), batch_size=4096, n_init=3)
    labels = km.fit_predict(normalized)
    centroids = km.cluster_centers_
    centroids = centroids / (np.linalg.norm(centroids, axis=1, keepdims=True) + 1e-9)

    merger = AgglomerativeClustering(
        n_clusters=None,
        metric="cosine",
        linkage="average",
        distance_threshold=config.CLUSTER_MERGE_COSINE,
    )
    group_of = merger.fit_predict(centroids)
    final_labels = np.array([group_of[l] for l in labels])
    n_groups = int(group_of.max()) + 1
    merged = np.zeros((n_groups, centroids.shape[1]), dtype=np.float32)
    merged_groups: dict[int, dict] = {}
    for group in range(n_groups):
        members = centroids[group_of == group]
        merged[group] = members.mean(axis=0)
        if len(members) > 1:
            merged_groups[group] = {
                "type": "centroid-merge",
                "view": view,
                "merged_clusters": int(len(members)),
                "passages": int((final_labels == group).sum()),
                "named_as": None,  # filled after Gemini naming
            }
    return final_labels, merged, merged_groups


def _hdbscan_view(normalized: np.ndarray, view: str):
    """One density lens. Noise (-1) is ignored; no centroid merging. The point
    set is capped at HDBSCAN_MAX_POINTS (the sample is already seeded-random,
    so slicing keeps it random) — the cap is PRINTED, never silent."""
    from sklearn.cluster import HDBSCAN

    points = normalized
    if len(points) > config.HDBSCAN_MAX_POINTS:
        print(
            f"  {view}: capping {len(points)} → {config.HDBSCAN_MAX_POINTS} points"
            " (seeded-random prefix; cap in config.HDBSCAN_MAX_POINTS)",
            flush=True,
        )
        points = points[: config.HDBSCAN_MAX_POINTS]
    labels = HDBSCAN(min_cluster_size=config.HDBSCAN_MIN_CLUSTER_SIZE).fit_predict(points)
    n_groups = int(labels.max()) + 1
    if n_groups <= 0:
        return np.full(len(normalized), -1), np.zeros((0, normalized.shape[1]), dtype=np.float32)
    centroids = np.zeros((n_groups, normalized.shape[1]), dtype=np.float32)
    for group in range(n_groups):
        centroids[group] = points[labels == group].mean(axis=0)
    full_labels = np.full(len(normalized), -1)
    full_labels[: len(points)] = labels
    return full_labels, centroids


def _snippets_for(keys: list[tuple[str, str]]) -> dict[tuple[str, str], str]:
    """Short text snippets for representative passages, batched per table
    (verses → translation, everything else → body_text)."""
    by_table: dict[str, list[str]] = defaultdict(list)
    for table, row_id in keys:
        by_table[table].append(row_id)
    out: dict[tuple[str, str], str] = {}
    for table, ids in by_table.items():
        column = "translation" if table == "verses" else "body_text"
        for row_id, text in db.rows(
            f"SELECT id::text, left(coalesce({column}, ''), 240) FROM public.{table}"
            f" WHERE id = ANY(%s::uuid[])",
            (ids,),
        ):
            out[(table, row_id)] = (text or "").replace("\n", " ").strip()
    return out


NAMING_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "clusters": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "cluster_id": {"type": "INTEGER"},
                    "incoherent": {"type": "BOOLEAN"},
                    "name": {"type": "STRING"},
                    "facet": {"type": "STRING", "enum": config.FACETS},
                    "same_as_existing_slug": {"type": "STRING"},
                },
                "required": ["cluster_id", "incoherent"],
            },
        }
    },
    "required": ["clusters"],
}


def _name_view(vocab: Vocab, model: str, view: str, keys: list, normalized: np.ndarray,
               labels: np.ndarray, centroids: np.ndarray, merges: list[dict],
               merged_groups: dict[int, dict] | None = None) -> None:
    """Gemini names one view's clusters from nearest AND farthest members;
    'incoherent — drop' is an allowed answer. same-as-existing answers are
    recorded as merge proposals too."""
    clusters = []
    for group in range(centroids.shape[0]):
        member_idx = np.where(labels == group)[0]
        if member_idx.size < MIN_CLUSTER_MEMBERS:
            continue
        sims = normalized[member_idx] @ centroids[group]
        order = np.argsort(-sims)
        nearest = member_idx[order[:3]]
        farthest = member_idx[order[-3:]]
        member_ids = sorted(f"{keys[i][0]}:{keys[i][1]}" for i in member_idx)
        clusters.append(
            {
                "id": group,
                "size": int(member_idx.size),
                "near": [keys[i] for i in nearest],
                "far": [keys[i] for i in farthest],
                "cache_key": _cache_key(
                    "cluster-naming", CACHE_PROMPT_VERSION, model, view,
                    int(group), member_ids,
                ),
            }
        )
    incoherent = named = mapped = 0

    def apply_decision(item: dict) -> None:
        nonlocal incoherent, named, mapped
        cluster_id = item.get("cluster_id")
        if item.get("incoherent"):
            incoherent += 1
            return
        same = (item.get("same_as_existing_slug") or "").strip()
        name = (item.get("name") or "").strip()
        record = (merged_groups or {}).get(cluster_id)
        if same and same in vocab.terms:
            if "cluster" not in vocab.terms[same]["sources"]:
                vocab.terms[same]["sources"].append("cluster")
            mapped += 1
            size = next((c["size"] for c in clusters if c["id"] == cluster_id), None)
            merges.append(
                {
                    "type": "same-as-existing",
                    "view": view,
                    "passages": size,
                    "existing_slug": same,
                    "proposed_name": name or None,
                }
            )
            if record:
                record["named_as"] = same
            return
        facet = item.get("facet", "Concept")
        if name and facet in config.FACETS:
            slug = vocab.add(name, facet, [], f"cluster:{view}")
            named += 1
            if record:
                record["named_as"] = slug

    # Cache split: replay cached decisions instantly; only uncached clusters
    # are sent to Gemini (snippets are fetched only for those).
    cached_items: list[dict] = []
    pending: list[dict] = []
    for cluster in clusters:
        hit = _cache_get(cluster["cache_key"])
        if hit is not None:
            cached_items.append({**hit, "cluster_id": cluster["id"]})
        else:
            pending.append(cluster)
    if cached_items:
        print(
            f"  {view}: {len(cached_items)} cluster decisions from cache, {len(pending)} to name",
            flush=True,
        )
    for item in cached_items:
        apply_decision(item)
    snippet_keys = [k for c in pending for k in (*c["near"], *c["far"])]
    snippets = _snippets_for(snippet_keys)
    for start in tqdm(range(0, len(pending), CLUSTERS_PER_CALL), desc=f"  naming {view}"):
        chunk = pending[start : start + CLUSTERS_PER_CALL]
        by_id = {c["id"]: c for c in chunk}
        lines = []
        for cluster in chunk:
            near = "\n    - ".join(snippets.get(k, "") for k in cluster["near"])
            far = "\n    - ".join(snippets.get(k, "") for k in cluster["far"])
            lines.append(
                f"cluster_id={cluster['id']} (≈{cluster['size']} passages)\n"
                f"  NEAREST members:\n    - {near}\n  FARTHEST members:\n    - {far}"
            )
        existing = sorted(vocab.terms)
        prompt = (
            "You are organizing a closed subject vocabulary for Śrīla Prabhupāda's"
            " books, lectures and letters (Gauḍīya Vaiṣṇava corpus). Below are"
            " embedding clusters from ONE clustering lens, each shown as its"
            " NEAREST members (closest to the centroid) and FARTHEST members"
            " (still inside the cluster). Clustering is a lens, not truth.\n"
            "For EACH cluster answer:\n"
            "- incoherent=true if the members do not share ONE subject (judge by"
            " the farthest members especially) — the cluster is then dropped;\n"
            "- else incoherent=false plus: the subject name, its facet (one of"
            f" {', '.join(config.FACETS)}), and — if it is the SAME subject as an"
            " existing term listed below — that term's slug in"
            " same_as_existing_slug (omit it otherwise).\n"
            f"{LABEL_RULES} Name and organize only; never invent subjects the"
            " snippets do not show.\n\n"
            + "\n\n".join(lines)
            + "\n\nExisting term slugs:\n"
            + ", ".join(existing)
        )
        parsed = _gemini_generate(model, prompt, NAMING_SCHEMA)
        for item in parsed.get("clusters", []):
            cluster = by_id.get(item.get("cluster_id"))
            if cluster is not None:
                _cache_put(cluster["cache_key"], {k: v for k, v in item.items() if k != "cluster_id"})
            apply_decision(item)
    for record in (merged_groups or {}).values():
        merges.append(record)
    print(
        f"  {view}: {named} named · {mapped} mapped to existing · {incoherent} incoherent-dropped",
        flush=True,
    )


def add_cluster_concepts(vocab: Vocab, model: str, merges: list[dict]) -> None:
    keys, matrix = _stratified_sample()
    normalized = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9)
    for k in config.KMEANS_VIEWS:
        view = f"kmeans-{k}"
        print(f"  clustering {len(keys)} vectors ({view}, merge<{config.CLUSTER_MERGE_COSINE})", flush=True)
        labels, centroids, merged_groups = _kmeans_view(normalized, k, view)
        print(f"  {view}: {centroids.shape[0]} clusters after provisional merges", flush=True)
        _name_view(vocab, model, view, keys, normalized, labels, centroids, merges, merged_groups)
    view = "hdbscan"
    print(f"  clustering ({view}, min_cluster_size={config.HDBSCAN_MIN_CLUSTER_SIZE})", flush=True)
    labels, centroids = _hdbscan_view(normalized, view)
    print(f"  {view}: {centroids.shape[0]} dense clusters (noise ignored)", flush=True)
    if centroids.shape[0]:
        _name_view(vocab, model, view, keys, normalized, labels, centroids, merges)


# ── Tree organization (Gemini organizes only) ───────────────────────────────

TREE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "assignments": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "slug": {"type": "STRING"},
                    "parent_slug": {"type": "STRING"},
                },
                "required": ["slug"],
            },
        }
    },
    "required": ["assignments"],
}


def organize_tree(vocab: Vocab, model: str) -> None:
    """Ask Gemini to assign a parent (an existing slug of the SAME facet) to
    each Concept/Practice term — organization only, never new terms. Invalid or
    cyclic assignments are dropped in code."""
    for facet in ("Concept", "Practice"):
        slugs = [s for s, t in vocab.terms.items() if t["facet"] == facet]
        if len(slugs) < 3:
            continue
        catalog = "\n".join(f"{s}: {vocab.terms[s]['term']}" for s in slugs)
        for start in range(0, len(slugs), 150):
            chunk = slugs[start : start + 150]
            prompt = (
                f"Organize these {facet} terms from a Gauḍīya Vaiṣṇava subject"
                " vocabulary into a shallow tree (max 2 levels). For each slug in"
                " the CHUNK list, give parent_slug = the slug of a BROADER term"
                " from the full catalog (same facet), or omit parent_slug for a"
                " top-level term. Only organize — never rename, add, or drop"
                " terms.\n\nFull catalog:\n" + catalog + "\n\nCHUNK:\n" + "\n".join(chunk)
            )
            parsed = _gemini_generate(model, prompt, TREE_SCHEMA)
            for item in parsed.get("assignments", []):
                slug, parent = item.get("slug", ""), (item.get("parent_slug") or "").strip()
                if (
                    slug in vocab.terms
                    and parent
                    and parent in vocab.terms
                    and parent != slug
                    and vocab.terms[parent]["facet"] == facet
                    and vocab.terms[parent].get("parent") != slug  # no 2-cycles
                ):
                    vocab.terms[slug]["parent"] = parent


# ── Scope notes (one line per term; shown at the gate; used in tagging) ─────

SCOPE_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "notes": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "slug": {"type": "STRING"},
                    "scope_note": {"type": "STRING"},
                },
                "required": ["slug", "scope_note"],
            },
        }
    },
    "required": ["notes"],
}


def draft_scope_notes(vocab: Vocab, model: str) -> None:
    """ONE line per term: what it covers + one thing it explicitly excludes
    (e.g. 'surrender — taking shelter of the Lord; not mere resignation').
    Stored on the term; shown at the ⛔ gate; injected into the tagging prompt."""
    pending = [s for s, t in vocab.terms.items() if not t["scope_note"]]
    for attempt in range(2):
        if not pending:
            break
        chunks = [pending[i : i + SCOPE_NOTES_PER_CALL] for i in range(0, len(pending), SCOPE_NOTES_PER_CALL)]
        for chunk in tqdm(chunks, desc=f"  scope notes (pass {attempt + 1})"):
            lines = []
            for slug in chunk:
                t = vocab.terms[slug]
                variants = ", ".join(t["variants"][:4])
                lines.append(f"{slug}: {t['term']} ({t['facet']}{'; variants: ' + variants if variants else ''})")
            prompt = (
                "For EACH term of this Gauḍīya Vaiṣṇava subject vocabulary write"
                " ONE short scope line (≤ 140 characters): what the term covers"
                " PLUS one thing it explicitly does NOT cover, separated by ';"
                " not'. Example: 'surrender — taking shelter of the Lord; not"
                " mere resignation'. Be concrete; never write doctrine, only"
                " indexing scope.\n\nTERMS:\n" + "\n".join(lines)
            )
            parsed = _gemini_generate(model, prompt, SCOPE_SCHEMA)
            for item in parsed.get("notes", []):
                slug = (item.get("slug") or "").strip()
                note = (item.get("scope_note") or "").strip()
                if slug in vocab.terms and note:
                    vocab.terms[slug]["scope_note"] = note[:200]
        pending = [s for s, t in vocab.terms.items() if not t["scope_note"]]
    if pending:
        print(f"  WARNING: {len(pending)} terms still have no scope note (listed in vocabulary.json warnings)", flush=True)


# ── Validation + output + vocab_terms load ──────────────────────────────────

def validate(vocab: Vocab) -> list[str]:
    """Gate warnings (never fatal — the human decides at the ⛔ gate)."""
    warnings: list[str] = []
    for slug, t in sorted(vocab.terms.items()):
        if t["kind"] == "concept":
            folded_label = fold(t["term"])
            has_plain_english = t["term"].isascii() or any(
                v.isascii() and fold(v) != folded_label for v in t["variants"]
            )
            if not has_plain_english:
                warnings.append(f"{slug}: no plain-English variant (label rule: every term carries one)")
        if slugify(t["term"]) in SANSKRIT_STOPWORDS or fold(t["term"]) in SANSKRIT_STOPWORDS:
            warnings.append(f"{slug}: label is a grammatical particle — particles are never terms")
        if not t["scope_note"]:
            warnings.append(f"{slug}: missing scope note")
    return warnings


def write_vocabulary(vocab: Vocab, merges: list[dict], warnings: list[str]) -> None:
    payload = {
        "version": datetime.now(timezone.utc).strftime("%Y-%m-%d.%H%M"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "facets": config.FACETS,
        "sampling": {
            "seed": config.SAMPLE_SEED,
            "cluster_sample": config.CLUSTER_SAMPLE,
            "kmeans_views": config.KMEANS_VIEWS,
            "hdbscan_min_cluster_size": config.HDBSCAN_MIN_CLUSTER_SIZE,
            "stratified": "by table; by book within prose_paragraphs",
        },
        "term_count": len(vocab.terms),
        "concept_count": vocab.concept_count(),
        "entity_count": vocab.entity_count(),
        "terms": sorted(vocab.terms.values(), key=lambda t: (t["facet"], t["slug"])),
        # ⛔ gate: every provisional merge below is a PROPOSAL. Veto = edit this
        # file (rename/split/re-add terms) before pressing Enter at the gate.
        "merges": merges,
        "warnings": warnings,
    }
    with open(config.VOCAB_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(
        f"  wrote {config.VOCAB_PATH} ({payload['concept_count']} concepts +"
        f" {payload['entity_count']} entities · {len(merges)} merge proposals ·"
        f" {len(warnings)} warnings)",
        flush=True,
    )
    print(
        "  Healthy is ~400-700 concepts — but the ⛔ gate decides, not a round number.",
        flush=True,
    )


def load_vocabulary() -> dict:
    if not config.VOCAB_PATH.exists():
        raise SystemExit(f"FATAL: {config.VOCAB_PATH} missing — run the vocabulary step first.")
    with open(config.VOCAB_PATH, encoding="utf-8") as f:
        return json.load(f)


def load_vocab_terms() -> None:
    """Upsert the frozen vocabulary into public.vocab_terms (service key) with
    Voyage embeddings of 'term (variants…)' for the shortlist SQL."""
    vocabulary = load_vocabulary()
    terms = vocabulary["terms"]
    texts = [
        term["term"] + (f" ({', '.join(term['variants'][:6])})" if term["variants"] else "")
        for term in terms
    ]
    print(f"  embedding {len(texts)} vocab terms via Voyage", flush=True)
    vectors = voyage_client.embed_terms(texts)
    supabase = db.get_supabase()
    for start in tqdm(range(0, len(terms), 200), desc="  upserting vocab_terms"):
        chunk = []
        for term, vector in zip(terms[start : start + 200], vectors[start : start + 200]):
            chunk.append(
                {
                    "term": term["term"],
                    "slug": term["slug"],
                    "facet": term["facet"],
                    "parent": term["parent"],
                    "variants": term["variants"],
                    "is_ai": False,
                    "embedding": vector,
                }
            )
        db.with_retry(
            lambda chunk=chunk: supabase.table("vocab_terms").upsert(chunk, on_conflict="slug").execute(),
            "vocab_terms upsert",
        )
    print("  vocab_terms loaded.", flush=True)


def vocab_terms_ready(expected: int | None = None) -> bool:
    try:
        count = db.table_count("vocab_terms", "embedding IS NOT NULL")
    except Exception:
        return False
    if expected is None:
        return count > 0
    return count >= expected


def run(model: str) -> None:
    if config.VOCAB_PATH.exists():
        print(f"  {config.VOCAB_PATH} already exists — keeping it (delete to rebuild).", flush=True)
    else:
        vocab = Vocab()
        merges: list[dict] = []
        add_seeds(vocab)
        candidates = chapter_title_candidates() + sanskrit_gloss_candidates()
        review_candidates(vocab, model, candidates, merges)
        add_cluster_concepts(vocab, model, merges)
        organize_tree(vocab, model)
        draft_scope_notes(vocab, model)
        warnings = validate(vocab)
        write_vocabulary(vocab, merges, warnings)
    expected = load_vocabulary()["term_count"]
    if not vocab_terms_ready(expected):
        load_vocab_terms()
    else:
        print("  vocab_terms already loaded.", flush=True)


def main() -> int:
    config.require_keys()
    model = gemini_client.confirm_model()
    run(model)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
