"""
voyage_client.py — Voyage AI embeddings for vocabulary terms.

Mirrors app/lib/03-embed.ts: the contextualized-embeddings endpoint,
voyage-context-4, 1024-dim, one document per input with one chunk each.
Vocabulary terms are embedded with input_type="query" because they are matched
AGAINST the stored passage vectors (embedding_context4, embedded as documents)
when building each passage's candidate shortlist.
"""
from __future__ import annotations

import requests

import config
import db

EXPECTED_DIMS = 1024
TIMEOUT = 120


def embed_terms(texts: list[str]) -> list[list[float]]:
    """Embed term strings (batched). Returns one 1024-dim vector per input, in
    order. Raises loudly on any failure or dim mismatch — vocabulary embeddings
    feed every shortlist, so a silent partial result would poison the run."""
    if not texts:
        return []
    if not config.VOYAGE_API_KEY:
        raise SystemExit("FATAL: VOYAGE_API_KEY missing — see `python run_all.py --doctor`.")

    out: list[list[float]] = []
    for start in range(0, len(texts), config.VOYAGE_EMBED_BATCH):
        batch = texts[start : start + config.VOYAGE_EMBED_BATCH]

        def _call(batch=batch):
            res = requests.post(
                config.VOYAGE_URL,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {config.VOYAGE_API_KEY}",
                },
                json={
                    "inputs": [[t] for t in batch],  # one document per term, one chunk each
                    "model": config.VOYAGE_MODEL,
                    "input_type": "query",
                    "output_dimension": EXPECTED_DIMS,
                    "output_dtype": "float",
                },
                timeout=TIMEOUT,
            )
            if not res.ok:
                raise RuntimeError(f"Voyage HTTP {res.status_code}: {res.text[:500]}")
            return res.json()

        data = db.with_retry(_call, "voyage embed batch")
        by_index: dict[int, list[float]] = {}
        for i, entry in enumerate(data.get("data") or []):
            idx = entry.get("index", i)
            by_index[idx] = ((entry.get("data") or [{}])[0]).get("embedding") or []
        for i in range(len(batch)):
            vec = by_index.get(i, [])
            if len(vec) != EXPECTED_DIMS:
                raise SystemExit(
                    f"FATAL: Voyage returned {len(vec)} dims for input {start + i}"
                    f" (expected {EXPECTED_DIMS}) — refusing a poisoned vocabulary."
                )
            out.append(vec)
    return out
