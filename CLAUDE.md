## CLAUDE.md

Instructions for Claude Code

Project: Ask Śrīla Prabhupāda

Next.js 16 App Router project. Supabase backend. The only app/ folder is the Next.js App Router directory. Run `npm install` then `npm run dev` to start at localhost:3000.

### Commands

```
npm install
npm run dev
npm run build
npm test          # vitest — fusion weighting, junk floor, dedup, prefilter, tiering, snippets, planners, verbatim validator
SITE=<url> bash scripts/verify-release.sh   # release acceptance checks against any deployment
```

### Tech Stack

Next.js 16 (App Router, Turbopack), TypeScript strict, Supabase (PostgreSQL — verses, verse_chunks, prose_paragraphs, transcript_paragraphs, letter_paragraphs tables, 244,000+ searchable passages; RLS enabled everywhere), Tailwind CSS 4, Framer Motion, vitest. Image processing: sharp plus bundled `heic-decode` JavaScript/WebAssembly for HEIC/HEVC → JPEG. Fonts: Cormorant Garamond, DM Sans, Noto Serif Devanagari.

### Environment Variables (in .env.local)

```
SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
SUPABASE_SERVICE_KEY=<service role key>
NEXT_PUBLIC_SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
VOYAGE_API_KEY=<voyage ai key>             # query embeddings (voyage-context-4, 1024-dim)
GEMINI_API_KEY=<google ai studio key>      # multi-query expansion, long-query preprocessing
COHERE_API_KEY=<cohere key>                # search result reranking (rerank-v4.0-pro)
GEMINI_QUERY_PLANNER_MODEL=gemini-2.5-flash   # optional — query-plan model
GEMINI_ARTICLE_PLANNER_MODEL=gemini-2.5-flash # optional — article-plan model
COHERE_RERANK_MODEL=rerank-v4.0-pro           # optional — reranker
NEXT_PUBLIC_SITE_URL=<canonical origin>       # optional — set after attaching the custom domain
SEARCH_CORPUS_VERSION=2026-07-08-tags-v3      # optional — cache-busts a re-tagged corpus
```

There is no environment variable that selects a search engine or a search mode.
There is one pipeline; nothing switches it.

### Tech Stack (AI)

Voyage AI (voyage-context-4 query embeddings, 1024-dim, batched), Google Gemini
(one schema-constrained query plan, one article plan), Cohere Rerank v4.0 Pro
(relevance reranking, judged against the original question only).

### Design Direction

Light theme first: light aurora gradients, soft lavender, whites, gentle pastels, card-based layouts with soft gradients, clean spacing, rounded corners, subtle shadows, and elegant typography. The overall feel is spiritual, warm, clean, and modern. An opt-in "Warm Evening" dark theme exists (toggle in the header's More ▾ menu); it overrides only the primitive tokens in globals.css. All ambient animation is gated behind prefers-reduced-motion.

Cinematic + simple: the dark frames (the doorway, the Journey opening, the Features interlude) are deliberate scenes, not a theme — the header goes light-on-dark over them (`variant="scene"`) so a pale bar never sits on a dark image. There is no audio anywhere on the site. The doorway shows on arrival only; every internal link home carries `?entrance=0`.

### Search pipeline (app/api/search/route.ts)

**ONE ENGINE, ONE ROAD.** There is a single pipeline. No flag, no environment variable, no `mode=` parameter and no question-classifier selects a different one, because there is no different one. A `mode=` parameter in the URL is ignored silently so old links keep working.

GET `/api/search?q=…` (JSON) or `?stream=1` (SSE: `stage` events understood → expanding → searching → reranking → weaving, then `result`, then `done`). A legacy `only_his` parameter is ignored silently. Recorded talks always retain complete mixed, guest, devotee, and unidentified text, with conservative speaker labels kept alongside it.

`route.ts` is the request boundary only — validate, read cache, call pipeline, log, respond (with a 3 MB payload tripwire that should never fire). The stages live in `app/lib/search-v2/`, joined in `pipeline.ts` as a **cascade — a spending plan, never a filter**: retrieve wide, spend the reranker on a few hundred, render ~20 in full, return everything else as citations:

Gemini query plan (one schema-constrained call with thinking off, 4 s cap per attempt (set from a measured p95 of 2,999.96 ms over 206 serial calls, plus one second), **exactly 5 distinct search angles — required, never "up to"**, so the library is searched with the original question plus five angles; a plan with fewer angles or angles that repeat one another earns ONE retry that is told what was wrong — a repeated ROLE is fine, since comparing two things means defining both, and a misread question — an invented constraint, a dropped name — is rejected outright with no retry; the recorded failure reason is specific: `plan_timeout`, `plan_invalid_json`, `plan_schema_rejected`, `plan_too_few_angles`, `plan_near_duplicate_angles`, `plan_semantic_rejected`; a POINTER question genuinely has no five distinct angles, so it is recorded as the outcome `pointer_question` and searched on its own words: counted, never excused, and never a degradation, since a cited verse is pinned anyway. QUESTION IS THE DEFAULT, and there are exactly two mechanical escapes, both read off the shape of the input by code before the planner runs: the input **is only** a citation (`BG 18.66`, `CC Adi 1.1` — but *not* "what does BG 18.66 mean about surrender", which is a real question that merely cites one), or it is a quotation marked as one **and** at least 8 words long (a shorter quoted span such as "surrender to Krishna" appears verbatim all over the corpus and is a question). No question mark and no question word is ever consulted — a devotee who omits the punctuation is still asking, and "control of the mind", "chanting", "love", "krsna consciousness" all get five angles; a written reference like "BG 18.66" becomes the siglum `BG` as the scripture filter — the `scripture` column stores only sigla — plus `exact_reference` for the pinned lookup) → batched Voyage embedding of the question and every approved angle → 5 concurrent batched `_v3` RPCs (verses 200, verse chunks 150, prose 120, transcripts 150, letters 80 — unequal on purpose: an equal budget is flooding, not fairness; semantic lane 300, clamped to ef_search 400 in SQL) riding alongside `direct_verse_lookup` when a reference was written (its verse is **pinned**: first in the main tier, immune to every cut); a scripture filter that empties both scripture sources while others found rows **fails open** and re-runs unfiltered — an empty result caused by a filter is a bug, never an answer → junk floor (fragments under 60 chars dropped; verses and pins exempt) → one weighted RRF pass (the original question always outweighs any angle) → real-duplicate collapse only (identical text, or ≥90% containment within the same source+reference — never "sounds similar") → channel-agreement pre-filter (`prefilter.ts`: signals the RPCs already returned, per-source floors so verses can't be outvoted, ~400 earn the cross-encoder; the rest are set aside for the citation tier, not deleted) → Cohere rerank in concurrent batches of 200, then one final pass over the top `RERANK_FINAL_POOL` (200) so the order is one true order (~600 documents per search, not ~4,000) → **adaptive tiering** (`select.ts`: the cut is the largest score gap between positions 8 and 20 — scores are query-dependent, so a fixed threshold is a category error; the cut moves passages to the `additional` tier, it never deletes them) → **verbatim re-fetch of the main tier only: every passage rendered in full is re-read from its source row and asserted byte-identical, or dropped** (citations show no body text, so there is nothing to verify) → Gemini article plan over the main tier (order and structure only, never words) → the wire response carries `passages` (main tier: full verified text, layers, who-and-when, server-computed label, rerank score, reranker's order) plus `additional` (every other survivor: label, citation, sentence-safe snippet — see `snippet.ts`, which never cuts mid-thought). The page prints both lists; nothing on the client looks anything up. The citation tier is headed "N more passages retrieved in this search" — never "every one the library found", which was untrue: N comes from a candidate pool capped at 700 rows across the five sources, not from the corpus.

**Nothing is deleted.** Every passage that survives retrieval reaches the response — ~20 in full, the rest grouped and collapsed under "N more passages". `totalResults` counts both tiers. Timeouts match the cascade: server `maxDuration` 300 s (needs Fluid compute on Vercel), client waits 150 s, and the loader shows live found-counts from SSE stage events.

Transcript paragraphs carry `speaker`/`speaker_confidence` (deterministic "Name:" backfill — migration `20260801120000`): a guest's words are labelled "Spoken by X — not Śrīla Prabhupāda", unlabelled paragraphs read "Speaker not identified", and nothing unlabelled is ever assumed to be his.

Failure discipline: a retrieval RPC failure is fatal (503 with a request id) and never becomes "no teachings found". Everything else degrades and says so in `degradedStages`. Only a clean, non-degraded answer is cached. Every serving logs one `search_logs` row via the `log_search` RPC and returns `searchLogId` for feedback/behavior/citation-click telemetry.

### File Structure

Every file has a doc comment at the top explaining its purpose. Files are numbered (01-, 02-) within each folder for clear ordering. Components under `components/landing/`, `components/lockscreen/`, `components/overlays/`, `components/feedback/`, and `components/search/01-04` are a retained earlier design generation (unmounted; the live UI is the `cinematic/` family + `results/` renderers).

```
/
├── app/
│   ├── api/
│   │   ├── analytics/
│   │   │   ├── behavior/route.ts      (user behavior tracking → log_search_behavior RPC)
│   │   │   ├── citation-click/route.ts (Vedabase click beacons → citation_clicks table)
│   │   │   ├── feedback/route.ts      (thumbs up/down votes → log_search_feedback RPC)
│   │   │   └── log/route.ts           (legacy search query logging endpoint)
│   │   ├── feedback/route.ts          (contact/feature request forms → feedback table)
│   │   ├── generate-article/route.ts  (AI generation quarantined/disabled — HTTP 410)
│   │   ├── lockscreen-images/
│   │   │   ├── route.ts               (image list endpoint)
│   │   │   └── heic/route.ts          (HEIC/HEVC + mismatch normalization to JPEG)
│   │   ├── health/route.ts            (can this deployment actually serve a search?)
│   │   ├── search/route.ts            (request boundary only: validate → cache → pipeline → log → JSON or SSE)
│   │   ├── search/plan-probe/route.ts (PREVIEW ONLY, 404 elsewhere: runs the query planner alone over the gold set and reports times, tokens, angles — the A1 merge gate)
│   │   └── verse/route.ts             (single verse lookup by id, or by textual cross-reference)
│   ├── components/
│   │   ├── cinematic/                 # THE LIVE UI FAMILY
│   │   │   ├── 01-cinematic-home.tsx  (home: doorway entrance + rotating verse, hero search, library count-up, Moments filmstrip, 1965 teaser, sample voices)
│   │   │   ├── 04-use-cinematic-reveal.ts (scroll reveals + 1.5s failsafe; journey rail fill)
│   │   │   ├── 05-journey-page.tsx    (His Journey chapters)
│   │   │   ├── 06-features-page.tsx   (three core features as live UI vignettes + supporting grid)
│   │   │   ├── 07-how-it-works-page.tsx (three steps + five under-the-hood pipeline cards)
│   │   │   ├── 09-search-experience.tsx (SSE orchestrator: loader → results → ask-next chips)
│   │   │   ├── 10-search-loader.tsx   (mandala loader: five ticking stages from SSE, percent, rotating verses)
│   │   │   ├── 11-site-header.tsx     (unified header: nav, More ▾, hamburger, theme toggle; variants overlay | solid | scene)
│   │   │   ├── 12-site-footer.tsx     (unified footer)
│   │   │   ├── 13-site-modals.tsx     (provider: seva modal with India/International toggle + one Bug/Idea/General feedback form, mailto submit)
│   │   │   └── 14-photo-slot.tsx      (path-addressed photo slot: placeholder until the exact file exists; useImageAvailable for bg swaps)
│   │   ├── results/
│   │   │   ├── 01-narrative-response.tsx (prints results.passages first-to-last: label, words, citation, copy; Essay | By source views of the same list; collapsed "N more passages" citation tier below)
│   │   │   └── 03-cinematic-dig-deeper.tsx (live cinematic evidence explorer: search, source/book/Skandha/chapter filters, grouped cards)
│   │   ├── verse/
│   │   │   └── 01-verse-view.tsx      (interactive reader: toggleable layers, swipe, cross-ref preview)
│   │   ├── layout/03-theme-toggle.tsx (light/warm-evening toggle, used by the site header)
│   │   ├── search/05-search-progress.tsx · 06-search-feedback.tsx (thumbs voting — mounted via results)
│   │   └── landing/ · lockscreen/ · overlays/ · feedback/ · search/01-04 (retained earlier generation, unmounted)
│   ├── hooks/
│   │   └── 01-use-search-behavior-tracker.ts (time-on-result, scroll, clicks — sendBeacon flush)
│   ├── lib/
│   │   ├── 01-supabase.ts            (shared server-side Supabase admin client)
│   │   ├── 02-analytics.ts           (tracking helpers: logFeedback/logBehavior/logCitationClick)
│   │   ├── 03-embed.ts               (Voyage embeddings; embedQueries batches original + variants)
│   │   ├── 05-link-postprocessor.ts   (citation linking)
│   │   ├── 06-lockscreen-data.ts      (shared lock-screen types + dormant legacy data)
│   │   ├── 08-cohere-rerank.ts        (Cohere Rerank v4.0 Pro relevance reranking)
│   │   ├── 09-purport-format.ts       (shared purport paragraph/footer helpers)
│   │   ├── 10-passage-fold.ts         (shared fold preview + matched-line highlight + verbatim key line)
│   │   ├── 11-motion.ts               (shared Framer Motion tokens)
│   │   ├── 12-provenance.ts           (authorship truth table: HIS / NOT-HIS / MIXED-VERIFY)
│   │   ├── 13-passage-label.ts        (TYPE · SOURCE · SPEAKER attribution + amber provenance badge)
│   │   ├── 14-verse-speaker.ts        (story speaker from uvāca markers)
│   │   ├── 15-transcript-speakers.ts  (Name: prefix segmentation for lectures)
│   │   ├── 17-verbatim-validator.ts   (re-fetch + normalize ⊆ assertion for every rendered block)
│   │   ├── 19-seva-config.ts          (donation rows per region; an empty value renders as "Add in project")
│   │   ├── 20-site.ts                 (canonical origin from NEXT_PUBLIC_SITE_URL)
│   │   ├── 27-lockscreen-photo-deck.ts (session-persistent Web Crypto shuffle deck)
│   │   ├── search-v2/                 # THE SEARCH ENGINE — the only one
│   │   │   ├── pipeline.ts            (the orchestrator; joins every stage, holds the budgets)
│   │   │   ├── config.ts              (fusion weights, per-source quotas, pool sizes, model ids)
│   │   │   ├── reference.ts           (spots a scripture reference — siglum for the filter, full form for the pin)
│   │   │   ├── query-plan.ts          (one schema-constrained Gemini query plan + its validator; exactly 5 angles, thinking off, one repair retry)
│   │   │   ├── planner-gate.ts        (planner-only measurement harness over the gold set: acceptance, latency, tokens, cost)
│   │   │   ├── retrieval.ts           (vocabulary resolve, batched embedding, 5 concurrent RPCs, fail-open)
│   │   │   ├── fusion.ts · dedup.ts   (junk floor + one weighted RRF pass, then duplicate collapse)
│   │   │   ├── prefilter.ts           (channel-agreement gate: who earns the reranker; sets aside, never deletes)
│   │   │   ├── rerank.ts              (Cohere batches + one capped final pass against the original question)
│   │   │   ├── select.ts              (adaptive tiering: largest-gap cut into main + additional)
│   │   │   ├── refetch.ts             (re-reads every MAIN-TIER passage from source and asserts it verbatim)
│   │   │   ├── snippet.ts             (sentence-safe previews — never cut mid-thought)
│   │   │   ├── article-plan.ts · render.ts (structure only, then the deterministic renderer)
│   │   │   ├── adapt.ts               (maps pipeline output onto the wire contract the UI renders)
│   │   │   ├── cache.ts · rpc.ts · errors.ts · citation.ts
│   │   ├── types/01-search.ts         (shared server↔client search contract + SSE stage events)
│   │   └── server/01-lockscreen-images.ts (validated build-time photo discovery + normalization)
│   ├── types/01-speech.d.ts           (Web Speech API types)
│   ├── verse/[id]/page.tsx            (verse detail page — server-rendered)
│   ├── search/page.tsx                (dynamic: reads ?q server-side → SearchExperience; noindex)
│   ├── journey/page.tsx · features/page.tsx · how-it-works/page.tsx
│   ├── globals.css                    (design tokens, light + warm-evening themes, motion-safe gating)
│   ├── layout.tsx                     (root layout + fonts + JSON-LD + modals provider)
│   ├── page.tsx                       (home page)
│   ├── icon.svg                       (lavender "A" monogram favicon)
│   ├── robots.ts                      (allow all; disallow /api/ + /search)
│   └── sitemap.ts                     (4 curated routes)
├── docs/screenshots/                  (release verification screenshots)
├── public/
│   ├── data/donate.json               (legacy; live seva rows come from app/lib/19-seva-config.ts)
│   ├── data/entrance-quotes.json      (entrance verse pool — bhāva/prema only; add lines here, no code change)
│   ├── images/
│   │   ├── README.md                  (how automatic photo discovery and validation work)
│   │   ├── lockscreen/                (photos; auto-discovered by /api/lockscreen-images)
│   │   ├── journey/                   (path-addressed /journey chapter photos; exact filenames in its README)
│   │   ├── moments/                   (path-addressed landing Moments photos: moments-01.jpg … moments-04.jpg)
│   │   ├── ChatGPT Image Aug 10, 2026, 05_51_20 AM.png (untouched social-card source)
│   │   └── social-share-v2.jpg         (sub-300 KiB Open Graph/Twitter derivative)
│   └── videos/lockscreen/             (optional admin video upload)
├── scripts/verify-release.sh          (acceptance checks: run with SITE=<url>)
├── supabase/migrations/               (applied migrations, committed for record)
├── tests/                             (vitest unit tests)
├── package.json · next.config.ts · tsconfig.json · vitest.config.ts · postcss.config.mjs
└── CLAUDE.md
```

### Supabase Connection Guide

1. Go to https://supabase.com and open your project (URL: wzktlpjtqmjxvragwhqg.supabase.co).
2. Go to Project Settings → API. Copy the anon public key and the service_role secret key.
3. Create a `.env.local` file in the repo root with the environment variables listed above.
4. RLS is enabled on every public table (public read on content; anon INSERT only on feedback/citation_clicks; search_logs writes go through the SECURITY DEFINER `log_search` RPC).
5. If deploying to Vercel, add these same environment variables in Vercel dashboard → Settings → Environment Variables.

All server-side Supabase access goes through the single shared client in `app/lib/01-supabase.ts` (`getSupabaseAdmin()`); API routes never construct their own client.

### Admin Actions Required

- Upload Śrīla Prabhupāda photos to `public/images/lockscreen/`, commit, and redeploy. Valid photos are byte-checked and added to the intro automatically; no manifest edit is needed. Corrupt or unsupported files fail the build with the exact filename.
- Upload the /journey chapter photos and the landing Moments photos by their exact filenames per `public/images/journey/README.md` and `public/images/moments/README.md` (path-addressed slots — placeholders are replaced automatically on redeploy, no code change).
- Fill in the real account details in `app/lib/19-seva-config.ts` (India and international rows). Any row left empty shows "Add in project" with its Copy button disabled; a filled row turns solid and copyable on its own.
- Set the real inbox in `FEEDBACK_EMAIL` (`app/components/cinematic/13-site-modals.tsx`) — every form currently composes a mail to a placeholder address. To store submissions in the `feedback` table instead, POST to `/api/feedback` from `submitForm` and update the line under the button.
- Replace the labelled sample voices in `app/components/cinematic/01-cinematic-home.tsx` (VOICES array) with real quotes, and drop the "Sample — a real voice will appear here" lines.
- Add or edit entrance verses in `public/data/entrance-quotes.json` (bhāva/prema only; verify wording and citations against Vedabase before shipping).
- After attaching the custom domain in Vercel, set `NEXT_PUBLIC_SITE_URL=https://asksrilaprabhupada.com`.
