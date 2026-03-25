/**
 * Post-processor that finds unlinked verse references in HTML and wraps them
 * in proper <a> tags pointing to Vedabase URLs.
 */

// Matches references like [BG 2.20], [SB 1.2.3], [CC Madhya 8.128], BG 2.20, SB 1.2.3, etc.
// Negative lookbehind ensures we don't match text already inside an <a> tag's inner text.
const VERSE_REF_PATTERN =
  /\[?\b(BG|SB|CC|NOI|ISO|BS)\s+((?:Adi|Madhya|Antya|[\d]+)\s*[.\s]\s*)?(\d+)[.\s](\d+(?:[–-]\d+)?)\]?/gi;

// Vedabase URL builder for known scriptures
function buildVedabaseLink(
  scripture: string,
  division: string | undefined,
  chapter: string,
  verse: string
): string {
  const base = "https://vedabase.io/en/library";
  const s = scripture.toLowerCase();
  const div = division?.trim().replace(/\s+/g, "").toLowerCase();

  if (s === "bg") return `${base}/bg/${chapter}/${verse}/`;
  if (s === "sb" && div) return `${base}/sb/${div}/${chapter}/${verse}/`;
  if (s === "sb") return `${base}/sb/${chapter}/${verse}/`;
  if (s === "cc" && div) return `${base}/cc/${div}/${chapter}/${verse}/`;
  if (s === "noi") return `${base}/noi/${verse}/`;
  if (s === "iso") return `${base}/iso/${verse}/`;
  if (s === "bs") return `${base}/bs/${chapter}/${verse}/`;
  return `${base}/${s}/`;
}

/**
 * Finds unlinked verse references in HTML and wraps them in <a> tags.
 *
 * @param html - The narrative HTML string
 * @param verseUrlMap - Optional map of "REF" → vedabase URL for precise matching
 * @returns Cleaned HTML with all verse references linked
 */
export function ensureVerseLinks(
  html: string,
  verseUrlMap?: Map<string, string>
): string {
  if (!html) return html;

  // Split HTML into segments: inside tags vs. text content
  // We only process text content (not inside existing <a> tags or HTML attributes)
  const parts = html.split(/(<a\b[^>]*>.*?<\/a>|<[^>]+>)/gi);

  const processed = parts.map((part) => {
    // Skip HTML tags and existing <a> links entirely
    if (part.startsWith("<")) return part;

    // Process text content: find and linkify verse references
    return part.replace(
      VERSE_REF_PATTERN,
      (match, scripture, division, chapter, verse) => {
        const s = scripture.toUpperCase();
        const div = division?.trim();
        const refText = div
          ? `${s} ${div}${chapter}.${verse}`
          : `${s} ${chapter}.${verse}`;
        const displayRef = match.startsWith("[") ? `[${refText}]` : refText;

        // Try the provided URL map first
        let url: string | undefined;
        if (verseUrlMap) {
          // Try various key formats
          url =
            verseUrlMap.get(refText) ||
            verseUrlMap.get(`[${refText}]`) ||
            verseUrlMap.get(refText.replace(/\s+/g, " "));
        }

        // Fall back to building the URL
        if (!url) {
          url = buildVedabaseLink(s, div, chapter, verse);
        }

        return `<a href="${url}" class="verse-link" target="_blank"><span class="verse-ref">${displayRef}</span></a>`;
      }
    );
  });

  return processed.join("");
}
