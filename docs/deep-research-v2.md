# Deep Research V2 — technical specification

> **SUPERSEDED — historical record.** The single-search-engine change removed
> the second engine, the `DEEP_RESEARCH_V2_ENABLED` flag and the two reader
> modes described below. **There is no rollback to a previous engine and no
> environment variable that selects one**; any such instruction in this document
> is history, not a runbook. Kept unedited so the reasoning behind the current
> pipeline stays readable.

The durable spec for the search rebuild. Phase A (search integrity) is
implemented; B–D are specified here and not yet built. Incident detail lives in
`docs/search-integrity-audit.md`; repo-wide rules in `AGENTS.md`.

## Product principle

**AI may arrange the evidence. Only the corpus supplies the teaching.**

AI may: classify intent, create search angles, suggest vocabulary concepts,
select from approved passage IDs, order approved passage IDs, choose neutral
structural roles and approved heading/transition types.

AI must not: generate the doctrinal answer, manufacture, shorten or rewrite
quotations, invent citations, URLs, speakers, recipients, places or dates,
reconcile apparently conflicting teachings, turn recipient-specific letters into
universal instructions, write theological connective prose or an unsupported
conclusion, use web search as spiritual evidence, use generated answers as
retrieval documents, or use free-form HyDE theology.

## Target architecture

```
Original question
  -> deterministic intent + exact-reference router
  -> one schema-constrained Gemini query plan (0–6 approved angles)
  -> one batched embedding request
  -> five batched table-level hybrid retrieval RPCs
  -> one global weighted RRF fusion
  -> exact and near-duplicate collapse
  -> one unified rerank against the ORIGINAL question
  -> rule-based coherent evidence selector
  -> one schema-constrained Gemini article plan (IDs + structure only)
  -> server validates IDs and re-fetches exact source rows
  -> deterministic renderer produces quotations, context and citations
```

## Phase A — implemented

### Database

`supabase/migrations/20260726120000_restore_search_functions_v3_columns.sql`
restores 18 RPCs on v3 columns and adds `search_rpc_contract_v1()`.

Column mapping: `fts` → `fts_core`; `embedding` → `embedding_context4`;
`tags` → `tags_core`, returned under the alias `tags` so the client contract is
unchanged.

Semantic lanes order by `<#>` to match the `vector_ip_ops` HNSW indexes and
expose `-(a <#> b)` as `similarity`; vectors are unit-norm so this equals
cosine. Tag lanes accept canonical `vocab_terms` slugs only. All functions are
`SECURITY INVOKER`, `SET search_path = ''`, `service_role`-only.

### Application boundary

`app/lib/search-v2/errors.ts` ships `InvalidSearchInputError` (400),
`SearchInfrastructureError` (503), `ProviderUnavailableError` (503).
`app/lib/search-v2/rpc.ts` ships `rpcOrThrow`, `rpcOrDegrade`, `unwrapOrThrow`,
`DegradationLog`, and an injectable client interface for tests.

Required lanes: direct lookup, and the original question's full-text and
semantic retrieval. Optional lanes: query expansion, variant retrieval,
supplementary phrases, spelling, chapter context, telemetry — each records a
`degradedStages` entry when it softens.

`SearchInfrastructureError` always escapes `hybridSearch`; it may not fall
through to the legacy v1/`ilike` path, which would answer a broken pipeline with
plausible-looking results.

### Response and HTTP contract

Success gains `requestId`, `retrievalStatus: "complete"`, `degradedStages`,
`disabledLanes`. `validated` keeps its existing meaning. Invalid input → 400;
database/config → 503 `search_infrastructure_error`; required provider → 503
`provider_unavailable`; unexpected → 500. SSE keeps the `failure` event name.
Query capped at 2,000 chars; modes limited to `article` and `references`.
`RESPONSE_VERSION` is `p8`; errors are never cached; request ids are attached
after the cache read.

`GET /api/health` reports only status, search availability and request id,
backed by `search_rpc_contract_v1`, calling no paid provider.

### Deferred out of Phase A, deliberately

- **ESLint.** The repo has never been linted; adding it to an integrity hotfix
  would mix unrelated churn from the retained earlier-generation components into
  a diff that must stay reviewable. CI runs typecheck, tests and build.
- **Rate limiting.** `/api/search` still has no per-IP throttle; the 2,000-char
  cap bounds a single request but not request volume. PR D.
- **Schema-history reconciliation.** Its own workstream — see the audit, §5.

## Phase B — retrieval and ranking V2 (not built)

Flag `DEEP_RESEARCH_V2_ENABLED=false` by default; existing search remains the
control arm.

**Intent router (deterministic, before any model call).** Intents:
`exact_reference`, `exact_quote`, `factual_entity`, `broad_concept`,
`practical_how`, `why_question`, `narrative`, `lecture_specific`,
`letter_specific`, `comparison`, `multi_part`, `insufficient_or_out_of_domain`.
Subquery *limits* (not quotas): exact reference 0; exact quote 0–1; entity 0–2;
narrow factual 1–2; ordinary philosophy 2–4; broad practical 3–5; comparison or
multi-part 3–6.

**One query plan.** Replaces both `app/lib/07-query-preprocessor.ts` and the
fixed ten variants in `app/lib/16-multi-query.ts`. Schema-constrained, validated
with Zod (a new dependency — the repo has no runtime validator today, and both
Gemini call sites currently use bare `JSON.parse` with no `responseSchema`).
Semantic validation rejects: more subqueries than the router permits, duplicate
ids, a subquery equivalent to the original, near-identical subqueries, loss of
explicit names/quotations/references, invented hard constraints, arbitrary
slugs, and an exact reference needlessly fanned out. On failure: one retry for a
transient/truncated response, then search the original question only, marked
degraded. Never fail into generated doctrine.

**Vocabulary resolution.** Server-side, against the 251 `vocab_terms`. Order:
exact slug → exact alias/variant → normalised spelling/transliteration →
vocabulary FTS → embedding similarity. Only validated ids reach retrieval. Must
be phrase-preserving: 143 of 251 terms are multiword, which is why Phase A
disabled the lane. Handle ambiguity explicitly (`dharma → {duty, religion}`).
Tags are a modest ranking signal, never a hard filter unless the user asked for
one or evaluation proves recall is preserved. Batch the calls: the current shape
would fire up to 45 tag RPCs per query.

**Retrieval.** One versioned batch function per corpus table
(`search_*_hybrid_batch_v2`), accepting the original plus approved subqueries
with id/text/embedding/weight, lexical phrases, validated tag ids, hard
constraints and a per-table candidate limit. Returns passage/chunk text — not
whole books, transcripts or purports; parent context is hydrated only after
final selection. Run the five concurrently. Report logging and hydration calls
separately and honestly.

**Channels.** `fts_core` for exact phrases, quotations, references, names and
distinctive wording. `fts_expansion` for aliases and spelling/transliteration
variants, weighted below `fts_core`. Embeddings for conceptual matches.
Controlled tags as a modest signal and a clustering/explanation aid.

**Fusion — once, weighted.** `score = Σ_{query,channel} w_q · w_c / (k + rank)`.
Starting candidates, to be benchmarked, not treated as truth:
`rrfK: 50`; query weights `original 1.0, primary 0.75, supporting 0.60,
exploratory 0.40`; channel weights `ftsCore 1.20, semantic 1.00, ftsExpansion
0.65, controlledTags 0.35`. Do not RRF per subquery and then RRF again equally.

**Deduplication.** Exact/normalised hashing, then near-duplicate embeddings at a
configurable starting threshold of cosine ≥ 0.95. Keep the highest-ranked
contextually complete passage and preserve alternative-source metadata. Never
merge distinct teachings on embedding proximity alone, never collapse a verse
into its purport, never collapse a personal letter into a general instruction.

**Reranking — once, unified.** One candidate list spanning all source types,
reranked against the **original question**, documents serialised consistently
(YAML with `passage_id`, `source_type`, `reference`, `date`, `recipient`,
`speaker`, `text`). Never rerank per subquery and fuse again. Raw scores are
ranking signals, not "confidence percentages". On failure, fall back to weighted
fusion plus the selector and mark the response degraded. Exact-reference paths
may bypass reranking.

Budgets: quick `{ maxSubqueries: 3, maxCandidatesBeforeRerank: 60,
maxFinalPassages: 4 }`; guided `{ 6, 120, 8 }`.

**Evidence selector.** Not top-N. Weighs relevance to the original question,
coverage of required subquestions, exact reference/quotation priority, a
redundancy penalty, verse–purport relationships, context completeness, speaker
correctness, recipient/date relevance, narrative-vs-instruction risk, and
whether a letter needs an explicit context label. Never force a lecture, a
letter, multiple books, multiple years or all PLEASE categories. MMR optional
behind `SEARCH_MMR_ENABLED=false` with a candidate λ of 0.70 — unproven until
the gold set says otherwise, and never overriding hard context constraints.

Also retire `scoreTagRelevance` (`app/api/search/route.ts`), whose doc comment
still describes the pre-cutover tag format while it scores slugs.

Reuse rather than rewrite: `fuseRankedLists` (`app/lib/16-multi-query.ts`),
`embedQueries` (`app/lib/03-embed.ts`), `app/lib/10-passage-fold.ts`,
`app/lib/12-provenance.ts`, `app/lib/13-passage-label.ts`.

## Phase C — grounded article planner and modes (not built)

Gemini receives the question, the approved passage IDs, limited verified
metadata and the structural roles it may choose — and no permission to quote or
paraphrase. It returns `article-plan-v1`: article type, title, opening,
`direct_answer_passage_ids` (≤3), 1–5 sections (`heading_key`, `short_subject`,
1–4 `passage_ids`, `transition_type`), closing, and a fixed disclosure string.
Headings are server-generated from `heading_key` + `short_subject`.

New error classes at this stage: `InvalidQueryPlanError`,
`InvalidArticlePlanError`, `EvidenceInsufficient`.

Reject or fall back deterministically when: an id was not supplied, an id repeats
without a structural reason, a section is empty, the mode's passage budget is
exceeded, a title or subject makes an unsupported doctrinal claim, a letter loses
recipient/date context, another speaker is attributed to Śrīla Prabhupāda,
chronology is claimed without dates, thin evidence is presented confidently, or
free-form prose appears. One retry for a transient/schema error, then the
existing deterministic renderer.

Then **re-fetch every selected passage**, confirming table, source type, exact
text, speaker, reference, date, recipient and location. Never trust quotation
text or citation metadata from the model. `app/lib/17-verbatim-validator.ts` is
reused unchanged as the final gate.

The renderer owns quotation text, Sanskrit/transliteration/word-for-word/
translation/purport layers, source labels, citation URLs, context notices,
controlled non-doctrinal transitions, folds, disclosure, "also appears in"
metadata and source-supported PLEASE labels.

**Quick Answer**: deterministic routing where possible, 0–3 subqueries, lower
budget, strongest direct source plus ≤3 supporting passages, planner skippable,
no long AI introduction, no forced practical application.

**Guided Study**: honest title, strongest source first, neutral source map, 4–8
passages grouped by purpose, verse–purport relationships, context labels for
letters/conversations/narratives, expandable context, related passages, optional
evidence trail.

CPU: Content = selected exact passages; Presentation = ordering, headings, cards,
folds, pacing; Understanding = intent, audience, constraints, mode. PLEASE
(Practical application, Lesson, Example, Analogy, Śāstric connection,
Elaboration) is an optional menu — a category appears only when a selected
passage supports it. Prefer analogies already in the corpus.

Stages: `planning`, `retrieving`, `fusing`, `reranking`, `selecting`,
`organizing`, `complete`, `degraded`, `error`. `SearchStageKey`
(`app/lib/types/01-search.ts`) and the loader's synthesised "Verify" step must
move together.

## Phase D — evaluation, cache, region, rollout (not built)

**Cache** — replace the process-local `Map` in `app/lib/04-search-cache.ts` with
a shared store. Versioned keys: `query-plan:v1:{hash}`,
`embedding:voyage-context-4:{hash}`,
`retrieval:v2:{corpus}:{mode}:{plan-hash}`, `rerank:v1:{question}:{candidates}`,
`article-plan:v1:{question}:{ids}`, `response:v2:{corpus}:{mode}:{question}`.
Never cache keys or errors. A full-response hit requires an exact normalised
question and identical mode/config/corpus version — never serve an answer
because a *different* question was similar. A semantic cache may reuse candidate
retrieval only if the original question is reranked and evidence revalidated.

**Telemetry** — request id, mode, intent, subquery count, retrieval RPC count,
candidate counts before/after fusion, duplicate counts, rerank document count,
selected passage count, degraded state, stage and total durations, provider
model ids, error category, flag cohort. Prefer a question hash to the raw
question unless policy permits storing it.

**Gold set** — ≥50 human-verified questions before internal rollout, 120–150
before broad rollout, covering exact verse, exact quotation, person/place, broad
concept, practical how, philosophical why, narrative, lecture-specific,
letter-specific, recipient/date, comparison, ambiguous, misspelled, Sanskrit
transliteration, long natural-language, multi-part, misleading assumption, and
no-corpus-answer.

**Experiments** — expansion breadth A(original only)/B(0–2)/C(0–4)/D(0–6)/
E(fixed six)/F(current ten); channel ablation; unified vs per-type reranking;
selector with and without MMR; Quick and Guided against baseline. Metrics:
Recall@10/20/50, MRR, nDCG@10, direct-answer presence, duplicate rate,
source-context error rate, subtopic coverage, citation faithfulness, p50/p95
latency, provider calls, measured cost per query. Human grading: faithfulness,
directness, coherence, redundancy, context preservation, readability, clear
separation of AI structure from corpus text, class-preparation usefulness.

**Release gates** — displayed quotation faithfulness 100%; exact-reference smoke
100%; infrastructure failures never presented as insufficient evidence; no
Recall@10 regression; expansion retained only on a measured gain (if Recall@10
improves by less than ~2 points, reduce or remove it — keep reranking and
selection if they independently help); context-error rate ≤ baseline; acceptable
measured p95 per mode; costs from real telemetry; no secrets in client bundles
or logs; no unaddressed material advisor findings; preview E2E green.

**Region** — evaluate `bom1` against the ap-south-1 (Mumbai) database only after
correctness work; verify the deployed function's actual region and compare
latency before and after. A region change does not fix inefficient retrieval.

**Rollout** — clean local build and tests → migration test → preview → preview
smoke/E2E → logs and advisors → draft PR review → explicit approval →
backward-compatible production migration → verify production contracts →
promote → flag off → internal/canary → observe → widen. Never combine an
untested migration with an untested release.

Note: `scripts/verify-release.sh` asserts `queryVariants.length in (0, 10)`;
that must change when adaptive 0–6 expansion ships.

## Required failure behaviour

| Failure | Behaviour |
|---|---|
| Gemini query planner unavailable | Original-query hybrid search |
| Query plan invalid | One safe retry, then original-query search |
| Voyage unavailable | Full-text lanes (plus validated tags once re-enabled) |
| One table-level RPC fails | Infrastructure failure; do not silently omit that source |
| Reranker unavailable | Weighted fusion + selector, marked degraded |
| Article planner unavailable | Existing deterministic renderer |
| Final source re-fetch fails | Drop the item or fail safely; never display an unverified quotation |
| Evidence genuinely weak | `evidence_insufficient`, with related verified passages |
| Infrastructure broken | Typed error, never "no teachings found" |

Every fallback must be visible in response metadata and telemetry.
