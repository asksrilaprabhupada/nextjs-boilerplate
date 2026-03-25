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
