/**
 * 01-search.ts — Shared search data contract (server ↔ client)
 *
 * The single source of truth for the /api/search response shape. The API route
 * (app/api/search/route.ts) and the results renderer
 * (app/components/results/01-narrative-response.tsx) both import from here so
 * the server and client can never drift. Also defines the SSE stage events the
 * streaming search path emits (?stream=1).
 *
 * THE WORDS TRAVEL IN THE RESPONSE. `passages` carries every kept passage with
 * its actual text — translation, purport, body, sanskrit — in the reranker's
 * order. The page prints the list from first to last; nothing on the client
 * looks anything up, and there is no second list the passages must be joined
 * against. The old shape (a `books` grouping holding the data, `mainFlowItems`
 * holding the order, `overflow…` holding the rest) required exactly that join,
 * and when the grouping arrived empty the page had names with no words — a
 * blank page. That shape is gone.
 */
import type { Authorship } from "@/app/lib/12-provenance";

export interface Citation {
  ref: string;
  book: string;
  url: string;
  type: "verse" | "prose" | "transcript" | "letter";
  title: string;
}

/**
 * One passage, complete: identity, the words themselves, who and when, the
 * server-computed label line, and the relevance score that kept it. Everything
 * a card needs to render, with no look-up anywhere.
 */
export interface SearchPassage {
  /** Namespaced key, e.g. "verse:<uuid>". Stable within a response. */
  id: string;
  type: "verse" | "purport" | "book" | "lecture" | "letter";
  reference: string | null;
  /** Vedabase link, when the source has one. */
  url: string | null;

  /* ── the words — exact stored text, verbatim-verified ── */
  /** Translation for verses; body text for everything else. */
  text: string;
  sanskrit: string | null;
  transliteration: string | null;
  synonyms: string | null;
  /** The verse's own purport, for verse passages that have one. */
  purport: string | null;

  /* ── who and when ── */
  speaker: string | null;
  recipient: string | null;
  date: string | null;
  location: string | null;

  /* ── labelling, computed once on the server so every surface agrees ── */
  /** "TYPE · SOURCE · SPEAKER" line, e.g. "Bhagavad-gītā 6.34 · Translation". */
  label: string;
  /** Amber authorship warning; empty when the words are his. */
  provenanceNote: string;
  /** Label for the folded purport under a verse card, when one exists. */
  purportLabel: string | null;
  /** Framing the reader must see (letters, recorded exchanges), or null. */
  contextNotice: string | null;

  /* ── relevance ── */
  /** Reranker score that kept this passage; null when the reranker was down. */
  rerankScore: number | null;
  /** How many other places this same text appears (collapsed duplicates). */
  alsoAppearsIn: number;
}

/**
 * One second-tier passage: everything that survived retrieval but was not
 * rendered in full. Citation, label and a sentence-safe snippet — enough to
 * scan, cite and follow to Vedabase. Built from retrieval data (not re-fetched:
 * verification is for displayed teaching text, and a citation line shows none),
 * which is also why the snippet is a preview and never quoted as his words.
 */
export interface AdditionalSearchPassage {
  /** Namespaced key, e.g. "verse:<uuid>". Stable within a response. */
  id: string;
  type: "verse" | "purport" | "book" | "lecture" | "letter";
  reference: string | null;
  /** Vedabase link when one can be derived from the reference; often null. */
  url: string | null;
  /** Server-computed label line. Never claims authorship it cannot prove. */
  label: string;
  /** Amber warning (e.g. a lecture line spoken by a guest); empty otherwise. */
  provenanceNote: string;
  /** One line, never cut mid-sentence (see search-v2/snippet.ts). */
  snippet: string;
  speaker: string | null;
  recipient: string | null;
  date: string | null;
  location: string | null;
  rerankScore: number | null;
}

/* ── Legacy hit shapes ──
   Still used by the retained Dig Deeper drawer and the shared label helpers
   (13-passage-label). The live response no longer carries them. */

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

export interface SearchResults {
  query: string;
  /**
   * The MAIN TIER: every passage rendered in full, words included, in the
   * RERANKER'S order. The page prints this list as it arrives — never re-sorted.
   */
  passages: SearchPassage[];
  /**
   * The SECOND TIER: every other passage that survived retrieval, as
   * citations with snippets. Collapsed on the page, complete in the payload —
   * nothing the engine found is dropped.
   */
  additional: AdditionalSearchPassage[];
  additionalCount: number;
  /**
   * Set only when the payload tripwire fired and the additional array was
   * truncated to fit the function response limit. Should never happen with the
   * tier caps in place — its presence is a bug report, not a feature.
   */
  additionalTruncated?: boolean;
  /** The honest total: passages.length + additionalCount. */
  totalResults: number;
  citations: Citation[];
  /** Honest page title (the article plan's, or a deterministic one). */
  intro?: string;
  /** Bare verse row ids among the passages — telemetry attribution. */
  articleVerseIds?: string[];
  suggestion?: string | null;
  suggestionDisplay?: string | null;
  queryTerms?: string[];
  /** Follow-up questions offered under the answer, when available. */
  queryVariants?: string[];
  /** True when every passage was verbatim-verified against its source row. */
  validated?: boolean;
  /** Number of passages dropped by the verbatim validator (0 in the normal case). */
  droppedBlocks?: number;
  /** search_logs row id for this search — feedback/behavior telemetry attaches to it. */
  searchLogId?: string | null;

  /* ── Integrity metadata ── */

  /** Correlates this response with server logs. Non-sensitive. */
  requestId?: string;
  /** True when any requested retrieval source was unavailable. */
  degraded: boolean;
  /**
   * "complete" means every requested source completed. "degraded" means the
   * answer is visibly partial; a total failure returns a typed error instead.
   */
  retrievalStatus: "complete" | "degraded";
  /** Public, allowlisted identities for unavailable retrieval sources. */
  degradedSources: DegradedSource[];
  /** Lanes switched off in this build. */
  disabledLanes?: string[];
}

export type FriendlyRetrievalSource =
  | "Scripture verses"
  | "Purports"
  | "Books"
  | "Lectures and conversations"
  | "Letters";

/** The only degradation detail allowed across the browser boundary. */
export interface DegradedSource {
  source: FriendlyRetrievalSource;
  reason: "temporarily unavailable";
}

/* ── SSE stage events (?stream=1) ── */

export type SearchStageKey = "understood" | "expanding" | "searching" | "reranking" | "weaving";

export interface SearchStageEvent {
  stage: SearchStageKey;
  /** Target percent for the loader bar at this stage. */
  pct: number;
  /** Human label shown under the mandala — carries live counts when known. */
  label: string;
  /** Passages found so far, when the pipeline has counted them. */
  found?: number;
}
