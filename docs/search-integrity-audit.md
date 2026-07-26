# Search integrity audit — 26 July 2026

Findings behind the Phase A restore. Every fact below was verified against the
live Supabase project `wzktlpjtqmjxvragwhqg`, not inherited from a prior report.

## Summary

Search was completely non-functional in production and the application reported
success. Two independent defects combined:

1. **All 18 search RPCs the application calls had been dropped** from the
   database.
2. **The route could not tell a dropped function from an empty result**, so the
   failure was served as HTTP 200 with zero passages and `validated: true`.

## 1. What was missing

The application calls 23 distinct RPCs. Five survived; eighteen were gone.

Survived: `suggest_spelling`, `get_verse_context`, `log_search`,
`log_search_feedback`, `log_search_behavior`.

Missing: `direct_verse_lookup`; `search_verses_fulltext`,
`search_verses_fulltext_v2`, `search_prose_fulltext`, `search_prose_fulltext_v2`,
`search_transcript_paragraphs_fulltext`, `search_letter_paragraphs_fulltext`,
`search_verse_chunks_fulltext`; `search_verses_semantic_v2`,
`search_prose_semantic_v2`, `search_verse_chunks_semantic`,
`search_transcript_paragraphs_semantic`, `search_letter_paragraphs_semantic`;
and the five `*_by_tags` functions.

Verified with the manifest query now shipped as `search_rpc_contract_v1()`:
18 rows `present = false`, 5 rows `present = true`.

## 2. Why the failure was invisible

`app/api/search/route.ts` made ~37 `.rpc()` calls. Exactly one — `log_search` —
checked `.error`.

`supabase-js` **resolves** rather than rejects when Postgres returns an error.
So `{ data: null, error }` became `.data || []`:

```
PostgREST error PGRST202  ->  data: null  ->  data || []  ->  []
                          ->  totalResults: 0, HTTP 200, validated: true
```

The `try/catch` fallback chain in `hybridSearch` was therefore never entered —
nothing threw. The v1 and `ilike` fallbacks had been dead code for the entire
outage.

## 3. Why a verbatim restore was impossible

The repository contains **no `CREATE FUNCTION` for any search RPC**.
`supabase/migrations/` held four files; the live history holds 57.

The historical DDL is recoverable from
`supabase_migrations.schema_migrations.statements`, and the authoritative
last-writer per family is:

| Family | Migration |
|---|---|
| full-text | `20260331112116_fix_all_fulltext_search_functions_english_unaccent` |
| semantic | `20260330151807_add_hnsw_ef_search_to_semantic_functions` |
| verse chunks | `20260331220334_drop_and_recreate_verse_chunks_search` |
| verses/prose by_tags | `20260325223207_create_tag_search_functions_and_indexes` |
| transcript/letter by_tags | `20260327233210_create_transcript_letter_search_rpcs` |
| direct lookup | `20260331221727_fix_direct_verse_lookup_range_match` |

But those bodies reference `fts`, `tags` and `embedding` — **columns that no
longer exist**. A v3 cutover replaced them, and the five corpus tables now carry
only `embedding_context4`, `fts_core`, `fts_expansion`, `fts_expansion_src`,
`tags_core`. Replaying the history verbatim would not compile.

So signatures and return shapes were preserved exactly and the bodies were
rewritten. Three deviations were unavoidable or deliberate:

**Semantic ordering had to change operator.** The historical bodies ordered by
`<=>` (cosine). The live indexes are `hnsw (embedding_context4 vector_ip_ops)`,
which `<=>` cannot use — a verbatim replay would have silently degraded every
semantic lane to a sequential scan over up to 144,438 rows. The restored
functions order by `<#>`. Measured: stored vectors are unit-norm
(L2 = 1.0000000), so `-(a <#> b)` equals cosine exactly and the historical
`match_threshold` defaults keep their meaning.

```
Index Scan using idx_verses_ctx4_hnsw on verses v
  Order By: (embedding_context4 <#> ...)
Execution Time: 6.289 ms      (with the chapters join and 0.3 threshold)
```

**Full-text matches `fts_core` only.** `fts_expansion` is populated and useful,
but weighting it changes retrieval behaviour and belongs in a benchmarked PR.

**Tag lanes take canonical slugs only, and are disabled at the call site.**
See below.

## 4. The tag lane is broken twice over

`tags_core` holds controlled-vocabulary slugs (`goloka-vrndavana`, `krsna`),
while the route splits queries into single words of length > 3.

- **143 of the 251** vocabulary terms are multiword, so most of the vocabulary
  is unreachable from single-word input. (62 of those carry a single-word
  variant, so the reachable set is not zero — but it is a minority.)
- **Frequency makes the signal nearly meaningless.** `krsna` tags **60,958 of
  144,438** transcript paragraphs (42%); `srila-prabhupada` tags 64,513.
- **Cost.** Measured on production: the legacy *unranked* shape returns in 3 ms
  but with no `ORDER BY` at all, so the rows are arbitrary. Ranking by tag
  overlap — which is what makes the lane meaningful — scans **66,461 rows in
  1,253 ms**. A broad query fires up to **45 tag RPCs** (5 original + 4 × 10
  variants).

The five functions are restored so the contract is whole and testable, and the
application call sites are disabled behind `TAG_LANES_ENABLED = false`, reported
to clients in `disabledLanes`. PR B owns phrase-preserving, ambiguity-aware,
batched resolution before they are called again.

A related stale assumption is recorded but not changed: `scoreTagRelevance`
(`app/api/search/route.ts`) still documents the pre-cutover tag format
(free-text topics, `SUMMARY:` prefixes, questions ending in `?`) while it now
scores slugs. It degrades quietly rather than erroring. PR B retires it.

## 5. Migration history has drifted, and branches cannot verify this schema

- Repo file `20260705150500_…` was applied as version `20260705150641`; repo
  `20260705152000_…` as `20260705151533`.
- Repo file `20260708120000_tags_fts_rebuild_columns_and_fts_core.sql` is **not
  in the live history at all**, though its columns and tables exist.
- Of the 57 recorded migrations, **zero** mention `tags_core`, `fts_core` or
  `embedding_context4`, and **zero** create `vocab_terms`.

Consequence: **a Supabase branch reproduces the pre-cutover schema, not
production.** The restored bodies would not compile there (no `fts_core`), and
the "assert 18 absent" precondition would fail because the branch would *have*
them. Replaying the repo's four migrations instead fails immediately, since they
`ALTER` tables never created in-repo.

Phase A therefore verifies contract and behaviour separately (see below).
Committing a production-captured baseline schema — so the repo is again the
source of truth and branches become usable — is the real remedy and is raised as
its own workstream. It is the root cause of this incident: functions were
dropped and nothing in the repository could restore them.

## 6. Corpus and index state (healthy)

| Table | Rows | `embedding_context4` | `fts_core` | `fts_expansion` | `tags_core` |
|---|---|---|---|---|---|
| verses | 25,131 | 100% | 100% | 100% | 100% |
| verse_chunks | 18,699 | 100% | 100% | 100% | 100% |
| prose_paragraphs | 36,412 | 100% | 100% | 100% | 100% |
| transcript_paragraphs | 144,438 | 100% | 100% | 100% | 100% |
| letter_paragraphs | 19,468 | 100% | 100% | 100% | 100% |

All five have `hnsw (embedding_context4 vector_ip_ops) m=32, ef_construction=256`
plus GIN on `fts_core`, `fts_expansion` and `tags_core`. Text search config is
`public.english_unaccent`. `vocab_terms` holds 251 terms, all with 1024-dim
embeddings, 232 with variants, across facets Concept/Person/Place/Practice/
Scripture. Every column needed to reproduce the historical return shapes
survives; `chapters` still supplies `chapter_number`, `canto_or_division`,
`chapter_title` and `book_slug`.

## 7. Verification performed

**Behaviour, read-only against production at real scale.** Each restored body
was executed as its equivalent inline `SELECT` / `EXPLAIN (ANALYZE, BUFFERS)`.
This is what caught the cosine-vs-inner-product defect and the tag-ranking cost.

- verses full-text: `Bitmap Index Scan on idx_verses_fts_core_gin`, 569 rows matched
- verses semantic + chapters join + threshold: `Index Scan using idx_verses_ctx4_hnsw`, 6.289 ms
- prose / transcripts / letters / chunks full-text: full result sets returned
- tag body: resolves `krsna` and `devotional-service`, discards `not-a-real-slug`

**Application boundary, in vitest.** `tests/rpc-strict-errors.test.ts` — 18
cases covering missing functions (PGRST202), timeouts, permission denial,
network rejection, genuine empties, degradation recording, redaction and status
mapping. Suite: 45 tests passing.

**Contract, at apply time.** `npm run verify:contract` against a real database.
Hard-fails without credentials by design.

## 8. Advisor baseline

Pre-existing, recorded before the change:

| Finding | Level | Disposition |
|---|---|---|
| `log_search` SECURITY DEFINER executable by `anon`/`authenticated` (0028/0029) | WARN | **Fixed** in this migration — converted to `SECURITY INVOKER`, `service_role` only. `service_role` verified `rolbypassrls = true` with full DML on `search_logs` and `popular_queries`. |
| `verse_refs` is a SECURITY DEFINER view (0010) | ERROR | Pre-existing. Needs an owner; not touched by this hotfix. |
| `citation_clicks` / `feedback` permissive anon INSERT (0024) | WARN | Pre-existing and intentional (public feedback). Re-confirm before rollout. |
| `unaccent`, `pg_prewarm` installed in `public` (0014) | WARN | Pre-existing. Moving them would break the pinned `public.english_unaccent` reference; defer. |
| RLS enabled, no policies: `search_logs`, `popular_queries`, `vocab_terms` | INFO | Intentional — server-only tables reached via `service_role`. |
| PostgreSQL `supabase-postgres-17.4.1.074` has security patches available | WARN | Pre-existing. Schedule an upgrade window. |

## 9. Rollback

Application-first: promote the preceding Vercel deployment. The restored
functions stay — they are additive, and the preceding application expects them
too. Any database correction is a new forward migration. Rollback must never
drop corpus data, embeddings, tags, indexes or migration history.
