/**
 * 13-passage-label.ts — The quiet attribution line above every passage
 *
 * Builds the "TYPE + SOURCE + SPEAKER" label rendered above each passage:
 *   Bhagavad-gītā 6.34 · Translation · Arjuna to Kṛṣṇa
 *   Śrīmad-Bhāgavatam 5.6.5 · Purport · Śrīla Prabhupāda
 *   Lecture · Los Angeles, 1969
 *   Conversation · Prabhupāda replying
 *   Letter · to Sharon Suzuki
 *
 * Labels are metadata, never doctrine. A speaker appears ONLY when it is
 * confidently known (uvāca markers, transcript Name: prefixes, letter
 * recipient fields) — otherwise the segment is simply omitted, never guessed.
 * "Śrīla Prabhupāda" is claimed for purports and book prose ONLY when the
 * passage's authorship is HIS (12-provenance).
 *
 * Pure module: no Supabase imports, safe for both server and client, so the
 * essay, references mode, dig-deeper cards, preview sheets, and the verse
 * page all compute identical labels from the same hit fields.
 */
import { type Authorship, getBookName, authorshipFor, provenanceNoteFor } from "@/app/lib/12-provenance";
import { isPrabhupada } from "@/app/lib/15-transcript-speakers";

export interface PassageLabel {
  /** Ordered segments joined with " · " for display. */
  parts: string[];
  /** Plain-language authorship warning; empty when the words are his. */
  provenanceNote: string;
}

export function formatLabel(label: PassageLabel): string {
  return label.parts.filter(Boolean).join(" · ");
}

/* ── shared field shapes (subsets of the search hit interfaces) ── */

interface VerseLike {
  scripture?: string;
  verse_number?: string;
  chapter_number?: string | number;
  canto_or_division?: string;
  book_slug?: string;
  vedabase_url?: string;
  authorship?: Authorship;
  provenanceNote?: string;
  speaker?: string;
  speakerTo?: string;
}

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

/** "Bhagavad-gītā 6.34", "Śrīmad-Bhāgavatam 5.6.5", "Caitanya-caritāmṛta Madhya 15.11" */
function verseSource(v: VerseLike): string {
  const slug = (v.book_slug || v.scripture || "").toLowerCase();
  const title = bookTitleFor(slug);
  const num = (v.verse_number || "").replace(/^(Text|Verse)\s+/i, "").trim();
  const bits = [v.canto_or_division, v.chapter_number, num].filter(x => x !== undefined && x !== null && String(x).trim() !== "");
  // Numeric segments join with dots (6.34); a named division stays a word (Madhya 15.11).
  const first = String(bits[0] ?? "");
  const ref = /^\d/.test(first) || bits.length === 0
    ? bits.join(".")
    : `${first} ${bits.slice(1).join(".")}`;
  return ref ? `${title} ${ref}` : title;
}

/** Fall back to client-side derivation when a cached response predates annotation. */
function verseAuthorship(v: VerseLike): Authorship {
  if (v.authorship) return v.authorship;
  return authorshipFor({
    kind: "verse",
    bookSlug: (v.book_slug || v.scripture || "").toLowerCase(),
    vedabaseUrl: v.vedabase_url,
    canto: v.canto_or_division,
    chapter: v.chapter_number,
  });
}

function verseNote(v: VerseLike): string {
  if (v.provenanceNote !== undefined) return v.provenanceNote;
  return provenanceNoteFor((v.book_slug || v.scripture || "").toLowerCase(), verseAuthorship(v));
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

export function labelForVerse(v: VerseLike): PassageLabel {
  const speaker = v.speaker ? (v.speakerTo ? `${v.speaker} to ${v.speakerTo}` : v.speaker) : "";
  return { parts: [verseSource(v), "Translation", speaker], provenanceNote: verseNote(v) };
}

export function labelForPurport(v: VerseLike): PassageLabel {
  const speaker = verseAuthorship(v) === "HIS" ? "Śrīla Prabhupāda" : "";
  return { parts: ["Purport", speaker], provenanceNote: verseNote(v) };
}

/** Purport label with the full source, for surfaces that show a purport alone. */
export function labelForPurportFull(v: VerseLike): PassageLabel {
  const speaker = verseAuthorship(v) === "HIS" ? "Śrīla Prabhupāda" : "";
  return { parts: [verseSource(v), "Purport", speaker], provenanceNote: verseNote(v) };
}

export function labelForProse(p: ProseLike): PassageLabel {
  const authorship = p.authorship ?? authorshipFor({ kind: "prose", bookSlug: p.book_slug });
  const note = p.provenanceNote ?? provenanceNoteFor(p.book_slug, authorship);
  const speaker = authorship === "HIS" ? "Śrīla Prabhupāda" : "";
  return { parts: [getBookName(p.book_slug || ""), "Book passage", speaker], provenanceNote: note };
}

export function labelForTranscript(t: TranscriptLike): PassageLabel {
  return {
    parts: [transcriptKind(t), placeAndYear(t.location, t.date), t.speaker || ""],
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
      // The speaker column is a deterministic read of the paragraph's own
      // "Name:" prefix. A guest's words carry an explicit warning — the one
      // failure this corpus cannot afford is a visitor quoted as Śrīla
      // Prabhupāda. An unlabelled paragraph is honestly unidentified.
      if (p.speaker && !isPrabhupada(p.speaker)) {
        return { ...base, provenanceNote: `Spoken by ${p.speaker} — not Śrīla Prabhupāda` };
      }
      if (!p.speaker && p.speakerConfidence === "unknown") {
        return {
          ...base,
          provenanceNote: "Speaker not identified — part of a recorded conversation",
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
 * the main-tier labels: additional passages are built from retrieval data
 * without the re-fetched row fields (canto, chapter, URL) the authorship truth
 * table needs, so this label never claims "Śrīla Prabhupāda" for a purport or
 * book passage it cannot verify. Type and citation only — plus the speaker
 * warning for lecture lines, which retrieval does carry.
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
      const parts = [transcriptKind({ title: p.reference || "" }), placeAndYear(p.location || "", p.date || ""), p.speaker || ""];
      const note =
        p.speaker && !isPrabhupada(p.speaker)
          ? `Spoken by ${p.speaker} — not Śrīla Prabhupāda`
          : "";
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
