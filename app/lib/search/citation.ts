/**
 * citation.ts — Build the citation a devotee checks against Vedabase.
 *
 * This is the TypeScript twin of public.format_verse_reference, and it is the
 * one that matters: the SQL version labels candidates during retrieval, but
 * THIS one produces the citation that is rendered, so it is the one a reader
 * acts on.
 *
 * The corpus does not describe every book the same way:
 *
 *   BG/NBS/MMS  verse_number = "66"          → BG 18.66
 *   SB          verse_number = "Text 9"      → SB 7.8.9    (division is the canto)
 *   CC          verse_number = "Text 1"      → CC Adi 1.1  (division is a word)
 *   BS          verse_number = "Verse text"  → BS 5.29     (chapter_number IS the verse;
 *                                                           the real chapter is always 5)
 *   ISO/NOI     verse_number = "Verse text"  → ISO 1, NOI 8
 *   ISO         invocation                    → ISO Invocation
 *
 * 22,000+ of 25,131 verses fall outside the simple case, so treating
 * verse_number as a bare number produces a malformed citation for most of the
 * corpus — "SB 7.8.Text 9", "ISO 0.Verse text".
 *
 * `vedabase_url` is the AUTHORITY when present, because it already carries the
 * canonical locator and cannot drift from the column quirks. The column-derived
 * form is only a fallback.
 */

/** Extracts the locator from a Vedabase library URL: /library/<book>/<locator>. */
function locatorFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/library\/[a-z]+\/(.+?)\/?$/i);
  if (!m) return null;
  const segments = m[1].split("/").filter(Boolean);
  if (segments.length === 0) return null;

  const head = segments[0];
  // A leading NON-numeric segment is a division name (cc/adi/1/1 → "Adi 1.1")
  // and takes a space; numeric segments join with dots.
  if (!/^\d/.test(head)) {
    const rest = segments.slice(1).filter((s) => /^\d/.test(s));
    const division = head.charAt(0).toUpperCase() + head.slice(1);
    return rest.length > 0 ? `${division} ${rest.join(".")}` : division;
  }
  return segments.filter((s) => /^\d/.test(s)).join(".");
}

/** Strips the "Text "/"Verse " prefix SB and CC store on verse_number. */
export function cleanVerseNumber(raw: string | null | undefined): string | null {
  const cleaned = (raw ?? "").replace(/^\s*(texts?|verses?)\s+/i, "").trim();
  return cleaned.length > 0 ? cleaned : null;
}

export interface VerseReferenceParts {
  scripture: string | null;
  /** chapters.canto_or_division — the SB canto or the CC division name. */
  division?: string | null;
  chapterNumber?: number | string | null;
  verseNumber?: string | null;
  vedabaseUrl?: string | null;
}

/**
 * Returns the citation, or null when there is not enough to build one.
 *
 * Returning null rather than a partial string is deliberate: a citation that
 * only half-identifies a passage is worse than none, because a reader will try
 * to look it up and land somewhere else.
 */
export function formatVerseReference(parts: VerseReferenceParts): string | null {
  const scripture = (parts.scripture ?? "").trim();
  if (!scripture) return null;

  const fromUrl = locatorFromUrl(parts.vedabaseUrl);
  if (fromUrl) return `${scripture} ${fromUrl}`;

  const num = cleanVerseNumber(parts.verseNumber);
  const chapter =
    parts.chapterNumber === null || parts.chapterNumber === undefined
      ? null
      : String(parts.chapterNumber);
  const division = (parts.division ?? "").trim() || null;

  // Placeholder verse_number ("Verse text", "Devanagari"): the locator is the
  // chapter number alone.
  if (!num || !/^\d/.test(num)) {
    return chapter ? `${scripture} ${chapter}` : scripture;
  }

  if (!division) return chapter ? `${scripture} ${chapter}.${num}` : `${scripture} ${num}`;

  if (/^\d+$/.test(division)) {
    return chapter ? `${scripture} ${division}.${chapter}.${num}` : `${scripture} ${division}.${num}`;
  }

  const cap = division.charAt(0).toUpperCase() + division.slice(1);
  return chapter ? `${scripture} ${cap} ${chapter}.${num}` : `${scripture} ${cap} ${num}`;
}
