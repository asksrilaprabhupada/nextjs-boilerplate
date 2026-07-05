# IMAGE AUDIT — "Real Search" Release (Task 1.4 / Task 8)

Inventory date: 2026-07-05. Full recursive listing of `public/` image/video assets and every
reference in code.

## A. Present assets

| File | Size | Referenced by |
|---|---|---|
| `public/images/lockscreen/prabhupadaanddisciplessmiling.jpg` | 642 KB | `cinematic/01-cinematic-home.tsx` (IMG.disciples — entrance beat 2, gallery, CTA), `05-journey-page.tsx` ×2, `06/07-*` pages |
| `public/images/lockscreen/Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg` | 38 KB | `IMG.deities` — gallery ×2, journey interlude + storefront |
| `public/images/lockscreen/Srila-Prabhupada-on-morning-walk-in-Vrindavan-620x350.avif` | 10 KB | `IMG.walk` — gallery, journey crossing. **Only 620×350 — must never render wider than ~620 px** (Task 8 policy: card-width slots only) |
| `public/images/og-image.png` | 304 KB | `app/layout.tsx` OG/Twitter metadata |
| `public/data/donate.json` | 153 B | orphaned `overlays/03-donate-overlay.tsx` only |
| `public/videos/lockscreen/` | empty (`.gitkeep`) | optional admin video slot |

All three photos are also auto-discovered and served by `/api/lockscreen-images`.

## B. Referenced-but-missing

| Reference | Where | Status |
|---|---|---|
| `/images/lockscreen/Prabh14.jpg` | `app/lib/06-lockscreen-data.ts:23` (slideshow fallback) | Deleted in commit `9483c47` ("Added APIs freshly"). **Restored from git history in Task 8.** |

## C. Deleted-in-history (git log --diff-filter=D -- public/images)

| File | Deleted in | Action |
|---|---|---|
| `public/images/lockscreen/Prabh14.jpg` | `9483c47` | Restore (`git checkout 9483c47^ -- <path>`) — Task 8 |
| `public/images/lockscreen/CT03-044-620x350.avif` | `9483c47` | Restore — Task 8 |
| `public/images/lockscreen/.gitkeep` | `d684e30` | Not needed (dir non-empty) |

## D. External design-tool URLs (v0.dev / *.vercel-storage.com / blob URLs / claude / design hosts)

**None found anywhere in the repo.** Nothing to localize.

## E. RE-EXPORT NEEDED — download from Claude Design and drop into `public/images/design/`

**None.** The owner reported photos added via Claude Design as missing; the audit found no code
references to any such files (no dangling imports, no external URLs). If the owner has additional
photos from Claude Design sessions, they were never committed nor referenced — export them manually
into `public/images/lockscreen/` (auto-discovered) and register them in
`app/lib/18-image-manifest.ts`.

## F. Usage-pattern notes (feeds Task 8)

- No `next/image` usage anywhere; all imagery is CSS `background-image` cover (crops freely — the
  reported "intro photo gets cropped" bug). Fixed in Task 8 via dual-layer (blurred cover backdrop +
  `object-fit: contain` subject).
- The 4-card "Moments" gallery (`01-cinematic-home.tsx` GALLERY) reuses 3 photos with mismatched
  captions ("03 — With disciples" shows the morning walk; "04 — The books" repeats the Deity photo).
  Fixed in Task 8 with distinct manifest images + truthful captions.
- After restoration the pool is **5 photos**; the intro rotation (max 4 per 26 s intro) and gallery
  (4 distinct) both fit.
