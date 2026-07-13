"""
build_vocabulary.py — build the closed, faceted controlled vocabulary
(vocabulary.json) and load it into vocab_terms. Step 2 of run_all.py; also
runnable standalone: `python build_vocabulary.py`.

Facets: Concept / Sanskrit / Person / Place / Scripture / Practice.

Sources, in order:
  1. Curated seeds (vocabulary_seeds.json — established Gauḍīya/Vedabase
     subject structure, committed to the repo).
  2. Chapter titles (chapters.chapter_title) → Concept candidates.
  3. Clustering of existing embedding_context4 vectors (stratified sample →
     MiniBatchKMeans → cosine merge) → Concept candidates. Gemini NAMES the
     clusters and ORGANIZES the tree only — it never invents standalone terms.
  4. Recurring Sanskrit glossary terms mined from verses.synonyms glosses →
     Sanskrit candidates, with spelling variants from transliteration_synonyms
     plus automatic diacritic folding.

Every term carries spelling variants. Output: vocabulary.json (the ⛔ review
gate artifact) with {term, slug, facet, parent, variants, sources}. Then
load_vocab_terms() upserts the frozen list into public.vocab_terms (service
key) with Voyage embeddings for the per-passage shortlists.
"""
from __future__ import annotations

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
CLUSTERS_PER_CALL = 40
# Sanskrit particles/inflection words that recur constantly in glosses but make
# useless tags (the recurrence floor alone would let them in).
SANSKRIT_STOPWORDS = {
    "ca", "eva", "na", "hi", "tu", "api", "iti", "vai", "atha", "tat", "tam",
    "sa", "te", "me", "mama", "asya", "tasya", "yat", "etat", "idam", "kim",
    "uvaca", "uvāca", "aham", "tvam", "sarva", "sarvam",
}


def fold(text: str) -> str:
    """Lenient diacritic fold shared by slugs and variant generation."""
    decomposed = unicodedata.normalize("NFD", text or "")
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch)).lower().strip()


def slugify(term: str) -> str:
    folded = fold(term)
    return stdre.sub(r"-{2,}", "-", stdre.sub(r"[^a-z0-9]+", "-", folded)).strip("-")


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
                "parent": parent,
                "variants": [],
                "sources": [],
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


# ── Source 1: curated seeds ─────────────────────────────────────────────────

def add_seeds(vocab: Vocab) -> None:
    with open(config.SEEDS_PATH, encoding="utf-8") as f:
        seeds = json.load(f)
    for facet, entries in seeds["facets"].items():
        if facet not in config.FACETS:
            raise SystemExit(f"FATAL: vocabulary_seeds.json has unknown facet '{facet}'")
        for entry in entries:
            vocab.add(entry["term"], facet, entry.get("variants", []), "seed")


# ── Source 2: chapter titles ────────────────────────────────────────────────

def add_chapter_titles(vocab: Vocab) -> None:
    titles = db.rows(
        "SELECT DISTINCT chapter_title FROM public.chapters"
        " WHERE chapter_title IS NOT NULL AND length(chapter_title) BETWEEN 4 AND 80"
        " ORDER BY chapter_title LIMIT %s",
        (CHAPTER_TITLE_MAX,),
    )
    for (title,) in titles:
        cleaned = stdre.sub(r"^\s*(chapter\s+)?\d+[.:\s-]*", "", title, flags=stdre.I).strip()
        if len(cleaned) >= 4 and not cleaned.isdigit():
            vocab.add(cleaned, "Concept", [], "chapter_title")


# ── Source 4: Sanskrit terms from synonyms glosses ──────────────────────────

def add_sanskrit_terms(vocab: Vocab) -> None:
    """verses.synonyms holds word-for-word glosses: 'term — gloss; term — gloss'.
    Recurring terms (freq ≥ SANSKRIT_MIN_FREQ, not particles) become the
    Sanskrit facet; the diacritic original is the display term and folded/known
    alternates are variants."""
    counts: Counter[str] = Counter()
    display: dict[str, str] = {}
    for (synonyms,) in db.iter_rows(
        "SELECT synonyms FROM public.verses WHERE synonyms IS NOT NULL"
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
            display.setdefault(base, head)

    translit = defaultdict(list)
    for variant, canonical, display_name in db.rows(
        "SELECT variant, canonical, display_name FROM public.transliteration_synonyms"
    ):
        translit[fold(canonical)].extend(x for x in (variant, display_name) if x)

    for base, freq in counts.most_common(config.SANSKRIT_MAX_TERMS):
        if freq < config.SANSKRIT_MIN_FREQ:
            break
        vocab.add(display[base], "Sanskrit", translit.get(base, []), "synonyms_gloss")


# ── Source 3: embedding clusters, named by Gemini ───────────────────────────

def _parse_vector(text: str) -> np.ndarray:
    # pgvector's text form "[0.1,0.2,...]" is valid JSON
    return np.asarray(json.loads(text), dtype=np.float32)


def _stratified_sample() -> tuple[list[tuple[str, str]], np.ndarray]:
    """Proportional sample of (table, id) + vectors across the five tables."""
    live = {t: db.table_count(t, "embedding_context4 IS NOT NULL") for t in config.CONTENT_TABLES}
    total = sum(live.values()) or 1
    keys: list[tuple[str, str]] = []
    vectors: list[np.ndarray] = []
    for table, count in live.items():
        want = min(count, round(config.CLUSTER_SAMPLE * count / total))
        if want == 0:
            continue
        print(f"  sampling {want} vectors from {table}", flush=True)
        got = 0
        for row_id, vec_text in db.iter_rows(
            f"SELECT id::text, embedding_context4::text FROM public.{table}"
            " WHERE embedding_context4 IS NOT NULL ORDER BY id LIMIT %s",
            (want,),
        ):
            vec = _parse_vector(vec_text)
            if vec.size != 1024:
                continue
            keys.append((table, row_id))
            vectors.append(vec)
            got += 1
        print(f"  {table}: {got} vectors", flush=True)
    return keys, np.vstack(vectors)


def _cluster(matrix: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """MiniBatchKMeans over-clustering, then cosine merge of near-duplicate
    centroids. Returns (final_labels_per_row, final_centroids)."""
    from sklearn.cluster import AgglomerativeClustering, MiniBatchKMeans

    normalized = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9)
    k = min(config.KMEANS_K, len(normalized))
    km = MiniBatchKMeans(n_clusters=k, random_state=42, batch_size=4096, n_init=3)
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
    for group in range(n_groups):
        members = centroids[group_of == group]
        merged[group] = members.mean(axis=0)
    return final_labels, merged


def _snippets_for(keys: list[tuple[str, str]]) -> list[str]:
    """Short text snippets for representative passages (verses → translation,
    everything else → body_text)."""
    out = []
    for table, row_id in keys:
        column = "translation" if table == "verses" else "body_text"
        text = db.one(f"SELECT left(coalesce({column}, ''), 240) FROM public.{table} WHERE id = %s", (row_id,))
        out.append((text or "").replace("\n", " ").strip())
    return out


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
            raise RuntimeError(f"Gemini HTTP {res.status_code}: {res.text[:500]}")
        return res.json()

    data = db.with_retry(_call, "gemini naming call")
    text = (((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or [{}])[0].get("text", "")
    return json.loads(text)


NAMING_SCHEMA = {
    "type": "OBJECT",
    "properties": {
        "clusters": {
            "type": "ARRAY",
            "items": {
                "type": "OBJECT",
                "properties": {
                    "cluster_id": {"type": "INTEGER"},
                    "name": {"type": "STRING"},
                    "facet": {"type": "STRING", "enum": config.FACETS},
                    "same_as_existing_slug": {"type": "STRING"},
                },
                "required": ["cluster_id", "name", "facet"],
            },
        }
    },
    "required": ["clusters"],
}


def add_cluster_concepts(vocab: Vocab, model: str) -> None:
    keys, matrix = _stratified_sample()
    print(f"  clustering {len(keys)} vectors (k={config.KMEANS_K}, merge<{config.CLUSTER_MERGE_COSINE})", flush=True)
    labels, centroids = _cluster(matrix)
    print(f"  {centroids.shape[0]} merged clusters", flush=True)

    normalized = matrix / (np.linalg.norm(matrix, axis=1, keepdims=True) + 1e-9)
    clusters = []
    for group in range(centroids.shape[0]):
        member_idx = np.where(labels == group)[0]
        if member_idx.size < 5:  # tiny clusters are noise, not concepts
            continue
        sims = normalized[member_idx] @ centroids[group]
        reps = member_idx[np.argsort(-sims)[:3]]
        clusters.append({"id": group, "size": int(member_idx.size), "reps": [keys[i] for i in reps]})

    existing = sorted(vocab.terms)
    for start in tqdm(range(0, len(clusters), CLUSTERS_PER_CALL), desc="  gemini naming"):
        chunk = clusters[start : start + CLUSTERS_PER_CALL]
        lines = []
        for cluster in chunk:
            snippets = _snippets_for(cluster["reps"])
            lines.append(
                f"cluster_id={cluster['id']} (≈{cluster['size']} passages):\n  - "
                + "\n  - ".join(snippets)
            )
        prompt = (
            "You are organizing a closed subject vocabulary for Śrīla Prabhupāda's"
            " books, lectures and letters (Gauḍīya Vaiṣṇava corpus). Below are"
            " embedding clusters, each shown as representative passage snippets.\n"
            "For EACH cluster return a short subject name (2-5 words, the kind of"
            " heading Vedabase or a Gītā index would use), the facet it belongs to"
            f" (one of {', '.join(config.FACETS)}), and — if the cluster is the SAME"
            " subject as one of the existing terms listed after the clusters — that"
            " term's slug in same_as_existing_slug (else omit it). Name and organize"
            " only; do not invent subjects the snippets do not show.\n\n"
            + "\n\n".join(lines)
            + "\n\nExisting term slugs:\n"
            + ", ".join(existing)
        )
        parsed = _gemini_generate(model, prompt, NAMING_SCHEMA)
        for item in parsed.get("clusters", []):
            same = (item.get("same_as_existing_slug") or "").strip()
            if same and same in vocab.terms:
                if "cluster" not in vocab.terms[same]["sources"]:
                    vocab.terms[same]["sources"].append("cluster")
                continue
            name = (item.get("name") or "").strip()
            facet = item.get("facet", "Concept")
            if name and facet in config.FACETS:
                vocab.add(name, facet, [], "cluster")


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


# ── Output + vocab_terms load ───────────────────────────────────────────────

def write_vocabulary(vocab: Vocab) -> None:
    payload = {
        "version": datetime.now(timezone.utc).strftime("%Y-%m-%d.%H%M"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "facets": config.FACETS,
        "term_count": len(vocab.terms),
        "terms": sorted(vocab.terms.values(), key=lambda t: (t["facet"], t["slug"])),
    }
    with open(config.VOCAB_PATH, "w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    print(f"  wrote {config.VOCAB_PATH} ({len(vocab.terms)} terms)", flush=True)


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
        add_seeds(vocab)
        add_chapter_titles(vocab)
        add_sanskrit_terms(vocab)
        add_cluster_concepts(vocab, model)
        organize_tree(vocab, model)
        write_vocabulary(vocab)
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
