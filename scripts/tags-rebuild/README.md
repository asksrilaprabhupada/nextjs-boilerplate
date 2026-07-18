# Tags & FTS Rebuild — offline batch harness (v3)

Offline Python harness for the search-data rebuild. Runs locally or in a
sandbox, never on Vercel. One command drives the whole build, resumably.
v3 = the consolidated correction pass folding three independent research
reviews into the v2 harness, applied BEFORE the paid tagging run.

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
python run_all.py --doctor    # green/red checklist: keys, model string, pooler, counts
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
| 3 | Pilot: **2,000 seeded-random stratified passages** (the `verse_chunks` stratum is fulfilled through parent verses). Auto-gates: schema validity ≥ .98 · OOV ≤ .02 · evidence-found rate REPORTED (not gated) · distinct tags ≥ 100 · singleton share ≤ 20% · ≥ 60% of vocabulary used · no tag on > 15% of passages · median 3–8 among TAGGED passages (zero-tag passages are valid, excluded, and never gated on a minimum). `pilot-report.md` gets the REAL extrapolated cost from `usageMetadata` + 30 random passage→tags→evidence samples. Auto-continues on pass (standing ruling); STOPS with the report on fail. | auto |
| 4 | Full tagging: ONE combined structured Gemini Batch call per passage (full **Gemini 3.5 Flash** — never Lite; exact current model string confirmed via the live models list) returns free-text `reasoning` FIRST (mitigates the constrained-decoding format tax), then `passage_function` (closed enum), `tags_core` (≤ `MAX_TAGS`, evidence sentence each) and 0-3 evidenced `questions`. Candidate shortlist = semantic top-25 ∪ exact alias matches in the passage ∪ hard-negative partners (both sides of every contrast pair), cap ~40; each candidate shows its scope note + "do NOT confuse with". Stance rules: aboutness only — no passing mentions, no opponent quotes, no rejected-view-as-endorsed; entities only when prominent; most-specific concepts, no ancestor padding; ZERO tags valid. Gates: out-of-vocabulary → HARD drop; in-vocab unevidenced → KEPT, flagged `evidence_found=false` (offsets stored for matches); unevidenced question → dropped. Provenance gating comes ONLY from `provenance.json`. `verse_chunks` are never sent. | ceiling |
| 5 | Finalize: `verse_chunks` inherit `tags_core` + `passage_function` from parent verses by SQL; tsvector verification; GIN indexes with `CREATE INDEX CONCURRENTLY`, one at a time, `ANALYZE` after each, invalid-index check; **hygiene report** (`hygiene-report.md`: 0 uses / < 20 uses / > 15% of corpus — report only, nothing auto-deleted); completion checklist incl. the Supabase compute downgrade reminder (LARGE → MICRO, ~$110/month). | — |

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
submit** past the ceiling — no approvals, no overrides at runtime. Batch
pricing knobs (`GEMINI_BATCH_PRICE_*_PER_M`) should be verified against the
live price sheet and pinned in `.env`; `--doctor` reminds you.

## Audit storage (never discarded)
- `tag_runs` — run id, resolved model string, prompt version, vocabulary
  version (hash of `vocabulary.json`), config snapshot (incl. the sampling
  seed), timestamps.
- `tag_evidence` — every tag the model returned with its evidence sentence,
  accepted or rejected (+ reject reason), the soft-gate `evidence_found` flag,
  and character offsets of matched evidence into the passage as sent.

## Safety model (enforced in CODE)
1. **Closed vocabulary**: the responseSchema constrains tags to each passage's
   shortlist enum; anything out of `vocabulary.json` is dropped anyway (HARD).
2. **Evidence checked, kept soft**: each tag's sentence is searched in the
   passage under a lenient fold (lowercase + strip diacritics; ≥ 4 words).
   In-vocabulary misses are KEPT but flagged `evidence_found=false` — abstract
   doctrinal themes often have no single quotable sentence, and strict-drop
   preferentially deletes the best tags. Questions are stricter: no answer
   span in the passage → the question drops.
3. **New columns only**: `tags_core`, `questions`, `fts_expansion_src`,
   `passage_function` (+ the trigger-derived tsvectors). The old `tags`/`fts`
   and every live `search_*` function are never touched; all schema changes
   are additive (`ADD COLUMN IF NOT EXISTS`), applied via `execute_sql` —
   never `apply_migration`.
4. **Nothing AI-written is ever shown**: reasoning is discarded; questions and
   evidence stay server-side; only closed-vocabulary `tags_core` values can
   ever surface. Tags/questions are internal metadata, never doctrine — a
   wrong tag degrades a ranking, never doctrine.

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
finalize.py           step 5 (also standalone): inheritance, indexes, hygiene report, checklist
audit.py              tag_runs / tag_evidence DDL (+ additive passage_function) + run bookkeeping
doctor.py             read-only readiness checklist
.env.example          template for scripts/tags-rebuild/.env (git-ignored)
```

## Status (2026-07-16)
- **Phase 2 (columns + support tables): DONE** (migration `20260708120000_…`).
- **Phase 3 (fts_core trigger + diacritic fix): mechanism DONE + verified.**
  Backfill: verses ✓, verse_chunks ✓; prose/transcripts/letters finish in step 1.
- **Harness v3 corrections: DONE** (this folder) — seed surgery + Sanskrit-facet
  dissolution, seeded sampling, clustering-as-lenses + merge proposals,
  candidates path, scope notes, entities-lite, candidate-union shortlist,
  reasoning-first schema, stance rules, soft evidence gate + offsets,
  evidenced questions (0-3), passage_function, pilot 2,000 + distribution
  gates, hygiene report. `passage_function` + `tag_evidence` soft-gate columns
  already applied to the live DB (additive, via execute_sql).
- Phase 6 (search wiring + Vercel preview) and Phase 7 (Deep Study) are
  app/SQL work, not in this harness — separate instruction to follow.
