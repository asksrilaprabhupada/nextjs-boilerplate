/**
 * 22-search-navigation.ts — Pure construction of internal search URLs.
 *
 * Every follow-up path uses this helper so a speaker-only search stays
 * speaker-only until the reader explicitly turns that filter off.
 */

export function buildSearchHref(question: string, speakerOnly = false): string {
  const href = `/search?q=${encodeURIComponent(question.trim())}`;
  return speakerOnly ? `${href}&only_his=1` : href;
}
