# Tags & FTS Rebuild — offline batch harness (v4-tiered)

> **v4-tiered (current)** replaces the single generative Gemini pass with a
> **three-tier classifier** over the same frozen 251-term vocabulary. Only the
> third tier costs money.
>
> - **Tier 1 — EXACT ALIASES (free, no LLM).** Person/Place/Scripture terms are
>   matched by term + variants against the passage sentences (word-boundary,
>   diacritic-insensitive — the `fold_text`/fts_core normalization). A hit →
>   `method='exact_alias'`, `confidence=1.0`, evidence = the first matching
>   sentence (id + offsets).
> - **Tier 2 — EMBEDDING SHORTLIST (free, no LLM).** Concept/Practice terms are
>   ranked by cosine similarity (`embedding_context4` ↔ `vocab_terms.embedding`);
>   the top **`TIER2_SHORTLIST_K`** per passage (default **12** in the pilot, the
>   width the judge mechanism was validated on). The **full run widens this to
>   `TIER2_SHORTLIST_K_FULL`=20** and recalibrates the thresholds against the k=20
>   shortlist at full-run start (same sweep, same targets — measured shortlist
>   recall ceiling k12=0.719 → k20=0.823; width only adds candidates, the
>   row-level gates stay active). Two thresholds, **calibrated against the p1 pilot
>   tags** (run `63c99428…`), band each candidate: ≥ **T_accept** → auto-assign
>   (`method='semantic'`, `confidence=similarity`); < **T_reject** → drop; the
>   middle band → Tier 3. Calibrated pilot defaults **T_accept=0.47** (measured
>   precision 0.80), **T_reject=0.22** (retains 0.96 of in-shortlist positives).
> - **Tier 3 — LLM JUDGE (the only paid part).** `gemini-3-flash-preview` for all
>   rows; retry once → escalate once to `gemini-3.5-flash` → quarantine. The
>   prompt shows ONLY the middle-band candidates (slug + scope note + shortlisted
>   hard-negative partners); output is exactly
>   `{"tags":[{"slug","evidence_sentence_id"}]}` (zero tags valid),
>   `thinkingLevel=LOW`, small output cap (~512). `method='llm_confirmed'`.
>
> Book-based **core/standard routing is gone** — this is pure classification, so
> the ladder is a Tier-3 model escalation, not a per-book choice. **Questions and
> `passage_function` are DEFERRED** (columns stay; nothing is generated now).
> **Writes:** `tags_core[]` is the fast merged copy (Tiers 1+2+3, highest
> confidence first, capped at `MAX_TAGS`, materialized from `tag_evidence`);
> `tag_evidence` gains **`method` + `confidence`**; `tag_passage_outcomes` tracks
> completion exactly as in p3. The 251-term vocabulary, sentence splitter,
> provenance gating, row-level completion, retrieval-time spend accounting and
> the $325 ceiling all carry over unchanged. `python run_all.py --pilot-only`
> runs the full tiered pipeline on the existing 2,000-row manifest and STOPS.
>
> **Queue-wait fix:** on HTTP 429 (batch queue full) at create time, submission
> now WAITS — polling in-flight jobs every 5 min and retrying when a slot frees —
> across **bakeoff, pilot and full** paths (previously bakeoff crashed).

# Legacy harness (v3.p3-hybrid) — retained below for reference

Offline Python harness for the search-data rebuild. Runs locally or in a
sandbox, never on Vercel. One command drives the whole build, resumably.
v3 = the consolidated correction pass folding three independent research
reviews into the v2 harness; v3.p2 froze the v3.p1 pilot and fixed the defects
it exposed (canonical pricing + thinking-token accounting, sentence-ID
evidence, direct verse_chunks tagging, raw failure diagnostics, the
validate-before-write pilot). **v3.p3-hybrid**: TWO models, one pipeline —
core scripture (verses/verse_chunks of Bhagavad-gītā `bg`, Śrīmad-Bhāgavatam
`sb`, Caitanya-caritāmṛta `cc`) routes to **gemini-3.5-flash**; every other
passage routes to the 3×-cheaper **gemini-3-flash-preview** — with the SAME
vocabulary, prompt, response schema and sentence-ID evidence, and an explicit,
NON-overridable `thinkingLevel=LOW` in every request for BOTH models
(3 Flash defaults to HIGH thinking — the override is mandatory). Completion is
now **row-level** (`tag_passage_outcomes`): invalid/missing rows retry once on
their own model, still-invalid standard rows escalate once to the core model,
anything left is QUARANTINED (listed, unresolved — the run never claims
complete and finalize refuses). Real token usage is recorded the moment
results are RETRIEVED, so the ledger counts every dollar actually spent. A
NO-DB-WRITE `--bakeoff-model` mode replays the banked p2 pilot requests
verbatim through any model and writes a comparison report against the banked
p2 (3.5 Flash) results.

## What the rebuild does (one paragraph)
Replace the broken free-form `tags` (359,433 distinct tags on verses, 89%
singletons → connects nothing) with a **closed, evidence-checked controlled
vocabulary** (`tags_core`), add a hidden **doc2query "questions"** lane
(HIS-content only, each question evidenced by its answer span), record one
**`passage_function`** per passage (closed enum; the only channel adopted from
the 49-channel beta spec), finish the diacritic-blind `fts_core`, and stage
`fts_expansion` + `questions_fts` + GIN indexes. Everything goes to **new
columns + new support tables**; the old `tags`/`fts`/live search stay intact
until the Phase 6 search wiring is approved on a Vercel preview. Tags,
questions and passage_function are internal metadata — never shown as doctrine.

## Setup
```
cd scripts/tags-rebuild
python -m venv .venv          # Windows: .venv\Scripts\activate · POSIX: . .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env        # then fill it in (cp on POSIX)
python run_all.py --doctor    # read-only readiness checklist
```

Credentials live in `scripts/tags-rebuild/.env` (git-ignored) — the ONLY file
the harness reads (process env wins). All five keys are **required**; there is
no anon-key fallback and the harness fails loudly if any is missing:
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (service role), `DATABASE_URL`
(**Session Pooler** DSN, port 5432 — not the 6543 transaction pooler),
`GEMINI_API_KEY`, `VOYAGE_API_KEY`. Set `MAX_SPEND_USD` too (default 325).

## Run
```
python run_all.py             # the whole build; stops once, at the ⛔ vocabulary gate
python run_all.py --resume    # rerun after Ctrl+C / crash / next day — continues in place
python run_all.py --yes       # skip the ⛔ gate (maintainer's standing one-shot ruling)
python run_all.py --pilot-only # run ONLY the v3.p3 pilot (validate files → retry once on
                              # the failing model → escalate still-invalid standard rows
                              # once to the core model → apply on a 100% row-level +
                              # distribution pass) then STOP before the full corpus run.
                              # Requires vocabulary.json already built.
python run_all.py --doctor    # green/red checklist: keys, BOTH routed model strings,
                              # pooler, counts, routing census, row-outcome states,
                              # + FAILS on any routed model without a pinned price,
                              # stale/mismatched pricing, or unpriced billed rows
python run_all.py --bakeoff-model MODEL [--bakeoff-route all|core|standard]
                              # NO-DB-WRITE bakeoff: replay the banked p2 pilot request
                              # files verbatim through MODEL (local state file only) and
                              # write shards/bakeoff_<model>_<route>_report.md + .json
                              # vs the banked p2 (3.5 Flash) results: schema validity,
                              # per-route tag agreement (exact + Jaccard + per-tag
                              # both/baseline-only/candidate-only), passage_function
                              # agreement + confusions, seeded question samples, true
                              # per-model cost. Needs the maintainer-local banked files.
python run_all.py --accept-quarantine
                              # explicit override: let the PILOT, the full run and finalize
                              # proceed although quarantined (unresolved) rows exist. In the
                              # PILOT this applies Tier-3 for the resolved rows and records the
                              # still-invalid rows as unresolved (never counted complete)
                              # instead of refusing. Quarantined rows are always listed loudly
                              # (table · passage_id · per-attempt finishReason/blockReason ·
                              # excerpt); every other unresolved state still refuses.
python run_all.py --revalidate-pilot   # re-scan banked shards/pilot_*.results.jsonl,
                              # recompute the gates + a per-bucket breakdown of WHY
                              # schema-invalid rows failed, rewrite pilot-report.md.
                              # No DB writes, no Gemini, no cost. Missing banked shards
                              # are reported as "cannot validate", never as clean.
```

The `--revalidate-pilot` breakdown classifies every schema-invalid response from
the model's own `finishReason` / `blockReason` into one of
`RECITATION · MAX_TOKENS · SAFETY/PROMPT_BLOCKED · MALFORMED_JSON · NO_TAGS_ARRAY · other`,
so a low schema-validity number tells you *why* rows failed rather than just
that they did. (A live pilot run also writes this section into `pilot-report.md`.)

| Step | What happens | Gate |
|---|---|---|
| 1 | `fts_core` backfill — touch rows `WHERE fts_core IS NULL` in batches over `DATABASE_URL`; progress printed; idempotent. | — |
| 2 | Vocabulary build → `vocabulary.json`: faceted (Concept / Person / Place / Scripture / Practice — **no Sanskrit facet**: one topic = one term, language forms are variants; labels are the word devotees actually use, English by default). Curated seeds (`vocabulary_seeds.json`, incl. `hard_negatives` contrast pairs) + CANDIDATES (chapter titles, mined Sanskrit glosses with particle stoplist + chapter-dispersion check, net-new mining capped ~100) through ONE Gemini naming/dedup path — never straight into the menu. Clustering runs as LENSES (k ∈ {150,300,500} MiniBatchKMeans + one HDBSCAN pass) with **seeded random** stratified sampling (by table; by book within prose; seed recorded); Gemini names each cluster from its nearest AND farthest members and may answer "incoherent — drop"; the 0.1-cosine centroid merge produces **merge PROPOSALS** (applied provisionally, all listed in the `merges` section). Every term gets a one-line **scope note** (covers X; not Y) and `kind: concept|entity` (entities don't count toward the ~400-700 concept expectation — the gate decides, not a round number). Loaded into `vocab_terms` (service key) with Voyage embeddings. | — |
| ⛔ | **THE ONE GATE:** review `vocabulary.json` — terms + scope notes + MERGES (veto = edit the file), then press Enter. (`--yes` skips.) | ⛔ |
| 3 | Pilot (**v3.p3**): an EXACT **2,000-row manifest** = ALL p1-failures + a p1-success comparison slice (matched to the failure table mix + length quartile) + a fresh remainder stratified across all five tables × length quartiles by largest-remainder allocation (checksum + per-route counts recorded in `tag_runs.config`), **route-split per model**. Results are **validated locally BEFORE any DB content write**: first-pass schema validity is **DIAGNOSTIC** (never an abort); every invalid/**missing** row is **retried once on its own model**, still-invalid standard-route rows **escalate once to the core model**, and **100% row-level validity** is required — still-invalid rows are listed explicitly (the would-be quarantine list) and the run stops with nothing applied. Distribution gates (OOV ≤ .02 · distinct tags ≥ 100 · singleton ≤ 20% · ≥ 60% vocab used · no tag on > 20% of passages · median 3–8 among TAGGED) run on the files too. Only on a full pass are all 2,000 rows applied in **one atomic transaction** (incl. their outcome rows). `pilot-report.md` gets first-pass/retry/escalation validity, an explicit **QUARANTINE listing** of every still-invalid row (table · passage_id · the **full per-attempt `finishReason`/`blockReason` history** · a passage excerpt) with the raw `finishReason`/`blockReason` for every `other` failure, the TRUE **per-model** cost (thinking INCLUDED) + per-route full-run extrapolation, and 40 samples (passage excerpt + tags + method + evidence sentence). Passing **`--accept-quarantine`** in the pilot applies Tier-3 for the resolved rows, records the still-invalid rows as `quarantined` (UNRESOLVED — loudly listed, never counted complete), recomputes the merged `tags_core`, and regenerates the report with real distribution stats + the samples; without it the current refuse (nothing applied) behavior stays. `--pilot-only` runs just this and stops. | auto |
| 4 | Full tagging: ONE combined structured Gemini Batch call per passage, routed **per passage** (core scripture → full **Gemini 3.5 Flash**; everything else → **Gemini 3 Flash preview** — never Lite on either route) with the NON-overridable `thinkingConfig.thinkingLevel=LOW` and the model-default temperature, returns `passage_function` (closed enum, incl. `not_applicable`), `tags_core` (≤ `MAX_TAGS`) and 0-3 `questions` — **evidence is a sentence ID** drawn from the numbered target sentences (deterministic splitter `asp-sentences-v1`), resolved back to the exact source sentence + offsets (the model never copies text). Candidate shortlist = semantic top-25 ∪ exact alias matches ∪ hard-negative partners, cap ~40. Stance rules: aboutness only; entities only when prominent; ZERO tags valid. Gates: out-of-vocabulary → HARD drop; in-vocab unresolvable-id → KEPT, `evidence_found=false`; unevidenced question → dropped. **`verse_chunks` are tagged DIRECTLY**. Coverage is **ROW-LEVEL** (`tag_passage_outcomes`): a passage counts only with a successfully applied result in this run — never because its id sat in a submitted shard; invalid/missing rows retry once (same model) → standard rows escalate once (core model) → still-invalid rows are **QUARANTINED** (listed; the run is never marked complete while any exist). | ceiling |
| 5 | Finalize: **REFUSES while any Gemini-eligible passage lacks a resolved outcome** in the run (quarantined rows require an explicit `--accept-quarantine`; skipped-no-shortlist rows are resolved but listed); then tsvector verification; GIN indexes with `CREATE INDEX CONCURRENTLY`, one at a time, `ANALYZE` after each, invalid-index check; **hygiene report** (`hygiene-report.md`: 0 uses / < 20 uses / > 15% of corpus — report only, nothing auto-deleted); completion checklist incl. the Supabase compute downgrade reminder (LARGE → MICRO, ~$110/month). | ⛔ unresolved |

## Provenance manifest — the single source of truth
`provenance.json` encodes the reviewed authorship rules; **the harness gates
only from this manifest — there are no ad-hoc rules in code** (`provenance.py`
just interprets it):
- **NOT-HIS**: prose books `rkd`, `mbk`, `spl`; Śrīmad-Bhāgavatam from Canto 10
  Chapter 14 onward (canto+chapter parsed from `vedabase_url`).
- **MIXED-VERIFY**: `nbs`, `mms`, `bs` — treated as NOT-HIS until verified.
- **Transcripts**: `Name:` speaker prefixes are parsed per paragraph; the last
  named speaker carries forward across prefix-less continuation paragraphs
  within a transcript (the known-imperfect heuristic, kept deliberately);
  a paragraph counts as Prabhupāda-speaking if he is among its speakers.
  Letters are HIS. Unknown book slugs are MIXED-VERIFY.
- **Gating**: questions ONLY for HIS / Prabhupāda-speaking content; everything
  still gets topic tags + passage_function.

## Batch mechanics (resumable by construction)
- Deterministic shard names embedding the **phase + run token + routed model**
  (`pilot:p3:<run8>:<model>:verses:000`,
  `full:p3:<run8>:<model>:transcript_paragraphs:w01:0003`, with `:retry:` /
  `:esc:` attempt segments) — disjoint from every p1/p2 key AND from any other
  p3 run's keys, so DB rows and `shards/` files can never collide. Each shard's
  id list, **model and pinned prices** are persisted in `tag_batch_jobs` before
  anything is sent; the attempt number is derived from the key.
- Every shard's JSONL input is capped at `SHARD_MAX_INPUT_TOKENS` (default
  400K; renamed from `MAX_SHARD_INPUT_TOKENS`). Our Gemini tier allows at most
  3M enqueued batch tokens at once, so the small cap lets ~6 jobs sit in the
  queue concurrently instead of one 2.5M job blocking every other shard; an
  oversized shard is split into token-bounded parts (`…:p00`, `…:p01`) before
  submission. Each wave **discards and re-plans** shards still in `pending`
  status at the current cap (never touching submitted/retrieved/applied shards),
  so changing the dial takes effect on resume.
- On `RESOURCE_EXHAUSTED` (HTTP 429) when the batch queue is full, submission
  does **not** crash: it polls in-flight jobs every 5 min and retries the create
  once one finishes and frees a slot, draining the whole shard list in waves
  unattended (giving up only after 24h with no job finishing). A queue-full 429
  is expected behaviour, not an error — it logs one short
  `queue full — waiting for space` line per wait cycle, never the JSON error
  body (non-429 errors keep their full bodies).
- While waiting on batch jobs the harness prints a **live progress line every
  30s** — applied passages / total eligible with %, shards done + in flight,
  and real spend so far (e.g. `12,480/244,148 passages (5.1%) · shards 8/53
  done, 2 in flight · $4.20`) — read cheaply from the DB; Google's job states
  are still polled at the existing interval.
- Google job IDs are recorded in `tag_batch_jobs` **before** polling; on
  restart the harness reconciles against Google's job list (by display name)
  so accepted-but-unrecorded jobs are **recovered, never resubmitted**.
- Jobs run server-side up to 24h — close the script after submission and rerun
  `python run_all.py --resume` later to collect and apply.
- **Real token usage is recorded the moment results are RETRIEVED** (one atomic
  UPDATE with the download) — a later apply failure can never erase or defer
  spend, and pilot download-only spend appears in the ledger immediately.
- A shard is marked `applied` only after its whole write transaction commits —
  crash re-runs never double-spend. Every id in the shard gets a row-level
  outcome (`applied` / `invalid` / `missing_response` / `skipped_no_shortlist`);
  schema-valid zero-tag rows get `tags_core = '{}'`.

## Cost ceiling (machine-enforced; per-model pricing)
`MAX_SPEND_USD` in `.env` is a hard ceiling (default **325**): the submitter
tracks real spend (from `usageMetadata`, recorded at retrieval) plus estimates
for in-flight shards and **refuses to submit** past the ceiling — no approvals,
no overrides at runtime. **Real spend counts `candidatesTokenCount` +
`thoughtsTokenCount`** (thinking is billable output; the split is stored per
shard in `tag_batch_jobs`). Batch pricing ships as a **canonical PER-MODEL map
in `config.py`** (`GEMINI_BATCH_PRICES_CANONICAL`: gemini-3.5-flash $0.75/M in
· $4.50/M out; gemini-3-flash-preview $0.25/M in · $1.50/M out); every shard
row records its model + prices at insert, the ledger prices strictly by those
**recorded** per-row prices, and pre-p3 rows are backfilled once (they were all
gemini-3.5-flash). `--doctor` **FAILS** (not warns) if any ROUTED model lacks a
pinned price, a price is ≤ 0 or a known-stale pair, the effective prices differ
from the canonical map (per-model `.env` overrides use the
`GEMINI_BATCH_PRICE_IN_PER_M__<MODEL>` suffix convention and must be mirrored
into the map), or any billed row has no recorded prices. Bakeoff spend counts
against the same ceiling (DB committed + the local state-file ledger).

## Audit storage (never discarded)
- `tag_runs` — run id, the resolved model fingerprint
  (`core=<model>;standard=<model>`), prompt version (`asp-tags-v3.p3-hybrid`),
  vocabulary version, config snapshot (sampling seed, **routing map, per-model
  batch prices, thinkingLevel, temperature provenance, maxOutputTokens,
  splitter version, pilot manifest checksum + cohort + per-route sizes**),
  timestamps. A new run supersedes prior unfinished runs (p1/p2 are frozen,
  their jobs + evidence retained).
- `tag_evidence` — every tag the model returned with the **resolved evidence
  sentence** (our exact copy, not the model's text) + the raw `evidence_sentence_id`,
  accepted or rejected (+ reject reason), the soft-gate `evidence_found` flag, and
  character offsets of the sentence into the passage as sent.
- `tag_passage_outcomes` — **the row-level completion ledger** (v3.p3), one row
  per (run, table, passage): shard key, model, attempt, outcome (`applied` /
  `invalid` / `missing_response` / `skipped_no_shortlist` / `quarantined`),
  failure class, and a `history` jsonb appending every attempt's transition —
  quarantine reports carry the complete error trail. Planning, completion and
  the finalize gate read ONLY this table (id-in-a-shard never counts).

## Safety model (enforced in CODE)
1. **Closed vocabulary**: the responseSchema constrains tags to each passage's
   shortlist enum; anything out of `vocabulary.json` is dropped anyway (HARD).
2. **Evidence by sentence ID, kept soft**: the model cites a sentence ID
   (`S001…`) from the numbered target sentences (the responseSchema constrains it
   to a closed enum of those IDs, so it cannot invent one); our code resolves the
   ID to the exact source sentence + offsets. In-vocabulary tags whose ID doesn't
   resolve are KEPT but flagged `evidence_found=false`; questions are stricter —
   an unresolvable ID drops the question.
3. **New columns only**: `tags_core`, `questions`, `fts_expansion_src`,
   `passage_function` (+ the trigger-derived tsvectors). The old `tags`/`fts`
   and every live `search_*` function are never touched; all schema changes
   are additive (`ADD COLUMN IF NOT EXISTS`), applied via `execute_sql` —
   never `apply_migration`.
4. **Nothing AI-written is ever shown**: questions and evidence stay
   server-side; evidence is our own resolved verbatim sentence, never model text;
   only closed-vocabulary `tags_core` values can ever surface. Tags/questions are
   internal metadata, never doctrine — a wrong tag degrades a ranking, never
   doctrine.

## Deliberately DROPPED (not deferred — do not build)
Editorial boards, double annotation, inter-annotator statistics, confidence
calibration curves, comprehension/user testing, SKOS-RDF/OWL export, a
lexeme/sense layer, utterance-level speaker segmentation (the carry-forward
heuristic stays, imperfect and known), classifier distillation, shadow/canary
infrastructure beyond our columns+flag+preview+revert, and 48 of the 49
proposed beta channels (only `passage_function` was adopted). Reason on
record: those govern systems where the taxonomy IS the public product; here
tags are internal, evidenced, auditable, reversible search scaffolding over
verbatim text.

## Files
```
run_all.py            orchestrator: --doctor / --resume / --yes / --revalidate-pilot
                      / --pilot-only / --bakeoff-model / --bakeoff-route / --accept-quarantine
config.py             .env loading, routed model strings, per-model price map, tuning
tiers.py              v4-tiered: Tier-1 exact aliases + Tier-2 shortlist/banding + calibration + merge + free-tier writer
routing.py            core/standard routing rules + SQL fragments (pure; collapses to 'standard' under v4 PURE_CLASSIFICATION)
db.py                 Session-Pooler psycopg + service-key supabase clients
provenance.json       ⚖ the manifest (single source of truth for gating)
provenance.py         manifest interpreter + transcript speaker walk
vocabulary_seeds.json curated faceted seeds incl. hard-negative contrast pairs (committed)
build_vocabulary.py   seeds + candidates + multi-view clustering + scope notes → vocabulary.json → vocab_terms
tagging.py            shards, Batch submit/reconcile/collect, gates, row outcomes, pilot report, cost ceiling
bakeoff.py            NO-DB-WRITE model bakeoff over the banked p2 pilot (local state + report)
gemini_client.py      models.list confirm (both routed models), File API, Batch API (raw HTTP)
voyage_client.py      term embeddings (voyage-context-4)
backfill_fts_core.py  step 1 (also standalone)
finalize.py           step 5 (also standalone): unresolved-row gate, tsvectors, indexes, hygiene report
sentences.py          deterministic sentence splitter (asp-sentences-v1) for sentence-ID evidence
audit.py              tag_runs / tag_evidence / tag_passage_outcomes DDL + legacy price backfill + run bookkeeping
doctor.py             read-only readiness checklist (per-model pricing, routing census, outcome states)
.env.example          template for scripts/tags-rebuild/.env (git-ignored)
```

## Status (2026-07-20)
- **Harness v4-tiered: DONE** (this change) — three-tier classifier replacing the
  generative pass. Tiers 1–2 (exact aliases + embedding shortlist) are free; Tier 3
  is the LLM judge over the calibrated middle band. `tag_evidence` gains
  `method`+`confidence`; `tags_core` is the merged Tiers 1+2+3 copy; questions +
  `passage_function` DEFERRED. Bakeoff now shares the 5-min queue-wait on 429.
  Free-tiers + calibration were **measured live** (see `PILOT_v4_CALIBRATION.md`):
  T_accept=0.47 (precision 0.800), T_reject=0.22 (retains 0.962); Tier 1 tagged
  1,298/1,722 pilot passages for $0; 1,688 passages (98%) fall to the judge;
  projected full-corpus Tier-3 ≈ $115–215 (< $325). The paid Tier-3 pilot is a
  keyed maintainer step (`python run_all.py --pilot-only`).
- **Pilot-completion fixes (this change):** (1) the pilot report now carries the
  explicit **QUARANTINE listing** required by design — every still-invalid row
  after retry + escalation, with table · passage_id · the full per-attempt
  `finishReason`/`blockReason` history · a passage excerpt, plus the raw signal
  for every `other`-bucketed row; (2) **`--accept-quarantine` is honored in the
  pilot** — it applies Tier-3 for the resolved rows, records the still-invalid
  rows as `quarantined` (UNRESOLVED, never counted complete), recomputes the
  merged `tags_core`, and regenerates the report with real distribution stats +
  the 40 samples (excerpt + tags + method + evidence sentence); (3) the Tier-2
  shortlist width is a config **`TIER2_SHORTLIST_K`** (default 12), and the full
  run widens it to **`TIER2_SHORTLIST_K_FULL`=20** and **recalibrates
  T_accept/T_reject against the k=20 shortlist at full-run start** (same sweep,
  same targets — measured recall ceiling k12=0.719 → k20=0.823).
- **Phase 2 (columns + support tables): DONE** (migration `20260708120000_…`).
- **Phase 3 (fts_core trigger + diacritic fix): mechanism DONE + verified.**
- **Harness v3.p1: DONE**, pilot RAN (run `63c99428…`) and exposed defects.
- **Harness v3.p2: DONE** — canonical batch pricing + thinking-token
  cost accounting + `--doctor` pricing FAIL; `thinkingLevel=LOW`, no reasoning
  field, `maxOutputTokens=8192`, model-default temperature, `not_applicable`
  passage_function; **sentence-ID evidence** (`asp-sentences-v1`) replacing
  quote-copying; **verse_chunks tagged directly** (inheritance removed); raw
  `other`-bucket diagnostics; the fresh 2,000-row validate-before-write pilot.
  The p2 pilot was downloaded (5 shards `retrieved` in `tag_batch_jobs`) but
  never applied — its banked request/result files are the bakeoff baseline.
- **Harness v3.p3-hybrid: DONE** (this change) — TWO-model routing (core
  bg/sb/cc verses+chunks → gemini-3.5-flash; everything else →
  gemini-3-flash-preview) with per-model canonical pricing + per-model
  `--doctor` FAILs; shard keys embed run token + model (no key/file collisions
  across models or runs); **retrieval-time usage recording** (the ledger counts
  every retrieved dollar); **row-level completion** via `tag_passage_outcomes`
  (retry once on own model → escalate standard rows once to core → quarantine,
  listed, never silently complete; `finalize` refuses while unresolved);
  non-overridable `thinkingLevel=LOW` for both models; `MAX_SPEND_USD`
  default 325; the NO-DB-WRITE `--bakeoff-model` mode (verbatim p2 request
  replay + comparison report). The paid `--pilot-only` and `--bakeoff-model`
  runs are maintainer steps on the populated local checkout (need `.env`,
  `vocabulary.json`, and — for the bakeoff — the banked p2 shard files).
- Phase 6 (search wiring + Vercel preview) and Phase 7 (Deep Study) are
  app/SQL work, not in this harness — separate instruction to follow.
