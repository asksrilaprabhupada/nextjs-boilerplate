# EXECUTION REPORT — "Real Search" Release

Working branch: `claude/vigilant-carson-xu98ho` (session-designated; supersedes the spec's
`real-search-release` name per owner confirmation). Base: `main` @ `78ae7d9`.

Status legend: ✅ done · ⚠️ done with deviations · ❌ failed (rolled back) · ⏳ pending

---

## §1 · Task 1 — Recon & file map ✅

### Route → component → data source map

| Route | Page file | Renders (client component) | Data source |
|---|---|---|---|
| `/` | `app/page.tsx` (server wrapper) | `app/components/cinematic/01-cinematic-home.tsx` | None (static; search submit → `window.location.assign("/search?q=…")` after a fake 3-phase timer) |
| `/search` | `app/search/page.tsx` (server wrapper) | `app/components/cinematic/08-search-results-page.tsx` | **100% hardcoded mock** (BG 2.20/2.40/10.10/18.66, `DEEP_ITEMS`, fake `playLoader`) — never calls `/api/search` |
| `/journey` | `app/journey/page.tsx` | `cinematic/05-journey-page.tsx` | Static |
| `/features` | `app/features/page.tsx` | `cinematic/06-features-page.tsx` | Static |
| `/how-it-works` | `app/how-it-works/page.tsx` | `cinematic/07-how-it-works-page.tsx` | Static |
| `/verse/[id]` | `app/verse/[id]/page.tsx` (server, force-dynamic) | `components/verse/01-verse-view.tsx` | Live Supabase fetch |
| `/api/search` | `app/api/search/route.ts` (~2,480 lines, GET only) | — | Live: Voyage embeddings → RPC fan-out → RRF → Cohere rerank → provenance → deterministic verbatim essay |
| other APIs | `analytics/{log,feedback,behavior}`, `feedback`, `verse`, `lockscreen-images(+heic)`, `generate-article` (410 disabled) | — | Supabase RPCs / table inserts / filesystem |

`/search` is a **Server Component wrapper** delegating to a `"use client"` mock. The canned data
literal lives in `cinematic/08-search-results-page.tsx` (`DEFAULT_Q` :21, `DEEP_ITEMS` :25-31,
hero passages :188-237, "Prototype shows 5 of 142" :283).

### Key discovery — the real search stack exists but is orphaned

- `app/components/results/01-narrative-response.tsx` + `02-dig-deeper-modal.tsx` are fully
  data-driven renderers of the exact `/api/search` response shape (typed `SearchResults` interface),
  with purport folds, copy-with-reference, provenance badges, and a filtered Dig-Deeper sheet —
  **imported by nothing**. This release rewires them inside the cinematic chrome instead of
  rewriting them.
- Also orphaned (zero importers): `components/layout/01-header.tsx` (has "More ▾" + hamburger +
  theme toggle), `layout/02-footer.tsx`, `components/search/01…06-*` (incl. real SpeechRecognition
  voice input and a reduced-motion-aware loader), `components/overlays/01…05-*`,
  `components/landing/01…06-*`, `components/lockscreen/01-lock-screen.tsx`,
  `components/feedback/01,02`, `hooks/01-use-search-behavior-tracker.ts` (transitively).
- `app/lib/02-analytics.ts#logSearch` is defined but never called; `search_logs` and `feedback`
  tables have 0 rows ever.

### CLAUDE.md staleness (needs owner attention; file map updated in Task 16)

- The entire `app/components/cinematic/` family (the LIVE site since PR #94) is undocumented.
- "Every file in the repository is used directly … no dead code" — false (orphan list above).
- "Light theme only" — a full "Warm Evening" dark theme + pre-paint bootstrap already exist in
  `globals.css` / `layout.tsx`.

### Grep-anchor verification (spec §Task 1.2)

All expected anchors located; two spec assumptions corrected:
- "More ▾" exists on the **home** inline header but not on inner pages (inverse of audit phrasing;
  same unification fix).
- `queryVariants`, `introSeen` — not present anywhere (features to be built, confirmed).
- "addresses" grammar-bug template: `app/api/search/route.ts:2038` (live) + :1383/:1566 duplicates
  (+ :1608/:1822 in dead code).

---

## §4 · Task 4 — Supabase RLS + function hardening ✅

Applied as ONE atomic migration `20260705144937_enable_rls_with_policies_and_fn_hardening`
(via Supabase MCP `apply_migration`; SQL committed to `supabase/migrations/`).

- RLS enabled + `"public read"` SELECT (anon, authenticated) on 9 content tables; read policy added
  to `chapters` (was RLS-on-zero-policies, fully blocking anon).
- RLS enabled on `search_logs` (NO anon policies — RPC/service-role only) and `feedback`;
  `"anon insert"` policies on `feedback` and `citation_clicks`.
- `SET search_path = public, pg_temp` pinned on **45 functions** — list generated from `pg_proc`,
  not hand-typed. Deviation: the 4 `unaccent`-extension functions (`unaccent` ×2, `unaccent_init`,
  `unaccent_lexize`) were intentionally excluded — extension-owned, not advisor-flagged, and
  text-search-template internals are risky to alter.

Verification output:
1. ✅ Security advisors re-run: all 11 `rls_disabled_in_public` ERRORs cleared; all 45
   `function_search_path_mutable` WARNs cleared; `sensitive_columns_exposed` (search_logs) cleared;
   `chapters`/`citation_clicks` no-policy INFOs cleared.
2. ✅ Anon-role probe (`SET ROLE anon`): `SELECT translation FROM verses LIMIT 1` returns data;
   `SELECT count(*) FROM search_logs` returns 0 visible rows (RLS filtering works). Content tables
   have zero write policies → anon writes provably blocked by RLS semantics.
3. ✅ Live prod `/api/search?q=test` → HTTP 200, `totalResults: 28`, full citations/keyAnswers
   (fetched via Vercel MCP; this sandbox's egress policy blocks `*.vercel.app` directly).
4. Remaining advisor items (expected/intentional): `search_logs` RLS-no-policy INFO (by design);
   2 WARNs for always-true INSERT policies on feedback/citation_clicks (spec-mandated public
   telemetry writes); `verse_refs` SECURITY DEFINER ERROR (TODO: owner decision — recreate with
   `security_invoker`); `unaccent` extension in public WARN (pre-existing); Postgres patch WARN
   (out of scope per spec).

## §2 · Task 2 — Wire /search to real API + SSE ⏳

## §3 · Task 3 — Multi-query expansion ⏳

## §6 · Task 6 — Framing grammar ⏳

## §9 · Task 9 — Essay v2 + validator + context RPC ⏳

## §10 · Task 10 — Dig deeper v2 ⏳

## §7 · Task 7 — Loader ⏳

## §14 · Task 14 — Telemetry ⏳

## §11 · Task 11 — Header/footer unification ⏳

## §5 · Task 5 — FAKE labelling ⏳

## §12 · Task 12 — Homepage fixes ⏳

## §8 · Task 8 — Images ⏳

## §13 · Task 13 — Inner pages ⏳

## §15 · Task 15 — SEO ⏳

## §16 · Task 16 — Final verification + PR ⏳

---

## Deviations & path mappings (running log)

- Spec `lib/types/search.ts` → `app/lib/types/search.ts`; `lib/search/multiQuery.ts` →
  `app/lib/16-multi-query.ts`; `lib/config/seva.ts` → `app/lib/19-seva-config.ts`;
  `lib/images/manifest.ts` → `app/lib/18-image-manifest.ts` (repo keeps all lib code under
  numbered `app/lib/`).
- Spec env var `SUPABASE_SERVICE_ROLE_KEY` → repo uses `SUPABASE_SERVICE_KEY`.

## Follow-ups (human decisions — see PR description)

- Attach custom domain in Vercel, then set `NEXT_PUBLIC_SITE_URL`.
- Replace FAKE testimonials & seva details (flip `isPlaceholder` in `app/lib/19-seva-config.ts`).
- `verse_refs` view is SECURITY DEFINER — recreate as `security_invoker` (owner decision).
- Postgres patch upgrade available (out of scope for this run).
- `run_benchmark_v2` embedding bake-off; then drop the losing embedding column.
- Source 6–10 licensed photos; build `/q/[slug]` curated question pages.
- CLAUDE.md "light theme only" contradicts the shipped dark theme + toggle.
