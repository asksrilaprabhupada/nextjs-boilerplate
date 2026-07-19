"""
routing.py — core/standard model routing for v3.p3-hybrid.

The SINGLE source of truth for which passage goes to which Gemini model:

  core     — verses and verse_chunks whose book is Bhagavad-gītā (bg),
             Śrīmad-Bhāgavatam (sb) or Caitanya-caritāmṛta (cc)
             → config.MODEL_CORE (full Gemini 3.5 Flash).
  standard — every other eligible passage (all prose/transcript/letter rows and
             the few non-core verses/chunks) → config.MODEL_STANDARD.

The book slug is exactly what load_passages/provenance already use:
`lower(coalesce(chapters.book_slug, verses.scripture))`, resolved through the
parent verse for verse_chunks — routing and provenance always see the same slug.
Pure functions + SQL fragments only; no DB access here, so every rule is
offline-testable.
"""
from __future__ import annotations

import config

CORE_BOOK_SLUGS = frozenset({"bg", "sb", "cc"})
ROUTED_TABLES = frozenset({"verses", "verse_chunks"})
ROUTES = ("core", "standard")


def route_for(table: str, book_slug: str | None) -> str:
    """'core' when the table is book-routed AND the folded slug is a core book;
    'standard' otherwise (including NULL/empty/unknown slugs — never assume)."""
    if table in ROUTED_TABLES and (book_slug or "").strip().lower() in CORE_BOOK_SLUGS:
        return "core"
    return "standard"


def model_for_route(route: str) -> str:
    if route == "core":
        return config.MODEL_CORE
    if route == "standard":
        return config.MODEL_STANDARD
    raise SystemExit(f"FATAL: unknown route {route!r} (expected one of {ROUTES})")


def route_for_model(model: str) -> str:
    """Inverse of model_for_route for reporting. When MODEL_CORE == MODEL_STANDARD
    (env override) everything is reported as 'core' — routing degenerates safely."""
    return "core" if model == config.MODEL_CORE else "standard"


def _route_case(slug_expr: str) -> str:
    slugs = ", ".join(f"'{s}'" for s in sorted(CORE_BOOK_SLUGS))
    return f"CASE WHEN lower({slug_expr}) IN ({slugs}) THEN 'core' ELSE 'standard' END"


def route_sql(table: str, alias: str = "t") -> tuple[str, str]:
    """(join_clause, route_expr) for planning queries, so shards are route-split
    in SQL with the exact slug expressions load_passages uses (tagging.py)."""
    if table == "verses":
        return (
            f" LEFT JOIN public.chapters rc ON rc.id = {alias}.chapter_id",
            _route_case(f"coalesce(rc.book_slug, {alias}.scripture)"),
        )
    if table == "verse_chunks":
        return (
            f" JOIN public.verses rv ON rv.id = {alias}.verse_id"
            f" LEFT JOIN public.chapters rc ON rc.id = rv.chapter_id",
            _route_case("coalesce(rc.book_slug, rv.scripture)"),
        )
    return ("", "'standard'")
