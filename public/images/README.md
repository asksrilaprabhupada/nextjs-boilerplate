# Photos

Two different mechanisms live under this folder:

**`lockscreen/` — automatic.** Drop a photograph directly into `lockscreen/`,
commit, and redeploy. The production build inspects the actual image bytes and
automatically adds every valid photo to the cinematic doorway. Real HEIC/HEIF
(HEVC) bytes are detected from their container brand and decoded by the bundled
JavaScript/WebAssembly decoder; AVIF and the other supported formats stay on
the Sharp path. HEIC/HEIF and extension-mismatched files are normalized to a
browser-safe JPEG without resizing or cropping. A corrupt or unsupported file
fails the build and names the exact file to fix. No manifest edit is needed.

**`journey/` and `moments/` — path-addressed slots.** The `/journey` chapter
frames and the landing Moments gallery load fixed, exactly named paths and
show an honest placeholder until each file exists. Upload the file, commit,
redeploy — no manifest entry and no code change needed. See
`journey/README.md` and `moments/README.md` for the exact filenames.

`ChatGPT Image Aug 10, 2026, 05_51_20 AM.png` is the untouched owner-selected
source artwork. `social-share-v2.jpg` is its no-crop, baseline-JPEG derivative
used by Open Graph, Twitter, and structured metadata in `app/layout.tsx`. The
share derivative must stay at or below 300 KiB for conservative messenger
compatibility. When `lockscreen/` contains no photos, the doorway keeps its
existing dark gradient and text treatment without requesting a substitute image.
