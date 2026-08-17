# halfvec: what the database actually says

Read-only report. **Nothing was changed.** Every figure below was measured
against the live project on 17 August 2026, not estimated, except where it is
explicitly labelled a derivation.

---

## The short version

The indexes are 1,907 MiB against 1,024 MiB of `shared_buffers`. That much is
as suspected, and it is the real reason searching is slow.

But the interesting number is not the total. It is this:

**Every one of the five HNSW indexes occupies exactly one 8 KiB page per
indexed row.** Not approximately — 1.0000 pages per row, on all five.

```
244,148 rows × 8,192 bytes = 1,999,900,672 bytes
measured total                1,999,994,880 bytes
```

That changes the shape of the question. The index size today is not
proportional to the vector payload at all; it is `rows × one page`. So halving
the bytes per vector buys **nothing whatsoever** unless it changes how many
elements fit in a page — from one to two. It is not a smooth 50% saving. It is
a threshold, and the whole decision turns on which side of it we land.

The derivation below says we land on the good side, with room to spare. But a
derivation is not a measurement, and the one experiment that settles it is
cheap and reversible.

---

## 1. Current state, measured

### Columns, indexes and operator classes

All five columns are `vector(1024)`. All five indexes are HNSW with
`m=32, ef_construction=256`, and — confirmed rather than assumed —
**all five use `vector_ip_ops`**:

| index | table | index size | table size | rows | pages | pages/row |
|---|---|---:|---:|---:|---:|---:|
| `idx_transcript_paragraphs_ctx4_hnsw` | transcript_paragraphs | **1,128 MiB** | 294 MiB | 144,438 | 144,439 | 1.0000 |
| `idx_prose_paragraphs_ctx4_hnsw` | prose_paragraphs | 284 MiB | 55 MiB | 36,412 | 36,411 | 1.0000 |
| `idx_verses_ctx4_hnsw` | verses | 196 MiB | 46 MiB | 25,131 | 25,132 | 1.0000 |
| `idx_letter_paragraphs_ctx4_hnsw` | letter_paragraphs | 152 MiB | 30 MiB | 19,468 | 19,469 | 1.0001 |
| `idx_verse_chunks_ctx4_hnsw` | verse_chunks | 146 MiB | 30 MiB | 18,699 | 18,689 | 0.9995 |
| **total** | | **1,907 MiB** | 455 MiB | 244,148 | | |

Index definition, identical in shape across all five:

```sql
CREATE INDEX idx_transcript_paragraphs_ctx4_hnsw
  ON public.transcript_paragraphs
  USING hnsw (embedding_context4 vector_ip_ops)
  WITH (m='32', ef_construction='256')
```

### `halfvec_ip_ops` is available and is the matching choice

Verified, not assumed — the operator class exists for the `hnsw` access method:

| access method | operator class | input type |
|---|---|---|
| hnsw | `halfvec_cosine_ops` | halfvec |
| hnsw | **`halfvec_ip_ops`** | halfvec |
| hnsw | `halfvec_l1_ops` | halfvec |
| hnsw | `halfvec_l2_ops` | halfvec |

`vector_ip_ops` → `halfvec_ip_ops` is a like-for-like swap of the distance
operator. pgvector is 0.8.0 on PostgreSQL 17.4 (aarch64).

### Environment

| | |
|---|---|
| `shared_buffers` | 1,024 MiB |
| indexes ÷ shared_buffers | **1.86×** |
| `maintenance_work_mem` | 256 MiB |
| `max_parallel_maintenance_workers` | 1 |
| database size | 4,711 MiB |
| region | ap-south-1 |

---

## 2. The embeddings are normalised — so half precision is the low-risk case

2,000 sampled vectors, 400 from each table:

| source | sampled | min ‖v‖ | max ‖v‖ | off unit by >1e-4 |
|---|---:|---:|---:|---:|
| letter_paragraphs | 400 | 0.999999892 | 1.000000130 | 0 |
| prose_paragraphs | 400 | 0.999999819 | 1.000000117 | 0 |
| transcript_paragraphs | 400 | 0.999999858 | 1.000000126 | 0 |
| verse_chunks | 400 | 0.999999884 | 1.000000116 | 0 |
| verses | 400 | 0.999999876 | 1.000000148 | 0 |

Every vector is unit length to within 1.5 × 10⁻⁷. Two consequences:

1. **Inner product and cosine rank identically.** The `_ip_ops` choice is
   already equivalent to cosine, so nothing about the distance metric changes.
2. **Half precision is genuinely low risk here.** float16 carries ~3 decimal
   digits with a relative error around 5 × 10⁻⁴. On unit vectors the dot
   product is bounded in [-1, 1], so the absolute error in a score is of the
   same order — far below the gaps that separate a relevant passage from an
   irrelevant one, and the reranker re-judges the survivors anyway. The risk is
   confined to near-ties deep in the candidate list, which the cross-encoder
   then re-orders regardless.

If the vectors had *not* been normalised the risk profile would be different —
inner product would be sensitive to magnitude, and quantisation error would
scale with it. They are, so it is not.

---

## 3. Every place the query vector is cast — 15 sites, and only 5 matter

Three per function, identical across all five:

| # | site | uses the index? |
|---|---|---|
| 1 | `... \|\| ']')::extensions.vector` — builds `q.emb` from the JSON argument | no |
| 2 | `(-1.0 * (t.embedding_context4 OPERATOR(extensions.<#>) q.emb))::double precision AS score` | no — a projection |
| 3 | `ORDER BY t.embedding_context4 OPERATOR(extensions.<#>) q.emb` | **yes** |

**Site 3 is the one that decides everything for Option B.** For an expression
index the planner matches the `ORDER BY` expression against the index
expression *structurally*. If even one of the five functions does not match, that
lane silently falls back to a sequential scan over its whole table — no error,
no warning, just a slow lane and a search that got worse for no visible reason.

Under Option B all three sites change together in each function: `q.emb` must
become a `halfvec(1024)`, and site 3 must read exactly as the index expression
does. Site 2 must change too or it will re-read the full-precision column and
undo the point of the exercise.

---

## 4. Will it actually shrink? The threshold, derived

**Do not expect a smooth halving.** Here is what the page arithmetic says.

Today, per row:

| | bytes |
|---|---:|
| vector payload (1024 × float4) | 4,096 |
| element tuple header (approx.) | ~64 |
| neighbour tuple, m=32 (approx.) | ~700 |
| **element + neighbours** | **~4,860** |
| usable page (8,192 − header − line pointers) | ~8,140 |

One fits. Two would need 9,720. Hence **exactly one page per row**, which is
what all five indexes measure — the model and the measurement agree, which is
the reason to trust the model for the next step.

With `halfvec(1024)`:

| | bytes |
|---|---:|
| vector payload (1024 × float2) | 2,048 |
| element tuple header (approx.) | ~64 |
| neighbour tuple, m=32 (approx.) | ~700 |
| **element + neighbours** | **~2,812** |
| two per page | 5,624 ≤ 8,140 ✓ |
| three per page | 8,436 > 8,140 ✗ |

**Two per page.** Which gives, if the derivation holds:

| index | now | derived after | saving |
|---|---:|---:|---:|
| transcripts | 1,128 MiB | **~564 MiB** | 564 MiB |
| prose | 284 MiB | ~142 MiB | 142 MiB |
| verses | 196 MiB | ~98 MiB | 98 MiB |
| letters | 152 MiB | ~76 MiB | 76 MiB |
| verse chunks | 146 MiB | ~73 MiB | 73 MiB |
| **total** | **1,907 MiB** | **~953 MiB** | **~954 MiB** |

That lands at the bottom of the 570–700 MiB expectation for transcripts, and it
would bring the whole index set to 953 MiB against 1,024 MiB of
`shared_buffers` — **under the line, for the first time.**

**But the neighbour-tuple figure is the one number I could not measure.** It is
the difference between two elements per page and one, which is the difference
between halving the index and saving nothing at all. `pgstattuple` and
`pageinspect` are both available on this project but **not installed**, and
installing an extension is a database change, so this report does not do it.
Installing `pgstattuple` would settle the question for the cost of one
`CREATE EXTENSION` — worth asking for before spending anything larger.

---

## 5. Disk headroom

**What I can measure:** the database is 4,711 MiB, of which 1,907 MiB is these
five HNSW indexes and 455 MiB is the five tables.

**What I cannot measure from SQL:** the size of the provisioned volume, and
therefore the free space on it. That is a dashboard figure. Please read it
before approving any build, and compare against the peaks below.

Peak **additional** space required, worst case (index does not shrink) and best
case (it halves):

| operation | additional peak, worst | additional peak, best |
|---|---:|---:|
| one shadow index on transcripts (Option B, one table) | ~1,430 MiB | ~865 MiB |
| all five expression indexes (Option B, full) | ~2,200 MiB | ~1,250 MiB |
| `ALTER COLUMN TYPE` on transcripts (Option A) | ~1,720 MiB | ~1,160 MiB |

Each figure is the new index, plus the build's temporary spill, plus — for
Option A — a second copy of the table during the rewrite. The build spills
because the HNSW graph does not fit in `maintenance_work_mem`: the transcripts
element data alone is ~296 MiB as halfvec against 256 MiB available, so the
build will use the two-phase on-disk path rather than staying in memory.

These are somewhat higher than the ~2.5 GB / ~2.85 GB figures in the brief. The
difference is that the brief's numbers look like totals; these are *additional*
peaks on top of the 1,907 MiB already committed, and they include the worst case
where the index does not shrink at all.

---

## 6. Three options, honestly compared

### Option A — `ALTER COLUMN TYPE halfvec(1024)`

Rewrites the table, takes an `ACCESS EXCLUSIVE` lock, rebuilds every index on
it.

- **Outage:** total unavailability of that table for the whole rewrite *and*
  index rebuild. The table rewrite is quick (294 MiB); the HNSW rebuild is the
  cost. At `m=32, ef_construction=256` on **one** parallel maintenance worker,
  144,438 rows plausibly takes **5–15 minutes** for transcripts, and a few
  minutes more for the other four.
- **I will not pretend that estimate is solid.** The honest way to get the
  number is to time the Option B shadow build first, which measures exactly the
  thing this estimate is guessing at. That is a reason to do B before A even if
  A is where you want to end up.
- **Rollback:** `ALTER COLUMN TYPE vector(1024)` back, and another full index
  rebuild — a second outage of the same length. Rollback is not cheap.
- Reads the whole table and rewrites it, so it needs the disk in section 5.

### Option B — expression index, built concurrently

```sql
CREATE INDEX CONCURRENTLY idx_transcript_paragraphs_ctx4_hnsw_half
  ON public.transcript_paragraphs
  USING hnsw ((embedding_context4::halfvec(1024)) halfvec_ip_ops)
  WITH (m='32', ef_construction='256');
```

Touches no column. Rolls back with one `DROP INDEX CONCURRENTLY`. Our problem
is index size rather than table size, so this gets the benefit at a fraction of
the risk.

Being accurate about the trade-offs, because "concurrently" is often read as
"free":

- It does **not** block ordinary reads and writes for the build.
- It **does** take coordination locks briefly at the start and end, and it
  waits for existing transactions to finish. A long-running transaction will
  stall it indefinitely.
- It **cannot** run inside a transaction block, so it cannot be wrapped in a
  migration that rolls back atomically.
- It **can** fail and leave an `INVALID` index behind, which is dead weight
  until dropped and must be verified before anything depends on it.
- It builds a **second** index while the first still exists — so during the
  build that table carries both, which is the disk figure in section 5.
- **The subtle failure mode is the one that matters:** if the `ORDER BY`
  expression in even one of the five functions does not match the index
  expression, the planner silently ignores the index and that lane falls back
  to a sequential scan. No error. `EXPLAIN` on all five cast sites is not
  optional; it is the acceptance test.

### Option C — buy more memory

Instant, instantly reversible, no migration, no recall testing, no risk to
correctness at all. `shared_buffers` is currently 1,024 MiB, which is the
Supabase **Medium** compute size (4 GB RAM, 2 cores — the same two cores that
rule out parallel sources). The next size up doubles RAM to 8 GB and
`shared_buffers` to roughly 2 GB, which is more than the 1,907 MiB the indexes
occupy today. The memory problem simply stops existing.

**Cost:** I cannot read your billing from here, so I will not state a figure as
though I had. Supabase's published list price for the Medium → Large compute
step is on the order of **$50–60 more per month**, and the exact number for
`ap-south-1` is on your project's billing page under Compute. Please confirm it
there rather than from this sentence.

That is the honest comparison the brief asked for: roughly $50–60 a month, with
zero engineering risk, against a day of migration work and a recall-testing
exercise that saves the same 950 MiB. If the site is going to grow past 8 GB
of index eventually then B is worth doing anyway — but B and C are not
either/or, and C is the one that can be tried this afternoon and undone this
evening.

---

## 7. Migration and rollback, per option

### Option A
1. Announce the outage. `ALTER TABLE ... ALTER COLUMN embedding_context4 TYPE halfvec(1024)`.
2. Rebuild the HNSW index with `halfvec_ip_ops`.
3. Rewrite all three cast sites in that table's `_v3` function.
4. `NOTIFY pgrst, 'reload schema'`.
5. **Rollback:** reverse the column type, rebuild the index, revert the function. A second outage of the same length.

### Option B
1. `CREATE INDEX CONCURRENTLY ... USING hnsw ((embedding_context4::halfvec(1024)) halfvec_ip_ops)`.
2. Verify it is `indisvalid` — a concurrent build can fail and leave an invalid index.
3. `pg_relation_size` it. This is the measurement the whole report is waiting on.
4. Rewrite the three cast sites so the `ORDER BY` matches the index expression **character for character**, using the same anchored-substitution-plus-byte-for-byte-reversal technique as the budget migrations.
5. `EXPLAIN` every one of the five cast sites and confirm an index scan, not a sequential scan. This is the acceptance test, not a formality.
6. Run the 65 gold questions against old and new; report recall and latency.
7. **Rollback:** revert the functions, then `DROP INDEX CONCURRENTLY`. The old index was never touched, so this is genuinely a return to today's state.

### Option C
1. Change the compute size in the dashboard. One restart.
2. **Rollback:** change it back. One restart.

---

## 8. What I recommend, and what I am not deciding

Install `pgstattuple` (one `CREATE EXTENSION`, trivially reversible) and read
the real free space per page. That converts section 4's derivation into a
measurement and costs almost nothing. If it says two elements will fit per
page, Option B's shadow build is worth running and will halve the indexes. If
it says they will not, halfvec saves nothing here and Option C is the only real
answer.

Either way, **Option C is worth pricing seriously.** A month of the larger
compute costs less than the engineering time this migration will take, it is
reversible in one restart, and it cannot make a single answer worse.

None of the above is a decision. This report changes nothing and asks for
nothing except the next yes.
