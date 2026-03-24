import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { type, name, email, message, query, page_url } = body;

    if (!type || !message) {
      return NextResponse.json({ error: "Type and message are required" }, { status: 400 });
    }

    if (!["feedback", "feature", "contact", "bug"].includes(type)) {
      return NextResponse.json({ error: "Invalid type" }, { status: 400 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const { error } = await supabase.from("feedback").insert({
      type,
      name: name || null,
      email: email || null,
      message,
      query: query || null,
      page_url: page_url || null,
    });

    if (error) {
      console.error("Feedback insert error:", error);
      return NextResponse.json({ error: "Failed to save. Please try again." }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Feedback error:", err);
    return NextResponse.json({ error: "Something went wrong." }, { status: 500 });
  }
}