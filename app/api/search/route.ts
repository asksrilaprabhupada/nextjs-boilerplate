/**
 * route.ts — Search API Route
 *
 * Handles search queries with parallel hybrid semantic + full-text + tag search,
 * RRF (Reciprocal Rank Fusion) scoring, Gemini AI narrative generation, and SSE streaming.
 * The core backend that powers the entire search experience.
 */
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { embedQuery } from "@/app/lib/03-embed";
import { getCached, setCached } from "@/app/lib/04-search-cache";
import { ensureVerseLinks } from "@/app/lib/05-link-postprocessor";
import { preprocessQuery } from "@/app/lib/07-query-preprocessor";

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

/** Fallback URL builder — strips "Text " prefix as safety net */
function buildVedabaseUrl(scripture: string, canto: string, chapter: string, verse: string): string {
  const base = "https://vedabase.io/en/library";
  const s = scripture?.toLowerCase();
  const cleanVerse = verse?.replace(/^Text\s+/i, "") || "";
  if (s === "bg") return `${base}/bg/${chapter}/${cleanVerse}/`;
  if (s === "sb") return `${base}/sb/${canto}/${chapter}/${cleanVerse}/`;
  if (s === "cc") return `${base}/cc/${canto}/${chapter}/${cleanVerse}/`;
  return `${base}/${s}/`;
}

// =====================================================
// GEMINI API HELPERS
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
interface VerseHit { id: string; scripture: string; verse_number: string; sanskrit_devanagari: string; transliteration: string; translation: string; purport: string; chapter_id: string; chapter_number?: string; canto_or_division?: string; chapter_title?: string; book_slug?: string; vedabase_url?: string; tags?: string[]; score?: number; }
interface ProseHit { id: string; book_slug: string; paragraph_number: number; body_text: string; chapter_id: string; vedabase_url?: string; chapter_title?: string; tags?: string[]; score?: number; }

// =====================================================
// RRF (Reciprocal Rank Fusion) SCORING
// =====================================================
const RRF_K = 60;

function rrfMerge<T extends { id: string }>(
  semanticList: T[],
  ftsList: T[],
  tagList: T[],
): Map<string, T & { score: number }> {
  const map = new Map<string, T & { score: number }>();

  semanticList.forEach((v, rank) => {
    const existing = map.get(v.id) || { ...v, score: 0 };
    existing.score += 1 / (RRF_K + rank);
    if (!map.has(v.id)) map.set(v.id, existing);
  });

  ftsList.forEach((v, rank) => {
    const existing = map.get(v.id) || { ...v, score: 0 };
    existing.score += 1 / (RRF_K + rank);
    if (!map.has(v.id)) map.set(v.id, existing);
  });

  tagList.forEach((v, rank) => {
    const existing = map.get(v.id) || { ...v, score: 0 };
    existing.score += 0.5 / (RRF_K + rank);
    if (!map.has(v.id)) map.set(v.id, existing);
  });

  return map;
}

// =====================================================
// V2 PARALLEL HYBRID SEARCH: FTS + Tags immediately, Semantic in parallel
// =====================================================
async function hybridSearchV2(query: string): Promise<{ verses: VerseHit[]; prose: ProseHit[] }> {
  const supabase = getSupabase();
  const preprocessed = await preprocessQuery(query);
  const mainPhrase = preprocessed.searchPhrases[0];

  // WAVE 1: Instant (no embedding needed)
  const ftsVersesPromise = supabase.rpc("search_verses_fulltext_v2", { search_query: mainPhrase, match_count: 25 });
  const ftsProsePromise = supabase.rpc("search_prose_fulltext_v2", { search_query: mainPhrase, match_count: 15 });
  const tagVersesPromise = preprocessed.tagTerms.length > 0
    ? supabase.rpc("search_verses_by_tags", { search_terms: preprocessed.tagTerms, match_count: 15 })
    : Promise.resolve({ data: [] as VerseHit[] });
  const tagProsePromise = preprocessed.tagTerms.length > 0
    ? supabase.rpc("search_prose_by_tags", { search_terms: preprocessed.tagTerms, match_count: 10 })
    : Promise.resolve({ data: [] as ProseHit[] });

  // WAVE 2: Embedding (parallel with Wave 1)
  const embeddingPromise = embedQuery(preprocessed.isLong ? mainPhrase : query);

  // Wait for all Wave 1 + embedding in parallel
  const [ftsVerses, ftsProse, tagVerses, tagProse, embedding] = await Promise.all([
    ftsVersesPromise, ftsProsePromise, tagVersesPromise, tagProsePromise, embeddingPromise,
  ]);

  // When embedding is ready, fire semantic search
  let semanticVersesData: VerseHit[] = [];
  let semanticProseData: ProseHit[] = [];

  if (embedding.length === 1536) {
    const vectorStr = `[${embedding.join(",")}]`;
    const [semV, semP] = await Promise.all([
      supabase.rpc("search_verses_semantic_v2", { query_embedding: vectorStr, match_count: 30 }),
      supabase.rpc("search_prose_semantic_v2", { query_embedding: vectorStr, match_count: 20 }),
    ]);
    semanticVersesData = semV.data || [];
    semanticProseData = semP.data || [];
  }

  // MERGE with RRF
  const verseMap = rrfMerge<VerseHit>(
    semanticVersesData,
    ftsVerses.data || [],
    tagVerses.data || [],
  );
  const proseMap = rrfMerge<ProseHit>(
    semanticProseData,
    ftsProse.data || [],
    tagProse.data || [],
  );

  const allVerses = [...verseMap.values()].sort((a, b) => b.score - a.score);
  const allProse = [...proseMap.values()].sort((a, b) => b.score - a.score);

  return { verses: allVerses, prose: allProse };
}

// =====================================================
// HYBRID SEARCH: V2 with fallback to legacy V1
// =====================================================
async function hybridSearch(query: string): Promise<{ verses: VerseHit[]; prose: ProseHit[] }> {
  try {
    return await hybridSearchV2(query);
  } catch (err) {
    console.error("V2 search failed, falling back to v1:", err);
    const raw = await fullTextSearch(query);
    return await legacyEnrich(raw.verses, raw.prose);
  }
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
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id,vedabase_url").or(tf).limit(15),
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id,vedabase_url").or(pf).limit(15),
    supabase.from("prose_paragraphs").select("id,book_slug,paragraph_number,body_text,chapter_id,vedabase_url").or(bf).limit(15),
  ]);

  const seenV = new Set<string>();
  const allV = [...(vT || []), ...(vP || [])];
  const uV = allV.filter(v => { if (seenV.has(v.id)) return false; seenV.add(v.id); return true; });
  const uP = (pr || []);
  return { verses: uV, prose: uP };
}

// =====================================================
// LEGACY ENRICH: Used by V1 fallback path only
// =====================================================
async function legacyEnrich(verses: VerseHit[], prose: ProseHit[]) {
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
      vedabase_url: v.vedabase_url || buildVedabaseUrl(v.scripture, cd, cn, v.verse_number),
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
// BUILD VERSE URL MAP for link post-processing
// =====================================================
function buildVerseUrlMap(verses: VerseHit[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of verses) {
    if (!v.vedabase_url) continue;
    const ref = `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`;
    map.set(ref, v.vedabase_url);
    map.set(`[${ref}]`, v.vedabase_url);
  }
  return map;
}

// =====================================================
// SYNTHESIS PROMPT BUILDER
// =====================================================
function buildSynthesisPrompt(question: string, verses: VerseHit[], prose: ProseHit[]): string {
  // Only pass top 20 verses and top 5 prose to synthesis (overflow is for "dig deeper" modal)
  const synthVerses = verses.slice(0, 20);
  const synthProse = prose.slice(0, 5);

  let ctx = "";
  const byBook: Record<string, { v: VerseHit[]; p: ProseHit[] }> = {};
  for (const v of synthVerses) { const s = v.book_slug || v.scripture?.toLowerCase() || "x"; if (!byBook[s]) byBook[s] = { v: [], p: [] }; byBook[s].v.push(v); }
  for (const p of synthProse) { if (!byBook[p.book_slug]) byBook[p.book_slug] = { v: [], p: [] }; byBook[p.book_slug].p.push(p); }

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

  if (!ctx.trim()) return "";

  return `You are the answer engine for asksrilaprabhupada.com. Devotee asked: "${question}"

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
9. You are a LIBRARIAN, not a guru. You introduce quotes and connect them with transitions like "Lord Kṛṣṇa says...", "Prabhupāda further explains...", "In another place...". You NEVER explain philosophy in your own words. Every philosophical statement must be a direct quote from the DATA below.
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
}

// =====================================================
// NON-STREAMING SYNTHESIS (fallback)
// =====================================================
async function synthesize(question: string, verses: VerseHit[], prose: ProseHit[], verseUrlMap: Map<string, string>) {
  const prompt = buildSynthesisPrompt(question, verses, prose);
  if (!prompt) return "<p>No relevant passages found.</p>";

  try {
    const text = await callGemini(prompt, GEMINI_MODEL_SYNTHESIS, 3000);
    if (!text) return buildFB(verses, prose);
    return ensureVerseLinks(text, verseUrlMap);
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
// METADATA + CITATIONS BUILDER
// =====================================================
function buildMetadataAndCitations(query: string, verses: VerseHit[], prose: ProseHit[]) {
  const citations = [
    ...verses.map(v => ({ ref: `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${v.verse_number}`, book: getBookName(v.book_slug || ""), url: v.vedabase_url || "", type: "verse" as const, title: v.chapter_title || "" })),
    ...prose.map(p => ({ ref: `${getBookName(p.book_slug)}`, book: getBookName(p.book_slug), url: p.vedabase_url || "", type: "prose" as const, title: p.chapter_title || "" })),
  ];

  const books: Record<string, { slug: string; name: string; verses: typeof verses; prose: typeof prose }> = {};
  for (const v of verses) { const s = (v.book_slug || "").toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [] }; books[s].verses.push(v); }
  for (const p of prose) { const s = p.book_slug.toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [] }; books[s].prose.push(p); }

  return {
    query,
    totalResults: verses.length + prose.length,
    citations,
    books: Object.values(books),
  };
}

// =====================================================
// STREAMING HANDLER
// =====================================================
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const query = url.searchParams.get("q");
  const wantStream = url.searchParams.get("stream") !== "false";

  if (!query) return NextResponse.json({ error: "Query 'q' required" }, { status: 400 });

  const cached = getCached<Record<string, unknown>>(query);
  if (cached) return NextResponse.json(cached);

  try {
    const { verses, prose } = await hybridSearch(query);
    const verseUrlMap = buildVerseUrlMap(verses);
    const metadata = buildMetadataAndCitations(query, verses, prose);

    if (!wantStream) {
      const narrative = await synthesize(query, verses, prose, verseUrlMap);
      const result = { ...metadata, narrative };
      setCached(query, result);
      return NextResponse.json(result);
    }

    const prompt = buildSynthesisPrompt(query, verses, prose);
    if (!prompt) {
      const result = { ...metadata, narrative: "<p>No relevant passages found.</p>" };
      return NextResponse.json(result);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        send({ type: "metadata", ...metadata });

        try {
          const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL_SYNTHESIS}:streamGenerateContent?alt=sse`;
          const geminiRes = await fetch(streamUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": geminiKey,
            },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                maxOutputTokens: 3000,
                temperature: 0.3,
              },
            }),
          });

          if (!geminiRes.ok || !geminiRes.body) {
            throw new Error(`Gemini streaming failed: ${geminiRes.status}`);
          }

          const reader = geminiRes.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let fullNarrative = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data: ")) continue;
              const jsonStr = line.slice(6).trim();
              if (!jsonStr || jsonStr === "[DONE]") continue;

              try {
                const chunk = JSON.parse(jsonStr);
                const text = chunk?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (text) {
                  const processed = ensureVerseLinks(text, verseUrlMap);
                  fullNarrative += processed;
                  send({ type: "narrative_chunk", html: processed });
                }
              } catch {
                // Skip malformed JSON chunks
              }
            }
          }

          const result = { ...metadata, narrative: fullNarrative };
          setCached(query, result);
          send({ type: "done" });
        } catch (streamErr) {
          console.error("Streaming synthesis failed, falling back:", streamErr);
          const narrative = await synthesize(query, verses, prose, verseUrlMap);
          send({ type: "narrative_chunk", html: narrative });

          const result = { ...metadata, narrative };
          setCached(query, result);
          send({ type: "done" });
        }

        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json({ error: "An error occurred." }, { status: 500 });
  }
}