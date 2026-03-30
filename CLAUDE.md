## CLAUDE.md

Instructions for Claude Code

Project: **Ask Śrīla Prabhupāda** — AI-powered devotional search engine across 36 books, 3,700+ lectures, and 6,500+ letters of His Divine Grace A.C. Bhaktivedanta Swami Prabhupāda. 244,000+ searchable passages.

### Quick Start

```bash
npm install
npm run dev    # localhost:3000
npm run build  # production build
```

### Tech Stack

- **Framework:** Next.js 16 (App Router, Turbopack) + React 19 + TypeScript strict
- **Database:** Supabase (PostgreSQL) — tables: `verses`, `verse_chunks`, `prose_paragraphs`, `transcript_paragraphs`, `letter_paragraphs`, plus `search_logs`, `search_behavior`, `feedback`
- **Search:** Hybrid semantic (Gemini embeddings + pgvector) + full-text + tag-based, ranked with RRF (Reciprocal Rank Fusion)
- **AI:** Gemini 2.0 Flash for narrative generation and query preprocessing, streamed via SSE
- **Styling:** Tailwind CSS 4, Framer Motion animations
- **Fonts:** Cormorant Garamond (headings), DM Sans (body), Noto Serif Devanagari (Sanskrit)
- **Image Processing:** Sharp (HEIC-to-JPEG conversion)
- **Deployment:** Vercel

### Environment Variables (.env.local)

```
SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
SUPABASE_SERVICE_KEY=<service role key>
NEXT_PUBLIC_SUPABASE_URL=https://wzktlpjtqmjxvragwhqg.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon key>
GEMINI_API_KEY=<Gemini API key for embeddings + narrative generation>
```

### Design Direction

Light theme only. No dark mode. Light aurora gradients, soft lavender (#D6C3FF), whites (#FFF8FC), gentle pastels. Card-based layouts with glassmorphism (`rgba(255,255,255,0.72)` backgrounds, `backdrop-filter: blur`), clean spacing, rounded corners, subtle shadows, and elegant typography. The overall feel should be spiritual, warm, clean, and modern.

Key CSS variables are defined in `app/globals.css`: `--bg-deep`, `--bg-surface`, `--bg-card`, `--garden-violet` (#8B5CF6), `--garden-deep-violet` (#7C3AED), `--garden-lavender`, `--garden-rose`, `--garden-blush`.

### Architecture Overview

Single-page app with search-driven UX. The home page (`app/page.tsx`) orchestrates everything: lock screen → hero search → streaming results → landing sections → overlays. All components are client-side (`"use client"`).

**Search flow:**
1. User types query → `01-hero-search.tsx` submits to `/api/search`
2. `07-query-preprocessor.ts` breaks long queries into focused phrases (Gemini Flash)
3. `03-embed.ts` generates vector embeddings (Gemini API)
4. `/api/search/route.ts` runs hybrid search (semantic + full-text + tags) with RRF scoring
5. Gemini 2.0 Flash generates narrative from top results, streamed via SSE
6. `05-link-postprocessor.ts` converts citation references to Vedabase.io links
7. `01-narrative-response.tsx` renders 2-column layout (narrative + summary sidebar)

**Caching:** In-memory cache (`04-search-cache.ts`) — 2,000 entries, 24-hour TTL (corpus is fixed).

### File Structure

Every file has a doc comment at the top explaining its purpose. Files are numbered (01-, 02-) within each folder for clear ordering.

```
app/
├── api/
│   ├── search/route.ts              # Core: hybrid search + Gemini narrative + SSE streaming
│   ├── verse/route.ts               # Single verse lookup by ID
│   ├── feedback/route.ts            # Contact/feature request form submissions
│   ├── generate-summary/route.ts    # Summary generation endpoint
│   ├── generate-article/route.ts    # Article generation endpoint
│   ├── analytics/
│   │   ├── log/route.ts             # Search query logging (queries, result counts, timing)
│   │   ├── behavior/route.ts        # User behavior (clicks, scroll depth, follow-ups)
│   │   └── feedback/route.ts        # Thumbs up/down votes on results
│   └── lockscreen-images/
│       ├── route.ts                 # Returns slideshow image list
│       └── heic/route.ts            # HEIC-to-JPEG conversion (Sharp)
├── components/
│   ├── layout/
│   │   ├── 01-header.tsx            # Sticky frosted-glass nav (Search, Features, How It Works, More dropdown)
│   │   └── 02-footer.tsx            # Site footer with branding and links
│   ├── search/
│   │   ├── 01-hero-search.tsx       # Main search bar (voice, typewriter placeholder, examples, progress)
│   │   ├── 02-typewriter-placeholder.tsx  # Rotating example questions animation
│   │   ├── 03-voice-input.tsx       # Web Speech API microphone button
│   │   ├── 04-examples-popover.tsx  # Clickable example question pills + modal
│   │   ├── 05-search-progress.tsx   # Multi-step progress indicator during search
│   │   └── 06-search-feedback.tsx   # Thumbs up/down voting after results
│   ├── results/
│   │   ├── 01-narrative-response.tsx  # 2-column: narrative content (75%) + summary sidebar (25%)
│   │   ├── 04-verse-block.tsx       # Verse card (Sanskrit, transliteration, translation, Vedabase link)
│   │   ├── 05-purport-block.tsx     # Purport commentary card
│   │   ├── 06-want-more-modal.tsx   # All results from a specific book
│   │   └── 07-dig-deeper-modal.tsx  # Full results modal (filters, book dropdown, topic grouping)
│   ├── overlays/
│   │   ├── 01-page-overlay.tsx      # Reusable Framer Motion slide-in modal wrapper
│   │   ├── 02-about-overlay.tsx     # About: mission, stats (25,131 verses, 36,412 prose, 144,438 lectures, 19,468 letters)
│   │   ├── 03-donate-overlay.tsx    # Bank details from /data/donate.json + copy buttons
│   │   ├── 04-contact-overlay.tsx   # Contact form (name, email, message)
│   │   └── 05-feature-request-overlay.tsx  # Feature request form
│   ├── landing/
│   │   ├── 00-sources-section.tsx   # Stats cards: 36 books, 3,700+ lectures, 6,500+ letters
│   │   ├── 01-why-different.tsx     # Value props: Not AI fluff, Exact citations, Every source
│   │   ├── 02-features-section.tsx  # Features grid (AI search, narrative answers, citations, open source)
│   │   ├── 03-steps-section.tsx     # 3 steps: Ask → Verify → Go deeper
│   │   ├── 04-testimonials-section.tsx  # 3 user testimonials
│   │   └── 05-cta-section.tsx       # Call-to-action with scroll-to-search
│   ├── feedback/
│   │   ├── 01-feedback-button.tsx   # Floating bottom-right feedback/bug/feature widget
│   │   └── 02-scroll-top-button.tsx # Floating scroll-to-top arrow
│   └── lockscreen/
│       └── 01-lock-screen.tsx       # Full-screen intro slideshow (Ken Burns, daily verse, optional video)
├── hooks/
│   └── 01-use-search-behavior-tracker.ts  # Tracks time spent, scroll depth, citation clicks
├── lib/
│   ├── 01-supabase.ts              # Supabase client init (browser + server via service role key)
│   ├── 02-analytics.ts             # Session/visitor ID generation, search/behavior/feedback logging
│   ├── 03-embed.ts                 # Gemini API text → vector embedding
│   ├── 04-search-cache.ts          # In-memory LRU cache (2,000 entries, 24hr TTL)
│   ├── 05-link-postprocessor.ts    # Citation refs → Vedabase.io clickable links (BG, SB, CC, etc.)
│   ├── 06-lockscreen-data.ts       # Slideshow config (image list, fallback, Ken Burns directions, daily verses)
│   ├── 07-query-preprocessor.ts    # Gemini Flash: long queries → 3-5 focused phrases + tags
│   └── server/
│       └── 01-lockscreen-images.ts  # Filesystem reader for public/images/lockscreen/ (.jpg/.png/.webp/.heic)
├── types/
│   └── 01-speech.d.ts              # TypeScript defs for Web Speech API (SpeechRecognition)
├── verse/[id]/page.tsx              # Dynamic verse detail page
├── features/page.tsx                # Features page (uses FeaturesSection component)
├── how-it-works/page.tsx            # How-it-works page (uses StepsSection component)
├── globals.css                      # Complete light theme, CSS variables, animations, utility classes
├── layout.tsx                       # Root layout: fonts, metadata, SEO, background gradients, SVG grain
├── page.tsx                         # Home page orchestrator (lock screen → search → results → landing)
├── robots.ts                        # robots.txt: allow /, disallow /api/
└── sitemap.ts                       # XML sitemap: home, /features, /how-it-works

scripts/
├── 01-generate-embeddings.ts        # Batch: generate vector embeddings for all passages
├── 02-generate-tags.ts              # Batch: generate tags for passages
└── 03-verify-urls.ts               # Utility: verify Vedabase.io citation URLs

public/
├── images/
│   ├── lockscreen/                  # Admin uploads Prabhupāda photos here
│   └── og-image.png                 # Open Graph social preview (1200x630)
├── videos/lockscreen/               # Optional video backgrounds
├── data/donate.json                 # Admin fills bank/payment details
├── favicon.ico
└── apple-touch-icon.png
```

### Key Component Props

```typescript
// HeroSearch
{ onSearch: (query: string) => void, onClear?: () => void, isSearching: boolean, hasResults: boolean, currentQuery?: string }

// NarrativeResponse — key types
Citation: { ref: string, book: string, url: string, type: "verse" | "prose", title: string }
VerseHit: { id, ref, book_slug, book_name, chapter, verse_number, sanskrit_devanagari, transliteration, translation, purport, ... }
ProseHit: { id, ref, book_slug, book_name, chapter_title, content, ... }
BookGroup: { slug: string, name: string, verses: VerseHit[], prose: ProseHit[] }

// Header
{ onMoreItemSelect?: (item: "About" | "Donate" | "Contact" | "Feature Request") => void, onSearchClick?: () => void }

// PageOverlay
{ isOpen: boolean, onClose: () => void, children: React.ReactNode }
```

### Content Statistics

- **25,131** verses with Sanskrit, transliteration, synonyms, translation, and purport
- **36,412** prose paragraphs from 36 books
- **144,438** lecture passages from 3,703 recorded lectures
- **19,468** letter passages from 6,587 personal letters
- **244,000+** total searchable passages
- All citations link to [Vedabase.io](https://vedabase.io)

### Supabase Setup

1. Open project at https://supabase.com (project URL: wzktlpjtqmjxvragwhqg.supabase.co)
2. Project Settings → API → copy anon key and service_role key
3. Create `.env.local` with the five environment variables above
4. Required tables: `verses`, `verse_chunks`, `prose_paragraphs`, `transcript_paragraphs`, `letter_paragraphs`, `search_logs`, `search_behavior`, `feedback`
5. For Vercel deployment: add same env vars in Vercel dashboard → Settings → Environment Variables

### Admin Actions

- Upload Śrīla Prabhupāda photos to `public/images/lockscreen/` and update filenames in `app/lib/06-lockscreen-data.ts`
- Optionally upload videos to `public/videos/lockscreen/` and set path in `06-lockscreen-data.ts`
- Edit `public/data/donate.json` with actual bank/payment details

### Coding Conventions

- Every file starts with a `/** doc comment */` explaining its purpose
- Files numbered `01-`, `02-` within folders for ordering
- All components are `"use client"` (client-side React)
- Landing sections use IntersectionObserver + `.scroll-reveal` class for entrance animations
- Inline styles used extensively (not CSS modules) — this is intentional for component co-location
- Path alias: `@/*` maps to repo root
