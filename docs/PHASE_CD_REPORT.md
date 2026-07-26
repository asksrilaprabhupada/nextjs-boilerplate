# Phases B (part 2), C and D

**Flag state:** `DEEP_RESEARCH_V2_ENABLED` now defaults **true**. V2 serves.
**Rollback:** set `DEEP_RESEARCH_V2_ENABLED=false` in Vercel. One variable, no deploy.

---

## Compute change — benchmarks re-verified

You moved Supabase to MICRO. That invalidated the Phase B numbers, so they were re-measured before anything was built on them.

| | LARGE | MICRO |
|---|---|---|
| `shared_buffers` | — | 256 MB |
| `max_connections` | — | 60 |
| transcripts batch (144,438 rows, 3 queries × 5 channels) | 678 ms | **782 ms** |

~15% slower, and the HNSW/GIN indexes still do the work. The Phase B claims stand. Worth noting: `max_connections` is 60, and each request opens five concurrent RPCs — the Session Pooler matters more on MICRO than it did on LARGE.

## Phase B (part 2) — the pipeline is now joined

| Module | Role |
|---|---|
| `retrieval.ts` | vocabulary resolution + batched embedding + five concurrent RPCs |
| `rerank.ts` | ONE unified Cohere rerank against the ORIGINAL question, YAML documents |
| `cache.ts` | versioned keyspace, Vercel Runtime Cache with an in-process fallback |
| `pipeline.ts` | the orchestrator, and the only place the stages are joined |
| `adapt.ts` | maps V2 output onto the existing wire contract so the UI is untouched |

The route now branches on the flag. Failures are **not** caught at the branch: a retrieval RPC failure reaches the handler as `SearchInfrastructureError` → 503. Falling back to V1 on error would rebuild exactly the disguise this work removed.

**Tag scorer rewritten.** `scoreTagRelevance` assumed `SUMMARY:` prefixes and `?`-suffixed question tags — a shape that has not existed since the v3 cutover. Every branch fell through, so it returned ~0 for everything, and its callers *filtered* on that result. It was discarding good passages, not merely failing to promote them. It now matches hyphenated vocabulary slugs against query content words, and the filter can no longer drop a passage whose tags simply say nothing.

## Phase C — structure from AI, teaching from the corpus

`article-plan.ts` sends Gemini the question, the approved passage IDs, limited verified metadata, and a closed enum of structural roles. It gets back structure only. Rejected outright — never repaired — when the plan references an ID that was never supplied, exceeds the mode's passage budget, claims chronology without dates, dresses an evidence-insufficient result as an answer, writes a promotional title, or writes a `short_subject` that reads as prose.

The disclosure is a `z.literal`, so a plan cannot reword what the page claims about itself.

`render.ts` owns every word a devotee reads: headings assembled server-side from `heading_key` + `short_subject`, transitions from a fixed non-doctrinal table, context labels, citations, folds, disclosure. Transitions say what the next passage **is** ("In a recorded lecture…", "The following personal letter was written to [verified recipient] in [verified year]"), never what it **means**.

### C3 — the hard stop

`refetch.ts` re-reads every selected passage from its source row and verifies id, namespace→table mapping, byte-match under the verbatim normaliser, speaker, reference, date, recipient and location. The renderer receives **only** this fresh data.

The failure mode is deletion. Never repair, never substitute, never render the stale copy. Tested:

| Scenario | Behaviour |
|---|---|
| stored text no longer matches | `text_mismatch` → dropped |
| row has vanished | `row_not_found` → dropped |
| verification read fails | `fetch_failed` → all dropped |
| unknown namespace | `unknown_namespace` → dropped |
| `verse:` key whose id exists only in `letter_paragraphs` | dropped — namespace decides the table |
| stale candidate claims a different recipient | fresh row wins |
| letter without verified recipient **and** date | not renderable |

### Reader modes

Quick Answer (`quick`): source-first, no source map, planner skipped entirely when ≤3 passages — a devotee fifteen minutes before class does not need an AI to arrange three passages. Guided Study (`guided`): neutral source map, up to 8 passages, full context.

SSE stages map onto the existing loader events, so the flag flips without touching the UI. The "Exploring 10 angles" label is gone — V2 does not fan out into ten variants and the label would be a lie.

## Phase D

**Cache** — versioned keys (`response:v2:{corpus}:{mode}:{hash}`, `retrieval:v2:…`, `embedding:{model}:…`). A full response is served only for an exact normalised question in the same mode, config and corpus version. A semantically-close *different* question never reuses an answer. Keys are never logged; cache failures degrade speed, never correctness.

**Telemetry** — per request: request id, mode, intent, question **hash** (never the question), subquery count, plan source, table RPC count, vocabulary and re-fetch counts reported **separately** so the "five RPCs" claim stays honest, candidate counts before/after fusion, duplicates collapsed, rerank document count, selected count, dropped-on-refetch, degraded stages, per-stage durations, model ids, flag cohort.

**Gold set** — `tests/gold/gold-set-v1.json`, **65 questions** across all 18 categories. Passage IDs in `must_find_passage_ids` were read from the live database and are verified. Every unverified row carries `needs_human_review: true`.

**Harness** — `npm run eval:gold` (`SITE=… node scripts/evaluate-search.mjs`). Computes Recall@10/20/50, MRR, nDCG@10, direct-answer presence, duplicate rate, citation faithfulness, out-of-domain handling, latency p50/p95. Supports `ARM`, `CATEGORY`, `LIMIT`, `MODE` for the experiment matrix.

It **refuses to score ranking metrics over unreviewed rows**, and prints how many it excluded. A recall number computed from model-suggested labels is a number about the labelling model. It exits non-zero if any unacceptable passage surfaces or any citation lacks a reference.

## Gates

lint 0 errors · typecheck clean · **116 tests** · production build succeeds.

## What is honestly NOT done

- **No end-to-end execution.** The network policy blocks the deployment host, Supabase HTTP, Voyage and Cohere. Everything above is verified at the database, type and unit-test layers. **V2 is serving production code that has never been run against a live request.**
- **The gold set's relevance labels are unreviewed.** 65 questions exist and are structurally validated; 24 carry verified anchors. The rest need a devotee's judgement before any recall number means anything.
- **The experiment matrix has not been run.** The harness exists; no arm has been executed, so there are no comparative numbers for expansion arms, channel arms, unified-vs-separate reranking, MMR λ, Cohere pro vs fast, or RRF k ∈ {20, 40, 60}.
- **The D5 gates are therefore unmet**, because they are measurements and nothing has been measured against a deployment.
- Fusion weights, `rrfK`, the 0.95 duplicate threshold, the 0.25 selection floor and MMR λ = 0.70 remain **benchmark candidates, not findings**.
- The legacy expansion modules (`16-multi-query.ts`, `07-query-preprocessor.ts`) still exist and are still used by the V1 control arm. They are no longer on the V2 path.

## First thing to do

```
curl -s https://asksrilaprabhupada.vercel.app/api/health
curl -s "https://asksrilaprabhupada.vercel.app/api/search?q=BG%2018.66" | head -c 2000
SITE=https://asksrilaprabhupada.vercel.app npm run eval:gold
```

If anything looks wrong: `DEEP_RESEARCH_V2_ENABLED=false`.

---

# Addendum — finishing pass

Work done after the four phases were merged, in risk order. Everything here was
found by exercising the system rather than reading it.

## 1. Citations were malformed for ~92% of the corpus (shipped defect)

Calling the batch RPC with the exact payload `supabase-js` sends produced
`SB 7.8.Text 9` and `ISO 0.Verse text`.

| Scripture | Rows affected | Storage |
|---|---|---|
| SB | 11,944 / 13,004 | `verse_number = 'Text 9'` |
| CC | 11,131 / 11,359 | `verse_number = 'Text 1'` |
| BS | 62 / 62 | `'Verse text'`; `chapter_number` **is** the verse, chapter always 5 |
| ISO | 19 / 19 | `'Verse text'` |
| NOI | 11 / 11 | `'Devanagari'` |

`vedabase_url` is now the authority — it carries the canonical locator and
cannot drift from per-book column quirks. Verified across **all 25,131 verses**:
`SB 1.1.1`, `CC Adi 1.1`, `CC Madhya 9.265`, `BG 18.66`, `BS 5.29`, `ISO 1`,
`ISO Invocation`, `NOI 8`, `NBS 1.1`, `MMS 1.1`.

`public.format_verse_reference()` (SQL) + `app/lib/search-v2/citation.ts` (TS,
and the one that actually renders). `refetch.ts` now joins through
`verses → chapters` for the SB canto / CC division.

## 2. The orchestrator had never been executed

`tests/search-v2-integration.test.ts` calls `runSearchV2` directly against a
fake seeded with real production rows, with **no provider keys** — the
all-providers-down path. Asserts the answer is still correct, cited and
verbatim; that exactly five table RPCs run with hydration counted separately;
that a retrieval failure propagates rather than returning empty; that a tampered
source row is dropped while the rest renders; and that the question never
reaches telemetry in plaintext.

## 3. Two defects in the V2 code itself

- The embedding lookup misused `cached()`, whose producer runs on a miss and
  then **stores the result** — writing a `null` into the shared keyspace for
  every unseen query text. Never served as a hit, but it polluted a shared
  cache. Now a direct read-only get.
- `durations.fusing = durations.fusing ?? 0` meant the fusing stage always
  recorded zero. Fusion and dedup are where a bad ranking is created; now timed.

## 4. Response cache wired into the V2 route

The V2 branch returned before the caching logic, so every request recomputed —
which matters more on MICRO with its 60-connection cap. Now keyed on the exact
normalised question + mode + corpus version. **A degraded or
evidence-insufficient response is never cached**: it is correct but weaker, and
a 24-hour entry would outlive the outage that produced it.

## 5. Planner call loops covered

The rejection predicates were already unit-tested; the loop around them was not.
Now covered against injected clients: one retry on a truncated body, safe
fallback after two failures without throwing, discard of a schema-valid plan
that invented a constraint, no model call at all for a bare exact reference, and
rejection of a plan that reworded the disclosure.

## Gates after the finishing pass

lint 0 errors · typecheck clean · **175 tests** · production build succeeds.

## Still open — and why

- **No live end-to-end run.** The network policy blocks the deployment host,
  Supabase HTTP, Voyage and Cohere. The integration test closes most of this gap
  at the orchestration layer, but nothing has served a real HTTP request.
- **41 of 65 gold-set rows carry unreviewed relevance labels.** This needs a
  devotee's judgement and cannot be automated; the harness refuses to score them.
- **The experiment matrix has not been run** — it requires a reachable
  deployment. The harness is ready.
- Fusion weights, `rrfK`, the duplicate threshold, the selection floor and MMR λ
  remain benchmark candidates, not findings.
