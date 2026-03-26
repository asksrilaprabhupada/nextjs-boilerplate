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
import { getSpeaker } from "@/app/api/generate-article/route";

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

/** Smart truncation — never cuts mid-sentence */
function smartTruncate(text: string, maxLen: number): string {
  if (!text || text.length <= maxLen) return text || "";
  const chunk = text.substring(0, maxLen);
  // Find the last complete sentence — period followed by a space and uppercase or quote
  const sentenceEnd = chunk.search(/\.\s(?=[A-Z"])/g) !== -1
    ? chunk.lastIndexOf(". ") + 1
    : chunk.lastIndexOf(".");
  if (sentenceEnd > maxLen * 0.4) {
    return chunk.substring(0, sentenceEnd + 1).trim();
  }
  // If no good sentence boundary, cut at last space
  const lastSpace = chunk.lastIndexOf(" ");
  if (lastSpace > maxLen * 0.5) {
    return chunk.substring(0, lastSpace).trim() + "...";
  }
  return chunk.trim() + "...";
}

/** Strip "Text " prefix from verse numbers for clean references */
function cleanRef(v: { scripture: string; canto_or_division?: string; chapter_number?: string; verse_number: string }): string {
  const cleanVerseNum = (v.verse_number || "").replace(/^Text\s+/i, "");
  return `${v.scripture} ${v.canto_or_division ? v.canto_or_division + "." : ""}${v.chapter_number}.${cleanVerseNum}`;
}

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
  if (!geminiKey) {
    console.error("[callGemini] GEMINI_API_KEY is not set!");
    return "";
  }
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
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.3 },
        safetySettings: [
          { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
          { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
        ],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error(`[callGemini] HTTP ${res.status}: ${errBody.substring(0, 500)}`);
      return "";
    }
    const data = await res.json();
    if (data?.promptFeedback?.blockReason) {
      console.error("[callGemini] PROMPT BLOCKED:", data.promptFeedback.blockReason);
      return "";
    }
    const candidate = data?.candidates?.[0];
    if (!candidate) {
      console.error("[callGemini] No candidates. Response:", JSON.stringify(data).substring(0, 300));
      return "";
    }
    if (candidate.finishReason === "SAFETY") {
      console.error("[callGemini] SAFETY BLOCKED. Ratings:", JSON.stringify(candidate.safetyRatings));
      return "";
    }
    return candidate?.content?.parts?.[0]?.text || "";
  } catch (err) {
    console.error("[callGemini] Exception:", err);
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
    const ref = cleanRef(v);
    map.set(ref, v.vedabase_url);
    map.set(`[${ref}]`, v.vedabase_url);
  }
  return map;
}

// =====================================================
// SYNTHESIS PROMPT BUILDER
// =====================================================
function buildSynthesisPrompt(question: string, verses: VerseHit[], prose: ProseHit[]): string {
  // Reduce context to avoid overwhelming the model
  const synthVerses = verses.slice(0, 8);
  const synthProse = prose.slice(0, 3);

  let ctx = "";
  const byBook: Record<string, { v: VerseHit[]; p: ProseHit[] }> = {};
  for (const v of synthVerses) { const s = v.book_slug || v.scripture?.toLowerCase() || "x"; if (!byBook[s]) byBook[s] = { v: [], p: [] }; byBook[s].v.push(v); }
  for (const p of synthProse) { if (!byBook[p.book_slug]) byBook[p.book_slug] = { v: [], p: [] }; byBook[p.book_slug].p.push(p); }

  for (const [slug, d] of Object.entries(byBook)) {
    ctx += `\n=== ${getBookName(slug).toUpperCase()} ===\n`;
    for (const v of d.v.slice(0, 10)) {
      const ref = cleanRef(v);
      ctx += `[${ref}] (${v.vedabase_url})\nTranslation: "${v.translation}"\nPurport: "${smartTruncate(v.purport || "", 800)}"\n\n`;
    }
    for (const p of d.p.slice(0, 3)) {
      const bodyText = (p.body_text || "").trim();
      if (bodyText.length < 80) continue;
      ctx += `[${getBookName(p.book_slug)} - ${p.chapter_title}] (${p.vedabase_url})\nText: "${smartTruncate(bodyText, 600)}"\n\n`;
    }
  }

  if (!ctx.trim()) return "";

  return `You are writing a short article answering a devotee's question: "${question}"

Use ONLY the scripture passages provided below. Never invent philosophy.

STRUCTURE YOUR ARTICLE LIKE THIS:
1. Start with a <p> paragraph (2-3 sentences) that restates and frames the actual question "${question}" — explain why this question matters or how it is addressed in Śrīla Prabhupāda's books. Do NOT use generic filler like "The scriptures offer clear guidance."
2. Organize the body by THEME, not just sequentially. Use <h3> headings for each thematic section. Make headings editorial (e.g., "The Rarity of Human Birth", "The Ultimate Goal"), NOT just scripture names.
3. End with a <p> paragraph (2-3 sentences) that ties the key teachings together into one clear takeaway. Summarize what the scriptures collectively teach about the question. Do NOT just say "click the links" or "read on Vedabase."

THEMATIC STRUCTURE: Do NOT just list verses sequentially. Instead, organize by theme or argument flow. For example, if the question is about the goal of human life:
- First group: Why human life is rare and valuable
- Second group: What the actual purpose/goal is
- Third group: How to achieve it

SPEAKER ATTRIBUTION — always name the speaker before a quote:
- BG translations: "Lord Kṛṣṇa tells Arjuna..." or "The Supreme Lord declares..."
- SB translations: Name the speaker — "Śukadeva Gosvāmī narrates...", "Nārada Muni instructs..."
- CC translations: "Lord Caitanya reveals...", "Kṛṣṇadāsa Kavirāja Gosvāmī records..."
- ALL purports: Vary the phrasing — "Śrīla Prabhupāda explains in his purport...", "In his commentary, Śrīla Prabhupāda illuminates...", "His Divine Grace further elaborates...", "Śrīla Prabhupāda writes in the purport...", "The significance is explained by Śrīla Prabhupāda...", "In his purport, His Divine Grace clarifies..."
- Prose books: "In [Book Title], Śrīla Prabhupāda writes..."

CRITICAL: For every verse you quote, you MUST include BOTH:
  a) The translation (in a <div class="verse-quote"> block)
  b) A substantial excerpt from the purport (in a <div class="purport-quote"> block)
The purport is where Śrīla Prabhupāda's actual explanation lives. An article that shows only translations without purports is INCOMPLETE.

FORMAT RULES:
- Your intro, transitions, and conclusion go in <p> tags
- Verse/translation quotes go in <div class="verse-quote">
- Purport quotes go in <div class="purport-quote">
- Prose book quotes go in <div class="prose-quote">
- Every reference MUST be a clickable link: <a href="VEDABASE_URL" class="verse-link" target="_blank"><span class="verse-ref">[REF]</span></a>
- Use diacritical marks: Kṛṣṇa, Prabhupāda, Bhāgavatam, etc.
- Use 5-8 passages total. Do NOT use all of them.
- Output clean HTML only. No markdown. No preamble.

PASSAGES:
${ctx}`;
}

// =====================================================
// NON-STREAMING SYNTHESIS (fallback)
// =====================================================
async function synthesize(question: string, verses: VerseHit[], prose: ProseHit[], verseUrlMap: Map<string, string>) {
  const prompt = buildSynthesisPrompt(question, verses, prose);
  if (!prompt) return "<p>No relevant passages found.</p>";

  try {
    const text = await callGemini(prompt, GEMINI_MODEL_SYNTHESIS, 4500);
    console.log("[Synthesis] Gemini returned", text?.length || 0, "chars");
    if (!text) {
      console.error("[Synthesis] Gemini returned empty — using fallback");
      return buildFB(question, verses, prose);
    }
    return ensureVerseLinks(text, verseUrlMap);
  } catch (err) {
    console.error("[Synthesis] Gemini call failed:", err);
    return buildFB(question, verses, prose);
  }
}

function buildFB(question: string, v: VerseHit[], p: ProseHit[]) {
  if (v.length === 0 && p.length === 0) {
    return "<p>No relevant passages found.</p>";
  }

  const parts: string[] = [];
  const bookNames = [...new Set(v.slice(0, 6).map(x => getBookName(x.book_slug || x.scripture?.toLowerCase() || "")))];

  // Question-aware intro
  const questionText = question.replace(/\?$/, "").toLowerCase();
  parts.push(`<p>The question of ${questionText} is one of the most fundamental inquiries addressed in Śrīla Prabhupāda's books. Across ${bookNames.slice(0, 3).join(", ")}${bookNames.length > 3 ? " and other texts" : ""}, the scriptures and Prabhupāda's purports provide direct and profound guidance.</p>`);

  // Varied transition templates (expanded to 10)
  const transitions = [
    (s: string, l: string) => `${s} states in ${l}:`,
    (s: string, l: string) => `In ${l}, ${s} declares:`,
    (s: string, l: string) => `This is further addressed in ${l}, where ${s} says:`,
    (s: string, l: string) => `${s} instructs in ${l}:`,
    (s: string, l: string) => `Another key teaching appears in ${l}:`,
    (s: string, l: string) => `The instruction continues in ${l}, where ${s} reveals:`,
    (s: string, l: string) => `${s} further illuminates this in ${l}:`,
    (s: string, l: string) => `Drawing from ${l}, ${s} teaches:`,
    (s: string, l: string) => `This truth is echoed in ${l}, where ${s} proclaims:`,
    (s: string, l: string) => `${s} emphasizes in ${l}:`,
  ];

  // Varied purport transition phrases
  const purportTransitions = [
    "Śrīla Prabhupāda explains in his purport:",
    "In his commentary, Śrīla Prabhupāda illuminates this point:",
    "His Divine Grace further elaborates:",
    "Śrīla Prabhupāda writes in the purport:",
    "The significance is explained by Śrīla Prabhupāda:",
    "In his purport, His Divine Grace clarifies:",
  ];

  // Verses: show translation AND purport content
  for (let i = 0; i < Math.min(v.length, 6); i++) {
    const x = v[i];
    const ref = cleanRef(x);
    const url = x.vedabase_url || "#";
    const link = `<a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${ref}]</span></a>`;
    const speaker = getSpeaker(ref, "translation");

    // Transition with speaker attribution
    parts.push(`<p>${transitions[i % transitions.length](speaker, link)}</p>`);

    // ACTUAL translation text
    if (x.translation) {
      parts.push(`<div class="verse-quote">"${x.translation}"</div>`);
    }

    // ACTUAL purport text — this is the heart of the teaching
    if (x.purport && x.purport.length > 10) {
      const excerpt = smartTruncate(x.purport, 600);
      parts.push(`<p>${purportTransitions[i % purportTransitions.length]}</p>`);
      parts.push(`<div class="purport-quote">"${excerpt}"</div>`);
    }
  }

  // Prose: show ACTUAL body_text, skip headings and short content
  for (const x of p.slice(0, 5)) {
    const bodyText = (x.body_text || "").trim();

    // Skip if too short or looks like just a heading
    if (bodyText.length < 80) continue;

    // Skip leading chapter numbers/headings
    let contentStart = 0;
    const headingMatch = bodyText.match(/^(?:[A-Z]{3,}\s|CHAPTER\s|Chapter\s|\d+[\.\s])/);
    if (headingMatch) {
      const firstNewline = bodyText.indexOf("\n");
      const firstPeriod = bodyText.indexOf(". ");
      contentStart = Math.min(
        firstNewline > 0 ? firstNewline + 1 : bodyText.length,
        firstPeriod > 0 ? firstPeriod + 2 : bodyText.length,
      );
    }

    const usableText = bodyText.substring(contentStart).trim();
    if (usableText.length < 50) continue;

    const bookName = getBookName(x.book_slug);
    const url = x.vedabase_url || "#";
    const excerpt = smartTruncate(usableText, 500);

    parts.push(`<p>In <a href="${url}" class="verse-link" target="_blank">${bookName}</a>${x.chapter_title ? " (" + x.chapter_title + ")" : ""}, Śrīla Prabhupāda writes:</p>`);
    parts.push(`<div class="prose-quote">"${excerpt}"</div>`);
  }

  // Conclusion that summarizes the teaching
  const mainTeaching = v.length > 0 && v[0].translation
    ? "As the scriptures emphasize, the human form of life is meant for spiritual realization — not merely material pursuits."
    : "These teachings consistently point toward the supreme goal of developing love of God through devotional service.";
  parts.push(`<p>${mainTeaching} For the complete purports and deeper study of each verse, the full texts are available on Vedabase.io through the reference links above.</p>`);

  return parts.join("\n");
}

// =====================================================
// METADATA + CITATIONS BUILDER
// =====================================================
function buildMetadataAndCitations(query: string, verses: VerseHit[], prose: ProseHit[]) {
  const citations = [
    ...verses.map(v => ({ ref: cleanRef(v), book: getBookName(v.book_slug || ""), url: v.vedabase_url || "", type: "verse" as const, title: v.chapter_title || "" })),
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
  const mode = url.searchParams.get("mode") || "article";

  if (!query) return NextResponse.json({ error: "Query 'q' required" }, { status: 400 });

  const cached = getCached<Record<string, unknown>>(query);
  if (cached) return NextResponse.json(cached);

  try {
    const { verses, prose } = await hybridSearch(query);

    // Top results for AI narrative (the AI only sees these)
    const narrativeVerses = verses.slice(0, 20);
    const narrativeProse = prose.slice(0, 5);

    // Overflow for "dig deeper" modal (everything else)
    const overflowVerses = verses.slice(20);
    const overflowProse = prose.slice(5);

    const verseUrlMap = buildVerseUrlMap(narrativeVerses);
    const metadata = buildMetadataAndCitations(query, narrativeVerses, narrativeProse);

    // Add overflow data to metadata
    const fullMetadata = {
      ...metadata,
      overflowVerses,
      overflowProse,
      totalVerses: verses.length,
      totalProse: prose.length,
    };

    // References mode: skip Gemini synthesis, return metadata with empty narrative
    if (mode === "references") {
      const result = { ...fullMetadata, narrative: "" };
      setCached(query, result);
      return NextResponse.json(result);
    }

    if (!wantStream) {
      const narrative = await synthesize(query, narrativeVerses, narrativeProse, verseUrlMap);
      const result = { ...fullMetadata, narrative };
      setCached(query, result);
      return NextResponse.json(result);
    }

    const prompt = buildSynthesisPrompt(query, narrativeVerses, narrativeProse);
    if (!prompt) {
      const result = { ...fullMetadata, narrative: "<p>No relevant passages found.</p>" };
      return NextResponse.json(result);
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: Record<string, unknown>) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        send({ type: "metadata", ...fullMetadata });

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
                maxOutputTokens: 4500,
                temperature: 0.3,
              },
              safetySettings: [
                { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
              ],
            }),
          });

          if (!geminiRes.ok || !geminiRes.body) {
            console.error("[Streaming] Gemini streaming failed:", geminiRes.status, await geminiRes.text().catch(() => ""));
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

          const result = { ...fullMetadata, narrative: fullNarrative };
          setCached(query, result);
          send({ type: "done" });
        } catch (streamErr) {
          console.error("Streaming synthesis failed, falling back:", streamErr);
          const narrative = await synthesize(query, narrativeVerses, narrativeProse, verseUrlMap);
          send({ type: "narrative_chunk", html: narrative });

          const result = { ...fullMetadata, narrative };
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