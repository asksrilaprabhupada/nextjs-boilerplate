/**
 * 22-search-navigation.ts — Pure construction of internal search URLs.
 *
 * Every follow-up path uses this helper so internal search links share one
 * canonical, question-only URL shape.
 */

export function buildSearchHref(question: string): string {
  return `/search?q=${encodeURIComponent(question.trim())}`;
}
