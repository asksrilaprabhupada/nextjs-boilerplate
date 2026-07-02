/**
 * 12-provenance.ts — Authorship & provenance foundation
 *
 * The single source of truth for WHOSE WORDS a passage is. Everything here is
 * derived in app code from book/scripture identity plus the Śrīmad-Bhāgavatam
 * completion rule — never from the database's `books.author` column, which
 * wrongly credits Śrīla Prabhupāda for every book.
 *
 * Authorship values:
 *   HIS           — Śrīla Prabhupāda's own words (books he wrote, his letters;
 *                   for lectures/conversations, his own spoken lines).
 *   NOT_HIS       — someone else's words served from our database: `spl` (a
 *                   biography ABOUT him by Satsvarūpa dāsa Goswami), `rkd` and
 *                   `mbk` (retellings by another author), `bs` (the 1932
 *                   Gauḍīya Maṭha edition — its foreword in our own database is
 *                   signed "Siddhānta Sarasvatī … 1932", so the translation and
 *                   purports are Bhaktisiddhānta Sarasvatī Ṭhākura's, verified
 *                   from the book's own front matter), and Śrīmad-Bhāgavatam
 *                   from Canto 10 Chapter 14 onward (completed by his
 *                   disciples after his passing).
 *   MIXED_VERIFY  — begun by him, completed by a disciple, exact boundary not
 *                   yet verified from the book's own front matter (`nbs`,
 *                   `mms` — our database holds no front matter for them).
 *                   Treated like NOT_HIS everywhere until verified.
 *
 * Pure module: no Supabase imports, safe for both server and client.
 * Labels produced here are metadata, never doctrine.
 */

export type Authorship = "HIS" | "NOT_HIS" | "MIXED_VERIFY";

export interface BookInfo {
  title: string;
  authorship: Authorship;
  /** Book exists in our database but NOT on vedabase.io — never build links. */
  noVedabase?: boolean;
}

/**
 * Canonical slug → book registry (titles merged from the previously duplicated
 * server/client BOOK_NAMES maps; the server map's titles win).
 * `sb` is HIS here at book level; the per-passage disciple-completion rule
 * (Canto 10 Ch 14 onward) is applied by `authorshipFor`.
 */
export const BOOK_REGISTRY: Record<string, BookInfo> = {
  bg: { title: "Bhagavad-gītā As It Is", authorship: "HIS" },
  sb: { title: "Śrīmad-Bhāgavatam", authorship: "HIS" },
  cc: { title: "Śrī Caitanya-caritāmṛta", authorship: "HIS" },
  noi: { title: "Nectar of Instruction", authorship: "HIS" },
  iso: { title: "Śrī Īśopaniṣad", authorship: "HIS" },
  bs: { title: "Śrī Brahma-saṁhitā", authorship: "NOT_HIS" },
  lob: { title: "Light of the Bhāgavata", authorship: "HIS" },
  kb: { title: "Kṛṣṇa, the Supreme Personality of Godhead", authorship: "HIS" },
  nod: { title: "The Nectar of Devotion", authorship: "HIS" },
  ssr: { title: "The Science of Self-Realization", authorship: "HIS" },
  tlc: { title: "Teachings of Lord Caitanya", authorship: "HIS" },
  tlk: { title: "Teachings of Lord Kapila", authorship: "HIS" },
  tqk: { title: "Teachings of Queen Kuntī", authorship: "HIS" },
  sc: { title: "A Second Chance", authorship: "HIS" },
  bbd: { title: "Beyond Birth and Death", authorship: "HIS" },
  bhakti: { title: "Bhakti: The Art of Eternal Love", authorship: "HIS" },
  cat: { title: "Civilization and Transcendence", authorship: "HIS" },
  josd: { title: "The Journey of Self-Discovery", authorship: "HIS" },
  owk: { title: "On the Way to Kṛṣṇa", authorship: "HIS" },
  pop: { title: "The Path of Perfection", authorship: "HIS" },
  poy: { title: "The Perfection of Yoga", authorship: "HIS" },
  pqpa: { title: "Perfect Questions, Perfect Answers", authorship: "HIS" },
  rv: { title: "Rāja-vidyā: The King of Knowledge", authorship: "HIS" },
  cabh: { title: "Chant and Be Happy", authorship: "HIS" },
  spl: { title: "Śrīla Prabhupāda-līlāmṛta", authorship: "NOT_HIS" },
  rkd: { title: "Rāmāyaṇa", authorship: "NOT_HIS" },
  mbk: { title: "Mahābhārata", authorship: "NOT_HIS" },
  ejop: { title: "Easy Journey to Other Planets", authorship: "HIS", noVedabase: true },
  ekc: { title: "Elevation to Kṛṣṇa Consciousness", authorship: "HIS", noVedabase: true },
  kcty: { title: "Kṛṣṇa Consciousness: The Topmost Yoga System", authorship: "HIS", noVedabase: true },
  lcfl: { title: "Life Comes From Life", authorship: "HIS", noVedabase: true },
  mog: { title: "Message of Godhead", authorship: "HIS", noVedabase: true },
  rtw: { title: "Renunciation Through Wisdom", authorship: "HIS", noVedabase: true },
  top: { title: "Transcendental Teachings of Prahlāda Mahārāja", authorship: "HIS", noVedabase: true },
  nbs: { title: "Nārada Bhakti Sūtra", authorship: "MIXED_VERIFY", noVedabase: true },
  mms: { title: "Mukunda-mālā-stotra", authorship: "MIXED_VERIFY", noVedabase: true },
};

export function getBookName(slug: string): string {
  return BOOK_REGISTRY[slug?.toLowerCase()]?.title || slug || "Unknown";
}

/** Books that exist in our database but NOT on vedabase.io — never create links for these */
export const NO_VEDABASE_BOOKS = new Set(
  Object.keys(BOOK_REGISTRY).filter(slug => BOOK_REGISTRY[slug].noVedabase),
);

/**
 * Parse an SB verse's canto and chapter. Primary source: the verse's own
 * vedabase_url path segments (https://vedabase.io/en/library/sb/10/29/4/).
 * Fallback: the canto_or_division / chapter_number fields. Returns null when
 * either value is non-numeric (CC divisions like "adi", malformed URLs) —
 * null simply means the SB completion rule does not fire.
 */
export function parseSbCantoChapter(
  vedabaseUrl?: string,
  cantoField?: string | number,
  chapterField?: string | number,
): { canto: number; chapter: number } | null {
  const m = vedabaseUrl?.match(/\/library\/sb\/(\d+)\/(\d+)\//);
  if (m) return { canto: parseInt(m[1], 10), chapter: parseInt(m[2], 10) };
  const canto = parseInt(String(cantoField ?? ""), 10);
  const chapter = parseInt(String(chapterField ?? ""), 10);
  if (Number.isFinite(canto) && Number.isFinite(chapter)) return { canto, chapter };
  return null;
}

/**
 * Śrīmad-Bhāgavatam completion rule: Śrīla Prabhupāda's own work runs through
 * Canto 10 Chapter 13 inclusive; from 10.14 onward (and all of Cantos 11–12)
 * the translations and purports were completed by his disciples.
 */
export function sbDiscipleCompleted(canto: number, chapter: number): boolean {
  return canto > 10 || (canto === 10 && chapter >= 14);
}

/**
 * Derive authorship for one passage. Letters are always his. Lectures and
 * conversations are HIS at passage level (his own spoken lines; per-line
 * attribution is handled by 15-transcript-speakers). Unknown book slugs are
 * MIXED_VERIFY — never assume words are his without evidence.
 */
export function authorshipFor(input: {
  kind: "verse" | "prose" | "lecture" | "letter";
  bookSlug?: string;
  vedabaseUrl?: string;
  canto?: string | number;
  chapter?: string | number;
}): Authorship {
  if (input.kind === "letter" || input.kind === "lecture") return "HIS";
  const slug = input.bookSlug?.toLowerCase() || "";
  const book = BOOK_REGISTRY[slug];
  if (!book) return "MIXED_VERIFY";
  if (slug === "sb") {
    const cc = parseSbCantoChapter(input.vedabaseUrl, input.canto, input.chapter);
    if (cc && sbDiscipleCompleted(cc.canto, cc.chapter)) return "NOT_HIS";
    return "HIS";
  }
  return book.authorship;
}

/**
 * Plain-language provenance note shown with a passage's label when its words
 * are not (or not verifiably) Śrīla Prabhupāda's. Empty string for HIS.
 * Contextual names come from the books' own front matter, never from
 * transcript text.
 */
export function provenanceNoteFor(bookSlug: string | undefined, authorship: Authorship): string {
  if (authorship === "HIS") return "";
  const slug = bookSlug?.toLowerCase() || "";
  switch (slug) {
    case "spl":
      return "From a biography of Śrīla Prabhupāda by Satsvarūpa dāsa Goswami — not his words";
    case "rkd":
    case "mbk":
      return "A retelling by another author — not Śrīla Prabhupāda's words";
    case "bs":
      return "Translation and purports by Bhaktisiddhānta Sarasvatī Ṭhākura — not by Śrīla Prabhupāda";
    case "sb":
      return "Completed by his disciples after his passing";
    case "nbs":
    case "mms":
      return "Begun by Śrīla Prabhupāda, completed by a disciple — authorship mixed";
    default:
      return "Authorship not verified — may not be Śrīla Prabhupāda's words";
  }
}
