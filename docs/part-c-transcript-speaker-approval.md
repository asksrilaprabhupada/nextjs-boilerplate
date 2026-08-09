# Part C transcript-speaker approval packet

## Status: schema applied and verified; backfill approval ready

This packet records four separate decisions:

1. The additive Supabase schema migration was explicitly approved, applied, and verified.
2. The paragraph backfill is frozen but still awaits its distinct approval marker.
3. The application read-path change was merged by the owner in PR #148.
4. Vercel reported the resulting `main` deployment complete.

None is implied by approval of another. The additive schema change is the only Supabase write performed. No paragraph data write, backfill, index creation, paid call, or agent-initiated merge or production promotion was performed.

Supabase recorded the schema operation as live migration `20260809143133_add_transcript_speaker_names`. The local migration and rollback paths are aligned to that version, and a new complete post-schema read-only scan froze the only packet eligible for backfill approval.

## Observed live facts

- Project: `asksrilaprabhupada` (`wzktlpjtqmjxvragwhqg`), PostgreSQL 17 in `ap-south-1`.
- `public.transcript_paragraphs`: 144,438 rows across 3,703 transcripts.
- Transcript IDs and paragraph numbers are non-null. Every transcript starts at paragraph 1 and is contiguous; the largest has 265 rows.
- Row-level security is enabled and the table remains publicly readable through its current policy.
- `speaker_names` exists as nullable `text[]` with no default. All 144,438 rows remain `NULL`, and no speaker index exists.
- `trg_transcript_search_vectors` now fires before insert or updates of `body_text`, `fts_expansion_src`, or `fts_core` only.
- The live `body_search_vectors_trigger()` raw `pg_proc.prosrc` MD5 is `2b79af99b4080b9c2c0b80ef8a642074`; its `proconfig` is exactly `search_path=public, pg_temp`.
- `scripts/tags-rebuild/backfill_fts_core.py` still deliberately performs `SET fts_core = fts_core`. The narrowed trigger must therefore retain `fts_core` in its update-column list.
- The final post-schema source scan counted 144,438 rows both before and after. It made no database write.

## Data contract

The only new database column is:

```sql
speaker_names text[] NULL
```

Its meanings are fixed:

- `NULL`: not processed.
- `{}`: processed, but no speaker could be proved.
- One name: one proved speaker.
- Multiple names: a mixed paragraph, stored once each in first-appearance order.
- `Speaker not identified` may occur only beside at least one known speaker, representing a genuinely unknown portion of a mixed paragraph.

The mapper reads only `id`, `transcript_id`, `paragraph_number`, and `body_text`. It does not read title, location, date, occasion, or other metadata, and it makes no AI call. It walks one complete transcript at a time, resets state at each transcript boundary, detects speaker boundaries inside rows, carries only the last proved singular speaker through unnamed continuation text, switches immediately on a new proved speaker, and clears inheritance at a plausible but unproved human boundary.

There is no transcript-wide contextual promotion. An ambiguous label cannot become a speaker merely because it repeats or appears between known turns. Non-speech headings such as `Dated`, `Location`, `Audio file`, `Type`, `Translation`, and `Purport` are ignored as metadata rather than fabricated as unknown speech. A composite label is split only when every component is independently proved. Audited aliases normalize `Yaduvara` to `Yadubara` and compact role numbers such as `Guest2` to `Guest (2)`.

The application keeps the existing public `speaker: string | null` field. Its authoritative final refetch selects `speaker_names` from the same row as `body_text` and joins the array with ` · `. It adds no public response field. `NULL`, `{}`, malformed arrays, and arrays containing `Speaker not identified` fail closed to the existing unidentified-speaker presentation.

## Final post-schema read-only evidence

### Identity and artifacts

| Item | SHA-256 |
| --- | --- |
| Canonical corpus input, including `body_text` | `580c6cc9a69d1acaaa4581730ad4c8a1e2aa36d8e3d2585a4f4e4bc8dc049d07` |
| `run-manifest.json` | `11ee0501916f6a124d6b603750fc1234391e668e2a9a90b65a147330c9b60e17` |
| `proposed-mapping.ndjson` | `a5789b46da576f5115ff3ac86bdc9843c4fc0360b1bd7ecc7619aaa53772de0f` |
| `suspicious.ndjson` | `d9a997c4fe8dd8eeb8d1c5d95ac0ecd219bca1383a60ac888f40d53c8c74f8fb` |
| `verification.json` | `7d50bf316dcc86e22cd8c6ed73a267730341a8bb323e9946348ab24e5cc8b386` |

| Artifact | Bytes | Records |
| --- | ---: | ---: |
| `proposed-mapping.ndjson` | 54,434,419 | 144,438 |
| `suspicious.ndjson` | 7,372,029 | 16,589 |
| `verification.json` | 90,007 | 1 JSON object |

The ignored local artifacts contain paragraph IDs, transcript IDs, paragraph numbers, body hashes, ordered arrays, evidence modes, suspicious codes, and proof pointers, but no paragraph body text. An independent scan of the two NDJSON mapping files found zero `body_text`, authorization, API-key, publishable-key, or database-URL fields. Re-validating the packet against the current code reached the approval gate and stopped because no approval marker was supplied.

### Counts

Evidence modes overlap. The four speaker-array categories do not overlap and sum to 144,438.

| Measure | Count |
| --- | ---: |
| Processed paragraphs | 144,438 |
| Processed transcripts | 3,703 |
| Explicit paragraphs | 73,006 |
| Inherited paragraphs | 71,268 |
| Mixed paragraphs | 51,981 |
| Unknown paragraphs | 20,027 |
| Suspicious paragraphs/records | 16,589 |
| Empty arrays | 4,994 |
| Exactly one known speaker | 87,463 |
| Multiple known speakers, no unknown sentinel | 36,909 |
| Known speaker(s) plus `Speaker not identified` | 15,072 |

Array lengths are: 4,994 with zero names; 87,463 with one; 33,166 with two; 14,612 with three; 3,458 with four; 637 with five; 98 with six; 8 with seven; and 2 with eight.

The 16,589 suspicious rows contain 18,088 flags across 1,030 distinct unproved labels. This is an intentional conservative result, not an invitation to infer them automatically. Frequent examples include `Bhagavan`, `Gurukrpa`, `Amogha`, `Radha Vallabha`, `Interviewer`, and `Allen Ginsberg`; each clears inheritance unless it is later added through separately reviewed exact evidence.

### Required fixtures and regression audit

- 1975 target `7a59854c-12f8-47ff-a770-c576aff45fe1`: `{"Śrīla Prabhupāda"}` through inherited proof.
- 1976 target `c8de2aaf-6926-4bf9-b778-51ad1f6293d5`: `{"Śrīla Prabhupāda","Devotees"}` in first-appearance order.
- `Text 3. Translation` regression `859e79b4-b0ad-41ae-ad67-87f02cd39e58`: `{"Śrīla Prabhupāda","Upendra"}`.
- `Twenty-eight` regression `5af17030-6e40-442c-9011-2546631cc0db`: `{"Śrīla Prabhupāda","Viṣṇujana"}`.
- `Text 2. Translation` continuation `b2a5cf44-98f9-4007-85cc-cc1432062df6`: `{"Upendra"}` through inheritance.

The final artifacts store none of these known false labels as speakers: `Surabhīr Abhipālayantam`, `Caraṇāravindam`, `Kuruśreṣṭha`, `Aham`, `Yantra`, `Nitya-siddha`, `Akhila-bandha-muktaye`, `Bahu-sambhavānte`, `Twenty-eight`, `Text 3. Translation`, `Uddhava`, or `Māyā`. Literal `Yaduvara` and `Guest2` also occur zero times because their canonical aliases are stored instead.

Forty-nine exact-name allowlist entries have frozen proof records. Each record contains its proof kind, occurrence count, and up to three source paragraph IDs, transcript IDs, paragraph numbers, line numbers, raw labels, and body hashes without copying body text.

A live read-only back-and-forth sample from transcript `003db473-f0f5-4dfb-ade9-45a54dacbf5d` was compared at paragraphs 1, 20, 30, 50, 71, and 72. The stored arrays match literal first-appearance order, de-duplicate repeated turns, normalize `Indian man(2)`, and preserve the last singular proved speaker.

## Rejected and invalidated candidates

- `a5ce3a7a7589b11a38507f4145eb7a9c006b0ecff0710848bb20100f961480fb`: rejected for promoting glossary, verse, and number labels.
- `ce85030e6f716cf427579472a9e6bd6c88deb002e759cd47996197798c55a7c1`: superseded because many independently audited literal names remained unknown.
- `6210013ccd127caf767e187467165034f7679d4891d89fa30c92c3c46b7529fc`: rejected because new exact names could act as contextual anchors and indirectly promote false labels.
- `49335fd9a0d324cf003bdd701548e92cf482b6853162e9930e7ce8f2b2802e51`: rejected after review found transcript-wide contextual promotion storing verse fragments such as `Surabhīr Abhipālayantam`, `Caraṇāravindam`, and `Kuruśreṣṭha` as ordinary speakers in 95 rows, with no suspicious flag.
- `b0a6952c5ed16bfd9e2a0a683a635a5dae59203532d8440d88fe085b26ece7d9`: invalidated by later strict database-target hardening and must not be used.

None was approved or applied.

## Reviewed files

The manifest directly binds the five operator/schema files and pinned dependencies below. The remaining hashes record the tests and application cutover reviewed alongside them.

| File | SHA-256 |
| --- | --- |
| `scripts/transcript-speakers/mapper.py` | `8c40a3db1d1be0f6ede4f2fa911f72b024131530f937f58468710de048bfbdb3` |
| `scripts/transcript-speakers/backfill.py` | `dd709c9e03a121f00bb2c7832b33d488f74fb9faa8efc775c43fad98cdff32a1` |
| `scripts/transcript-speakers/recompute.py` | `4aad405c2fb3f2a187e6b7bf397b169616e50a64d6c647a78223717a7e154482` |
| `scripts/transcript-speakers/requirements.txt` | `4c1b637f006ca59d6e65c4e090df7166e20b0281ea576ed0baf9939801ce96f8` |
| `supabase/migrations/20260809143133_add_transcript_speaker_names.sql` | `33ed570fdba2facbd8509cf8dcf9ab856e8b6750f4ff17c104636e762b68bb2c` |
| `supabase/rollbacks/20260809143133_leave_transcript_speaker_names_inert.sql` | `a12d330e97c2abd0b532a7e7f813df111ed612c4cc1fa6ffd64d610576dcded5` |
| `scripts/transcript-speakers/tests/screenshot_fixtures.py` | `f2e0d31967733586a42a7d675e05a3680de16aa9475bcee357b7e133dbac0628` |
| `scripts/transcript-speakers/tests/test_mapper.py` | `8f8dbc629c0d51883298b9f0fe99a26b56d186403f50d0a5c7914fba0b451178` |
| `scripts/transcript-speakers/tests/test_backfill.py` | `103ff3a98ea57fbc453992a904effaed5499aef35b714f1cbc33414248ec985f` |
| `scripts/transcript-speakers/tests/test_recompute.py` | `5ee93d6e23b21f99b27034e28a25e334d77ebad9d9c4c33f686f9b54b3011a22` |
| `tests/transcript-speaker-backfill-contract.test.ts` | `c6e6864f7df3dde38d1955304e6ca2c32aea4d56ee74be357a42fd8520da2c54` |
| `app/lib/15-transcript-speakers.ts` | `da1c3198abe5bbd407fb1b515763ce2ed66483b07ba0148b084fcdbfa3befe2f` |
| `app/lib/21-transcript-attribution.ts` | `e1a610de5eead4af3a98d8df3eeeccfad56c98ac1a6bfa55164739aac9c80ede` |
| `app/lib/search-v2/refetch.ts` | `4aebc69f850c531dcd2566e465a4bd10d15d66e91bd1973672d6bda9ec4832e8` |
| `tests/transcript-speaker-filter.test.ts` | `c37d1817838499c5d489212344ff327580ac1a96c07198e7f4234de9efb2d7ab` |
| `tests/search-v2-integration.test.ts` | `8aee023cb190a0d574adbaa7b1f225c45c017ad42f01f976907d7650efde08c5` |

Post-schema alignment verification passes: 65 Python mapper/backfill/recompute tests, the full Vitest suite (437 passed and 1 skipped), type-check, lint (0 errors; 27 pre-existing warnings), production build, changed-file secret scan, final scope review, and diff whitespace check.

## Applied schema packet

Migration SHA-256:

```text
33ed570fdba2facbd8509cf8dcf9ab856e8b6750f4ff17c104636e762b68bb2c
```

Supabase applied this exact migration as version `20260809143133`. Post-apply verification found 144,438 total rows, 144,438 `NULL` speaker arrays, zero processed rows, and zero speaker indexes. The migration:

- runs in one transaction with a 3-second lock timeout and 30-second statement timeout;
- requires the exact table, RLS, live trigger function body, function-level `search_path`, and trigger catalog shape;
- accepts only an absent column or nullable `text[]` with no default;
- adds exactly one column and no index;
- performs no paragraph `INSERT`, `UPDATE`, `DELETE`, or backfill;
- narrows the vector trigger to `BEFORE INSERT OR UPDATE OF body_text, fts_expansion_src, fts_core`;
- verifies column shape, RLS, function, no speaker index, and the exact narrowed trigger before commit; and
- reloads the PostgREST schema cache only after verification.

### Historical migration drift and execution strategy

The live migration ledger has three historical timestamp mismatches:

| Local migration | Matching live version |
| --- | --- |
| `20260705150500_add_query_variants_and_fix_log_search.sql` | `20260705150641` |
| `20260705152000_add_get_verse_context_rpc.sql` | `20260705151533` |
| `20260727120000_search_hybrid_batch_v3.sql` | `20260727203701` |

Therefore never use `supabase db push` for this operation.

Completed execution record:

1. The live column, RLS, index, trigger, raw function hash/config, corpus counts, and migration ledger were rechecked with no drift.
2. The approved SQL SHA-256 was `33ed570fdba2facbd8509cf8dcf9ab856e8b6750f4ff17c104636e762b68bb2c`.
3. One Supabase `apply_migration` call named `add_transcript_speaker_names` succeeded and produced live version `20260809143133`.
4. Catalog verification proved the nullable array shape, RLS, unchanged function fingerprint/config, exact narrowed trigger, zero speaker indexes, and zero processed rows.
5. The local migration/rollback paths and runner references were aligned, tests passed, and the complete post-schema read-only scan produced the final manifest below.

## Backfill controls and load

The initial backfill runner requires all of these before writing:

- explicit `--execute-approved-backfill`;
- an exact manifest-bound approval marker;
- pinned `requests==2.34.2` and `psycopg==3.3.4`;
- an exact Supabase direct host or official session-pooler host/user pair;
- explicit port 5432, database `postgres`, and `sslmode=require` or stronger;
- no conninfo or ambient `hostaddr`, `service`, or `servicefile` routing override;
- the exact approved project ref and schema fingerprint;
- the shared project advisory lock;
- unchanged complete transcript membership, identities, paragraph numbers, body hashes, and existing non-null arrays.

At a 500-row maximum, the current corpus resolves to 309 transcript-complete transactions, averaging about 467 rows. No transcript is split. Every transaction uses bounded lock, statement, and idle timeouts, locks and verifies its complete transcripts, updates only differing `speaker_names`, verifies after writing, commits, and fsyncs a hash-bound ledger record. A rerun verifies and skips the committed ledger prefix.

The first approved attempt stopped before batch 1 with SQLSTATE `57014`. Live
verification immediately afterward found zero processed rows and no apply
ledger, so no partial backfill occurred. The failure was isolated to the two
read-only whole-corpus preflight scans: their cold-cache plan may touch about
144,000 heap/index buffers. The repaired runner gives whole-corpus read-only
preflight and final checks 120 seconds and restores the 30-second limit before
any batch write. The 3-second lock limit, 30-second write limit, 500-row
maximum, mappings, and conflict checks are unchanged.

After all batches, a serializable whole-corpus pass rechecks every identity, body hash, and final array under `FOR SHARE` locks. Corpus writers must be paused or coordinated through the same advisory-lock protocol throughout the mutation window. The final pass is a point-in-time guarantee; non-cooperating writers after it remain an operational risk.

Adding a nullable no-default column is expected to be metadata-only, but replacing the trigger needs a table lock and will fail after 3 seconds rather than wait. Narrowing the trigger prevents 144,438 speaker-only updates from recalculating indexed search vectors while preserving the active `fts_core = fts_core` repair workflow.

Actual elapsed time, WAL, replica lag, contention, and vacuum demand remain unknown until an approved monitored window. Do not increase the reviewed 120-second read-only scan limit, the 30-second write limit, or the batch size without review.

## Verification queries

Immediately after schema and before any backfill:

```sql
SELECT data_type, udt_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'transcript_paragraphs'
  AND column_name = 'speaker_names';

SELECT
  pg_catalog.md5(p.prosrc) AS raw_prosrc_md5,
  p.proconfig
FROM pg_catalog.pg_proc AS p
WHERE p.oid = pg_catalog.to_regprocedure('public.body_search_vectors_trigger()');

SELECT pg_catalog.pg_get_triggerdef(t.oid, true)
FROM pg_catalog.pg_trigger AS t
WHERE t.tgrelid = 'public.transcript_paragraphs'::regclass
  AND t.tgname = 'trg_transcript_search_vectors'
  AND NOT t.tgisinternal;

SELECT count(*) AS speaker_index_count
FROM pg_catalog.pg_index AS i
WHERE i.indrelid = 'public.transcript_paragraphs'::regclass
  AND pg_catalog.strpos(
    pg_catalog.lower(pg_catalog.pg_get_indexdef(i.indexrelid)),
    'speaker_names'
  ) > 0;

SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE speaker_names IS NULL) AS unprocessed_rows
FROM public.transcript_paragraphs;
```

Expected: nullable `_text`/`text[]`, no default; raw function MD5 `2b79af99b4080b9c2c0b80ef8a642074`; `search_path=public, pg_temp`; trigger scoped to `body_text, fts_expansion_src, fts_core`; zero speaker indexes; 144,438 total and 144,438 unprocessed.

After a separately approved backfill:

```sql
SELECT
  count(*) AS total_rows,
  count(*) FILTER (WHERE speaker_names IS NULL) AS unprocessed_rows,
  count(*) FILTER (WHERE cardinality(speaker_names) = 0) AS empty_arrays,
  count(*) FILTER (
    WHERE cardinality(speaker_names) = 1
      AND NOT ('Speaker not identified' = ANY(speaker_names))
  ) AS known_single_only,
  count(*) FILTER (
    WHERE cardinality(speaker_names) > 1
      AND NOT ('Speaker not identified' = ANY(speaker_names))
  ) AS known_multiple_only,
  count(*) FILTER (
    WHERE 'Speaker not identified' = ANY(speaker_names)
  ) AS known_and_unknown,
  count(*) FILTER (
    WHERE cardinality(speaker_names) = 1
      AND 'Speaker not identified' = ANY(speaker_names)
  ) AS invalid_unknown_only
FROM public.transcript_paragraphs;

WITH expected(id, speaker_names) AS (
  VALUES
    ('7a59854c-12f8-47ff-a770-c576aff45fe1'::uuid,
     ARRAY['Śrīla Prabhupāda']::text[]),
    ('c8de2aaf-6926-4bf9-b778-51ad1f6293d5'::uuid,
     ARRAY['Śrīla Prabhupāda', 'Devotees']::text[])
)
SELECT p.id, p.speaker_names,
       p.speaker_names IS NOT DISTINCT FROM e.speaker_names AS passed
FROM expected AS e
JOIN public.transcript_paragraphs AS p USING (id)
ORDER BY p.id;
```

The final post-schema packet expects 144,438 total, zero unprocessed, 4,994 empty, 87,463 known-single-only, 36,909 known-multiple-only, 15,072 known-and-unknown, zero invalid-unknown-only, and both fixtures passing after the separately approved backfill.

## Rollback and interruption

Rollback file SHA-256:

```text
a12d330e97c2abd0b532a7e7f813df111ed612c4cc1fa6ffd64d610576dcded5
```

It intentionally executes no SQL. On interruption:

1. Stop the runner and preserve its artifacts and ledger.
2. Do not cut over the application, or restore the previous application first if necessary.
3. Leave the additive nullable column, reviewed partial arrays, and narrowed trigger in place for audit; `NULL` still identifies unprocessed rows.
4. Resume only if the exact approved packet, ledger, and live rows all reverify.
5. Clearing arrays, dropping the column, broadening the trigger, or overwriting a third-party non-null correction requires a new forward migration and separate approval.

## Future transcript changes

Any insert, edit, deletion, reorder, transcript-ID move, or speaker-boundary correction can alter every later inheritance decision. Recompute all rows of the affected `transcript_id`; for a move, recompute both old and new transcript IDs.

`recompute.py` freezes exactly one complete transcript, with current arrays and desired arrays, before approval. Apply requires:

```text
I_APPROVE_TRANSCRIPT_SPEAKER_RECOMPUTE:<transcript_id>:<manifest_sha256>
```

It accepts only the entire exact frozen-current state or the entire exact desired state. A mixed before/after state or any third value fails closed. It locks all rows, updates in one serializable transaction, verifies after, and supports an idempotent rerun after an uncertain commit result. It never performs a one-row inheritance patch.

## Approval markers

Consumed schema-only marker, bound to the applied migration hash:

```text
I_APPROVE_TRANSCRIPT_SPEAKER_SCHEMA:33ed570fdba2facbd8509cf8dcf9ab856e8b6750f4ff17c104636e762b68bb2c
```

Retired pre-schema evidence marker, recorded only and **not actionable for backfill**:

```text
PRE_SCHEMA_TRANSCRIPT_SPEAKER_MANIFEST:b2befe2c5d8224c399ccd482668d1ec039005a50ed9372349cafd2da61d88170
```

Retired first-attempt marker, recorded only and **not actionable after the
runner timeout repair**:

```text
I_APPROVE_TRANSCRIPT_SPEAKER_BACKFILL:7b2a8d2870a014e84d7bdb727c22c08bffea25bc2e157a72182808c1a758f50e
```

The replacement post-schema backfill marker is:

```text
I_APPROVE_TRANSCRIPT_SPEAKER_BACKFILL:11ee0501916f6a124d6b603750fc1234391e668e2a9a90b65a147330c9b60e17
```

It authorizes only the frozen paragraph backfill. It does not authorize a merge, Vercel deployment, unrelated schema change, paid call, or production promotion.
