/**
 * 15-transcript-speakers.ts — Who speaks inside a lecture/conversation paragraph
 *
 * Transcript paragraphs are verbatim multi-speaker blocks with `Name:` prefixes
 * baked into body_text (e.g. "Prabhupāda: …\nPradyumna: …"); many continuation
 * paragraphs carry no prefix at all. This module segments a paragraph by those
 * prefixes so that:
 *   - the matched-sentence emphasis (bloom) and verbatim key answers can be
 *     restricted to sentences Śrīla Prabhupāda himself speaks, and
 *   - display attribution ("Prabhupāda replying") is claimed only on evidence.
 *
 * Rules, in the conservative direction:
 *   - A paragraph with NO prefixes gives NO restriction (no other speaker is
 *     evidenced) and NO speaker chip (never guess a speaker).
 *   - In a prefixed paragraph, an unlabeled leading run (a continuation of an
 *     unknown previous turn) is EXCLUDED from emphasis — ambiguous is not his.
 *
 * Pure module (no Supabase imports), shared by the fold helpers (server +
 * client) and the search route.
 */
import type { MatchRange } from "./10-passage-fold";

export interface TranscriptSegment {
  /** Speaker name as written in the prefix; null for an unlabeled leading run. */
  speaker: string | null;
  start: number;
  end: number;
}

/**
 * A dialogue-turn prefix at the start of a line: 1–4 capitalized-ish words
 * ("Prabhupāda", "Gopāla Kṛṣṇa", "Dr. Patel", "Guest (2)") then a colon and
 * whitespace. Each word must begin with an uppercase letter (or a parenthesis/
 * digit after the first), so a mid-sentence clause like "the process: you…"
 * never reads as a speaker.
 */
export const SPEAKER_LINE_RE =
  /^(\p{Lu}[\p{L}\p{M}.'’-]*(?:[ ][(\p{Lu}\p{N}][\p{L}\p{M}\p{N}.'’)-]*){0,3})[ \t]*[:：](?=[ \t])/u;

/** Diacritic-insensitive check that a prefix names Śrīla Prabhupāda himself. */
export function isPrabhupada(name: string | null): boolean {
  if (!name) return false;
  const n = name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();
  return n === "prabhupada" || n === "srila prabhupada";
}

/**
 * Split a paragraph into speaker segments on line-anchored `Name:` prefixes.
 * Text before the first prefix — or the whole paragraph when none exists — is
 * one segment with speaker null.
 */
export function segmentTranscriptParagraph(text: string): TranscriptSegment[] {
  const src = text || "";
  if (!src) return [];
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment = { speaker: null, start: 0, end: 0 };

  let lineStart = 0;
  for (const rawLine of src.split("\n")) {
    const m = rawLine.match(SPEAKER_LINE_RE);
    if (m) {
      if (lineStart > current.start) {
        current.end = lineStart;
        segments.push(current);
      }
      current = { speaker: m[1], start: lineStart, end: lineStart };
    }
    lineStart += rawLine.length + 1; // +1 for the consumed "\n"
  }
  current.end = src.length;
  if (current.end > current.start) segments.push(current);
  return segments;
}

/**
 * Ranges of `text` where emphasis (matched-sentence highlight, key answers)
 * may land. Returns:
 *   - null when the paragraph has no speaker prefixes at all — no restriction,
 *     because no other speaker is evidenced;
 *   - otherwise only the segments Prabhupāda himself speaks (possibly empty —
 *     then nothing may be emphasized).
 */
export function allowedEmphasisRanges(text: string): MatchRange[] | null {
  const segments = segmentTranscriptParagraph(text);
  if (!segments.some(s => s.speaker !== null)) return null;
  return segments
    .filter(s => isPrabhupada(s.speaker))
    .map(s => ({ start: s.start, end: s.end }));
}
