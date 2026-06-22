## CLAUDE.md

Instructions for Claude Code

Project: Ask Śrīla Prabhupāda

Next.js 16 App Router project. Supabase backend. The only app/ folder is the Next.js App Router directory. Run `npm install` then `npm run dev` to start at localhost:3000.

### Commands

```
npm install
npm run dev
npm run build
```

### Tech Stack

Next.js 16 (App Router, Turbopack), TypeScript strict, Supabase (PostgreSQL — verses, verse_chunks, prose_paragraphs, transcript_paragraphs, letter_paragraphs tables, 244,000+ searchable passages), Tailwind CSS 4, Framer Motion. AI: Voyage AI (voyage-context-4 query embeddings, 1024-dim), Google Gemini (narrative generation + query preprocessing), Cohere Rerank v4.0 Pro (relevance reranking). Image processing: sharp (HEIC → JPEG). Fonts: Cormorant Garamond, DM Sans, Noto Serif Devanagari.

### Environment Variables (in .env.local)

```
SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
SUPABASE_SERVICE_KEY=<service role key>
NEXT_PUBLIC_SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
VOYAGE_API_KEY=<voyage ai key>             # query embeddings (voyage-context-4, 1024-dim)
GEMINI_API_KEY=<google ai studio key>      # query preprocessing, narrative generation
COHERE_API_KEY=<cohere key>                # search result reranking (rerank-v4.0-pro)
```

### Design Direction

Light theme only. Light aurora gradients, soft lavender, whites, gentle pastels. No dark backgrounds. Card-based layouts with soft gradients, clean spacing, rounded corners, subtle shadows, and elegant typography. The overall feel should be spiritual, warm, clean, and modern.

### File Structure

Every file has a doc comment at the top explaining its purpose. Files are numbered (01-, 02-) within each folder, gaplessly, for clear ordering. Every file in the repository is used directly by the web app or the Supabase-backed API — there is no dead code or unused asset.

```
/
├── app/
│   ├── api/
│   │   ├── analytics/
│   │   │   ├── behavior/route.ts      (user behavior tracking)
│   │   │   ├── feedback/route.ts      (thumbs up/down votes)
│   │   │   └── log/route.ts           (search query logging)
│   │   ├── feedback/route.ts          (contact/feature request forms)
│   │   ├── generate-article/route.ts  (AI narrative article generation; exports getSpeaker helper)
│   │   ├── lockscreen-images/
│   │   │   ├── route.ts               (image list endpoint)
│   │   │   └── heic/route.ts          (HEIC-to-JPEG conversion via sharp)
│   │   ├── search/route.ts            (hybrid search + RRF + Cohere rerank + AI narrative)
│   │   └── verse/route.ts             (single verse lookup)
│   ├── components/
│   │   ├── feedback/                  # Floating widgets
│   │   │   ├── 01-feedback-button.tsx (floating widget)
│   │   │   └── 02-scroll-top-button.tsx (scroll-to-top button)
│   │   ├── landing/                   # Landing page sections
│   │   │   ├── 01-sources-section.tsx
│   │   │   ├── 02-why-different.tsx
│   │   │   ├── 03-features-section.tsx
│   │   │   ├── 04-steps-section.tsx
│   │   │   ├── 05-testimonials-section.tsx
│   │   │   └── 06-cta-section.tsx
│   │   ├── layout/                    # App shell
│   │   │   ├── 01-header.tsx          (sticky frosted-glass nav)
│   │   │   └── 02-footer.tsx          (site footer)
│   │   ├── lockscreen/
│   │   │   └── 01-lock-screen.tsx     (intro slideshow)
│   │   ├── overlays/                  # Modal dialogs
│   │   │   ├── 01-page-overlay.tsx    (reusable modal wrapper)
│   │   │   ├── 02-about-overlay.tsx
│   │   │   ├── 03-donate-overlay.tsx  (bank details + copy)
│   │   │   ├── 04-contact-overlay.tsx
│   │   │   └── 05-feature-request-overlay.tsx
│   │   ├── results/                   # Search results display
│   │   │   ├── 01-narrative-response.tsx (2-column layout: content + summary sidebar)
│   │   │   ├── 02-want-more-modal.tsx (expanded book results)
│   │   │   └── 03-dig-deeper-modal.tsx (full results modal)
│   │   └── search/                    # Search input and progress
│   │       ├── 01-hero-search.tsx     (main search bar)
│   │       ├── 02-typewriter-placeholder.tsx
│   │       ├── 03-voice-input.tsx     (microphone button)
│   │       ├── 04-examples-popover.tsx
│   │       ├── 05-search-progress.tsx (multi-step loader)
│   │       └── 06-search-feedback.tsx (thumbs voting)
│   ├── hooks/
│   │   └── 01-use-search-behavior-tracker.ts
│   ├── lib/
│   │   ├── 01-supabase.ts            (shared server-side Supabase admin client)
│   │   ├── 02-analytics.ts           (tracking helpers)
│   │   ├── 03-embed.ts               (vector embeddings)
│   │   ├── 04-search-cache.ts        (result caching)
│   │   ├── 05-link-postprocessor.ts   (citation linking)
│   │   ├── 06-lockscreen-data.ts      (slideshow config + daily verses)
│   │   ├── 07-query-preprocessor.ts   (search query extraction)
│   │   ├── 08-cohere-rerank.ts        (Cohere Rerank v4.0 Pro relevance reranking)
│   │   ├── 09-purport-format.ts       (shared purport paragraph/footer helpers)
│   │   ├── 10-passage-fold.ts         (shared fold preview + matched-line highlight + verbatim key line)
│   │   └── server/
│   │       └── 01-lockscreen-images.ts (filesystem image reader)
│   ├── types/
│   │   └── 01-speech.d.ts            (Web Speech API types)
│   ├── verse/[id]/page.tsx            (verse detail page)
│   ├── features/page.tsx
│   ├── how-it-works/page.tsx
│   ├── globals.css                    (complete light theme)
│   ├── layout.tsx                     (root layout + fonts)
│   ├── page.tsx                       (home page)
│   ├── robots.ts
│   └── sitemap.ts
├── public/
│   ├── data/donate.json               (admin fills bank details)
│   ├── images/
│   │   ├── lockscreen/                (slideshow photos; every image here is auto-discovered and served by /api/lockscreen-images)
│   │   └── og-image.png               (Open Graph social preview)
│   └── videos/lockscreen/             (optional admin video upload)
├── package.json
├── next.config.ts
├── tsconfig.json
├── postcss.config.mjs
└── CLAUDE.md
```

### Supabase Connection Guide

1. Go to https://supabase.com and open your project (URL: wzktlpjtqmjxvragwhqg.supabase.co).
2. Go to Project Settings → API. Copy the anon public key and the service_role secret key.
3. Create a `.env.local` file in the repo root with the environment variables listed above (Supabase keys plus `VOYAGE_API_KEY`, `GEMINI_API_KEY`, and `COHERE_API_KEY` for search).
4. Make sure the `verses` table and `chapters` table exist with the correct schema.
5. If deploying to Vercel, add these same environment variables in Vercel dashboard → Settings → Environment Variables.

All server-side Supabase access goes through the single shared client in `app/lib/01-supabase.ts` (`getSupabaseAdmin()`); API routes never construct their own client.

### Admin Actions Required

- Upload Śrīla Prabhupāda photos to `public/images/lockscreen/`. They are auto-discovered by `/api/lockscreen-images` — no code change needed. `app/lib/06-lockscreen-data.ts` holds only the fallback image and the daily-verse rotation.
- Optionally upload a video to `public/videos/lockscreen/` and set its path in `06-lockscreen-data.ts` (`lockscreenVideo`).
- Edit `public/data/donate.json` with actual bank details.
