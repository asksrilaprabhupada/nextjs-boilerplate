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

```
/
├── app/
│   ├── api/search/route.ts
│   ├── api/verse/route.ts
│   ├── components/
│   │   ├── AboutOverlay.tsx
│   │   ├── ContactOverlay.tsx
│   │   ├── DonateOverlay.tsx      (bank details with copy buttons)
│   │   ├── GoDeeper.tsx
│   │   ├── Header.tsx             (light theme, frosted glass)
│   │   ├── HeroSearch.tsx         (light theme)
│   │   ├── LockScreen.tsx         (local images/video, no clock)
│   │   ├── NarrativeResponse.tsx
│   │   ├── PageOverlay.tsx
│   │   ├── PurportBlock.tsx       (card-based, light theme)
│   │   ├── ScriptureLayer.tsx     (card-based, light theme)
│   │   └── VerseBlock.tsx         (card-based, light theme)
│   ├── lib/
│   │   ├── lockscreen-data.ts     (local image paths, no Unsplash)
│   │   └── supabase.ts
│   ├── verse/[id]/page.tsx        (light theme)
│   ├── globals.css                (complete light theme)
│   ├── layout.tsx
│   └── page.tsx
├── public/
│   ├── images/lockscreen/         (admin uploads Prabhupada photos here)
│   ├── videos/lockscreen/         (admin uploads videos here, optional)
│   └── data/donate.json           (admin fills in bank details here)
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

- Upload Śrīla Prabhupāda photos to `public/images/lockscreen/` and update filenames in `app/lib/lockscreen-data.ts`.
- Optionally upload videos to `public/videos/lockscreen/` and set the path in `lockscreen-data.ts`.
- Edit `public/data/donate.json` with actual bank details.
