/**
 * route.ts — Analytics Feedback Route
 *
 * Records thumbs-up/thumbs-down votes on search results to Supabase.
 * Captures quality signals that help evaluate search relevance.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";

export async function POST(request: NextRequest) {
  try {
    const { searchLogId, vote, text } = await request.json();

    if (!searchLogId || (vote !== 1 && vote !== -1)) {
      return NextResponse.json({ error: "searchLogId and vote (1 or -1) required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();

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
