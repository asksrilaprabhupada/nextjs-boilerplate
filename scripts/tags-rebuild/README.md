# Tags & FTS Rebuild — offline batch harness (v3.p2)

Offline Python harness for the search-data rebuild. Runs locally or in a
sandbox, never on Vercel. One command drives the whole build, resumably.
v3 = the consolidated correction pass folding three independent research
reviews into the v2 harness. **v3.p2** freezes the v3.p1 pilot and corrects the
defects it exposed: canonical batch pricing with thinking-token cost accounting,
`thinkingLevel=LOW` + no free-text reasoning field, **sentence-ID evidence**
(no quote-copying), **direct verse_chunks tagging** (no inheritance), raw
failure diagnostics, and a fresh validate-before-write pilot with a one-shot
retry to 100%.

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
`GEMINI_API_KEY`, `VOYAGE_API_KEY`. Set `MAX_SPEND_USD` too (suggested 500).

## Run
```
python run_all.py             # the whole build; stops once, at the ⛔ vocabulary gate
python run_all.py --resume    # rerun after Ctrl+C / crash / next day — continues in place
python run_all.py --yes       # skip the ⛔ gate (maintainer's standing one-shot ruling)
python run_all.py --pilot-only # run ONLY the v3.p2 pilot (validate files → retry once →
                              # apply on a 100% + distribution pass) then STOP before the
                              # full corpus run. Requires vocabulary.json already built.
python run_all.py --doctor    # green/red checklist: keys, model string, pooler, counts,
                              # + FAILS on absent/stale batch pricing
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
| 3 | Pilot (**v3.p2**): an EXACT **2,000-row manifest** = ALL p1-failures + a p1-success comparison slice (matched to the failure table mix + length quartile) + a fresh remainder stratified across all five tables × length quartiles by largest-remainder allocation (checksum recorded in `tag_runs.config`). Results are **validated locally BEFORE any DB write**: first-pass schema validity ≥ **99.5%**, then every schema-invalid row is **retried once** and **100%** is required; distribution gates (OOV ≤ .02 · distinct tags ≥ 100 · singleton ≤ 20% · ≥ 60% vocab used · no tag on > 20% of passages · median 3–8 among TAGGED) run on the files too. Only on a full pass are all 2,000 rows applied in **one atomic transaction** (p2 overwrites p1's pilot content writes; p1 evidence is retained under its run_id). `pilot-report.md` gets first-pass-vs-post-retry validity, the raw `finishReason`/`blockReason` for every `other` failure, the TRUE cost (thinking INCLUDED) + honest full-run extrapolation across all five tables, and 40 samples. `--pilot-only` runs just this and stops. | auto |
| 4 | Full tagging: ONE combined structured Gemini Batch call per passage (full **Gemini 3.5 Flash** — never Lite) with `thinkingConfig.thinkingLevel=LOW` and the model-default temperature returns `passage_function` (closed enum, incl. `not_applicable`), `tags_core` (≤ `MAX_TAGS`) and 0-3 `questions` — **evidence is a sentence ID** drawn from the numbered target sentences (deterministic splitter `asp-sentences-v1`), resolved back to the exact source sentence + offsets (the model never copies text). Candidate shortlist = semantic top-25 ∪ exact alias matches ∪ hard-negative partners, cap ~40. Stance rules: aboutness only; entities only when prominent; ZERO tags valid. Gates: out-of-vocabulary → HARD drop; in-vocab unresolvable-id → KEPT, `evidence_found=false`; unevidenced question → dropped. **`verse_chunks` are tagged DIRECTLY** (target chunk numbered; parent-verse translation + adjacent chunks as un-numbered context; evidence must come from the target). Coverage is **run_id-scoped**, so p2 retags every eligible row. | ceiling |
| 5 | Finalize: tsvector verification; GIN indexes with `CREATE INDEX CONCURRENTLY`, one at a time, `ANALYZE` after each, invalid-index check; **hygiene report** (`hygiene-report.md`: 0 uses / < 20 uses / > 15% of corpus — report only, nothing auto-deleted); completion checklist incl. the Supabase compute downgrade reminder (LARGE → MICRO, ~$110/month). *(v3.p2: no verse_chunks inheritance step — chunks are tagged directly.)* | — |

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
- Deterministic shard names (`pilot:verses:000`, `transcript_paragraphs:w01:0003`);
  each shard's id list is persisted in `tag_batch_jobs` before anything is sent.
- Every shard's JSONL input is capped at `MAX_SHARD_INPUT_TOKENS` (2.5M). Our
  Gemini tier allows at most 3M enqueued batch tokens at once, so an oversized
  shard is split into token-bounded parts (`…:p00`, `…:p01`) before submission —
  each job always fits the queue.
- On `RESOURCE_EXHAUSTED` (HTTP 429) when the batch queue is full, submission
  does **not** crash: it polls in-flight jobs every 5 min and retries the create
  once one finishes and frees a slot, draining the whole shard list in waves
  unattended (giving up only after 24h with no job finishing).
- Google job IDs are recorded in `tag_batch_jobs` **before** polling; on
  restart the harness reconciles against Google's job list (by display name)
  so accepted-but-unrecorded jobs are **recovered, never resubmitted**.
- Jobs run server-side up to 24h — close the script after submission and rerun
  `python run_all.py --resume` later to collect and apply.
- A shard is marked `applied` only after its whole write transaction commits —
  crash re-runs never double-spend. Rows whose tags all failed the hard gate
  get `tags_core = '{}'` so they are never resubmitted either.

## Cost ceiling (machine-enforced)
`MAX_SPEND_USD` in `.env` is a hard ceiling: the submitter tracks real spend
(from `usageMetadata`) plus estimates for in-flight shards and **refuses to
submit** past the ceiling — no approvals, no overrides at runtime. **Real spend
counts `candidatesTokenCount` + `thoughtsTokenCount`** (thinking is billable
output; the split is stored per shard in `tag_batch_jobs`). Batch pricing
(`GEMINI_BATCH_PRICE_*_PER_M`) ships as **canonical constants in `config.py`**
($0.75/M in · $4.50/M out for Gemini 3.5 Flash Batch); `--doctor` **FAILS** (not
warns) if the effective prices are absent (≤0), the known v3.p1 placeholder
(0.15/1.25), or differ from the code canonical — an `.env` override must be
mirrored into the canonical constants.

## Audit storage (never discarded)
- `tag_runs` — run id, resolved model string, prompt version (`asp-tags-v3.p2`),
  vocabulary version, config snapshot (sampling seed, **pricing, thinkingLevel,
  temperature provenance, maxOutputTokens, splitter version, pilot manifest
  checksum + cohort sizes**), timestamps. A new run supersedes prior unfinished
  runs (p1 is frozen, its jobs + evidence retained).
- `tag_evidence` — every tag the model returned with the **resolved evidence
  sentence** (our exact copy, not the model's text) + the raw `evidence_sentence_id`,
  accepted or rejected (+ reject reason), the soft-gate `evidence_found` flag, and
  character offsets of the sentence into the passage as sent.

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
config.py             .env loading, model strings, tuning, REQUIRED-keys policy
db.py                 Session-Pooler psycopg + service-key supabase clients
provenance.json       ⚖ the manifest (single source of truth for gating)
provenance.py         manifest interpreter + transcript speaker walk
vocabulary_seeds.json curated faceted seeds incl. hard-negative contrast pairs (committed)
build_vocabulary.py   seeds + candidates + multi-view clustering + scope notes → vocabulary.json → vocab_terms
tagging.py            shards, Batch submit/reconcile/collect, gates, pilot report, cost ceiling
gemini_client.py      models.list confirm, File API, Batch API (raw HTTP)
voyage_client.py      term embeddings (voyage-context-4)
backfill_fts_core.py  step 1 (also standalone)
finalize.py           step 5 (also standalone): tsvectors, indexes, hygiene report, checklist
sentences.py          deterministic sentence splitter (asp-sentences-v1) for sentence-ID evidence
audit.py              tag_runs / tag_evidence DDL (+ additive passage_function) + run bookkeeping
doctor.py             read-only readiness checklist
.env.example          template for scripts/tags-rebuild/.env (git-ignored)
```

## Status (2026-07-18)
- **Phase 2 (columns + support tables): DONE** (migration `20260708120000_…`).
- **Phase 3 (fts_core trigger + diacritic fix): mechanism DONE + verified.**
- **Harness v3.p1: DONE**, pilot RAN (run `63c99428…`) and exposed defects.
- **Harness v3.p2: DONE** (this change) — canonical batch pricing + thinking-token
  cost accounting + `--doctor` pricing FAIL; `thinkingLevel=LOW`, no reasoning
  field, `maxOutputTokens=8192`, model-default temperature, `not_applicable`
  passage_function; **sentence-ID evidence** (`asp-sentences-v1`) replacing
  quote-copying; **verse_chunks tagged directly** (inheritance removed); raw
  `other`-bucket diagnostics; the fresh 2,000-row validate-before-write pilot
  (all p1-failures + matched successes + quartile-stratified fresh, retry-once to
  100%, atomic apply) behind `--pilot-only`; run isolation freezes p1. The paid
  `--pilot-only` run is a maintainer step on the populated local checkout (needs
  `.env` + `vocabulary.json`). Additive columns (`cost_candidate_tok`,
  `cost_thought_tok`, `evidence_sentence_id`) are created by the harness at run time.
- Phase 6 (search wiring + Vercel preview) and Phase 7 (Deep Study) are
  app/SQL work, not in this harness — separate instruction to follow.
