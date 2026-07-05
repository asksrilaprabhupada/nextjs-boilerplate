/**
 * route.ts — Citation Click Analytics Route
 *
 * Records a Vedabase citation click into the citation_clicks table (which
 * click, from which search, at which position). Written via the service
 * client like every other telemetry route; the browser sends fire-and-forget
 * beacons (see logCitationClick in app/lib/02-analytics.ts).
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";

export async function POST(request: NextRequest) {
  try {
    // sendBeacon may deliver the JSON as a Blob without a JSON content-type;
    // Request.json() parses the body regardless.
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "JSON body required" }, { status: 400 });
    }
    const { searchLogId, verseId, proseId, citationRef, bookSlug, clickPosition } = body as Record<string, unknown>;
    if (!searchLogId || typeof searchLogId !== "string") {
      return NextResponse.json({ error: "searchLogId required" }, { status: 400 });
    }

    const supabase = getSupabaseAdmin();
    const { error } = await supabase.from("citation_clicks").insert({
      search_log_id: searchLogId,
      verse_id: typeof verseId === "string" && verseId ? verseId : null,
      prose_id: typeof proseId === "string" && proseId ? proseId : null,
      citation_ref: typeof citationRef === "string" && citationRef ? citationRef.slice(0, 500) : null,
      book_slug: typeof bookSlug === "string" && bookSlug ? bookSlug.slice(0, 120) : null,
      click_position: typeof clickPosition === "number" && Number.isFinite(clickPosition) ? clickPosition : null,
    });

    if (error) {
      console.error("[citation-click] insert error:", error);
      return NextResponse.json({ error: "Failed to record" }, { status: 500 });
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[citation-click] error:", err);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}
