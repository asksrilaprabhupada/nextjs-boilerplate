# Search speed implementation

This is one selected configuration, not an experiment matrix.

## Deploy

1. Set the Supabase project to **Large (8 GB)** before enabling overlapping
   database searches. Its published compute charge is approximately $110/month,
   separate from the overall plan, credits, and other usage. This is a capacity
   recommendation based on the observed small buffers and roughly 1.9 GB of
   HNSW indexes; it is not proof that hardware is the only bottleneck.
2. Set `GEMINI_QUERY_PLANNER_MODEL=gemini-3.1-flash-lite` in the deployment
   environment. The code defaults to this model, but an existing environment
   value of `gemini-2.5-flash` takes precedence.
3. Deploy this change. Keep the current Voyage and Cohere credentials/models.
   No embedding rebuild or corpus migration is needed.

The application already requests semantic limit 100. Applying the pending SQL
clamp migration is not required to obtain that request behavior and is not
counted as a speed improvement here.

## What changes

- The planner requests one faithful reformulation for simple questions, and
  allows up to three for compound questions. The original is always searched.
- The model no longer generates schema-version, preserved-term, false-assumption,
  or exact-reference fields. Existing internal defaults and deterministic
  reference extraction preserve the application contract. Empty constraints
  need not contain seven unused fields.
- The first reformulation must preserve explicit `not`, `never`, `without`,
  `only`, and `alone`. Invalid plans still fall back with visible degradation.
- Gemini 3 uses MINIMAL thinking; Gemini 2.5 overrides retain budget zero.
  Planning has 3 seconds per attempt and 3.5 seconds overall, including retries.
- Two workers drain the five-source retrieval queue. Every requested source is
  attempted, output order is stable, and failure handling remains explicit.
- Passage limits, original-query weighting, reranking, exact-reference pinning,
  and verbatim verification remain in place.

## Verification

Automated tests cover compact output, qualification preservation, bounded
concurrency, stable result handling, and existing error and passage-integrity
contracts. Unit tests do not establish retrieval quality or production latency.
The live planner gate remains available and reports the new one-to-three range,
actual thinking usage, and model-specific estimated token costs.

No production deployment, compute change, warming schedule, or database mutation
was made while preparing this change. A ten-second production response remains
a target until measured after deployment. A recurring full-index prewarm is
deliberately not installed on the currently undersized database.

Sources: [Gemini 3.1 Flash-Lite](https://ai.google.dev/gemini-api/docs/models/gemini-3.1-flash-lite),
[Google pricing](https://ai.google.dev/gemini-api/docs/pricing),
[Supabase compute](https://supabase.com/docs/guides/platform/compute-and-disk),
[PostgreSQL prewarming](https://www.postgresql.org/docs/current/pgprewarm.html).
