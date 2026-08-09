/**
 * 09-purport-format.ts — Purport Formatting Helpers
 *
 * Pure, dependency-free helpers shared by the search API (server) and the
 * narrative results component (client) so that a purport preview and its
 * inline-expanded full text are formatted identically.
 *
 * Responsibilities:
 *   - Strip the "Thus end the Bhaktivedanta purports…" closing footer from previews.
 *   - Split a purport into whole paragraphs (single "\n" boundaries).
 *   - Render paragraphs to safe HTML (escaping only &, <, > — diacritics and
 *     curly quotes are valid text and must render verbatim).
 *   - Map a matched-chunk character range to whole-paragraph indices so long
 *     purports can show the relevant section without cutting mid-sentence.
 */

/** Purports at or below this length are shown whole; longer ones get a preview + expand. */
export const PURPORT_CUTOFF = 2800;

/**
 * Removes the "Thus end(s) the Bhaktivedanta purports …" closing footer.
 * The footer always begins a line and runs to the end of the text. SB uses
 * "…of the [Canto], [Chapter]…", CC uses "…to Śrī Caitanya-caritāmṛta…".
 * Some rows are ONLY the footer — guard so we never return blank text.
 */
export function stripPurportBoilerplate(text: string): string {
  if (!text) return "";
  const stripped = text
    .replace(/\n?\s*Thus ends? the Bhaktivedanta purports[\s\S]*$/i, "")
    .trimEnd();
  return stripped.length < 5 ? text : stripped;
}

/**
 * Strips MECHANICAL artifacts from displayed text — a leaked leading paragraph
 * number at the start of a line (a stray "42)" / "42." / "42]") and broken
 * intra-line whitespace — without touching wording. Works line by line and
 * PRESERVES the "\n" boundaries and line count, so character offsets computed
 * against the cleaned string stay valid for matched-line highlighting. This is
 * cleanup ONLY: it never drops, reorders, hides, or judges a passage. Parenthesised
 * list markers like "(1)" are left intact (only bare leading enumerators are stray).
 */
export function cleanDisplayText(text: string): string {
  if (!text) return "";
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^(\s*)\d{1,4}[)\].]\s+/, "$1") // leaked leading enumerator
        .replace(/[ \t]{2,}/g, " ")              // collapse broken whitespace
        .replace(/[ \t]+$/g, ""),                // trailing whitespace
    )
    .join("\n");
}

/** Splits text into trimmed, non-empty paragraphs on single "\n" boundaries. */
export function splitIntoParagraphs(text: string): string[] {
  if (!text) return [];
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Escapes only the characters that would break HTML markup. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Renders paragraphs as a sequence of <p class="pp"> blocks. */
export function paragraphsToHtml(paras: string[]): string {
  return paras.map((p) => `<p class="pp">${escapeHtml(p)}</p>`).join("");
}

/**
 * Paragraphs with their character offsets within the ORIGINAL string, so a
 * character range can be mapped to paragraph indices. The produced sequence
 * matches splitIntoParagraphs() exactly (trimmed, non-empty, same order).
 */
function paragraphsWithOffsets(text: string): { text: string; start: number }[] {
  const out: { text: string; start: number }[] = [];
  let offset = 0;
  for (const raw of text.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const leading = raw.length - raw.trimStart().length;
      out.push({ text: trimmed, start: offset + leading });
    }
    offset += raw.length + 1; // +1 for the consumed "\n"
  }
  return out;
}

/**
 * Maps a character range [startOffset, endOffset] within `clean` to the
 * indices of the whole paragraphs that contain those offsets. Indices align
 * with splitIntoParagraphs(clean). Offsets must be measured against the raw
 * `clean` string (including its "\n" separators), never against trimmed text.
 */
export function mapOffsetToParagraphRange(
  clean: string,
  startOffset: number,
  endOffset: number,
): { startPara: number; endPara: number } {
  const paras = paragraphsWithOffsets(clean);
  let startPara = 0;
  let endPara = 0;
  for (let i = 0; i < paras.length; i++) {
    if (startOffset >= paras[i].start) startPara = i;
    if (endOffset >= paras[i].start) endPara = i;
  }
  return { startPara, endPara };
}
