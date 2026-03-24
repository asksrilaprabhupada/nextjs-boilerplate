import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const geminiKey = process.env.GEMINI_API_KEY || "";

// Model for keyword extraction (simple task — use cheapest)
const GEMINI_MODEL_KEYWORDS = "gemini-2.5-flash-lite";
// Model for synthesis (needs quality — use flash-lite for free, or "gemini-2.5-flash" for better quality)
const GEMINI_MODEL_SYNTHESIS = "gemini-2.5-flash-lite";

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
// TOUCH 1: Extract keywords + synonyms
// =====================================================
async function extractKeywordsAndSynonyms(question: string) {
  const prompt = `Extract search terms for Srila Prabhupada's scripture library.
Question: "${question}"
Return ONLY JSON: {"keywords":["6-10 direct terms"],"synonyms":["6-10 alternate terms Prabhupada uses"],"relatedConcepts":["4-6 broader concepts"]}
No explanation. Only JSON.`;

  try {
    const text = await callGemini(prompt, GEMINI_MODEL_KEYWORDS, 300);
    if (!text) return fallback(question);
    const cleaned = text.replace(/```json\n?/g, "").replace(/```/g, "").trim();
    const parsed = JSON.parse(cleaned);
    return {
      keywords: parsed.keywords || [],
      synonyms: parsed.synonyms || [],
      relatedConcepts: parsed.relatedConcepts || [],
    };
  } catch {
    return fallback(question);
  }
}

function fallback(q: string) {
  return {
    keywords: q.toLowerCase().replace(/[?!.,]/g, "").split(/\s+/).filter(w => w.length > 3),
    synonyms: [],
    relatedConcepts: [],
  };
}

interface VerseHit { id: string; scripture: string; verse_number: string; sanskrit_devanagari: string; transliteration: string; translation: string; purport: string; chapter_id: string; chapter_number?: string; canto_or_division?: string; chapter_title?: string; book_slug?: string; vedabase_url?: string; }
interface ProseHit { id: string; book_slug: string; paragraph_number: number; body_text: string; chapter_id: string; vedabase_url?: string; chapter_title?: string; }

// Search all tables
async function searchWithTerms(terms: string[], seenV: Set<string>, seenP: Set<string>) {
  if (terms.length === 0) return { verses: [] as VerseHit[], prose: [] as ProseHit[] };
  const supabase = getSupabase();
  const tf = terms.map(k => `translation.ilike.%${k}%`).join(",");
  const pf = terms.map(k => `purport.ilike.%${k}%`).join(",");
  const bf = terms.map(k => `body_text.ilike.%${k}%`).join(",");

  const [{ data: vT }, { data: vP }, { data: pr }] = await Promise.all([
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id").or(tf).limit(15),
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id").or(pf).limit(15),
    supabase.from("prose_paragraphs").select("id,book_slug,paragraph_number,body_text,chapter_id,vedabase_url").or(bf).limit(15),
  ]);

  const allV = [...(vT || []), ...(vP || [])];
  const uV = allV.filter(v => { if (seenV.has(v.id)) return false; seenV.add(v.id); return true; });
  const uP = (pr || []).filter(p => { if (seenP.has(p.id)) return false; seenP.add(p.id); return true; });
  return { verses: uV, prose: uP };
}

// Enrich with chapter info
async function enrich(verses: VerseHit[], prose: ProseHit[]) {
  const supabase = getSupabase();
  const ids = [...new Set([...verses.map(v => v.chapter_id), ...prose.map(p => p.chapter_id)])];
  let cm = new Map();
  if (ids.length > 0) {
    const { data } = await supabase.from("chapters").select("id,chapter_number,canto_or_division,chapter_title,book_slug").in("id", ids);
    cm = new Map((data || []).map((c: Record<string, unknown>) => [c.id, c]));
  }
  const eV = verses.map(v => {
    const c = cm.get(v.chapter_id) as Record<string, unknown> | undefined;
    const cn = (c?.chapter_number as string) || ""; const cd = (c?.canto_or_division as string) || "";
    return { ...v, chapter_number: cn, canto_or_division: cd, chapter_title: (c?.chapter_title as string) || "", book_slug: (c?.book_slug as string) || v.scripture?.toLowerCase(), vedabase_url: buildVedabaseUrl(v.scripture, cd, cn, v.verse_number) };
  });
  const eP = prose.map(p => {
    const c = cm.get(p.chapter_id) as Record<string, unknown> | undefined;
    return { ...p, chapter_title: (c?.chapter_title as string) || "", vedabase_url: p.vedabase_url || `https://vedabase.io/en/library/${p.book_slug}/` };
  });
  return { verses: eV, prose: eP };
}

// =====================================================
// TOUCH 2: Synthesize answer (Gemini)
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

export async function GET(request: NextRequest) {
  const query = new URL(request.url).searchParams.get("q");
  if (!query) return NextResponse.json({ error: "Query 'q' required" }, { status: 400 });

  try {
    const { keywords, synonyms, relatedConcepts } = await extractKeywordsAndSynonyms(query);
    const seenV = new Set<string>(), seenP = new Set<string>();
    const r1 = await searchWithTerms(keywords, seenV, seenP);
    const r2 = await searchWithTerms(synonyms, seenV, seenP);
    const allV = [...r1.verses, ...r2.verses], allP = [...r1.prose, ...r2.prose];
    const { verses, prose } = await enrich(allV, allP);
    const narrative = await synthesize(query, verses, prose);

    const citations = [
      ...verses.map(v => ({ ref: `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`, book: getBookName(v.book_slug || ""), url: v.vedabase_url || "", type: "verse" as const, title: v.chapter_title || "" })),
      ...prose.map(p => ({ ref: `${getBookName(p.book_slug)}`, book: getBookName(p.book_slug), url: p.vedabase_url || "", type: "prose" as const, title: p.chapter_title || "" })),
    ];

    const books: Record<string, { slug: string; name: string; verses: typeof verses; prose: typeof prose }> = {};
    for (const v of verses) { const s = (v.book_slug || "").toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [] }; books[s].verses.push(v); }
    for (const p of prose) { const s = p.book_slug.toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [] }; books[s].prose.push(p); }

    return NextResponse.json({ query, keywords, synonyms, relatedConcepts, narrative, totalResults: verses.length + prose.length, citations, books: Object.values(books) });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json({ error: "An error occurred." }, { status: 500 });
  }
}