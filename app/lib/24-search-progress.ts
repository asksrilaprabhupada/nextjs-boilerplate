/**
 * 24-search-progress.ts — Neutral progress labels shared by SSE and fallback UI.
 *
 * An unfiltered search may contain other recorded speakers, so progress copy
 * describes evidence and passages without claiming whose words are present.
 */

export const SEARCH_PROGRESS_LABELS = {
  reranking: "Selecting relevant passages…",
  weaving: "Arranging the evidence…",
  idle: "Preparing the evidence…",
} as const;
