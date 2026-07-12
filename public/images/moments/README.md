# Moments photos (path-addressed slots)

Photos for the landing page's **Moments** gallery (four cards). These slots
are **path-addressed**: drop files with the exact names below into this
folder, commit, and redeploy — each card's placeholder is replaced
automatically, with no code change. No manifest registration is needed
(unlike `lockscreen/`).

Exact filenames (case-sensitive, `.jpg`):

- `moments-01.jpg`
- `moments-02.jpg`
- `moments-03.jpg`
- `moments-04.jpg`

Rules:

- **Authentic archival photographs only** — never an AI-generated or stock
  stand-in.
- Card-width slots: ≥1000px wide recommended.
- The captions and alt text in the code are deliberately **neutral**
  ("01 — Śrīla Prabhupāda · archival photograph"). After uploading the four
  photos, supply the real caption lines as a follow-up edit to the `GALLERY`
  constant in `app/components/cinematic/01-cinematic-home.tsx` — captions must
  describe what each photo actually shows.
- Until a file is uploaded, the browser logs a 404 for its path on page load.
  That is expected and harmless — it is how the slot detects the file.
