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

### ⚠️ `20260708120000_tags_fts_rebuild_columns_and_fts_core` — **DOES NOT MATCH**

This is the one that needs a decision rather than a rubber stamp.

The file adds **seven** columns to each of the five content tables. Only **four**
of them exist:

| column | in the file | live |
|---|---|---|
| `tags_core` | yes | **yes** |
| `fts_core` | yes | **yes** |
| `fts_expansion` | yes | **yes** |
| `fts_expansion_src` | yes | **yes** |
| `tags_ai` | yes | **no** |
| `questions` | yes | **no** |
| `questions_fts` | yes | **no** |

Identical on all five tables — `verses`, `verse_chunks`, `prose_paragraphs`,
`transcript_paragraphs`, `letter_paragraphs`. So a trimmed version of this
migration was applied, and the fuller version was committed.

**The database is not broken by this.** The live trigger function does not
mention the missing columns either:

```
new.fts_core := setweight(to_tsvector('english_unaccent', coalesce(new.translation,'')), 'A') || …
new.fts_expansion := to_tsvector('english_unaccent', coalesce(new.fts_expansion_src,''));
return new;
```

The file's version of that trigger sets `NEW.questions_fts` from `NEW.questions`.
Had *that* been applied without the columns, every insert and update on those
five tables would fail. It was not. The live database is internally consistent —
it is the committed file that overstates what happened.

**Nothing uses the three missing columns.** Checked in both directions:

- all 30 live `search_*` and trigger functions: none reference `tags_ai` or
  `questions_fts`;
- the application source: no reference in `app/` or `scripts/`.

---

## 3. What I propose

**Step 1 — correct the record, no database change.**

Amend `supabase/migrations/20260708120000_…sql` so it declares what was actually
applied: drop `tags_ai`, `questions` and `questions_fts` from the `ADD COLUMN`
list, and drop the two trigger lines that set `questions_fts`. Add a header note
saying what was found and when. This is a **file edit only** — it touches no
database and can be reviewed in a pull request like any other change.

The alternative is to add the three columns to the database so it matches the
file. I do not recommend it: nothing reads them, and adding unused columns to
five tables totalling 244,148 rows — one of which carries a 1.1 GB index — is
real work for no benefit.

**Step 2 — record all four as applied.** One statement, four rows, no schema
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
