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

/**
 * Books written out in full, mapped to the siglum they are. A devotee who
 * writes "Bhagavad-gita 6.6" has named the book as plainly as one who writes
 * "BG 6.6".
 */
const SPELLED_OUT_BOOKS: [string, string][] = [
  [String.raw`bhagavad\s*-?\s*gita`, "BG"],
  [String.raw`srimad\s*-?\s*bhagavatam|bhagavata\s*purana`, "SB"],
  [String.raw`caitanya\s*-?\s*caritamrta|chaitanya\s*-?\s*charitamrta`, "CC"],
  [String.raw`nectar\s+of\s+instruction`, "NOI"],
  [String.raw`isopanisad|ishopanishad`, "ISO"],
  [String.raw`brahma\s*-?\s*samhita`, "BS"],
];

/** Diacritics folded away, so "Śrīmad-Bhāgavatam" reads as "srimad-bhagavatam". */
function foldDiacritics(text: string): string {
  return text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

/** The siglum a spelled-out book name implies, or null. */
export function siglumOfSpelledOutBook(query: string): string | null {
  const folded = foldDiacritics(query);
  for (const [pattern, siglum] of SPELLED_OUT_BOOKS) {
    if (new RegExp(pattern).test(folded)) return siglum;
  }
  return null;
}

/** The same body/verse tail the abbreviated form accepts. */
const REFERENCE_TAIL = String.raw`[\s.]*` +
  String.raw`(?:(?:adi|madhya|antya|canto|chapter|verse|text|mantra|sloka|shloka)\b[\s.]*)*` +
  String.raw`\d+(?:\s*[.\s]\d*\d(?:\s*[.\s]\d+)*)?(?:\s*-\s*\d+)?\s*$`;

/**
 * Is the input NOTHING BUT a citation?
 *
 * Not "does it contain one" — IS it one. "BG 18.66" is a request to look up a
 * verse. "what does BG 18.66 mean about surrender" is a real question that
 * happens to cite a verse, and it deserves the full fan-out; the cited verse
 * still arrives, because `direct_verse_lookup` pins it either way.
 *
 * Anchored at both ends, and mechanical: no question mark is looked for, no
 * question word, nothing a model decides. A devotee who omits the question mark
 * is not thereby making a citation.
 */
export function isBareReference(query: string): boolean {
  const trimmed = (query || "").trim();
  if (!trimmed) return false;
  if (REFERENCE_RE.test(trimmed)) return true;

  const folded = foldDiacritics(trimmed);
  for (const [pattern] of SPELLED_OUT_BOOKS) {
    if (new RegExp(String.raw`^\s*(?:${pattern})\b${REFERENCE_TAIL}`, "i").test(folded)) {
      return true;
    }
  }
  return false;
}

/** Siglum of an already-extracted reference string ("BG 18.66" → "BG"). */
export function siglumOf(reference: string): string | null {
  const m = (reference || "").trim().match(/^([A-Za-z]+)/);
  return m ? m[1].toUpperCase() : null;
}
