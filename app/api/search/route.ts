import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const anthropicKey = process.env.ANTHROPIC_API_KEY || "";

function getSupabase() {
  return createClient(supabaseUrl, supabaseKey);
}

// Book display names
const BOOK_NAMES: Record<string, string> = {
  bg: "Bhagavad Gītā As It Is",
  sb: "Śrīmad Bhāgavatam",
  cc: "Śrī Caitanya Caritāmṛta",
  noi: "Nectar of Instruction",
  iso: "Śrī Īśopaniṣad",
  bs: "Śrī Brahma-saṁhitā",
  lob: "Light of the Bhāgavata",
  kb: "Kṛṣṇa, the Supreme Personality of Godhead",
  nod: "The Nectar of Devotion",
  ssr: "The Science of Self-Realization",
  tlc: "Teachings of Lord Caitanya",
  tlk: "Teachings of Lord Kapila",
  tqk: "Teachings of Queen Kuntī",
  sc: "A Second Chance",
  bbd: "Beyond Birth and Death",
  bhakti: "Bhakti: The Art of Eternal Love",
  cat: "Civilization and Transcendence",
  josd: "The Journey of Self-Discovery",
  owk: "On the Way to Kṛṣṇa",
  pop: "The Path of Perfection",
  poy: "The Perfection of Yoga",
  pqpa: "Perfect Questions, Perfect Answers",
  rv: "Rāja-vidyā: The King of Knowledge",
  cabh: "Chant and Be Happy",
  spl: "Śrīla Prabhupāda-līlāmṛta",
  rkd: "Rāmāyaṇa",
  mbk: "Mahābhārata",
};

function getBookName(slug: string): string {
  return BOOK_NAMES[slug.toLowerCase()] || slug;
}

// ============================================================
// TOUCH 1: Ask Claude to extract search keywords from question
// Cost: ~50 tokens (~$0.0001)
// ============================================================
async function extractKeywords(question: string): Promise<string[]> {
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 150,
        messages: [
          {
            role: "user",
            content: `You are a keyword extractor for searching Srila Prabhupada's books (Bhagavad Gita, Srimad Bhagavatam, Caitanya Caritamrita, Nectar of Devotion, and other Vaishnava texts).

Given this question from a devotee: "${question}"

Extract 6-10 search keywords and phrases that would find relevant verses and paragraphs in Prabhupada's books. Include:
- Sanskrit terms (like "bhakti", "karma", "dharma", "atma", "maya")
- English equivalents used by Prabhupada
- Key philosophical concepts
- Names of personalities if relevant

Return ONLY a JSON array of strings. Nothing else. No explanation.
Example: ["surrender", "sharanagati", "devotional service", "Krishna", "Bg 18.66", "give up", "protection"]`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Touch 1 failed:", response.status);
      // Fallback: simple keyword extraction
      return question.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || "[]";
    // Parse the JSON array from Claude's response
    const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const keywords = JSON.parse(cleaned);
    return Array.isArray(keywords) ? keywords : [question];
  } catch (err) {
    console.error("Touch 1 error:", err);
    return question.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
  }
}

// ============================================================
// DATABASE SEARCH: Find relevant content using keywords
// Cost: FREE (no AI)
// ============================================================
interface VerseHit {
  id: string;
  scripture: string;
  verse_number: string;
  sanskrit_devanagari: string;
  transliteration: string;
  translation: string;
  purport: string;
  chapter_id: string;
  chapter_number?: string;
  canto_or_division?: string;
  chapter_title?: string;
  book_slug?: string;
}

interface ProseHit {
  id: string;
  book_slug: string;
  paragraph_number: number;
  body_text: string;
  chapter_id: string;
  vedabase_url?: string;
  chapter_title?: string;
}

async function searchDatabase(keywords: string[]): Promise<{
  verses: VerseHit[];
  prose: ProseHit[];
}> {
  const supabase = getSupabase();

  // Search verses by translation
  const verseTransFilter = keywords.map((k) => `translation.ilike.%${k}%`).join(",");
  const { data: versesByTrans } = await supabase
    .from("verses")
    .select("id, scripture, verse_number, sanskrit_devanagari, transliteration, translation, purport, chapter_id")
    .or(verseTransFilter)
    .limit(20);

  // Search verses by purport
  const versePurpFilter = keywords.map((k) => `purport.ilike.%${k}%`).join(",");
  const { data: versesByPurport } = await supabase
    .from("verses")
    .select("id, scripture, verse_number, sanskrit_devanagari, transliteration, translation, purport, chapter_id")
    .or(versePurpFilter)
    .limit(20);

  // Search prose paragraphs
  const proseFilter = keywords.map((k) => `body_text.ilike.%${k}%`).join(",");
  const { data: proseHits } = await supabase
    .from("prose_paragraphs")
    .select("id, book_slug, paragraph_number, body_text, chapter_id, vedabase_url")
    .or(proseFilter)
    .limit(20);

  // Combine and deduplicate verses
  const allVerses = [...(versesByTrans || []), ...(versesByPurport || [])];
  const seenIds = new Set<string>();
  const uniqueVerses = allVerses.filter((v) => {
    if (seenIds.has(v.id)) return false;
    seenIds.add(v.id);
    return true;
  });

  // Enrich with chapter info
  const allChapterIds = [
    ...new Set([
      ...uniqueVerses.map((v) => v.chapter_id),
      ...(proseHits || []).map((p) => p.chapter_id),
    ]),
  ];

  let chapterMap = new Map();
  if (allChapterIds.length > 0) {
    const { data: chapters } = await supabase
      .from("chapters")
      .select("id, chapter_number, canto_or_division, chapter_title, book_slug")
      .in("id", allChapterIds);
    chapterMap = new Map(
      (chapters || []).map((ch: Record<string, unknown>) => [ch.id, ch])
    );
  }

  const enrichedVerses: VerseHit[] = uniqueVerses.map((v) => {
    const ch = chapterMap.get(v.chapter_id) as Record<string, unknown> | undefined;
    return {
      ...v,
      chapter_number: (ch?.chapter_number as string) || "",
      canto_or_division: (ch?.canto_or_division as string) || "",
      chapter_title: (ch?.chapter_title as string) || "",
      book_slug: (ch?.book_slug as string) || v.scripture?.toLowerCase() || "",
    };
  });

  const enrichedProse: ProseHit[] = (proseHits || []).map((p) => {
    const ch = chapterMap.get(p.chapter_id) as Record<string, unknown> | undefined;
    return {
      ...p,
      chapter_title: (ch?.chapter_title as string) || "",
    };
  });

  return { verses: enrichedVerses, prose: enrichedProse };
}

// ============================================================
// TOUCH 2: Ask Claude to synthesize a narrative answer
// Cost: ~500 tokens (~$0.001)
// ============================================================
async function synthesizeAnswer(
  question: string,
  verses: VerseHit[],
  prose: ProseHit[]
): Promise<string> {
  // Build context from search results
  let context = "";

  // Group verses by book
  const versesByBook: Record<string, VerseHit[]> = {};
  for (const v of verses) {
    const slug = v.book_slug || v.scripture?.toLowerCase() || "unknown";
    if (!versesByBook[slug]) versesByBook[slug] = [];
    versesByBook[slug].push(v);
  }

  // Group prose by book
  const proseByBook: Record<string, ProseHit[]> = {};
  for (const p of prose) {
    if (!proseByBook[p.book_slug]) proseByBook[p.book_slug] = [];
    proseByBook[p.book_slug].push(p);
  }

  // Build verse context
  for (const [slug, bookVerses] of Object.entries(versesByBook)) {
    const bookName = getBookName(slug);
    context += `\n\n=== FROM ${bookName.toUpperCase()} ===\n`;
    for (const v of bookVerses.slice(0, 8)) {
      const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`;
      context += `\n[${ref}]\n`;
      if (v.translation) context += `Translation: "${v.translation}"\n`;
      if (v.purport) context += `Purport (excerpt): "${v.purport.substring(0, 600)}"\n`;
    }
  }

  // Build prose context
  for (const [slug, bookProse] of Object.entries(proseByBook)) {
    const bookName = getBookName(slug);
    context += `\n\n=== FROM ${bookName.toUpperCase()} ===\n`;
    for (const p of bookProse.slice(0, 5)) {
      if (p.chapter_title) context += `[${p.chapter_title}]\n`;
      context += `"${p.body_text.substring(0, 500)}"\n\n`;
    }
  }

  if (!context.trim()) {
    return "I could not find specific references for this question in Śrīla Prabhupāda's books. Please try rephrasing your question with different terms.";
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 2000,
        messages: [
          {
            role: "user",
            content: `You are a devotional assistant for asksrilaprabhupada.com. A devotee asked this question:

"${question}"

Below are the relevant verses and passages found from Śrīla Prabhupāda's books. Use ONLY this content to answer. Do NOT add your own philosophical interpretations. Your job is to weave Prabhupāda's actual words into a beautiful, clear narrative.

RULES:
1. For Bhagavad Gītā translations, say "Lord Kṛṣṇa says in Bhagavad Gītā [verse ref]: ..." and quote the translation.
2. For Bhagavad Gītā purports, say "Śrīla Prabhupāda explains in the purport: ..." and quote key sentences.
3. For Śrīmad Bhāgavatam, mention which character is speaking if known (e.g., "Śukadeva Gosvāmī tells King Parīkṣit...").
4. For Caitanya Caritāmṛta, mention Lord Caitanya or the relevant devotee.
5. For prose books, say "In [book name], Śrīla Prabhupāda writes: ..." and quote.
6. Keep verse references in brackets like [BG 18.66] or [SB 1.2.6].
7. Present the most directly relevant points FIRST.
8. Use maximum 25 key points across all sources.
9. Organize by scripture: Bhagavad Gītā first, then Śrīmad Bhāgavatam, then Caitanya Caritāmṛta, then other books.
10. Use Prabhupāda's actual words as much as possible. Put his direct quotes in quotation marks.
11. Write in a warm, devotional tone. You are serving the devotees.
12. Use proper diacritical marks for Sanskrit terms (Kṛṣṇa, not Krishna).

FORMAT your response as clean HTML with these rules:
- Use <h3> for scripture section headers (e.g., "From Bhagavad Gītā As It Is")
- Use <div class="verse-quote"> for verse translations
- Use <div class="purport-quote"> for purport excerpts
- Use <div class="prose-quote"> for prose book excerpts
- Use <span class="verse-ref"> for verse references like [BG 18.66]
- Use <p> for your connecting narrative text
- Do NOT use markdown. Use only HTML.

SCRIPTURE DATA:
${context}`,
          },
        ],
      }),
    });

    if (!response.ok) {
      console.error("Touch 2 failed:", response.status);
      return buildFallbackResponse(verses, prose);
    }

    const data = await response.json();
    return data.content?.[0]?.text || buildFallbackResponse(verses, prose);
  } catch (err) {
    console.error("Touch 2 error:", err);
    return buildFallbackResponse(verses, prose);
  }
}

// If AI fails, build a basic response from raw data
function buildFallbackResponse(verses: VerseHit[], prose: ProseHit[]): string {
  let html = "";

  if (verses.length > 0) {
    html += "<h3>From the Scriptures</h3>";
    for (const v of verses.slice(0, 10)) {
      const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`;
      if (v.translation) {
        html += `<div class="verse-quote"><span class="verse-ref">[${ref}]</span> "${v.translation}"</div>`;
      }
    }
  }

  if (prose.length > 0) {
    html += "<h3>From Śrīla Prabhupāda's Books</h3>";
    for (const p of prose.slice(0, 5)) {
      const bookName = getBookName(p.book_slug);
      html += `<div class="prose-quote"><p><strong>From ${bookName}:</strong> "${p.body_text.substring(0, 400)}..."</p></div>`;
    }
  }

  return html || "<p>No relevant passages found. Please try a different question.</p>";
}

// ============================================================
// MAIN API HANDLER
// ============================================================
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q");

  if (!query) {
    return NextResponse.json({ error: "Query parameter 'q' is required" }, { status: 400 });
  }

  try {
    // TOUCH 1: Extract keywords using AI
    console.log("[Touch 1] Extracting keywords for:", query);
    const keywords = await extractKeywords(query);
    console.log("[Touch 1] Keywords:", keywords);

    // DATABASE SEARCH: Find relevant content (FREE)
    console.log("[Search] Searching database...");
    const { verses, prose } = await searchDatabase(keywords);
    console.log(`[Search] Found ${verses.length} verses, ${prose.length} prose paragraphs`);

    // TOUCH 2: Synthesize narrative answer using AI
    console.log("[Touch 2] Synthesizing answer...");
    const narrativeHtml = await synthesizeAnswer(query, verses, prose);

    // Group raw results by book for reference section
    const bookGroups: Record<string, {
      book_slug: string;
      book_name: string;
      verses: (VerseHit & { content_type: "verse" })[];
      prose: (ProseHit & { content_type: "prose" })[];
    }> = {};

    for (const v of verses) {
      const slug = (v.book_slug || v.scripture || "").toLowerCase();
      if (!bookGroups[slug]) {
        bookGroups[slug] = { book_slug: slug, book_name: getBookName(slug), verses: [], prose: [] };
      }
      bookGroups[slug].verses.push({ ...v, content_type: "verse" });
    }

    for (const p of prose) {
      const slug = p.book_slug.toLowerCase();
      if (!bookGroups[slug]) {
        bookGroups[slug] = { book_slug: slug, book_name: getBookName(slug), verses: [], prose: [] };
      }
      bookGroups[slug].prose.push({ ...p, content_type: "prose" });
    }

    return NextResponse.json({
      query,
      keywords,
      narrative: narrativeHtml,
      total_results: verses.length + prose.length,
      books: Object.values(bookGroups),
    });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json(
      { error: "An error occurred while searching. Please try again." },
      { status: 500 }
    );
  }
}