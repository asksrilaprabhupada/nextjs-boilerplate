/**
 * route.ts — Verse API Route
 *
 * Fetches a single verse by ID from Supabase with all its fields.
 * Provides verse data for the detail page and internal lookups.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Verse ID is required" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdmin();

    const { data: verse, error } = await supabase
      .from("verses")
      .select("*, chapters(chapter_number, canto_or_division, chapter_title, scripture)")
      .eq("id", id)
      .single();

    if (error || !verse) {
      return NextResponse.json({ error: "Verse not found" }, { status: 404 });
    }

    return NextResponse.json(verse);
  } catch (err) {
    console.error("Verse fetch error:", err);
    return NextResponse.json({ error: "Failed to fetch verse" }, { status: 500 });
  }
}
