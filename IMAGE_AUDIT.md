# IMAGE AUDIT — "Real Search" Release (Task 1.4 / Task 8)

Inventory date: 2026-07-05. Full recursive listing of `public/` image/video assets and every
reference in code.

> Historical snapshot: on 2026-08-09 the manual `app/lib/18-image-manifest.ts`
> registry was removed in favor of validated build-time discovery from
> `public/images/lockscreen/`. `Prabh14.jpg` and `CT03-044-620x350.avif` were
> deleted at the owner's request. The dated findings below are retained as the
> record of the earlier release.
>
> The final Task 8 cleanup also replaced the retired social card with the
> owner-selected `ChatGPT Image Aug 10, 2026, 05_51_20 AM.png` in Open Graph,
> Twitter, and structured metadata. Its real 1672×941 dimensions are declared;
> no crop or image alteration is performed by the application.

## A. Present assets

| File | Size | Referenced by |
|---|---|---|
| `public/images/lockscreen/prabhupadaanddisciplessmiling.jpg` | 642 KB | `cinematic/01-cinematic-home.tsx` (IMG.disciples — entrance beat 2, gallery, CTA), `05-journey-page.tsx` ×2, `06/07-*` pages |
| `public/images/lockscreen/Srila-Prabhupada-looking-at-Krishna-Balaram-Deities-Vrindavan-India.jpg` | 38 KB | `IMG.deities` — gallery ×2, journey interlude + storefront |
| `public/images/lockscreen/Srila-Prabhupada-on-morning-walk-in-Vrindavan-620x350.avif` | 10 KB | `IMG.walk` — gallery, journey crossing. **Only 620×350 — must never render wider than ~620 px** (Task 8 policy: card-width slots only) |
| `public/images/ChatGPT Image Aug 10, 2026, 05_51_20 AM.png` | 2.38 MB | `app/layout.tsx` Open Graph/Twitter/structured metadata |
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
| `public/images/lockscreen/Prabh14.jpg` | `9483c47` | ✅ Restored (682×466) — Task 8 |
| `public/images/lockscreen/CT03-044-620x350.avif` | `9483c47` | ✅ Restored (620×350) — Task 8 |
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

- ✅ FIXED (Task 8): the intro is now dual-layer (blurred cover backdrop + `object-fit: contain`
  subject) — the photograph itself is never cropped at any viewport shape — and rotates through the
  full manifest (sessionStorage-seeded start, 9 s crossfade, max 4 per intro, first two preloaded,
  once per session with a `?intro=1` QA override).
- ✅ FIXED (Task 8): the Moments gallery shows 4 DISTINCT photos with truthful captions and renders
  via `next/image` (fill + sizes + real alt). The 620×350 walk AVIF no longer stretches full-bleed —
  the journey-teaser band uses the restored 682×466 `Prabh14.jpg` behind a deliberate blur, and both
  parallax CSS backgrounds now carry `role="img"` + `aria-label`.
- Manifest: `app/lib/18-image-manifest.ts` registers every photo ({src, alt, caption, dimensions,
  allowFullBleed}); `public/images/README.md` tells the owner how to add more. Pool is **5 photos**.
