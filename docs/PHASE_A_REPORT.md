# Phase A — Restore search, move the region

**Commit(s):** `f82d744` → merged to `main` as `d3fe0cb`
**PR:** [#119](https://github.com/asksrilaprabhupada/nextjs-boilerplate/pull/119)
**Deployed:** merged to `main` at 2026-07-26T18:17:29Z. **Region not independently confirmed — see "Verification gap" below.**

---

## The finding that changed the plan

The restore migration `20260726120000_restore_search_functions_v3_columns.sql` was committed and merged to `main` in a previous session, but **it had never reached the database.**

```
SELECT proname FROM pg_proc JOIN pg_namespace ON ... WHERE nspname='public'
  → no search_* functions
  → no direct_verse_lookup
  → no search_rpc_contract_v1
```

Search was still returning "no passages found" for every query. This is precisely the `apply_migration` silent-failure trap the brief documents: the file existed, the PR was green, the migration had never run.

## What changed

### Database

Applied via `execute_sql` after a full rehearsal in a throwaway `search_rehearsal` schema (A1), which was then dropped.

- **18 search RPCs + `search_rpc_contract_v1`** created in `public`, reimplemented on the v3 columns (`fts_core` / `embedding_context4` / `tags_core`) with the exact legacy signatures, defaults, return columns and aliases the route expects.
- **Semantic lanes use `<#>`**, not `<=>`. The indexes are `vector_ip_ops`; cosine would have bypassed them entirely.
- **`log_search` → `SECURITY INVOKER`.** `EXECUTE` revoked from `PUBLIC`/`anon`/`authenticated` and granted to `service_role` across all 23 RPCs. Postgres grants `EXECUTE` to `PUBLIC` by default and the five functions that survived the outage still carried it.
- **`suggest_spelling` repaired.** Confirmed live it was raising `42883: function similarity(text, text) does not exist` on *every* call — `pg_trgm` lives in `extensions`, unreachable from its pinned `search_path`. Now schema-qualified and working.
- **Migration recorded** in `supabase_migrations.schema_migrations` with the live `pg_get_functiondef` output (20 statements), so this drift is visible to `list_migrations` and recoverable.

No table, column, index, corpus or HNSW changes. No `DROP ... CASCADE` in `public`.

### Code

- `vercel.json` — `regions: ["bom1"]`, `fluid: true`. Previously `iad1` (Washington), an ocean from Mumbai.
- `npm run lint` added (eslint 9 flat config) and wired into CI ahead of typecheck. `eslint-config-next` 16 ships native flat configs; the `FlatCompat` shim cannot serialise their plugin graph and dies with a circular-structure error.
- Every lint **error** in the code this phase owns is fixed: removed `any` casts in the search route and Cohere client, typed `direct_verse_lookup`'s row shape and the dynamic PostgREST builder, `prefer-const`, `declare const`.

## Verification

| Command | Result |
|---|---|
| `search_rpc_contract_v1()` | **23/23 compatible** |
| Preconditions (v3 columns, pgvector, `vector_ip_ops`, `english_unaccent`, 10 indexes) | all present |
| `vector_norm(embedding_context4)` × 5 tables | **1.0000000** (min 0.9999999, max 1.0000001) |
| Rehearsal contract (18 fns) | 0 missing, 0 security-definer, 0 unpinned `search_path`, 0 unpinned `ef_search`, 0 over-granted |
| `EXPLAIN ANALYZE` semantic lane | `Index Scan using idx_transcript_paragraphs_ctx4_hnsw` |
| `suggest_spelling` before → after | `42883` error → corrects "bhagvad" → "bhagavad" |
| CI (lint / typecheck / tests / build) | all success |

### Smoke queries (against production data)

| # | Query | Rows | Evidence |
|---|---|---|---|
| 1 | Exact reference `BG 18.66` | 1 | `https://vedabase.io/en/library/bg/18/66/` — "Abandon all varieties of religion and just surrender unto Me…" |
| 2 | Exact quotation (verses FTS) | 10 | BG 18.66 top hit, correct Vedabase URL |
| 3 | Broad concept (verses semantic) | 30 | self-similarity exactly `1.000000`; confirms `-(a <#> b)` == cosine |
| 4 | Lecture-specific (transcript FTS / semantic) | 20 / 20 | real transcript paragraphs |
| 5 | Letter-specific (letter FTS / semantic) | 20 / 20 | real letter paragraphs |

The transcript and letter **semantic** lanes — the two the migration author suspected had been silently dead before the outage (declared `STABLE` with a body-level `SET LOCAL`, which SPI rejects) — both return rows under the function-level `SET` clause.

## Latency

**Database layer, measured** (single warm run, all six lanes sequentially):

| Lane | ms |
|---|---|
| `direct_verse_lookup` | 0 |
| `search_verses_fulltext_v2` | 327 |
| `search_verses_semantic_v2` | 42 |
| `search_transcript_paragraphs_semantic` | 8 |
| `search_letter_paragraphs_semantic` | 180 |
| `search_transcript_paragraphs_fulltext` | 58 |
| **Total, 6 lanes** | **615** |

**End-to-end p50/p95 through the deployed function: not measured.** See below. The baseline to beat remains the logged ~14.4 s (no variants) / ~24.7 s (ten variants).

## Safety

- Citation validation: every smoke hit carries a real `vedabase_url` re-read from the source row.
- Secret scan: no `.env` in the repo; no secret printed or committed. `NEXT_PUBLIC_*` carries only the Supabase URL and anon key, as before.
- Advisors: the `log_search` SECURITY DEFINER findings (0028/0029) are **gone**. Remaining findings are all pre-existing and unrelated: `verse_refs` security-definer view (ERROR), `unaccent`/`pg_prewarm` in public (WARN), deliberate anon-INSERT policies on `feedback`/`citation_clicks` (WARN), RLS-enabled-no-policy on three service-role-only tables (INFO, correct — deny-all to anon), and a platform Postgres patch (WARN).

## Verification gap — needs your action

**This sandbox's network policy blocks nearly all outbound HTTPS.** Measured:

| Host | Result |
|---|---|
| `asksrilaprabhupada.vercel.app` | **blocked** (403 CONNECT) |
| `api.vercel.com`, `vercel.com` | **blocked** |
| `wzktlpjtqmjxvragwhqg.supabase.co` | **blocked** |
| `api.voyageai.com`, `api.cohere.com` | **blocked** |
| `generativelanguage.googleapis.com` | reachable |
| `github.com` | reachable |

Database work is unaffected — it goes through the Supabase MCP server, not this sandbox's network. But I **cannot**:

- confirm the deployed function actually reports `bom1`,
- call `/api/health` on the live site,
- run the five smoke queries through the HTTP pipeline,
- measure end-to-end p50/p95.

To close this, either add those hosts to the environment's network policy (plus provider keys in env), or run these yourself:

```
curl -s https://asksrilaprabhupada.vercel.app/api/health
curl -s "https://asksrilaprabhupada.vercel.app/api/search?q=BG%2018.66"
curl -s -D- -o /dev/null https://asksrilaprabhupada.vercel.app/api/health   # x-vercel-id shows the region
```

## Deviations

1. **Applied via `execute_sql` in two chunks, not one atomic statement.** The MCP tool is the only path to the database here (no `DATABASE_URL`, no Supabase CLI). Chunk 1 = preconditions, collision guard, 19 functions. Chunk 2 = contract function, grants, `log_search`, `suggest_spelling`, comments, `NOTIFY`. Verified 23/23 compatible afterwards.
2. **24 remaining lint errors downgraded to `warn`, not fixed.** All are React-Compiler-era `react-hooks/*` findings in pre-existing UI, many in the retained unmounted design generation. They sit in one scoped, commented block — visible in lint output, not switched off. Rewriting the component tree during a search-backend fix is unrelated risk. Server, lib and test code stays at `error`.
3. **Tag lanes remain disabled at the call site** (`TAG_LANES_ENABLED = false`), reported in `disabledLanes`. The functions are restored so the contract is whole; Phase B owns phrase-preserving vocabulary resolution.

## Remaining risks

- **No end-to-end execution has happened.** Everything above is verified at the database and build layers only.
- The app-side tag scorer still assumes `SUMMARY:` prefixes and `?`-suffixed question tags while `tags_core` holds plain slugs. It currently scores ~nothing, and `.filter(_tagScore >= 0.08)` on the verse and prose lanes means it may be actively discarding good results. **Phase B fixes this.**
- Both Gemini expansion paths still use raw `JSON.parse`. Phase B deletes them.
- Supabase compute is on **LARGE (~$110/month)**, upgraded for the tagging run. Flagging as a downgrade candidate per the brief — not changed.
