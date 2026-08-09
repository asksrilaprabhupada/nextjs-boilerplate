/**
 * 13-passage-label.ts — The quiet attribution line above every passage
 *
 * Builds the "TYPE + SOURCE + SPEAKER" label rendered above each passage:
 *   Bhagavad-gītā 6.34 · Translation · Arjuna to Kṛṣṇa
 *   Śrīmad-Bhāgavatam 5.6.5 · Purport · Śrīla Prabhupāda
 *   Lecture · Los Angeles, 1969
 *   Conversation · Dr. Patel:
 *   Letter · to Sharon Suzuki
 *
 * Labels are metadata, never doctrine. A speaker appears ONLY when it is
 * confidently known (uvāca markers, transcript Name: prefixes, letter
 * recipient fields) — otherwise the segment is simply omitted, never guessed.
 * "Śrīla Prabhupāda" is claimed for purports and book prose ONLY when the
 * passage's authorship is HIS (12-provenance).
 *
 * Pure module: no Supabase imports. The search adapter computes both main and
 * additional-passage labels here once; result cards, the evidence explorer,
 * and preview sheets then print those same wire fields.
 */
import { type Authorship, getBookName, authorshipFor, provenanceNoteFor } from "@/app/lib/12-provenance";
import {
  transcriptSpeakerDisplay,
  UNIDENTIFIED_SPEAKER_NOTICE,
} from "@/app/lib/21-transcript-attribution";

export interface PassageLabel {
  /** Ordered segments joined with " · " for display. */
  parts: string[];
  /** Plain-language provenance notice; empty when the label is sufficient. */
  provenanceNote: string;
}

export function formatLabel(label: PassageLabel): string {
  return label.parts.filter(Boolean).join(" · ");
}

/* ── shared field shapes (subsets of the search hit interfaces) ── */

interface ProseLike {
  book_slug?: string;
  chapter_title?: string;
  authorship?: Authorship;
  provenanceNote?: string;
}

interface TranscriptLike {
  title?: string;
  date?: string;
  location?: string;
  occasion?: string;
  speaker?: string;
  provenanceNote?: string;
}

interface LetterLike {
  recipient?: string;
  date?: string;
  provenanceNote?: string;
}

/* ── helpers ── */

/** "Bhagavad-gītā As It Is" is verbose for a label line; use reading names. */
const LABEL_TITLES: Record<string, string> = {
  bg: "Bhagavad-gītā",
  sb: "Śrīmad-Bhāgavatam",
  cc: "Caitanya-caritāmṛta",
};

function bookTitleFor(slug: string): string {
  const s = slug.toLowerCase();
  return LABEL_TITLES[s] || getBookName(s);
}

function yearOf(date?: string): string {
  const m = (date || "").match(/\b(1[89]\d\d|20\d\d)\b/);
  return m ? m[1] : "";
}

/** "Los Angeles, 1969" — whatever parts exist, joined naturally. */
function placeAndYear(location?: string, date?: string): string {
  const year = yearOf(date);
  const loc = (location || "").trim();
  if (loc && year) return `${loc}, ${year}`;
  return loc || year;
}

/**
 * Lecture vs conversation, derived from the transcript's own title/occasion
 * wording only — metadata, never content.
 */
function transcriptKind(t: TranscriptLike): string {
  const src = `${t.title || ""} ${t.occasion || ""}`.toLowerCase();
  if (/conversation|morning walk|room conversation|interview|press|meeting|discussion/.test(src)) return "Conversation";
  return "Lecture";
}

/* ── label builders ── */

export function labelForProse(p: ProseLike): PassageLabel {
  const authorship = p.authorship ?? authorshipFor({ kind: "prose", bookSlug: p.book_slug });
  const note = p.provenanceNote ?? provenanceNoteFor(p.book_slug, authorship);
  const speaker = authorship === "HIS" ? "Śrīla Prabhupāda" : "";
  return { parts: [getBookName(p.book_slug || ""), "Book passage", speaker], provenanceNote: note };
}

export function labelForTranscript(t: TranscriptLike): PassageLabel {
  return {
    parts: [transcriptKind(t), placeAndYear(t.location, t.date), transcriptSpeakerDisplay(t.speaker)],
    provenanceNote: t.provenanceNote || "",
  };
}

export function labelForLetter(l: LetterLike): PassageLabel {
  const to = (l.recipient || "").trim();
  const year = yearOf(l.date);
  return {
    parts: ["Letter", to ? `to ${to}` : "", year],
    provenanceNote: l.provenanceNote || "",
  };
}

/* ── labels for the wire passage shape ──
   The /api/search response now ships one flat passage list; the server computes
   each passage's label HERE, once, so every surface prints the same line and
   the client never re-derives provenance. */

interface WirePassageLike {
  type: "verse" | "purport" | "book" | "lecture" | "letter";
  /** Formatted citation, e.g. "BG 6.34"; the book slug for book passages. */
  reference: string | null;
  url?: string | null;
  scripture?: string | null;
  division?: string | null;
  chapterNumber?: number | null;
  speaker?: string | null;
  /** Transcript speaker provenance ('labelled' | 'inherited' | 'unknown'). */
  speakerConfidence?: string | null;
  /** True when any displayed transcript bytes have no explicit speaker label. */
  speakerUnidentified?: boolean;
  recipient?: string | null;
  date?: string | null;
  location?: string | null;
}

/** "BG 6.34" → "Bhagavad-gītā 6.34"; unknown sigla pass through unchanged. */
function readableReference(reference: string | null): string {
  const ref = (reference || "").trim();
  if (!ref) return "";
  const m = ref.match(/^([A-Za-z]{2,4})\s+(.+)$/);
  if (!m) return ref;
  const title = bookTitleFor(m[1].toLowerCase());
  return title !== m[1].toLowerCase() ? `${title} ${m[2]}` : ref;
}

function wireVerseAuthorship(p: WirePassageLike): Authorship {
  return authorshipFor({
    kind: "verse",
    bookSlug: (p.scripture || "").toLowerCase(),
    vedabaseUrl: p.url ?? undefined,
    canto: p.division ?? undefined,
    chapter: p.chapterNumber ?? undefined,
  });
}

export function labelForWirePassage(p: WirePassageLike): PassageLabel {
  switch (p.type) {
    case "verse": {
      const auth = wireVerseAuthorship(p);
      return {
        parts: [readableReference(p.reference), "Translation", p.speaker || ""],
        provenanceNote: provenanceNoteFor((p.scripture || "").toLowerCase(), auth),
      };
    }
    case "purport": {
      const auth = wireVerseAuthorship(p);
      return {
        parts: [readableReference(p.reference), "Purport", auth === "HIS" ? "Śrīla Prabhupāda" : ""],
        provenanceNote: provenanceNoteFor((p.scripture || "").toLowerCase(), auth),
      };
    }
    case "book":
      return labelForProse({ book_slug: p.reference || "" });
    case "lecture": {
      const base = labelForTranscript({
        title: p.reference || "",
        date: p.date || "",
        location: p.location || "",
        speaker: p.speaker || "",
      });
      // A name is sufficient attribution; repeating a negative comparison on
      // every guest passage is noisy. Silence is unsafe only when no speaker
      // is identified, so that case receives one explicit notice.
      if (!p.speaker || p.speakerUnidentified || p.speakerConfidence === "unknown") {
        return {
          ...base,
          provenanceNote: UNIDENTIFIED_SPEAKER_NOTICE,
        };
      }
      return base;
    }
    case "letter":
      return labelForLetter({ recipient: p.recipient || "", date: p.date || "" });
  }
}

/**
 * Label for a SECOND-TIER citation line. Deliberately more conservative than
 * the main-tier labels: additional passages do not carry the fresh canto,
 * chapter, or URL fields the authorship truth table needs (even when a filtered
 * transcript's body was freshly verified). This label therefore never claims
 * "Śrīla Prabhupāda" for a purport or book passage it cannot verify. Type and
 * citation only — plus plain speaker attribution (or the explicit unidentified
 * notice) for recorded talks.
 */
export function labelForAdditionalPassage(p: WirePassageLike): PassageLabel {
  switch (p.type) {
    case "verse":
      return { parts: [readableReference(p.reference), "Translation"], provenanceNote: "" };
    case "purport":
      return { parts: [readableReference(p.reference), "Purport"], provenanceNote: "" };
    case "book":
      return { parts: [getBookName(p.reference || ""), "Book passage"], provenanceNote: "" };
    case "lecture": {
      const parts = [
        transcriptKind({ title: p.reference || "" }),
        placeAndYear(p.location || "", p.date || ""),
        transcriptSpeakerDisplay(p.speaker),
      ];
      const note = p.speaker && !p.speakerUnidentified ? "" : UNIDENTIFIED_SPEAKER_NOTICE;
      return { parts, provenanceNote: note };
    }
    case "letter":
      return labelForLetter({ recipient: p.recipient || "", date: p.date || "" });
  }
}

/** Label for the folded purport shown under a verse card, or null. */
export function purportLabelForWirePassage(p: WirePassageLike): string | null {
  if (p.type !== "verse") return null;
  const auth = wireVerseAuthorship(p);
  return formatLabel({
    parts: ["Purport", auth === "HIS" ? "Śrīla Prabhupāda" : ""],
    provenanceNote: "",
  });
}
