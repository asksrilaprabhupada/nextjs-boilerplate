/**
 * 10-passage-fold.ts — Unified Fold + Highlight Helpers
 *
 * Pure, dependency-free helpers (like 09-purport-format.ts) shared by the search
 * API (server, builds the Article HTML) and the narrative results component
 * (client, renders References and expands folds). Having ONE module means the
 * Article and References use the SAME fold markup, the SAME preview, and the
 * SAME matched-line highlight — never two divergent "Read more" implementations.
 *
 * Responsibilities:
 *   - Locate the genuinely matched sentence in a passage (from the matched purport
 *     chunk for verses, or query-term overlap for prose/lecture/letter). Never
 *     fabricate a match: returns null when nothing can be located.
 *   - Render a passage to HTML with a soft, true highlight: the matched sentence
 *     (<mark class="hl-sentence">) and the query words (<mark class="hl-word">),
 *     diacritic-insensitive ("sraddha" ↔ "śrāddha", "Krishna" ↔ "Kṛṣṇa").
 *   - Build a short, scannable preview that LEADS with the matched line, plus the
 *     unified fold-block markup (preview + inline expand) used everywhere.
 *   - Derive a VERBATIM "key answer" line for a passage (never paraphrased).
 */

import { escapeHtml, splitIntoParagraphs, stripPurportBoilerplate } from "./09-purport-format";

export type PassageType = "verse" | "purport" | "prose" | "lecture" | "letter";

/** Number of passages woven into the main-flow Article (the rest go to References / Dig Deeper). */
export const MAIN_FLOW_COUNT = 10;

/** Approximate length of a folded preview, in characters (~3 lines). Single tunable knob. */
export const PREVIEW_CHAR_TARGET = 300;

/** Visual line-clamp height of a folded preview (CSS var fallback). */
export const FOLD_PREVIEW_LINES = 3;

/* ─────────────────────────── Diacritic-insensitive matching ─────────────────────────── */

/**
 * Whole-word transliteration pairs that NFD-stripping alone can't converge
 * (e.g. "Krishna" → "krisna" vs "Kṛṣṇa" → "krsna"). Small and curated; layer-2
 * word highlighting simply adds nothing when a term isn't in this map.
 */
const TRANSLIT_MAP: Record<string, string> = {
  krishna: "krsna", krsna: "krsna", krishn: "krsna",
  vishnu: "visnu", visnu: "visnu",
  shiva: "siva", siva: "siva",
  shraddha: "sraddha", sraddha: "sraddha",
  chaitanya: "caitanya", caitanya: "caitanya",
};

/**
 * Lowercases, strips diacritics (NFD + remove combining marks), folds a few
 * common transliteration spellings, so "śrāddha" and "sraddha" — and "Kṛṣṇa"
 * and "Krishna" — compare equal. Perfection is not required.
 */
export function normalizeForMatch(s: string): string {
  const base = (s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!base) return base;
  // Curated whole-word folding first (handles spellings NFD can't converge, e.g.
  // "krishna" → "krsna"), then a generic "sh" → "s" pass with a final re-check.
  if (TRANSLIT_MAP[base]) return TRANSLIT_MAP[base];
  const folded = base.replace(/sh/g, "s");
  return TRANSLIT_MAP[folded] || folded;
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "yours", "what", "whats",
  "who", "whom", "why", "how", "when", "where", "which", "that", "this", "these",
  "those", "with", "from", "about", "does", "did", "was", "were", "have", "has",
  "had", "can", "could", "should", "would", "will", "shall", "may", "might", "must",
  "into", "onto", "upon", "over", "under", "than", "then", "they", "them", "their",
  "his", "her", "him", "she", "its", "our", "out", "off", "all", "any", "some",
  "srila", "prabhupada", "say", "says", "said", "teach", "teaches", "explain",
  "explains", "tell", "talk", "regarding", "concerning",
]);

/**
 * Extracts the salient search terms from a raw query for highlighting: lowercased
 * word tokens (diacritics preserved for display matching), minus short stopwords.
 */
export function extractQueryTerms(query: string): string[] {
  const tokens = (query || "").toLowerCase().match(/[\p{L}̀-ͯ]+/gu) || [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of tokens) {
    if (tok.length < 3) continue;
    if (STOPWORDS.has(tok)) continue;
    const norm = normalizeForMatch(tok);
    if (!norm || norm.length < 3) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(tok);
  }
  return out;
}

/* ─────────────────────────── Tokens & sentences with offsets ─────────────────────────── */

interface Span { text: string; start: number; end: number }

/** Word tokens (letters incl. diacritics) with their offsets in the original string. */
function wordTokens(text: string): Span[] {
  const out: Span[] = [];
  const re = /[\p{L}̀-ͯ']+/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** Splits into sentences, keeping each sentence's [start,end] in the original string. */
function sentenceSpans(text: string): Span[] {
  const out: Span[] = [];
  // A sentence ends at . ! ? (optionally followed by a closing quote) then whitespace,
  // or at a newline, or at end of string. Devanagari danda "।" also ends a sentence.
  const re = /[^.!?।\n]*(?:[.!?।]+["'”’)]*|\n|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index >= text.length) break;
    const raw = m[0];
    if (m[0].length === 0) { re.lastIndex++; continue; }
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      out.push({ text: trimmed, start: m.index + lead, end: m.index + lead + trimmed.length });
    }
  }
  return out;
}

/** Set of normalized query terms (for overlap scoring / word matching). */
function normalizedTermSet(queryTerms: string[]): Set<string> {
  const set = new Set<string>();
  for (const t of queryTerms) {
    const n = normalizeForMatch(t);
    if (n.length >= 3) set.add(n);
  }
  return set;
}

/** Count of DISTINCT query terms that appear as words inside [start,end] of `text`. */
function overlapScore(text: string, start: number, end: number, terms: Set<string>): number {
  if (terms.size === 0) return 0;
  const hit = new Set<string>();
  for (const tok of wordTokens(text.slice(start, end))) {
    const n = normalizeForMatch(tok.text);
    if (terms.has(n)) hit.add(n);
  }
  return hit.size;
}

/* ─────────────────────────── Locate the genuinely matched sentence ─────────────────────────── */

export interface MatchRange { start: number; end: number }

/**
 * Locates the matched sentence within `text`.
 *
 * - Verses/purports: `matchedChunkText` is the purport chunk the search actually
 *   hit. We find that chunk by prefix (its tail may include the stripped footer),
 *   then return the best-overlap sentence inside it, or the chunk's first sentence
 *   (the chunk genuinely matched, so emphasizing its lead is truthful).
 * - Prose/lecture/letter: no chunk — the matched unit is the paragraph. We return
 *   the highest query-overlap sentence, or NULL when nothing overlaps (a semantic
 *   match with no literal query word). We NEVER fabricate a guessed sentence.
 */
export function locateMatchedSentence(
  text: string,
  matchedChunkText: string | undefined,
  queryTerms: string[],
): MatchRange | null {
  const clean = text || "";
  if (!clean) return null;
  const terms = normalizedTermSet(queryTerms);
  const sentences = sentenceSpans(clean);
  if (sentences.length === 0) return null;

  // Determine the search window: the matched chunk's range (purports) or the whole text.
  let winStart = 0;
  let winEnd = clean.length;
  if (matchedChunkText && matchedChunkText.trim()) {
    const matched = matchedChunkText.trim();
    let idx = clean.indexOf(matched.slice(0, 160));
    if (idx === -1) idx = clean.indexOf(matched.slice(0, 60));
    if (idx !== -1) {
      winStart = idx;
      winEnd = Math.min(clean.length, idx + matched.length);
    }
    // Even if the chunk can't be located, fall through with the full window so a
    // query-overlap sentence can still be emphasized; otherwise we return null below.
  }

  // Sentences that intersect the window.
  const inWindow = sentences.filter((s) => s.end > winStart && s.start < winEnd);
  const pool = inWindow.length > 0 ? inWindow : sentences;

  // Pick the highest query-overlap sentence in the pool.
  let best: Span | null = null;
  let bestScore = 0;
  for (const s of pool) {
    const sc = overlapScore(clean, s.start, s.end, terms);
    if (sc > bestScore) { bestScore = sc; best = s; }
  }
  if (best && bestScore > 0) return { start: best.start, end: best.end };

  // No query overlap. If we have a located chunk, the chunk itself is the genuine
  // match — emphasize its first in-window sentence (truthful). Otherwise null.
  if (matchedChunkText && matchedChunkText.trim() && inWindow.length > 0) {
    return { start: inWindow[0].start, end: inWindow[0].end };
  }
  return null;
}

/* ─────────────────────────── Highlight rendering ─────────────────────────── */

interface Marker { pos: number; kind: "so" | "sc" | "wo" | "wc" }

/**
 * Escapes `text` and wraps the matched sentence in <mark class="hl-sentence"> and
 * each query-term word in <mark class="hl-word">. Query words always nest cleanly
 * inside or outside the sentence span. Marks are inserted around spans of the
 * trusted passage text only — query terms are never themselves injected — so the
 * output is XSS-safe and the escaping stays correct around & < >.
 */
export function highlightHtml(text: string, matched: MatchRange | null, queryTerms: string[]): string {
  const clean = text || "";
  if (!clean) return "";
  const terms = normalizedTermSet(queryTerms);

  const markers: Marker[] = [];
  if (matched && matched.end > matched.start) {
    markers.push({ pos: matched.start, kind: "so" });
    markers.push({ pos: matched.end, kind: "sc" });
  }
  if (terms.size > 0) {
    for (const tok of wordTokens(clean)) {
      if (terms.has(normalizeForMatch(tok.text))) {
        markers.push({ pos: tok.start, kind: "wo" });
        markers.push({ pos: tok.end, kind: "wc" });
      }
    }
  }
  if (markers.length === 0) return escapeHtml(clean);

  // At a given position, emit closes before opens, and order sentence vs word so
  // that <mark hl-sentence> always wraps <mark hl-word> (proper nesting).
  const order: Record<Marker["kind"], number> = { wc: 0, sc: 1, so: 2, wo: 3 };
  markers.sort((a, b) => (a.pos - b.pos) || (order[a.kind] - order[b.kind]));

  let out = "";
  let cursor = 0;
  for (const mk of markers) {
    if (mk.pos > cursor) { out += escapeHtml(clean.slice(cursor, mk.pos)); cursor = mk.pos; }
    out += mk.kind === "so" ? '<mark class="hl-sentence">'
      : mk.kind === "sc" ? "</mark>"
      : mk.kind === "wo" ? '<mark class="hl-word">'
      : "</mark>";
  }
  if (cursor < clean.length) out += escapeHtml(clean.slice(cursor));
  return out;
}

/** Renders whole paragraphs as <p class="pp">…</p>, highlighting the matched line + query words. */
export function highlightParagraphsHtml(
  text: string,
  matchedChunkText: string | undefined,
  queryTerms: string[],
): string {
  const clean = stripPurportBoilerplate(text || "");
  const paras = splitIntoParagraphs(clean);
  if (paras.length === 0) return "";
  const matched = locateMatchedSentence(clean, matchedChunkText, queryTerms);
  let offset = 0;
  const out: string[] = [];
  for (const raw of clean.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed.length > 0) {
      const lead = raw.length - raw.trimStart().length;
      const pStart = offset + lead;
      const pEnd = pStart + trimmed.length;
      // Translate the absolute match range into this paragraph's local coordinates.
      let local: MatchRange | null = null;
      if (matched && matched.start < pEnd && matched.end > pStart) {
        local = { start: Math.max(0, matched.start - pStart), end: Math.min(trimmed.length, matched.end - pStart) };
      }
      out.push(`<p class="pp">${highlightHtml(trimmed, local, queryTerms)}</p>`);
    }
    offset += raw.length + 1; // +1 for the consumed "\n"
  }
  return out.join("");
}

/* ─────────────────────────── Section text (prose / lecture / letter) ─────────────────────────── */

/** Lightweight Sanskrit check (pure copy of the server's, so neighbours match the article). */
function isMostlySanskritLite(text: string): boolean {
  const iast = (text.match(/[āīūṛṝḷṃḥṣṭḍṅñśṁ]/g) || []).length;
  const total = text.replace(/\s/g, "").length;
  if (total === 0) return false;
  return iast / total > 0.15;
}

/**
 * Joins the matched paragraph with its neighbours into one section string (the
 * full faithful context shown on expand). A neighbour is kept only if substantial
 * and not mostly Sanskrit; the matched paragraph is always kept whole. Cuts fall
 * only on whole-paragraph boundaries — never mid-sentence.
 */
export function buildSectionText(body: string, before?: string, after?: string, cap = 2800): string {
  const matched = (body || "").trim();
  if (!matched) return "";
  const beforeOk = before && before.trim().length > 40 && !isMostlySanskritLite(before) ? before.trim() : "";
  const afterOk = after && after.trim().length > 40 && !isMostlySanskritLite(after) ? after.trim() : "";
  let pieces = [beforeOk, matched, afterOk].filter(Boolean) as string[];
  const total = (arr: string[]) => arr.reduce((n, s) => n + s.length, 0);
  if (total(pieces) > cap && beforeOk && afterOk) {
    pieces = beforeOk.length >= afterOk.length ? [matched, afterOk] : [beforeOk, matched];
  }
  if (total(pieces) > cap && pieces.length > 1) pieces = [matched];
  return pieces.join("\n");
}

/* ─────────────────────────── Preview + fold block ─────────────────────────── */

export interface FoldPreview { previewHtml: string; truncated: boolean; matched: MatchRange | null }

/**
 * Builds the folded preview for a passage. The preview is a SINGLE block that
 * leads with the matched sentence (so the devotee instantly sees why the result
 * is relevant), ~PREVIEW_CHAR_TARGET characters, cut on a whole-sentence boundary.
 * `truncated=false` when the whole passage already fits — short passages render
 * whole (the preview would just equal the full text), with no fade and no button.
 */
export function buildFoldPreviewHtml(opts: {
  type: PassageType;
  text: string;
  matchedChunkText?: string;
  queryTerms: string[];
}): FoldPreview {
  const clean = (opts.type === "purport" ? stripPurportBoilerplate(opts.text || "") : (opts.text || "")).trim();
  if (!clean) return { previewHtml: "", truncated: false, matched: null };

  const matched = locateMatchedSentence(clean, opts.matchedChunkText, opts.queryTerms);

  // Whole short passage → render in full (paragraphs), no fold.
  if (clean.length <= PREVIEW_CHAR_TARGET) {
    return {
      previewHtml: highlightParagraphsHtml(clean, opts.matchedChunkText, opts.queryTerms),
      truncated: false,
      matched,
    };
  }

  // Build a window of whole sentences (~PREVIEW_CHAR_TARGET) that leads with the
  // matched sentence; if no match was located, lead from the start of the text.
  const sentences = sentenceSpans(clean);
  let startIdx = 0;
  if (matched) {
    startIdx = sentences.findIndex((s) => s.start <= matched.start && s.end >= matched.start);
    if (startIdx < 0) startIdx = 0;
    // Keep one short sentence of lead-in context when it's brief, for readability.
    if (startIdx > 0 && sentences[startIdx - 1].text.length <= 90) startIdx -= 1;
  }
  let acc = 0;
  let endIdx = startIdx;
  for (let i = startIdx; i < sentences.length; i++) {
    acc += sentences[i].text.length + 1;
    endIdx = i;
    if (acc >= PREVIEW_CHAR_TARGET) break;
  }
  const winStart = sentences[startIdx].start;
  const winEnd = sentences[endIdx].end;
  const windowText = clean.slice(winStart, winEnd).trim();

  // Translate the match range into window-local coordinates.
  let localMatch: MatchRange | null = null;
  if (matched && matched.start >= winStart && matched.start < winEnd) {
    localMatch = { start: Math.max(0, matched.start - winStart), end: Math.min(windowText.length, matched.end - winStart) };
  }

  return {
    previewHtml: highlightHtml(windowText, localMatch, opts.queryTerms),
    truncated: true,
    matched,
  };
}

/**
 * The unified fold-block markup used by BOTH the Article (server) and References
 * (client). Keeps the legacy `${type}-quote` class so the hover tooltip keeps
 * working, plus an `id="source-{id}"` anchor (key answers scroll to it) and
 * data-* attributes the shared expand handler reads.
 */
export function buildFoldBlock(opts: {
  type: PassageType;
  id: string;
  previewHtml: string;
  truncated: boolean;
  citeHtml?: string;
  expandLabel?: string;
  /** Element anchor id (key answers scroll here). Defaults to `id`; pass null to omit. */
  anchorId?: string | null;
}): string {
  const cls = `fold-block ${opts.type}-quote${opts.truncated ? " is-folded" : ""}`;
  const label = opts.expandLabel || (opts.type === "purport" ? "Read the full purport →" : "Read the full passage →");
  const btn = opts.truncated
    ? `<button type="button" class="fold-expand-btn" data-passage-id="${escapeAttr(opts.id)}" data-passage-type="${opts.type}">${label}</button>`
    : "";
  const anchor = opts.anchorId === null ? "" : ` id="source-${escapeAttr(opts.anchorId ?? opts.id)}"`;
  return (
    `<div class="${cls}"${anchor} data-passage-type="${opts.type}" data-passage-id="${escapeAttr(opts.id)}">` +
      `<div class="fold-preview">${opts.previewHtml}</div>` +
      btn +
      (opts.citeHtml || "") +
    `</div>`
  );
}

/** Escapes a value for use inside an HTML attribute (ids contain only safe chars, but be safe). */
function escapeAttr(s: string): string {
  return (s || "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ─────────────────────────── Verbatim key line ─────────────────────────── */

/**
 * The VERBATIM "key answer" line for a passage — never paraphrased.
 *   verse  → its translation (the natural single faithful statement)
 *   others → the matched sentence (same line highlighted in the passage), or the
 *            first sentence of the matched paragraph when no sentence can be located.
 */
export function keyLineFor(opts: {
  type: PassageType;
  translation?: string;
  body?: string;
  matchedChunkText?: string;
  queryTerms: string[];
}): string {
  if (opts.type === "verse") return (opts.translation || "").trim();
  const text = (opts.body || "").trim();
  if (!text) return "";
  const matched = locateMatchedSentence(text, opts.matchedChunkText, opts.queryTerms);
  if (matched) return text.slice(matched.start, matched.end).trim();
  const sentences = sentenceSpans(text);
  return sentences.length > 0 ? sentences[0].text : text;
}
