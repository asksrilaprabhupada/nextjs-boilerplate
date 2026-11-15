/**
 * 03-cinematic-dig-deeper.tsx — Dig Deeper (cinematic redesign)
 *
 * Design: docs/redesign/designs/DigDeeper.dc.html (the phone gets the same page,
 * narrowed). Every other passage THIS SEARCH retrieved — not everything the
 * library holds; the candidate pool is capped — browsed through a three-step
 * shelf: 1 Source → 2 Book → 3 Chapter, with a breadcrumb and a "Best match /
 * Book order" toggle. Filters are only source, book and the book's own
 * hierarchy (canto, līlā, chapter): no speaker filter and no topic filter, as
 * the owner decided. Each row shows its server-computed label, its
 * sentence-safe snippet, and the citation bar.
 *
 * The facet logic is unchanged from the previous explorer: facets come only
 * from structured wire fields or strict reference formats, presentation labels
 * are never treated as metadata, and anything unproved stays "Unknown". The
 * one addition is "Book order" (book, canto or līlā, chapter, verse; dated
 * talks and letters oldest first). "Best match" keeps the reranker's order.
 *
 * Also exports the answer page's Dig Deeper card.
 */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import SiteHeader from "../cinematic/11-site-header";
import SiteFooter from "../cinematic/12-site-footer";
import CitationBar from "./04-citation-bar";
import { BOOK_REGISTRY } from "@/app/lib/12-provenance";
import type { AdditionalSearchPassage } from "@/app/lib/types/01-search";

const ALL = "";
export const UNKNOWN_METADATA = "Unknown";

export type DigDeeperContentFamily =
  | "all"
  | "scripture"
  | "verse"
  | "purport"
  | "book"
  | "lecture"
  | "letter";

export type DigDeeperSort = "relevance" | "newest" | "book";
export type DigDeeperGrouping = "ranked" | "source";

export interface DigDeeperFilters {
  family: DigDeeperContentFamily;
  query: string;
  occasion: string;
  book: string;
  division: string;
  chapter: string;
  speaker: string;
  location: string;
  recipient: string;
  year: string;
}

export interface ParsedAdditionalSearchPassage {
  passage: AdditionalSearchPassage;
  originalIndex: number;
  occasion: string | null;
  book: string | null;
  division: string | null;
  chapter: string | null;
  speakers: string[] | null;
  location: string | null;
  recipient: string | null;
  year: string | null;
  dateSort: number | null;
  sourceGroup: string;
  searchText: string;
}

const EMPTY_FILTERS: DigDeeperFilters = {
  family: "all",
  query: "",
  occasion: ALL,
  book: ALL,
  division: ALL,
  chapter: ALL,
  speaker: ALL,
  location: ALL,
  recipient: ALL,
  year: ALL,
};

const TYPE_LABELS: Record<AdditionalSearchPassage["type"], string> = {
  verse: "Verse",
  purport: "Purport",
  book: "Book",
  lecture: "Lecture / conversation",
  letter: "Letter",
};

const FAMILY_DEFINITIONS: ReadonlyArray<{
  value: DigDeeperContentFamily;
  label: string;
}> = [
  { value: "all", label: "All content" },
  { value: "scripture", label: "Scripture / Books" },
  { value: "verse", label: "Verses" },
  { value: "purport", label: "Purports" },
  { value: "book", label: "Books" },
  { value: "lecture", label: "Lectures / Conversations" },
  { value: "letter", label: "Letters" },
];

const BOOK_BY_SLUG: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(BOOK_REGISTRY).map(([slug, book]) => [slug, book.title]),
);

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

function clean(value: string | null | undefined): string {
  return value?.replace(/\s+/g, " ").trim() ?? "";
}

export function normalizeDigDeeperText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[’‘]/g, "'")
    .replace(/[–—]/g, "-")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();
}

interface ParsedReferenceMetadata {
  book: string | null;
  division: string | null;
  chapter: string | null;
}

const CC_DIVISIONS: Readonly<Record<string, string>> = {
  adi: "Ādi-līlā",
  madhya: "Madhya-līlā",
  antya: "Antya-līlā",
};

/** Parse only the raw reference field and fail closed on every unknown shape. */
export function parseAdditionalReference(
  passage: AdditionalSearchPassage,
): ParsedReferenceMetadata {
  const rawReference = clean(passage.reference);
  const reference = normalizeDigDeeperText(rawReference);

  if (passage.type === "book") {
    const prose = reference.match(/^([a-z0-9-]+)(?:\s+¶\s*\d+)?$/);
    const provedBook = prose ? BOOK_BY_SLUG[prose[1]] : undefined;
    return {
      book: provedBook ?? UNKNOWN_METADATA,
      division: null,
      chapter: UNKNOWN_METADATA,
    };
  }

  if (passage.type !== "verse" && passage.type !== "purport") {
    return { book: null, division: null, chapter: null };
  }

  const bg = reference.match(/^bg\s+(\d+)\.(\d+)(?:-(\d+))?$/);
  if (bg) {
    return {
      book: BOOK_BY_SLUG.bg,
      division: null,
      chapter: `Chapter ${bg[1]}`,
    };
  }

  // The live purport lane stores SB/CC as scripture + chapter + verse. The
  // siglum and first number therefore prove the work and chapter, while the
  // omitted canto or lila must remain unknown.
  if (passage.type === "purport") {
    const sbPurport = reference.match(/^sb\s+(\d+)\.(?:text\s+)?(\d+)(?:-(\d+))?$/);
    if (sbPurport) {
      return {
        book: BOOK_BY_SLUG.sb,
        division: null,
        chapter: `Chapter ${sbPurport[1]}`,
      };
    }

    const ccPurport = reference.match(/^cc\s+(\d+)\.(?:text\s+)?(\d+)(?:-(\d+))?$/);
    if (ccPurport) {
      return {
        book: BOOK_BY_SLUG.cc,
        division: null,
        chapter: `Chapter ${ccPurport[1]}`,
      };
    }
  }

  const sb = reference.match(/^sb\s+(\d+)\.(\d+)\.(?:text\s+)?(\d+)(?:-(\d+))?$/);
  if (sb) {
    return {
      book: BOOK_BY_SLUG.sb,
      division: `Canto ${sb[1]}`,
      chapter: `Chapter ${sb[2]}`,
    };
  }

  const cc = reference.match(
    /^cc\s+(adi|madhya|antya)(?:-lila)?(?:\s+|\.)(\d+)\.(?:text\s+)?(\d+)(?:-(\d+))?$/,
  );
  if (cc) {
    return {
      book: BOOK_BY_SLUG.cc,
      division: CC_DIVISIONS[cc[1]],
      chapter: `Chapter ${cc[2]}`,
    };
  }

  const brahmaSamhita = reference.match(/^bs\s+(\d+)\.(\d+)(?:-(\d+))?$/);
  if (brahmaSamhita) {
    return {
      book: BOOK_BY_SLUG.bs,
      division: null,
      chapter: `Chapter ${brahmaSamhita[1]}`,
    };
  }

  const textOnly = reference.match(/^(noi|iso|nbs|mms)\s+(?:text\s+|mantra\s+)?(?:invocation|\d+(?:-\d+)?)$/);
  if (textOnly) {
    return {
      book: BOOK_BY_SLUG[textOnly[1]],
      division: null,
      chapter: null,
    };
  }

  return {
    book: UNKNOWN_METADATA,
    division: null,
    chapter: UNKNOWN_METADATA,
  };
}

function parseOccasion(
  passage: AdditionalSearchPassage,
): string | null {
  if (passage.type !== "lecture") return null;
  const reference = normalizeDigDeeperText(clean(passage.reference));
  if (/\bmorning walk\b/.test(reference)) return "Morning Walk";
  if (/\broom conversation\b/.test(reference)) return "Room Conversation";
  if (/\blecture\b/.test(reference)) return "Lecture";
  if (/\binterview\b/.test(reference)) return "Interview";
  if (/\bpress conference\b/.test(reference)) return "Press Conference";
  if (/\b(?:meeting|discussion)\b/.test(reference)) return "Meeting / Discussion";
  if (/\bconversation\b/.test(reference)) return "Conversation";
  return "Other recorded talk";
}

function parseSpeakers(passage: AdditionalSearchPassage): string[] | null {
  if (!passage.speaker && passage.type !== "lecture") return null;

  const speakers = clean(passage.speaker)
    .split(/\s*·\s*/u)
    .map(clean)
    .filter(Boolean);

  if (passage.speakerUnidentified && !speakers.includes("Speaker not identified")) {
    speakers.push("Speaker not identified");
  }
  if (speakers.length === 0) speakers.push(UNKNOWN_METADATA);
  return Array.from(new Set(speakers));
}

function parseYear(passage: AdditionalSearchPassage): string | null {
  const date = clean(passage.date);
  const directYear = date.match(/^(18\d{2}|19\d{2}|20\d{2}|21\d{2})-\d{2}-\d{2}$/)?.[1];
  if (directYear) return directYear;

  if (passage.type !== "lecture" && passage.type !== "letter") return null;
  return UNKNOWN_METADATA;
}

function parseDateSort(dateValue: string | null, year: string | null): number | null {
  const date = clean(dateValue);
  const iso = date.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return Number(iso[1]) * 10_000 + Number(iso[2]) * 100 + Number(iso[3]);

  const monthFirst = normalizeDigDeeperText(date).match(
    /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})$/,
  );
  if (monthFirst) {
    return Number(monthFirst[3]) * 10_000 + MONTHS[monthFirst[1]] * 100 + Number(monthFirst[2]);
  }

  const dayFirst = normalizeDigDeeperText(date).match(
    /^(\d{1,2})\s+(january|february|march|april|may|june|july|august|september|october|november|december),?\s+(\d{4})$/,
  );
  if (dayFirst) {
    return Number(dayFirst[3]) * 10_000 + MONTHS[dayFirst[2]] * 100 + Number(dayFirst[1]);
  }

  return year && year !== UNKNOWN_METADATA ? Number(year) * 10_000 : null;
}

function sourceGroupFor(
  passage: AdditionalSearchPassage,
  book: string | null,
  occasion: string | null,
): string {
  if (passage.type === "lecture") {
    const groups: Record<string, string> = {
      "Morning Walk": "Morning Walks",
      "Room Conversation": "Room Conversations",
      Lecture: "Lectures",
      Interview: "Interviews",
      "Press Conference": "Press Conferences",
      "Meeting / Discussion": "Meetings / Discussions",
      Conversation: "Conversations",
    };
    return (occasion && groups[occasion]) || "Other recorded talks";
  }
  if (passage.type === "letter") return "Letters";
  if (book && book !== UNKNOWN_METADATA) return book;
  return TYPE_LABELS[passage.type] === "Book" ? "Other books" : `${TYPE_LABELS[passage.type]}s`;
}

/**
 * Derives only display metadata that is stated in the passage fields. Missing or
 * unparseable applicable values remain explicitly Unknown; no corpus facts are
 * guessed from topic, title, location, or neighboring passages.
 */
export function parseAdditionalSearchPassage(
  passage: AdditionalSearchPassage,
  originalIndex = 0,
): ParsedAdditionalSearchPassage {
  const referenceMetadata = parseAdditionalReference(passage);
  const { book, division, chapter } = referenceMetadata;
  const occasion = parseOccasion(passage);
  const speakers = parseSpeakers(passage);
  const year = parseYear(passage);
  const location = clean(passage.location) ||
    (passage.type === "lecture" || passage.type === "letter" ? UNKNOWN_METADATA : null);
  const recipient = clean(passage.recipient) ||
    (passage.type === "letter" ? UNKNOWN_METADATA : null);
  const sourceGroup = sourceGroupFor(passage, book, occasion);

  const searchText = normalizeDigDeeperText(
    [
      passage.type,
      TYPE_LABELS[passage.type],
      passage.reference,
      passage.label,
      passage.provenanceNote,
      passage.snippet,
      passage.speaker,
      passage.recipient,
      passage.date,
      passage.location,
      occasion,
      book,
      division,
      chapter,
      speakers?.join(" "),
      year,
    ]
      .filter(Boolean)
      .join(" "),
  );

  return {
    passage,
    originalIndex,
    occasion,
    book,
    division,
    chapter,
    speakers,
    location,
    recipient,
    year,
    dateSort: parseDateSort(passage.date, year),
    sourceGroup,
    searchText,
  };
}

export function passageMatchesContentFamily(
  row: ParsedAdditionalSearchPassage,
  family: DigDeeperContentFamily,
): boolean {
  if (family === "all") return true;
  if (family === "scripture") {
    return row.passage.type === "verse" || row.passage.type === "purport" || row.passage.type === "book";
  }
  return row.passage.type === family;
}

export function filterAdditionalSearchPassages(
  rows: readonly ParsedAdditionalSearchPassage[],
  filters: DigDeeperFilters,
): ParsedAdditionalSearchPassage[] {
  const query = normalizeDigDeeperText(filters.query);
  return rows.filter((row) => {
    if (!passageMatchesContentFamily(row, filters.family)) return false;
    if (query && !row.searchText.includes(query)) return false;
    if (filters.occasion && row.occasion !== filters.occasion) return false;
    if (filters.book && row.book !== filters.book) return false;
    if (filters.division && row.division !== filters.division) return false;
    if (filters.chapter && row.chapter !== filters.chapter) return false;
    if (filters.speaker && !row.speakers?.includes(filters.speaker)) return false;
    if (filters.location && row.location !== filters.location) return false;
    if (filters.recipient && row.recipient !== filters.recipient) return false;
    if (filters.year && row.year !== filters.year) return false;
    return true;
  });
}

/* ── Book order ─────────────────────────────────────────────────────────── */

const BOOK_ORDER = new Map<string, number>(Object.values(BOOK_REGISTRY).map((book, index) => [book.title, index]));
const LILA_ORDER: Readonly<Record<string, number>> = { "Ādi-līlā": 1, "Madhya-līlā": 2, "Antya-līlā": 3 };
const FAMILY_RANK: Readonly<Record<AdditionalSearchPassage["type"], number>> = {
  verse: 0,
  purport: 0,
  book: 0,
  lecture: 1,
  letter: 2,
};

function firstNumber(value: string | null, pattern: RegExp): number {
  const match = value?.match(pattern);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function bookRank(book: string | null): number {
  if (!book || book === UNKNOWN_METADATA) return Number.POSITIVE_INFINITY;
  return BOOK_ORDER.get(book) ?? Number.POSITIVE_INFINITY;
}

function divisionRank(division: string | null): number {
  if (!division) return 0;
  return LILA_ORDER[division] ?? firstNumber(division, /(\d+)/);
}

function chapterRank(chapter: string | null): number {
  if (!chapter) return 0;
  return firstNumber(chapter, /(\d+)/);
}

function verseRank(reference: string | null): number {
  return firstNumber(reference, /(\d+)(?:-\d+)?\s*$/);
}

function compareNumbers(left: number, right: number): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function compareBookOrder(left: ParsedAdditionalSearchPassage, right: ParsedAdditionalSearchPassage): number {
  const family = compareNumbers(FAMILY_RANK[left.passage.type], FAMILY_RANK[right.passage.type]);
  if (family) return family;
  if (FAMILY_RANK[left.passage.type] === 0) {
    const keys: Array<[number, number]> = [
      [bookRank(left.book), bookRank(right.book)],
      [divisionRank(left.division), divisionRank(right.division)],
      [chapterRank(left.chapter), chapterRank(right.chapter)],
      [verseRank(left.passage.reference), verseRank(right.passage.reference)],
    ];
    for (const [a, b] of keys) {
      const step = compareNumbers(a, b);
      if (step) return step;
    }
  } else {
    const date = compareNumbers(left.dateSort ?? Number.POSITIVE_INFINITY, right.dateSort ?? Number.POSITIVE_INFINITY);
    if (date) return date;
  }
  return left.originalIndex - right.originalIndex;
}

export function sortAdditionalSearchPassages(
  rows: readonly ParsedAdditionalSearchPassage[],
  sort: DigDeeperSort,
): ParsedAdditionalSearchPassage[] {
  if (sort === "book") return [...rows].sort(compareBookOrder);
  return [...rows].sort((left, right) => {
    if (sort === "newest") {
      const leftDate = left.dateSort ?? Number.NEGATIVE_INFINITY;
      const rightDate = right.dateSort ?? Number.NEGATIVE_INFINITY;
      if (leftDate !== rightDate) return rightDate - leftDate;
    }

    // The response already carries the pipeline's authoritative relevance
    // order. Preserve it exactly; set-aside evidence legitimately has no
    // rerank score, so rebuilding the order from scores would be lossy.
    return left.originalIndex - right.originalIndex;
  });
}

/* ── Sources ────────────────────────────────────────────────────────────── */

export type DigSource = "scripture" | "lecture" | "letter";
const SOURCES: readonly DigSource[] = ["scripture", "lecture", "letter"];
const SOURCE_LABEL: Readonly<Record<DigSource, string>> = {
  scripture: "Books",
  lecture: "Lectures and conversations",
  letter: "Letters",
};
const SOURCE_SHORT: Readonly<Record<DigSource, string>> = {
  scripture: "Books",
  lecture: "Lectures",
  letter: "Letters",
};

function sourceOf(type: AdditionalSearchPassage["type"]): DigSource {
  return type === "lecture" ? "lecture" : type === "letter" ? "letter" : "scripture";
}

function countSources(list: readonly AdditionalSearchPassage[]): Record<DigSource, number> {
  const counts: Record<DigSource, number> = { scripture: 0, lecture: 0, letter: 0 };
  for (const passage of list) counts[sourceOf(passage.type)] += 1;
  return counts;
}

function trueTotalOf(list: readonly AdditionalSearchPassage[], totalCount?: number): number {
  const declared = typeof totalCount === "number" && Number.isFinite(totalCount) ? Math.trunc(totalCount) : list.length;
  return Math.max(list.length, declared);
}

const shownName = (value: string, unknown: string) => (value === UNKNOWN_METADATA ? unknown : value);

/* ── The answer page's card ─────────────────────────────────────────────── */

export function DigDeeperCard({
  list,
  totalCount,
  onOpen,
}: {
  list: AdditionalSearchPassage[];
  totalCount?: number;
  onOpen: (source?: DigSource) => void;
}) {
  if (list.length === 0) return null;
  const total = trueTotalOf(list, totalCount);
  const counts = countSources(list);
  return (
    <section aria-labelledby="asp-dig-h" className="asp-digcard">
      <p className="asp-kicker">Dig deeper</p>
      <h2 id="asp-dig-h">
        {total.toLocaleString("en-US")} more {total === 1 ? "passage" : "passages"}{" "}
        <em className="asp-grad-em">retrieved in this search</em>
      </h2>
      <p className="asp-digcard-sub">Sorted by source, book and chapter, so you can go straight to the book you want.</p>
      <div className="asp-digcard-actions">
        <button type="button" className="asp-btn-primary" onClick={() => onOpen()}>
          Open Dig Deeper
        </button>
        {SOURCES.filter((source) => counts[source] > 0).map((source) => (
          <button key={source} type="button" className="asp-btn-ghost" onClick={() => onOpen(source)}>
            {SOURCE_SHORT[source]}
          </button>
        ))}
      </div>
    </section>
  );
}

/* ── The Dig Deeper screen ──────────────────────────────────────────────── */

const PAGE_SIZE = 30;
const BOOKS_AT_FIRST = 4;
type Order = "relevance" | "book";

function Check({ on }: { on: boolean }) {
  return on ? <span aria-hidden="true">✓</span> : null;
}

function Row({ row }: { row: ParsedAdditionalSearchPassage }) {
  const passage = row.passage;
  return (
    <li className="asp-row">
      {passage.label ? <p className="asp-passage-label">{passage.label}</p> : null}
      {passage.provenanceNote ? <p className="asp-passage-note" style={{ marginTop: 0, marginBottom: 8 }}>{passage.provenanceNote}</p> : null}
      {passage.snippet ? <p className="asp-row-text">{passage.snippet}</p> : null}
      <CitationBar passage={passage} copyText={passage.snippet} />
    </li>
  );
}

export default function DigDeeperPage({
  q,
  list,
  totalCount,
  truncated = false,
  initialSource,
  onBack,
}: {
  q: string;
  list: AdditionalSearchPassage[];
  totalCount?: number;
  truncated?: boolean;
  initialSource?: DigSource | null;
  onBack: () => void;
}) {
  const parsed = useMemo(() => list.map((passage, index) => parseAdditionalSearchPassage(passage, index)), [list]);
  const [filters, setFilters] = useState<DigDeeperFilters>(() => ({ ...EMPTY_FILTERS, family: initialSource ?? "all" }));
  const [order, setOrder] = useState<Order>("relevance");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [moreBooks, setMoreBooks] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus({ preventScroll: true });
  }, []);

  const trueTotal = trueTotalOf(list, totalCount);
  const sourceCounts = useMemo(() => countSources(list), [list]);
  const family = filters.family as DigSource | "all";

  const bookOptions = useMemo(() => {
    const books = new Set<string>();
    for (const row of parsed) {
      if (sourceOf(row.passage.type) === "scripture" && row.book) books.add(row.book);
    }
    return Array.from(books).sort(
      (left, right) => compareNumbers(bookRank(left), bookRank(right)) || left.localeCompare(right, "en"),
    );
  }, [parsed]);

  const chapterOptions = useMemo(() => {
    if (!filters.book) return [];
    const seen = new Map<string, { division: string | null; chapter: string }>();
    for (const row of parsed) {
      if (sourceOf(row.passage.type) !== "scripture" || row.book !== filters.book || !row.chapter) continue;
      const key = `${row.division ?? ""}|${row.chapter}`;
      if (!seen.has(key)) seen.set(key, { division: row.division, chapter: row.chapter });
    }
    return Array.from(seen.values()).sort(
      (left, right) =>
        compareNumbers(divisionRank(left.division), divisionRank(right.division)) ||
        compareNumbers(chapterRank(left.chapter), chapterRank(right.chapter)),
    );
  }, [parsed, filters.book]);

  const filtered = useMemo(() => filterAdditionalSearchPassages(parsed, filters), [parsed, filters]);
  const sorted = useMemo(() => sortAdditionalSearchPassages(filtered, order), [filtered, order]);
  const visible = sorted.slice(0, shown);

  const change = (next: DigDeeperFilters) => {
    setFilters(next);
    setShown(PAGE_SIZE);
  };
  const chooseSource = (source: DigSource) =>
    change({ ...EMPTY_FILTERS, family: family === source ? "all" : source });
  const chooseBook = (book: string) =>
    change({ ...EMPTY_FILTERS, family: "scripture", book: filters.book === book ? "" : book });
  const chooseChapter = (division: string | null, chapter: string) => {
    const same = filters.chapter === chapter && filters.division === (division ?? "");
    change({ ...filters, division: same ? "" : division ?? "", chapter: same ? "" : chapter });
  };
  const clear = () => change({ ...EMPTY_FILTERS });

  const booksToShow = moreBooks || bookOptions.length <= BOOKS_AT_FIRST
    ? bookOptions
    : bookOptions.filter((book, index) => index < BOOKS_AT_FIRST || book === filters.book);

  const crumbs: string[] = [];
  if (family !== "all") crumbs.push(SOURCE_LABEL[family]);
  if (filters.book) crumbs.push(shownName(filters.book, "Book not recognised"));
  if (filters.chapter) {
    crumbs.push([filters.division, shownName(filters.chapter, "Chapter not recognised")].filter(Boolean).join(" · "));
  }
  const heading = crumbs.length ? crumbs[crumbs.length - 1] : "All sources";
  const status = truncated || trueTotal > list.length
    ? `Showing ${sorted.length.toLocaleString("en-US")} of ${list.length.toLocaleString("en-US")} visible passages · ${trueTotal.toLocaleString("en-US")} retrieved in this search`
    : `Showing ${sorted.length.toLocaleString("en-US")} of ${trueTotal.toLocaleString("en-US")} passages retrieved in this search`;

  return (
    <div className="asp-page">
      <section className="asp-dark" aria-label="Dig deeper">
        <div aria-hidden="true" className="asp-layer asp-dig-band-base" />
        <div aria-hidden="true" className="asp-grain" style={{ opacity: 0.1 }} />
        <SiteHeader
          right={
            <button type="button" className="asp-ghost-pill" onClick={onBack} aria-label="Back to the answer">
              <span aria-hidden="true" className="asp-not-phone">← Back to the answer</span>
              <span aria-hidden="true" className="asp-only-phone">← Answer</span>
            </button>
          }
        />
        <div className="asp-dig-head asp-sec">
          <p className="asp-eyebrow asp-rise">Dig deeper</p>
          <h1 ref={headingRef} tabIndex={-1} className="asp-dig-h1 asp-rise" style={{ animationDelay: "80ms", outline: "none" }}>
            {trueTotal.toLocaleString("en-US")} more {trueTotal === 1 ? "passage" : "passages"}{" "}
            <em>retrieved in this search</em>
          </h1>
          <p className="asp-dig-sub asp-rise" style={{ animationDelay: "160ms" }}>
            For “{q}” · Choose a source, then a book, then a chapter.
          </p>
        </div>
      </section>

      <div className="asp-dig-main asp-sec">
        <div className="asp-dig-layout">
          <nav className="asp-shelf" aria-label="Filter passages">
            <p className="asp-shelf-step" id="asp-step-source">1 · Source</p>
            <ul className="asp-shelf-list" aria-labelledby="asp-step-source">
              {SOURCES.filter((source) => sourceCounts[source] > 0).map((source) => (
                <li key={source}>
                  <button type="button" className="asp-f" aria-pressed={family === source} onClick={() => chooseSource(source)}>
                    {SOURCE_LABEL[source]} <Check on={family === source} />
                  </button>
                </li>
              ))}
            </ul>

            {family === "scripture" && bookOptions.length > 0 && (
              <>
                <div className="asp-shelf-rule" />
                <p className="asp-shelf-step" id="asp-step-book">2 · Book</p>
                <ul className="asp-shelf-list" aria-labelledby="asp-step-book">
                  {booksToShow.map((book) => (
                    <li key={book}>
                      <button type="button" className="asp-f" aria-pressed={filters.book === book} onClick={() => chooseBook(book)}>
                        {shownName(book, "Book not recognised")} <Check on={filters.book === book} />
                      </button>
                    </li>
                  ))}
                  {bookOptions.length > BOOKS_AT_FIRST && (
                    <li>
                      <button type="button" className="asp-f asp-f-more" aria-expanded={moreBooks} onClick={() => setMoreBooks((open) => !open)}>
                        {moreBooks ? "Show fewer books" : "Show all books"}
                      </button>
                    </li>
                  )}
                </ul>
              </>
            )}

            {filters.book && chapterOptions.length > 0 && (
              <>
                <div className="asp-shelf-rule" />
                <p className="asp-shelf-step" id="asp-step-chapter">3 · Chapter</p>
                <ul className="asp-shelf-list" aria-labelledby="asp-step-chapter">
                  {chapterOptions.map(({ division, chapter }) => {
                    const on = filters.chapter === chapter && filters.division === (division ?? "");
                    const label = [division, shownName(chapter, "Chapter not recognised")].filter(Boolean).join(" · ");
                    return (
                      <li key={`${division ?? ""}|${chapter}`}>
                        <button type="button" className="asp-f" aria-pressed={on} onClick={() => chooseChapter(division, chapter)}>
                          {label} <Check on={on} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </nav>

          <div className="asp-dig-results">
            <div className="asp-dig-tools">
              <p className="asp-crumbs">
                {crumbs.length === 0 ? (
                  <span>All sources</span>
                ) : (
                  crumbs.map((crumb, index) => (
                    <span key={crumb} style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      {index > 0 && <span aria-hidden="true">›</span>}
                      {index === crumbs.length - 1 ? <strong>{crumb}</strong> : crumb}
                    </span>
                  ))
                )}
                {crumbs.length > 0 && (
                  <button type="button" className="asp-crumb-clear" onClick={clear}>
                    Clear
                  </button>
                )}
              </p>
              <div className="asp-order" role="group" aria-label="Order">
                <button type="button" aria-pressed={order === "relevance"} onClick={() => setOrder("relevance")}>
                  Best match
                </button>
                <button type="button" aria-pressed={order === "book"} onClick={() => setOrder("book")}>
                  Book order
                </button>
              </div>
            </div>

            <div className="asp-dig-group-head">
              <h2>{heading}</h2>
            </div>
            <p className="asp-dig-status" role="status" aria-live="polite">
              {status}
            </p>

            {sorted.length === 0 ? (
              <div className="asp-panel" style={{ marginTop: 24 }}>
                <p className="asp-panel-title">No passages match this choice</p>
                <p className="asp-panel-text">Choose another source, book or chapter.</p>
                <div className="asp-panel-actions">
                  <button type="button" className="asp-btn-ghost" onClick={clear}>
                    Clear
                  </button>
                </div>
              </div>
            ) : (
              <ol className="asp-rows">
                {visible.map((row) => (
                  <Row key={`${row.passage.type}:${row.passage.reference ?? row.passage.label}:${row.originalIndex}`} row={row} />
                ))}
              </ol>
            )}

            {sorted.length > visible.length && (
              <div className="asp-dig-more">
                <button type="button" className="asp-btn-ghost" onClick={() => setShown((count) => count + PAGE_SIZE)}>
                  Show {Math.min(PAGE_SIZE, sorted.length - visible.length).toLocaleString("en-US")} more
                </button>
              </div>
            )}

            {truncated || trueTotal > list.length ? (
              <p className="asp-dig-foot">
                The visible list was shortened to fit the response. The retrieved count above remains the true count.
              </p>
            ) : null}
            <p className="asp-dig-foot">These are passages, not the whole teaching. Read each one in full before you rely on it.</p>
          </div>
        </div>
      </div>
      <SiteFooter />
    </div>
  );
}
