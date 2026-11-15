# Cinematic redesign — build instructions for Claude Code

The owner designed and approved a new look for the site in a design canvas. This folder contains everything from that canvas. Your job is to build that look into the real site. Change only how the site looks and moves; the search engine stays exactly as it is.

Read this whole file before you change anything.

## What is in this folder

- `designs/*.dc.html`: the approved screens. Each file is HTML with inline styles, a `<style>` block inside `<helmet>`, and a small script. Copy colours, sizes, spacing, fonts, shadows and animations from them **exactly**.
  - `<x-dc>`, `<helmet>`, `<sc-for>`, `<sc-if>`, `{{ … }}` and `class Component extends DCLogic` are the canvas's own template syntax. Read past them. They are not code to ship.
  - Read a list like `<sc-for list="{{ verses }}" as="v">` as "repeat this block for each item".
  - The screens are fixed mockups: desktop is 1440 px wide, phone is 375 × 667. Build them as normal responsive pages:
    - The phone layout applies below 768 px.
    - The desktop layout applies from 768 px up, which includes iPad.
- `public/images/redesign/`: every image the designs use, already sized and in WebP. The designs reference these by their real paths, for example `/images/redesign/photos/with-disciples.webp`.
  - `photos/`: real photographs of Śrīla Prabhupāda, taken from this repo's own images.
  - `logo/`: crops of a photograph the owner supplied. `face-gold` and `medallion-gold` are gold-toned; `face-colour` and `medallion-colour` keep the natural colours.
- `data/entrance-quotes.json`: the new doorway verse pool, 24 verses. Same format as `public/data/entrance-quotes.json`.
- `data/self-typing-questions.json`: the questions that type themselves in the search box (8 for desktop and iPad, 8 shorter ones for phone).
- `data/lineage.json`: the 15 names shown while a search runs.

| Screen | Desktop / iPad | Phone |
|---|---|---|
| Doorway (lock screen) | `Main.dc.html` | `PhoneEntry.dc.html` |
| Ask (home) | `Ask.dc.html` | `PhoneAsk.dc.html` |
| Searching | `Searching.dc.html` | `PhoneSearching.dc.html` |
| Answer | `Answer.dc.html` | `PhoneAnswer.dc.html` |
| Dig Deeper | `DigDeeper.dc.html` | (same page, narrowed) |
| Advanced (switched off, see below) | `Advanced.dc.html` | `PhoneAdvanced.dc.html` |
| Context story (not built now) | `ContextStory.dc.html` | — |
| Logo sheet | `Logo.dc.html` | — |

## Rules that must not be broken

1. **Look and feel only.** Do not touch `app/lib/search-v2/`, `app/api/search/`, the database, any migration, any model, any search setting or any environment variable for search. If a screen seems to need new data from the search, stop and say so instead of building it.
2. **Only real words.** Every quotation shown as Śrīla Prabhupāda's or an ācārya's must be stored, verbatim text. No AI-written titles, summaries, context or captions anywhere. The design's sample numbers ("664 more passages", "36 books · 3,700 lectures · 6,500 letters") are placeholders. Show the real counts the site already computes.
3. **Fast on old devices.** The owner tests on an iPhone 6s (iOS 15 / Safari 15) and an iPad.
   - Animate only `transform` and `opacity`. Never animate a CSS `filter` (blur, etc.).
   - Load only the photos the device will show: portrait set below 768 px, landscape set from 768 px. The first photo loads at once; the rest load after the first paint.
   - The film grain in the designs is a live SVG `feTurbulence` filter. Replace it with a small tiled PNG made once.
   - Below-the-fold images are lazy.
   - No new heavy libraries: Framer Motion, already in the project, is enough; plain CSS keyframes are better.
4. **Reduced motion.** Every animation must stop for `prefers-reduced-motion: reduce`. Each design file shows the exact rule.
5. **No visible box.** The owner sees, and dislikes, any rectangle that appears around moving text or photos. To avoid it:
   - Never wrap animated text in an `overflow: hidden` container. It clips the glow and shows a box edge.
   - Keep moving photo layers larger than the screen. The designs use `inset: -8%`.
   - Glow and bloom layers are oversized and never scale below 1.
   - No `filter` on text.
6. **Accessibility.**
   - Touch targets at least 44 px.
   - Visible focus outlines.
   - Alt text and aria labels as written in the designs.
   - Text contrast at least 4.5:1.
7. **Branch and PR, never merge.** Work on a new branch and open a pull request. **Do not merge it.** The owner checks the Vercel preview on his iPhone 6s and iPad first.

## What to build, in this order

### 1. Logo, header and footer (every page)

Designs: the header at the top of every design file, and `Logo.dc.html`.

**Header, left side:**
- His gold portrait medallion: `logo/face-gold.webp` with a gold gradient ring. 40 px on desktop, 34 px on phone. The ring CSS is in any design file's header.
- A thin vertical gold divider.
- The logotype, two lines:
  - "Ask": Cormorant Garamond italic 500, gold `#d9b76a`, with a gold hairline running out to the right.
  - "Śrīla Prabhupāda": Cormorant Garamond 600, gold-foil gradient (`background-clip: text`), with a soft light glint crossing it every 8 seconds (class `asp-foil` in every design's `<style>`).
  - Sizes: desktop 14 px / 22 px, phone 12 px / 18 px.
  - Copy the markup from `Ask.dc.html`.

**Header nav:** remove His Journey, Features and How it works.

**Footer:** exactly three links: **Support the seva** (the existing seva modal) · **Send feedback** (the existing feedback form) · **GitHub**.

**Icons:**
- App icons (apple-touch-icon 180, PWA 192 and 512): the gold face medallion on a dark rounded square, as on the logo sheet.
- 16 px browser-tab icon: the small gold book emblem SVG shown on the logo sheet. A face cannot be read at 16 px.
- Replace `app/icon.svg` accordingly.

### 2. Doorway (lock screen)

Designs: `Main.dc.html` (desktop/iPad), `PhoneEntry.dc.html` (phone). Code today: the doorway inside `app/components/cinematic/01-cinematic-home.tsx`, with photos from `app/lib/server/01-lockscreen-images.ts`.

**Layout:**
- Same as the current doorway: one full-screen photograph, "Ask" and "Śrīla Prabhupāda" at the bottom centre, a thin gold rule, then one verse in small italic (16–21 px) with its speaker and source in gold.
- No "Enter" button. Tap or click anywhere to continue.
- No "Nothing added. Nothing invented." on this screen.
- On phone, the title is centred.

**Photos:**
- One photo every 7 seconds. Each change is a 2.6-second film-style transition, all defined as keyframes in the design.
- Desktop/iPad, landscape set:

  | Order | Photo | Transition |
  |---|---|---|
  | 1 | with-disciples | focus pull |
  | 2 | vrindavan-deities | light leak |
  | 3 | new-york-1965 | push-through |
  | 4 | jaladuta-1965 | exposure bloom |
  | 5 | morning-walk | lens flare |

- Phone, portrait set:

  | Order | Photo | Transition |
  |---|---|---|
  | 1 | folded-hands | soft dissolve |
  | 2 | with-disciples | light leak |
  | 3 | lecturing | push |
  | 4 | vrindavan-deities | bloom |
  | 5 | paris | dip to black |
  | 6 | new-york-1965 | lens flare |

- Each photo has its own colour grade (the grade layers in the design).
- Copy the keyframes and per-slide classes from the design's `<style>`: `asp-Lp0`–`asp-Lp4` for landscape, `asp-Pp0`–`asp-Pp5` for portrait, plus the leak, bloom and flare overlays.
- The existing automatic photo discovery can stay for any extra photos the owner adds later. These two ordered sets are what show now.

**Verses:**
- Replace `public/data/entrance-quotes.json` with `docs/redesign/data/entrance-quotes.json`.
- Start on a random verse. Every 9 seconds, pick another at random that was not among the last 12 shown.
- The fade and rise between verses is in the design script (`ON`, `OUT`, `WAIT` styles).

**When it shows:** keep today's behaviour. It shows on arrival, and `?entrance=0` skips it. Also show it at most once per day per device: store the date in `localStorage` inside a try/catch.

### 3. Ask (home)

Designs: `Ask.dc.html`, `PhoneAsk.dc.html`. Code today: the hero part of `01-cinematic-home.tsx`, plus `app/components/search/`.

The home page becomes **only** what the design shows:
- the dark hero
- the search box
- the "Search in" switch (hidden for now, see Advanced below)
- three sample questions
- the library numbers
- the three trust cards
- the footer

Remove from the home page: the Moments filmstrip, the manifesto, the 1965 journey teaser, the sample voices and the closing door. Keep their component files for later, unmounted.

**Hero:**
- A faint Vṛndāvana deities photo: opacity 0.4, a slow 24-second zoom.
- Warm gold and violet glows drifting.
- Grain, as a PNG tile.

**Floating light bubbles:**
- Desktop: 16 small glowing dots plus 5 large faint out-of-focus discs. Phone: 9 plus 3.
- Every third dot is gold; the rest are lavender.
- They rise slowly with a gentle sideways sway, then fade. They are already mid-flight when the page opens (negative animation delays).
- Copy the positions, sizes, durations and keyframes from the design: the `.asp-bubs` block, and the `asp-bub-d*` / `asp-bub-p*` keyframes.
- They sit behind all text.

**Title:** "Ask", the gradient "Śrīla Prabhupāda", and "Nothing added. Nothing invented." underneath.

**Search box:**
- A cream box inside a 1.5 px gold frame. A thin line of gold-and-violet light travels around the frame every 9 seconds: a rotating `conic-gradient` square clipped by the rounded frame. The frame needs `isolation: isolate` and `-webkit-mask-image` so Safari clips it to the rounded corners.
- A soft gold halo behind the box breathes every 6 seconds.
- The violet "Ask" button gets a light glint every 7 seconds.

**Self-typing questions** (replaces `02-typewriter-placeholder.tsx`):
- The questions come from `data/self-typing-questions.json`, shuffled on every visit.
- Each letter fades in and rises slightly on a steady beat: a new letter starts every 42 ms on desktop and every 46 ms on phone, and each letter's own fade takes 560 ms.
- Each letter starts gold and settles into the ink colour.
- After the last letter, a violet cursor fades in and blinks.
- The full question stays for 2.6 seconds, then fades upward over 0.7 seconds, and the next one begins.
- Implement it like the design: render the letters once per question, with CSS `animation-delay`. Update state only **twice per question**, never once per letter. That is what keeps it smooth.
- Alternate between two identical keyframe names (`asp-chA` / `asp-chB`) so the animation restarts.
- The overlay sits on top of the real input and has `pointer-events: none`. It disappears the moment the input has focus or text.
- The real input keeps its label for screen readers.

**"Search in" switch:** see Advanced below. For now, do not show it.

**Library numbers:** use the real counts the current home page already shows.

### 4. Searching

Designs: `Searching.dc.html`, `PhoneSearching.dc.html`. Code today: `app/components/cinematic/10-search-loader.tsx` and `app/components/search/05-search-progress.tsx`.

**Left side:**
- "You asked" and the devotee's own question.
- Four progress steps:
  1. Understanding your question
  2. Searching the books, lectures and letters
  3. Weighing every passage
  4. Checking each quote against its source
- Drive the steps from the real SSE stage events you already receive. Never use fake timers.
- Keep the live found-counts if they fit.

**Right side:** the disciplic succession, from `data/lineage.json`.
- One name every 2 seconds, from Śrī Caitanya Mahāprabhu to Śrīla Bhaktisiddhānta Sarasvatī Ṭhākura. Each name sits in the design's gold ornament frame.
- It ends on Śrīla Prabhupāda's photograph.
- **Do not show the words "Painting to come"** on the live site. Show the ornament and the name only.
- When the owner later adds an approved painting, he will only add an image path to `lineage.json`. Make the component use `image` when it is not null.

**Leave out:** "Prototype only: jump to the answer". It exists only in the mockup.

### 5. Answer

Designs: `Answer.dc.html`, `PhoneAnswer.dc.html`. Code today: `app/components/results/01-narrative-response.tsx`.

**Top:** "You asked" and the devotee's own question. There is no AI title, as today.

**Disclaimer:**
- A short version under the question.
- A full section at the bottom, beside the `photos/translating.webp` photograph.
- Use the design's text word for word:

  > This site finds Śrīla Prabhupāda's words and shows exactly where they come from. It does not give the whole teaching. Read every passage in its full context, on Vedabase or in the original book, and ask senior devotees when something is unclear. We cannot take responsibility for how a passage is understood.

**Passage cards:** the new citation bar.
- A gold medal with the source abbreviation (Bg, SB, Cc, etc.; use the existing label data) and the passage's number.
- "Read in full ↗": the existing Vedabase link. Show it only when the passage has a URL.
- "Copy": the existing copy-with-reference behaviour. The copied state shows a check.
- The design's "Context" segment is **not built now** (see below).

**Highlights:**
- Keep the existing highlighting, restyled like the design's violet highlight.
- **Do not show the three-colour "Highlights" legend** (direct answer / instruction / analogy). The search does not produce those kinds, so the legend would be untrue.

**Dig Deeper card:**
- The heading stays "N more passages retrieved in this search", with the real N. The existing test forbids the words "every" and "all".
- Opens Dig Deeper.

**Advanced card:** only when Advanced is switched on.

### 6. Dig Deeper

Design: `DigDeeper.dc.html`. Code today: `app/components/results/03-cinematic-dig-deeper.tsx`.

- The dark band header.
- The three-step shelf: **1 Source → 2 Book → 3 Chapter**.
- A breadcrumb.
- A "Best match / Book order" toggle.
- Filters stay **source, book and the book's own hierarchy (canto, līlā, chapter) only**. No speaker filter and no topic filter: the owner decided this.
- Reuse the existing filter logic. This is a restyle.

### 7. Hide the extra pages

- His Journey, Features and How it works: remove every link to them.
- Make `/journey`, `/features` and `/how-it-works` redirect to `/` (temporary, 307).
- Remove them from `app/sitemap.ts`.
- Keep the files: the owner will bring them back later.

## Built later, not now

- **Advanced (previous ācāryas' books).** Designs: `Advanced.dc.html`, `PhoneAdvanced.dc.html`, plus the "Search in" switch in `Ask.dc.html`. The ācāryas' books are **not in the database yet**, so this would show nothing real.
  - Build the switch and the Advanced screen.
  - Show them only when `NEXT_PUBLIC_ADVANCED_ENABLED === "true"`. Default: off.
  - While it is off, the Ask page shows no switch, and the Answer page shows no Advanced card.
  - Never show sample or placeholder passages.
- **"The story that led here" (context).** Designs: `ContextStory.dc.html`, and the dark context panel in `Answer.dc.html`. This needs a reviewed list, per verse, of the verses that tell its backstory, approved by senior devotees. That list does not exist yet. **Do not build it, and never let AI write it.**
- **The three-colour highlight legend.** Not built, as explained above.

## When you finish

1. Run `npm run build` and `npm test`. Both must pass.
2. Open a pull request titled "Cinematic redesign". **Do not merge.**
3. In the PR description, write in very simple words:
   - what changed on each screen
   - anything from the designs you could not build, and why
   - the Vercel preview link
4. Give the owner this short checklist to try on his iPhone 6s and iPad:
   - The doorway changes photo every 7 seconds and the verse every 9 seconds.
   - No box is visible around any moving photo or text.
   - Questions type smoothly in the search box and vanish when you tap it.
   - A search shows the lineage names, then the answer with the new citation bar.
   - "Read in full" and "Copy" work.
   - His Journey, Features and How it works are gone.
   - With "Reduce Motion" turned on in the phone's settings, nothing moves.
