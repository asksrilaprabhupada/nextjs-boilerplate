## CLAUDE.md

Instructions for Claude Code

Project: Ask Śrīla Prabhupāda

Next.js 16 App Router project. Supabase backend. The only app/ folder is the Next.js App Router directory. Run `npm install` then `npm run dev` to start at localhost:3000.

### Commands

```
npm install
npm run dev
npm run build
npm test          # vitest — fusion weighting, dedup, selection, planners, verbatim validator
SITE=<url> bash scripts/verify-release.sh   # release acceptance checks against any deployment
```

### Tech Stack

Next.js 16 (App Router, Turbopack), TypeScript strict, Supabase (PostgreSQL — verses, verse_chunks, prose_paragraphs, transcript_paragraphs, letter_paragraphs tables, 244,000+ searchable passages; RLS enabled everywhere), Tailwind CSS 4, Framer Motion, vitest. Image processing: sharp (HEIC → JPEG). Fonts: Cormorant Garamond, DM Sans, Noto Serif Devanagari.

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

GET `/api/search?q=…` (JSON) or `?stream=1` (SSE: `stage` events understood → expanding → searching → reranking → weaving, then `result`, then `done`).

`route.ts` is the request boundary only — validate, read cache, call pipeline, log, respond. The stages live in `app/lib/search-v2/`, joined in `pipeline.ts`:

Gemini query plan (one schema-constrained call, ≤6 distinct search angles, 4 s cap, rejected rather than repaired on any semantic violation) → batched Voyage embedding of the question and every approved angle → 5 concurrent batched RPCs (verses, verse chunks, prose, transcripts, letters; 400 candidates per table per question) → one weighted RRF pass (the original question always outweighs any angle) → real-duplicate collapse only (identical text, or ≥90% containment within the same source+reference — never "sounds similar") → Cohere rerank of EVERY candidate in concurrent batches of 200, then one final rerank of everything above the relevance line so the order is one true order → selection by relevance, not by counting: every passage scoring ≥ `RELEVANCE_THRESHOLD` (0.30, a starting value, every score logged for tuning) is kept — no ceiling; top-10 floor when few clear the line; top-100 fused order when the reranker is down (marked degraded) → **verbatim re-fetch: every selected passage re-read from its source row and asserted byte-identical, or dropped** → Gemini article plan (order and structure only, never words; skipped above its schema's capacity — arrangement changes, nothing is dropped) → the wire response carries `passages`: every kept passage with its full verified text, layers, who-and-when, server-computed label and rerank score, in the reranker's order. The page prints that list; nothing on the client looks anything up.

**No limits.** There is no maximum passage count anywhere in the pipeline or the UI. If 240 passages clear the relevance line, all 240 are shown (folded, never dropped). Timeouts match: server `maxDuration` 300 s (needs Fluid compute on Vercel), client waits 330 s, and the loader shows live found-counts from SSE stage events.

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
│   │   │   └── heic/route.ts          (HEIC-to-JPEG conversion via sharp)
│   │   ├── health/route.ts            (can this deployment actually serve a search?)
│   │   ├── search/route.ts            (request boundary only: validate → cache → pipeline → log → JSON or SSE)
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
│   │   │   ├── 01-narrative-response.tsx (prints results.passages first-to-last: label, words, citation, copy; Essay | By source views of the same list)
│   │   │   └── 02-dig-deeper-modal.tsx (retained, unmounted — there is no overflow any more; every passage is in the main list)
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
│   │   ├── 06-lockscreen-data.ts      (slideshow fallback + daily verses)
│   │   ├── 08-cohere-rerank.ts        (Cohere Rerank v4.0 Pro relevance reranking)
│   │   ├── 09-purport-format.ts       (shared purport paragraph/footer helpers)
│   │   ├── 10-passage-fold.ts         (shared fold preview + matched-line highlight + verbatim key line)
│   │   ├── 11-motion.ts               (shared Framer Motion tokens)
│   │   ├── 12-provenance.ts           (authorship truth table: HIS / NOT-HIS / MIXED-VERIFY)
│   │   ├── 13-passage-label.ts        (TYPE · SOURCE · SPEAKER attribution + amber provenance badge)
│   │   ├── 14-verse-speaker.ts        (story speaker from uvāca markers)
│   │   ├── 15-transcript-speakers.ts  (Name: prefix segmentation for lectures)
│   │   ├── 17-verbatim-validator.ts   (re-fetch + normalize ⊆ assertion for every rendered block)
│   │   ├── 18-image-manifest.ts       (photo registry: src/alt/caption/allowFullBleed)
│   │   ├── 19-seva-config.ts          (donation rows per region; an empty value renders as "Add in project")
│   │   ├── 20-site.ts                 (canonical origin from NEXT_PUBLIC_SITE_URL)
│   │   ├── search-v2/                 # THE SEARCH ENGINE — the only one
│   │   │   ├── pipeline.ts            (the orchestrator; joins every stage, holds the budgets)
│   │   │   ├── config.ts              (fusion weights, selection sizing, model ids)
│   │   │   ├── reference.ts           (spots a scripture reference — a retrieval clue, never a road)
│   │   │   ├── query-plan.ts          (one schema-constrained Gemini query plan + its validator)
│   │   │   ├── retrieval.ts           (vocabulary resolve, batched embedding, 5 concurrent RPCs)
│   │   │   ├── fusion.ts · dedup.ts   (one weighted RRF pass, then duplicate collapse)
│   │   │   ├── rerank.ts              (one Cohere rerank against the original question)
│   │   │   ├── select.ts              (rule-based evidence selection)
│   │   │   ├── refetch.ts             (re-reads every passage from source and asserts it verbatim)
│   │   │   ├── article-plan.ts · render.ts (structure only, then the deterministic renderer)
│   │   │   ├── adapt.ts               (maps pipeline output onto the wire contract the UI renders)
│   │   │   ├── cache.ts · rpc.ts · errors.ts · citation.ts
│   │   ├── types/01-search.ts         (shared server↔client search contract + SSE stage events)
│   │   └── server/01-lockscreen-images.ts (filesystem image reader)
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
│   │   ├── README.md                  (how to add photos + register them in the manifest)
│   │   ├── lockscreen/                (photos; auto-discovered by /api/lockscreen-images)
│   │   ├── journey/                   (path-addressed /journey chapter photos; exact filenames in its README)
│   │   ├── moments/                   (path-addressed landing Moments photos: moments-01.jpg … moments-04.jpg)
│   │   └── og-image.png               (Open Graph social preview)
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

- Upload Śrīla Prabhupāda photos to `public/images/lockscreen/` (auto-discovered by `/api/lockscreen-images`) AND register them in `app/lib/18-image-manifest.ts` with truthful alt/caption so they join the intro rotation and galleries.
- Upload the /journey chapter photos and the landing Moments photos by their exact filenames per `public/images/journey/README.md` and `public/images/moments/README.md` (path-addressed slots — placeholders are replaced automatically on redeploy, no code change).
- Fill in the real account details in `app/lib/19-seva-config.ts` (India and international rows). Any row left empty shows "Add in project" with its Copy button disabled; a filled row turns solid and copyable on its own.
- Set the real inbox in `FEEDBACK_EMAIL` (`app/components/cinematic/13-site-modals.tsx`) — every form currently composes a mail to a placeholder address. To store submissions in the `feedback` table instead, POST to `/api/feedback` from `submitForm` and update the line under the button.
- Replace the labelled sample voices in `app/components/cinematic/01-cinematic-home.tsx` (VOICES array) with real quotes, and drop the "Sample — a real voice will appear here" lines.
- Add or edit entrance verses in `public/data/entrance-quotes.json` (bhāva/prema only; verify wording and citations against Vedabase before shipping).
- After attaching the custom domain in Vercel, set `NEXT_PUBLIC_SITE_URL=https://asksrilaprabhupada.com`.
