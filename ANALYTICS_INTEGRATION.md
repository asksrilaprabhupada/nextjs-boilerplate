# Analytics & Feedback System — Integration Instructions for Claude Code

## Context

The Supabase database already has these tables and functions (DO NOT create them again):
- `search_logs` table — stores every search with query, results, timings, behavior signals, feedback
- `citation_clicks` table — tracks which citation links users click
- `popular_queries` table — auto-maintained query frequency tally
- `search_daily_stats` table — daily aggregates
- `log_search()` RPC function — inserts a search log row, returns the UUID
- `log_search_feedback()` RPC function — records thumbs up/down + optional text
- `log_search_behavior()` RPC function — records scroll depth, time on page, clicked citations

The following client-side files already exist in the project (DO NOT recreate them):
- `app/lib/analytics.ts` — client-side helpers (logSearch, logFeedback, logBehavior, getSessionId, getVisitorId)
- `app/components/SearchFeedback.tsx` — thumbs up/down UI component
- `app/hooks/useSearchBehaviorTracker.ts` — auto-tracks scroll, time, citation clicks

## What Needs To Be Done

There are **2 categories** of work:

### CATEGORY A: Create 3 new API route files (these DO NOT exist yet)
### CATEGORY B: Modify 3 existing files to wire everything together

---

## CATEGORY A: Create 3 API Routes

These are simple proxy routes that receive JSON from the client and call the Supabase RPC functions.

### A1. Create `app/api/analytics/log/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      query, sessionId, visitorId, totalResults,
      verseIds, proseIds, booksReturned, searchMethod,
      searchDurationMs, embeddingDurationMs, synthesisDurationMs,
      totalDurationMs, narrativeLength, source, userAgent, referrer,
    } = body;

    if (!query) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { data, error } = await supabase.rpc("log_search", {
      p_query: query,
      p_session_id: sessionId || null,
      p_visitor_id: visitorId || null,
      p_total_results: totalResults || 0,
      p_verse_ids: verseIds || [],
      p_prose_ids: proseIds || [],
      p_books_returned: booksReturned || [],
      p_search_method: searchMethod || "hybrid",
      p_search_duration_ms: searchDurationMs || null,
      p_embedding_duration_ms: embeddingDurationMs || null,
      p_synthesis_duration_ms: synthesisDurationMs || null,
      p_total_duration_ms: totalDurationMs || null,
      p_narrative_length: narrativeLength || null,
      p_source: source || "web",
      p_user_agent: userAgent || null,
      p_referrer: referrer || null,
    });

    if (error) {
      console.error("log_search error:", error);
      return NextResponse.json({ error: "Failed to log" }, { status: 500 });
    }

    return NextResponse.json({ searchLogId: data });
  } catch (err) {
    console.error("Analytics log error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
```

### A2. Create `app/api/analytics/feedback/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function POST(request: NextRequest) {
  try {
    const { searchLogId, vote, text } = await request.json();

    if (!searchLogId || (vote !== 1 && vote !== -1)) {
      return NextResponse.json({ error: "searchLogId and vote (1 or -1) required" }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error } = await supabase.rpc("log_search_feedback", {
      p_search_log_id: searchLogId,
      p_vote: vote,
      p_text: text || null,
    });

    if (error) {
      console.error("log_search_feedback error:", error);
      return NextResponse.json({ error: "Failed to save feedback" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Feedback error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
```

### A3. Create `app/api/analytics/behavior/route.ts`

```typescript
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      searchLogId, clickedCitations, clickedWantMore,
      scrolledToBottom, timeOnResultMs, followedUpQuery,
    } = body;

    if (!searchLogId) {
      return NextResponse.json({ error: "searchLogId required" }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error } = await supabase.rpc("log_search_behavior", {
      p_search_log_id: searchLogId,
      p_clicked_citations: clickedCitations || null,
      p_clicked_want_more: clickedWantMore || null,
      p_scrolled_to_bottom: scrolledToBottom ?? null,
      p_time_on_result_ms: timeOnResultMs || null,
      p_followed_up_query: followedUpQuery || null,
    });

    if (error) {
      console.error("log_search_behavior error:", error);
      return NextResponse.json({ error: "Failed to save" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Behavior log error:", err);
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}
```

---

## CATEGORY B: Modify 3 Existing Files

### B1. Modify `app/components/NarrativeResponse.tsx`

**What to change:** Add SearchFeedback component, accept searchLogId prop, show feedback widget below the narrative card (but not while streaming).

**Step 1:** Add a new prop `searchLogId` to the Props interface.

Find this block:
```typescript
interface Props {
  results: SearchResults | null;
  isLoading: boolean;
  isStreaming?: boolean;
  streamingNarrative?: string;
  onSearch: (q: string) => void;
}
```

Replace with:
```typescript
interface Props {
  results: SearchResults | null;
  isLoading: boolean;
  isStreaming?: boolean;
  streamingNarrative?: string;
  onSearch: (q: string) => void;
  searchLogId?: string | null;
}
```

**Step 2:** Update the component function signature to destructure `searchLogId`.

Find:
```typescript
export default function NarrativeResponse({ results, isLoading, isStreaming, streamingNarrative, onSearch }: Props) {
```

Replace with:
```typescript
export default function NarrativeResponse({ results, isLoading, isStreaming, streamingNarrative, onSearch, searchLogId }: Props) {
```

**Step 3:** Add the import at the top of the file (with the other imports):

```typescript
import SearchFeedback from "./SearchFeedback";
```

**Step 4:** Add the SearchFeedback widget inside the narrative card, AFTER the streaming indicator div and BEFORE the follow-up questions section.

Find this block (the follow-up questions section):
```typescript
          {/* Follow-up questions — hidden while streaming */}
          {!isStreaming && followUps.length > 0 && (
```

Add this IMMEDIATELY BEFORE that block:
```typescript
          {/* Feedback widget — only show after streaming completes */}
          {!isStreaming && results && results.totalResults > 0 && (
            <SearchFeedback searchLogId={searchLogId || null} />
          )}

```

### B2. Modify `app/page.tsx`

**What to change:** Add state for searchLogId, call logSearch after results arrive, wire up the behavior tracker hook, pass searchLogId to NarrativeResponse, log follow-up queries.

**Step 1:** Add these imports near the top of the file (with the other imports):

```typescript
import { logSearch, logBehavior } from "./lib/analytics";
import { useSearchBehaviorTracker } from "./hooks/useSearchBehaviorTracker";
```

**Step 2:** Add new state variables. Find this line:

```typescript
  const abortRef = useRef<AbortController | null>(null);
```

Add these AFTER it:

```typescript
  const [searchLogId, setSearchLogId] = useState<string | null>(null);
  const searchStartTimeRef = useRef<number>(0);
  useSearchBehaviorTracker(searchLogId);
```

**Step 3:** Inside the `handleSearch` callback, record the start time. Find this line inside handleSearch:

```typescript
    setIsSearching(true);
```

Add this BEFORE it:

```typescript
    // Log follow-up if there was a previous search
    if (searchLogId) {
      logBehavior({ searchLogId, followedUpQuery: query });
    }

    searchStartTimeRef.current = Date.now();
```

**Step 4:** After search results are fully received (non-streaming path), log the search. Find this block inside handleSearch:

```typescript
      // Non-streaming response (cached results return as JSON)
      if (contentType.includes("application/json")) {
        setSearchResults(await res.json());
        setIsSearching(false);
        return;
      }
```

Replace with:

```typescript
      // Non-streaming response (cached results return as JSON)
      if (contentType.includes("application/json")) {
        const jsonResults = await res.json();
        setSearchResults(jsonResults);
        setIsSearching(false);

        // Log the search asynchronously (fire and forget)
        logSearch({
          query,
          totalResults: jsonResults.totalResults || 0,
          verseIds: (jsonResults.books || []).flatMap((b: any) => (b.verses || []).map((v: any) => v.id)),
          proseIds: (jsonResults.books || []).flatMap((b: any) => (b.prose || []).map((p: any) => p.id)),
          booksReturned: (jsonResults.books || []).map((b: any) => b.slug),
          searchMethod: "hybrid",
          totalDurationMs: Date.now() - searchStartTimeRef.current,
          narrativeLength: (jsonResults.narrative || "").length,
        }).then(id => setSearchLogId(id));

        return;
      }
```

**Step 5:** For the streaming path, log the search after the "done" event. Find this block inside the streaming event parser:

```typescript
            } else if (event.type === "done") {
              // Finalize: set the complete narrative into results
              if (partialResults) {
                setSearchResults({ ...partialResults, narrative: narrativeAccum });
              }
              setIsStreaming(false);
              setStreamingNarrative("");
            }
```

Replace with:

```typescript
            } else if (event.type === "done") {
              // Finalize: set the complete narrative into results
              if (partialResults) {
                const finalResults = { ...partialResults, narrative: narrativeAccum };
                setSearchResults(finalResults);

                // Log the search asynchronously (fire and forget)
                logSearch({
                  query,
                  totalResults: finalResults.totalResults || 0,
                  verseIds: (finalResults.books || []).flatMap((b: any) => (b.verses || []).map((v: any) => v.id)),
                  proseIds: (finalResults.books || []).flatMap((b: any) => (b.prose || []).map((p: any) => p.id)),
                  booksReturned: (finalResults.books || []).map((b: any) => b.slug),
                  searchMethod: "hybrid",
                  totalDurationMs: Date.now() - searchStartTimeRef.current,
                  narrativeLength: narrativeAccum.length,
                }).then(id => setSearchLogId(id));
              }
              setIsStreaming(false);
              setStreamingNarrative("");
            }
```

**Step 6:** Pass searchLogId to NarrativeResponse. Find:

```typescript
          <NarrativeResponse results={searchResults} isLoading={isSearching} isStreaming={isStreaming} streamingNarrative={streamingNarrative} onSearch={handleSearch} />
```

Replace with:

```typescript
          <NarrativeResponse results={searchResults} isLoading={isSearching} isStreaming={isStreaming} streamingNarrative={streamingNarrative} onSearch={handleSearch} searchLogId={searchLogId} />
```

**Step 7:** Reset searchLogId when a new search starts. Find the beginning of the handleSearch try block where state is reset:

```typescript
    setIsSearching(true);
    setIsStreaming(false);
    setStreamingNarrative("");
    setSearchResults(null);
    setCurrentQuery(query);
```

Add this line in that block:

```typescript
    setSearchLogId(null);
```

---

## Verification

After all changes, run:

```bash
npm run build
```

The build should succeed with no TypeScript errors.

Then run:

```bash
npm run dev
```

1. Open the app and do a search
2. Wait for results to appear
3. You should see a "Was this helpful?" widget with thumbs up/down below the narrative answer
4. Click thumbs up — should show "🙏 Thank you for your feedback"
5. Check Supabase: `SELECT * FROM search_logs ORDER BY created_at DESC LIMIT 5;` — should have your search logged
6. Check: `SELECT * FROM popular_queries ORDER BY search_count DESC LIMIT 5;` — should have your query

If thumbs down is clicked, a text input should appear asking "What could be improved?" with Submit and Skip buttons.

---

## File Structure After Integration

```
app/
├── api/
│   ├── analytics/
│   │   ├── log/route.ts          ← NEW (Category A1)
│   │   ├── feedback/route.ts     ← NEW (Category A2)
│   │   └── behavior/route.ts     ← NEW (Category A3)
│   ├── search/route.ts           (unchanged)
│   ├── feedback/route.ts         (existing, unchanged — this is the old contact form)
│   └── verse/route.ts            (unchanged)
├── components/
│   ├── SearchFeedback.tsx        ← ALREADY EXISTS (you integrated this)
│   ├── NarrativeResponse.tsx     ← MODIFIED (Category B1)
│   └── ... other components
├── hooks/
│   └── useSearchBehaviorTracker.ts ← ALREADY EXISTS (you integrated this)
├── lib/
│   ├── analytics.ts              ← ALREADY EXISTS (you integrated this)
│   └── ... other lib files
└── page.tsx                      ← MODIFIED (Category B2)
```

## Important Notes

- The 3 API routes in `app/api/analytics/` are completely separate from the existing `app/api/feedback/route.ts`. Do NOT touch the old feedback route.
- All analytics calls are fire-and-forget. If they fail, the user experience is unaffected.
- The `searchLogId` state is reset to `null` when a new search starts, so the feedback widget disappears and reappears with the new result.
- The behavior tracker hook automatically cleans up when the component unmounts or when searchLogId changes.