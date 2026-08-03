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
 *   - A paragraph with NO prefixes gets NO speaker name (never guess). The
 *     general emphasis helper leaves it unrestricted for legacy unfiltered
 *     display, while the explicit speaker-only projection excludes it.
 *   - In a prefixed paragraph, an unlabeled leading run (a continuation of an
 *     unknown previous turn) is EXCLUDED from emphasis — ambiguous is not his.
 *
 * Pure module (no Supabase imports), shared by the fold helpers (server +
 * client) and the search route.
 */
import type { MatchRange } from "./10-passage-fold";

export interface TranscriptSegment {
  /** Trusted speaker name as written in the prefix; null when not attributable. */
  speaker: string | null;
  /** True when a line-level `...:` turn boundary started this segment. */
  explicitBoundary: boolean;
  start: number;
  end: number;
}

export const CANONICAL_PRABHUPADA_SPEAKER = "Śrīla Prabhupāda";

export interface TranscriptSpeakerAttribution {
  /** Unique explicit names, in first-spoken order. */
  speakers: string[];
  /** Compact value for the existing single speaker wire field. */
  displaySpeaker: string | null;
  /** True when any displayed bytes have no explicit line-level speaker. */
  unidentified: boolean;
  confidence: "labelled" | "unknown";
}

export interface PrabhupadaSegmentProjection {
  /** Exact source slices, in source order, with no generated separator. */
  text: string;
  keptSegments: number;
  guestSegmentsRemoved: number;
  unknownSegmentsRemoved: number;
}

/**
 * A conservative turn boundary, deliberately broader than the names we display.
 *
 * The corpus contains real labels such as `Indian man:`, `Govinda dāsī:`, and
 * long/punctuated role names. Missing one after a `Prabhupāda:` line would fold
 * the guest's words into his segment. Therefore every uppercase line-prefix
 * before a colon is a safety boundary. A separate trust check below decides
 * whether that prefix is suitable for presentation as a person's name; an
 * ambiguous heading remains an unidentified boundary, never his continuation.
 */
export const SPEAKER_LINE_RE = /^(\p{Lu}[^\r\n:：]*?)[ \t]*[:：]/u;

/** Lowercase words genuinely used inside corpus speaker labels. */
const TRUSTED_LOWERCASE_LABEL_WORDS = new Set([
  "assistant",
  "audience",
  "boy",
  "boys",
  "child",
  "children",
  "dasa",
  "dasi",
  "devotee",
  "devotees",
  "disciple",
  "doctor",
  "father",
  "follower",
  "girl",
  "girls",
  "guest",
  "guests",
  "lady",
  "manager",
  "man",
  "member",
  "men",
  "monk",
  "mother",
  "passerby",
  "priest",
  "reporter",
  "reporters",
  "representative",
  "secretary",
  "son",
  "student",
  "students",
  "voice",
  "wife",
  "woman",
  "women",
]);

/** Metadata/headings observed in transcript text; boundaries, but not speakers. */
const NON_SPEAKER_LABELS = new Set([
  "answer",
  "audio file",
  "chapter",
  "conclusion",
  "date",
  "dated",
  "example",
  "location",
  "note",
  "notes",
  "purport",
  "question",
  "recording",
  "synonyms",
  "text",
  "translation",
  "verse",
]);

function foldLabelWord(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z-]/g, "");
}

/**
 * Return a display-safe name, or null for an ambiguous line heading. This check
 * is intentionally stricter than SPEAKER_LINE_RE; safety segmentation must not
 * depend on whether a boundary is also trustworthy attribution metadata.
 */
function trustedSpeakerLabel(raw: string): string | null {
  const label = raw.trim();
  if (!label || label.length > 80) return null;

  const normalizedLabel = label
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z]+/g, " ")
    .trim();
  if (NON_SPEAKER_LABELS.has(normalizedLabel)) return null;

  const words = label.split(/[ \t]+/u);
  if (words.length > 8 || !/^\p{Lu}/u.test(words[0])) return null;
  const trusted = words.every((word, index) => {
    if (index === 0 || /^(?:\p{Lu}|\p{Lt})/u.test(word)) return true;
    if (/^\(\d+\)$/u.test(word)) return true;
    return TRUSTED_LOWERCASE_LABEL_WORDS.has(foldLabelWord(word));
  });
  return trusted ? label : null;
}

/** Diacritic-insensitive check that a prefix names Śrīla Prabhupāda himself. */
export function isPrabhupada(name: string | null): boolean {
  if (!name) return false;
  const n = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z ]/g, "")
    .trim();
  return n === "prabhupada" || n === "srila prabhupada";
}

/**
 * Split a paragraph on conservative line-level turn boundaries. Text before the
 * first boundary — or the whole paragraph when none exists — is one unknown
 * segment. A syntactic boundary whose label is not presentation-safe starts an
 * unknown segment instead of being treated as the preceding speaker's words.
 */
export function segmentTranscriptParagraph(text: string): TranscriptSegment[] {
  const src = text || "";
  if (!src) return [];
  const segments: TranscriptSegment[] = [];
  let current: TranscriptSegment = {
    speaker: null,
    explicitBoundary: false,
    start: 0,
    end: 0,
  };

  let lineStart = 0;
  for (const rawLine of src.split("\n")) {
    const m = rawLine.match(SPEAKER_LINE_RE);
    if (m) {
      if (lineStart > current.start) {
        current.end = lineStart;
        segments.push(current);
      }
      const boundaryLabel = m[1].trim();
      current = {
        // Canonical variants always remain attributable even if a future
        // spelling falls outside the presentation-name grammar.
        speaker: isPrabhupada(boundaryLabel)
          ? boundaryLabel
          : trustedSpeakerLabel(boundaryLabel),
        explicitBoundary: true,
        start: lineStart,
        end: lineStart,
      };
    }
    lineStart += rawLine.length + 1; // +1 for the consumed "\n"
  }
  current.end = src.length;
  if (current.end > current.start) segments.push(current);
  return segments;
}

/**
 * Derive display attribution from the paragraph's own line prefixes. A
 * multi-speaker database row stays multi-speaker; no first-label shortcut is
 * allowed. Canonical spelling variants of Prabhupāda are folded only for the
 * metadata value — source text is never rewritten.
 */
export function transcriptSpeakerAttribution(text: string): TranscriptSpeakerAttribution {
  const source = text || "";
  const segments = segmentTranscriptParagraph(source);
  const speakers: string[] = [];
  const seen = new Set<string>();

  for (const segment of segments) {
    if (!segment.speaker) continue;
    const name = isPrabhupada(segment.speaker)
      ? CANONICAL_PRABHUPADA_SPEAKER
      : segment.speaker.trim();
    const key = name.normalize("NFC").toLocaleLowerCase("en");
    if (!name || seen.has(key)) continue;
    seen.add(key);
    speakers.push(name);
  }

  const unidentified = speakers.length === 0 || segments.some((segment) =>
    segment.speaker === null && source.slice(segment.start, segment.end).trim().length > 0);

  return {
    speakers,
    displaySpeaker: speakers.length > 0 ? speakers.join(", ") : null,
    unidentified,
    confidence: unidentified ? "unknown" : "labelled",
  };
}

/**
 * Project a mixed recorded exchange onto only explicitly labelled Prabhupāda
 * turns. Every returned byte is an exact slice of `source`; joining with an
 * empty string inserts no connective prose or punctuation. A guest-only or
 * wholly unlabelled row projects to the empty string and must be dropped by
 * the caller.
 */
export function projectPrabhupadaSegments(source: string): PrabhupadaSegmentProjection {
  const text = source || "";
  const segments = segmentTranscriptParagraph(text);
  const kept = segments.filter((segment) => isPrabhupada(segment.speaker));
  const guests = segments.filter((segment) =>
    segment.speaker !== null && !isPrabhupada(segment.speaker));
  const unknown = segments.filter((segment) => segment.speaker === null);

  return {
    text: kept.map((segment) => text.slice(segment.start, segment.end)).join(""),
    keptSegments: kept.length,
    guestSegmentsRemoved: guests.length,
    unknownSegmentsRemoved: unknown.length,
  };
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
  if (!segments.some(s => s.explicitBoundary)) return null;
  return segments
    .filter(s => isPrabhupada(s.speaker))
    .map(s => ({ start: s.start, end: s.end }));
}
