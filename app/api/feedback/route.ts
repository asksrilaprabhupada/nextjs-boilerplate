/**
 * route.ts — Feedback API Route
 *
 * Handles contact form, bug report, and feature request submissions by saving them to Supabase.
 * Collects user feedback from the contact and feature request overlays.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";

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

    const supabase = getSupabaseAdmin();

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