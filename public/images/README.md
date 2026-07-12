# Photos

Two different mechanisms live under this folder:

**`lockscreen/` — manifest-registered.** Drop new photographs into
`lockscreen/` — they are auto-discovered and served by `/api/lockscreen-images`
(HEIC/HEIF files are converted on the fly). To include a photo in the
cinematic intro rotation, also register it in
**`app/lib/18-image-manifest.ts`** with a truthful `alt` and `caption`
(describe what the photo actually shows). Mark `allowFullBleed: true` only for
sources comfortably wider than ~1600px — smaller scans (like the 620×350
AVIFs) must stay in card-width slots or behind a deliberate blur backdrop.

**`journey/` and `moments/` — path-addressed slots.** The /journey chapter
frames and the landing Moments gallery load fixed, exactly named paths and
show an honest placeholder until each file exists. Upload the file, commit,
redeploy — no manifest entry and no code change needed. See
`journey/README.md` and `moments/README.md` for the exact filenames.

`og-image.png` is the social-share card referenced from `app/layout.tsx`.
