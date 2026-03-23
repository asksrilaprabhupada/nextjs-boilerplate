import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "https://wzktlpjtqmjxvragwhqg.supabase.co";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";

function getSupabase() {
  return createClient(supabaseUrl, supabaseKey);
}

// Simple keyword extraction for search
function extractKeywords(query: string): string[] {
  const stopWords = new Set([
    "what", "is", "the", "how", "to", "do", "does", "why", "can", "a", "an",
    "of", "in", "on", "for", "and", "or", "about", "from", "with", "that",
    "this", "it", "be", "are", "was", "were", "been", "being", "have", "has",
    "had", "having", "i", "me", "my", "we", "our", "you", "your", "he", "she",
    "they", "them", "his", "her", "its", "which", "who", "whom", "when",
    "where", "there", "here", "should", "would", "could", "will", "shall",
  ]);

  return query
    .toLowerCase()
    .replace(/[?!.,;:'"]/g, "")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !stopWords.has(word));
}

// Generate simple narrative intro based on scripture and query
function generateNarrativeIntro(scripture: string, query: string): string {
  const topic = query.toLowerCase();
  switch (scripture) {
    case "BG":
      return `Regarding ${topic}, Lord Śrī Kṛṣṇa directly addresses this in the Bhagavad Gītā. Through His conversation with Arjuna on the battlefield of Kurukṣetra, He illuminates this subject with great clarity.`;
    case "SB":
      return `The Śrīmad Bhāgavatam provides deeper insight into ${topic} through its vast narratives and philosophical teachings. The great sages and devotees expand upon this understanding.`;
    case "CC":
      return `Śrī Caitanya Caritāmṛta reveals the highest understanding of ${topic} through the pastimes and teachings of Lord Śrī Caitanya Mahāprabhu, who is Kṛṣṇa Himself appearing as a devotee.`;
    default:
      return "";
  }
}

function generateConnectors(verses: unknown[]): string[] {
  const connectors = [
    "Śrīla Prabhupāda explains in the purport:",
    "Further elaborating on this point, Śrīla Prabhupāda writes:",
    "In his commentary, Śrīla Prabhupāda illuminates this verse:",
  ];
  return verses.map((_, i) => connectors[i % connectors.length]);
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");

  if (!query) {
    return NextResponse.json({ error: "Query parameter 'q' is required" }, { status: 400 });
  }

  try {
    const supabase = getSupabase();
    const keywords = extractKeywords(query);

    if (keywords.length === 0) {
      return NextResponse.json({ error: "Please provide a more specific question" }, { status: 400 });
    }

    // Search for relevant verses using text search on translation and purport
    const searchTerm = keywords.join(" | ");

    // Search each scripture separately
    const searchScripture = async (scripture: string, limit: number) => {
      // Try text search on translation field
      const { data, error } = await supabase
        .from("verses")
        .select("id, scripture, verse_number, sanskrit_devanagari, transliteration, translation, purport, chapter_id")
        .eq("scripture", scripture)
        .or(keywords.map((k) => `translation.ilike.%${k}%`).join(","))
        .limit(limit);

      if (error || !data || data.length === 0) {
        // Fallback: try purport search
        const { data: purportData } = await supabase
          .from("verses")
          .select("id, scripture, verse_number, sanskrit_devanagari, transliteration, translation, purport, chapter_id")
          .eq("scripture", scripture)
          .or(keywords.map((k) => `purport.ilike.%${k}%`).join(","))
          .limit(limit);

        return purportData || [];
      }

      return data;
    };

    // Fetch chapter info for verse references
    const enrichWithChapterInfo = async (verses: Record<string, unknown>[]) => {
      if (verses.length === 0) return [];

      const chapterIds = [...new Set(verses.map((v) => v.chapter_id))];
      const { data: chapters } = await supabase
        .from("chapters")
        .select("id, chapter_number, canto_or_division, chapter_title")
        .in("id", chapterIds);

      const chapterMap = new Map(
        (chapters || []).map((ch: Record<string, unknown>) => [ch.id, ch])
      );

      return verses.map((v) => {
        const ch = chapterMap.get(v.chapter_id) as Record<string, unknown> | undefined;
        return {
          ...v,
          chapter_number: ch?.chapter_number || "",
          canto_or_division: ch?.canto_or_division || "",
          chapter_title: ch?.chapter_title || "",
        };
      });
    };

    const [bgVerses, sbVerses, ccVerses] = await Promise.all([
      searchScripture("BG", 3),
      searchScripture("SB", 3),
      searchScripture("CC", 3),
    ]);

    const [bgEnriched, sbEnriched, ccEnriched] = await Promise.all([
      enrichWithChapterInfo(bgVerses),
      enrichWithChapterInfo(sbVerses),
      enrichWithChapterInfo(ccVerses),
    ]);

    const results = {
      bg: {
        verses: bgEnriched,
        narrativeIntro: bgEnriched.length > 0 ? generateNarrativeIntro("BG", query) : "",
        narrativeConnectors: generateConnectors(bgEnriched),
      },
      sb: {
        verses: sbEnriched,
        narrativeIntro: sbEnriched.length > 0 ? generateNarrativeIntro("SB", query) : "",
        narrativeConnectors: generateConnectors(sbEnriched),
      },
      cc: {
        verses: ccEnriched,
        narrativeIntro: ccEnriched.length > 0 ? generateNarrativeIntro("CC", query) : "",
        narrativeConnectors: generateConnectors(ccEnriched),
      },
    };

    return NextResponse.json(results);
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: "An error occurred while searching. Please try again." },
      { status: 500 }
    );
  }
}
