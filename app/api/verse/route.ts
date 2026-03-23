import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wzktlpjtqmjxvragwhqg.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");

  if (!id) {
    return NextResponse.json({ error: "Verse ID is required" }, { status: 400 });
  }

  try {
    const supabase = createClient(supabaseUrl, supabaseKey);

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
