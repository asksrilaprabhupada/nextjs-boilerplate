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
import { cohereRerank } from "@/app/lib/08-cohere-rerank";
import { getSpeaker } from "@/app/api/generate-article/route";

const supabaseUrl = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "";
const geminiKey = process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL_SYNTHESIS = "gemini-2.5-flash";

function getSupabase() { return createClient(supabaseUrl, supabaseKey); }

const BOOK_NAMES: Record<string, string> = {
  bg: "Bhagavad-gītā As It Is",
  sb: "Śrīmad-Bhāgavatam",
  cc: "Śrī Caitanya-caritāmṛta",
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
  ejop: "Easy Journey to Other Planets",
  ekc: "Elevation to Kṛṣṇa Consciousness",
  kcty: "Kṛṣṇa Consciousness: The Topmost Yoga System",
  lcfl: "Life Comes From Life",
  mog: "Message of Godhead",
  rtw: "Renunciation Through Wisdom",
  top: "Transcendental Teachings of Prahlāda Mahārāja",
  nbs: "Nārada Bhakti Sūtra",
  mms: "Mukunda-mālā-stotra",
};
function getBookName(slug: string): string { return BOOK_NAMES[slug?.toLowerCase()] || slug || "Unknown"; }

/** Books that exist in our database but NOT on vedabase.io — never create links for these */
const NO_VEDABASE_BOOKS = new Set(["nbs", "mms", "rtw", "lcfl", "kcty", "ekc", "mog", "ejop", "top"]);

/**
 * Returns true if the text is mostly Sanskrit transliteration (not useful as prose content).
 * Detects IAST diacritical characters and Sanskrit verse patterns.
 */
function isMostlySanskrit(text: string): boolean {
  const iastChars = (text.match(/[āīūṛṝḷṃḥṣṭḍṅñśṁ]/g) || []).length;
  const totalChars = text.replace(/\s/g, "").length;
  if (totalChars === 0) return false;

  // If more than 15% of characters are IAST diacriticals, it's likely Sanskrit
  if (iastChars / totalChars > 0.15) return true;

  // Also check for common Sanskrit verse openings
  const sanskritPatterns = [
    /^[""]?śrī-bhagavān uvāca/i,
    /^[""]?[a-zāīūṛṝḷṃḥṣṭḍṅñśṁ\s-]{20,}$/i,
  ];
  return sanskritPatterns.some(p => p.test(text.trim()));
}

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
  if (NO_VEDABASE_BOOKS.has(s)) return "";
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
interface VerseHit { id: string; scripture: string; verse_number: string; sanskrit_devanagari: string; transliteration: string; translation: string; purport: string; chapter_id: string; chapter_number?: string; canto_or_division?: string; chapter_title?: string; book_slug?: string; vedabase_url?: string; tags?: string[]; score?: number; similarity?: number; }
interface ProseHit { id: string; book_slug: string; paragraph_number: number; body_text: string; chapter_id: string; vedabase_url?: string; chapter_title?: string; tags?: string[]; score?: number; similarity?: number; }
interface TranscriptHit { id: string; transcript_id?: string; paragraph_number: number; body_text: string; content_type?: string; title?: string; date?: string; location?: string; occasion?: string; scripture_ref?: string; vedabase_url?: string; tags?: string[]; score?: number; similarity?: number; }
interface LetterHit { id: string; letter_id?: string; paragraph_number: number; body_text: string; content_type?: string; title?: string; date?: string; location?: string; recipient?: string; vedabase_url?: string; tags?: string[]; score?: number; similarity?: number; }
interface ChunkHit { id: string; verse_id: string; scripture: string; chapter_number?: number; verse_number: string; chunk_number: number; body_text: string; tags?: string[]; score?: number; similarity?: number; }

// =====================================================
// RRF (Reciprocal Rank Fusion) SCORING
// =====================================================
const RRF_K = 60;

function rrfMerge<T extends { id: string; similarity?: number }>(
  semanticList: T[],
  ftsList: T[],
  tagList: T[],
): Map<string, T & { score: number; similarity?: number }> {
  const map = new Map<string, T & { score: number; similarity?: number }>();

  semanticList.forEach((v, rank) => {
    const existing = map.get(v.id) || { ...v, score: 0 };
    existing.score += 1 / (RRF_K + rank);
    // Preserve semantic similarity score from the vector search RPC
    if ((v as Record<string, unknown>).similarity != null) {
      existing.similarity = (v as Record<string, unknown>).similarity as number;
    }
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
async function hybridSearchV2(query: string): Promise<{ verses: VerseHit[]; prose: ProseHit[]; transcripts: TranscriptHit[]; letters: LetterHit[]; directVerse?: VerseHit }> {
  const supabase = getSupabase();

  // ── Direct verse lookup for exact references like "BG 18.66", "SB 1.1.1", "NOI verse 1" ──
  let directVerse: VerseHit | undefined;
  const isDirectRef = /^(BG|SB|CC|NOI|ISO|BS|NBS|MMS)\s+/i.test(query.trim());
  if (isDirectRef) {
    try {
      const { data: dvData } = await supabase.rpc("direct_verse_lookup", { ref_query: query.trim() });
      if (dvData && dvData.length > 0) {
        const dv = dvData[0];
        directVerse = {
          id: dv.id,
          scripture: dv.scripture,
          verse_number: dv.verse_number,
          sanskrit_devanagari: dv.sanskrit_devanagari || "",
          transliteration: dv.transliteration || "",
          translation: dv.translation || "",
          purport: dv.purport || "",
          chapter_id: dv.chapter_id,
          chapter_number: String(dv.chapter_number || ""),
          canto_or_division: dv.canto_or_division || "",
          chapter_title: dv.chapter_title || "",
          book_slug: dv.book_slug || dv.scripture?.toLowerCase(),
          vedabase_url: dv.vedabase_url || "",
          tags: dv.tags || [],
          score: 999, // Highest possible score — this is THE verse they asked for
        };
      }
    } catch (err) {
      console.error("[direct_verse_lookup] Error:", err);
    }
  }

  const preprocessed = await preprocessQuery(query);
  const mainPhrase = preprocessed.searchPhrases[0];

  // For long queries with multiple extracted phrases, run additional FTS searches
  const additionalPhrases = preprocessed.searchPhrases.slice(1, 3);
  const additionalFtsPromises = additionalPhrases.flatMap(phrase => [
    supabase.rpc("search_verses_fulltext_v2", { search_query: phrase, match_count: 10 }),
    supabase.rpc("search_prose_fulltext_v2", { search_query: phrase, match_count: 5 }),
    supabase.rpc("search_transcript_paragraphs_fulltext", { search_query: phrase, match_count: 5 }),
    supabase.rpc("search_letter_paragraphs_fulltext", { search_query: phrase, match_count: 3 }),
  ]);

  // WAVE 1: Instant (no embedding needed)
  const ftsVersesPromise = supabase.rpc("search_verses_fulltext_v2", { search_query: mainPhrase, match_count: 25 });
  const ftsProsePromise = supabase.rpc("search_prose_fulltext_v2", { search_query: mainPhrase, match_count: 15 });
  const ftsTranscriptsPromise = supabase.rpc("search_transcript_paragraphs_fulltext", { search_query: mainPhrase, match_count: 10 });
  const ftsLettersPromise = supabase.rpc("search_letter_paragraphs_fulltext", { search_query: mainPhrase, match_count: 8 });
  const ftsChunksPromise = supabase.rpc("search_verse_chunks_fulltext", { search_query: mainPhrase, match_count: 15 });
  const tagVersesPromise = preprocessed.tagTerms.length > 0
    ? supabase.rpc("search_verses_by_tags", { search_terms: preprocessed.tagTerms, match_count: 15 })
    : Promise.resolve({ data: [] as VerseHit[] });
  const tagProsePromise = preprocessed.tagTerms.length > 0
    ? supabase.rpc("search_prose_by_tags", { search_terms: preprocessed.tagTerms, match_count: 10 })
    : Promise.resolve({ data: [] as ProseHit[] });
  const tagTranscriptsPromise = preprocessed.tagTerms.length > 0
    ? supabase.rpc("search_transcript_paragraphs_by_tags", { search_terms: preprocessed.tagTerms, match_count: 8 })
    : Promise.resolve({ data: [] as TranscriptHit[] });
  const tagLettersPromise = preprocessed.tagTerms.length > 0
    ? supabase.rpc("search_letter_paragraphs_by_tags", { search_terms: preprocessed.tagTerms, match_count: 6 })
    : Promise.resolve({ data: [] as LetterHit[] });
  const tagChunksPromise = preprocessed.tagTerms.length > 0
    ? supabase.rpc("search_verse_chunks_by_tags", { search_terms: preprocessed.tagTerms, match_count: 10 })
    : Promise.resolve({ data: [] as ChunkHit[] });

  // WAVE 2: Embedding (parallel with Wave 1)
  const embeddingPromise = embedQuery(preprocessed.isLong ? mainPhrase : query);

  // Wait for all Wave 1 + embedding in parallel
  const [ftsVerses, ftsProse, ftsTranscripts, ftsLetters, ftsChunks, tagVerses, tagProse, tagTranscripts, tagLetters, tagChunks, embedding] = await Promise.all([
    ftsVersesPromise, ftsProsePromise, ftsTranscriptsPromise, ftsLettersPromise, ftsChunksPromise,
    tagVersesPromise, tagProsePromise, tagTranscriptsPromise, tagLettersPromise, tagChunksPromise,
    embeddingPromise,
  ]);

  // When embedding is ready, fire semantic search
  let semanticVersesData: VerseHit[] = [];
  let semanticProseData: ProseHit[] = [];
  let semanticTranscriptsData: TranscriptHit[] = [];
  let semanticLettersData: LetterHit[] = [];
  let semanticChunksData: ChunkHit[] = [];

  if (embedding.length === 1536) {
    const vectorStr = `[${embedding.join(",")}]`;
    const [semV, semP, semT, semL, semC] = await Promise.all([
      supabase.rpc("search_verses_semantic_v2", { query_embedding: vectorStr, match_count: 30 }),
      supabase.rpc("search_prose_semantic_v2", { query_embedding: vectorStr, match_count: 20 }),
      supabase.rpc("search_transcript_paragraphs_semantic", { query_embedding: vectorStr, match_count: 15 }),
      supabase.rpc("search_letter_paragraphs_semantic", { query_embedding: vectorStr, match_count: 10 }),
      supabase.rpc("search_verse_chunks_semantic", { query_embedding: vectorStr, match_count: 15 }),
    ]);
    semanticVersesData = semV.data || [];
    semanticProseData = semP.data || [];
    semanticTranscriptsData = semT.data || [];
    semanticLettersData = semL.data || [];
    semanticChunksData = semC.data || [];
  }

  // Resolve additional phrase FTS results
  let additionalFtsResults: { data: any[] | null }[] = [];
  if (additionalPhrases.length > 0) {
    additionalFtsResults = await Promise.all(additionalFtsPromises);
  }

  // Merge additional phrase FTS results into main FTS arrays before RRF
  if (additionalFtsResults.length > 0) {
    for (let p = 0; p < additionalPhrases.length; p++) {
      const base = p * 4;
      const extraVerses = additionalFtsResults[base]?.data || [];
      const extraProse = additionalFtsResults[base + 1]?.data || [];
      const extraTranscripts = additionalFtsResults[base + 2]?.data || [];
      const extraLetters = additionalFtsResults[base + 3]?.data || [];

      if (ftsVerses.data) ftsVerses.data.push(...extraVerses);
      else ftsVerses.data = extraVerses;
      if (ftsProse.data) ftsProse.data.push(...extraProse);
      else ftsProse.data = extraProse;
      if (ftsTranscripts.data) ftsTranscripts.data.push(...extraTranscripts);
      else ftsTranscripts.data = extraTranscripts;
      if (ftsLetters.data) ftsLetters.data.push(...extraLetters);
      else ftsLetters.data = extraLetters;
    }
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
  const transcriptMap = rrfMerge<TranscriptHit>(
    semanticTranscriptsData,
    ftsTranscripts.data || [],
    tagTranscripts.data || [],
  );
  const letterMap = rrfMerge<LetterHit>(
    semanticLettersData,
    ftsLetters.data || [],
    tagLetters.data || [],
  );

  // RRF merge chunks
  const chunkMap = rrfMerge<ChunkHit>(
    semanticChunksData,
    ftsChunks.data || [],
    tagChunks.data || [],
  );

  // Boost parent verses found via chunks — surfaces content buried deep in long purports
  for (const chunk of chunkMap.values()) {
    if (!chunk.verse_id) continue;
    const existingVerse = verseMap.get(chunk.verse_id);
    if (existingVerse) {
      // Verse already found by direct search — give it a chunk boost
      existingVerse.score += chunk.score * 0.3;
    }
  }

  const allVerses = [...verseMap.values()].sort((a, b) => b.score - a.score);
  const allProse = [...proseMap.values()].sort((a, b) => b.score - a.score);
  const allTranscripts = [...transcriptMap.values()].sort((a, b) => b.score - a.score);
  const allLetters = [...letterMap.values()].sort((a, b) => b.score - a.score);

  // If we found a direct verse match, inject it at position #1 (deduplicate if already present)
  if (directVerse) {
    const existingIdx = allVerses.findIndex(v => v.id === directVerse!.id);
    if (existingIdx >= 0) {
      allVerses.splice(existingIdx, 1);
    }
    allVerses.unshift(directVerse as VerseHit & { score: number; similarity?: number });
  }

  return { verses: allVerses, prose: allProse, transcripts: allTranscripts, letters: allLetters, directVerse };
}

// =====================================================
// HYBRID SEARCH: V2 with fallback to legacy V1
// =====================================================
async function hybridSearch(query: string): Promise<{ verses: VerseHit[]; prose: ProseHit[]; transcripts: TranscriptHit[]; letters: LetterHit[]; directVerse?: VerseHit }> {
  try {
    return await hybridSearchV2(query);
  } catch (err) {
    console.error("V2 search failed, falling back to v1:", err);
    const raw = await fullTextSearch(query);
    const enriched = await legacyEnrich(raw.verses, raw.prose);
    return { ...enriched, transcripts: [], letters: [] };
  }
}

// =====================================================
// TAG-BASED RELEVANCE SCORING
// =====================================================

/**
 * Scores how relevant a result is to the query using its tags.
 *
 * Tags contain three types of data:
 *   - Topics: "anger", "detachment", "devotional service" (general keywords)
 *   - Questions: "How to overcome anger?" (questions this verse answers)
 *   - Summary: "SUMMARY: This verse teaches that anger arises from lust" (1-2 line summary)
 *
 * Returns a score from 0.0 to 1.0 where:
 *   0.0 = no tag overlap with query (likely irrelevant)
 *   0.5 = moderate overlap (tangentially related)
 *   1.0 = strong overlap (directly answers the query)
 */
function scoreTagRelevance(query: string, tags: string[] | null | undefined): number {
  if (!tags || tags.length === 0) return 0.25; // No tags = neutral, don't hard-exclude

  const queryLower = query.toLowerCase().replace(/[?!.,;:'"]/g, "");
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

  const stopWords = new Set([
    "the", "and", "for", "that", "this", "with", "from", "how", "what",
    "why", "when", "where", "who", "does", "did", "was", "are", "has",
    "have", "about", "which", "their", "they", "been", "being", "will",
    "would", "could", "should", "into", "also", "very", "just", "can",
    "srila", "prabhupada", "prabhupāda", "said", "say", "says",
  ]);
  const queryKeywords = queryWords.filter(w => !stopWords.has(w));

  if (queryKeywords.length === 0) return 0.25;

  let summaryScore = 0;
  let questionScore = 0;
  let topicScore = 0;
  let topicCount = 0;

  for (const tag of tags) {
    const tagLower = tag.toLowerCase();

    // ── SUMMARY tags (highest signal) ──
    if (tagLower.startsWith("summary:")) {
      const summary = tagLower.substring(8).trim();
      const summaryWords = summary.split(/\s+/).filter(w => w.length > 2);
      const matches = queryKeywords.filter(qw =>
        summaryWords.some(sw => sw.includes(qw) || qw.includes(sw))
      ).length;
      summaryScore = matches / queryKeywords.length;
      continue;
    }

    // ── QUESTION tags (high signal — direct intent match) ──
    if (tagLower.includes("?")) {
      const questionWords = tagLower.replace(/[?!.,]/g, "").split(/\s+/).filter(w => w.length > 2 && !stopWords.has(w));
      const matches = queryKeywords.filter(qw =>
        questionWords.some(qfw => qfw.includes(qw) || qw.includes(qfw))
      ).length;
      const qScore = matches / Math.max(queryKeywords.length, 1);
      questionScore = Math.max(questionScore, qScore);
      continue;
    }

    // ── Topic tags (moderate signal) ──
    topicCount++;
    const tagWords = tagLower.split(/\s+/).filter(w => w.length > 2);
    const hasOverlap = queryKeywords.some(qw =>
      tagWords.some(tw => tw.includes(qw) || qw.includes(tw))
    ) || queryKeywords.some(qw => tagLower.includes(qw));

    if (hasOverlap) topicScore += 1;
  }

  const normalizedTopicScore = topicCount > 0 ? Math.min(topicScore / Math.max(queryKeywords.length * 0.5, 1), 1) : 0;

  // Weighted combination: summary > question > topic
  const finalScore = (
    summaryScore * 0.45 +
    questionScore * 0.35 +
    normalizedTopicScore * 0.20
  );

  return Math.min(Math.max(finalScore, 0), 1);
}

/**
 * Checks if a verse/prose result is garbage and should be excluded.
 * Returns true if the result should be REMOVED.
 */
function isGarbageResult(
  item: { translation?: string; body_text?: string; purport?: string; tags?: string[] },
  type: "verse" | "prose"
): boolean {
  if (type === "prose") {
    const text = (item.body_text || "").trim();

    // Too short to be useful
    if (text.length < 50) return true;

    // Just a chapter/section heading
    if (/^(TEXT\s|CHAPTER\s|Chapter\s|\d+\s*$)/i.test(text)) return true;
    if (/^[A-Z\s]{3,30}$/.test(text.trim())) return true;

    // Just someone's question (not Prabhupāda's teaching)
    if (/^[""\u201C]?[A-Z][^.]{5,80}\?\s*[""\u201D]?\s*$/.test(text)) return true;
    if (/^(Bob|Śyāmasundara|Lieutenant|Mr\.|Mrs\.|Boy|Girl|Student|Reporter|Question):/i.test(text)) return true;

    // Mostly Sanskrit transliteration (not English content)
    const iastChars = (text.match(/[āīūṛṝḷṃḥṣṭḍṅñśṁ]/g) || []).length;
    const totalChars = text.replace(/\s/g, "").length;
    if (totalChars > 0 && iastChars / totalChars > 0.15) return true;

    return false;
  }

  // For verses: very rarely garbage, but check for empty translation
  if (type === "verse") {
    if (!item.translation && !item.purport) return true;
    if ((item.translation || "").trim().length < 10) return true;
  }

  return false;
}

/**
 * Multi-signal relevance ranker for the Explore section.
 *
 * Combines:
 *   1. RRF score (from initial search merge)
 *   2. Tag relevance score (how well tags match the query)
 *   3. Embedding similarity (semantic closeness to query)
 *
 * Then filters out garbage and low-relevance results.
 */
function rankAndFilterOverflow(
  query: string,
  verses: VerseHit[],
  prose: ProseHit[],
): { verses: VerseHit[]; prose: ProseHit[]; totalFiltered: number } {

  // ── Score and filter verses ──
  const scoredVerses = verses
    .filter(v => !isGarbageResult(v, "verse"))
    .map(v => {
      const tagScore = scoreTagRelevance(query, v.tags);
      const semanticScore = v.similarity || 0;
      const rrfScore = v.score || 0;

      const combinedScore = (
        rrfScore * 0.30 +
        tagScore * 0.45 +
        semanticScore * 0.25
      );

      return { ...v, _combinedScore: combinedScore, _tagScore: tagScore };
    })
    .filter(v => v._tagScore >= 0.08)
    .sort((a, b) => b._combinedScore - a._combinedScore);

  // ── Score and filter prose ──
  const scoredProse = prose
    .filter(p => !isGarbageResult(p, "prose"))
    .map(p => {
      const tagScore = scoreTagRelevance(query, p.tags);
      const semanticScore = p.similarity || 0;
      const rrfScore = p.score || 0;

      const combinedScore = (
        rrfScore * 0.30 +
        tagScore * 0.45 +
        semanticScore * 0.25
      );

      return { ...p, _combinedScore: combinedScore, _tagScore: tagScore };
    })
    .filter(p => p._tagScore >= 0.08)
    .sort((a, b) => b._combinedScore - a._combinedScore);

  const totalOriginal = verses.length + prose.length;
  const totalAfterFilter = scoredVerses.length + scoredProse.length;

  return {
    verses: scoredVerses,
    prose: scoredProse,
    totalFiltered: totalOriginal - totalAfterFilter,
  };
}

/**
 * Re-rank all results by combining RRF score with tag relevance.
 * Used to improve both article (top 20) and overflow ordering.
 */
function reRankResults<T extends { score?: number; tags?: string[]; similarity?: number }>(
  items: T[],
  query: string,
  minRelevance: number,
  minCount: number,
): T[] {
  const scored = items.map(item => ({
    ...item,
    _relevanceScore: scoreTagRelevance(query, item.tags),
  }));

  // Sort by combined RRF score + tag relevance + semantic similarity
  scored.sort((a, b) => {
    const aTotal = (a.score || 0) + a._relevanceScore * 0.4 + (a.similarity || 0) * 0.25;
    const bTotal = (b.score || 0) + b._relevanceScore * 0.4 + (b.similarity || 0) * 0.25;
    return bTotal - aTotal;
  });

  // Filter out very low relevance results
  const relevant = scored.filter(item => item._relevanceScore >= minRelevance);

  // Fall back to unfiltered if too few survive
  return (relevant.length >= minCount ? relevant : scored);
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
// INSTRUCTIONAL LANGUAGE BOOST (Layer 2)
// =====================================================

/**
 * Detects if a query is asking for practical instruction ("how to", "what should",
 * "what is the way to", etc.) and boosts verses that contain instructional language
 * in their purports.
 */
function applyInstructionalBoost(
  query: string,
  verses: VerseHit[],
): VerseHit[] {
  // Only apply for instructional/practical queries
  const instructionalPatterns = [
    /^how (to|can|should|do|does)/i,
    /^what (should|can|is the way|is the method|is the process)/i,
    /^why (should|do|does|is)/i,
    /\b(overcome|control|conquer|avoid|stop|manage|deal with|free from|get rid of)\b/i,
    /\b(practice|method|process|way to|path to|means of)\b/i,
  ];

  const isInstructional = instructionalPatterns.some(p => p.test(query));
  if (!isInstructional) return verses;

  // Instructional language patterns in purports
  const instructionalPurportPatterns = [
    /\b(one should|one must|we should|we must|it is recommended|the process is|the method is)\b/i,
    /\b(by practicing|by chanting|by engaging|by serving|through devotional|the way to)\b/i,
    /\b(therefore|thus|in this way|the solution|the remedy|the cure)\b/i,
    /\b(is advised|is instructed|is recommended|is prescribed|should be controlled)\b/i,
    /\b(kṛṣṇa consciousness|devotional service|bhakti-yoga|spiritual master)\b/i,
  ];

  // Scripture-type boost: BG, NOI, ISO are primarily instructional.
  const instructionalScriptures = new Set(["BG", "NOI", "ISO", "BS"]);

  return verses.map(v => {
    let boost = 0;

    // Check purport for instructional language
    const purport = (v.purport || "").toLowerCase();
    const matchCount = instructionalPurportPatterns.filter(p => p.test(purport)).length;
    boost += matchCount * 0.02; // Small boost per pattern match

    // Check translation for instructional language
    const translation = (v.translation || "").toLowerCase();
    if (instructionalPurportPatterns.some(p => p.test(translation))) {
      boost += 0.03;
    }

    // Scripture type boost for instructional queries
    const scripture = (v.scripture || "").toUpperCase();
    if (instructionalScriptures.has(scripture)) {
      boost += 0.04;
    }

    // Check if SUMMARY tag contains instructional intent
    const summaryTag = (v.tags || []).find(t => t.startsWith("SUMMARY:"));
    if (summaryTag) {
      const summary = summaryTag.toLowerCase();
      if (/\b(teaches|instructs|explains how|the way|method|process|should|must)\b/.test(summary)) {
        boost += 0.03;
      }
    }

    // Check if question tags match the query's intent (not just keywords)
    const questionTags = (v.tags || []).filter(t => t.includes("?"));
    for (const qt of questionTags) {
      if (/\b(how to|overcome|control|what should)\b/i.test(qt)) {
        boost += 0.04;
        break;
      }
    }

    return { ...v, score: (v.score || 0) + boost };
  }).sort((a, b) => (b.score || 0) - (a.score || 0));
}

// =====================================================
// PASTIME/NARRATIVE DETECTION (Layer 3)
// =====================================================

/**
 * Detects if a verse is primarily a narrative/pastime description rather
 * than a philosophical teaching. Narrative verses describe events:
 * "He became angry", "She said to him", "They went to the forest"
 *
 * Used to demote these for instructional queries while keeping them
 * for narrative queries like "What happened when Dakṣa cursed Śiva?"
 */
function isPastimeNarrative(v: VerseHit): boolean {
  const translation = (v.translation || "").toLowerCase();

  // Narrative action patterns — describing events, not teaching philosophy
  const narrativePatterns = [
    /^(he|she|they|lord|śrī|the lord|caitanya|mahāprabhu|kṛṣṇa|nityānanda)\s+(then|immediately|thereupon|thus|thereafter)?\s*(said|spoke|replied|told|asked|went|came|became|took|gave|saw|heard|left|stood|began|continued)/i,
    /\b(became very angry|became angry|was angry|in anger he|in anger she|angrily said|angry mood)\b/i,
    /^(hearing this|when .+ heard|upon hearing|after hearing)/i,
    /^(at that time|in the meantime|meanwhile|thereafter|then|after this)/i,
    /\b(slapped|kicked|chastised|cursed|struck|beat|hit)\b/i,
  ];

  const isNarrative = narrativePatterns.some(p => p.test(translation));

  // Also check: if the scripture is CC and the translation describes an event
  const isCC = (v.scripture || "").toUpperCase() === "CC";
  const hasDialogueMarkers = /^[""\u201C]/.test((v.translation || "").trim());
  const isShortDialogue = hasDialogueMarkers && (v.translation || "").length < 200;

  // CC dialogue that's just someone speaking in a pastime (not philosophy)
  if (isCC && isShortDialogue && !/(one should|the process|devotional service|kṛṣṇa consciousness|the supreme|absolute truth)/i.test(translation)) {
    return true;
  }

  return isNarrative;
}

// =====================================================
// (Reranking now handled by cohereRerank from app/lib/08-cohere-rerank.ts)
// =====================================================

// =====================================================
// SYNTHESIS PROMPT BUILDER
// =====================================================
function buildSynthesisPrompt(question: string, verses: VerseHit[], prose: ProseHit[], transcripts: TranscriptHit[] = [], letters: LetterHit[] = []): string {
  // Reduce context to avoid overwhelming the model
  const synthVerses = verses.slice(0, 15);
  const synthProse = prose.slice(0, 5);
  const synthTranscripts = transcripts.slice(0, 4);
  const synthLetters = letters.slice(0, 2);

  // Build a unified list of all passages with scores
  interface UnifiedPassage {
    score: number;
    type: 'verse' | 'prose' | 'lecture' | 'letter';
    ref: string;
    url: string;
    tagSummary: string;
    content: string;
  }

  const allPassages: UnifiedPassage[] = [];

  // Add verses
  for (const v of synthVerses) {
    const ref = cleanRef(v);
    const summaryTag = (v.tags || []).find(t => t.startsWith("SUMMARY:"));
    const tagSummary = summaryTag ? summaryTag.replace("SUMMARY:", "").trim() : "";
    const content = `Translation: "${v.translation}"\nPurport: "${smartTruncate(v.purport || "", 800)}"`;
    allPassages.push({
      score: v.score || 0,
      type: 'verse',
      ref: `[${ref}]`,
      url: v.vedabase_url || "",
      tagSummary,
      content,
    });
  }

  // Add prose
  for (const p of synthProse) {
    let bodyText = (p.body_text || "").trim();
    if (bodyText.length < 80) continue;
    const lines = bodyText.split("\n");
    let englishStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!isMostlySanskrit(lines[i]) && lines[i].trim().length > 30) {
        englishStart = i;
        break;
      }
    }
    bodyText = lines.slice(englishStart).join("\n").trim();
    if (isMostlySanskrit(bodyText) || bodyText.length < 50) continue;
    const summaryTag = (p.tags || []).find(t => t.startsWith("SUMMARY:"));
    const tagSummary = summaryTag ? summaryTag.replace("SUMMARY:", "").trim() : "";
    allPassages.push({
      score: p.score || 0,
      type: 'prose',
      ref: `[${getBookName(p.book_slug)} - ${p.chapter_title}]`,
      url: p.vedabase_url || "",
      tagSummary,
      content: `Text: "${smartTruncate(bodyText, 600)}"`,
    });
  }

  // Add transcripts (lectures)
  for (const t of synthTranscripts) {
    let bodyText = (t.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;
    const datePart = t.date ? new Date(t.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
    const locationPart = t.location || "";
    const label = t.title || [datePart, locationPart].filter(Boolean).join(", ") || "Lecture";
    const summaryTag = (t.tags || []).find(tag => tag.startsWith("SUMMARY:"));
    const tagSummary = summaryTag ? summaryTag.replace("SUMMARY:", "").trim() : "";
    allPassages.push({
      score: t.score || 0,
      type: 'lecture',
      ref: `[Lecture: ${label}]`,
      url: t.vedabase_url || "",
      tagSummary,
      content: `Text: "${smartTruncate(bodyText, 600)}"`,
    });
  }

  // Add letters
  for (const l of synthLetters) {
    let bodyText = (l.body_text || "").trim();
    if (bodyText.length < 80) continue;
    const datePart = l.date ? new Date(l.date).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "";
    const recipientPart = l.recipient || "";
    const label = recipientPart ? `Letter to ${recipientPart}` : (l.title || "Letter");
    const summaryTag = (l.tags || []).find(tag => tag.startsWith("SUMMARY:"));
    const tagSummary = summaryTag ? summaryTag.replace("SUMMARY:", "").trim() : "";
    allPassages.push({
      score: l.score || 0,
      type: 'letter',
      ref: `[${label}]`,
      url: l.vedabase_url || "",
      tagSummary,
      content: `Text: "${smartTruncate(bodyText, 600)}"`,
    });
  }

  // Sort ALL passages by score (highest first)
  allPassages.sort((a, b) => b.score - a.score);

  // Build the context string from the unified sorted list
  let ctx = "";
  for (const p of allPassages) {
    ctx += `${p.ref} (${p.url})${p.tagSummary ? "\nAbout: " + p.tagSummary : ""}\nSource type: ${p.type}\n${p.content}\n\n`;
  }

  if (!ctx.trim()) return "";

  // Extract top 3 SUMMARY tags for a unique intro
  const summaryTags: string[] = [];
  const allTagSources = [...verses.slice(0, 5), ...prose.slice(0, 3), ...transcripts.slice(0, 3), ...letters.slice(0, 2)];
  for (const item of allTagSources) {
    const tags = (item as any).tags as string[] | undefined;
    if (tags) {
      const summary = tags.find((t: string) => t.startsWith("SUMMARY:"));
      if (summary) {
        summaryTags.push(summary.replace("SUMMARY:", "").trim());
        if (summaryTags.length >= 3) break;
      }
    }
  }
  const topSummaries = summaryTags.length > 0
    ? summaryTags.map((s, i) => `  Finding ${i + 1}: ${s}`).join('\n')
    : '  (Write a thoughtful intro based on the passages below)';

  return `You are writing a short article answering a devotee's question: "${question}"

Use ONLY the scripture passages provided below. Never invent philosophy.

STRUCTURE YOUR ARTICLE LIKE THIS:
1. Start with a <p> paragraph (2-3 sentences) that is UNIQUE and SPECIFIC to this search. Here are the key findings from the top results to help you write a compelling intro:
${topSummaries}
Use these findings to write a specific intro — mention what the scriptures actually say, which speakers address this topic, or what the core teaching is. NEVER write generic filler like "The scriptures offer clear guidance" or "This is addressed extensively in Prabhupāda's books." Every intro must be different based on the actual content found.
2. Organize the body by THEME, not just sequentially. Use <h3> headings for each thematic section. Make headings editorial (e.g., "The Rarity of Human Birth", "The Ultimate Goal"), NOT just scripture names.
3. End with a <p> paragraph (2-3 sentences) that specifically summarizes what the scriptures teach about the question asked: "${question}". DO NOT use a generic conclusion about "the human form of life" — the conclusion must directly relate to the topic discussed in the article. End with a brief mention that full purports are available via Vedabase.io links above.

PRACTICAL TAKEAWAY: If the passages contain specific practical instructions (chant, serve, follow the spiritual master, wake early, etc.), end the article by briefly listing what a devotee should actually DO based on these teachings. Use a short paragraph, not a bullet list. Frame it as: "Based on these teachings, the practical steps are..."

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
- Lectures: "In a lecture on [date] at [location], Śrīla Prabhupāda said...", "Speaking at [location], Śrīla Prabhupāda explained...", "During a lecture on [scripture_ref], Prabhupāda remarked..."
- Letters: "In a letter to [recipient] on [date], Śrīla Prabhupāda wrote...", "Writing to [recipient], His Divine Grace advised..."

CRITICAL: For every verse you quote, you MUST include BOTH:
  a) The translation (in a <div class="verse-quote"> block)
  b) A substantial excerpt from the purport (in a <div class="purport-quote"> block)
The purport is where Śrīla Prabhupāda's actual explanation lives. An article that shows only translations without purports is INCOMPLETE.

FORMAT RULES:
- Your intro, transitions, and conclusion go in <p> tags
- Verse/translation quotes go in <div class="verse-quote">
- Purport quotes go in <div class="purport-quote"> — ALWAYS end the purport block with the same clickable reference link as the verse: <a href="VEDABASE_URL" class="verse-link" target="_blank"><span class="verse-ref">[REF]</span></a>
- Prose book quotes go in <div class="prose-quote"> — end with the book name as a styled reference if a Vedabase link exists
- Lecture quotes go in <div class="lecture-quote"> — end with a clickable reference link to the lecture on Vedabase
- Letter quotes go in <div class="letter-quote"> — end with a clickable reference link to the letter on Vedabase
- Every quote block MUST end with a citation INSIDE the div, right-aligned. Use this exact format:
  <div class="cite-ref"><a href="VEDABASE_URL" class="verse-link" target="_blank"><span class="verse-ref">[REF]</span></a></div>
- For verse translations: citation is [BG 6.34] or [SB 1.2.6] etc.
- For purport quotes: citation is the SAME reference as the verse — [BG 6.34]. The purport is on the same Vedabase page.
- For prose book quotes: citation is [Book Title]. If no Vedabase URL, use <span class="verse-label">[Book Title]</span> instead of a link.
- For lecture quotes: citation is [Lecture · YEAR · CITY] — only the year, not the full date. Only the city name, not the full address. Example: [Lecture · 1973 · Stockholm]
- For letter quotes: citation is [Letter to RECIPIENT · YEAR] — only the year. Example: [Letter to Hamsaduta · 1972]
- If the VEDABASE_URL is empty or missing, render as: <div class="cite-ref"><span class="verse-label">[REF]</span></div>
- Do NOT put citations in the transition/context paragraphs. Citations go ONLY inside quote block divs.
- EXCEPTION: If the VEDABASE_URL is empty or missing, do NOT create a link. Instead render the reference as: <span class="verse-label">[REF]</span> — this applies to books not available on Vedabase.io (Nārada Bhakti Sūtra, Mukunda-mālā-stotra, Renunciation Through Wisdom, Life Comes From Life, Kṛṣṇa Consciousness: The Topmost Yoga System, Elevation to Kṛṣṇa Consciousness, Message of Godhead, Easy Journey to Other Planets, Transcendental Teachings of Prahlāda Mahārāja).
- Use diacritical marks: Kṛṣṇa, Prabhupāda, Bhāgavatam, etc.
- Use 10-15 of the MOST relevant passages. Organize them into 3-4 thematic sections. Quality over quantity — a focused article with the strongest passages is better than a long one with weaker filler.
- Each section should have an <h3> heading and 2-3 sentences of context, then the passages.
- Do NOT skip passages unless they are clearly duplicates or completely irrelevant to the question.
- You may quote from the same book multiple times if the passages address different aspects of the question.
- Group related passages together under thematic headings rather than listing them by book.
- Output clean HTML only. No markdown. No preamble.

PASSAGES:
${ctx}`;
}

// =====================================================
// NON-STREAMING SYNTHESIS (fallback)
// =====================================================
async function synthesize(question: string, verses: VerseHit[], prose: ProseHit[], verseUrlMap: Map<string, string>, transcripts: TranscriptHit[] = [], letters: LetterHit[] = []) {
  const prompt = buildSynthesisPrompt(question, verses, prose, transcripts, letters);
  if (!prompt) return "<p>No relevant passages found.</p>";

  try {
    const text = await callGemini(prompt, GEMINI_MODEL_SYNTHESIS, 6000);
    console.log("[Synthesis] Gemini returned", text?.length || 0, "chars");
    if (!text) {
      console.error("[Synthesis] Gemini returned empty — using fallback");
      return buildFB(question, verses, prose, transcripts, letters);
    }
    return ensureVerseLinks(text, verseUrlMap);
  } catch (err) {
    console.error("[Synthesis] Gemini call failed:", err);
    return buildFB(question, verses, prose, transcripts, letters);
  }
}

/** Group verses by their primary topic tag for thematic sections */
function groupByTheme(verses: VerseHit[]): Map<string, VerseHit[]> {
  const groups = new Map<string, VerseHit[]>();

  for (const v of verses) {
    const topics = (v.tags || []).filter(t =>
      !t.startsWith("SUMMARY:") &&
      !t.includes("?") &&
      t.length > 2 &&
      t.length < 40 &&
      /^[a-zA-Z\s]+$/.test(t)
    );

    const theme = topics[0] || "General";
    if (!groups.has(theme)) groups.set(theme, []);
    groups.get(theme)!.push(v);
  }

  return groups;
}

// =====================================================
// TEMPLATE ARTICLE BUILDER (Strategy A — zero AI calls)
// =====================================================

/**
 * Groups passages into thematic sections using their topic tags.
 * Returns a Map of heading → items, where heading is a clean human-readable title.
 */
function groupIntoThemes(
  items: Array<{ type: 'verse' | 'prose' | 'lecture' | 'letter'; data: VerseHit | ProseHit | TranscriptHit | LetterHit; score: number }>,
): Map<string, typeof items> {
  const groups = new Map<string, typeof items>();
  const assigned = new Set<number>();

  // Pass 1: Group by the FIRST topic tag (most specific)
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const tags = (item.data as any).tags as string[] | undefined;
    if (!tags) continue;

    const topicTags = tags.filter(t =>
      !t.startsWith("SUMMARY:") &&
      !t.includes("?") &&
      t.length > 2 &&
      t.length < 50
    );

    if (topicTags.length === 0) continue;

    // Use the first topic tag as the group key
    const rawKey = topicTags[0].toLowerCase().trim();

    if (!groups.has(rawKey)) groups.set(rawKey, []);
    groups.get(rawKey)!.push(item);
    assigned.add(i);
  }

  // Pass 2: Put unassigned items into "Additional Teachings"
  for (let i = 0; i < items.length; i++) {
    if (assigned.has(i)) continue;
    const key = "additional teachings";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(items[i]);
  }

  // Merge small groups (1 item) into the nearest larger group or "Additional Teachings"
  const merged = new Map<string, typeof items>();
  const smallItems: typeof items = [];
  for (const [key, group] of groups) {
    if (group.length >= 2) {
      merged.set(key, group);
    } else {
      smallItems.push(...group);
    }
  }
  if (smallItems.length > 0) {
    const key = merged.size > 0 ? "further insights" : "teachings";
    merged.set(key, smallItems);
  }

  return merged;
}

/**
 * Converts a raw tag key like "mind control difficulty" into a readable heading
 * like "The Difficulty of Controlling the Mind".
 */
function tagToHeading(tag: string): string {
  // Common heading transformations
  const transforms: Record<string, string> = {
    "mind control": "Controlling the Mind",
    "mind control difficulty": "The Formidable Nature of the Mind",
    "restless mind": "The Restless Nature of the Mind",
    "devotional service": "The Path of Devotional Service",
    "controlling senses": "Controlling the Senses",
    "sense control": "Mastering the Senses",
    "devotion": "The Power of Devotion",
    "anger": "Overcoming Anger",
    "lust": "The Enemy of Lust",
    "soul": "The Nature of the Soul",
    "death": "The Moment of Death",
    "reincarnation": "The Cycle of Birth and Death",
    "surrender": "The Path of Surrender",
    "spiritual master": "The Role of the Spiritual Master",
    "chanting": "The Power of Chanting",
    "karma": "Understanding Karma",
    "liberation": "The Goal of Liberation",
    "material nature": "The Modes of Material Nature",
    "further insights": "Further Insights",
    "additional teachings": "Additional Teachings",
    "teachings": "Key Teachings",
  };

  const lower = tag.toLowerCase();
  if (transforms[lower]) return transforms[lower];

  // Default: Title Case the tag
  return tag
    .split(/\s+/)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Builds a complete HTML article from search results using ONLY templates.
 * Zero AI calls. 100% correct citations. Instant.
 */
function buildTemplateArticle(
  question: string,
  verses: VerseHit[],
  prose: ProseHit[],
  transcripts: TranscriptHit[] = [],
  letters: LetterHit[] = [],
): string {
  if (verses.length === 0 && prose.length === 0 && transcripts.length === 0 && letters.length === 0) {
    return "<p>No relevant passages found for this query.</p>";
  }

  const parts: string[] = [];

  // ── Collect ALL items into a unified scored list ──
  interface ArticleItem {
    type: 'verse' | 'prose' | 'lecture' | 'letter';
    data: VerseHit | ProseHit | TranscriptHit | LetterHit;
    score: number;
  }

  const allItems: ArticleItem[] = [];

  for (const v of verses.slice(0, 15)) {
    if (!v.translation && !v.purport) continue;
    if ((v.translation || "").trim().length < 10) continue;
    allItems.push({ type: 'verse', data: v, score: v.score || 0 });
  }

  const seenBookSlugs = new Set<string>();
  for (const p of prose.slice(0, 5)) {
    const bodyText = (p.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;
    if (seenBookSlugs.has(p.book_slug)) continue;
    seenBookSlugs.add(p.book_slug);
    allItems.push({ type: 'prose', data: p, score: p.score || 0 });
  }

  for (const t of transcripts.slice(0, 4)) {
    const bodyText = (t.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;
    allItems.push({ type: 'lecture', data: t, score: t.score || 0 });
  }

  for (const l of letters.slice(0, 2)) {
    const bodyText = (l.body_text || "").trim();
    if (bodyText.length < 80) continue;
    allItems.push({ type: 'letter', data: l, score: l.score || 0 });
  }

  // Sort by score
  allItems.sort((a, b) => b.score - a.score);

  // ── INTRO: Build from SUMMARY tags ──
  const summaries: string[] = [];
  for (const item of allItems.slice(0, 5)) {
    const tags = (item.data as any).tags as string[] | undefined;
    if (!tags) continue;
    const summary = tags.find(t => t.startsWith("SUMMARY:"));
    if (summary) {
      summaries.push(summary.replace("SUMMARY:", "").trim());
      if (summaries.length >= 2) break;
    }
  }

  const articleVerses = verses.slice(0, 15);
  const bookNames = [...new Set(articleVerses.map(x => getBookName(x.book_slug || x.scripture?.toLowerCase() || "")))];
  const bookListStr = bookNames.length === 1
    ? bookNames[0]
    : bookNames.length === 2
      ? `${bookNames[0]} and ${bookNames[1]}`
      : `${bookNames.slice(0, 2).join(", ")}, and ${bookNames.length > 3 ? "other texts" : bookNames[2]}`;

  // Get primary speaker for the first verse
  const firstVerse = verses[0];
  const firstRef = firstVerse ? cleanRef(firstVerse) : "";
  const firstSpeaker = firstVerse ? getSpeaker(firstRef, "translation") : "";

  if (summaries.length >= 2) {
    parts.push(`<p>${summaries[0]} ${summaries[1]} Through ${bookListStr}, Śrīla Prabhupāda provides clear guidance on this subject.</p>`);
  } else if (summaries.length === 1) {
    parts.push(`<p>${summaries[0]} Śrīla Prabhupāda addresses this in ${bookListStr}, offering both scriptural evidence and practical instruction.</p>`);
  } else if (firstSpeaker && firstSpeaker !== "the scripture") {
    const questionTopic = question.replace(/\?$/, "").replace(/^(what|how|why|when|where|who|did|does|is|are|was|were)\s+(is|are|did|does|do|was|were|srila|prabhupada|prabhupāda|say|said|about)?\s*/i, "").trim().toLowerCase() || question.replace(/\?$/, "").toLowerCase();
    parts.push(`<p>${firstSpeaker} directly addresses ${questionTopic} in the scriptures. Through ${bookListStr}, Śrīla Prabhupāda illuminates this teaching with his purports.</p>`);
  } else {
    const questionTopic = question.replace(/\?$/, "").replace(/^(what|how|why|when|where|who|did|does|is|are|was|were)\s+(is|are|did|does|do|was|were|srila|prabhupada|prabhupāda|say|said|about)?\s*/i, "").trim().toLowerCase() || question.replace(/\?$/, "").toLowerCase();
    parts.push(`<p>Śrīla Prabhupāda gives clear guidance on ${questionTopic} through ${bookListStr}. Here is what the scriptures and his teachings reveal.</p>`);
  }

  // ── GROUP INTO THEMED SECTIONS with <h3> headings ──
  const themes = groupIntoThemes(allItems);

  // Transition templates
  const transitions = [
    (s: string, ref: string) => `${s} states (${ref}):`,
    (s: string, ref: string) => `In ${ref}, ${s} declares:`,
    (s: string, ref: string) => `${s} instructs (${ref}):`,
    (s: string, ref: string) => `Drawing from ${ref}, ${s} teaches:`,
    (s: string, ref: string) => `${s} further illuminates this (${ref}):`,
    (s: string, ref: string) => `The instruction continues in ${ref}:`,
    (s: string, ref: string) => `${s} emphasizes (${ref}):`,
    (s: string, ref: string) => `This truth is addressed in ${ref}, where ${s} proclaims:`,
  ];

  const purportTransitions = [
    "Śrīla Prabhupāda explains in his purport:",
    "In his commentary, Śrīla Prabhupāda illuminates this point:",
    "His Divine Grace further elaborates:",
    "Śrīla Prabhupāda writes in the purport:",
    "The significance is explained by Śrīla Prabhupāda:",
    "In his purport, His Divine Grace clarifies:",
  ];

  let transIdx = 0;
  let purportIdx = 0;

  for (const [themeKey, themeItems] of themes) {
    // Emit <h3> heading
    parts.push(`<h3>${tagToHeading(themeKey)}</h3>`);

    for (const item of themeItems) {
      if (item.type === 'verse') {
        const v = item.data as VerseHit;
        const ref = cleanRef(v);
        const url = v.vedabase_url || "";
        const speaker = getSpeaker(ref, "translation");

        const cite = url
          ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${ref}]</span></a></div>`
          : `<div class="cite-ref"><span class="verse-label">[${ref}]</span></div>`;

        // Transition
        parts.push(`<p>${transitions[transIdx % transitions.length](speaker, ref)}</p>`);
        transIdx++;

        // Translation
        if (v.translation) {
          parts.push(`<div class="verse-quote">"${v.translation}"${cite}</div>`);
        }

        // Purport (substantial excerpt only)
        if (v.purport && v.purport.length > 50) {
          const excerpt = smartTruncate(v.purport, 600);
          parts.push(`<p>${purportTransitions[purportIdx % purportTransitions.length]}</p>`);
          purportIdx++;
          parts.push(`<div class="purport-quote">"${excerpt}"${cite}</div>`);
        }

      } else if (item.type === 'prose') {
        const p = item.data as ProseHit;
        let bodyText = (p.body_text || "").trim();
        if (bodyText.length < 80) continue;

        // Skip Sanskrit lines at the beginning
        const lines = bodyText.split("\n");
        let englishStart = 0;
        for (let i = 0; i < lines.length; i++) {
          if (!isMostlySanskrit(lines[i]) && lines[i].trim().length > 30) {
            englishStart = i;
            break;
          }
        }
        bodyText = lines.slice(englishStart).join("\n").trim();
        if (isMostlySanskrit(bodyText) || bodyText.length < 50) continue;

        const bookName = getBookName(p.book_slug);
        const url = p.vedabase_url || "";
        const excerpt = smartTruncate(bodyText, 500);
        const noVedabase = NO_VEDABASE_BOOKS.has(p.book_slug?.toLowerCase());

        const cite = (!noVedabase && url)
          ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${bookName}]</span></a></div>`
          : `<div class="cite-ref"><span class="verse-label">[${bookName}]</span></div>`;

        parts.push(`<p>In ${bookName}${p.chapter_title ? " (" + p.chapter_title + ")" : ""}, Śrīla Prabhupāda writes:</p>`);
        parts.push(`<div class="prose-quote">"${excerpt}"${cite}</div>`);

      } else if (item.type === 'lecture') {
        const t = item.data as TranscriptHit;
        const bodyText = (t.body_text || "").trim();
        if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;

        const year = t.date ? new Date(t.date).getFullYear().toString() : "";
        const city = t.location || "";
        const url = t.vedabase_url || "";
        const excerpt = smartTruncate(bodyText, 500);

        let attribution = "In a lecture";
        if (city && year) attribution = `Speaking in ${city} (${year})`;
        else if (city) attribution = `Speaking in ${city}`;
        else if (year) attribution = `In a lecture (${year})`;

        const citeLabel = ["Lecture", year, city].filter(Boolean).join(" · ");
        const cite = url
          ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${citeLabel}]</span></a></div>`
          : `<div class="cite-ref"><span class="verse-label">[${citeLabel}]</span></div>`;

        parts.push(`<p>${attribution}, Śrīla Prabhupāda said:</p>`);
        parts.push(`<div class="lecture-quote">"${excerpt}"${cite}</div>`);

      } else if (item.type === 'letter') {
        const l = item.data as LetterHit;
        const bodyText = (l.body_text || "").trim();
        if (bodyText.length < 80) continue;

        const year = l.date ? new Date(l.date).getFullYear().toString() : "";
        const recipientPart = l.recipient || "";
        const url = l.vedabase_url || "";
        const excerpt = smartTruncate(bodyText, 500);

        let attribution = "In a letter";
        if (recipientPart && year) attribution = `Writing to ${recipientPart} (${year})`;
        else if (recipientPart) attribution = `Writing to ${recipientPart}`;
        else if (year) attribution = `In a letter (${year})`;

        const citeParts = ["Letter"];
        if (recipientPart) citeParts.push(`to ${recipientPart}`);
        if (year) citeParts.push(year);
        const citeLabel = citeParts.join(" · ");
        const cite = url
          ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${citeLabel}]</span></a></div>`
          : `<div class="cite-ref"><span class="verse-label">[${citeLabel}]</span></div>`;

        parts.push(`<p>${attribution}, Śrīla Prabhupāda wrote:</p>`);
        parts.push(`<div class="letter-quote">"${excerpt}"${cite}</div>`);
      }
    }
  }

  // ── CONCLUSION ──
  const questionTopic = question
    .replace(/\?$/, "")
    .replace(/^(what|how|why|when|where|who|did|does|is|are|was|were)\s+(is|are|did|does|do|was|were|srila|prabhupada|prabhupāda|say|said|about)?\s*/i, "")
    .replace(/^(srila\s+)?(prabhupada|prabhupāda)\s+(say|said|says|teach|teaches|explain|explains)\s+(about\s+)?/i, "")
    .trim()
    .toLowerCase() || question.replace(/\?$/, "").toLowerCase();

  if (summaries.length > 0) {
    parts.push(`<p>Through these passages from ${bookListStr}, Śrīla Prabhupāda's teaching on ${questionTopic} is clear and consistent. Full purports with complete context are available through the Vedabase.io links above.</p>`);
  } else {
    parts.push(`<p>These teachings from ${bookListStr} offer Śrīla Prabhupāda's direct guidance on ${questionTopic}. Full purports are available through the Vedabase.io links above.</p>`);
  }

  return parts.join("\n");
}

function buildFB(question: string, v: VerseHit[], p: ProseHit[], t: TranscriptHit[] = [], l: LetterHit[] = []) {
  if (v.length === 0 && p.length === 0 && t.length === 0 && l.length === 0) {
    return "<p>No relevant passages found.</p>";
  }

  const parts: string[] = [];
  const articleVerses = v.slice(0, 15);
  const bookNames = [...new Set(articleVerses.map(x => getBookName(x.book_slug || x.scripture?.toLowerCase() || "")))];

  // Extract the core topic from the question for intro/conclusion
  const questionTopic = question
    .replace(/\?$/, "")
    .replace(/^(what|how|why|when|where|who|did|does|is|are|was|were)\s+(is|are|did|does|do|was|were|srila|prabhupada|prabhupāda|say|said|about)?\s*/i, "")
    .replace(/^(srila\s+)?(prabhupada|prabhupāda)\s+(say|said|says|teach|teaches|explain|explains)\s+(about\s+)?/i, "")
    .trim()
    .toLowerCase() || question.replace(/\?$/, "").toLowerCase();

  // Grammatically correct book list
  const bookListStr = bookNames.length === 1
    ? bookNames[0]
    : bookNames.length === 2
      ? `${bookNames[0]} and ${bookNames[1]}`
      : `${bookNames.slice(0, 2).join(", ")}, and ${bookNames.length > 3 ? "other texts" : bookNames[2]}`;

  // Extract summaries from top results for a unique intro
  const introSummaries: string[] = [];
  for (const item of [...v.slice(0, 3), ...p.slice(0, 2), ...t.slice(0, 2), ...l.slice(0, 1)]) {
    const tags = (item as any).tags as string[] | undefined;
    if (tags) {
      const summary = tags.find((tag: string) => tag.startsWith("SUMMARY:"));
      if (summary) {
        introSummaries.push(summary.replace("SUMMARY:", "").trim());
        if (introSummaries.length >= 2) break;
      }
    }
  }

  // Content-aware intro templates
  if (introSummaries.length >= 2) {
    parts.push(`<p>${introSummaries[0]}. ${introSummaries[1]}. Through ${bookListStr}, Śrīla Prabhupāda provides profound guidance on this subject.</p>`);
  } else if (introSummaries.length === 1) {
    parts.push(`<p>${introSummaries[0]}. Śrīla Prabhupāda addresses this topic through ${bookListStr}, offering both scriptural evidence and practical instruction.</p>`);
  } else {
    // No summaries available — use a question-aware intro
    const isWho = /^who\b/i.test(question);
    const isWhat = /^what\b/i.test(question);
    const isHow = /^how\b/i.test(question);
    const isWhy = /^why\b/i.test(question);

    if (isHow) {
      parts.push(`<p>Śrīla Prabhupāda gives clear practical guidance on ${questionTopic}. Drawing from ${bookListStr}, here are the specific instructions from the scriptures and his own teachings.</p>`);
    } else if (isWhy) {
      parts.push(`<p>The deeper reason behind ${questionTopic} is revealed through the scriptures. In ${bookListStr}, Śrīla Prabhupāda explains the spiritual significance with great clarity.</p>`);
    } else if (isWho) {
      parts.push(`<p>The identity and role of ${questionTopic} is described vividly in the scriptures. Through ${bookListStr}, Śrīla Prabhupāda illuminates this subject.</p>`);
    } else if (isWhat) {
      parts.push(`<p>Understanding ${questionTopic} requires scriptural knowledge. In ${bookListStr}, Śrīla Prabhupāda reveals what the Vedic literature teaches about this important subject.</p>`);
    } else {
      parts.push(`<p>Śrīla Prabhupāda addresses ${questionTopic} in ${bookListStr}. Here is what the scriptures and his teachings reveal on this subject.</p>`);
    }
  }

  // Varied transition templates (expanded to 10)
  const transitions = [
    (s: string, ref: string) => `${s} states (${ref}):`,
    (s: string, ref: string) => `In ${ref}, ${s} declares:`,
    (s: string, ref: string) => `This is further addressed in ${ref}, where ${s} says:`,
    (s: string, ref: string) => `${s} instructs (${ref}):`,
    (s: string, ref: string) => `Another key teaching appears in ${ref}:`,
    (s: string, ref: string) => `The instruction continues in ${ref}, where ${s} reveals:`,
    (s: string, ref: string) => `${s} further illuminates this (${ref}):`,
    (s: string, ref: string) => `Drawing from ${ref}, ${s} teaches:`,
    (s: string, ref: string) => `This truth is echoed in ${ref}, where ${s} proclaims:`,
    (s: string, ref: string) => `${s} emphasizes (${ref}):`,
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

  /** Render a single verse with transition, translation, and purport */
  const renderSingleVerse = (idx: number, x: VerseHit) => {
    const ref = cleanRef(x);
    const url = x.vedabase_url || "";
    const cite = url
      ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${ref}]</span></a></div>`
      : `<div class="cite-ref"><span class="verse-label">[${ref}]</span></div>`;
    const speaker = getSpeaker(ref, "translation");

    // Transition sentence (NO citation here — citation goes inside quote blocks)
    parts.push(`<p>${transitions[idx % transitions.length](speaker, ref)}</p>`);

    // Translation with citation at end
    if (x.translation) {
      parts.push(`<div class="verse-quote">"${x.translation}"${cite}</div>`);
    }

    // Purport with same citation at end
    if (x.purport && x.purport.length > 10) {
      const excerpt = smartTruncate(x.purport, 600);
      parts.push(`<p>${purportTransitions[idx % purportTransitions.length]}</p>`);
      parts.push(`<div class="purport-quote">"${excerpt}"${cite}</div>`);
    }
  };

  /** Render a single prose passage */
  const renderSingleProse = (x: ProseHit) => {
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80) return false;

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

    let usableText = bodyText.substring(contentStart).trim();
    const lines = usableText.split("\n");
    let englishStart = 0;
    for (let i = 0; i < lines.length; i++) {
      if (!isMostlySanskrit(lines[i]) && lines[i].trim().length > 30) {
        englishStart = i;
        break;
      }
    }
    usableText = lines.slice(englishStart).join("\n").trim();
    if (isMostlySanskrit(usableText) || usableText.length < 50) return false;

    const bookName = getBookName(x.book_slug);
    const url = x.vedabase_url || "";
    const excerpt = smartTruncate(usableText, 500);

    const cite = url
      ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${bookName}]</span></a></div>`
      : `<div class="cite-ref"><span class="verse-label">[${bookName}]</span></div>`;

    parts.push(`<p>In ${bookName}${x.chapter_title ? " (" + x.chapter_title + ")" : ""}, Śrīla Prabhupāda writes:</p>`);
    parts.push(`<div class="prose-quote">"${excerpt}"${cite}</div>`);
    return true;
  };

  /** Render a single transcript (lecture) passage */
  const renderSingleTranscript = (x: TranscriptHit) => {
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) return;

    const year = x.date ? new Date(x.date).getFullYear().toString() : "";
    const city = x.location || "";
    const url = x.vedabase_url || "";
    const excerpt = smartTruncate(bodyText, 500);

    // Build short attribution
    let attribution = "In a lecture";
    if (city && year) attribution = `Speaking in ${city} (${year})`;
    else if (city) attribution = `Speaking in ${city}`;
    else if (year) attribution = `In a lecture (${year})`;

    // Build citation: [Lecture · 1973 · Stockholm]
    const citeLabel = ["Lecture", year, city].filter(Boolean).join(" · ");
    const cite = url
      ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${citeLabel}]</span></a></div>`
      : `<div class="cite-ref"><span class="verse-label">[${citeLabel}]</span></div>`;

    parts.push(`<p>${attribution}, Śrīla Prabhupāda said:</p>`);
    parts.push(`<div class="lecture-quote">"${excerpt}"${cite}</div>`);
  };

  /** Render a single letter passage */
  const renderSingleLetter = (x: LetterHit) => {
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80) return;

    const year = x.date ? new Date(x.date).getFullYear().toString() : "";
    const recipientPart = x.recipient || "";
    const url = x.vedabase_url || "";
    const excerpt = smartTruncate(bodyText, 500);

    // Build short attribution
    let attribution = "In a letter";
    if (recipientPart && year) attribution = `Writing to ${recipientPart} (${year})`;
    else if (recipientPart) attribution = `Writing to ${recipientPart}`;
    else if (year) attribution = `In a letter (${year})`;

    // Build citation: [Letter to Name · 1972]
    const citeParts = ["Letter"];
    if (recipientPart) citeParts.push(`to ${recipientPart}`);
    if (year) citeParts.push(year);
    const citeLabel = citeParts.join(" · ");
    const cite = url
      ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${citeLabel}]</span></a></div>`
      : `<div class="cite-ref"><span class="verse-label">[${citeLabel}]</span></div>`;

    parts.push(`<p>${attribution}, Śrīla Prabhupāda wrote:</p>`);
    parts.push(`<div class="letter-quote">"${excerpt}"${cite}</div>`);
  };

  // Build unified list of all items with scores, sort by relevance
  interface FBItem {
    score: number;
    type: 'verse' | 'prose' | 'lecture' | 'letter';
    data: VerseHit | ProseHit | TranscriptHit | LetterHit;
  }

  const allItems: FBItem[] = [];

  for (const x of v.slice(0, 15)) {
    allItems.push({ score: x.score || 0, type: 'verse', data: x });
  }
  const seenBookSlugs = new Set<string>();
  for (const x of p.slice(0, 5)) {
    if (seenBookSlugs.has(x.book_slug)) continue;
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80) continue;
    if (isMostlySanskrit(bodyText) || bodyText.length < 50) continue;
    seenBookSlugs.add(x.book_slug);
    allItems.push({ score: x.score || 0, type: 'prose', data: x });
  }
  for (const x of t.slice(0, 4)) {
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;
    allItems.push({ score: x.score || 0, type: 'lecture', data: x });
  }
  for (const x of l.slice(0, 2)) {
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80) continue;
    allItems.push({ score: x.score || 0, type: 'letter', data: x });
  }

  // Sort all items by score (highest first)
  allItems.sort((a, b) => b.score - a.score);

  // Render each item using the appropriate helper
  let itemIdx = 0;
  for (const item of allItems) {
    switch (item.type) {
      case 'verse':
        renderSingleVerse(itemIdx, item.data as VerseHit);
        break;
      case 'prose':
        renderSingleProse(item.data as ProseHit);
        break;
      case 'lecture':
        renderSingleTranscript(item.data as TranscriptHit);
        break;
      case 'letter':
        renderSingleLetter(item.data as LetterHit);
        break;
    }
    itemIdx++;
  }

  // Content-aware conclusion
  if (introSummaries.length > 0) {
    parts.push(`<p>Through these passages from ${bookListStr}, Śrīla Prabhupāda's teaching on ${questionTopic} is clear and consistent. Full purports with complete context are available through the Vedabase.io links above.</p>`);
  } else {
    parts.push(`<p>These teachings from ${bookListStr} offer Śrīla Prabhupāda's direct guidance on ${questionTopic}. Full purports are available through the Vedabase.io links above.</p>`);
  }

  return parts.join("\n");
}

// =====================================================
// METADATA + CITATIONS BUILDER
// =====================================================
function buildMetadataAndCitations(query: string, verses: VerseHit[], prose: ProseHit[], transcripts: TranscriptHit[] = [], letters: LetterHit[] = []) {
  const citations = [
    ...verses.map(v => ({ ref: cleanRef(v), book: getBookName(v.book_slug || ""), url: v.vedabase_url || "", type: "verse" as const, title: v.chapter_title || "" })),
    ...prose.map(p => ({ ref: `${getBookName(p.book_slug)}`, book: getBookName(p.book_slug), url: p.vedabase_url || "", type: "prose" as const, title: p.chapter_title || "" })),
    ...transcripts.map(t => ({ ref: `Lecture: ${t.title || ""}`, book: "Lectures", url: t.vedabase_url || "", type: "transcript" as const, title: t.title || "" })),
    ...letters.map(l => ({ ref: `Letter to ${l.recipient || ""}`, book: "Letters", url: l.vedabase_url || "", type: "letter" as const, title: l.title || "" })),
  ];

  const books: Record<string, { slug: string; name: string; verses: VerseHit[]; prose: ProseHit[]; transcripts: TranscriptHit[]; letters: LetterHit[] }> = {};
  for (const v of verses) { const s = (v.book_slug || "").toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [], transcripts: [], letters: [] }; books[s].verses.push(v); }
  for (const p of prose) { const s = p.book_slug.toLowerCase(); if (!books[s]) books[s] = { slug: s, name: getBookName(s), verses: [], prose: [], transcripts: [], letters: [] }; books[s].prose.push(p); }
  if (transcripts.length > 0) {
    if (!books["lectures"]) books["lectures"] = { slug: "lectures", name: "Lectures", verses: [], prose: [], transcripts: [], letters: [] };
    books["lectures"].transcripts = transcripts;
  }
  if (letters.length > 0) {
    if (!books["letters"]) books["letters"] = { slug: "letters", name: "Letters", verses: [], prose: [], transcripts: [], letters: [] };
    books["letters"].letters = letters;
  }

  return {
    query,
    totalResults: verses.length + prose.length + transcripts.length + letters.length,
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
    // Fire search and spelling check in parallel
    const spellingSupa = getSupabase();
    const [searchResults, spellResult] = await Promise.all([
      hybridSearch(query),
      spellingSupa.rpc('suggest_spelling', { raw_query: query }).then(res => res, () => ({ data: null })),
    ]);

    const { verses, prose, transcripts, letters } = searchResults;

    // "Did you mean?" — extract spelling suggestion
    let suggestion: string | null = null;
    let suggestionDisplay: string | null = null;
    try {
      const spellData = spellResult.data;
      if (spellData && spellData.length > 0 && spellData[0].suggested_query) {
        const suggested = spellData[0].suggested_query;
        if (suggested.toLowerCase() !== query.toLowerCase()) {
          suggestion = suggested;
          suggestionDisplay = spellData[0].display_query || suggested;
        }
      }
    } catch (e) {
      console.error('[suggest_spelling] Error:', e);
    }

    // Skip re-ranking layers for direct verse lookups (e.g., "BG 2.20")
    const isDirectLookup = /^(BG|SB|CC|NOI|ISO|BS)\s+\d/i.test(query);

    // ── Step 1: Re-rank by tag relevance + semantic similarity ──
    const rankedVerses = reRankResults(verses, query, 0.1, 3);
    const rankedProse = reRankResults(prose, query, 0.1, 2);
    const rankedTranscripts = reRankResults(transcripts, query, 0.1, 2);
    const rankedLetters = reRankResults(letters, query, 0.1, 2);

    let narrativeTranscripts: TranscriptHit[];
    let narrativeLetters: LetterHit[];
    let overflowTranscripts: TranscriptHit[];
    let overflowLetters: LetterHit[];

    let narrativeVerses: VerseHit[];
    let narrativeProse: ProseHit[];
    let rawOverflowVerses: VerseHit[];
    let rawOverflowProse: ProseHit[];

    if (isDirectLookup) {
      // Direct lookup: skip instructional boost, pastime demotion, and LLM re-ranking
      narrativeVerses = rankedVerses.slice(0, 40);
      narrativeProse = rankedProse.slice(0, 12);
      rawOverflowVerses = rankedVerses.slice(40);
      rawOverflowProse = rankedProse.slice(12);
      narrativeTranscripts = rankedTranscripts.slice(0, 8);
      narrativeLetters = rankedLetters.slice(0, 6);
      overflowTranscripts = rankedTranscripts.slice(8);
      overflowLetters = rankedLetters.slice(6);
    } else {
      // ── Step 2: Instructional language boost for "how to" queries ──
      const boostedVerses = applyInstructionalBoost(query, rankedVerses);

      // ── Step 3: Demote pure pastime/narrative verses for philosophical queries ──
      const isPhilosophicalQuery = /^(how|what|why|explain|describe the nature|what is the|what are the)\b/i.test(query);
      const demotedVerses = isPhilosophicalQuery
        ? boostedVerses.map(v => {
            if (isPastimeNarrative(v)) {
              return { ...v, score: (v.score || 0) * 0.5 };
            }
            return v;
          }).sort((a, b) => (b.score || 0) - (a.score || 0))
        : boostedVerses;

      // ── Step 4: Cohere cross-encoder re-ranking ──
      // Skip rerank if top result clearly dominates (saves latency)
      const topScores = demotedVerses.slice(0, 5).map(v => v.score || 0);
      const clearWinner = topScores.length >= 2 && topScores[0] > topScores[1] * 2;

      let rerankedVerses: VerseHit[];
      let rerankedProse: ProseHit[];
      let rerankedTranscripts: TranscriptHit[];
      let rerankedLetters: LetterHit[];

      if (clearWinner) {
        rerankedVerses = demotedVerses.slice(0, 50);
        rerankedProse = rankedProse.slice(0, 15);
        rerankedTranscripts = rankedTranscripts.slice(0, 10);
        rerankedLetters = rankedLetters.slice(0, 8);
      } else {
        const [verseResults, proseResults, transcriptResults, letterResults] = await Promise.all([
          cohereRerank(query, demotedVerses.slice(0, 50), 50),
          cohereRerank(query, rankedProse.slice(0, 15), 15),
          cohereRerank(query, rankedTranscripts.slice(0, 10), 10),
          cohereRerank(query, rankedLetters.slice(0, 8), 8),
        ]);
        rerankedVerses = verseResults.map(r => ({ ...r.item, score: r.relevance_score }));
        rerankedProse = proseResults.map(r => ({ ...r.item, score: r.relevance_score }));
        rerankedTranscripts = transcriptResults.map(r => ({ ...r.item, score: r.relevance_score }));
        rerankedLetters = letterResults.map(r => ({ ...r.item, score: r.relevance_score }));
      }

      // ── Step 5: Slice for narrative and overflow ──
      narrativeVerses = rerankedVerses.slice(0, 40);
      narrativeProse = rerankedProse.slice(0, 12);

      rawOverflowVerses = [
        ...rerankedVerses.slice(40),
        ...demotedVerses.slice(50),
      ];
      rawOverflowProse = [
        ...rerankedProse.slice(12),
        ...rankedProse.slice(15),
      ];

      narrativeTranscripts = rerankedTranscripts.slice(0, 8);
      narrativeLetters = rerankedLetters.slice(0, 6);
      overflowTranscripts = [
        ...rerankedTranscripts.slice(8),
        ...rankedTranscripts.slice(10),
      ];
      overflowLetters = [
        ...rerankedLetters.slice(6),
        ...rankedLetters.slice(8),
      ];
    }

    // Overflow for "dig deeper" modal — apply multi-signal relevance pipeline
    const rankedOverflow = rankAndFilterOverflow(query, rawOverflowVerses, rawOverflowProse);

    const overflowVerses = rankedOverflow.verses;
    const overflowProse = rankedOverflow.prose;

    if (rankedOverflow.totalFiltered > 0) {
      console.log(`[Relevance] Filtered ${rankedOverflow.totalFiltered} low-relevance overflow results`);
    }

    const verseUrlMap = buildVerseUrlMap(narrativeVerses);
    const metadata = buildMetadataAndCitations(query, narrativeVerses, narrativeProse, narrativeTranscripts, narrativeLetters);

    // Add overflow data to metadata — include article verse IDs for frontend badges
    const articleVerseIds = narrativeVerses.map(v => v.id);
    const fullMetadata = {
      ...metadata,
      suggestion,
      suggestionDisplay,
      overflowVerses,
      overflowProse,
      overflowTranscripts,
      overflowLetters,
      totalVerses: verses.length,
      totalProse: prose.length,
      totalTranscripts: transcripts.length,
      totalLetters: letters.length,
      articleVerseIds,
    };

    // References mode: skip Gemini synthesis, return metadata with empty narrative
    if (mode === "references") {
      const result = { ...fullMetadata, narrative: "" };
      setCached(query, result);
      return NextResponse.json(result);
    }

    // ── Strategy A: Template-built article (zero AI calls, instant) ──
    const narrative = buildTemplateArticle(query, narrativeVerses, narrativeProse, narrativeTranscripts, narrativeLetters);
    const result = { ...fullMetadata, narrative };
    setCached(query, result);
    return NextResponse.json(result);
  } catch (err) {
    console.error("Search error:", err);
    return NextResponse.json({ error: "An error occurred." }, { status: 500 });
  }
}