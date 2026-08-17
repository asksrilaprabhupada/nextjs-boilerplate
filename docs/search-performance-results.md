# Search performance results

One row per benchmark run, appended never rewritten. The point is to end up with
a history instead of another argument.

**The three benchmark questions are fixed** in `tests/gold/benchmark-questions.json`
and must not be swapped. A later job that wants a different question adds a
fourth; changing one of these silently resets every comparison ever made against
this table.

## How a run is done

Thirteen searches. One search of question 1 alone after at least 30 minutes
idle — **that single run is the cold number, and nothing else may be called
cold.** By the second question the shared indexes are already partly resident.
Then four rounds, each round being question 1, then 2, then 3, in order.

Report per question: the cold number once, and the **median** of the four warm
runs. Cold and warm are never averaged together.

## Rules

- **Stop-loss.** If a run shows the warm median more than 10% worse than the
  previous recorded baseline, stop and report. Do not carry on and call it noise.
- **Cache status is recorded on every row.** Caching was deleted in Job 1, so
  every search is a real search. A slow number here is not a cold cache, because
  there is no cache.
- Superseded: the 26.9 s figure from 16 August. It was one search of one
  question. Every comparison is made against the Job 2 baseline below.

## Reading the numbers

`total`, `planning`, `retrieving`, `reranking`, `verifying` and `organizing` come
from `search_logs.stage_durations_ms`; per-source timings come from
`search_logs.source_durations_ms`. The query that produces them is
`scripts/benchmark-report.sql`, so every row in this table is measured the same
way.

Two things worth remembering when reading a `retrieving` number: the five source
RPCs run concurrently, so the stage is at least the slowest single source, and
the difference between the stage total and that slowest source is embedding plus
vocabulary rather than database time.

---

## Results

| Date | What changed | Question | Cold (s) | Warm median (s) | planning | retrieving | reranking | verifying | organizing | cache |
|---|---|---|---|---|---|---|---|---|---|---|
| _pending_ | Job 2 — first baseline, caching deleted | q022 | — | — | — | — | — | — | — | disabled |
| _pending_ | Job 2 — first baseline, caching deleted | q043 | n/a | — | — | — | — | — | — | disabled |
| _pending_ | Job 2 — first baseline, caching deleted | q055 | n/a | — | — | — | — | — | — | disabled |

Cold is measured for question 1 only, by design. `n/a` for the other two is
correct and not a missing measurement.
