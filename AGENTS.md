# AGENTS.md

Short repo-wide rules. Project detail lives in `CLAUDE.md`; the search
rebuild specification lives in `docs/deep-research-v2.md`.

## Commands

```
npm ci              # locked install (npm — package-lock.json is the only lockfile)
npm run dev
npm run build
npm run typecheck   # tsc --noEmit
npm test            # vitest
npm run verify:contract          # needs SUPABASE_URL + SUPABASE_SERVICE_KEY
SITE=<url> bash scripts/verify-release.sh
```

CI (`.github/workflows/ci.yml`) runs install, typecheck, tests and build. It
deliberately does not check the database contract — that needs real credentials,
and a check that skips itself reports green while proving nothing.

## The product rule

This is a high-faithfulness religious corpus search engine, not a chatbot.

**AI may arrange the evidence. Only the corpus supplies the teaching.**

AI may classify intent, propose search angles, suggest controlled-vocabulary
concepts, and select and order approved passage IDs. AI must not generate the
doctrinal answer, write connective theological prose, manufacture or shorten
quotations, invent citations, speakers, recipients, places or dates, or turn a
recipient-specific letter into a universal instruction.

Every rendered block is re-fetched from its source row and asserted verbatim
(`app/lib/17-verbatim-validator.ts`). Do not weaken or bypass that gate.

## The integrity invariant

**A database error must never become an empty result.**

In July 2026 every `search_*` RPC was dropped. `supabase-js` *resolves* rather
than rejects on a Postgres error, so `const { data } = await supabase.rpc(...)`
yielded `undefined`, `data || []` yielded `[]`, and total infrastructure failure
was served to devotees as "no passages found" — HTTP 200, `validated: true`.

Therefore, in any code that touches Supabase:

- Never destructure `{ data }` without handling `error`. Use `rpcOrThrow`,
  `rpcOrDegrade` or `unwrapOrThrow` from `app/lib/search-v2/rpc.ts`. This applies
  to direct table reads, not only RPCs.
- Required lanes throw `SearchInfrastructureError`. Optional lanes may soften
  only when core retrieval independently succeeded, and every softening is
  recorded in `degradedStages`.
- "No direct evidence" may only be returned after retrieval actually completed
  (`retrievalStatus: "complete"`).
- Never cache an error. Bump `RESPONSE_VERSION` in `app/api/search/route.ts`
  whenever response shape or content policy changes.
- Error bodies crossing the network carry a stable code and a request id, never
  a message, SQL, arguments or a stack.

## Database

- Migrations are forward-only and hand-written as
  `supabase/migrations/YYYYMMDDHHMMSS_name.sql`. No Supabase CLI is configured
  and there is no `config.toml`.
- No `DROP ... CASCADE`. No corpus/index/embedding changes without benchmark
  evidence in the PR.
- New functions: `SECURITY INVOKER`, `SET search_path = ''`, fully-qualified
  references, `REVOKE` from `PUBLIC`/`anon`/`authenticated`, `GRANT` to
  `service_role` only. PostgreSQL grants `EXECUTE` to `PUBLIC` by default.
- After adding a function, reload the PostgREST schema cache
  (`NOTIFY pgrst, 'reload schema'`); otherwise callers get `PGRST202` for a
  function that exists.
- **Known drift:** the repo's migrations cannot rebuild this database. The live
  history stops at `20260705151533` and never mentions the v3 columns
  (`tags_core`, `fts_core`, `fts_expansion`, `embedding_context4`) or
  `vocab_terms`. A Supabase branch therefore reproduces the *pre-cutover*
  schema, not production. See `docs/search-integrity-audit.md`.

## Secrets

`SUPABASE_SERVICE_KEY` is required server-side and has no fallback — a missing
key raises a typed error rather than silently downgrading to the anon key and
RLS. Never expose provider keys to the browser or prefix them `NEXT_PUBLIC_`.
Never print `.env` contents; verify variable presence, not values.
