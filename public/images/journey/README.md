# Journey photos (path-addressed slots)

Photos for the **His Journey** page (`/journey`). These slots are
**path-addressed**: drop a file with the exact name below into this folder,
commit, and redeploy — the on-page placeholder is replaced automatically, with
no code change. Until a file exists, its slot shows a calm "Photograph coming"
card. No manifest registration is needed (unlike `lockscreen/`).

Exact filenames (case-sensitive, `.jpg`):

| Filename | Where it appears |
| --- | --- |
| `journey-1965-jaladuta-ship.jpg` | Chapter 1 (the Jaladuta). Also becomes the landing page's 1965 banner background once it exists. |
| `journey-1965-arrival-new-york.jpg` | Chapter 2 (arrival in New York) |
| `journey-1966-matchless-gifts-storefront.jpg` | Chapter 3 (26 Second Avenue storefront) |
| `journey-books-translating.jpg` | Chapter 4 (translating the books) |
| `journey-1966-77-world.jpg` | Chapter 5 (around the world) |
| `journey-quote-background.jpg` | Optional — interlude verse background. Falls back to the current Deities photo until uploaded. |

Rules:

- **Authentic archival photographs only** — never an AI-generated or stock
  stand-in. Each filename promises its subject; the alt text in the code
  describes exactly that subject, so the file must actually show it.
- Recommended sizes: ≥1440px wide for the chapter frames; ≥1600px wide for
  `journey-quote-background.jpg` (it renders full-bleed).
- Until a file is uploaded, the browser logs a 404 for its path on page load.
  That is expected and harmless — it is how the slot detects the file.
