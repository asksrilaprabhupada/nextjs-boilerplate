/**
 * route.ts — Analytics Behavior Route
 *
 * Logs user behavior events (clicks, scroll depth, follow-up searches) to Supabase.
 * Captures interaction patterns to understand how users engage with results.
 */
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
