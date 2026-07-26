/**
 * route.ts — Search API Route
 *
 * Handles search queries with parallel hybrid semantic + full-text + tag search,
 * RRF (Reciprocal Rank Fusion) scoring, Cohere reranking, and a deterministic
 * verbatim-only woven-essay template. The core backend that powers the entire
 * search experience.
 *
 * Two response modes:
 *   GET /api/search?q=…            → single JSON response (unchanged, cacheable)
 *   GET /api/search?q=…&stream=1   → SSE: `stage` events as the pipeline advances
 *                                    (understood → expanding → searching →
 *                                    reranking → weaving), then `result` with the
 *                                    exact same JSON payload, then `done`.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/app/lib/01-supabase";
import { embedQueries } from "@/app/lib/03-embed";
import { generateQueryVariants, fuseRankedLists, multiQueryChannels } from "@/app/lib/16-multi-query";
import { getCached, setCached } from "@/app/lib/04-search-cache";
import { ensureVerseLinks } from "@/app/lib/05-link-postprocessor";
import { preprocessQuery } from "@/app/lib/07-query-preprocessor";
import { cohereRerank } from "@/app/lib/08-cohere-rerank";
import {
  PURPORT_CUTOFF,
  stripPurportBoilerplate,
  splitIntoParagraphs,
  paragraphsToHtml,
  mapOffsetToParagraphRange,
} from "@/app/lib/09-purport-format";
import {
  MAIN_FLOW_COUNT,
  extractQueryTerms,
  normalizeForMatch,
  buildFoldPreviewHtml,
  buildFoldBlock,
  highlightHtml,
  locateMatchedSentence,
  keyLineFor,
  type PassageType,
} from "@/app/lib/10-passage-fold";
import { chapterSpeakerWalk, type SpeakerState } from "@/app/lib/14-verse-speaker";
import { allowedEmphasisRanges } from "@/app/lib/15-transcript-speakers";
import { labelForTranscript } from "@/app/lib/13-passage-label";
import {
  type Authorship,
  getBookName,
  NO_VEDABASE_BOOKS,
  authorshipFor,
  provenanceNoteFor,
  PROVENANCE_POLICY,
} from "@/app/lib/12-provenance";
import type {
  VerseHit,
  ProseHit,
  TranscriptHit,
  LetterHit,
  SearchStageKey,
} from "@/app/lib/types/01-search";
import { validateMainFlow, normalizeVerbatim, type SourceFetchClient } from "@/app/lib/17-verbatim-validator";
import {
  rpcOrThrow,
  rpcOrDegrade,
  unwrapOrThrow,
  DegradationLog,
  type RpcCapableClient,
} from "@/app/lib/search-v2/rpc";
import {
  InvalidSearchInputError,
  isSearchError,
  newRequestId,
} from "@/app/lib/search-v2/errors";

// The cold pipeline (embeddings + ~20 RPCs + Cohere) can take 25–50 s; give the
// function room on Vercel. If the plan rejects 90, drop to 60.
export const maxDuration = 90;

const geminiKey = process.env.GEMINI_API_KEY || "";

const GEMINI_MODEL_SYNTHESIS = "gemini-2.5-flash";

/**
 * Bumped whenever the response shape or content policy changes, so the 24h
 * in-memory cache can never serve a response built by older code. The mode is
 * part of the key — article and references responses differ and must never
 * collide.
 *
 * p8: the strict RPC boundary. p7 could cache a successful-looking empty result
 * produced while every search function was missing from the database; bumping
 * retires any such entry rather than letting it outlive the fix.
 */
const RESPONSE_VERSION = "p8";
const cacheKey = (query: string, mode: string) => `${RESPONSE_VERSION}:${mode}:${query}`;

/** Modes the route accepts. Anything else is invalid input, not a silent default. */
const ALLOWED_MODES = new Set(["article", "references"]);

/**
 * Upper bound on `q`. Without one, a single unauthenticated request drives the
 * full paid fan-out (Gemini + Voyage + Cohere + ~20 RPCs) with an arbitrarily
 * large query. Rate limiting proper is PR D.
 */
const MAX_QUERY_CHARS = 2000;

/**
 * PHASE A: the five *_by_tags lanes are restored in the database but not called.
 *
 * `tags_core` holds controlled-vocabulary slugs ("goloka-vrndavana", "krsna"),
 * while this route splits queries into single words — 143 of the 251 vocabulary
 * terms are multiword and unreachable that way. Measured on production, the
 * ranked tag shape scans 66,461 rows / ~1.25 s for a common slug ("krsna" tags
 * 60,958 of 144,438 transcript paragraphs), and a broad query would fire up to
 * 45 tag RPCs. PR B owns phrase-preserving, ambiguity-aware, batched resolution;
 * until then the lane is disabled openly and reported in `disabledLanes`.
 */
const TAG_LANES_ENABLED = false;
const DISABLED_LANES: string[] = TAG_LANES_ENABLED ? [] : ["tags"];

/** Pipeline progress hook — drives the SSE `stage` events. */
type OnStage = (stage: SearchStageKey, labelOverride?: string) => void;

/**
 * Threaded through every pipeline stage so a failure can be correlated with
 * server logs, and so optional lanes that softened can be reported honestly
 * rather than disappearing.
 */
interface PipelineContext {
  requestId: string;
  degraded: DegradationLog;
}

const STAGE_META: Record<SearchStageKey, { pct: number; label: string }> = {
  understood: { pct: 12, label: "Reading your question…" },
  expanding: { pct: 22, label: "Exploring 10 angles of your question…" },
  searching: { pct: 45, label: "Searching 244,148 passages…" },
  reranking: { pct: 70, label: "Selecting his words…" },
  weaving: { pct: 90, label: "Weaving the essay…" },
};
const STAGE_ORDER: SearchStageKey[] = ["understood", "expanding", "searching", "reranking", "weaving"];

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

/**
 * Fallback URL builder — strips "Text " prefix as safety net. Only used when a
 * row has no vedabase_url of its own (rare; coverage is ~100%). Builds ONLY
 * exact per-verse pages; when the exact page can't be derived it returns ""
 * rather than a generic book-root link — a citation must open THAT passage's
 * own page or nothing.
 */
function buildVedabaseUrl(scripture: string, canto: string, chapter: string, verse: string): string {
  const base = "https://vedabase.io/en/library";
  const s = scripture?.toLowerCase();
  const cleanVerse = verse?.replace(/^Text\s+/i, "") || "";
  if (s === "bg") return `${base}/bg/${chapter}/${cleanVerse}/`;
  if (s === "sb") return `${base}/sb/${canto}/${chapter}/${cleanVerse}/`;
  if (s === "cc") return `${base}/cc/${canto}/${chapter}/${cleanVerse}/`;
  return "";
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
// VerseHit / ProseHit / TranscriptHit / LetterHit live in the shared
// server↔client contract (app/lib/types/01-search.ts). ChunkHit never leaves
// the pipeline (chunks only boost their parent verse), so it stays private.
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

/**
 * A widening full-text call that is allowed to fail. Used for supplementary
 * phrases and query variants — never for the original question's own lanes.
 */
function optionalFts(
  db: RpcCapableClient,
  fn: string,
  searchQuery: string,
  matchCount: number,
  pipeline: PipelineContext,
): Promise<Record<string, unknown>[]> {
  return rpcOrDegrade<Record<string, unknown>[]>(
    db,
    fn,
    { search_query: searchQuery, match_count: matchCount },
    { stage: `retrieval:widening:${fn}`, requestId: pipeline.requestId },
    [],
    pipeline.degraded,
  ).then(rows => rows ?? []);
}

// =====================================================
// V2 PARALLEL HYBRID SEARCH: FTS + Tags immediately, Semantic in parallel
// =====================================================
async function hybridSearchV2(query: string, pipeline: PipelineContext, onStage?: OnStage): Promise<{ verses: VerseHit[]; prose: ProseHit[]; transcripts: TranscriptHit[]; letters: LetterHit[]; directVerse?: VerseHit; queryVariants?: string[]; topic?: string | null; embeddingMs?: number }> {
  const supabase = getSupabaseAdmin();
  const db = supabase as unknown as RpcCapableClient;
  const { requestId, degraded } = pipeline;

  // ── Direct verse lookup for exact references like "BG 18.66", "SB 1.1.1", "NOI verse 1" ──
  //
  // Required lane: a devotee asking for an exact citation must get that verse or
  // a typed failure. It previously swallowed every error, so a dropped function
  // looked identical to "that verse does not exist".
  let directVerse: VerseHit | undefined;
  const isDirectRef = /^(BG|SB|CC|NOI|ISO|BS|NBS|MMS)\s+/i.test(query.trim());
  /** The exact return shape of public.direct_verse_lookup, per the DB contract. */
  interface DirectVerseRow {
    id: string;
    scripture: string;
    verse_number: string;
    sanskrit_devanagari: string | null;
    transliteration: string | null;
    translation: string | null;
    purport: string | null;
    chapter_id: string;
    vedabase_url: string | null;
    tags: string[] | null;
    chapter_number: number | null;
    canto_or_division: string | null;
    chapter_title: string | null;
    book_slug: string | null;
  }
  if (isDirectRef) {
    {
      const dvData = await rpcOrThrow<Record<string, unknown>[] | null>(
        db,
        "direct_verse_lookup",
        { ref_query: query.trim() },
        { stage: "retrieval:direct_verse_lookup", requestId },
      );
      if (dvData && dvData.length > 0) {
        const dv = dvData[0] as unknown as DirectVerseRow;
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
    }
  }

  const preprocessed = await preprocessQuery(query);
  const mainPhrase = preprocessed.searchPhrases[0];

  // For long queries with multiple extracted phrases, run additional FTS searches
  const additionalPhrases = preprocessed.searchPhrases.slice(1, 3);
  //
  // Supplementary phrases widen recall for long queries; a failure here must not
  // sink a search whose main phrase succeeded, so they degrade and are recorded.
  const additionalFtsPromises = additionalPhrases.flatMap(phrase => [
    optionalFts(db, "search_verses_fulltext_v2", phrase, 10, pipeline),
    optionalFts(db, "search_prose_fulltext_v2", phrase, 5, pipeline),
    optionalFts(db, "search_transcript_paragraphs_fulltext", phrase, 5, pipeline),
    optionalFts(db, "search_letter_paragraphs_fulltext", phrase, 3, pipeline),
  ]);

  // WAVE 1: Instant (no embedding needed).
  // These are the required lanes — the evidence a devotee actually receives.
  // Any database error propagates as SearchInfrastructureError.
  const ftsVersesPromise = rpcOrThrow<VerseHit[] | null>(db, "search_verses_fulltext_v2", { search_query: mainPhrase, match_count: 25 }, { stage: "retrieval:verses:fulltext", requestId });
  const ftsProsePromise = rpcOrThrow<ProseHit[] | null>(db, "search_prose_fulltext_v2", { search_query: mainPhrase, match_count: 15 }, { stage: "retrieval:prose:fulltext", requestId });
  const ftsTranscriptsPromise = rpcOrThrow<TranscriptHit[] | null>(db, "search_transcript_paragraphs_fulltext", { search_query: mainPhrase, match_count: 10 }, { stage: "retrieval:transcripts:fulltext", requestId });
  const ftsLettersPromise = rpcOrThrow<LetterHit[] | null>(db, "search_letter_paragraphs_fulltext", { search_query: mainPhrase, match_count: 8 }, { stage: "retrieval:letters:fulltext", requestId });
  const ftsChunksPromise = rpcOrThrow<ChunkHit[] | null>(db, "search_verse_chunks_fulltext", { search_query: mainPhrase, match_count: 15 }, { stage: "retrieval:chunks:fulltext", requestId });

  // Tag lanes are disabled in Phase A (see TAG_LANES_ENABLED). Reported in
  // `disabledLanes` rather than silently returning nothing.
  const tagVersesPromise = Promise.resolve<VerseHit[]>([]);
  const tagProsePromise = Promise.resolve<ProseHit[]>([]);
  const tagTranscriptsPromise = Promise.resolve<TranscriptHit[]>([]);
  const tagLettersPromise = Promise.resolve<LetterHit[]>([]);
  const tagChunksPromise = Promise.resolve<ChunkHit[]>([]);

  // ── Multi-query expansion (RAG-Fusion) ──
  // The original query's Wave-1 FTS/tag RPCs are already in flight above; the
  // Gemini variant call (4 s hard cap, empty on any failure) overlaps them.
  // Variants widen recall only — every downstream relevance judgement (Cohere)
  // stays against the ORIGINAL question.
  const expansion = await generateQueryVariants(query);
  const variants = expansion.variants;
  const channels = multiQueryChannels();
  onStage?.(
    "expanding",
    variants.length > 0
      ? `Exploring ${variants.length} angles of your question…`
      : "Searching directly…",
  );

  // Variant fan-out: full-text and semantic only — the tag channel is disabled
  // in Phase A. Variants widen recall, so each call is optional: a failure
  // narrows the search and is recorded, but never sinks an answer whose own
  // lanes succeeded.
  const variantFtsPromises = variants.map(v =>
    channels.has("fulltext")
      ? Promise.all([
          optionalFts(db, "search_verses_fulltext_v2", v, 6, pipeline),
          optionalFts(db, "search_prose_fulltext_v2", v, 6, pipeline),
          optionalFts(db, "search_transcript_paragraphs_fulltext", v, 6, pipeline),
          optionalFts(db, "search_letter_paragraphs_fulltext", v, 6, pipeline),
        ])
      : Promise.resolve(null),
  );

  // WAVE 2: ONE batched Voyage call embeds the original + every variant.
  const embedTexts = [
    preprocessed.isLong ? mainPhrase : query,
    ...(channels.has("semantic") ? variants : []),
  ];
  const embedStart = Date.now();
  let embeddingMs = 0;
  const embeddingsPromise = embedQueries(embedTexts).then(r => {
    embeddingMs = Date.now() - embedStart;
    return r;
  });

  // Wait for all Wave 1 + variant channels + embeddings in parallel
  onStage?.("searching");
  const [ftsVerses, ftsProse, ftsTranscripts, ftsLetters, ftsChunks, tagVerses, tagProse, tagTranscripts, tagLetters, tagChunks, embeddings, variantFts] = await Promise.all([
    ftsVersesPromise, ftsProsePromise, ftsTranscriptsPromise, ftsLettersPromise, ftsChunksPromise,
    tagVersesPromise, tagProsePromise, tagTranscriptsPromise, tagLettersPromise, tagChunksPromise,
    embeddingsPromise,
    Promise.all(variantFtsPromises),
  ]);
  const embedding = embeddings[0] || [];

  // When embedding is ready, fire semantic search
  let semanticVersesData: VerseHit[] = [];
  let semanticProseData: ProseHit[] = [];
  let semanticTranscriptsData: TranscriptHit[] = [];
  let semanticLettersData: LetterHit[] = [];
  let semanticChunksData: ChunkHit[] = [];

  // Variant semantic wave fires alongside the original's semantic RPCs.
  const variantSemanticPromise = Promise.all(
    (channels.has("semantic") ? embeddings.slice(1) : []).map(emb => {
      if (emb.length !== 1024) return Promise.resolve(null);
      const vs = `[${emb.join(",")}]`;
      const opts = (fn: string) =>
        rpcOrDegrade<Record<string, unknown>[]>(
          db, fn, { query_embedding: vs, match_count: 8 },
          { stage: `retrieval:widening:${fn}`, requestId }, [], degraded,
        ).then(rows => rows ?? []);
      return Promise.all([
        opts("search_verses_semantic_v2"),
        opts("search_prose_semantic_v2"),
        opts("search_transcript_paragraphs_semantic"),
        opts("search_letter_paragraphs_semantic"),
      ]);
    }),
  );

  if (embedding.length === 1024) {
    const vectorStr = `[${embedding.join(",")}]`;
    const [semV, semP, semT, semL, semC] = await Promise.all([
      rpcOrThrow<VerseHit[] | null>(db, "search_verses_semantic_v2", { query_embedding: vectorStr, match_count: 30 }, { stage: "retrieval:verses:semantic", requestId }),
      rpcOrThrow<ProseHit[] | null>(db, "search_prose_semantic_v2", { query_embedding: vectorStr, match_count: 20 }, { stage: "retrieval:prose:semantic", requestId }),
      rpcOrThrow<TranscriptHit[] | null>(db, "search_transcript_paragraphs_semantic", { query_embedding: vectorStr, match_count: 15 }, { stage: "retrieval:transcripts:semantic", requestId }),
      rpcOrThrow<LetterHit[] | null>(db, "search_letter_paragraphs_semantic", { query_embedding: vectorStr, match_count: 10 }, { stage: "retrieval:letters:semantic", requestId }),
      rpcOrThrow<ChunkHit[] | null>(db, "search_verse_chunks_semantic", { query_embedding: vectorStr, match_count: 15 }, { stage: "retrieval:chunks:semantic", requestId }),
    ]);
    semanticVersesData = semV || [];
    semanticProseData = semP || [];
    semanticTranscriptsData = semT || [];
    semanticLettersData = semL || [];
    semanticChunksData = semC || [];
  } else {
    // Voyage returned nothing usable. Full-text still carries the answer, but
    // the response must admit the semantic channel is missing.
    degraded.record("embedding:voyage", "voyage", { code: "embedding_unavailable" });
  }

  // Resolve additional phrase FTS results (already degraded-safe arrays).
  const additionalFtsResults: Record<string, unknown>[][] =
    additionalPhrases.length > 0 ? await Promise.all(additionalFtsPromises) : [];

  // Merge additional phrase FTS results into main FTS arrays before RRF
  const ftsVersesRows: VerseHit[] = [...(ftsVerses ?? [])];
  const ftsProseRows: ProseHit[] = [...(ftsProse ?? [])];
  const ftsTranscriptRows: TranscriptHit[] = [...(ftsTranscripts ?? [])];
  const ftsLetterRows: LetterHit[] = [...(ftsLetters ?? [])];
  for (let p = 0; p < additionalPhrases.length; p++) {
    const base = p * 4;
    ftsVersesRows.push(...((additionalFtsResults[base] ?? []) as unknown as VerseHit[]));
    ftsProseRows.push(...((additionalFtsResults[base + 1] ?? []) as unknown as ProseHit[]));
    ftsTranscriptRows.push(...((additionalFtsResults[base + 2] ?? []) as unknown as TranscriptHit[]));
    ftsLetterRows.push(...((additionalFtsResults[base + 3] ?? []) as unknown as LetterHit[]));
  }

  // MERGE with RRF
  const verseMap = rrfMerge<VerseHit>(semanticVersesData, ftsVersesRows, tagVerses);
  const proseMap = rrfMerge<ProseHit>(semanticProseData, ftsProseRows, tagProse);
  const transcriptMap = rrfMerge<TranscriptHit>(semanticTranscriptsData, ftsTranscriptRows, tagTranscripts);
  const letterMap = rrfMerge<LetterHit>(semanticLettersData, ftsLetterRows, tagLetters);

  // RRF merge chunks
  const chunkMap = rrfMerge<ChunkHit>(semanticChunksData, ftsChunks ?? [], tagChunks);

  // Boost parent verses found via chunks — surfaces content buried deep in long purports
  const bestChunkScore = new Map<string, number>(); // verse_id → best chunk score seen
  for (const chunk of chunkMap.values()) {
    if (!chunk.verse_id) continue;
    const existingVerse = verseMap.get(chunk.verse_id);
    if (existingVerse) {
      // Verse already found by direct search — give it a chunk boost
      existingVerse.score += chunk.score * 0.3;
      // Remember the highest-scoring matched chunk so the article can show the
      // section of a long purport that actually matched (not used for ranking).
      if (chunk.score > (bestChunkScore.get(chunk.verse_id) ?? 0)) {
        bestChunkScore.set(chunk.verse_id, chunk.score);
        existingVerse.matchedChunkText = chunk.body_text;
      }
    }
  }

  const allVerses = [...verseMap.values()].sort((a, b) => b.score - a.score);
  const allProse = [...proseMap.values()].sort((a, b) => b.score - a.score);
  const allTranscripts = [...transcriptMap.values()].sort((a, b) => b.score - a.score);
  const allLetters = [...letterMap.values()].sort((a, b) => b.score - a.score);

  // ── RAG-Fusion: per-variant RRF mini-lists, then a second-stage RRF across
  // the original + all variant lists. The original list is passed FIRST so its
  // enriched metadata (similarity, matchedChunkText, chunk boosts) wins the
  // canonical-row pick. Caps keep the pool Cohere sees bounded.
  let fusedVerses: VerseHit[] = allVerses;
  let fusedProse: ProseHit[] = allProse;
  let fusedTranscripts: TranscriptHit[] = allTranscripts;
  let fusedLetters: LetterHit[] = allLetters;

  const variantSemantic = await variantSemanticPromise;
  if (variants.length > 0) {
    const vVerseLists: VerseHit[][] = [];
    const vProseLists: ProseHit[][] = [];
    const vTranscriptLists: TranscriptHit[][] = [];
    const vLetterLists: LetterHit[][] = [];

    for (let i = 0; i < variants.length; i++) {
      const sem = variantSemantic[i];
      const fts = variantFts[i];
      // The tag channel is disabled in Phase A, so variant lists fuse semantic
      // and full-text only.
      const rankedV = [...rrfMerge<VerseHit>((sem?.[0] ?? []) as unknown as VerseHit[], (fts?.[0] ?? []) as unknown as VerseHit[], []).values()].sort((a, b) => b.score - a.score);
      const rankedP = [...rrfMerge<ProseHit>((sem?.[1] ?? []) as unknown as ProseHit[], (fts?.[1] ?? []) as unknown as ProseHit[], []).values()].sort((a, b) => b.score - a.score);
      const rankedT = [...rrfMerge<TranscriptHit>((sem?.[2] ?? []) as unknown as TranscriptHit[], (fts?.[2] ?? []) as unknown as TranscriptHit[], []).values()].sort((a, b) => b.score - a.score);
      const rankedL = [...rrfMerge<LetterHit>((sem?.[3] ?? []) as unknown as LetterHit[], (fts?.[3] ?? []) as unknown as LetterHit[], []).values()].sort((a, b) => b.score - a.score);
      if (rankedV.length > 0) vVerseLists.push(rankedV);
      if (rankedP.length > 0) vProseLists.push(rankedP);
      if (rankedT.length > 0) vTranscriptLists.push(rankedT);
      if (rankedL.length > 0) vLetterLists.push(rankedL);
    }

    fusedVerses = fuseRankedLists([allVerses, ...vVerseLists], RRF_K, 120);
    fusedProse = fuseRankedLists([allProse, ...vProseLists], RRF_K, 40);
    fusedTranscripts = fuseRankedLists([allTranscripts, ...vTranscriptLists], RRF_K, 30);
    fusedLetters = fuseRankedLists([allLetters, ...vLetterLists], RRF_K, 20);
  }

  // If we found a direct verse match, inject it at position #1 (deduplicate if already present)
  if (directVerse) {
    const existingIdx = fusedVerses.findIndex(v => v.id === directVerse!.id);
    if (existingIdx >= 0) {
      fusedVerses.splice(existingIdx, 1);
    }
    fusedVerses.unshift(directVerse as VerseHit & { score: number; similarity?: number });
  }

  return {
    verses: fusedVerses,
    prose: fusedProse,
    transcripts: fusedTranscripts,
    letters: fusedLetters,
    directVerse,
    queryVariants: variants,
    topic: expansion.topic,
    embeddingMs,
  };
}

// =====================================================
// HYBRID SEARCH: V2, with the legacy V1 path retained only for non-database faults
// =====================================================
/**
 * A SearchInfrastructureError ALWAYS escapes this function.
 *
 * The legacy fallback below reaches for v1 RPCs and then raw `ilike` table
 * scans. Letting a database failure fall through to it would answer a broken
 * pipeline with a thin, plausible-looking result set — the same disguise this
 * work exists to remove. Only a non-database fault (a bug in the V2 assembly
 * code) may use the fallback.
 *
 * @deprecated The v1/ilike path is retained for this hotfix only; PR B removes
 * it once the V2 retrieval modules own the pipeline.
 */
async function hybridSearch(query: string, pipeline: PipelineContext, onStage?: OnStage): Promise<{ verses: VerseHit[]; prose: ProseHit[]; transcripts: TranscriptHit[]; letters: LetterHit[]; directVerse?: VerseHit; queryVariants?: string[]; topic?: string | null; embeddingMs?: number }> {
  try {
    return await hybridSearchV2(query, pipeline, onStage);
  } catch (err) {
    if (isSearchError(err)) throw err;
    console.error(
      JSON.stringify({
        level: "error",
        event: "search.v2_assembly_failed",
        requestId: pipeline.requestId,
      }),
    );
    pipeline.degraded.record("retrieval:v2", "hybridSearchV2", { code: "assembly_error" });
    const raw = await fullTextSearch(query, pipeline);
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

/**
 * Legacy v1 lane. Reachable only from the non-database branch of hybridSearch.
 * Its RPCs are still strict: a database failure here must surface, not slide
 * quietly down to the `ilike` scan.
 */
async function fullTextSearch(query: string, pipeline: PipelineContext): Promise<{ verses: VerseHit[]; prose: ProseHit[] }> {
  const db = getSupabaseAdmin() as unknown as RpcCapableClient;
  const { requestId } = pipeline;

  const [ftsVerses, ftsProse] = await Promise.all([
    rpcOrThrow<(VerseHit & { rank?: number })[] | null>(db, "search_verses_fulltext", { search_query: query, match_count: 20 }, { stage: "retrieval:legacy:verses:fulltext", requestId }),
    rpcOrThrow<(ProseHit & { rank?: number })[] | null>(db, "search_prose_fulltext", { search_query: query, match_count: 10 }, { stage: "retrieval:legacy:prose:fulltext", requestId }),
  ]);

  if ((ftsVerses?.length || 0) > 0 || (ftsProse?.length || 0) > 0) {
    return {
      verses: (ftsVerses || []).map(v => ({ ...v, score: v.rank || 0 })),
      prose: (ftsProse || []).map(p => ({ ...p, score: p.rank || 0 })),
    };
  }

  return ilikeSearch(query, pipeline);
}

async function ilikeSearch(query: string, pipeline: PipelineContext): Promise<{ verses: VerseHit[]; prose: ProseHit[] }> {
  const supabase = getSupabaseAdmin();
  const { requestId } = pipeline;
  const terms = query.toLowerCase().replace(/[?!.,]/g, "").split(/\s+/).filter(w => w.length > 3);
  if (terms.length === 0) return { verses: [], prose: [] };

  const tf = terms.map(k => `translation.ilike.%${k}%`).join(",");
  const pf = terms.map(k => `purport.ilike.%${k}%`).join(",");
  const bf = terms.map(k => `body_text.ilike.%${k}%`).join(",");

  const [rT, rP, rPr] = await Promise.all([
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id,vedabase_url").or(tf).limit(15),
    supabase.from("verses").select("id,scripture,verse_number,sanskrit_devanagari,transliteration,translation,purport,chapter_id,vedabase_url").or(pf).limit(15),
    supabase.from("prose_paragraphs").select("id,book_slug,paragraph_number,body_text,chapter_id,vedabase_url").or(bf).limit(15),
  ]);

  // These are table reads, not RPCs, but they resolve with the same
  // { data, error } shape and were being destructured just as unsafely.
  const ctx = { stage: "retrieval:legacy:ilike", requestId };
  const vT = unwrapOrThrow<VerseHit[] | null>(rT, "verses.ilike(translation)", ctx) ?? [];
  const vP = unwrapOrThrow<VerseHit[] | null>(rP, "verses.ilike(purport)", ctx) ?? [];
  const pr = unwrapOrThrow<ProseHit[] | null>(rPr, "prose_paragraphs.ilike(body_text)", ctx) ?? [];

  const seenV = new Set<string>();
  const allV = [...vT, ...vP];
  const uV = allV.filter(v => { if (seenV.has(v.id)) return false; seenV.add(v.id); return true; });
  return { verses: uV, prose: pr };
}

// =====================================================
// LEGACY ENRICH: Used by V1 fallback path only
// =====================================================
async function legacyEnrich(verses: VerseHit[], prose: ProseHit[]) {
  const supabase = getSupabaseAdmin();
  const ids = [...new Set([...verses.map(v => v.chapter_id), ...prose.map(p => p.chapter_id)].filter((x): x is string => !!x))];

  let cm = new Map<string, Record<string, unknown>>();
  if (ids.length > 0) {
    const { data } = await supabase.from("chapters").select("id,chapter_number,canto_or_division,chapter_title,book_slug").in("id", ids);
    cm = new Map((data || []).map((c: Record<string, unknown>) => [c.id as string, c]));
  }

  const eV = verses.map(v => {
    const c = v.chapter_id ? cm.get(v.chapter_id) : undefined;
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
    const c = p.chapter_id ? cm.get(p.chapter_id) : undefined;
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
    const bodyText = (t.body_text || "").trim();
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
    const bodyText = (l.body_text || "").trim();
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
    const tags = (item as { tags?: string[] }).tags;
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
Use these findings ONLY to orient the reader — name the topic, which books/lectures/letters address it, and which speakers appear. Do NOT state any spiritual teaching in your own voice (never write "the purpose of life is…", "one should…", or "the core teaching is…"); the teachings must come SOLELY from the attributed verbatim quotes below. Avoid generic filler; vary the framing based on the actual sources found.
2. Organize the body by THEME, not just sequentially. Use <h3> headings for each thematic section. Make headings editorial (e.g., "The Rarity of Human Birth", "The Ultimate Goal"), NOT just scripture names.
3. End with a <p> paragraph (1-2 sentences) that FRAMES the collection — name the topic "${question}" and the sources drawn upon — WITHOUT asserting any teaching in your own voice (no "the scriptures teach that…", no "one should…"). End with a brief mention that full purports are available via Vedabase.io links above.

PRACTICAL TAKEAWAY: Do NOT compose practical instructions in your own voice. If a passage states a practical instruction (chant, serve, follow the spiritual master, etc.), it may appear ONLY as that passage's attributed verbatim quote — never paraphrased, summarized, or synthesized as the narrator's advice.

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
// NON-STREAMING SYNTHESIS — QUARANTINED
// The live GET path builds the essay from buildTemplateArticle (deterministic,
// verbatim-only). AI synthesis is disabled here so no code path — present or
// future — can produce an AI-authored narrative (Hard Rule 1). Left inert (not
// deleted) so the intent is explicit; it now returns the deterministic template.
// =====================================================
async function synthesize(question: string, verses: VerseHit[], prose: ProseHit[], _verseUrlMap: Map<string, string>, transcripts: TranscriptHit[] = [], letters: LetterHit[] = []) {
  return buildFB(question, verses, prose, transcripts, letters);
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
    const tags = (item.data as { tags?: string[] }).tags;
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
 * Builds the purport preview shown inside the article.
 *
 * Short/medium purports (≤ PURPORT_CUTOFF) are shown WHOLE — never truncated.
 * Long purports get a two-part preview: the opening (where Prabhupāda states
 * his point) plus the matched section (the paragraphs around the chunk the
 * search hit, which may be deep in the purport), with a "…" between them when
 * they are not contiguous. Cuts only ever fall on whole-paragraph boundaries.
 * The closing "Thus end the Bhaktivedanta purports…" footer is stripped from
 * every preview. Returns { html, truncated } — `truncated` drives the inline
 * "Read the full purport" expand UI on the client.
 */
function buildPurportPreview(v: VerseHit): { html: string; truncated: boolean } {
  const clean = stripPurportBoilerplate(v.purport || "");
  const paras = splitIntoParagraphs(clean);
  if (paras.length === 0) return { html: "", truncated: false };

  // Short/medium → whole purport.
  if (clean.length <= PURPORT_CUTOFF) {
    return { html: paragraphsToHtml(paras), truncated: false };
  }

  // Opening: whole paragraphs from the start until ~700 chars (at least one).
  const OPENING_TARGET = 700;
  let openingEndIdx = 0;
  let acc = 0;
  for (let i = 0; i < paras.length; i++) {
    acc += paras[i].length;
    openingEndIdx = i;
    if (acc >= OPENING_TARGET) break;
  }

  // Matched section, if the search hit a specific chunk of this purport.
  // Locate by the chunk's PREFIX: a chunk's tail can include the footer we
  // already stripped from `clean`, so the full string may not be found.
  const matched = (v.matchedChunkText || "").trim();
  let matchIdx = -1;
  if (matched) {
    matchIdx = clean.indexOf(matched.slice(0, 160));
    if (matchIdx === -1) matchIdx = clean.indexOf(matched.slice(0, 60));
  }

  if (matchIdx === -1) {
    // No locatable matched chunk → opening-only preview.
    return { html: paragraphsToHtml(paras.slice(0, openingEndIdx + 1)), truncated: true };
  }

  const matchEnd = Math.min(clean.length - 1, matchIdx + matched.length - 1);
  const { startPara, endPara } = mapOffsetToParagraphRange(clean, matchIdx, matchEnd);

  // Widen by ±1 neighbour, then shrink the tail while the section is too long
  // (always keeping the paragraphs that actually contain the match).
  const SECTION_CAP = 1000;
  let secStart = Math.max(0, startPara - 1);
  let secEnd = Math.min(paras.length - 1, endPara + 1);
  const sectionLen = (a: number, b: number) =>
    paras.slice(a, b + 1).reduce((n, p) => n + p.length, 0);
  while (secEnd > endPara && sectionLen(secStart, secEnd) > SECTION_CAP) secEnd--;
  while (secStart < startPara && sectionLen(secStart, secEnd) > SECTION_CAP) secStart++;

  // If the matched section overlaps or directly follows the opening, merge the
  // two (no ellipsis); otherwise show opening … matched section.
  if (secStart <= openingEndIdx + 1) {
    const merged = paras.slice(0, Math.max(openingEndIdx, secEnd) + 1);
    return { html: paragraphsToHtml(merged), truncated: true };
  }

  const html =
    paragraphsToHtml(paras.slice(0, openingEndIdx + 1)) +
    `<p class="pp-ellipsis">…</p>` +
    paragraphsToHtml(paras.slice(secStart, secEnd + 1));
  return { html, truncated: true };
}

/**
 * Builds the "section" shown for a prose / lecture / letter result: the matched
 * paragraph plus its neighbouring paragraphs, so the key sentence in the
 * paragraph just above or below is visible. The matched paragraph is always
 * kept whole; a neighbour is dropped only if the section would exceed the
 * cutoff. Cuts only ever fall on whole-paragraph boundaries — never mid-sentence.
 */
function buildSectionHtml(matchedBody: string, before?: string, after?: string): string {
  const matched = (matchedBody || "").trim();
  if (!matched) return "";

  // Include a neighbour only if it is substantial and not mostly Sanskrit.
  const beforeOk = before && before.trim().length > 40 && !isMostlySanskrit(before) ? before.trim() : "";
  const afterOk = after && after.trim().length > 40 && !isMostlySanskrit(after) ? after.trim() : "";

  let pieces = [beforeOk, matched, afterOk].filter(Boolean) as string[];
  const total = (arr: string[]) => arr.reduce((n, s) => n + s.length, 0);
  if (total(pieces) > PURPORT_CUTOFF && beforeOk && afterOk) {
    // Drop the larger neighbour first.
    pieces = beforeOk.length >= afterOk.length ? [matched, afterOk] : [beforeOk, matched];
  }
  if (total(pieces) > PURPORT_CUTOFF && pieces.length > 1) {
    pieces = [matched];
  }

  const paras = pieces.flatMap((s) => splitIntoParagraphs(s));
  return paragraphsToHtml(paras);
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
  queryTerms: string[] = [],
  topic: string | null = null,
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

  // The main-flow passages are already selected upstream (top MAIN_FLOW_COUNT by
  // rerank score, with the same admission filters); render exactly what we're
  // handed, in unified score order. Light guards remain as defence only.
  for (const v of verses) {
    if (!v.translation && !v.purport) continue;
    if ((v.translation || "").trim().length < 10) continue;
    allItems.push({ type: 'verse', data: v, score: v.score || 0 });
  }

  for (const p of prose) {
    const bodyText = (p.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;
    allItems.push({ type: 'prose', data: p, score: p.score || 0 });
  }

  for (const t of transcripts) {
    const bodyText = (t.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;
    allItems.push({ type: 'lecture', data: t, score: t.score || 0 });
  }

  for (const l of letters) {
    const bodyText = (l.body_text || "").trim();
    if (bodyText.length < 80) continue;
    allItems.push({ type: 'letter', data: l, score: l.score || 0 });
  }

  // Sort by score
  allItems.sort((a, b) => b.score - a.score);

  // ── INTRO: framing ONLY ──
  // Name the topic, the sources, and the speakers — never state a teaching in the
  // narrator's voice (Hard Rule 1). The doctrine is carried solely by the attributed
  // verbatim passages below, not by this orientation. The wording comes from
  // computeFraming — one source for the structured fields and this HTML.
  const framing = computeFraming(question, verses, prose, transcripts, letters, topic);
  parts.push(`<p>${framing.intro}</p>`);

  // ── GROUP INTO THEMED SECTIONS with <h3> headings ──
  const themes = groupIntoThemes(allItems);

  // Transition templates. Speaker forms are used ONLY when the verse carries a
  // confident uvāca-derived speaker (14-verse-speaker); otherwise the neutral
  // ref-only forms — a speaker is never guessed.
  const speakerTransitions = [
    (s: string, ref: string) => `${s} states (${ref}):`,
    (s: string, ref: string) => `In ${ref}, ${s} declares:`,
    (s: string, ref: string) => `${s} instructs (${ref}):`,
    (s: string, ref: string) => `Drawing from ${ref}, ${s} teaches:`,
    (s: string, ref: string) => `${s} further illuminates this (${ref}):`,
    (s: string, ref: string) => `${s} emphasizes (${ref}):`,
  ];
  const neutralTransitions = [
    (ref: string) => `As stated in ${ref}:`,
    (ref: string) => `In ${ref}:`,
    (ref: string) => `The instruction continues in ${ref}:`,
    (ref: string) => `Another key teaching appears in ${ref}:`,
    (ref: string) => `This truth is addressed in ${ref}:`,
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
        const speaker = v.speaker ? (v.speakerTo ? `${v.speaker} to ${v.speakerTo}` : v.speaker) : "";

        const cite = url
          ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${ref}]</span></a></div>`
          : `<div class="cite-ref"><span class="verse-label">[${ref}]</span></div>`;

        // Transition — speaker form only with a confident uvāca speaker
        parts.push(`<p>${speaker
          ? speakerTransitions[transIdx % speakerTransitions.length](speaker, ref)
          : neutralTransitions[transIdx % neutralTransitions.length](ref)}</p>`);
        transIdx++;

        // Translation — folds only if unusually long; the verse anchor lives here.
        const tText = (v.translation || "").trim();
        if (tText) {
          const tFold = buildFoldPreviewHtml({ type: 'verse', text: tText, queryTerms });
          const inner = tFold.truncated
            ? `"${tFold.previewHtml}"`
            : `"${highlightHtml(tText, locateMatchedSentence(tText, undefined, queryTerms), queryTerms)}"`;
          parts.push(buildFoldBlock({
            type: 'verse', id: v.id, previewHtml: inner, truncated: tFold.truncated,
            citeHtml: cite, expandLabel: "Read the full translation →",
          }));
        }

        // Purport — preview leads with the matched line; expand reveals the whole
        // purport (incl. the opening). The verse anchor is on the translation, so
        // the purport block carries no source id (anchorId: null).
        if (v.purport && v.purport.length > 50) {
          const pFold = buildFoldPreviewHtml({
            type: 'purport', text: v.purport, matchedChunkText: v.matchedChunkText, queryTerms,
          });
          if (pFold.previewHtml) {
            parts.push(`<p>${purportTransitions[purportIdx % purportTransitions.length]}</p>`);
            purportIdx++;
            parts.push(buildFoldBlock({
              type: 'purport', id: v.id, anchorId: null, previewHtml: pFold.previewHtml,
              truncated: pFold.truncated, citeHtml: cite, expandLabel: "Read the full purport →",
            }));
          }
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
        const noVedabase = NO_VEDABASE_BOOKS.has(p.book_slug?.toLowerCase());

        const cite = (!noVedabase && url)
          ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${bookName}]</span></a></div>`
          : `<div class="cite-ref"><span class="verse-label">[${bookName}]</span></div>`;

        const fold = buildFoldPreviewHtml({ type: 'prose', text: bodyText, queryTerms });
        parts.push(`<p>In ${bookName}${p.chapter_title ? " (" + p.chapter_title + ")" : ""}, Śrīla Prabhupāda writes:</p>`);
        parts.push(buildFoldBlock({
          type: 'prose', id: p.id, previewHtml: fold.previewHtml, truncated: fold.truncated,
          citeHtml: cite, expandLabel: "Read in context →",
        }));

      } else if (item.type === 'lecture') {
        const t = item.data as TranscriptHit;
        const bodyText = (t.body_text || "").trim();
        if (bodyText.length < 80 || isMostlySanskrit(bodyText)) continue;

        const year = t.date ? new Date(t.date).getFullYear().toString() : "";
        const city = t.location || "";
        const url = t.vedabase_url || "";

        const citeLabel = ["Lecture", year, city].filter(Boolean).join(" · ");
        const cite = url
          ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${citeLabel}]</span></a></div>`
          : `<div class="cite-ref"><span class="verse-label">[${citeLabel}]</span></div>`;

        const fold = buildFoldPreviewHtml({ type: 'lecture', text: bodyText, queryTerms });
        // "Śrīla Prabhupāda said" only when his own line is the confirmed match
        // (t.speaker set by annotateProvenance) OR the paragraph is prefix-less
        // lecture body (the document's own speaker, no contrary evidence).
        // A mixed or conversational exchange gets neutral framing.
        const hasSpeakerPrefixes = allowedEmphasisRanges(bodyText) !== null;
        const isLectureKind = labelForTranscript(t).parts[0] === "Lecture";
        const place = city && year ? ` in ${city} (${year})` : city ? ` in ${city}` : year ? ` (${year})` : "";
        const transition = (t.speaker || (!hasSpeakerPrefixes && isLectureKind))
          ? `${city || year ? `Speaking${place}` : "In a lecture"}, Śrīla Prabhupāda said:`
          : `From a recorded exchange${place}:`;
        parts.push(`<p>${transition}</p>`);
        parts.push(buildFoldBlock({
          type: 'lecture', id: t.id, previewHtml: fold.previewHtml, truncated: fold.truncated,
          citeHtml: cite, expandLabel: "Read in context →",
        }));

      } else if (item.type === 'letter') {
        const l = item.data as LetterHit;
        const bodyText = (l.body_text || "").trim();
        if (bodyText.length < 80) continue;

        const year = l.date ? new Date(l.date).getFullYear().toString() : "";
        const recipientPart = l.recipient || "";
        const url = l.vedabase_url || "";

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

        const fold = buildFoldPreviewHtml({ type: 'letter', text: bodyText, queryTerms });
        parts.push(`<p>${attribution}, Śrīla Prabhupāda wrote:</p>`);
        parts.push(buildFoldBlock({
          type: 'letter', id: l.id, previewHtml: fold.previewHtml, truncated: fold.truncated,
          citeHtml: cite, expandLabel: "Read in context →",
        }));
      }
    }
  }

  // ── CONCLUSION: framing only (orientation + where to read more) ──
  parts.push(`<p>${framing.conclusion}</p>`);

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

  // Intro — framing ONLY: name the topic and the sources; never state a teaching in
  // the narrator's voice (Hard Rule 1). Doctrine is carried by the attributed quotes.
  const fbSourceKinds: string[] = [];
  if (bookNames.length > 0) fbSourceKinds.push(bookListStr);
  if (t.length > 0) fbSourceKinds.push("his recorded lectures");
  if (l.length > 0) fbSourceKinds.push("his letters");
  const fbSourcesStr = fbSourceKinds.length === 0
    ? "his books, lectures, and letters"
    : fbSourceKinds.length === 1
      ? fbSourceKinds[0]
      : fbSourceKinds.length === 2
        ? `${fbSourceKinds[0]} and ${fbSourceKinds[1]}`
        : `${fbSourceKinds.slice(0, -1).join(", ")}, and ${fbSourceKinds[fbSourceKinds.length - 1]}`;
  parts.push(`<p>On the question of “${question.trim().replace(/\s+/g, " ")}”, Śrīla Prabhupāda speaks across ${fbSourcesStr}. Here is what he teaches, in his own words and purports.</p>`);

  // Varied transition templates — neutral ref-only forms (a speaker is never
  // guessed; the coarse per-canto speaker map is gone).
  const transitions = [
    (ref: string) => `As stated in ${ref}:`,
    (ref: string) => `In ${ref}:`,
    (ref: string) => `This is further addressed in ${ref}:`,
    (ref: string) => `Another key teaching appears in ${ref}:`,
    (ref: string) => `The instruction continues in ${ref}:`,
    (ref: string) => `Drawing from ${ref}:`,
    (ref: string) => `This truth is echoed in ${ref}:`,
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

    // Transition sentence (NO citation here — citation goes inside quote blocks)
    parts.push(`<p>${transitions[idx % transitions.length](ref)}</p>`);

    // Translation with citation at end
    if (x.translation) {
      parts.push(`<div class="verse-quote">"${x.translation}"${cite}</div>`);
    }

    // Purport — whole teaching (short/medium) or opening + matched section (long).
    if (x.purport && x.purport.length > 10) {
      const { html, truncated } = buildPurportPreview(x);
      if (html) {
        parts.push(`<p>${purportTransitions[idx % purportTransitions.length]}</p>`);
        if (truncated) {
          parts.push(
            `<div class="purport-quote purport-block" data-verse-id="${x.id}">` +
              `<div class="purport-preview">${html}</div>` +
              `<button type="button" class="purport-expand-btn" data-verse-id="${x.id}">Read the full purport →</button>` +
              cite +
            `</div>`,
          );
        } else {
          parts.push(`<div class="purport-quote">${html}${cite}</div>`);
        }
      }
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
    const sectionHtml = buildSectionHtml(usableText);

    const cite = url
      ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${bookName}]</span></a></div>`
      : `<div class="cite-ref"><span class="verse-label">[${bookName}]</span></div>`;

    parts.push(`<p>In ${bookName}${x.chapter_title ? " (" + x.chapter_title + ")" : ""}, Śrīla Prabhupāda writes:</p>`);
    parts.push(`<div class="prose-quote">${sectionHtml}${cite}</div>`);
    return true;
  };

  /** Render a single transcript (lecture) passage */
  const renderSingleTranscript = (x: TranscriptHit) => {
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80 || isMostlySanskrit(bodyText)) return;

    const year = x.date ? new Date(x.date).getFullYear().toString() : "";
    const city = x.location || "";
    const url = x.vedabase_url || "";
    const sectionHtml = buildSectionHtml(bodyText);

    // Build citation: [Lecture · 1973 · Stockholm]
    const citeLabel = ["Lecture", year, city].filter(Boolean).join(" · ");
    const cite = url
      ? `<div class="cite-ref"><a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">[${citeLabel}]</span></a></div>`
      : `<div class="cite-ref"><span class="verse-label">[${citeLabel}]</span></div>`;

    // Same speaker guard as the live template: never claim "Śrīla Prabhupāda
    // said" over a multi-speaker exchange without a confirmed line of his.
    const hasSpeakerPrefixes = allowedEmphasisRanges(bodyText) !== null;
    const isLectureKind = labelForTranscript(x).parts[0] === "Lecture";
    const place = city && year ? ` in ${city} (${year})` : city ? ` in ${city}` : year ? ` (${year})` : "";
    const transition = (x.speaker || (!hasSpeakerPrefixes && isLectureKind))
      ? `${city || year ? `Speaking${place}` : "In a lecture"}, Śrīla Prabhupāda said:`
      : `From a recorded exchange${place}:`;
    parts.push(`<p>${transition}</p>`);
    parts.push(`<div class="lecture-quote">${sectionHtml}${cite}</div>`);
  };

  /** Render a single letter passage */
  const renderSingleLetter = (x: LetterHit) => {
    const bodyText = (x.body_text || "").trim();
    if (bodyText.length < 80) return;

    const year = x.date ? new Date(x.date).getFullYear().toString() : "";
    const recipientPart = x.recipient || "";
    const url = x.vedabase_url || "";
    const sectionHtml = buildSectionHtml(bodyText);

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
    parts.push(`<div class="letter-quote">${sectionHtml}${cite}</div>`);
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

  // Conclusion — framing only (orientation + where to read more)
  parts.push(`<p>These passages gather Śrīla Prabhupāda's words on this question from ${fbSourcesStr}. The complete purports, with full context, are one click away on Vedabase.</p>`);

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
// NEIGHBOUR PARAGRAPHS (for prose / lecture / letter "section" context)
// =====================================================
/**
 * Fetches the paragraphs immediately before and after each matched
 * prose / lecture / letter paragraph, so the article can show the matched
 * paragraph in context. One batched query per table (by parent id +
 * paragraph_number). Returns a Map keyed by the matched paragraph's id.
 */
async function fetchNeighbourMap(
  prose: ProseHit[],
  transcripts: TranscriptHit[],
  letters: LetterHit[],
): Promise<Map<string, { before?: string; after?: string }>> {
  const supabase = getSupabaseAdmin();
  const result = new Map<string, { before?: string; after?: string }>();

  /**
   * The narrow slice of the PostgREST builder this helper uses. The table and
   * column names are computed at runtime, so the generated per-table types do
   * not apply; this states exactly what is called instead of erasing the type.
   */
  interface DynamicTableQuery {
    select(columns: string): DynamicTableQuery;
    in(column: string, values: readonly (string | number)[]): DynamicTableQuery;
    then<R>(
      onfulfilled: (value: { data: unknown[] | null; error: unknown }) => R,
    ): Promise<R>;
  }

  const load = async <T extends { id: string; paragraph_number: number }>(
    table: string,
    parentCol: keyof T & string,
    items: T[],
  ) => {
    const valid = items.filter(
      (it) => (it as Record<string, unknown>)[parentCol] && typeof it.paragraph_number === "number",
    );
    if (valid.length === 0) return;

    const parentIds = [...new Set(valid.map((it) => (it as Record<string, unknown>)[parentCol] as string))];
    const wantedNums = [
      ...new Set(valid.flatMap((it) => [it.paragraph_number - 1, it.paragraph_number + 1])),
    ];

    // Dynamic table + column name — cast past the typed query builder.
    const { data, error } = await (supabase.from(table) as unknown as DynamicTableQuery)
      .select(`${parentCol}, paragraph_number, body_text`)
      .in(parentCol, parentIds)
      .in("paragraph_number", wantedNums);
    if (error || !data) return;

    const byKey = new Map<string, string>();
    for (const row of data as Array<Record<string, unknown>>) {
      byKey.set(`${row[parentCol]}:${row.paragraph_number}`, (row.body_text as string) || "");
    }

    for (const it of valid) {
      const parent = (it as Record<string, unknown>)[parentCol] as string;
      const before = byKey.get(`${parent}:${it.paragraph_number - 1}`);
      const after = byKey.get(`${parent}:${it.paragraph_number + 1}`);
      if (before || after) result.set(it.id, { before, after });
    }
  };

  await Promise.all([
    load<ProseHit>("prose_paragraphs", "chapter_id", prose),
    load<TranscriptHit>("transcript_paragraphs", "transcript_id", transcripts),
    load<LetterHit>("letter_paragraphs", "letter_id", letters),
  ]);

  return result;
}

// =====================================================
// MAIN-FLOW SELECTION (top N across all types) + VERBATIM KEY ANSWERS
// =====================================================
interface MainItem { type: PassageType; data: VerseHit | ProseHit | TranscriptHit | LetterHit; score: number; }

/**
 * Selects the top MAIN_FLOW_COUNT passages across ALL types by rerank score, for
 * the woven Article. References / sidebar / Dig Deeper keep the full relevant set
 * — only the main flow is shortened. Applies the SAME admission filters the
 * article uses, so what's selected is exactly what can render (Article == its keys).
 */
function selectMainFlow(verses: VerseHit[], prose: ProseHit[], transcripts: TranscriptHit[], letters: LetterHit[]) {
  const pool: MainItem[] = [];
  for (const v of verses) {
    if ((v.translation || "").trim().length < 10 && (v.purport || "").trim().length < 50) continue;
    pool.push({ type: "verse", data: v, score: v.score || 0 });
  }
  const seenBook = new Set<string>();
  for (const p of prose) {
    const b = (p.body_text || "").trim();
    if (b.length < 80 || isMostlySanskrit(b)) continue;
    if (seenBook.has(p.book_slug)) continue; // one prose per book, matching the article
    seenBook.add(p.book_slug);
    pool.push({ type: "prose", data: p, score: p.score || 0 });
  }
  for (const t of transcripts) {
    const b = (t.body_text || "").trim();
    if (b.length < 80 || isMostlySanskrit(b)) continue;
    pool.push({ type: "lecture", data: t, score: t.score || 0 });
  }
  for (const l of letters) {
    const b = (l.body_text || "").trim();
    if (b.length < 80) continue;
    pool.push({ type: "letter", data: l, score: l.score || 0 });
  }
  pool.sort((a, b) => b.score - a.score);

  // Drop near-identical twins from the main flow (e.g. the same purport text under
  // two book names). Mechanical only — match on the DISPLAYED text being
  // substantially the same (normalized prefix), keep the best-ranked (pool is sorted
  // desc by score), and let the dropped twin remain available in References / overflow.
  const sigOf = (it: MainItem): string => {
    let text: string;
    if (it.type === "verse") {
      const v = it.data as VerseHit;
      const purport = (v.purport || "").trim();
      // Dedupe verses on the PURPORT when present (the "same purport text under two
      // book names" case); fall back to the translation when there is no purport.
      text = purport.length > 80 ? purport : (v.translation || "");
    } else {
      text = (it.data as ProseHit | TranscriptHit | LetterHit).body_text || "";
    }
    // A long normalized prefix: exact/near-exact twins collide, while distinct
    // passages that merely share a formulaic opening diverge before the window ends.
    return normalizeForMatch(text.slice(0, 1200)).slice(0, 400);
  };
  const seenSig = new Set<string>();
  const items: MainItem[] = [];
  for (const it of pool) {
    const sig = sigOf(it);
    if (sig && seenSig.has(sig)) continue;
    if (sig) seenSig.add(sig);
    items.push(it);
    if (items.length >= MAIN_FLOW_COUNT) break;
  }

  // ── Guided-study ordering ──
  // The essay opens with a primary verse — the top verse preferring BG/SB and
  // a purport-bearing anchor (a scored verse without a purport yields the
  // anchor slot to the nearest purport-bearing one) — followed by the best
  // lecture and the best letter, so every answer walks book → lecture →
  // letter before the remaining score-ordered flow. The pool arrives HIS-only
  // (provenance policy runs upstream).
  const isPreferred = (v: VerseHit) => ["BG", "SB"].includes((v.scripture || "").toUpperCase());
  const hasPurport = (v: VerseHit) => (v.purport || "").trim().length >= 50;

  // If the top-10 cut missed lectures/letters entirely, pull the best one of
  // each back in from the pool (swapping out the lowest-scored tail items) —
  // the guided flow wants his spoken and written voice beside the verse.
  for (const wanted of ["lecture", "letter"] as const) {
    if (items.some(i => i.type === wanted)) continue;
    const candidate = pool.find(i => i.type === wanted && !seenSig.has(sigOf(i)));
    if (!candidate) continue;
    if (items.length >= MAIN_FLOW_COUNT) items.pop(); // lowest-scored tail yields its slot
    const sig = sigOf(candidate);
    if (sig) seenSig.add(sig);
    items.push(candidate);
  }

  const verseItems = items.filter(i => i.type === "verse");
  const primary =
    verseItems.find(i => isPreferred(i.data as VerseHit) && hasPurport(i.data as VerseHit)) ||
    verseItems.find(i => hasPurport(i.data as VerseHit)) ||
    verseItems.find(i => isPreferred(i.data as VerseHit)) ||
    verseItems[0];
  const bestLecture = items.find(i => i.type === "lecture");
  const bestLetter = items.find(i => i.type === "letter");
  const head = [primary, bestLecture, bestLetter].filter((x): x is MainItem => !!x);
  const headIds = new Set(head.map(h => h.data.id));
  const ordered = [...head, ...items.filter(i => !headIds.has(i.data.id))];

  return {
    items: ordered,
    verses: ordered.filter(i => i.type === "verse").map(i => i.data as VerseHit),
    prose: ordered.filter(i => i.type === "prose").map(i => i.data as ProseHit),
    transcripts: ordered.filter(i => i.type === "lecture").map(i => i.data as TranscriptHit),
    letters: ordered.filter(i => i.type === "letter").map(i => i.data as LetterHit),
  };
}

/**
 * Neutral framing text for the woven essay (Hard Rule 1): names the topic, the
 * sources, and the speaker — never states a teaching in the narrator's voice.
 * Single source for both the structured `intro`/`conclusion` fields and the
 * legacy narrative HTML string.
 */
function computeFraming(
  question: string,
  verses: VerseHit[],
  prose: ProseHit[],
  transcripts: TranscriptHit[] = [],
  letters: LetterHit[] = [],
  topic: string | null = null,
): { intro: string; conclusion: string } {
  const bookNames = [...new Set([
    ...verses.map(x => getBookName(x.book_slug || x.scripture?.toLowerCase() || "")),
    ...prose.map(x => getBookName(x.book_slug || "")),
  ].filter(Boolean))];
  const bookListStr = bookNames.length === 1
    ? bookNames[0]
    : bookNames.length === 2
      ? `${bookNames[0]} and ${bookNames[1]}`
      : `${bookNames.slice(0, 2).join(", ")}, and ${bookNames.length > 3 ? "other texts" : bookNames[2]}`;

  const sourceKinds: string[] = [];
  if (bookNames.length > 0) sourceKinds.push(bookListStr);
  if (transcripts.length > 0) sourceKinds.push("his recorded lectures");
  if (letters.length > 0) sourceKinds.push("his letters");
  const sourcesStr = sourceKinds.length === 0
    ? "his books, lectures, and letters"
    : sourceKinds.length === 1
      ? sourceKinds[0]
      : sourceKinds.length === 2
        ? `${sourceKinds[0]} and ${sourceKinds[1]}`
        : `${sourceKinds.slice(0, -1).join(", ")}, and ${sourceKinds[sourceKinds.length - 1]}`;

  // FRAMING INVARIANT: intro/conclusion may name ONLY Śrīla Prabhupāda, book
  // titles from the registry, and source types. Never a per-verse speaker,
  // never a name scraped from transcript text, never invented honorifics.
  //
  // Grammar-safe frames: raw questions never slot into a noun position ("addresses
  // to control the mind"). With a Gemini gerund topic ("controlling the mind") the
  // noun frame works; otherwise the question is quoted whole.
  const displayQuestion = question.trim().replace(/\s+/g, " ");
  const intro = topic
    ? `Śrīla Prabhupāda addresses ${topic} across ${sourcesStr}. Here is what he teaches, in his own words and purports.`
    : `On the question of “${displayQuestion}”, Śrīla Prabhupāda speaks across ${sourcesStr}. Here is what he teaches, in his own words and purports.`;
  const conclusion = topic
    ? `These passages gather Śrīla Prabhupāda's words on ${topic} from ${sourcesStr}. The complete purports, with full context, are one click away on Vedabase.`
    : `These passages gather Śrīla Prabhupāda's words on this question from ${sourcesStr}. The complete purports, with full context, are one click away on Vedabase.`;
  return { intro, conclusion };
}

/** Ordered, structured descriptor of one woven-essay passage for the client. */
function buildMainFlowNode(item: MainItem): { type: "verse" | "prose" | "lecture" | "letter"; id: string; ref: string; url: string } {
  if (item.type === "verse") {
    const v = item.data as VerseHit;
    return { type: "verse", id: v.id, ref: cleanRef(v), url: v.vedabase_url || "" };
  }
  if (item.type === "prose") {
    const p = item.data as ProseHit;
    const noVedabase = NO_VEDABASE_BOOKS.has(p.book_slug?.toLowerCase());
    return { type: "prose", id: p.id, ref: getBookName(p.book_slug), url: noVedabase ? "" : (p.vedabase_url || "") };
  }
  if (item.type === "lecture") {
    const t = item.data as TranscriptHit;
    const year = t.date ? new Date(t.date).getFullYear().toString() : "";
    const ref = ["Lecture", year, t.location].filter(Boolean).join(" · ");
    return { type: "lecture", id: t.id, ref, url: t.vedabase_url || "" };
  }
  const l = item.data as LetterHit;
  const year = l.date ? new Date(l.date).getFullYear().toString() : "";
  const ref = ["Letter", l.recipient ? `to ${l.recipient}` : "", year].filter(Boolean).join(" · ");
  return { type: "letter", id: l.id, ref, url: l.vedabase_url || "" };
}

/** Builds a verbatim key-answer line + anchor id for one main-flow passage. */
function buildKeyAnswer(item: MainItem, queryTerms: string[]): { id: string; ref: string; line: string } {
  if (item.type === "verse") {
    const v = item.data as VerseHit;
    return { id: v.id, ref: cleanRef(v), line: keyLineFor({ type: "verse", translation: v.translation, queryTerms }) };
  }
  if (item.type === "prose") {
    const p = item.data as ProseHit;
    return { id: p.id, ref: getBookName(p.book_slug), line: keyLineFor({ type: "prose", body: p.body_text, matchedChunkText: undefined, queryTerms }) };
  }
  if (item.type === "lecture") {
    const t = item.data as TranscriptHit;
    const year = t.date ? new Date(t.date).getFullYear().toString() : "";
    const ref = ["Lecture", year, t.location].filter(Boolean).join(" · ");
    return { id: t.id, ref, line: keyLineFor({ type: "lecture", body: t.body_text, queryTerms }) };
  }
  const l = item.data as LetterHit;
  const year = l.date ? new Date(l.date).getFullYear().toString() : "";
  const ref = ["Letter", l.recipient ? `to ${l.recipient}` : "", year].filter(Boolean).join(" · ");
  return { id: l.id, ref, line: keyLineFor({ type: "letter", body: l.body_text, queryTerms }) };
}

// =====================================================
// PROVENANCE ANNOTATION
// =====================================================
/**
 * Story-speaker maps computed per chapter from uvāca markers (14-verse-speaker).
 * The corpus is fixed, so chapters are memoized for the life of the instance.
 */
const chapterSpeakerCache = new Map<string, Map<string, SpeakerState>>();

/**
 * Batched lookup of confident story speakers for the given BG/SB verse hits:
 * one query fetches every uncached chapter's verses (id, verse_number,
 * transliteration), then chapterSpeakerWalk carries the most recent uvāca
 * speaker forward within each chapter. Verses without a confident speaker are
 * simply absent from the returned map — never guessed.
 */
async function fetchVerseSpeakerMap(verses: VerseHit[]): Promise<Map<string, SpeakerState>> {
  const result = new Map<string, SpeakerState>();
  const wanted = verses.filter(v =>
    v.chapter_id && ["BG", "SB"].includes((v.scripture || "").toUpperCase()),
  );
  if (wanted.length === 0) return result;

  const missing = [...new Set(wanted.map(v => v.chapter_id))]
    .filter((id): id is string => !!id && !chapterSpeakerCache.has(id));
  if (missing.length > 0) {
    try {
      const supabase = getSupabaseAdmin();
      const { data, error } = await supabase
        .from("verses")
        .select("id, chapter_id, scripture, verse_number, transliteration")
        .in("chapter_id", missing);
      if (error) throw error;
      const byChapter = new Map<string, { id: string; scripture: string; verse_number: string; transliteration: string | null }[]>();
      for (const row of data || []) {
        const list = byChapter.get(row.chapter_id) || [];
        list.push(row);
        byChapter.set(row.chapter_id, list);
      }
      for (const [chapterId, rows] of byChapter) {
        chapterSpeakerCache.set(chapterId, chapterSpeakerWalk(rows, rows[0]?.scripture || ""));
      }
      for (const id of missing) {
        if (!chapterSpeakerCache.has(id)) chapterSpeakerCache.set(id, new Map());
      }
    } catch (err) {
      console.error("[fetchVerseSpeakerMap] Error:", err);
      return result; // no speakers is always a safe outcome
    }
  }

  for (const v of wanted) {
    const s = v.chapter_id ? chapterSpeakerCache.get(v.chapter_id)?.get(v.id) : undefined;
    if (s) result.set(v.id, s);
  }
  return result;
}

/**
 * Stamp every outgoing hit with its authorship (HIS / NOT_HIS / MIXED_VERIFY)
 * and a plain-language provenance note, derived in app code (12-provenance) —
 * never from books.author. Covers narrative AND overflow sets so every
 * surface (essay, references, dig deeper, preview sheets) can label passages.
 * Confident uvāca story speakers are attached to verses from speakerMap.
 */
function annotateProvenance(
  verses: VerseHit[],
  prose: ProseHit[],
  transcripts: TranscriptHit[],
  letters: LetterHit[],
  speakerMap?: Map<string, SpeakerState>,
  queryTerms: string[] = [],
): void {
  for (const v of verses) {
    const slug = (v.book_slug || v.scripture || "").toLowerCase();
    v.authorship = authorshipFor({
      kind: "verse",
      bookSlug: slug,
      vedabaseUrl: v.vedabase_url,
      canto: v.canto_or_division,
      chapter: v.chapter_number,
    });
    v.provenanceNote = provenanceNoteFor(slug, v.authorship);
    const s = speakerMap?.get(v.id);
    if (s) {
      v.speaker = s.speaker;
      v.speakerTo = s.speakerTo;
    }
  }
  for (const p of prose) {
    p.authorship = authorshipFor({ kind: "prose", bookSlug: p.book_slug });
    p.provenanceNote = provenanceNoteFor(p.book_slug, p.authorship);
  }
  for (const t of transcripts) {
    t.authorship = authorshipFor({ kind: "lecture" });
    t.provenanceNote = "";
    // "Prabhupāda replying" is claimed only when the paragraph has Name: turn
    // prefixes AND the matched sentence lies in a segment he himself speaks.
    // Prefix-less continuation paragraphs get no speaker chip — never guess.
    const ranges = allowedEmphasisRanges(t.body_text || "");
    if (ranges && locateMatchedSentence(t.body_text || "", undefined, queryTerms, ranges)) {
      t.speaker = "Prabhupāda replying";
    }
  }
  for (const l of letters) {
    l.authorship = authorshipFor({ kind: "letter" });
    l.provenanceNote = "";
  }
}

// =====================================================
// SEARCH PIPELINE (shared by the JSON and SSE handlers)
// =====================================================

/** Request metadata threaded into telemetry (never used for retrieval). */
interface SearchRequestContext {
  userAgent?: string | null;
  referrer?: string | null;
  visitorId?: string | null;
}

interface SearchDurations {
  embeddingMs?: number;
  searchMs?: number;
  synthesisMs?: number;
  totalMs?: number;
}

/**
 * Writes one search_logs row via the log_search RPC and returns its id.
 * Shared by the fresh-pipeline path and the cache-hit path (method: "cache").
 * Telemetry never blocks or breaks a search — failures log and return null.
 */
async function logSearchRow(
  query: string,
  result: Record<string, unknown>,
  method: string,
  durations: SearchDurations,
  ctx: SearchRequestContext,
): Promise<string | null> {
  try {
    const supabase = getSupabaseAdmin();
    const mainFlowItems = (result.mainFlowItems as { type: string; id: string }[] | undefined) || [];
    const { data, error } = await supabase.rpc("log_search", {
      p_query: query,
      p_visitor_id: ctx.visitorId ?? null,
      p_total_results: (result.totalResults as number) ?? 0,
      p_verse_ids: (result.articleVerseIds as string[] | undefined) || [],
      p_prose_ids: mainFlowItems.filter(i => i.type === "prose").map(i => i.id),
      p_books_returned: ((result.books as { name: string }[] | undefined) || []).map(b => b.name),
      p_search_method: method,
      p_search_duration_ms: durations.searchMs ?? null,
      p_embedding_duration_ms: durations.embeddingMs ?? null,
      p_synthesis_duration_ms: durations.synthesisMs ?? null,
      p_total_duration_ms: durations.totalMs ?? null,
      p_narrative_length: typeof result.narrative === "string" ? result.narrative.length : null,
      p_source: "web",
      p_user_agent: ctx.userAgent ?? null,
      p_referrer: ctx.referrer ?? null,
      p_query_variants: (result.queryVariants as string[] | undefined) || [],
    });
    if (error) throw error;
    return (data as string) ?? null;
  } catch (err) {
    console.error("[log_search] failed (search unaffected):", err);
    return null;
  }
}

async function runSearchPipeline(
  query: string,
  mode: string,
  pipeline: PipelineContext,
  onStage?: OnStage,
  ctx: SearchRequestContext = {},
): Promise<Record<string, unknown>> {
  onStage?.("understood");
  const tStart = Date.now();

  // Fire search and spelling check in parallel. Spelling is enrichment, not
  // evidence, so it is allowed to degrade — but the softening is recorded
  // rather than swallowed.
  const spellingDb = getSupabaseAdmin() as unknown as RpcCapableClient;
  const [searchResults, spellData] = await Promise.all([
    hybridSearch(query, pipeline, onStage),
    rpcOrDegrade<Record<string, string>[] | null>(
      spellingDb,
      "suggest_spelling",
      { raw_query: query },
      { stage: "enrichment:spelling", requestId: pipeline.requestId },
      null,
      pipeline.degraded,
    ),
  ]);
  const searchMs = Date.now() - tStart;

  const { verses, prose, transcripts, letters, directVerse } = searchResults;
  const queryVariants = searchResults.queryVariants || [];
  const topic = searchResults.topic ?? null;
  const embeddingMs = searchResults.embeddingMs;
  onStage?.("reranking");
  {

    // "Did you mean?" — extract spelling suggestion
    let suggestion: string | null = null;
    let suggestionDisplay: string | null = null;
    if (spellData && spellData.length > 0 && spellData[0].suggested_query) {
      const suggested = spellData[0].suggested_query;
      if (suggested.toLowerCase() !== query.toLowerCase()) {
        suggestion = suggested;
        suggestionDisplay = spellData[0].display_query || suggested;
      }
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

    // ── Provenance policy: only Śrīla Prabhupāda's own words reach heroes, the
    // woven essay, citations, and framing. NOT-HIS / MIXED-VERIFY passages
    // (spl/rkd/mbk, bs, nbs/mms, SB ≥ 10.14) are routed to Dig Deeper with
    // plain-language labels — never silently deleted, fully reversible via
    // PROVENANCE_POLICY. Exception: a verse the user explicitly looked up by
    // reference stays in the main flow, labeled.
    const policyRoutedVerses: VerseHit[] = [];
    const policyRoutedProse: ProseHit[] = [];
    if (PROVENANCE_POLICY.restrictedToDigDeeperOnly) {
      const keepVerses: VerseHit[] = [];
      for (const v of narrativeVerses) {
        const a = authorshipFor({
          kind: "verse",
          bookSlug: (v.book_slug || v.scripture || "").toLowerCase(),
          vedabaseUrl: v.vedabase_url,
          canto: v.canto_or_division,
          chapter: v.chapter_number,
        });
        if (a === "HIS" || v.id === directVerse?.id) keepVerses.push(v);
        else policyRoutedVerses.push(v);
      }
      narrativeVerses = keepVerses;

      const keepProse: ProseHit[] = [];
      for (const p of narrativeProse) {
        if (authorshipFor({ kind: "prose", bookSlug: p.book_slug }) === "HIS") keepProse.push(p);
        else policyRoutedProse.push(p);
      }
      narrativeProse = keepProse;
    }

    // Overflow for "dig deeper" modal — apply multi-signal relevance pipeline
    const rankedOverflow = rankAndFilterOverflow(query, rawOverflowVerses, rawOverflowProse);

    // Policy-routed passages join Dig Deeper AFTER the relevance filter runs —
    // they bypass it by design so exclusion from the essay never becomes
    // silent deletion. Merged by score, deduped by id.
    const mergeByScore = <T extends { id: string; score?: number }>(base: T[], extra: T[]): T[] => {
      const seen = new Set(base.map(x => x.id));
      return [...base, ...extra.filter(x => !seen.has(x.id))]
        .sort((a, b) => (b.score || 0) - (a.score || 0));
    };
    const overflowVerses = mergeByScore(rankedOverflow.verses, policyRoutedVerses);
    const overflowProse = mergeByScore(rankedOverflow.prose, policyRoutedProse);

    if (rankedOverflow.totalFiltered > 0) {
      console.log(`[Relevance] Filtered ${rankedOverflow.totalFiltered} low-relevance overflow results`);
    }

    // Salient query terms for diacritic-insensitive matched-line highlighting
    // (computed once; threaded into the server Article and sent to the client so
    // References highlights identically).
    const queryTerms = extractQueryTerms(query);

    // Fetch neighbouring paragraphs for the relevant prose/lecture/letter set and
    // attach them to the hits, so the fold can expand to the full section (matched
    // paragraph + neighbours) on the client — in BOTH the Article and References.
    const [neighbours, speakerMap] = await Promise.all([
      fetchNeighbourMap(narrativeProse, narrativeTranscripts, narrativeLetters),
      fetchVerseSpeakerMap([...narrativeVerses, ...overflowVerses]),
    ]);
    const attachNeighbours = <T extends { id: string; before?: string; after?: string }>(items: T[]) => {
      for (const it of items) {
        const ctx = neighbours.get(it.id);
        if (ctx) { it.before = ctx.before; it.after = ctx.after; }
      }
    };
    attachNeighbours(narrativeProse);
    attachNeighbours(narrativeTranscripts);
    attachNeighbours(narrativeLetters);

    // Stamp authorship + provenance notes on everything the client will see —
    // the narrative set and the dig-deeper overflow alike.
    annotateProvenance(
      [...narrativeVerses, ...overflowVerses],
      [...narrativeProse, ...overflowProse],
      [...narrativeTranscripts, ...overflowTranscripts],
      [...narrativeLetters, ...overflowLetters],
      speakerMap,
      queryTerms,
    );

    const verseUrlMap = buildVerseUrlMap(narrativeVerses);
    const metadata = buildMetadataAndCitations(query, narrativeVerses, narrativeProse, narrativeTranscripts, narrativeLetters);

    // Main flow = top MAIN_FLOW_COUNT passages across ALL types by rerank score,
    // reordered so the essay opens primary verse → best lecture → best letter.
    // References keeps the full relevant set above; only the Article is shortened.
    let mainFlow = selectMainFlow(narrativeVerses, narrativeProse, narrativeTranscripts, narrativeLetters);
    onStage?.("weaving");

    // ── Verbatim validator (non-negotiable): every block the essay renders is
    // re-fetched from its source row and asserted verbatim; failures are
    // dropped, never rendered. Runs BEFORE keyAnswers/mainFlowItems/framing so
    // every downstream count stays consistent automatically.
    const validation = await validateMainFlow(mainFlow.items, getSupabaseAdmin() as unknown as SourceFetchClient);
    let droppedBlocks = validation.droppedBlocks;
    if (validation.keptItems.length !== mainFlow.items.length) {
      const kept = validation.keptItems;
      mainFlow = {
        items: kept,
        verses: kept.filter(i => i.type === "verse").map(i => i.data as VerseHit),
        prose: kept.filter(i => i.type === "prose").map(i => i.data as ProseHit),
        transcripts: kept.filter(i => i.type === "lecture").map(i => i.data as TranscriptHit),
        letters: kept.filter(i => i.type === "letter").map(i => i.data as LetterHit),
      };
    }

    // ── Chapter context for the primary verse (one get_verse_context RPC). ──
    const primaryVerse = mainFlow.items.find(i => i.type === "verse")?.data as VerseHit | undefined;
    let primaryVerseContext: {
      verseId: string;
      before: { id: string; ref: string; translation: string; vedabase_url?: string; position: number }[];
      after: { id: string; ref: string; translation: string; vedabase_url?: string; position: number }[];
    } | null = null;
    if (primaryVerse) {
      {
        // Chapter context enriches the answer but is not the answer, so it may
        // degrade — visibly, in degradedStages.
        const ctxRows = await rpcOrDegrade<{ id: string; scripture: string; verse_number: string; translation: string; vedabase_url: string | null; rel_position: number }[] | null>(
          getSupabaseAdmin() as unknown as RpcCapableClient,
          "get_verse_context",
          { p_verse_id: primaryVerse.id, p_radius: 1 },
          { stage: "enrichment:verse_context", requestId: pipeline.requestId },
          null,
          pipeline.degraded,
        );
        if (ctxRows && ctxRows.length > 0) {
          const toLine = (r: { id: string; scripture: string; verse_number: string; translation: string; vedabase_url: string | null; rel_position: number }) => ({
            id: r.id,
            // Neighbours share the primary verse's chapter, so its canto/chapter
            // numbers complete the reference.
            ref: cleanRef({
              scripture: r.scripture,
              canto_or_division: primaryVerse.canto_or_division,
              chapter_number: primaryVerse.chapter_number,
              verse_number: r.verse_number,
            }),
            translation: r.translation || "",
            vedabase_url: r.vedabase_url || undefined,
            position: r.rel_position,
          });
          primaryVerseContext = {
            verseId: primaryVerse.id,
            before: ctxRows.filter((r: { rel_position: number }) => r.rel_position < 0).map(toLine),
            after: ctxRows.filter((r: { rel_position: number }) => r.rel_position > 0).map(toLine),
          };
        }
      }
    }

    // Verbatim key answers for the woven main-flow passages (no AI; never paraphrased).
    // Dedupe the same way — two distinct passages can surface the same matched line,
    // and the list must never repeat a line.
    const keyAnswers: { id: string; ref: string; line: string }[] = [];
    const seenKeyLine = new Set<string>();
    for (const it of mainFlow.items) {
      const ka = buildKeyAnswer(it, queryTerms);
      if (!ka.line || !ka.line.trim()) continue; // skip empty / non-substantive lines — never a bare fragment
      // Verbatim check for the derived line too: it must appear inside the
      // re-fetched source text (validator supplies it; fail-open when absent).
      if (validation.validated && validation.sourceText.size > 0) {
        const src = validation.sourceText.get(ka.id);
        if (src && !src.includes(normalizeVerbatim(ka.line))) {
          droppedBlocks += 1;
          console.error(`[verbatim-validator] dropped key answer for ${ka.ref}: line not verbatim`);
          continue;
        }
      }
      const norm = normalizeForMatch(ka.line).slice(0, 200);
      if (norm && seenKeyLine.has(norm)) continue;
      if (norm) seenKeyLine.add(norm);
      keyAnswers.push(ka);
    }

    // Article verse IDs = the woven verses (drives Dig Deeper "In article" badges).
    const articleVerseIds = mainFlow.verses.map(v => v.id);

    // Ordered structured descriptors for the woven essay (the client renders these
    // as passage cards, in most-important-first order, reusing the shared fold
    // helpers for the verbatim bodies). Neutral framing sent separately.
    const mainFlowItems = mainFlow.items.map(buildMainFlowNode);
    const { intro, conclusion } = computeFraming(query, mainFlow.verses, mainFlow.prose, mainFlow.transcripts, mainFlow.letters, topic);

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
      queryTerms,
      keyAnswers,
      mainFlowItems,
      intro,
      conclusion,
      queryVariants,
      topic,
      validated: validation.validated,
      droppedBlocks,
      primaryVerseContext,
    };

    // ── Strategy A: Template-built article (zero AI calls, instant).
    // References mode returns the same metadata with an empty narrative.
    const narrative = mode === "references"
      ? ""
      : buildTemplateArticle(query, mainFlow.verses, mainFlow.prose, mainFlow.transcripts, mainFlow.letters, queryTerms, topic);
    const result: Record<string, unknown> = {
      ...fullMetadata,
      narrative,
      // Retrieval ran to completion. This is what distinguishes an honest
      // "no direct evidence" answer from a failure — `validated` keeps its
      // existing meaning (every quoted block verbatim-checked).
      retrievalStatus: "complete",
      degradedStages: pipeline.degraded.list(),
      disabledLanes: DISABLED_LANES,
    };

    // Telemetry: one search_logs row per fresh pipeline run (Task 14). The id
    // rides on the response so thumbs/behavior/citation clicks can attach.
    const totalMs = Date.now() - tStart;
    const searchLogId = await logSearchRow(query, result, "hybrid_rag_fusion", {
      embeddingMs,
      searchMs,
      synthesisMs: totalMs - searchMs,
      totalMs,
    }, ctx);
    return { ...result, searchLogId };
  }
}

/**
 * Cache-aware pipeline entry — both handlers go through here.
 *
 * Two invariants: only a completed result is ever cached (an error must never
 * become a 24 h cached "no passages found"), and correlation ids are attached
 * AFTER the cache read so a cached body never replays another request's id.
 */
async function getOrComputeResult(
  query: string,
  mode: string,
  pipeline: PipelineContext,
  onStage?: OnStage,
  ctx: SearchRequestContext = {},
): Promise<{ result: Record<string, unknown>; fromCache: boolean }> {
  const key = cacheKey(query, mode);
  const cached = getCached<Record<string, unknown>>(key);
  if (cached) {
    // Cached answers still log a fresh row (method "cache") so feedback on
    // them attributes to a real search_logs id.
    const searchLogId = await logSearchRow(query, cached, "cache", { totalMs: 0 }, ctx);
    return {
      result: { ...cached, searchLogId, requestId: pipeline.requestId },
      fromCache: true,
    };
  }
  const result = await runSearchPipeline(query, mode, pipeline, onStage, ctx);
  // Never cache the per-request searchLogId or requestId — every serving logs
  // its own row and carries its own correlation id.
  const { searchLogId: _perRequest, ...cacheable } = result;
  void _perRequest;
  setCached(key, cacheable);
  return { result: { ...result, requestId: pipeline.requestId }, fromCache: false };
}

// =====================================================
// HANDLERS — plain JSON (default) and SSE (?stream=1)
// =====================================================
/**
 * Maps a thrown pipeline failure to its wire form.
 *
 * Typed failures carry a stable code, an appropriate status (400 for bad input,
 * 503 for infrastructure and required providers) and the correlation id.
 * Everything else is an unexpected 500. No message, SQL or stack ever crosses
 * the boundary — those live in the server logs, joined by request id.
 */
function failureResponseBody(err: unknown, requestId: string): {
  status: number;
  body: Record<string, unknown>;
} {
  if (isSearchError(err)) {
    console.error(
      JSON.stringify({
        level: "error",
        event: "search.failed",
        requestId,
        code: err.code,
        stage: err.stage ?? null,
        name: err.name,
      }),
    );
    return { status: err.status, body: { ...err.toPublicJSON(), request_id: requestId } };
  }
  console.error(
    JSON.stringify({ level: "error", event: "search.unexpected_error", requestId }),
    err,
  );
  return {
    status: 500,
    body: { error: "An error occurred.", code: "internal_error", request_id: requestId },
  };
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const rawQuery = url.searchParams.get("q");
  const mode = url.searchParams.get("mode") || "article";
  const wantStream = url.searchParams.get("stream") === "1";

  const requestId = newRequestId();
  const pipeline: PipelineContext = { requestId, degraded: new DegradationLog(requestId) };

  // Input validation happens before any paid work. Without a length cap one
  // unauthenticated request drives the full Gemini + Voyage + Cohere + RPC
  // fan-out with an arbitrarily large query.
  const query = (rawQuery ?? "").trim();
  let inputError: InvalidSearchInputError | null = null;
  if (!query) {
    inputError = new InvalidSearchInputError("Query 'q' required", { requestId });
  } else if (query.length > MAX_QUERY_CHARS) {
    inputError = new InvalidSearchInputError(
      `Query exceeds ${MAX_QUERY_CHARS} characters`,
      { requestId },
    );
  } else if (!ALLOWED_MODES.has(mode)) {
    inputError = new InvalidSearchInputError(`Unknown mode "${mode}"`, { requestId });
  }
  if (inputError && !wantStream) {
    const { status, body } = failureResponseBody(inputError, requestId);
    return NextResponse.json(body, { status });
  }

  const ctx: SearchRequestContext = {
    userAgent: request.headers.get("user-agent"),
    referrer: request.headers.get("referer"),
    visitorId: request.cookies.get("asp_vid")?.value ?? null,
  };

  if (!wantStream) {
    try {
      const { result } = await getOrComputeResult(query, mode, pipeline, undefined, ctx);
      return NextResponse.json(result);
    } catch (err) {
      const { status, body } = failureResponseBody(err, requestId);
      return NextResponse.json(body, { status });
    }
  }

  // ── SSE stream: stage events as the pipeline advances, then the full result. ──
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const write = (chunk: string) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(chunk)); } catch { closed = true; }
      };
      const send = (event: string, data: unknown) =>
        write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      // Comment heartbeat defeats proxy buffering and keeps the connection alive
      // through the long cold path.
      const heartbeat = setInterval(() => write(`: ping\n\n`), 15000);

      const emitted = new Set<SearchStageKey>();
      const onStage: OnStage = (stage, labelOverride) => {
        if (emitted.has(stage)) return;
        emitted.add(stage);
        const meta = STAGE_META[stage];
        send("stage", { stage, pct: meta.pct, label: labelOverride ?? meta.label });
      };

      try {
        if (inputError) throw inputError;
        const { result, fromCache } = await getOrComputeResult(query, mode, pipeline, onStage, ctx);
        if (fromCache) {
          // Cached answer: replay the stages quickly so the loader still arcs.
          for (const s of STAGE_ORDER) {
            onStage(s);
            await new Promise((r) => setTimeout(r, 120));
          }
        }
        send("result", result);
        send("done", {});
      } catch (err) {
        // Headers are already streamed, so the status code is spent. Emit the
        // typed failure the client listens for — never a fabricated empty
        // `result`, which is what made the outage invisible.
        const { body } = failureResponseBody(err, requestId);
        send("failure", body);
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}