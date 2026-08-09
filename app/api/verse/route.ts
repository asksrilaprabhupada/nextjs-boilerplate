/**
 * route.ts — Verse API Route
 *
 * Fetches a single verse from Supabase, either by `id` (the detail page and
 * internal lookups) or by textual `ref` (e.g. "Bg. 2.13", "SB 1.2.6",
 * "Cc. Madhya 20.108") to power inline cross-reference previews. Returns the
 * verse with its joined chapter fields.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";

const VERSE_SELECT = "*, chapters(chapter_number, canto_or_division, chapter_title, scripture)";

/** Parse a community-format reference into { scripture, canto?, chapter, verse }. */
export function parseVerseRef(raw: string): { scripture: string; canto: string | null; chapter: string; verse: string } | null {
  const s = raw.replace(/[[\]]/g, "").trim();
  const m = s.match(/^(BG|SB|CC|NOI|ISO|BS)\.?\s+(.+)$/i);
  if (!m) return null;
  const scripture = m[1].toUpperCase();
  let rest = m[2].trim();
  let canto: string | null = null;
  const div = rest.match(/^(Ādi|Adi|Madhya|Antya)\s+(.+)$/i);
  if (div) { canto = div[1]; rest = div[2]; }
  const nums = rest.split(/[.\s]+/).map((x) => x.trim()).filter(Boolean);
  if (scripture === "SB" && nums.length >= 3) return { scripture, canto: nums[0], chapter: nums[1], verse: nums[2].split(/[–-]/)[0] };
  if (nums.length >= 2) return { scripture, canto, chapter: nums[0], verse: nums[1].split(/[–-]/)[0] };
  return null;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  const ref = searchParams.get("ref");

  if (!id && !ref) {
    return NextResponse.json({ error: "Verse 'id' or 'ref' is required" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdmin();

    if (id) {
      const { data: verse, error } = await supabase.from("verses").select(VERSE_SELECT).eq("id", id).single();
      if (error || !verse) return NextResponse.json({ error: "Verse not found" }, { status: 404 });
      return NextResponse.json(verse);
    }

    // ── Cross-reference lookup by textual ref ──
    const parsed = parseVerseRef(ref as string);
    if (!parsed) return NextResponse.json({ error: "Unrecognized reference" }, { status: 404 });

    let cq = supabase.from("chapters").select("id").eq("scripture", parsed.scripture).eq("chapter_number", parsed.chapter);
    if (parsed.canto) cq = cq.ilike("canto_or_division", `%${parsed.canto}%`);
    const { data: chapters } = await cq;
    if (!chapters || chapters.length === 0) return NextResponse.json({ error: "Verse not found" }, { status: 404 });

    const { data: verses } = await supabase
      .from("verses")
      .select(VERSE_SELECT)
      .in("chapter_id", chapters.map((c) => c.id))
      .eq("verse_number", parsed.verse)
      .limit(1);

    if (!verses || verses.length === 0) return NextResponse.json({ error: "Verse not found" }, { status: 404 });
    return NextResponse.json(verses[0]);
  } catch (err) {
    console.error("Verse fetch error:", err);
    return NextResponse.json({ error: "Failed to fetch verse" }, { status: 500 });
  }
}
