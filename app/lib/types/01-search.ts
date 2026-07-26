/**
 * 01-search.ts — Shared search data contract (server ↔ client)
 *
 * The single source of truth for the /api/search response shape. The API route
 * (app/api/search/route.ts) and the results renderer
 * (app/components/results/01-narrative-response.tsx) both import from here so
 * the server and client can never drift. Also defines the SSE stage events the
 * streaming search path emits (?stream=1).
 */
import type { Authorship } from "@/app/lib/12-provenance";

export interface Citation {
  ref: string;
  book: string;
  url: string;
  type: "verse" | "prose" | "transcript" | "letter";
  title: string;
}

export interface VerseHit {
  id: string; scripture: string; verse_number: string; sanskrit_devanagari: string;
  transliteration: string; translation: string; purport: string;
  chapter_id?: string; chapter_number?: string; canto_or_division?: string; chapter_title?: string;
  book_slug?: string; vedabase_url?: string; tags?: string[];
  score?: number; similarity?: number; matchedChunkText?: string;
  authorship?: Authorship; provenanceNote?: string; speaker?: string; speakerTo?: string;
}

export interface ProseHit {
  id: string; book_slug: string; paragraph_number: number; body_text: string;
  chapter_id?: string; chapter_title?: string; vedabase_url?: string; tags?: string[];
  score?: number; similarity?: number; before?: string; after?: string;
  authorship?: Authorship; provenanceNote?: string;
}

export interface TranscriptHit {
  id: string; transcript_id?: string; paragraph_number: number; body_text: string;
  content_type?: string; title?: string; date?: string; location?: string;
  occasion?: string; scripture_ref?: string; vedabase_url?: string;
  tags?: string[]; score?: number; similarity?: number; before?: string; after?: string;
  authorship?: Authorship; provenanceNote?: string; speaker?: string;
}

export interface LetterHit {
  id: string; letter_id?: string; paragraph_number: number; body_text: string;
  content_type?: string; title?: string; date?: string; location?: string;
  recipient?: string; vedabase_url?: string;
  tags?: string[]; score?: number; similarity?: number; before?: string; after?: string;
  authorship?: Authorship; provenanceNote?: string;
}

export interface KeyAnswer { id: string; ref: string; line: string; }

export interface BookGroup {
  slug: string; name: string; verses: VerseHit[]; prose: ProseHit[];
  transcripts?: TranscriptHit[]; letters?: LetterHit[];
}

/** Ordered structured descriptor of one woven-essay passage (from the server). */
export interface MainFlowNode {
  type: "verse" | "prose" | "lecture" | "letter";
  id: string;
  ref: string;
  url: string;
}

/** Chapter neighbours of the essay's primary verse (get_verse_context RPC). */
export interface VerseContextLine {
  id: string; ref: string; translation: string; vedabase_url?: string; position: number;
}
export interface VerseContext {
  /** The primary verse these neighbours surround — the strip renders under its card. */
  verseId: string;
  before: VerseContextLine[];
  after: VerseContextLine[];
}

export interface SearchResults {
  query: string;
  narrative: string;
  totalResults: number;
  citations: Citation[];
  books: BookGroup[];
  /** Legacy fields kept optional for older callers; the live API does not send them. */
  keywords?: string[];
  synonyms?: string[];
  relatedConcepts?: string[];
  overflowVerses?: VerseHit[];
  overflowProse?: ProseHit[];
  overflowTranscripts?: TranscriptHit[];
  overflowLetters?: LetterHit[];
  totalVerses?: number;
  totalProse?: number;
  totalTranscripts?: number;
  totalLetters?: number;
  articleVerseIds?: string[];
  suggestion?: string | null;
  suggestionDisplay?: string | null;
  queryTerms?: string[];
  keyAnswers?: KeyAnswer[];
  mainFlowItems?: MainFlowNode[];
  intro?: string;
  conclusion?: string;
  /** Multi-query expansion (RAG-Fusion): the Gemini variant questions searched alongside the original. */
  queryVariants?: string[];
  /** 2–5 word gerund topic phrase from the variant call (framing aid); null when unavailable. */
  topic?: string | null;
  /** True when every quoted block was verbatim-verified against its source row. */
  validated?: boolean;
  /** Number of blocks dropped by the verbatim validator (0 in the normal case). */
  droppedBlocks?: number;
  /** search_logs row id for this search — feedback/behavior telemetry attaches to it. */
  searchLogId?: string | null;
  /** Chapter neighbours of the primary essay verse. */
  primaryVerseContext?: VerseContext | null;

  /* ── Integrity metadata ── */

  /** Correlates this response with server logs. Non-sensitive. */
  requestId?: string;
  /**
   * "complete" means retrieval ran end to end, so an empty result is a genuine
   * absence of direct evidence rather than a failure. A failed search never
   * carries this field — it returns a typed error instead.
   */
  retrievalStatus?: "complete";
  /** Optional lanes that softened on this request. Empty in the normal case. */
  degradedStages?: DegradedStage[];
  /** Lanes switched off in this build, e.g. ["tags"] during Phase A. */
  disabledLanes?: string[];
}

/** One optional lane that failed and was softened rather than fatal. */
export interface DegradedStage {
  stage: string;
  /** An RPC or provider name. Never carries query text or arguments. */
  source: string;
  code: string;
}

/* ── SSE stage events (?stream=1) ── */

export type SearchStageKey = "understood" | "expanding" | "searching" | "reranking" | "weaving";

export interface SearchStageEvent {
  stage: SearchStageKey;
  /** Target percent for the loader bar at this stage. */
  pct: number;
  /** Human label shown under the mandala. */
  label: string;
}
