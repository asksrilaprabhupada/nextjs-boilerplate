# Phase B (part 1) — Retrieval and ranking V2

**Commit:** `1a2913b` · **PR:** [#120](https://github.com/asksrilaprabhupada/nextjs-boilerplate/pull/120)
**Flag state:** `DEEP_RESEARCH_V2_ENABLED` defaults **false**. V2 is not serving. See "Not done".

---

## What changed

### Database (applied and verified against production)

| Function | Purpose |
|---|---|
| `search_verses_hybrid_batch_v2` | batched hybrid retrieval over `verses` |
| `search_verse_chunks_hybrid_batch_v2` | over `verse_chunks` (purports) |
| `search_prose_hybrid_batch_v2` | over `prose_paragraphs` |
| `search_transcripts_hybrid_batch_v2` | over `transcript_paragraphs` |
| `search_letters_hybrid_batch_v2` | over `letter_paragraphs` |
| `resolve_vocabulary_terms_v1` | controlled-vocabulary resolution |

Each batch function takes the original query **and every approved subquery in one call**, runs semantic (`<#>`), `fts_core`, `fts_expansion`, caller phrases and controlled tags internally, and returns per-query-per-channel ranks. Fusion happens once, in the application.

**~135 RPCs → 5.**

The five are generated from a single template inside one PL/pgSQL block. Two reasons, both load-bearing:

1. `PERFORM '[1]'::extensions.vector` must run in the *same session* before any `CREATE` carrying `SET hnsw.ef_search`. Until pgvector's library loads that parameter is a GUC placeholder, and Supabase's non-superuser `postgres` gets `ERROR 42501`. This bit during the first apply attempt.
2. Five hand-copied 200-line bodies drift one edit at a time; one template cannot.

### Application (`app/lib/search-v2/`)

`config.ts`, `intent.ts`, `query-plan.ts`, `fusion.ts`, `dedup.ts`, `select.ts` — see PR #120 for the per-module detail.

## Verification

| Check | Result |
|---|---|
| All six functions present, `ef_search` pinned on the five | yes |
| service-role executable, no anon/authenticated grant | yes |
| Vocabulary: `chanting hare krsna` → `chanting-hare-krsna` | variant, 0.94 |
| Vocabulary: `bhakti-yoga` → `devotional-service` | variant, 0.94 |
| Vocabulary: `not-a-real-concept-xyz` | resolves to nothing |
| Multi-query batch on "control my restless mind" | BG 6.5, 6.6, 6.26, 6.34, 6.35 |
| All five channels firing in one call | `semantic, fts_core, fts_expansion, lexical, controlled_tags` |
| Scripture constraint (`BG` only) respected | yes |
| Unit tests | 82 pass (45 existing + 37 new) |
| lint / typecheck / build | 0 errors / clean / succeeds |

## Latency

`EXPLAIN ANALYZE`, `transcript_paragraphs` (144,438 rows), 3 queries × 5 channels:

```
Function Scan on search_transcripts_hybrid_batch_v2 (actual rows=60 loops=1)
Execution Time: 678.818 ms
```

Retrieval stage run concurrently across five tables: **~0.7 s**.
Baseline: ~135 cross-ocean RPCs, logged **14.4 s** (no variants) / **24.7 s** (ten variants).

End-to-end p50/p95 remains **unmeasured** — see Phase A report's verification gap.

## Three defects the new tests caught

1. `"who was X"` routed as narrative (3 subqueries); the brief caps person questions at 2. It is an identity question, not an event.
2. Subquery near-duplicate detection compared raw tokens — `"by practice"` vs `"through practice"` scored 0.71 and passed. Now compares content words (1.0).
3. The selection band minimum could drag in a far weaker passage to fill a slot. A relative-score floor now applies unless the candidate covers an otherwise-unanswered angle.

## Not done — Phase B is incomplete

- **B4** embedding cache keyed by model + normalised text hash
- **B8** unified Cohere rerank against the original question (YAML document serialisation, degraded marking on failure)
- Retrieval client wrapping the five RPCs, run concurrently through `rpcOrThrow`
- Pipeline orchestrator and `/api/search` wiring behind the flag
- **B3 client half**: the app-side tag scorer still assumes `SUMMARY:` prefixes and `?`-suffixed question tags while `tags_core` holds plain slugs. Its `_tagScore >= 0.08` filter on the verse and prose lanes may be actively discarding good results.
- Deletion of the two legacy expansion paths (`16-multi-query.ts`, `07-query-preprocessor.ts`) — they remain wired into the live route until the V2 orchestrator replaces them.

Phases C and D are not started.

## Deviations

1. **Flag left OFF, against the brief's "ship with the flag ON".** The flag currently has nothing to switch to: the orchestrator is unwritten. Shipping it on would advertise a pipeline that is not serving, which is the same class of dishonesty as the outage this work is repairing.
2. **Migration applied as a template-driven `DO` block** rather than five literal `CREATE` statements, for the `ef_search` and drift reasons above. The committed file is exactly what was executed; `pg_get_functiondef` output is recorded in `supabase_migrations.schema_migrations`.

## Remaining risks

- Nothing in either phase has been executed end-to-end. The sandbox network policy blocks the Vercel host, Supabase HTTP, Voyage and Cohere.
- Fusion weights, `rrfK`, the 0.95 duplicate threshold and the 0.25 selection floor are **benchmark candidates, not findings**. Phase D's gold set decides them.
- Supabase compute remains on **LARGE (~$110/month)** — a downgrade candidate, unchanged.
