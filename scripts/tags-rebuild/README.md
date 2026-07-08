# Tags & FTS Rebuild — offline batch harness

Offline scripts for the search rebuild. They run in the sandbox (or locally), never
on Vercel. See the approved plan for the full reasoning; this is the operational map.

## What the rebuild does (one paragraph)
Replace the broken free-form `tags` (359,433 distinct tags on verses, 89% singletons →
connects nothing) with a **closed, evidence-checked controlled vocabulary** (`tags_core`),
add a hidden **doc2query "questions"** lane, fix the `verse_chunks` diacritic bug, and fuse
meaning + `fts_core` + `fts_expansion` + `questions_fts` + `tags_core` (RRF, then Cohere
rerank) behind a one-env-var flag. Everything goes to **new columns + new functions**; the
old `tags`/`fts`/live search stay intact until a Vercel preview is approved.

## Credentials (from the environment; never committed)
Required: `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `VOYAGE_API_KEY`,
`COHERE_API_KEY`. Optional but recommended for bulk steps: `DATABASE_URL` (direct Postgres
DSN — no PostgREST size limit, no 60s statement cap). Outbound network must reach
`generativelanguage.googleapis.com`, `api.voyageai.com`, `api.cohere.com`, Supabase, and PyPI.
Check readiness: `python -c "import config; print(config.missing_keys())"` → `[]` means ready.

## Setup
```
cd scripts/tags-rebuild
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
```

## Run order (⛔ = stop for maintainer approval)
| # | Script | Phase | Notes |
|---|--------|-------|-------|
| 0 | `python backfill_fts_core.py` | 3 | Finish fts_core on existing rows. Idempotent/resumable. **Runnable now.** |
| 1 | `python build_vocabulary.py` | 1 ⛔ | Stratified sample → MiniBatchKMeans → merge → faceted tree → `vocabulary.json`. Embeds terms into `vocab_terms`. **⛔ approve the vocabulary before tagging.** |
| 2 | `python stage_shortlists.py` | 4 | Per passage: top-30 nearest vocab terms via `embedding <=> embedding_context4` (SQL, free). |
| 3 | `python run_tagging.py --pilot 1000` | 4 ⛔ | One combined Gemini Batch call/passage → `{tags_core+evidence, tags_ai, questions}`; 2 code gates. **⛔ report real cost + quality + gate-yield before the full run.** |
| 4 | `python run_tagging.py --full` | 4 | Sharded, resumable via `tag_batch_jobs`. Writes tags_core/tags_ai/questions + `fts_expansion_src`. |
| 5 | `python finalize_expansion.py` | 5 | Build `fts_expansion` from `fts_expansion_src`; GIN indexes on the new columns. |

Then Phase 6 (search wiring + Vercel preview) and Phase 7 (Deep Study) are app/SQL work,
not in this harness — see the plan.

## Safety model (enforced in CODE — this is the maintainer's automated spot-check)
1. **Closed vocabulary:** a `tags_core` value not in `vocabulary.json` is dropped.
2. **Evidence required:** each `tags_core` tag must carry a sentence that actually appears in
   the passage (lenient fold: lowercase + strip diacritics — looser than the display verbatim
   validator so valid tags aren't over-dropped); else the tag is dropped. Min 4 words.
3. **maxItems caps** in the responseSchema (tags_core ≤6, questions ≤5, tags_ai ≤5).
4. **Bounded + resumable:** each passage tagged once; `tag_batch_jobs` tracks every shard;
   idempotent apply (mark `applied` only after commit) → crash re-runs never double-spend.
5. **Nothing AI-written is ever shown:** `tags_ai`, `questions`, and evidence sentences stay
   out of the client `SearchResults`; only `tags_core` surfaces (existing `tags?` field).

## Status (2026-07-08)
- **Phase 2 (columns + support tables): DONE** — `tags_core/tags_ai/fts_core/fts_expansion/
  fts_expansion_src/questions/questions_fts` on all 5 tables; `vocab_terms` + `tag_batch_jobs`
  created. (migration `20260708120000_...sql`)
- **Phase 3 (fts_core trigger + diacritic fix): mechanism DONE + verified.** Triggers live on
  all 5 tables; diacritic-blindness proven (`sraddha`=`śrāddha`=130; `Krsna`=`Kṛṣṇa`=8834).
  Backfill: verses ✓, verse_chunks ✓; letters/prose partial; transcripts pending →
  **run `backfill_fts_core.py` to finish** (deferred off the MCP because of its 60s cap).
- **Phases 1, 4, 5: pending credentials** (the paid/AI passes). Scripts land here as each is built.
