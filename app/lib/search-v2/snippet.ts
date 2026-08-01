/**
 * snippet.ts — One-line previews that never stop mid-thought.
 *
 * A snippet that stops mid-thought is not a short truth, it is a small lie. The
 * failure that motivated this file: a correct quotation from SB 8.23.31 was cut
 * before the line that completed its meaning, and a reader could reasonably draw
 * the opposite conclusion. So a snippet NEVER ends mid-sentence: it extends to
 * the next sentence boundary even when that overshoots the character budget.
 *
 * Truncation is always visible: "…" AFTER the closing punctuation when the end
 * was cut, "… " before the first word when the start is mid-text. A reader can
 * always tell a window from a whole.
 */

/** A sentence boundary: terminal punctuation followed by whitespace or the end.
 *  `"` counts so a quotation closes with its quote mark; `॥` is the danda pair
 *  that closes Sanskrit verse lines. */
const BOUNDARY_RE = /[.!?"॥]+(?=\s|$)/g;

interface Sentence {
  start: number;
  /** Exclusive end, INCLUDING the closing punctuation. */
  end: number;
}

function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;
  for (const m of text.matchAll(BOUNDARY_RE)) {
    const end = (m.index ?? 0) + m[0].length;
    sentences.push({ start, end });
    start = end;
  }
  if (start < text.length) sentences.push({ start, end: text.length });
  return sentences;
}

/** Cheap diacritic-insensitive fold for keyword matching only. */
function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

export function makeSnippet(text: string, maxChars = 220, queryTerms: string[] = []): string {
  // One-line preview: the snippet is a window, not the verbatim body, so
  // newlines collapse — the verbatim text always comes from the full passage.
  const src = (text || "").replace(/\s+/g, " ").trim();
  if (!src) return "";
  if (src.length <= maxChars) return src;

  const sentences = splitSentences(src);

  // The window opens at the sentence with the best keyword match — a preview
  // that shows an unrelated opening line while the match sits at paragraph
  // eight is a preview of nothing.
  let startIdx = 0;
  const terms = queryTerms.map(fold).filter((t) => t.length >= 3);
  if (terms.length > 0) {
    let best = 0;
    for (let i = 0; i < sentences.length; i++) {
      const body = fold(src.slice(sentences[i].start, sentences[i].end));
      const hits = terms.reduce((n, t) => n + (body.includes(t) ? 1 : 0), 0);
      if (hits > best) {
        best = hits;
        startIdx = i;
      }
    }
  }

  // Extend forward whole sentences until the budget is met — and then finish
  // the sentence that crosses it. Never cut inside one, never inside a word.
  const from = sentences[startIdx].start;
  let to = sentences[startIdx].end;
  for (let i = startIdx + 1; i < sentences.length && to - from < maxChars; i++) {
    to = sentences[i].end;
  }

  const head = from > 0 ? "… " : "";
  const tail = to < src.length ? "…" : "";
  return head + src.slice(from, to).trim() + tail;
}
