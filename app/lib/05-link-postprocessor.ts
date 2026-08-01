/**
 * 05-link-postprocessor.ts — Link Post-Processor
 *
 * Adds clickable citation links to verse references in the AI-generated narrative HTML.
 * Ensures every verse mention in the narrative links to its detail page.
 */

// Matches references like [BG 2.20], [SB 1.2.3], [CC Madhya 8.128], BG 2.20, SB 1.2.3, etc.
// Negative lookbehind ensures we don't match text already inside an <a> tag's inner text.
const VERSE_REF_PATTERN =
  /\[?\b(BG|SB|CC|NOI|ISO|BS|NBS|MMS)\s+((?:Adi|Madhya|Antya|[\d]+)\s*[.\s]\s*)?(\d+)[.\s](\d+(?:[–-]\d+)?)\]?/gi;

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

        // For books not on Vedabase, show as styled label instead of link
        const noVedabaseScriptures = new Set(["NBS", "MMS"]);
        if (noVedabaseScriptures.has(s)) {
          return `<span class="verse-label">${displayRef}</span>`;
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

/**
 * Vedabase URL for one formatted verse reference ("BG 18.66", "SB 7.8.9",
 * "CC Madhya 8.128"), or null when the reference does not parse cleanly or the
 * book is not on Vedabase. Used for second-tier citation links, which carry no
 * re-fetched row to take the canonical URL from — a null link is better than a
 * guessed one that lands a reader on the wrong verse.
 */
export function vedabaseUrlForReference(reference: string | null | undefined): string | null {
  const ref = (reference || "").trim();
  if (!ref) return null;
  const m = ref.match(/^(BG|SB|CC|NOI|ISO|BS)\s+(?:(Adi|Madhya|Antya)\s+)?(\d+(?:\.\d+)*(?:[–-]\d+)?)$/i);
  if (!m) return null;
  const s = m[1].toUpperCase();
  const division = m[2];
  const nums = m[3].split(".");
  // Each book addresses differently; anything that does not fit its shape
  // returns null rather than a guessed URL.
  if ((s === "NOI" || s === "ISO") && nums.length === 1) {
    return buildVedabaseLink(s, undefined, nums[0], nums[0]);
  }
  if (s === "CC" && division && nums.length === 2) {
    return buildVedabaseLink(s, division, nums[0], nums[1]);
  }
  if (s === "SB" && nums.length === 3) {
    return buildVedabaseLink(s, nums[0], nums[1], nums[2]);
  }
  if ((s === "BG" || s === "BS") && nums.length === 2) {
    return buildVedabaseLink(s, undefined, nums[0], nums[1]);
  }
  return null;
}
