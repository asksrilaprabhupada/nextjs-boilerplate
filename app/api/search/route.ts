import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { embedQuery } from "@/app/lib/embed";
import { getCached, setCached } from "@/app/lib/search-cache";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const geminiKey = process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL_SYNTHESIS = "gemini-2.0-flash";

function getSupabase() { return createClient(supabaseUrl, supabaseKey); }

const BOOK_NAMES: Record<string, string> = {
  bg: "Bhagavad Gītā As It Is", sb: "Śrīmad Bhāgavatam", cc: "Śrī Caitanya Caritāmṛta",
  noi: "Nectar of Instruction", iso: "Śrī Īśopaniṣad", bs: "Śrī Brahma-saṁhitā",
  lob: "Light of the Bhāgavata", kb: "Kṛṣṇa Book", nod: "The Nectar of Devotion",
  ssr: "The Science of Self-Realization", tlc: "Teachings of Lord Caitanya",
  tlk: "Teachings of Lord Kapila", tqk: "Teachings of Queen Kuntī",
  sc: "A Second Chance", bbd: "Beyond Birth and Death",
  bhakti: "Bhakti: The Art of Eternal Love", cat: "Civilization and Transcendence",
  josd: "The Journey of Self-Discovery", owk: "On the Way to Kṛṣṇa",
  pop: "The Path of Perfection", poy: "The Perfection of Yoga",
  pqpa: "Perfect Questions, Perfect Answers", rv: "Rāja-vidyā: The King of Knowledge",
  cabh: "Chant and Be Happy", spl: "Śrīla Prabhupāda-līlāmṛta",
  rkd: "Rāmāyaṇa", mbk: "Mahābhārata",
};
function getBookName(slug: string): string { return BOOK_NAMES[slug?.toLowerCase()] || slug || "Unknown"; }

function buildVedabaseUrl(scripture: string, canto: string, chapter: string, verse: string): string {
  const base = "https://vedabase.io/en/library";
  const s = scripture?.toLowerCase();
  if (s === "bg") return `${base}/bg/${chapter}/${verse}/`;
  if (s === "sb") return `${base}/sb/${canto}/${chapter}/${verse}/`;
  if (s === "cc") return `${base}/cc/${canto}/${chapter}/${verse}/`;
  return `${base}/${s}/`;
}

// =====================================================
// GEMINI API HELPER
// =====================================================
async function callGemini(prompt: string, model: string, maxTokens: number): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": geminiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          maxOutputTokens: maxTokens,
          temperature: 0.3,
        },
      }),
    });
    if (!res.ok) {
      console.error("Gemini API error:", res.status, await res.text());
      return "";
    }
    const data = await res.json();
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } catch (err) {
    console.error("Gemini call failed:", err);
    return "";
  }
}

// =====================================================
// TYPES
// =====================================================
interface VerseHit { id: string; scripture: string; verse_number: string; sanskrit_devanagari: string; transliteration: string; translation: string; purport: string; chapter_id: string; chapter_number?: string; canto_or_division?: string; chapter_title?: string; book_slug?: string; vedabase_url?: string; score?: number; }
interface ProseHit { id: string; book_slug: string; paragraph_number: number; body_text: string; chapter_id: string; vedabase_url?: string; chapter_title?: string; score?: number; }

// =====================================================
// HYBRID SEARCH: Semantic + Full-text with fallback
// =====================================================
async function hybridSearch(query: string): Promise<{ verses: VerseHit[]; prose: ProseHit[] }> {
  const supabase = getSupabase();

  // Step 1: Embed the query
  const embedding = await embedQuery(query);
  const hasEmbedding = embedding.length === 1536;

  if (hasEmbedding) {
    // Convert to string format for Supabase RPC
    const vectorStr = `[${embedding.join(",")}]`;

    try {
      // Step 2: Run 4 search queries in parallel
      const [semanticVerses, semanticProse, ftsVerses, ftsProse] = await Promise.all([
        supabase.rpc("search_verses_semantic", { query_embedding: vectorStr, match_count: 20 }),
        supabase.rpc("search_prose_semantic", { query_embedding: vectorStr, match_count: 15 }),
        supabase.rpc("search_verses_fulltext", { search_query: query, match_count: 15 }),
        supabase.rpc("search_prose_fulltext", { search_query: query, match_count: 10 }),
      ]);

      // Step 3: Merge and deduplicate verses
      const verseMap = new Map<string, VerseHit & { score: number }>();

      for (const v of (semanticVerses.data || [])) {
        verseMap.set(v.id, { ...v, score: v.similarity || 0 });
      }
      for (const v of (ftsVerses.data || [])) {
        if (verseMap.has(v.id)) {
          // Found by BOTH — boost score
          const existing = verseMap.get(v.id)!;
          existing.score += 0.3;
        } else {
          // Normalize FTS rank to ~0-1 range (ts_rank is usually small)
          verseMap.set(v.id, { ...v, score: Math.min((v.rank || 0) * 10, 1) * 0.5 });
        }
      }

      // Step 3b: Merge and deduplicate prose
      const proseMap = new Map<string, ProseHit & { score: number }>();

      for (const p of (semanticProse.data || [])) {
        proseMap.set(p.id, { ...p, score: p.similarity || 0 });
      }
      for (const p of (ftsProse.data || [])) {
        if (proseMap.has(p.id)) {
          const existing = proseMap.get(p.id)!;
          existing.score += 0.3;
        } else {
          proseMap.set(p.id, { ...p, score: Math.min((p.rank || 0) * 10, 1) * 0.5 });
        }
      }

      // Step 4: Sort by combined relevance, take top 25 total
      const allVerses = [...verseMap.values()].sort((a, b) => b.score - a.score);
      const allProse = [...proseMap.values()].sort((a, b) => b.score - a.score);

      // Distribute: up to 18 verses, up to 7 prose, total 25
      const topVerses = allVerses.slice(0, 18);
      const topProse = allProse.slice(0, 7);
      const remaining = 25 - topVerses.length - topProse.length;
      if (remaining > 0 && allVerses.length > 18) {
        topVerses.push(...allVerses.slice(18, 18 + remaining));
      }

      return { verses: topVerses, prose: topProse };
    } catch (err) {
      console.error("Hybrid search failed, falling back to full-text:", err);
      return fullTextSearch(query);
    }
  }

  // Embedding failed — fall back to full-text search
  console.warn("Embedding failed, using full-text search fallback");
  return fullTextSearch(query);
}

async function fullTextSearch(query: string): Promise<{ verses: VerseHit[]; prose: ProseHit[] }> {
  const supabase = getSupabase();

  try {
    const [ftsVerses, ftsProse] = await Promise.all([
      supabase.rpc("search_verses_fulltext", { search_query: query, match_count: 20 }),
      supabase.rpc("search_prose_fulltext", { search_query: query, match_count: 10 }),
    ]);

    if ((ftsVerses.data?.length || 0) > 0 || (ftsProse.data?.length || 0) > 0) {
      return {
        verses: (ftsVerses.data || []).map((v: VerseHit & { rank?: number }) => ({ ...v, score: v.rank || 0 })),
        prose: (ftsProse.data || []).map((p: ProseHit & { rank?: number }) => ({ ...p, score: p.rank || 0 })),
      };
    }
  } catch (err) {
    console.error("Full-text search failed, falling back to ilike:", err);
  }

  // Final fallback: ilike search
  return ilikeSearch(query);
}

async function ilikeSearch(query: string): Promise<{ verses: VerseHit[]; prose: ProseHit[] }> {
  const supabase = getSupabase();
  const terms = query.toLowerCase().replace(/[?!.,]/g, "").split(/\s+/).filter(w => w.length > 3);
  if (terms.length === 0) return { verses: [], prose: [] };

  const tf = terms.map(k => `translation.ilike.%${k}%`).join(",");
  const pf = terms.map(k => `purport.ilike.%${k}%`).join(",");
  const bf = terms.map(k => `body_text.ilike.%${k}%`).join(",");

  const [{ data: vT }, { data: vP }, { data: pr }] = await Promise.all([
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id").or(tf).limit(15),
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id").or(pf).limit(15),
    supabase.from("prose_paragraphs").select("id,book_slug,paragraph_number,body_text,chapter_id,vedabase_url").or(bf).limit(15),
  ]);

  const seenV = new Set<string>();
  const allV = [...(vT || []), ...(vP || [])];
  const uV = allV.filter(v => { if (seenV.has(v.id)) return false; seenV.add(v.id); return true; });
  const uP = (pr || []);
  return { verses: uV, prose: uP };
}

// =====================================================
// ENRICH: Single query with IN clause for chapter info
// =====================================================
async function enrich(verses: VerseHit[], prose: ProseHit[]) {
  const supabase = getSupabase();
  const ids = [...new Set([...verses.map(v => v.chapter_id), ...prose.map(p => p.chapter_id)].filter(Boolean))];

  let cm = new Map<string, Record<string, unknown>>();
  if (ids.length > 0) {
    const { data } = await supabase.from("chapters").select("id,chapter_number,canto_or_division,chapter_title,book_slug").in("id", ids);
    cm = new Map((data || []).map((c: Record<string, unknown>) => [c.id as string, c]));
  }

  const eV = verses.map(v => {
    const c = cm.get(v.chapter_id);
    const cn = (c?.chapter_number as string) || "";
    const cd = (c?.canto_or_division as string) || "";
    return {
      ...v,
      chapter_number: cn,
      canto_or_division: cd,
      chapter_title: (c?.chapter_title as string) || "",
      book_slug: (c?.book_slug as string) || v.scripture?.toLowerCase(),
      vedabase_url: buildVedabaseUrl(v.scripture, cd, cn, v.verse_number),
    };
  });

  const eP = prose.map(p => {
    const c = cm.get(p.chapter_id);
    return {
      ...p,
      chapter_title: (c?.chapter_title as string) || "",
      vedabase_url: p.vedabase_url || `https://vedabase.io/en/library/${p.book_slug}/`,
    };
  });

  return { verses: eV, prose: eP };
}

// =====================================================
// SYNTHESIS (Gemini)
// =====================================================
async function synthesize(question: string, verses: VerseHit[], prose: ProseHit[]) {
  let ctx = "";
  const byBook: Record<string, { v: VerseHit[]; p: ProseHit[] }> = {};
  for (const v of verses) { const s = v.book_slug || v.scripture?.toLowerCase() || "x"; if (!byBook[s]) byBook[s] = { v: [], p: [] }; byBook[s].v.push(v); }
  for (const p of prose) { if (!byBook[p.book_slug]) byBook[p.book_slug] = { v: [], p: [] }; byBook[p.book_slug].p.push(p); }

  for (const [slug, d] of Object.entries(byBook)) {
    ctx += `\n=== ${getBookName(slug).toUpperCase()} ===\n`;
    for (const v of d.v.slice(0, 10)) {
      const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`;
      ctx += `[${ref}] (${v.vedabase_url})\nTranslation: "${v.translation}"\nPurport: "${(v.purport || "").substring(0, 500)}"\n\n`;
    }
    for (const p of d.p.slice(0, 5)) {
      ctx += `[${getBookName(p.book_slug)} - ${p.chapter_title}] (${p.vedabase_url})\n"${p.body_text.substring(0, 400)}"\n\n`;
    }
  }

  if (!ctx.trim()) return "<p>No relevant passages found.</p>";

  const prompt = `You are the answer engine for asksrilaprabhupada.com. Devotee asked: "${question}"

Use ONLY the data below. Never invent.

RULES:
1. BG translations: "Lord Kṛṣṇa says in <a href="URL" class="verse-link" target="_blank"><span class="verse-ref">[BG X.Y]</span></a>:" then quote.
2. BG purports: "Śrīla Prabhupāda explains in the purport:" then key sentences.
3. SB: mention speaker if identifiable (Śukadeva, Nārada, etc.).
4. CC: mention Lord Caitanya or relevant devotee.
5. Prose: "In [Book], Śrīla Prabhupāda writes:" then quote.
6. EVERY reference MUST be a link: <a href="VEDABASE_URL" class="verse-link" target="_blank"><span class="verse-ref">[REF]</span></a>
7. Use 10-15+ distinct references minimum.
8. Order: BG → SB → CC → other books. Each gets <h3>.
9. Smooth connecting paragraphs. Read like a flowing report, not a list.
10. Direct quotes in quotation marks. Diacritical marks always.
11. Warm devotional tone. Serve the devotees.

FORMAT: Clean HTML only.
- <h3> for section headers
- <div class="verse-quote"> for translations
- <div class="purport-quote"> for purports
- <div class="prose-quote"> for prose excerpts
- <a href class="verse-link" target="_blank"><span class="verse-ref">[REF]</span></a> for references
- <p> for narrative. No markdown.

DATA:
${ctx}`;

  try {
    const text = await callGemini(prompt, GEMINI_MODEL_SYNTHESIS, 3000);
    if (!text) return buildFB(verses, prose);
    return text;
  } catch {
    return buildFB(verses, prose);
  }
}

function buildFB(v: VerseHit[], p: ProseHit[]) {
  let h = "<h3>Scripture References</h3>";
  for (const x of v.slice(0, 15)) {
    const ref = `${x.scripture} ${x.canto_or_division ? x.canto_or_division + "." : ""}${x.chapter_number}.${x.verse_number}`;
    h += `<div class="verse-quote"><a href="${x.vedabase_url}" class="verse-link" target="_blank"><span class="verse-ref">[${ref}]</span></a> "${x.translation}"</div>`;
  }
  for (const x of p.slice(0, 10)) h += `<div class="prose-quote"><a href="${x.vedabase_url}" class="verse-link" target="_blank">${getBookName(x.book_slug)}</a>: "${x.body_text.substring(0, 300)}..."</div>`;
  return h;
}

// =====================================================
// API HANDLER
// =====================================================
export async function GET(request: NextRequest) {
  const query = new URL(request.url).searchParams.get("q");
  if (!query) return NextResponse.json({ error: "Query 'q' required" }, { status: 400 });

  // Check cache first
  const cached = getCached<Record<string, unknown>>(query);
  if (cached) return NextResponse.json(cached);

  try {
    // Hybrid search: semantic + full-text + ilike fallback chain
    const { verses: rawVerses, prose: rawProse } = await hybridSearch(query);

    // Enrich with chapter info (single IN query)
    const { verses, prose } = await enrich(rawVerses, rawProse);

    // Synthesize narrative
    const narrative = await synthesize(query, verses, prose);

    const citations = [
      ...verses.map(v => ({ ref: `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`, book: getBookName(v.book_slug || ""), url: v.vedabase_url || "", type: "verse" as const, title: v.chapter_title || "" })),
      ...prose.map(p => ({ ref: `${getBookName(p.book_slug)}`, book: getBookName(p.book_slug), url: p.vedabase_url || "", type: "prose" as const, title: p.chapter_title || "" })),
    ];

    const books: Record<string, { slug: string; name: string; verses: typeof verses; prose: typeof prose }> = {};
    for (const v of verses) { const s = (v.book_slug || "").toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [] }; books[s].verses.push(v); }
    for (const p of prose) { const s = p.book_slug.toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [] }; books[s].prose.push(p); }

    const result = { query, narrative, totalResults: verses.length + prose.length, citations, books: Object.values(books) };

    // Cache successful results
    setCached(query, result);

    return NextResponse.json(result);
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json({ error: "An error occurred." }, { status: 500 });
  }
}
