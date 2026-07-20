# Pilot report — asp-tags-v4-tiered

_FREE-TIERS + CALIBRATION pass. Tiers 1–2 and the threshold calibration read
only stored data (`embedding_context4`, `vocab_terms.embedding`, the frozen p1
pilot tags), so every number below is **measured**, not modelled. Tier 3 (the
paid LLM judge) requires `GEMINI_API_KEY` and is the maintainer's keyed run —
its **true** cost is recorded from `usageMetadata` at retrieval when the pilot
is run with credentials; the figure here is a structural projection._

- Pipeline: three-tier classifier over the frozen **251-term** vocabulary
  (Person 74 · Place 19 · Scripture 19 → Tier 1; Concept 103 · Practice 36 →
  Tiers 2–3). Questions + `passage_function` are **DEFERRED** (columns stay, no
  generation now).
- Tier-3 model: `gemini-3-flash-preview` → escalates once to `gemini-3.5-flash`
  → quarantine (retry-once / escalate-once ladder). `thinkingLevel=LOW`,
  classification-only output (`{"tags":[{"slug","evidence_sentence_id"}]}`),
  small output cap (512).
- Evidence: sentence-id (`asp-sentences-v1`). `MAX_TAGS=12`. Cost ceiling
  `MAX_SPEND_USD=325`.
- Calibration set: the frozen p1 pilot run `63c99428-7ecb-469d-a551-cc99f9585673`
  — 1,722 passages, 5,633 accepted tags (of which **3,905** are Concept/Practice,
  the Tier-2/3 ground truth).

## Tier-2 threshold calibration (vs the p1 pilot tags)

Rule: sweep the cosine similarity threshold over the top-12 Concept/Practice
embedding shortlist per passage; **T_accept** = the smallest threshold whose
measured precision ≥ 0.80; **T_reject** = the largest threshold that still
retains ≥ 0.95 of the in-shortlist positive tags.

| threshold | value | measured |
|---|---|---|
| **T_accept** | **0.47** | precision **0.800** (68 TP / 85 candidates ≥ 0.47); in-shortlist recall 0.024 |
| **T_reject** | **0.22** | retains **0.962** of in-shortlist positive tags (2,701 / 2,807) |

- **Shortlist recall ceiling: 0.719** — only 2,807 of the 3,905 accepted
  Concept/Practice pilot tags rank inside a top-12 embedding shortlist at all;
  the other ~28% are structurally unreachable by embedding shortlisting (they
  are why Tier 3, not Tier 2, does the heavy lifting).
- **Finding:** pure embedding similarity is a *weak* signal for these tags — even
  at cosine ≥ 0.48 precision is only ~0.81. So Tier 2 auto-accepts a tiny
  high-precision head, auto-rejects a low tail, and hands the large ambiguous
  middle to the Tier-3 judge. This is the intended shape, confirmed empirically.

| pooled candidates (1,722 × 12 = 20,664) | ≥ T_accept (auto-accept) | middle band (judged) | < T_reject (auto-drop) |
|---|---|---|---|
| 20,664 | **85** | **17,954** | **2,625** |

## Per-tier counts (measured on the 1,722 labeled pilot passages)

| tier | assignment | tags / pairs | passages | cost |
|---|---|---|---|---|
| **Tier 1** — exact aliases (Person/Place/Scripture) | `method='exact_alias'`, confidence 1.0 | **2,300** tags (89 distinct terms) | **1,298** (75%) | **$0** |
| **Tier 2** — auto-accept (≥ 0.47) | `method='semantic'`, confidence = similarity | **85** pairs | **82** | **$0** |
| **Tier 2** — auto-reject (< 0.22) | dropped | 2,625 pairs | — | **$0** |
| **Tier 3** — judged (middle band) | `method='llm_confirmed'` | **17,954** pairs (~10.6 / passage) | **1,688** (98%) | paid |

- Tiers 1–2 resolve tags on **1,298 / 1,722** passages for free before any LLM
  call; the merged `tags_core` is the union (Tier 1 → Tier 2 → Tier 3, deduped,
  capped at `MAX_TAGS`, highest-confidence first).
- Only **34** pilot passages (2%) have no middle-band candidate and skip the
  judge entirely; they still keep their free Tier-1/2 tags.

## Distribution gates

The distribution gates (OOV ≤ 2% · distinct tags ≥ 100 · singleton ≤ 20% · ≥ 60%
vocab used · no tag on > 20% of passages · median 3–8 among tagged) run on the
**merged** `tags_core` and therefore need the Tier-3 confirmations. They are
reported by `write_pilot_report_v4` after the keyed pilot applies. Not computable
in the free-tiers-only pass (Tiers 1–2 alone are a lower bound on coverage).

## Cost

- **Tiers 1–2: $0.00** (measured — no LLM).
- **Tier 3 true pilot cost:** requires the keyed run (no `GEMINI_API_KEY` in this
  environment). The harness records real `candidatesTokenCount +
  thoughtsTokenCount` at retrieval, so the maintainer's pilot yields the exact
  figure; it counts against the same `MAX_SPEND_USD=325` ceiling.

### Projected full-corpus Tier-3 cost (estimate)

- Eligible passages (corpus): **244,148** (verses 25,131 · verse_chunks 18,699 ·
  prose 36,412 · transcripts 144,438 · letters 19,468).
- Judged-passage rate from the pilot: **~98%** → ~**239,000** Tier-3 calls.
- Batch price `gemini-3-flash-preview`: **$0.25/M in · $1.50/M out**. Estimated
  per-passage payload: ~1,000–1,500 input tokens (≈10 candidate lines + numbered
  target) and ~150–350 output tokens (classification array + LOW thinking,
  well under the 512 cap).
- **Projected full-corpus Tier-3 cost: ~$115–$215 (central ≈ $165)** — under the
  $325 ceiling, and far below the old generative full run (which paid for tags +
  up to 3 questions + `passage_function` and routed core scripture to the 3×
  costlier `gemini-3.5-flash`). This is a structural estimate; the maintainer's
  keyed pilot replaces it with the measured per-passage cost before any full run.

## What was and was not run here

- **Run (free, measured):** the 251-term vocabulary check, Tier-1 exact-alias
  matching, Tier-2 embedding shortlist + banding, and the full threshold
  calibration against the p1 pilot tags — all read-only against the live DB.
- **Not run (needs `GEMINI_API_KEY`):** the Tier-3 batch judge, the atomic
  Tier-3 apply, the merged-`tags_core` distribution gates, the 40 sampled
  passages, and the true Tier-3 cost. `python run_all.py --pilot-only` performs
  all of these and stops before the full corpus.
- **The full corpus run was NOT started** (as instructed).
