# A3 — Migration ledger repair: approval packet

**Nothing in this document has been applied.** It asks for one decision. No SQL
runs against the production database without a fresh, explicit "yes, apply it"
answering the exact question at the end.

Everything below was read from the live database on 8 August 2026 with read-only
queries. Where a claim is made, the query that established it is shown.

---

## 1. What is wrong

The database has changes its own history does not record.

| | |
|---|---|
| rows in `supabase_migrations.schema_migrations` | **63** |
| newest recorded version | **20260802155648** |
| migration files committed in `supabase/migrations/` | 13 |
| files newer than the newest recorded version | **3** |
| files with no ledger row at any version | **4** |

Four committed migrations have never been recorded. The brief said three; there
is a fourth, from July, that had gone unnoticed.

---

## 2. The four, checked one at a time against what is actually live

### ✅ `20260802223000_transcripts_v3_segment_presence_filter`

The transcripts search function carries the speaker gate.

```sql
select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'search_transcripts_hybrid_batch_v3'
  and pg_get_functiondef(p.oid) ilike '%speaker_only%';
-- → 1
```

**Live state matches the file.** Safe to record as applied.

### ✅ `20260803190000_search_answer_snapshots_metadata`

```sql
select count(*) from information_schema.tables
where table_schema = 'public' and table_name = 'search_answer_snapshots';   -- → 1
select count(*) from information_schema.columns
where table_schema = 'public' and table_name = 'search_answer_snapshots';   -- → 17
```

**Live state matches the file.** Safe to record as applied.

### ✅ `20260803223000_service_role_search_timeout`

```sql
select array_to_string(rolconfig, ' | ') from pg_roles where rolname = 'service_role';
-- → search_path=public, extensions | statement_timeout=20s
```

**Live state matches the file.** Safe to record as applied.

### ⚠️ `20260708120000_tags_fts_rebuild_columns_and_fts_core` — **DID NOT MATCH; FILE NOW CORRECTED**

This is the one that needed work rather than a rubber stamp. Compared against
the live database, the committed file declared substantially more than was ever
run — and it was worse than the columns alone.

| the file declared | live |
|---|---|
| columns `tags_core`, `fts_core`, `fts_expansion`, `fts_expansion_src` | **present** on all five tables |
| columns `tags_ai`, `questions`, `questions_fts` | **absent** on all five tables |
| table `vocab_terms` | **present**, with exactly the declared columns |
| table `tag_batch_jobs` + `idx_tag_batch_jobs_status` | **absent** |
| 5 partial indexes `idx_*_null_tags_core` | **absent** |
| the 5 `trg_*_search_vectors` triggers | **present** |
| trigger lines setting `NEW.questions_fts` | **absent** from both live trigger bodies |

So a trimmed version was applied on 2026-07-08 and a fuller version was
committed. The file described a database that does not exist.

**The database is not harmed by this**, and the reason is worth stating. The live
trigger bodies stop after `fts_core` and `fts_expansion`:

```
new.fts_core := setweight(to_tsvector('english_unaccent', coalesce(new.body_text,'')), 'A');
new.fts_expansion := to_tsvector('english_unaccent', coalesce(new.fts_expansion_src,''));
return new;
```

Had the file's version been applied *without* its columns, every insert and
update on all five content tables would fail. It was not. The database is
internally consistent; the file was wrong.

**Nothing reads the missing columns.** Checked in both directions: none of the 30
live `search_*`/trigger functions references `tags_ai` or `questions_fts`, and
neither does anything in `app/` or `scripts/`.

**One thing the file was right about, in the end.** Its closing note said the GIN
indexes would be built out-of-band by the backfill scripts. All fifteen exist —
`idx_<table>_{fts_core,fts_expansion,tags_core}_gin` on each of the five tables.

#### The correction, already made

`supabase/migrations/20260708120000_tags_fts_rebuild_columns_and_fts_core.sql`
now declares only what was applied. **No database change was made to produce it.**
`tags_ai`, `questions` and `questions_fts` are deliberately NOT created.

```
SHA-256  276ab4fbd938d0e354727122e88503afe63353271bccc3e74cf98c08c929e64e
```

Removed: the three columns, the `tag_batch_jobs` table and its index, the five
partial `null_tags_core` indexes, and the two trigger lines setting
`NEW.questions_fts`. Kept: the four live columns, `vocab_terms`, both trigger
functions as they actually are, and all five triggers. A header records what was
found, when, and why — so the next person to read it is not puzzled by the gap.

`tests/tags-fts-migration-record.test.ts` pins this. It fails if a `questions_fts`
line ever returns to a trigger body, which is the one edit here that could break
production writes.

## 3. What I propose

**Step 1 — correct the record. DONE, and it touched no database.**

The file above now says what actually happened. Hash
`276ab4fbd938d0e354727122e88503afe63353271bccc3e74cf98c08c929e64e`.

The alternative would have been to add the three columns to the database so it
matched the file. It was not taken and is not recommended: nothing reads them,
and adding unused columns to five tables totalling 244,148 rows — one carrying a
1.1 GB index — is real work for no reader.

**Step 2 — record all four as applied. NOT DONE. This is what needs your yes.** One statement, four rows, no schema
change:

```sql
insert into supabase_migrations.schema_migrations (version, name)
values
  ('20260708120000', 'tags_fts_rebuild_columns_and_fts_core'),
  ('20260802223000', 'transcripts_v3_segment_presence_filter'),
  ('20260803190000', 'search_answer_snapshots_metadata'),
  ('20260803223000', 'service_role_search_timeout')
on conflict (version) do nothing;
```

This is exactly what Supabase's own `migration repair --status applied` does.
Verified beforehand: none of these four versions is present, so the statement
inserts four rows and updates nothing.

```sql
select version from supabase_migrations.schema_migrations
where version in ('20260708120000','20260802223000','20260803190000','20260803223000');
-- → 0 rows
```

---

## 4. What this does NOT do

- It does not create, alter or drop a single table, column, index or function.
- It does not re-run any migration. Nothing in those four files executes.
- It does not touch a single row of any content table.
- It cannot change what a devotee sees. The search pipeline never reads this
  table.

## 5. If it goes wrong

Reversible with one statement:

```sql
delete from supabase_migrations.schema_migrations
where version in ('20260708120000','20260802223000','20260803190000','20260803223000');
```

That restores the ledger exactly as it is today — 63 rows, newest
`20260802155648`.

## 6. Afterwards

A dry run should report no unexpected changes. The check is that the ledger's
newest version becomes `20260803223000` and the row count becomes 67, with every
committed file accounted for.

---

## The question

> **Do you approve inserting those four rows into
> `supabase_migrations.schema_migrations`, after the file correction in Step 1
> is merged?**

A "yes" to this exact question, and nothing else, is what I will treat as
approval. Approval given earlier for something else does not count.
