# Ask Śrīla Prabhupāda — Implementation Plan for Claude Code (v2 CORRECTED)

## Instructions for Claude Code

This document contains step-by-step implementation instructions for 6 major upgrades to the Ask Śrīla Prabhupāda project. **Read the entire document before starting any task.** Implement in the order listed below — each task may depend on the previous one.

### ⚠️ CRITICAL CORRECTIONS FROM v1

This document supersedes the previous implementation plan. Key corrections:

1. **Embedding dimension is 1536, NOT 768.** The database columns `verses.embedding` and `prose_paragraphs.embedding` are defined as `vector(1536)`. All SQL functions, scripts, and API calls MUST use 1536 dimensions.
2. **Use `gemini-embedding-001` for embeddings, NOT `text-embedding-004`.** The older model is deprecated. `gemini-embedding-001` is the current #1 ranked embedding model. It outputs 3072 dimensions by default but supports `output_dimensionality: 1536` to match the database.
3. **Tags must be generated BEFORE embeddings.** A new Task 0 generates rich search tags using Gemini 3.1 Flash. These tags are combined with verse text to create super-rich embeddings.
4. **The synthesis model `gemini-2.5-flash-lite` is being deprecated June 1, 2026.** Migrate to `gemini-2.0-flash` or `gemini-2.5-flash` for the narrative synthesis step.
5. **Cost estimates corrected.** Tag generation ~$30-50, embedding generation ~$4-5, total one-time ~$35-55.

---

## Current Architecture (What Exists)

- **Next.js 16 App Router** with TypeScript strict, Tailwind CSS 4, Framer Motion
- **Supabase** (PostgreSQL 17, project ID: `wzktlpjtqmjxvragwhqg`, region: `ap-south-1`)
- **Tables:**
  - `verses` — 25,112 rows. Columns: `id` (uuid PK), `chapter_id` (FK→chapters), `scripture`, `verse_number`, `sanskrit_devanagari`, `transliteration`, `synonyms`, `translation`, `purport`, `vedabase_url`, `tags` (text[]), `embedding` (vector(1536)), `created_at`
  - `prose_paragraphs` — 34,145 rows. Columns: `id` (uuid PK), `chapter_id` (FK→chapters), `book_slug`, `paragraph_number`, `body_text`, `vedabase_url`, `tags` (text[]), `embedding` (vector(1536)), `created_at`
  - `chapters` — 1,145 rows. Columns: `id` (uuid PK), `scripture`, `canto_or_division`, `chapter_number`, `chapter_title`, `total_verses`, `vedabase_url`, `book_slug`, `created_at`
  - `books` — 27 rows. Columns: `id`, `title`, `slug`, `content_type` (verse_book | prose_book), `author`, `total_chapters`, `vedabase_url`
  - `feedback` — 0 rows
- **Database facts (verified):**
  - `verses.embedding` = `vector(1536)` — **1536 dimensions, NOT 768**
  - `prose_paragraphs.embedding` = `vector(1536)` — **1536 dimensions, NOT 768**
  - 0 verses have embeddings populated (all NULL)
  - 0 prose paragraphs have embeddings populated (all NULL)
  - `tags` columns exist as `text[]` on both tables (currently empty arrays)
- **Supabase Extensions already installed:** `vector` (pgvector 0.8.0), `pg_trgm` (1.6), `uuid-ossp`, `pgcrypto`, `pg_graphql`, `pg_stat_statements`
- **No Supabase Edge Functions** exist yet
- **Current search:** Gemini-based two-touch (keyword extraction → ilike search → Gemini synthesis). See `app/api/search/route.ts`
- **Environment variables:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GEMINI_API_KEY`
- **Design:** Light theme only. Lavender/violet/white palette. Fonts: Cormorant Garamond (display), DM Sans (body), Noto Serif Devanagari (Sanskrit)

---

## TASK 0: Generate Rich Search Tags (Run BEFORE Embeddings)

**Goal:** For every verse and prose paragraph, use Gemini 3.1 Flash to generate rich search tags — topic words, Sanskrit terms, related questions, and a brief summary. These tags dramatically improve embedding quality.

### 0A. Create the tag generation script

Create a standalone Node.js script `scripts/generate-tags.ts` that:

1. Reads all rows from `verses` where `tags` is NULL or empty (`tags = '{}'`)
2. For each verse, sends the translation + first 800 chars of purport to Gemini 3.1 Flash with this prompt:

```
You are an expert on Śrīla Prabhupāda's teachings and ISKCON devotee culture.

Read this verse and purport from {scripture} {canto}.{chapter}.{verse_number}.

Translation: "{translation}"
Purport (excerpt): "{first 800 chars of purport}"

Return ONLY a JSON object with these fields:
{
  "topics": ["10-15 English search terms a devotee might type to find this verse — include practical life topics, philosophical concepts, emotional states, daily practices"],
  "sanskrit_terms": ["5-8 relevant Sanskrit terms with and without diacritics, e.g. both 'karma' and 'brahma-muhurta' and 'brahma-muhūrta'"],
  "questions": ["3-5 questions a devotee might ask that this verse answers, e.g. 'How to control the mind?', 'What happens after death?'"],
  "summary": "1-2 sentence summary of the key teaching in this verse and purport"
}

No explanation. Only valid JSON.
```

3. Parses the JSON response and updates the `tags` column with an array combining all terms: `[...topics, ...sanskrit_terms, ...questions]`
4. Also stores the summary — append it as the last element of the tags array prefixed with "SUMMARY: "
5. Processes in batches of 10-20 with 1-2 second delays between batches
6. Logs progress: "Generated tags for 500 / 25112 verses..."
7. Then does the same for `prose_paragraphs` where `tags` is NULL or empty, using `body_text` instead of translation/purport
8. Handles errors gracefully — if one row fails, log it and continue
9. Can be re-run safely (only processes rows with empty tags)

**Model:** `gemini-3.1-flash-preview` (or latest stable Flash model available)
- API endpoint: `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent`
- Note: If `gemini-3.1-flash` is not yet available via API, use `gemini-2.0-flash` instead. Check the Gemini API models page for the latest available model ID.

**Cost estimate:** ~$30-50 total for all 59,257 entries (one time)

### 0B. Validate tags before proceeding

After the tag script completes, run a validation query:

```sql
-- Check how many rows got tags
SELECT 
  (SELECT count(*) FROM verses WHERE tags != '{}' AND array_length(tags, 1) > 5) as verses_with_tags,
  (SELECT count(*) FROM verses) as total_verses,
  (SELECT count(*) FROM prose_paragraphs WHERE tags != '{}' AND array_length(tags, 1) > 5) as prose_with_tags,
  (SELECT count(*) FROM prose_paragraphs) as total_prose;
```

At least 95% of rows should have 5+ tags. If many rows are missing tags, check the error log and re-run the script.

---

## TASK 1: Vector Embeddings in Supabase (Semantic Search)

**Goal:** Populate the existing `embedding` columns with vector embeddings using the tags from Task 0, create HNSW indexes, and create Supabase RPC functions for semantic similarity search.

### 1A. Create the embedding generation script

Create a standalone Node.js script `scripts/generate-embeddings.ts` that:

1. Reads all rows from `verses` where `embedding IS NULL`
2. For each verse, creates a **rich text blob** for embedding by combining tags + translation + purport:

```
"[{scripture} {canto}.{chapter}.{verse_number}] Topics: {tags joined by comma}. Translation: {translation}. Purport excerpt: {first 800 chars of purport}"
```

For example:
```
"[BG 6.17] Topics: regulated life, daily schedule, eating habits, sleeping habits, waking early, brahma-muhūrta, maṅgala-ārati, 4 AM, yoga discipline, reducing suffering, karma, brahma-muhurta, How to live a regulated life?, What time should a devotee wake up?, SUMMARY: Prabhupāda explains that a devotee must regulate eating sleeping and recreation to mitigate material suffering. Translation: He who is regulated in his habits of eating, sleeping, recreation and work can mitigate all material pains by practicing the yoga system. Purport excerpt: ..."
```

3. Calls **`gemini-embedding-001`** to generate a vector. **CRITICAL: Set `output_dimensionality: 1536`** to match the database column.

**API endpoint:**
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent
Headers: { "Content-Type": "application/json", "x-goog-api-key": GEMINI_API_KEY }
Body: {
  "model": "models/gemini-embedding-001",
  "content": { "parts": [{ "text": "..." }] },
  "outputDimensionality": 1536
}
```
Response: `{ "embedding": { "values": [0.1, 0.2, ...] } }` — will be exactly 1536 floats.

4. Updates the row's `embedding` column with the vector
5. Processes in batches of 20-50 with appropriate delays (1-2 seconds between batches) to avoid rate limits
6. Logs progress: "Processed 500 / 25112 verses..."
7. Then does the same for `prose_paragraphs` where `embedding IS NULL`, using:
```
"[{book_slug} - paragraph {paragraph_number}] Topics: {tags joined by comma}. Text: {first 1200 chars of body_text}"
```
8. Handles errors gracefully — if one row fails, log it and continue. Don't crash the whole script.
9. Can be re-run safely (only processes NULL embeddings)

**CRITICAL DIMENSION CHECK:** The vector MUST be exactly 1536 dimensions. Before inserting the first embedding, verify:
```typescript
const embedding = data?.embedding?.values || [];
if (embedding.length !== 1536) {
  throw new Error(`Expected 1536 dimensions, got ${embedding.length}. Check outputDimensionality parameter.`);
}
```

### 1B. Create HNSW indexes in Supabase

Run these SQL migrations **AFTER embeddings are populated:**

```sql
-- Create HNSW indexes for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_verses_embedding_hnsw
ON verses
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_prose_embedding_hnsw
ON prose_paragraphs
USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

### 1C. Create full-text search indexes (for hybrid search)

```sql
-- Add GIN indexes for full-text search (much faster than ilike)
ALTER TABLE verses ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(translation, '') || ' ' || coalesce(purport, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_verses_fts ON verses USING GIN (fts);

ALTER TABLE prose_paragraphs ADD COLUMN IF NOT EXISTS fts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(body_text, ''))
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_prose_fts ON prose_paragraphs USING GIN (fts);
```

### 1D. Create Supabase RPC functions for hybrid search

**⚠️ ALL vector parameters MUST be `vector(1536)`, NOT `vector(768)`**

```sql
-- Semantic search function for verses
CREATE OR REPLACE FUNCTION search_verses_semantic(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 20
)
RETURNS TABLE (
  id uuid,
  scripture text,
  verse_number text,
  sanskrit_devanagari text,
  transliteration text,
  translation text,
  purport text,
  chapter_id uuid,
  vedabase_url text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
    v.transliteration, v.translation, v.purport, v.chapter_id,
    v.vedabase_url,
    1 - (v.embedding <=> query_embedding) AS similarity
  FROM verses v
  WHERE v.embedding IS NOT NULL
    AND 1 - (v.embedding <=> query_embedding) > match_threshold
  ORDER BY v.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Semantic search function for prose
CREATE OR REPLACE FUNCTION search_prose_semantic(
  query_embedding vector(1536),
  match_threshold float DEFAULT 0.3,
  match_count int DEFAULT 15
)
RETURNS TABLE (
  id uuid,
  book_slug text,
  paragraph_number int,
  body_text text,
  chapter_id uuid,
  vedabase_url text,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id, p.book_slug, p.paragraph_number, p.body_text,
    p.chapter_id, p.vedabase_url,
    1 - (p.embedding <=> query_embedding) AS similarity
  FROM prose_paragraphs p
  WHERE p.embedding IS NOT NULL
    AND 1 - (p.embedding <=> query_embedding) > match_threshold
  ORDER BY p.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

-- Full-text keyword search function for verses
CREATE OR REPLACE FUNCTION search_verses_fulltext(
  search_query text,
  match_count int DEFAULT 15
)
RETURNS TABLE (
  id uuid,
  scripture text,
  verse_number text,
  sanskrit_devanagari text,
  transliteration text,
  translation text,
  purport text,
  chapter_id uuid,
  vedabase_url text,
  rank real
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    v.id, v.scripture, v.verse_number, v.sanskrit_devanagari,
    v.transliteration, v.translation, v.purport, v.chapter_id,
    v.vedabase_url,
    ts_rank(v.fts, websearch_to_tsquery('english', search_query)) AS rank
  FROM verses v
  WHERE v.fts @@ websearch_to_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;

-- Full-text keyword search function for prose
CREATE OR REPLACE FUNCTION search_prose_fulltext(
  search_query text,
  match_count int DEFAULT 10
)
RETURNS TABLE (
  id uuid,
  book_slug text,
  paragraph_number int,
  body_text text,
  chapter_id uuid,
  vedabase_url text,
  rank real
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.id, p.book_slug, p.paragraph_number, p.body_text,
    p.chapter_id, p.vedabase_url,
    ts_rank(p.fts, websearch_to_tsquery('english', search_query)) AS rank
  FROM prose_paragraphs p
  WHERE p.fts @@ websearch_to_tsquery('english', search_query)
  ORDER BY rank DESC
  LIMIT match_count;
END;
$$;
```

### 1E. Rewrite `app/api/search/route.ts` to use hybrid search

The new search pipeline should be:

1. **Embed the user's question** using `gemini-embedding-001` with `outputDimensionality: 1536` (one API call, very fast)
2. **Run 4 queries in parallel** using `Promise.all`:
   - `supabase.rpc('search_verses_semantic', { query_embedding, match_count: 20 })`
   - `supabase.rpc('search_prose_semantic', { query_embedding, match_count: 15 })`
   - `supabase.rpc('search_verses_fulltext', { search_query: userQuestion, match_count: 15 })`
   - `supabase.rpc('search_prose_fulltext', { search_query: userQuestion, match_count: 10 })`
3. **Merge & deduplicate** results by `id`. For items found by both semantic and keyword search, boost their score
4. **Sort by combined relevance** — semantic similarity is the primary signal, keyword rank is secondary
5. **Take top 25 results** and enrich with chapter info (same as current `enrich()` function)
6. **Pass to Gemini for synthesis** — **⚠️ MIGRATE from `gemini-2.5-flash-lite` (deprecated June 1, 2026) to `gemini-2.0-flash` or latest stable Flash model**

**This eliminates the keyword extraction step entirely** — no more first Gemini call. This saves 1-3 seconds per search.

**Embedding helper function:**
```typescript
async function embedQuery(text: string): Promise<number[]> {
  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent";
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": geminiKey },
    body: JSON.stringify({
      content: { parts: [{ text }] },
      outputDimensionality: 1536
    }),
  });
  const data = await res.json();
  const values = data?.embedding?.values || [];
  if (values.length !== 1536) {
    console.error(`Embedding dimension mismatch: expected 1536, got ${values.length}`);
    return [];
  }
  return values;
}
```

**Fallback:** If embedding fails (API error, rate limit), fall back to full-text search only. Never let the search completely fail.

---

## TASK 2: Audio Input (Voice-to-Text)

**Goal:** Add a microphone button to the search bar that lets users speak their question. Uses the Web Speech API (browser-native, no external service needed).

### 2A. Create `app/components/VoiceInput.tsx`

A new component that:

1. Renders a microphone icon button (positioned inside the search input, to the left of the submit button)
2. On click, checks for `window.SpeechRecognition || window.webkitSpeechRecognition` support
3. If not supported, shows a brief tooltip: "Voice input not supported in this browser"
4. If supported, starts recognition with these settings:
   - `recognition.continuous = true` (let them speak as long as they want)
   - `recognition.interimResults = true` (show text as they speak — feels responsive)
   - `recognition.lang = 'en-US'`
5. While recording:
   - The microphone icon turns into a pulsing red/violet indicator (animated)
   - The interim transcript appears in the search input in real-time (lighter color for unfinalized text)
   - A small "stop" button or visual cue to end recording
6. When user stops speaking (or clicks stop):
   - The final transcript replaces the search input value
   - Recording indicator disappears
   - User can edit the transcript before submitting, OR it can auto-submit after a brief pause
7. Error handling: if microphone permission is denied, show a helpful message

### 2B. Integrate into `HeroSearch.tsx`

- Import and render `VoiceInput` inside the search form
- Pass `onTranscript` callback that updates the `query` state
- Pass `onFinalTranscript` callback that optionally auto-submits the search
- The voice button should sit between the text input area and the submit arrow button
- On mobile, the voice button should be clearly tappable (minimum 44x44px touch target)

### 2C. TypeScript types

Add a type declaration for the Web Speech API since it's not in standard TypeScript types:

```typescript
// app/types/speech.d.ts
interface SpeechRecognitionEvent extends Event {
  results: SpeechRecognitionResultList;
  resultIndex: number;
}

interface SpeechRecognitionResultList {
  length: number;
  item(index: number): SpeechRecognitionResult;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  item(index: number): SpeechRecognitionAlternative;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionAlternative {
  transcript: string;
  confidence: number;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: Event & { error: string }) => void) | null;
  onend: (() => void) | null;
  onstart: (() => void) | null;
}

declare global {
  interface Window {
    SpeechRecognition: new () => SpeechRecognition;
    webkitSpeechRecognition: new () => SpeechRecognition;
  }
}
```

### 2D. Styling

- The microphone button should match the existing design system: violet/lavender tones, soft rounded corners
- Recording state: gentle pulsing glow animation in violet/red
- The button should NOT clutter the search bar — it should feel natural and integrated
- Hide the voice button entirely if the browser doesn't support it (progressive enhancement)

---

## TASK 3: Beautify the Search Bar and Search Experience

**Goal:** Elevate the search input from a standard text field to a premium, visually striking experience.

### 3A. Redesign the search input

1. **Larger, more prominent input**: Increase padding to 20px vertical, make the font size 17-18px. The input should feel spacious and inviting.

2. **Animated typewriter placeholder**: Instead of static placeholder text, cycle through example questions with a typewriter animation:
   - "What is the purpose of human life?"
   - "How to overcome anger?"
   - "What happens to the soul after death?"
   - "Why is chanting Hare Kṛṣṇa important?"
   - Each question types character by character (40-60ms per char), pauses 3 seconds, then erases and types the next one
   - When the user focuses the input, stop the animation and clear the placeholder

3. **Richer visual treatment for the input container**:
   - Multi-layered shadow on the input: a subtle spread shadow + a tighter colored glow
   - On focus, the border should transition to a gradient-like effect (use box-shadow with violet tones)
   - A very subtle frosted-glass effect on the input background
   - On hover (before focus), a gentle lift with shadow change

4. **Better button design**: The submit button should have a smooth hover animation and a ripple effect on click. When searching, show a more elegant loading animation than just a spinning circle — consider three bouncing dots or a flowing gradient animation.

5. **Search progress indicator**: When a search is in progress, show a multi-step progress bar below the search input:
   - Step 1: "Understanding your question..." (appears immediately)
   - Step 2: "Searching 27 books..." (after 500ms)
   - Step 3: "Finding relevant verses..." (after 1.5s)
   - Step 4: "Composing answer from Prabhupāda's words..." (after 3s)
   - Each step has a small icon/animation and text
   - The current step pulses/glows, completed steps get a checkmark
   - This replaces the current simple spinner

6. **Topic pills redesign**: Make the suggestion pills below the search more visually interesting:
   - Add a small relevant icon or emoji before each pill
   - Staggered animation on initial load (current stagger is good, keep it)
   - On hover, a more dramatic lift + color shift
   - Group them into categories if space allows

### 3B. Post-search state

When results appear and the search bar compresses to the top:

- Add a thin, beautiful gradient line below the sticky search bar as a visual separator
- The compressed search bar should still feel premium — frosted glass treatment as it sticks
- Show the current query in the input with a small "×" clear button to start a new search

### 3C. Responsive

- On mobile (< 768px), the search input should be full-width with appropriate padding
- The voice button and submit button should not overlap or crowd each other on small screens
- Topic pills should scroll horizontally on very small screens rather than wrapping to many lines
- The multi-step progress indicator should stack vertically on mobile

### 3D. Design system consistency

All new styles should:
- Use the existing CSS variables from `globals.css` (`--garden-violet`, `--garden-lavender`, etc.)
- Use existing font classes (`font-display`, `font-body`)
- Follow the light theme — no dark backgrounds
- Use the existing `--ease-out-expo` cubic-bezier for smooth animations
- Maintain the spiritual, warm, clean, modern feel described in CLAUDE.md

---

## TASK 4: Stream the Synthesis Response

**Goal:** Stream the narrative text to the client so users see content appearing progressively.

### 4A. Convert the search API to streaming

Modify `app/api/search/route.ts`:

1. After the hybrid search completes, return a **ReadableStream** response
2. First, immediately send a JSON chunk with the metadata (keywords, citations, books, totalResults)
3. Then, start the Gemini synthesis call using the `streamGenerateContent` endpoint:
   ```
   POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
   ```
   **⚠️ Use `gemini-2.0-flash` or latest stable Flash model, NOT `gemini-2.5-flash-lite` (deprecated)**
4. Forward chunks to the client as SSE:
   ```
   data: {"type":"metadata","keywords":[...],"citations":[...],"books":[...],"totalResults":42}

   data: {"type":"narrative_chunk","html":"<h3>From Bhagavad Gītā</h3>"}

   data: {"type":"narrative_chunk","html":"<p>Lord Kṛṣṇa says in..."}

   data: {"type":"done"}
   ```

### 4B. Update the client to handle streaming

Modify the search handler in `app/page.tsx` and `NarrativeResponse.tsx`:

1. Use `fetch` with the response body as a ReadableStream
2. Parse the SSE events as they arrive
3. When `metadata` arrives, immediately render the LeftRail, RightRail, and overall layout
4. When `narrative_chunk` arrives, append the HTML to the narrative card progressively
5. Use a smooth fade-in effect as new content appears
6. When `done` arrives, finalize the display

### 4C. Fallback

If streaming fails for any reason, fall back to the current non-streaming behavior. The user should never see a broken state.

---

## TASK 5: Full-Text Search Indexes (Speed Optimization)

### 5A. Add database indexes for common query patterns

```sql
CREATE INDEX IF NOT EXISTS idx_chapters_id ON chapters (id);
CREATE INDEX IF NOT EXISTS idx_verses_chapter_id ON verses (chapter_id);
CREATE INDEX IF NOT EXISTS idx_prose_chapter_id ON prose_paragraphs (chapter_id);
CREATE INDEX IF NOT EXISTS idx_verses_scripture ON verses (scripture);

-- Trigram indexes for fuzzy matching (pg_trgm is already installed)
CREATE INDEX IF NOT EXISTS idx_verses_translation_trgm ON verses USING GIN (translation gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_verses_purport_trgm ON verses USING GIN (purport gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_prose_body_trgm ON prose_paragraphs USING GIN (body_text gin_trgm_ops);
```

### 5B. Implement response caching

Create `app/lib/search-cache.ts` with a Map-based LRU cache (max 200 entries, 15 min TTL). Cache key = normalized lowercase query string. Check cache before searching; store results after successful search.

### 5C. Optimize the enrich step

Use a single SQL join instead of fetching chapters separately. Or include chapter info in the RPC functions themselves.

### 5D. Parallelize everything possible

- Embedding the query + any pre-processing → parallel
- All 4 search RPC calls → parallel with `Promise.all`
- Enrichment should be minimal if chapter info is included in search results

---

## TASK 6: Verify and Fix Scripture Links

### 6A. Post-processing step for links

Add a post-processing step after Gemini returns the narrative:

1. Parse the narrative HTML
2. Find any verse references NOT wrapped in `<a>` tags (plain text like `[BG 2.20]` or `BG 2.20`)
3. Automatically wrap them in the correct `<a>` tag using the Vedabase URL builder
4. Validate all existing `<a>` tags have valid `href` attributes

### 6B. Create `app/lib/link-postprocessor.ts`

```typescript
function ensureVerseLinks(html: string, verseUrlMap: Map<string, string>): string {
  // 1. Find unlinked verse references like [BG 2.20] or BG 2.20
  // 2. Wrap them in <a> tags
  // 3. Verify existing links have correct URLs
  // Return cleaned HTML
}
```

### 6C. Verify in the UI

Ensure links are violet colored, open in a new tab, have hover underline, and are easily tappable on mobile.

---

## File Structure for New/Modified Files

```
/
├── scripts/
│   ├── generate-tags.ts             ← NEW: tag generation script (Task 0)
│   └── generate-embeddings.ts       ← NEW: embedding generation script (Task 1)
├── app/
│   ├── api/search/route.ts          ← MODIFIED: hybrid search + streaming
│   ├── components/
│   │   ├── VoiceInput.tsx           ← NEW: voice input component
│   │   ├── HeroSearch.tsx           ← MODIFIED: new design + voice + progress
│   │   ├── SearchProgress.tsx       ← NEW: multi-step search progress
│   │   ├── TypewriterPlaceholder.tsx← NEW: animated placeholder
│   │   └── NarrativeResponse.tsx    ← MODIFIED: streaming support
│   ├── lib/
│   │   ├── embed.ts                 ← NEW: embedding helper (uses gemini-embedding-001, 1536 dims)
│   │   ├── search-cache.ts          ← NEW: LRU cache
│   │   └── link-postprocessor.ts    ← NEW: link fixer
│   ├── types/
│   │   └── speech.d.ts              ← NEW: Web Speech API types
│   ├── globals.css                  ← MODIFIED: new animations + styles
│   └── page.tsx                     ← MODIFIED: streaming search handler
├── supabase/
│   └── migrations/
│       ├── 001_fulltext_indexes.sql ← NEW: FTS columns + GIN indexes
│       ├── 002_search_functions.sql ← NEW: RPC functions (vector(1536)!)
│       └── 003_additional_indexes.sql ← NEW: chapter, scripture, trigram indexes
└── CLAUDE.md                        ← UPDATED: new architecture docs
```

---

## Implementation Order

1. **Task 0** — Generate tags with Gemini Flash. This is a standalone script the developer runs manually. Takes hours due to rate limits.
2. **Task 1A** — Generate embeddings (AFTER tags exist). Also a standalone script. Takes hours.
3. **Task 1B-1D** — Database indexes and RPC functions (SQL migrations)
4. **Task 5A-5D** — Speed optimizations (more indexes, caching, parallel queries)
5. **Task 1E** — Rewrite search route with hybrid search
6. **Task 4** — Add streaming to the search response
7. **Task 6** — Link post-processing
8. **Task 3** — Search bar beautification
9. **Task 2** — Audio input

**IMPORTANT:** Tasks 0 and 1A are standalone scripts that the developer runs from the terminal. They are NOT part of the web app. Claude Code should create the scripts, but the developer runs them manually. The web app code (Tasks 1E onward) should gracefully handle the case where embeddings don't exist yet — fall back to keyword search only.

---

## Testing Checklist

After implementation, verify each of these queries returns relevant results:

- "What did Prabhupāda say about waking up early in the morning?" → should return brahma-muhūrta, maṅgala-ārati, regulated life passages — NOT metaphorical awakening from Maya
- "What is karma?" → should return BG 3.x, 4.x karma-yoga verses
- "How to control the mind?" → should return BG 6.6, 6.34-35
- "What happens after death?" → should return BG 2.13, 2.22, 8.5-6, SB passages on transmigration
- "What is the purpose of human life?" → should return broad results from BG, SB, and prose books
- "Chanting Hare Krishna" → should return specific passages about the mahā-mantra

For each, verify:
1. Results are semantically relevant (not just keyword matches)
2. All verse references are clickable links to Vedabase.io
3. Response time is under 8 seconds (ideally under 5)
4. The narrative reads coherently and quotes Prabhupāda's actual words
5. The streaming UI shows progressive content loading

---

## Model Reference (Correct as of March 2026)

| Purpose | Model ID | Dimension | Notes |
|---------|----------|-----------|-------|
| Tag generation | `gemini-2.0-flash` (or `gemini-3.1-flash-preview` if available) | N/A | Cheapest capable model for structured output |
| Embedding (one-time + per-query) | `gemini-embedding-001` | **1536** (set via `outputDimensionality`) | #1 on MTEB leaderboard. Default is 3072 — MUST set to 1536 |
| Narrative synthesis | `gemini-2.0-flash` | N/A | **DO NOT use `gemini-2.5-flash-lite`** — deprecated June 2026 |

---

## Environment Variables

No new environment variables needed. The existing `GEMINI_API_KEY` is used for:
- Tag generation (Gemini Flash)
- Text embedding (`gemini-embedding-001`)
- Narrative synthesis (Gemini Flash)

---

## Notes for Claude Code

- **DIMENSION IS 1536.** Every SQL function, every API call, every validation check must use 1536. Not 768. Not 3072. **1536.**
- **Do NOT break existing functionality.** The app must work at every step. If embeddings aren't ready yet, the search should gracefully fall back to keyword-only mode.
- **Test incrementally.** After each task, verify the app still builds (`npm run build`) and runs (`npm run dev`).
- **Keep the design direction.** Light theme only. Lavender/violet palette. Spiritual, warm, clean, modern. No dark backgrounds.
- **Performance matters.** The #1 user complaint is speed. Parallelize, cache, stream.
- **Semantic relevance matters.** The #2 user complaint is irrelevant results. Vector search with rich tags is the fix.
- **The tag and embedding scripts will take time.** 59,000+ rows × API calls with rate limits = several hours each. They are run manually by the developer, not by the web app.
- **`gemini-2.5-flash-lite` is deprecated.** Migrate the synthesis model to `gemini-2.0-flash` or the latest stable Flash model.