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

Next.js 16 (App Router, Turbopack), TypeScript strict, Supabase (PostgreSQL — verses and chapters tables, 25,020 verses), Tailwind CSS 4, Framer Motion, Fonts: Cormorant Garamond, DM Sans, Noto Serif Devanagari.

### Environment Variables (in .env.local)

```
SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
SUPABASE_SERVICE_KEY=<service role key>
NEXT_PUBLIC_SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
```

### Design Direction

Light theme only. Light aurora gradients, soft lavender, whites, gentle pastels. No dark backgrounds. Card-based layouts with soft gradients, clean spacing, rounded corners, subtle shadows, and elegant typography. The overall feel should be spiritual, warm, clean, and modern.

### File Structure

Every file has a doc comment at the top explaining its purpose. Files are numbered (01-, 02-) within each folder for clear ordering.

```
/
├── app/
│   ├── api/
│   │   ├── analytics/
│   │   │   ├── behavior/route.ts      (user behavior tracking)
│   │   │   ├── feedback/route.ts      (thumbs up/down votes)
│   │   │   └── log/route.ts           (search query logging)
│   │   ├── feedback/route.ts          (contact/feature request forms)
│   │   ├── lockscreen-images/
│   │   │   ├── route.ts               (image list endpoint)
│   │   │   └── heic/route.ts          (HEIC-to-JPEG conversion)
│   │   ├── search/route.ts            (hybrid search + AI narrative)
│   │   └── verse/route.ts             (single verse lookup)
│   ├── components/
│   │   ├── layout/                    # App shell
│   │   │   ├── 01-header.tsx          (sticky frosted-glass nav)
│   │   │   └── 02-footer.tsx          (site footer)
│   │   ├── search/                    # Search input and progress
│   │   │   ├── 01-hero-search.tsx     (main search bar)
│   │   │   ├── 02-typewriter-placeholder.tsx
│   │   │   ├── 03-voice-input.tsx     (microphone button)
│   │   │   ├── 04-examples-popover.tsx
│   │   │   ├── 05-search-progress.tsx (multi-step loader)
│   │   │   └── 06-search-feedback.tsx (thumbs voting)
│   │   ├── results/                   # Search results display
│   │   │   ├── 01-narrative-response.tsx (2-column layout: content + summary sidebar)
│   │   │   ├── 04-verse-block.tsx     (verse card)
│   │   │   ├── 05-purport-block.tsx   (purport card)
│   │   │   ├── 06-want-more-modal.tsx (expanded book results)
│   │   │   └── 07-dig-deeper-modal.tsx (full results modal)
│   │   ├── overlays/                  # Modal dialogs
│   │   │   ├── 01-page-overlay.tsx    (reusable modal wrapper)
│   │   │   ├── 02-about-overlay.tsx
│   │   │   ├── 03-donate-overlay.tsx  (bank details + copy)
│   │   │   ├── 04-contact-overlay.tsx
│   │   │   └── 05-feature-request-overlay.tsx
│   │   ├── landing/                   # Landing page sections
│   │   │   ├── 01-why-different.tsx
│   │   │   ├── 02-features-section.tsx
│   │   │   ├── 03-steps-section.tsx
│   │   │   ├── 04-testimonials-section.tsx
│   │   │   └── 05-cta-section.tsx
│   │   ├── feedback/
│   │   │   └── 01-feedback-button.tsx (floating widget)
│   │   └── lockscreen/
│   │       └── 01-lock-screen.tsx     (intro slideshow)
│   ├── hooks/
│   │   └── 01-use-search-behavior-tracker.ts
│   ├── lib/
│   │   ├── 01-supabase.ts            (database client)
│   │   ├── 02-analytics.ts           (tracking helpers)
│   │   ├── 03-embed.ts               (vector embeddings)
│   │   ├── 04-search-cache.ts        (result caching)
│   │   ├── 05-link-postprocessor.ts   (citation linking)
│   │   ├── 06-lockscreen-data.ts      (slideshow config)
│   │   ├── 07-query-preprocessor.ts   (search query extraction)
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
├── scripts/
│   ├── 01-generate-embeddings.ts      (batch embedding generation)
│   ├── 02-generate-tags.ts            (batch tag generation)
│   └── 03-verify-urls.ts             (URL verification utility)
├── public/
│   ├── images/
│   │   ├── lockscreen/                (admin uploads photos here)
│   │   └── og-image.png               (Open Graph social preview)
│   ├── videos/lockscreen/             (optional video uploads)
│   └── data/donate.json               (admin fills bank details)
├── package.json
├── next.config.ts
├── tsconfig.json
├── postcss.config.mjs
└── CLAUDE.md
```

### Supabase Connection Guide

1. Go to https://supabase.com and open your project (URL: wzktlpjtqmjxvragwhqg.supabase.co).
2. Go to Project Settings → API. Copy the anon public key and the service_role secret key.
3. Create a `.env.local` file in the repo root with the four environment variables listed above.
4. Make sure the `verses` table and `chapters` table exist with the correct schema.
5. If deploying to Vercel, add these same environment variables in Vercel dashboard → Settings → Environment Variables.

### Admin Actions Required

- Upload Śrīla Prabhupāda photos to `public/images/lockscreen/` and update filenames in `app/lib/06-lockscreen-data.ts`.
- Optionally upload videos to `public/videos/lockscreen/` and set the path in `06-lockscreen-data.ts`.
- Edit `public/data/donate.json` with actual bank details.
