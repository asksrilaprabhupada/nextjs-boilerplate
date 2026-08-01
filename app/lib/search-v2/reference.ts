/**
 * reference.ts — Recognising a scripture reference inside a question.
 *
 * This is a RETRIEVAL CLUE and nothing more. When a devotee writes "BG 18.66"
 * the siglum and numbers are worth handing to the search as a constraint, the
 * same way a quoted phrase is worth handing to the lexical channel.
 *
 * It deliberately does NOT decide anything about how the question is answered.
 * The module this replaced used the same regexes to send a bare reference down a
 * different road — no planner, no fan-out, no reranking — which meant two
 * questions about the same verse could be answered by two different pipelines
 * and nobody could tell which. There is one road now, and spotting a reference
 * does not change it; it only adds one more thing to search for.
 *
 * Pure and synchronous. It costs nothing to run.
 */

/**
 * Scripture sigla the corpus actually stores, matching direct_verse_lookup's
 * parser. Anchored so "BGS" or a word merely starting with "so" cannot match.
 */
const SCRIPTURE_SIGLA = ["BG", "SB", "CC", "NOI", "ISO", "BS", "NBS", "MMS"] as const;

/** A query that is nothing but a reference ("BG 18.66", "CC Adi 1.1"). */
const REFERENCE_RE = new RegExp(
  String.raw`^\s*(?:${SCRIPTURE_SIGLA.join("|")})\b[\s.]*` +
    String.raw`(?:(?:adi|madhya|antya|canto|chapter|verse|text|mantra|sloka|shloka)\b[\s.]*)*` +
    String.raw`\d+(?:\s*[.\s]\s*\d+)*(?:\s*-\s*\d+)?\s*$`,
  "i",
);

/** A reference embedded in a longer question ("what does BG 18.66 mean?"). */
const REFERENCE_MENTION_RE = new RegExp(
  String.raw`\b(?:${SCRIPTURE_SIGLA.join("|")})\.?\s*\d+(?:[.\s]\d+)*\b`,
  "i",
);

/**
 * Normalises a matched reference into the shape direct_verse_lookup parses.
 * The RPC does its own cleaning, so this only needs to collapse whitespace and
 * uppercase the siglum.
 */
export function normalizeReference(raw: string): string {
  const cleaned = raw.trim().replace(/\s+/g, " ");
  return cleaned.replace(/^([A-Za-z]+)/, (m) => m.toUpperCase());
}

/** The reference a question mentions, or null. Never changes what happens next. */
export function extractReference(query: string): string | null {
  const trimmed = (query || "").trim();
  if (REFERENCE_RE.test(trimmed)) return normalizeReference(trimmed);
  const mention = trimmed.match(REFERENCE_MENTION_RE);
  return mention ? normalizeReference(mention[0]) : null;
}

/**
 * The SIGLUM only — "BG" from "BG 18.66". This is what the scripture constraint
 * must carry: `chapters.scripture` stores "BG", never "BG 18.66", so sending the
 * full reference as a filter matches zero rows and silently deletes every verse.
 */
export function extractSiglum(query: string): string | null {
  const ref = extractReference(query);
  if (!ref) return null;
  const m = ref.match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}

/** Siglum of an already-extracted reference string ("BG 18.66" → "BG"). */
export function siglumOf(reference: string): string | null {
  const m = (reference || "").trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}
