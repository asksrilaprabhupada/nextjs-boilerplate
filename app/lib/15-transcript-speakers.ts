/**
 * 15-transcript-speakers.ts — Who speaks inside a lecture/conversation paragraph
 *
 * Transcript paragraphs are verbatim multi-speaker blocks with `Name:` prefixes
 * baked into body_text (e.g. "Prabhupāda: …\nPradyumna: …"); many continuation
 * paragraphs carry no prefix at all. This module segments a paragraph by those
 * prefixes so display attribution is claimed only on evidence. Every speaker's
 * text remains present and eligible for result previews.
 *
 * Rules, in the conservative direction:
 *   - A paragraph with NO prefixes gets NO speaker name (never guess).
 *   - In a prefixed paragraph, an unlabeled leading run remains unidentified.
 *
 * Pure module (no Supabase imports), shared by the fold helpers (server +
 * client) and the search route.
 */
export interface TranscriptSegment {
  /** Trusted speaker name as written in the prefix; null when not attributable. */
  speaker: string | null;
  /** True when a line-level `...:` turn boundary started this segment. */
  explicitBoundary: boolean;
  start: number;
  end: number;
}

export const CANONICAL_PRABHUPADA_SPEAKER = "Śrīla Prabhupāda";

export const UNKNOWN_TRANSCRIPT_SPEAKER = "Speaker not identified";

export interface TranscriptSpeakerAttribution {
  /** Unique proved names or the unknown sentinel, in first-appearance order. */
  speakers: string[];
  /** Compact value for the existing single speaker wire field. */
  displaySpeaker: string | null;
  /** True when any displayed bytes have no explicit line-level speaker. */
  unidentified: boolean;
  confidence: "labelled" | "unknown";
}

/**
 * Convert the authoritative database array into the existing string-valued
 * speaker field. NULL (not processed), an empty array (processed but unproved),
 * or malformed data all fail closed as unidentified. First-appearance order is
 * preserved exactly as stored and body text is never consulted.
 */
export function storedTranscriptSpeakerAttribution(
  value: unknown,
): TranscriptSpeakerAttribution {
  const unidentifiedResult: TranscriptSpeakerAttribution = {
    speakers: [],
    displaySpeaker: null,
    unidentified: true,
    confidence: "unknown",
  };
  if (!Array.isArray(value)) return unidentifiedResult;

  const speakers: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.trim()) return unidentifiedResult;
    const name = item.trim().normalize("NFC");
    const key = name.toLocaleLowerCase("en");
    if (seen.has(key)) return unidentifiedResult;
    seen.add(key);
    speakers.push(name);
  }

  const unidentified =
    speakers.length === 0 || speakers.includes(UNKNOWN_TRANSCRIPT_SPEAKER);
  return {
    speakers,
    displaySpeaker: speakers.length > 0 ? speakers.join(" · ") : null,
    unidentified,
    confidence: unidentified ? "unknown" : "labelled",
  };
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
    displaySpeaker: speakers.length > 0 ? speakers.join(" · ") : null,
    unidentified,
    confidence: unidentified ? "unknown" : "labelled",
  };
}
