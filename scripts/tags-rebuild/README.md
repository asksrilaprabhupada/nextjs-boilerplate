# Tags & FTS Rebuild — offline batch harness (v2)

Offline Python harness for the search-data rebuild. Runs locally or in a
sandbox, never on Vercel. One command drives the whole build, resumably.

## What the rebuild does (one paragraph)
Replace the broken free-form `tags` (359,433 distinct tags on verses, 89%
singletons → connects nothing) with a **closed, evidence-checked controlled
vocabulary** (`tags_core`), add a hidden **doc2query "questions"** lane
(HIS-content only), finish the diacritic-blind `fts_core`, and stage
`fts_expansion` + `questions_fts` + GIN indexes. Everything goes to **new
columns + new support tables**; the old `tags`/`fts`/live search stay intact
until the Phase 6 search wiring is approved on a Vercel preview.

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
```

| Step | What happens | Gate |
|---|---|---|
| 1 | `fts_core` backfill — touch rows `WHERE fts_core IS NULL` in batches over `DATABASE_URL`; progress printed; idempotent. Remaining at last snapshot: prose ~29,412 · transcripts ~144,438 · letters ~10,468. | — |
| 2 | Vocabulary build → `vocabulary.json`: faceted (Concepts / Sanskrit / Persons / Places / Scriptures / Practices). Concepts = curated Gauḍīya/Vedabase seeds (`vocabulary_seeds.json`) + chapter titles + `embedding_context4` clustering; Sanskrit facet mined from recurring `synonyms` glosses; every term carries spelling variants (`transliteration_synonyms` + diacritic folding). **Gemini names clusters and organizes the tree only.** Loaded into `vocab_terms` (service key) with Voyage embeddings. | — |
| ⛔ | **THE ONE GATE:** “Review vocabulary.json, then press Enter to continue.” (`--yes` skips.) | ⛔ |
| 3 | Pilot: first stratified 1,000 passages, proportional across the five tables (the `verse_chunks` stratum is fulfilled through parent verses). Auto-validates schema validity, evidence-match rate, tag-count distribution, out-of-vocab rate; saves `pilot-report.md` with the REAL extrapolated cost from `usageMetadata`; **continues automatically** (standing ruling) unless a threshold fails — then it STOPS with the report. | auto |
| 4 | Full tagging: ONE combined structured Gemini Batch call per passage (full **Gemini 3.5 Flash** — never Lite; exact current model string confirmed via the live models list) returns `tags_core` (≤ `MAX_TAGS`, default 12, each with an evidence sentence) **and** the few distinct questions the passage genuinely answers. Code gates drop out-of-vocabulary or unevidenced tags. Provenance gating comes ONLY from `provenance.json`: questions for HIS / Prabhupāda-speaking rows; NOT-HIS rows get topic tags only. `verse_chunks` are never sent. | ceiling |
| 5 | Finalize: `verse_chunks` inherit `tags_core` from parent verses by SQL; tsvector verification; GIN indexes with `CREATE INDEX CONCURRENTLY`, one at a time, `ANALYZE` after each, invalid-index check. | — |

## Provenance manifest — the single source of truth
`provenance.json` encodes the reviewed authorship rules; **the harness gates
only from this manifest — there are no ad-hoc rules in code** (`provenance.py`
just interprets it):
- **NOT-HIS**: prose books `rkd`, `mbk`, `spl`; Śrīmad-Bhāgavatam from Canto 10
  Chapter 14 onward (canto+chapter parsed from `vedabase_url`).
- **MIXED-VERIFY**: `nbs`, `mms`, `bs` — treated as NOT-HIS until verified.
- **Transcripts**: `Name:` speaker prefixes are parsed per paragraph; the last
  named speaker carries forward across prefix-less continuation paragraphs
  within a transcript; a paragraph counts as Prabhupāda-speaking if he is
  among its speakers. Letters are HIS. Unknown book slugs are MIXED-VERIFY.
- **Gating**: questions ONLY for HIS / Prabhupāda-speaking content; everything
  still gets topic tags.

## Batch mechanics (resumable by construction)
- Deterministic shard names (`pilot:verses:000`, `transcript_paragraphs:w01:0003`);
  each shard's id list is persisted in `tag_batch_jobs` before anything is sent.
- Google job IDs are recorded in `tag_batch_jobs` **before** polling; on
  restart the harness reconciles against Google's job list (by display name)
  so accepted-but-unrecorded jobs are **recovered, never resubmitted**.
- Jobs run server-side up to 24h — close the script after submission and rerun
  `python run_all.py --resume` later to collect and apply.
- A shard is marked `applied` only after its whole write transaction commits —
  crash re-runs never double-spend. Rows whose tags all failed the gates get
  `tags_core = '{}'` so they are never resubmitted either.

## Cost ceiling (machine-enforced)
`MAX_SPEND_USD` in `.env` is a hard ceiling: the submitter tracks real spend
(from `usageMetadata`) plus estimates for in-flight shards and **refuses to
submit** past the ceiling — no approvals, no overrides at runtime. Batch
pricing knobs (`GEMINI_BATCH_PRICE_*_PER_M`) should be verified against the
live price sheet and pinned in `.env`; `--doctor` reminds you.

## Audit storage (never discarded)
- `tag_runs` — run id, resolved model string, prompt version, vocabulary
  version (hash of `vocabulary.json`), config snapshot, timestamps.
- `tag_evidence` — every tag the model returned with its evidence sentence,
  accepted or rejected (+ reject reason). Created idempotently by the harness
  over `DATABASE_URL` (this project's `apply_migration` path is not used).

## Safety model (enforced in CODE)
1. **Closed vocabulary**: the responseSchema constrains tags to each passage's
   shortlist enum; anything out of `vocabulary.json` is dropped anyway.
2. **Evidence required**: each tag's sentence must appear in the passage under
   a lenient fold (lowercase + strip diacritics; ≥ 4 words) or the tag drops.
3. **New columns only**: `tags_core`, `questions`, `fts_expansion_src` (+ the
   trigger-derived tsvectors). The old `tags`/`fts` and every live `search_*`
   function are never touched; no migrations are applied by the harness.
4. **Nothing AI-written is ever shown**: questions and evidence stay server-
   side; only closed-vocabulary `tags_core` values can ever surface.

## Files
```
run_all.py            orchestrator: --doctor / --resume / --yes
config.py             .env loading, model strings, tuning, REQUIRED-keys policy
db.py                 Session-Pooler psycopg + service-key supabase clients
provenance.json       ⚖ the manifest (single source of truth for gating)
provenance.py         manifest interpreter + transcript speaker walk
vocabulary_seeds.json curated faceted seeds (committed)
build_vocabulary.py   seeds + chapter titles + clustering + Sanskrit mining → vocabulary.json → vocab_terms
tagging.py            shards, Batch submit/reconcile/collect, gates, pilot report, cost ceiling
gemini_client.py      models.list confirm, File API, Batch API (raw HTTP)
voyage_client.py      term embeddings (voyage-context-4)
backfill_fts_core.py  step 1 (also standalone)
finalize.py           step 5 (also standalone)
audit.py              tag_runs / tag_evidence DDL + run bookkeeping
doctor.py             read-only readiness checklist
.env.example          template for scripts/tags-rebuild/.env (git-ignored)
```

## Status (2026-07-12)
- **Phase 2 (columns + support tables): DONE** (migration `20260708120000_…`).
- **Phase 3 (fts_core trigger + diacritic fix): mechanism DONE + verified.**
  Backfill: verses ✓, verse_chunks ✓; prose/transcripts/letters finish in step 1.
- **This harness (v2)** covers vocabulary → pilot → full tagging → finalize.
  Phase 6 (search wiring + Vercel preview) and Phase 7 (Deep Study) are
  app/SQL work, not in this harness.
